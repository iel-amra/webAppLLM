// Service worker : garde l'app et le moteur sur l'iPhone pour fonctionner sans réseau.
// Le modèle lui-même (gros fichiers) est mis en cache par Transformers.js, pas ici.

const VERSION = "v4";

// Sur Chrome/Edge (PC, Android), on « isole » la page pour que le mode processeur
// puisse utiliser plusieurs cœurs. Pas sur Safari/iPhone, qui n'en a pas besoin.
const UA = self.navigator.userAgent;
const ISOLATE = /Chrome|Chromium|Edg\//.test(UA) && !/iPhone|iPad|iPod/.test(UA);

function withIsolation(res) {
  if (!ISOLATE || !res || res.status === 0 || res.type === "opaqueredirect") return res;
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
const SHELL_CACHE = `lfm3-shell-${VERSION}`;
const LIB_CACHE = "lfm3-lib"; // moteur Transformers.js / ONNX Runtime (CDN)

const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./engine.js",
  "./worker.js",
  "./style.css",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("lfm3-shell-") && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 1) Fichiers de l'app : réseau d'abord (pour recevoir les mises à jour), cache si hors ligne
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true }).then(
            (hit) => hit || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())
          )
        )
        .then(withIsolation)
    );
    return;
  }

  // 2) Moteur sur le CDN (versions figées) : cache d'abord, réseau la première fois
  if (url.hostname === "cdn.jsdelivr.net") {
    event.respondWith(
      caches.open(LIB_CACHE).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // 3) Petits fichiers de config Hugging Face : hors ligne, un fichier jamais téléchargé
  //    (parce qu'il n'existe pas) doit répondre « absent » au lieu de faire planter le chargement.
  //    Les gros fichiers du modèle ne passent pas par ici.
  if (url.hostname.endsWith("huggingface.co") && url.pathname.endsWith(".json")) {
    event.respondWith(fetch(req).catch(() => new Response("Not found", { status: 404 })));
  }
});
