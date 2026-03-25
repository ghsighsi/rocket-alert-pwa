const CACHE_NAME = "rocket-alert-v10";

self.addEventListener("install", (event) => {
  // Skip waiting — activate immediately
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Delete ALL old caches
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Skip non-GET requests
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Never cache API calls or socket.io
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io")) {
    return;
  }

  // Network-first for everything — never serve stale content
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
