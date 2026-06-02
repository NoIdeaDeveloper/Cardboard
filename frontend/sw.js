const CACHE_NAME = 'cardboard-v2';
const API_CACHE_NAME = 'cardboard-api-v1';
const API_CACHE_MAX = 50;  // max entries in API cache — prevents unbounded growth

const SHELL_ASSETS = [
  '/',
  '/js/shared-utils.js',
  '/js/api.js',
  '/js/app.js',
  '/js/ui.js',
  '/js/theme.js',
  '/js/ui-helpers.js',
  '/js/confetti.js',
  '/css/style.css',
];

// API GET paths to cache for offline read access (stale-while-revalidate)
const CACHEABLE_API_PREFIXES = [
  '/api/games/',
  '/api/stats',
  '/api/collection/stats',
  '/api/players/',
];

function isCacheableApi(pathname) {
  return CACHEABLE_API_PREFIXES.some(p => pathname.startsWith(p));
}

// Trim a cache to the most recently used N entries to prevent unbounded growth.
function trimCache(cache, max) {
  return cache.keys().then(keys => {
    if (keys.length <= max) return;
    // Delete oldest entries (excess beyond max)
    const toDelete = keys.slice(0, keys.length - max);
    return Promise.all(toDelete.map(req => cache.delete(req)));
  });
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== API_CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (url.pathname.startsWith('/api/')) {
    if (e.request.method === 'GET' && isCacheableApi(url.pathname)) {
      // Stale-while-revalidate for cacheable API GET endpoints
      e.respondWith(
        caches.open(API_CACHE_NAME).then((cache) => {
          const networkFetch = fetch(e.request).then((resp) => {
            if (resp.ok) {
              cache.put(e.request, resp.clone());
              trimCache(cache, API_CACHE_MAX);
            }
            return resp;
          }).catch(() => cache.match(e.request));
          return cache.match(e.request).then((cached) => cached || networkFetch);
        })
      );
    } else {
      // Network-only for mutating API calls (POST/PATCH/DELETE)
      e.respondWith(fetch(e.request));
    }
    return;
  }

  // Stale-while-revalidate for static assets and images
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const networkFetch = fetch(e.request).then((resp) => {
        if (resp.ok && e.request.method === 'GET') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, clone);
            // Trim excess non-shell entries (shell assets count as ~13 entries)
            trimCache(cache, SHELL_ASSETS.length + 50);
          });
        }
        return resp;
      });
      return cached || networkFetch;
    })
  );
});
