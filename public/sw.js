// Getnesty service worker.
//
// Scope is deliberately narrow: this exists to (a) satisfy the browser's
// "installable as an app" requirement, and (b) give the static shell
// (HTML/CSS/JS/icons) a cache fallback if the network drops mid-session.
// It NEVER caches /api/* responses — dues, occupancy, payment status etc.
// change constantly, and serving a stale cached API response instead of a
// real one would be actively misleading, not a helpful offline feature.

const CACHE_NAME = 'getnesty-shell-v1';
const SHELL_ASSETS = [
  '/manifest.json',
  '/manifest-platform.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {}) // don't fail install over a slow/blocked asset
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only ever intervene on same-origin GETs, and never on API calls.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
