const CACHE_NAME = "norium-public-shell-v2";
const APP_SHELL = ["/index.html", "/manifest.webmanifest", "/norium-logo.png", "/favicon.svg", "/icons.svg"];
const STATIC_FILES = new Set(APP_SHELL);

function canStore(response) {
  return response.ok && !/private|no-store/i.test(response.headers.get("Cache-Control") || "");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api")) return;
  if (event.request.headers.has("Authorization")) return;
  if (
    url.pathname.startsWith("/src/") ||
    url.pathname.startsWith("/@vite") ||
    url.pathname.startsWith("/node_modules/") ||
    url.pathname.includes("__vite")
  ) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Only the public SPA shell can be used offline, never a portal or signed URL.
          if ((url.pathname === "/" || url.pathname.startsWith("/app/")) && !url.search && canStore(response)) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy)));
          }
          return response;
        })
        .catch(() => caches.match("/index.html")),
    );
    return;
  }

  // Cache only build artifacts. Private media and signed resources remain network-only.
  const immutableAsset = /^\/assets\/[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]{8,}\.(?:js|css|png|jpe?g|webp|svg|woff2?)$/.test(url.pathname);
  if (url.search || (!immutableAsset && !STATIC_FILES.has(url.pathname))) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached && immutableAsset) return cached;
      const network = fetch(event.request)
        .then((response) => {
          if (canStore(response)) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
