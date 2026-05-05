const CACHE_NAME = "milk-rise-alert-v3";
const APP_ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=1",
  "./app.js?v=2",
  "./manifest.webmanifest?v=1",
  "./assets/alarm.base64.txt?v=1",
  "./assets/icon.svg",
  "./assets/apple-touch-icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
