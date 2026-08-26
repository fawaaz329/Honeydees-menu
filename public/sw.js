const CACHE_NAME = "honeydees-v6-live";
const ASSETS = ["/", "/order", "/admin", "/manifest.json"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request));
    return;
  }

  if (e.request.mode === "navigate" || ASSETS.includes(url.pathname)) {
    e.respondWith(
      fetch(e.request)
        .then((response) => {
          const resClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, resClone));
          return response;
        })
        .catch(() => caches.match(e.request).then((res) => res || new Response("Offline", { status: 503 })))
    );
    return;
  }

  e.respondWith(caches.match(e.request).then((res) => res || fetch(e.request)));
});

// Route notification clicks directly to /order
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/order";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (let client of windowClients) {
        if (client.url.includes("/order") && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
