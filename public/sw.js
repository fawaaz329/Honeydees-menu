const CACHE_NAME = "honeydees-v4-network-first";
const ASSETS = ["/", "/order", "/admin", "/manifest.json"];

self.addEventListener("install", (e) => {
  self.skipWaiting(); // Force the new service worker to activate immediately
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // APIs should always go to the network
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request));
    return;
  }

  // HTML Pages: Network First, Fallback to Cache
  if (e.request.mode === 'navigate' || ASSETS.includes(url.pathname)) {
    e.respondWith(
      fetch(e.request).then(response => {
        const resClone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone));
        return response;
      }).catch(() => caches.match(e.request).then(res => res || new Response("Offline", { status: 503 })))
    );
    return;
  }

  // Other assets (images, fonts): Cache First, Fallback to Network
  e.respondWith(caches.match(e.request).then((res) => res || fetch(e.request)));
});
