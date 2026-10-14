// TANDEM's Gemini proxy (Supabase Edge Function).
// Keeps the Gemini key server-side and avoids browser CORS issues with Google's API.
//
// Request:  POST { prompt: string, json?: boolean, images?: [{ mimeType, data /* base64 */ }] }
// Response: { text, imagesReceived }  or  { error }
//
// Deploy:   supabase functions deploy tandem-gemini-proxy
// Secrets:  supabase secrets set GEMINI_API_KEY=...
// Optional: supabase secrets set GEMINI_MODELS="model-a,model-b"
//           Models are tried in order; the next one is used only when the previous is
//           overloaded (503 / high demand), so a busy model doesn't fail the request.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MODELS = (Deno.env.get("GEMINI_MODELS") || "gemini-2.5-flash,gemini-2.5-flash-lite")
  .split(",").map((m) => m.trim()).filter(Boolean);
const MAX_IMAGES = 16;
const MAX_IMAGE_B64 = 2_000_000; // ~1.5MB per frame — the app sends ~40KB JPEGs

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return reply({ error: "GEMINI_API_KEY secret is not set on this function" }, 500);

  let body: { prompt?: string; json?: boolean; images?: { mimeType?: string; data?: string }[] };
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
    ...(body.json ? { generationConfig: { responseMimeType: "application/json" } } : {}),
  };

  let lastError = "";
  let lastStatus = 500;
  for (const model of MODELS) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    if (res.ok) {
      let data;
      try { data = JSON.parse(raw); } catch { return reply({ error: "Gemini returned invalid JSON" }, 502); }
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
      return reply({ text, imagesReceived: images.length, model });
    }
    lastStatus = res.status;
    lastError = `Gemini API error ${res.status}: ${raw}`;
    // Only fall through to the next model when this one is overloaded; anything else
    // (bad key, quota used up, bad request) would fail the same way on every model.
    if (!(res.status === 503 || /UNAVAILABLE|high demand|overloaded/i.test(raw))) break;
  }
  return reply({ error: lastError }, lastStatus);
});
