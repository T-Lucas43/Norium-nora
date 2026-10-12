const CACHE_NAME = "norium-public-shell-v3";
const PREVIOUS_CACHE = "norium-public-shell-v2";
const APP_SHELL = ["/index.html", "/boot-fallback.css", "/manifest.webmanifest", "/norium-logo.png", "/favicon.svg", "/icons.svg"];
const STATIC_FILES = new Set(APP_SHELL);

function canStore(response) {
  return response.ok && !/private|no-store/i.test(response.headers.get("Cache-Control") || "");
}

async function cachedResponse(request) {
  for (const name of [CACHE_NAME, PREVIOUS_CACHE]) {
    try {
      const response = await (await caches.open(name)).match(request);
      if (response instanceof Response) return response;
    } catch {
      // CacheStorage can be unavailable or full; network delivery must continue.
    }
  }
  return undefined;
}

function savePublic(event, request, response) {
  if (!canStore(response)) return;
  const copy = response.clone();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {}));
}

function unavailable(navigation) {
  const body = navigation
    ? '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Norium · Conexão indisponível</title><link rel="stylesheet" href="/boot-fallback.css"></head><body><main class="norium-boot"><section><img src="/norium-logo.png" alt="Norium" width="96" height="96"><h1>Não conseguimos conectar ao Norium</h1><p>A conexão está indisponível no momento. Verifique sua rede e tente novamente.</p><a href="">Tentar novamente</a></section></main></body></html>'
    : "Recurso temporariamente indisponível. Tente novamente quando a conexão voltar.";
  return new Response(body, { status: 503, headers: { "Content-Type": navigation ? "text/html; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
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
      // Keep one public build generation for pages already open during an update.
      // Never delete caches belonging to unrelated features or personal data.
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("norium-public-shell-") && key !== CACHE_NAME && key !== PREVIOUS_CACHE).map((key) => caches.delete(key).catch(() => false))))
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
            savePublic(event, "/index.html", response);
          }
          return response;
        })
        .catch(async () => {
          if ((url.pathname === "/" || url.pathname.startsWith("/app/")) && !url.search) {
            return (await cachedResponse("/index.html")) || unavailable(true);
          }
          return unavailable(true);
        }),
    );
    return;
  }

  // Cache only build artifacts. Private media and signed resources remain network-only.
  const immutableAsset = /^\/assets\/[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]{8,}\.(?:js|css|png|jpe?g|webp|svg|woff2?)$/.test(url.pathname);
  if (url.search || (!immutableAsset && !STATIC_FILES.has(url.pathname))) return;

  event.respondWith(
    cachedResponse(event.request).then((cached) => {
      if (cached && immutableAsset) return cached;
      const network = fetch(event.request)
        .then((response) => {
          if (canStore(response)) {
            savePublic(event, event.request, response);
          }
          return response;
        })
        .catch(() => cached || unavailable(false));
      if (cached) {
        event.waitUntil(network.then(() => {}));
        return cached;
      }
      return network;
    }),
  );
});
