// grok-remote service worker.
//
// Caching strategy:
//   - app shell: precache "/" and "/index.html" on install.
//   - /api/*: network-first, never cached (live data).
//   - other same-origin GETs: cache-first with background revalidation.

const CACHE = 'gr-shell-v6-revert-bottom';
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // never cache API traffic.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // cache-first with stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const networkFetch = fetch(req).then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          cache.put(req, resp.clone()).catch(() => {});
        }
        return resp;
      }).catch(() => null);

      if (cached) {
        // revalidate in the background.
        networkFetch.catch(() => {});
        return cached;
      }
      const fresh = await networkFetch;
      if (fresh) return fresh;
      // last resort: shell fallback for navigations.
      if (req.mode === 'navigate') {
        const shell = await cache.match('/index.html');
        if (shell) return shell;
      }
      return new Response('', { status: 504, statusText: 'offline' });
    })
  );
});
