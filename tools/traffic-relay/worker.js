// Live traffic relay (Cloudflare Worker): forwards /v2/point/<lat>/<lon>/<nm> to the free
// ADS-B service api.adsb.lol (data ODbL) and adds the CORS header the browser needs.
// Answers are cached for 5 s at the edge, so many players cost one request.
//
// Deploy: Cloudflare dashboard -> Workers -> Create -> paste this file -> Deploy.
// Then set the repository variable TRAFFIC_URL (Settings -> Secrets and variables -> Actions
// -> Variables) to the worker's URL, e.g. https://traffic-relay.<name>.workers.dev
// The next deploy of the site uses it (VITE_TRAFFIC_URL in .github/workflows/deploy.yml).

const ALLOWED_ORIGINS = ['https://trapanotto.github.io', 'http://localhost:4173', 'http://localhost:5180'];
const UPSTREAM = 'https://api.adsb.lol';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') ?? '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    // Only the point query, with sane numbers (no open proxy).
    const m = url.pathname.match(/^\/v2\/point\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(\d+)$/);
    if (!m || Number(m[3]) > 250) return new Response('not found', { status: 404, headers: cors });
    const lat = Number(m[1]).toFixed(2);
    const lon = Number(m[2]).toFixed(2);
    const upstream = `${UPSTREAM}/v2/point/${lat}/${lon}/${m[3]}`;
    const cache = caches.default;
    const key = new Request(upstream);
    let res = await cache.match(key);
    if (!res) {
      const r = await fetch(upstream, { headers: { 'User-Agent': 'trapanotto-flightsimulator' } });
      res = new Response(r.body, r);
      res.headers.set('Cache-Control', 'public, max-age=5');
      if (r.ok) ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
