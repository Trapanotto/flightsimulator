// Fetches all Swiss aerodromes, runways, taxiways and aprons from OpenStreetMap (Overpass API)
// and writes them in the compact form the game uses.
//
// Usage: node tools/fetch-aeroways.mjs [overpass.json]
//   With a file argument the saved Overpass answer is used instead of downloading.
// Output:
//   src/game/aerodromes.generated.ts       aerodromes + paved runways (start places, markings)
//   public/assets/airports/aeroways.json   taxiways and aprons (pavement on the terrain)
//
// Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
import fs from 'node:fs';

// Switzerland plus a margin: Basel-Mulhouse (LFSB) lies in France.
const BBOX = '45.80,5.90,47.85,10.55';
const QUERY = `[out:json][timeout:180];
(
  nwr["aeroway"~"^(aerodrome|runway|taxiway|taxilane|apron)$"](${BBOX});
);
out geom tags;`;

let data;
if (process.argv[2]) data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
else {
  const servers = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  for (let attempt = 0; attempt < 6 && !data; attempt++) {
    const url = servers[attempt % servers.length];
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'trapanotto-flightsimulator (github.com/Trapanotto/flightsimulator)',
      },
      body: 'data=' + encodeURIComponent(QUERY),
    }).catch((err) => ({ ok: false, status: String(err) }));
    if (res.ok) data = await res.json();
    else {
      console.log(`${url}: HTTP ${res.status}, retrying`);
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
  if (!data) throw new Error('Overpass: no server answered');
  fs.mkdirSync('build', { recursive: true });
  fs.writeFileSync('build/overpass-aeroways.json', JSON.stringify(data));
}

