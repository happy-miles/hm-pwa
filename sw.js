const CACHE_NAME = "happy-miles-v2";
const ASSETS = [
    "./",
    "./index.html",
    "./style.css",
    "./config.js",
    "./app.js",
    "./manifest.json",
    "./icon.png",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js",
    "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
    "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core.wasm.js",
    "https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz"
];

self.addEventListener("install", (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            );
        })
    );
    self.clients.claim();
});

self.addEventListener("fetch", (e) => {
    if (e.request.url.includes("script.google.com") || e.request.url.includes("ngrok-free.app")) {
        return;
    }
    
    e.respondWith(
        caches.match(e.request).then((cachedResponse) => {
            if (cachedResponse) {
                fetch(e.request).then(response => {
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, response));
                }).catch(() => {});
                return cachedResponse;
            }
            return fetch(e.request).catch(() => caches.match("./index.html"));
        })
    );
});
