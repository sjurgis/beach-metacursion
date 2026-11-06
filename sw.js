/* Snells Beach service worker: offline app shell + last data. No push, sync or badges.
   VERSION must equal APP_VERSION in app.js and data/version.txt (scripts/validate.py checks). */
const VERSION = "2026-11-06r2";
const CACHE = "snells-beach-" + VERSION;
const SHELL = ["./", "index.html", "app.js", "style.css", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png",
  "data/beaches.json", "data/forecast.json", "data/live.txt", "data/version.txt"];
const TIMEOUT_MS = 6000;   // flaky beach-car-park signal: fall back to the cached copy rather than hang

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "no-cache" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("snells-beach-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* Network first for everything same-origin (data and shell), cache as fallback.
   Cached copies are stored without the ?t= cache-buster so one copy per file. */
async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  try {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const res = await fetch(req.url, { cache: "no-store", signal: ac.signal, credentials: "same-origin" }).finally(() => clearTimeout(timer));
    if (res.ok) {
      const h = new Headers(res.headers); h.set("x-sw-cached-at", new Date().toISOString());
      const body = await res.clone().blob();
      await cache.put(key, new Response(body, { status: res.status, statusText: res.statusText, headers: h }));
    }
    return res;
  } catch (err) {
    const hit = await cache.match(key) || (req.mode === "navigate" && (await cache.match("./") || await cache.match("index.html")));
    if (!hit) throw err;
    const h = new Headers(hit.headers); h.set("x-sw-offline", "1");
    return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers: h });
  }
}
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("cloudflareinsights.com")) return; // never touch analytics beacon
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL("./", self.registration.scope).pathname)) return;
  url.search = "";
  if (req.mode === "navigate") url.pathname = url.pathname.replace(/index\.html$/, "");
  e.respondWith(networkFirst(req, url.href));
});
