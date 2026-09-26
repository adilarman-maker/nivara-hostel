// Getnesty service worker.
//
// Scope is deliberately narrow: this exists to (a) satisfy the browser's
// "installable as an app" requirement, and (b) give the static shell
// (HTML/CSS/JS/icons) a cache fallback if the network drops mid-session.
// It NEVER caches /api/* responses — dues, occupancy, payment status etc.
// change constantly, and serving a stale cached API response instead of a
// real one would be actively misleading, not a helpful offline feature.

const CACHE_NAME = 'getnesty-shell-v2'; // bumped so this deploy clears everyone's old cached shell cleanly
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

// ---------- Push notifications ----------
// The payload is whatever lib/push.js sent — see routes/payments.js,
// routes/complaints.js, routes/messages.js for the actual trigger points.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { /* non-JSON payload — show a generic notification below */ }
  const title = data.title || 'Getnesty';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
    vibrate: [80, 40, 80],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping a notification focuses an already-open tab on the right page if
// one exists, rather than always opening a fresh one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
