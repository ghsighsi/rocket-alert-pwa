const CACHE_NAME = "maller-alert-v1";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/app.js?v=32",
  "/style.css?v=32",
  "/icon-192.png",
  "/icon-512.png",
  "/icon.svg",
  "/release-sound.mp3",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Never cache API calls or socket.io — always network
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io")) {
    return;
  }

  // Cache-first for static assets (icons, sounds, css, js)
  const isStatic =
    url.pathname.match(/\.(png|svg|mp3|ico|webp)$/) ||
    url.pathname.startsWith("/style.css") ||
    url.pathname.startsWith("/app.js");

  if (isStatic) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
          return res;
        });
      })
    );
    return;
  }

  // Network-first for HTML and everything else
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
