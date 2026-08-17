// OpenShelf service worker: app shell precache + stale-while-revalidate for everything same-origin (incl. /data/*.json).
const CACHE = 'openshelf-v1';
const SHELL = ['./', 'index.html', 'search.html', 'app.js', 'agents.json', 'manifest.json', 'icon.svg', 'llms.txt', 'openapi.json'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || /admin/.test(u.pathname)) return;   // images, analytics, admin → network
  e.respondWith(caches.open(CACHE).then(async c => {
    const key = u.origin + u.pathname;   // one cache entry per file (search.html?q=… collapses to search.html)
    const hit = await c.match(key);
    const net = fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) c.put(key, r.clone()); return r; }).catch(() => hit || Response.error());
    return hit || net;
  }));
});