const R = 6_371_000;
const rad = Math.PI / 180;
const round = (v) => Math.round(v * 1e6) / 1e6;
const dist = (a, b) => {
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.hypot(x, y) * R;
};
const bearing = (a, b) => {
  const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
  const x =
    Math.cos(a[1] * rad) * Math.sin(b[1] * rad) -
    Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
  return (((Math.atan2(y, x) / rad) % 360) + 360) % 360;
};
const pts = (geom) => (geom ?? []).map((p) => [p.lon, p.lat]);
const centroid = (ring) => {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
};
function inside(p, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
/** Joins way segments (relation members) into closed rings. */
function joinRings(segments) {
  const rings = [];
  const left = segments.filter((s) => s.length > 1).map((s) => s.slice());
  while (left.length) {
    let ring = left.shift();
    let grew = true;
    while (grew && dist(ring[0], ring[ring.length - 1]) > 0.5) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const s = left[i];
        const end = ring[ring.length - 1];
        if (dist(end, s[0]) < 0.5) ring = ring.concat(s.slice(1));
        else if (dist(end, s[s.length - 1]) < 0.5) ring = ring.concat(s.slice(0, -1).reverse());
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}
function rings(e) {
  if (e.type === 'way') return [pts(e.geometry)];
  if (e.type === 'relation')
    return joinRings(
      (e.members ?? []).filter((m) => m.role !== 'inner').map((m) => pts(m.geometry)),
    );
  return [];
}

// ---- aerodromes ----
const aerodromes = [];
for (const e of data.elements) {
  const t = e.tags ?? {};
  if (t.aeroway !== 'aerodrome') continue;
  const icao = (t.icao ?? '').split(';')[0].trim();
  if (!/^(LS..|LFSB)$/.test(icao)) continue;
  let outline = rings(e)[0];
  // Big relations come without member geometry: use their bounding box.
  const bb = e.bounds;
  if (!outline && bb)
    outline = [
      [bb.minlon, bb.minlat],
      [bb.maxlon, bb.minlat],
      [bb.maxlon, bb.maxlat],
      [bb.minlon, bb.maxlat],
    ];
  const pos = e.type === 'node' ? [e.lon, e.lat] : outline ? centroid(outline) : null;
  if (!pos) continue;
  const name = (t['name:de'] ?? t.name ?? icao)
    .replace(
      /^(Flughafen|Flugplatz|Flugfeld|Sportflugplatz|Militärflugplatz|Aéroport de|Aérodrome de|Aeroporto di|Aéroport international de)\s+/i,
      '',
    )
    .replace(/^(Aérodrome|Aéroport) d['’]/i, '')
    .replace(/\s+(Airport|Airfield|airfield|Aerodrome|Air Base)$/i, '');
  aerodromes.push({
    icao,
    name,
    pos,
    outline,
    military: t.military === 'airfield' || /Milit|Air Base|aérienne/i.test(t.name ?? ''),
  });
}
/** Aerodrome a feature belongs to: the one whose outline contains it, else the nearest (< 4 km). */
function aerodromeOf(p) {
  for (const a of aerodromes) if (a.outline && inside(p, a.outline)) return a;
  let best = null;
  let bd = 4000;
  for (const a of aerodromes) {
    const d = dist(p, a.pos);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  return best;
}

// ---- runways ----
const HARD = /^(asphalt|concrete|paved|concrete:plates|concrete:lanes)$/;
const runways = [];
// OSM often splits a runway into several ways (displaced thresholds, crossings): chain the
// pieces that touch end to end and point the same way.
const pieces = data.elements
  .filter((e) => e.type === 'way' && e.tags?.aeroway === 'runway' && (e.geometry?.length ?? 0) >= 2)
  .map((e) => ({ tags: e.tags, line: pts(e.geometry), used: false }));
const axis = (l) => bearing(l[0], l[l.length - 1]) % 180;
const aligned = (p, q) => {
  const d = Math.abs(axis(p.line) - axis(q.line));
  return Math.min(d, 180 - d) < 8;
};
for (const start of pieces) {
  if (start.used) continue;
  start.used = true;
  let line = start.line.slice();
  const tags = { ...start.tags };
  let grew = true;
  while (grew) {
    grew = false;
    for (const q of pieces) {
      if (q.used || !aligned(start, q)) continue;
      const s0 = line[0];
      const s1 = line[line.length - 1];
      const q0 = q.line[0];
      const q1 = q.line[q.line.length - 1];
      if (dist(s1, q0) < 2) line = line.concat(q.line.slice(1));
      else if (dist(s1, q1) < 2) line = line.concat(q.line.slice(0, -1).reverse());
      else if (dist(s0, q1) < 2) line = q.line.slice(0, -1).concat(line);
      else if (dist(s0, q0) < 2) line = q.line.slice(1).reverse().concat(line);
      else continue;
      q.used = true;
      for (const k of ['surface', 'width', 'ref']) tags[k] ??= q.tags[k];
      grew = true;
    }
  }
  const a = line[0];
  const b = line[line.length - 1];
  const length = dist(a, b);
  const ad = aerodromeOf([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  if (!ad || length < 300) continue;
  const surface = tags.surface ?? '';
  const hard = HARD.test(surface) || (!surface && length >= 500);
  if (!hard) continue;
  const width = Number.parseFloat(tags.width) || (length > 2000 ? 45 : length > 1200 ? 30 : 20);
  // Designator of the end the line starts at: the magnetic course from it in tens of degrees
  // (declination in Switzerland is about 3° east).
  const course = bearing(a, b) - 3;
  let ident = String(((Math.round(course / 10) + 35) % 36) + 1).padStart(2, '0');
  // The official designators (ref "14/32") win: runways keep their names when the magnetic
  // declination drifts. Take the end that matches the course.
  const m = /(\d{1,2})[LRC]?\s*\/\s*(\d{1,2})[LRC]?/.exec(tags.ref ?? '');
  if (m) {
    const off = (n) => {
      const d = Math.abs(((Number(n) * 10 - course) % 360) + 360) % 360;
      return Math.min(d, 360 - d);
    };
    const best = off(m[1]) <= off(m[2]) ? m[1] : m[2];
    if (off(best) < 30) ident = best.padStart(2, '0');
  }
  runways.push({
    airport: ad.name,
    icao: ad.icao,
    ident,
    from: { lat: round(a[1]), lon: round(a[0]) },
    to: { lat: round(b[1]), lon: round(b[0]) },
    widthM: Math.round(width),
    lengthM: Math.round(length),
  });
}
runways.sort((p, q) => p.airport.localeCompare(q.airport, 'de') || q.lengthM - p.lengthM);

// ---- taxiways and aprons ----
const isLarge = (icao) => ['LSZH', 'LSGG', 'LFSB'].includes(icao);
const taxiways = [];
const aprons = [];
for (const e of data.elements) {
  const t = e.tags ?? {};
  if (/^(grass|dirt|gravel|ground|unpaved)$/.test(t.surface ?? '')) continue;
  if (t.aeroway === 'taxiway' || t.aeroway === 'taxilane') {
    const line = pts(e.geometry);
    if (line.length < 2) continue;
    const ad = aerodromeOf(line[Math.floor(line.length / 2)]);
    if (!ad) continue;
    const w =
      Number.parseFloat(t.width) ||
      (t.aeroway === 'taxilane' ? 8 : isLarge(ad.icao) ? 23 : ad.military ? 18 : 12);
    taxiways.push({ w: Math.round(w * 10) / 10, c: line.flat().map(round) });
  } else if (t.aeroway === 'apron') {
    for (const ring of rings(e)) {
      if (!aerodromeOf(centroid(ring))) continue;
      aprons.push({ c: ring.flat().map(round) });
    }
  }
}

// ---- write ----
const usedIcao = new Set(runways.map((r) => r.icao));
const ads = aerodromes
  .filter((a) => usedIcao.has(a.icao))
  .map((a) => ({ icao: a.icao, name: a.name, lon: round(a.pos[0]), lat: round(a.pos[1]) }))
  .sort((p, q) => p.name.localeCompare(q.name, 'de'));

const ts = `// Generated by tools/fetch-aeroways.mjs – do not edit.
// Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
import type { Runway } from './airports';

export interface Aerodrome {
  icao: string;
  name: string;
  lon: number;
  lat: number;
}

export const AERODROMES: Aerodrome[] = ${JSON.stringify(ads, null, 1)};

/** Paved runways, threshold to threshold along the OSM way. */
export const ALL_RUNWAYS: Array<Runway & { lengthM: number }> = ${JSON.stringify(runways, null, 1)};
`;
fs.writeFileSync('src/game/aerodromes.generated.ts', ts);
fs.mkdirSync('public/assets/airports', { recursive: true });
fs.writeFileSync(
  'public/assets/airports/aeroways.json',
  JSON.stringify({
    source: 'OpenStreetMap contributors, ODbL 1.0',
    taxiways,
    aprons,
  }),
);
console.log(
  `${ads.length} aerodromes, ${runways.length} paved runways, ${taxiways.length} taxiways, ${aprons.length} aprons`,
);
console.log(
  'aeroways.json',
  (fs.statSync('public/assets/airports/aeroways.json').size / 1e6).toFixed(2),
  'MB',
);
