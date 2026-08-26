const CACHE_NAME = "honeydees-v8-push";
const ASSETS = ["/", "/order", "/admin", "/manifest.json"];

self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.map(x => caches.delete(x)))));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith("/api/")) { e.respondWith(fetch(e.request)); return; }
  if (e.request.mode === "navigate" || ASSETS.includes(u.pathname)) {
    e.respondWith(fetch(e.request).then(r => {
      const rc = r.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, rc));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || new Response("Offline", { status: 503 }))));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

// TRUE WEB PUSH BACKGROUND EVENT
self.addEventListener("push", e => {
  let d = { title: "Honeydees Update", body: "Tap to view status." };
  if (e.data) {
    try { d = e.data.json(); } catch (err) { d.body = e.data.text(); }
  }
  e.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body,
      icon: "https://via.placeholder.com/192x192.png?text=H",
      badge: "https://via.placeholder.com/192x192.png?text=H",
      vibrate: [200, 100, 200],
      data: { url: d.url || "/" }
    })
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const t = e.notification.data?.url || "/";
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(w => {
    for (let c of w) { if (c.url.includes(t) && "focus" in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(t);
  }));
});
