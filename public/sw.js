// Tile cache for repeat visits: elevation, aerial photos and vector tiles from geo.admin.ch
// are kept in the browser (cache first). The tiles only change with new swisstopo releases,
// their own HTTP cache lifetime is just one hour. The oldest tiles are dropped beyond MAX.
const CACHE = 'tiles-v1';
const HOSTS = ['3d.geo.admin.ch', 'wmts.geo.admin.ch', 'vectortiles.geo.admin.ch'];
const MAX = 6000;
let added = 0;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !HOSTS.includes(new URL(req.url).host)) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req.url);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type !== 'opaque') {
        e.waitUntil(
          cache.put(req.url, res.clone()).then(() => {
            if (++added % 300 === 0) return trim(cache);
          }),
        );
      }
      return res;
    }),
  );
});

/** Keeps the newest MAX entries (keys come back in insertion order). */
async function trim(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}
