const CACHE_NAME = "honeydees-pwa-v1";
const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/order.html",
  "/admin.html",
  "/manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => k !== CACHE_NAME && caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Network-first for dynamic API routes
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(event.request).then((res) => res || new Response(JSON.stringify({ error: "Offline" }), {
          headers: { "Content-Type": "application/json" }
        }))
      )
    );
    return;
  }

  // Cache-first for HTML, styling & images
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
