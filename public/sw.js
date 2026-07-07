const CACHE_NAME = 'hisaab-v6';
const STATIC_ASSETS = [
  '/',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-192-maskable.png',
  '/icon-512-maskable.png',
  '/manifest.json',
];

// Install: cache shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network first, cache fallback for navigation
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
    return;
  }

  // Hashed deployment bundles are already immutable in the browser cache.
  // Do not keep a second service-worker copy: an old open tab should either
  // fetch its exact bundle or surface the app-update recovery screen.
  if (new URL(event.request.url).pathname.startsWith('/assets/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // For other requests: network first, then cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (
          response.ok &&
          event.request.method === 'GET' &&
          event.request.url.startsWith(self.location.origin)
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
