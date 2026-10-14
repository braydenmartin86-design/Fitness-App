// TANDEM service worker — caches the app shell so it opens instantly and works offline
// after the first load. It deliberately does NOT touch anything cross-origin (Supabase
// API calls, the realtime websocket, the Google Fonts / Supabase CDN scripts) — those
// always go straight to the network, untouched, so your data never gets served stale.

const CACHE_NAME = 'tandem-shell-v2';
const APP_SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Only handle same-origin GET requests for the app shell itself. Everything else
  // (Supabase reads/writes, the realtime socket, external CDN scripts) passes straight
  // through to the network untouched — this is what keeps data always fresh and live.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // The app page itself: network first, so a new version shows up on the very next open
  // (cache-first meant every update needed the app closed and reopened twice). The cached
  // copy is only used when offline.
  if (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached); // offline — serve the cached shell instead
      return cached || network;
    })
  );
});
