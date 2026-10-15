// TANDEM's Gemini proxy (Supabase Edge Function).
// Keeps the Gemini key server-side and avoids browser CORS issues with Google's API.
//
// Request:  POST { prompt: string, json?: boolean, images?: [{ mimeType, data /* base64 */ }],
//                  thinkingBudget?: number /* 0 = answer straight away (much faster on 2.5 models) */ }
// Response: { text, imagesReceived }  or  { error }
//
// Deploy:   supabase functions deploy tandem-gemini-proxy
// Secrets:  supabase secrets set GEMINI_API_KEY=...   (any casing works, e.g. gemini_api_key)
// Models:   by default the proxy asks Google which models this key can use and picks the
//           newest "Flash" model (plus a lighter backup), so a retired model can't break it.
// Optional: supabase secrets set GEMINI_MODELS="model-a,model-b" to pin specific models.
//           Models are tried in order; the next one is used when the previous is overloaded
//           (503) or has been retired (404) — a retired pinned model falls back to auto-pick.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const PINNED_MODELS = (Deno.env.get("GEMINI_MODELS") || "")
  .split(",").map((m) => m.trim()).filter(Boolean);

// Ask Google which models this key can call and rank the Flash ones: stable before preview
// (previews can change or vanish), then newest version, then full Flash before Flash-Lite. Cached for the life of the worker.
let discovered: string[] | null = null;
// If the model list can't be fetched, fall back to Google's rolling "latest" aliases.
const LATEST_ALIASES = ["gemini-flash-latest", "gemini-flash-lite-latest"];
async function discoverModelsOrAliases(key: string): Promise<string[]> {
  try { return await discoverModels(key); } catch { return LATEST_ALIASES; }
}
async function discoverModels(key: string): Promise<string[]> {
  if (discovered) return discovered;
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    headers: { "x-goog-api-key": key },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Couldn't list Gemini models (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const names: string[] = (data.models || [])
    .filter((m: { supportedGenerationMethods?: string[] }) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m: { name: string }) => m.name.replace(/^models\//, ""))
    .filter((n: string) => /^gemini-/.test(n) && /flash/.test(n))
    .filter((n: string) => !/image|tts|audio|live|embed|exp|learnlm|robotics|computer|native|thinking/.test(n));
  const version = (n: string) => parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
  const score = (n: string) =>
    (/preview/.test(n) ? 0 : 10_000) + version(n) * 100 - (/lite/.test(n) ? 10 : 0) - (/-\d{3,}$|-\d{2}-\d{2}/.test(n) ? 1 : 0);
  names.sort((a, b) => score(b) - score(a));
  const best = names.find((n) => !/lite/.test(n));
  const lite = names.find((n) => /lite/.test(n));
  discovered = [best, lite, ...names].filter((n, i, arr): n is string => !!n && arr.indexOf(n) === i).slice(0, 3);
  if (!discovered.length) throw new Error("This Gemini key has no Flash models available");
  return discovered;
}
const MAX_IMAGES = 16;
const MAX_IMAGE_B64 = 2_000_000; // ~1.5MB per frame — the app sends ~40KB JPEGs

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Supabase kills a function at ~150s with a bare error (no CORS headers), which the browser
// can only report as "Load failed". Give Gemini 120s, then answer with a readable error instead.
const GEMINI_TIMEOUT_MS = 120_000;

// Secret names are case-sensitive, so accept GEMINI_API_KEY, gemini_api_key, or any other
// secret whose name looks like a Gemini key.
function findGeminiKey(): string | undefined {
  for (const name of ["GEMINI_API_KEY", "gemini_api_key", "Gemini_API_Key"]) {
    const v = Deno.env.get(name);
    if (v) return v;
  }
  try {
    const hit = Object.entries(Deno.env.toObject()).find(([k, v]) => /gemini/i.test(k) && /key/i.test(k) && v);
    return hit?.[1];
  } catch {
    return undefined;
  }
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    // Any unexpected crash still goes back with CORS headers so the app can show what happened.
    const msg = e instanceof Error ? e.message : String(e);
    return reply({ error: /abort|timed out/i.test(msg) ? "Gemini took too long to answer (timed out after 120s)" : `Proxy error: ${msg}` }, 504);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);

  const key = findGeminiKey();
  if (!key) return reply({ error: "No Gemini key found — add a secret named GEMINI_API_KEY (or gemini_api_key) in Supabase → Edge Functions → Secrets" }, 500);

  let body: { prompt?: string; json?: boolean; thinkingBudget?: number; images?: { mimeType?: string; data?: string }[] };
  try { body = await req.json(); } catch { return reply({ error: "Invalid JSON body" }, 400); }
  if (!body.prompt) return reply({ error: "Missing prompt" }, 400);

  const images = (body.images || []).filter((i) => i && typeof i.data === "string" && i.data.length <= MAX_IMAGE_B64);
  if (images.length > MAX_IMAGES) return reply({ error: `Too many images (max ${MAX_IMAGES})` }, 400);

  const payload = {
    contents: [{
      role: "user",
      parts: [
        { text: body.prompt },
        ...images.map((i) => ({ inline_data: { mime_type: i.mimeType || "image/jpeg", data: i.data } })),
      ],
    }],
  };
  const generationConfig: Record<string, unknown> = {};
  if (body.json) generationConfig.responseMimeType = "application/json";
  const wantsThinkingBudget = typeof body.thinkingBudget === "number";

  let lastError = "";
  let lastStatus = 500;
  const callModel = (model: string, withThinking: boolean) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      body: JSON.stringify({
        ...payload,
        generationConfig: {
          ...generationConfig,
          ...(withThinking ? { thinkingConfig: { thinkingBudget: body.thinkingBudget } } : {}),
        },
      }),
    });

  let models = PINNED_MODELS.length ? PINNED_MODELS : await discoverModelsOrAliases(key);
  let usedDiscovery = !PINNED_MODELS.length;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    let res = await callModel(model, wantsThinkingBudget);
    // Not every model accepts a custom thinking budget (or 0) — if it's rejected, just ask normally.
    if (res.status === 400 && wantsThinkingBudget) res = await callModel(model, false);
    const raw = await res.text();
    if (res.ok) {
      let data;
      try { data = JSON.parse(raw); } catch { return reply({ error: "Gemini returned invalid JSON" }, 502); }
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
      return reply({ text, imagesReceived: images.length, model });
    }
    lastStatus = res.status;
    lastError = `Gemini API error ${res.status}: ${raw}`;
    const retired = res.status === 404 || /no longer available|not found|deprecated/i.test(raw);
    if (retired) {
      discovered = null; // the cached list is stale
      if (!usedDiscovery) {
        // A pinned model was retired — switch to auto-picked models instead of failing.
        usedDiscovery = true;
        models = [...models.slice(0, i + 1), ...(await discoverModelsOrAliases(key))];
      }
      continue;
    }
    // Overloaded → try the next model. Anything else (bad key, quota used up, bad request)
    // would fail the same way on every model.
    if (!(res.status === 503 || /UNAVAILABLE|high demand|overloaded/i.test(raw))) break;
  }
  return reply({ error: lastError }, lastStatus);
}
