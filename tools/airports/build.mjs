// Builds the airport data of the game from open sources. Run by hand when the sources change:
//
//   node tools/airports/build.mjs            uses the cached downloads in build/airports/
//   node tools/airports/build.mjs --refresh  downloads OurAirports and OpenStreetMap again
//
// Sources:
//   OurAirports (public domain), https://davidmegginson.github.io/ourairports-data/
//     airports.csv, runways.csv: the list of airfields, reference points, elevations, runway
//     designators, lengths, widths, surfaces, lighting, displaced thresholds.
//   OpenStreetMap via Overpass (ODbL 1.0, "© OpenStreetMap contributors"): runway centre lines
//     traced from imagery (more exact than OurAirports' coordinates and aligned with the
//     orthophoto the game shows), displaced threshold pieces, taxiways, aprons, windsocks,
//     holding positions, the tower, and individually mapped lights (approach lights, PAPI)
//     telling which runway ends have them.
//   tools/airports/curated.mjs: names, border airports, instrument approaches (from the AIPs).
//
// Output:
//   src/geo/airports.generated.ts            every airfield with its runways (small, checked in)
//   public/assets/world/airports/<ICAO>.json taxiways, aprons, windsocks of one airport, loaded
//                                            by the airport layer when the airport comes near
//   build/airports/report.txt                where the sources disagree
import fs from 'node:fs';
import path from 'node:path';
import { BORDER_AIRPORTS, INSTRUMENT, NAMES } from './curated.mjs';

const CACHE = 'build/airports';
const OUT_TS = 'src/geo/airports.generated.ts';
const OUT_DIR = 'public/assets/world/airports';
const refresh = process.argv.includes('--refresh');
/** Switzerland and its border airports, with a margin. */
const BBOX = { south: 45.7, west: 5.7, north: 47.95, east: 10.7 };
/** Magnetic variation in Switzerland, 2025: about 3 degrees east. */
const VARIATION = 3;
const FT = 0.3048;

fs.mkdirSync(CACHE, { recursive: true });

// ---------------------------------------------------------------- downloads

async function cached(name, fetcher) {
  const file = path.join(CACHE, name);
  if (!refresh && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const text = await fetcher();
  fs.writeFileSync(file, text);
  return text;
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'tfs-airports-tool' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const OVERPASS_QUERY = `[out:json][timeout:240];
(nwr["aeroway"~"^(aerodrome|runway|taxiway|taxilane|apron|windsock|navigationaid|holding_position|tower)$"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}););
out geom tags;`;

async function overpass() {
  const servers = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = servers[attempt % servers.length];
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'tfs-airports-tool',
      },
      body: 'data=' + encodeURIComponent(OVERPASS_QUERY),
    }).catch((err) => ({ ok: false, status: String(err) }));
    if (res.ok) return res.text();
    console.log(`${url}: HTTP ${res.status}, retrying`);
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  throw new Error('Overpass: no server answered');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const head = rows.shift();
  return rows.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])));
}

const OA_BASE = 'https://davidmegginson.github.io/ourairports-data/';
const oaAirports = parseCsv(await cached('airports.csv', () => download(OA_BASE + 'airports.csv')));
const oaRunways = parseCsv(await cached('runways.csv', () => download(OA_BASE + 'runways.csv')));
const osm = JSON.parse(await cached('overpass.json', overpass)).elements;

// ---------------------------------------------------------------- geometry

const RAD = Math.PI / 180;
const R = 6_371_000;
/** Great-circle distance in metres between [lon, lat] points. */
function dist(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** True bearing from a to b, degrees. */
function bearing(a, b) {
  const dLon = (b[0] - a[0]) * RAD;
  const y = Math.sin(dLon) * Math.cos(b[1] * RAD);
  const x =
    Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) -
    Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos(dLon);
  return (((Math.atan2(y, x) / RAD) % 360) + 360) % 360;
}
const angleDiff = (a, b) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
};
/** Local east/north metres of p relative to o (fine within an airport). */
function en(o, p) {
  return [(p[0] - o[0]) * RAD * R * Math.cos(o[1] * RAD), (p[1] - o[1]) * RAD * R];
}
/** Along-track and cross-track metres of p relative to the line from a towards bearing brg. */
function alongCross(a, brg, p) {
  const [e, n] = en(a, p);
  const s = Math.sin(brg * RAD);
  const c = Math.cos(brg * RAD);
  return [e * s + n * c, e * c - n * s];
}
const pts = (geom) => (geom ?? []).map((p) => [p.lon, p.lat]);
function inside(p, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function lineLength(line) {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += dist(line[i - 1], line[i]);
  return s;
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
    if (ring.length >= 4 && dist(ring[0], ring[ring.length - 1]) <= 0.5) rings.push(ring);
  }
  return rings;
}
/** Outer rings of an OSM area (closed way or multipolygon relation). */
function outerRings(e) {
  if (e.type === 'way') {
    const ring = pts(e.geometry);
    return ring.length >= 4 && dist(ring[0], ring[ring.length - 1]) < 0.5 ? [ring] : [];
  }
  if (e.type === 'relation')
    return joinRings(
      (e.members ?? []).filter((m) => m.role !== 'inner').map((m) => pts(m.geometry)),
    );
  return [];
}
function centroid(ring) {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

// ---------------------------------------------------------------- normalising

/** Designator: "1" -> "01", "08l" -> "08L"; undefined for helipads and junk. */
function normIdent(s) {
  const m = /^0?(\d{1,2})([LRCG]?)$/i.exec((s ?? '').trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n < 1 || n > 36) return undefined;
  return String(n).padStart(2, '0') + m[2].toUpperCase();
}
/** Runway number of a designator, degrees magnetic / 10. */
const identNumber = (id) => Number(id.slice(0, 2));
/** Parses an OSM ref like "14/32", "14L-32R", "06 / 24". */
function parseRef(ref) {
  const m = /^\s*(\d{1,2}[LRCG]?)\s*[/-]\s*(\d{1,2}[LRCG]?)\s*$/i.exec(ref ?? '');
  if (!m) return undefined;
  const a = normIdent(m[1]);
  const b = normIdent(m[2]);
  return a && b ? [a, b] : undefined;
}
/** Designator for a true bearing (magnetic course in tens of degrees). */
function identFor(brg) {
  const n = ((Math.round((brg - VARIATION) / 10) + 35) % 36) + 1;
  return String(n).padStart(2, '0');
}

const SURFACES = [
  [/^(asp|asph|asphalt|paved|bitumen|asfalt|tarmac)/i, 'asphalt'],
  [/^(con|conc|concrete|concrete:plates|concrete:lanes|pem)/i, 'concrete'],
  [/^(grs|grass|turf|gras|g$)/i, 'grass'],
  [/^(gravel|grvl|fine_gravel|compacted)/i, 'gravel'],
  [/^(dirt|ground|earth|unpaved)/i, 'dirt'],
  [/^(sno|snow|ice)/i, 'snow'],
];
function normSurface(s) {
  for (const [re, v] of SURFACES) if (re.test((s ?? '').trim())) return v;
  return undefined;
}
const paved = (s) => s === 'asphalt' || s === 'concrete';

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const round1 = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------- airports

const report = [];
const note = (icao, text) => report.push(`${icao}: ${text}`);

const isAirport = (a) => /^(small_airport|medium_airport|large_airport)$/.test(a.type);
const codeOf = (a) => a.icao_code || a.gps_code || a.ident;
const selected = oaAirports.filter((a) => {
  if (!isAirport(a)) return false;
  const code = codeOf(a);
  return a.iso_country === 'CH' || a.iso_country === 'LI' || BORDER_AIRPORTS.includes(code);
});

// OSM aerodromes by ICAO (some carry two codes, "LSGS;LSMS").
const osmAerodromes = new Map();
for (const e of osm) {
  const t = e.tags ?? {};
  if (t.aeroway !== 'aerodrome') continue;
  const codes = (t.icao ?? t['ref:icao'] ?? '').split(';').map((s) => s.trim());
  const rings = outerRings(e);
  for (const code of codes) if (code) osmAerodromes.set(code, { tags: t, rings, element: e });
}

const airports = selected.map((a) => {
  const icao = codeOf(a);
  const ad = osmAerodromes.get(icao);
  return {
    icao,
    oa: a,
    osm: ad,
    pos: [Number(a.longitude_deg), Number(a.latitude_deg)],
    rings: ad?.rings ?? [],
    runways: [],
    chains: [],
    taxiways: [],
    aprons: [],
    windsocks: [],
    holds: [],
    towers: [],
    lights: [],
  };
});

/** The selected airport a point belongs to: inside its OSM outline, else the nearest (< 3.5 km). */
function airportOf(p, maxDist = 3500) {
  for (const ap of airports) for (const ring of ap.rings) if (inside(p, ring)) return ap;
  let best;
  let bd = maxDist;
  for (const ap of airports) {
    const d = dist(p, ap.pos);
    if (d < bd) {
      bd = d;
      best = ap;
    }
  }
  return best;
}

// ---------------------------------------------------------------- OSM runways

// OSM splits a runway into several ways (displaced thresholds, crossings): chain the pieces that
// touch end to end and point the same way, remembering which pieces are displaced thresholds.
const pieces = osm
  .filter((e) => e.type === 'way' && e.tags?.aeroway === 'runway' && (e.geometry?.length ?? 0) >= 2)
  .map((e) => ({ tags: e.tags, line: pts(e.geometry), used: false, id: e.id }))
  .filter((p) => dist(p.line[0], p.line[p.line.length - 1]) > 5); // areas: first == last
const axis = (l) => bearing(l[0], l[l.length - 1]) % 180;
const aligned = (p, q) => {
  const d = Math.abs(axis(p.line) - axis(q.line));
  return Math.min(d, 180 - d) < 8;
};
const chains = [];
for (const start of pieces) {
  if (start.used) continue;
  start.used = true;
  // Ordered list of [piece, reversed?].
  let seq = [{ p: start, line: start.line }];
  let grew = true;
  while (grew) {
    grew = false;
    for (const q of pieces) {
      if (q.used || !aligned(start, q)) continue;
      const head = seq[0].line[0];
      const tail = seq[seq.length - 1].line.at(-1);
      const q0 = q.line[0];
      const q1 = q.line.at(-1);
      if (dist(tail, q0) < 2) seq.push({ p: q, line: q.line });
      else if (dist(tail, q1) < 2) seq.push({ p: q, line: q.line.slice().reverse() });
      else if (dist(head, q1) < 2) seq = [{ p: q, line: q.line }, ...seq];
      else if (dist(head, q0) < 2) seq = [{ p: q, line: q.line.slice().reverse() }, ...seq];
      else continue;
      q.used = true;
      grew = true;
    }
  }
  const line = [];
  for (const s of seq) line.push(...(line.length ? s.line.slice(1) : s.line));
  const isDisplaced = (s) => s.p.tags.runway === 'displaced_threshold';
  let dStart = 0;
  for (const s of seq) {
    if (!isDisplaced(s)) break;
    dStart += lineLength(s.line);
  }
  let dEnd = 0;
  for (const s of [...seq].reverse()) {
    if (!isDisplaced(s)) break;
    dEnd += lineLength(s.line);
  }
  const tags = {};
  for (const s of seq.filter((s) => !isDisplaced(s)).concat(seq))
    for (const k of ['ref', 'surface', 'width', 'length', 'lit', 'name', 'description'])
      tags[k] ??= s.p.tags[k];
  const a = line[0];
  const b = line.at(-1);
  chains.push({
    line,
    a,
    b,
    length: dist(a, b),
    displaced: [dStart, dEnd],
    tags,
    ref: parseRef(tags.ref),
    surface: normSurface(tags.surface),
    width: Number.parseFloat(tags.width) || undefined,
    ids: seq.map((s) => s.p.id),
    used: false,
  });
}
for (const c of chains) {
  if (c.length < 100) continue;
  const ap = airportOf([(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2]);
  if (ap) ap.chains.push(c);
}

// ---------------------------------------------------------------- other OSM features

const NON_PAVED = /^(grass|dirt|gravel|ground|unpaved|earth|sand|fine_gravel|compacted)$/;
for (const e of osm) {
  const t = e.tags ?? {};
  if (t.aeroway === 'taxiway' || t.aeroway === 'taxilane') {
    if (e.type !== 'way') continue;
    if (NON_PAVED.test(t.surface ?? '')) continue;
    const line = pts(e.geometry);
    if (line.length < 2) continue;
    const ap = airportOf(line[Math.floor(line.length / 2)], 2500);
    if (ap) ap.taxiways.push({ line, tags: t });
  } else if (t.aeroway === 'apron') {
    if (NON_PAVED.test(t.surface ?? '')) continue;
    for (const ring of outerRings(e)) {
      const ap = airportOf(centroid(ring), 2500);
      if (ap) ap.aprons.push({ ring, tags: t });
    }
  } else if (t.aeroway === 'windsock' && e.type === 'node') {
    const ap = airportOf([e.lon, e.lat], 2500);
    if (ap) ap.windsocks.push([e.lon, e.lat]);
  } else if (t.aeroway === 'holding_position' && e.type === 'node') {
    const ap = airportOf([e.lon, e.lat], 2500);
    if (ap) ap.holds.push([e.lon, e.lat]);
  } else if (t.aeroway === 'tower') {
    const p = e.type === 'node' ? [e.lon, e.lat] : outerRings(e).map(centroid)[0];
    if (!p) continue;
    const ap = airportOf(p, 2500);
    if (ap) ap.towers.push(p);
  } else if (t.aeroway === 'navigationaid' && e.type === 'node') {
    const ap = airportOf([e.lon, e.lat], 5000);
    if (ap) ap.lights.push({ kind: t.navigationaid ?? '', p: [e.lon, e.lat] });
  }
}

// ---------------------------------------------------------------- runways per airport

function matchChain(ap, le, he, oaRow, refOnly) {
  const want = [le, he];
  const byRef = ap.chains.find(
    (c) =>
      !c.used &&
      c.ref &&
      ((c.ref[0] === want[0] && c.ref[1] === want[1]) ||
        (c.ref[0] === want[1] && c.ref[1] === want[0])),
  );
  if (byRef || refOnly) return byRef;
  // By geometry: the same axis, near the OurAirports runway (or the right heading).
  const brg = (identNumber(le) * 10 + VARIATION) % 180;
  const leP = [Number(oaRow.le_longitude_deg), Number(oaRow.le_latitude_deg)];
  const heP = [Number(oaRow.he_longitude_deg), Number(oaRow.he_latitude_deg)];
  const hasCoords = leP[1] && heP[1];
  const oaSurface = normSurface(oaRow.surface);
  let best;
  let bestScore = Infinity;
  for (const c of ap.chains) {
    if (c.used) continue;
    const off = Math.min(angleDiff(axis(c.line), brg), 180 - angleDiff(axis(c.line), brg));
    if (off > 15) continue;
    // A paved and a grass runway side by side: the surface tells them apart.
    if (oaSurface && c.surface && paved(oaSurface) !== paved(c.surface)) continue;
    let score;
    if (hasCoords) {
      const mid = [(leP[0] + heP[0]) / 2, (leP[1] + heP[1]) / 2];
      const cm = [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2];
      score = dist(mid, cm);
      if (score > 400) continue;
    } else {
      score = Math.abs(c.length - Number(oaRow.length_ft) * FT);
    }
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function lightsNear(ap, end, brg, kinds, alongMin, alongMax, crossMax) {
  return ap.lights.filter((l) => {
    if (!kinds.includes(l.kind)) return false;
    const [s, x] = alongCross(end, brg, l.p);
    return s >= alongMin && s <= alongMax && Math.abs(x) <= crossMax;
  });
}

for (const ap of airports) {
  const rows = oaRunways.filter(
    (r) =>
      r.airport_ident === ap.oa.ident &&
      r.closed !== '1' &&
      normIdent(r.le_ident) &&
      normIdent(r.he_ident),
  );
  // Designators first (OSM refs), then geometry for the rest: parallel runways otherwise steal
  // each other's match.
  const matched = new Map();
  for (const refOnly of [true, false])
    for (const row of rows) {
      if (matched.has(row)) continue;
      const c = matchChain(ap, normIdent(row.le_ident), normIdent(row.he_ident), row, refOnly);
      if (c) {
        c.used = true;
        matched.set(row, c);
      }
    }
  for (const row of rows) {
    const le = normIdent(row.le_ident);
    const he = normIdent(row.he_ident);
    let chain = matched.get(row);
    const oaLe0 = [Number(row.le_longitude_deg), Number(row.le_latitude_deg)];
    const oaHe0 = [Number(row.he_longitude_deg), Number(row.he_latitude_deg)];
    const tagLength = Number.parseFloat(chain?.tags.length ?? '');
    if (
      chain &&
      tagLength &&
      Math.abs(tagLength - chain.length) > 0.1 * tagLength &&
      oaLe0[1] &&
      oaHe0[1] &&
      Math.abs(dist(oaLe0, oaHe0) - tagLength) < Math.abs(chain.length - tagLength)
    ) {
      // The OSM line contradicts its own length tag (a piece is missing): OurAirports' ends
      // are the better guess.
      note(
        ap.icao,
        `${le}/${he}: OSM line is ${chain.length.toFixed(0)} m but tagged ${tagLength} m, OurAirports ends used`,
      );
      chain = undefined;
    }
    const oaLe = [Number(row.le_longitude_deg), Number(row.le_latitude_deg)];
    const oaHe = [Number(row.he_longitude_deg), Number(row.he_latitude_deg)];
    const oaHas = !!(oaLe[1] && oaHe[1] && dist(oaLe, oaHe) > 100);
    let ends;
    let displaced = [
      Number(row.le_displaced_threshold_ft) * FT || 0,
      Number(row.he_displaced_threshold_ft) * FT || 0,
    ];
    if (chain) {
      chain.used = true;
      // Orient the OSM line so that it starts at the `le` end.
      let a = chain.a;
      let b = chain.b;
      let dsp = chain.displaced;
      const brgAB = bearing(a, b);
      const leBrg = identNumber(le) * 10 + VARIATION;
      if (angleDiff(brgAB, leBrg) > 90) {
        [a, b] = [b, a];
        dsp = [dsp[1], dsp[0]];
      }
      ends = [a, b];
      if (oaHas) {
        const d0 = dist(a, oaLe);
        const d1 = dist(b, oaHe);
        if (d0 > 15 || d1 > 15)
          note(
            ap.icao,
            `${le}/${he}: ends differ OSM vs OurAirports by ${d0.toFixed(0)} m / ${d1.toFixed(0)} m (OSM used)`,
          );
      } else if (!oaLe[1] || !oaHe[1]) {
        note(ap.icao, `${le}/${he}: no end coordinates in OurAirports, taken from OSM`);
      } else
        note(
          ap.icao,
          `${le}/${he}: OurAirports ends unusable (${dist(oaLe, oaHe).toFixed(0)} m apart), taken from OSM`,
        );
      const oaDisp = displaced;
      if (dsp[0] > 1 || dsp[1] > 1) {
        if (Math.abs(dsp[0] - oaDisp[0]) > 30 || Math.abs(dsp[1] - oaDisp[1]) > 30)
          note(
            ap.icao,
            `${le}/${he}: displaced thresholds OSM ${dsp.map((v) => v.toFixed(0)).join('/')} m, OurAirports ${oaDisp.map((v) => v.toFixed(0)).join('/')} m (OSM used)`,
          );
        displaced = dsp;
      }
    } else if (oaHas) {
      ends = [oaLe, oaHe];
      note(ap.icao, `${le}/${he}: not found in OSM, OurAirports ends used`);
    } else {
      note(ap.icao, `${le}/${he}: no geometry in either source, dropped`);
      continue;
    }
    const length = dist(ends[0], ends[1]);
    if (length < 180) {
      // Helicopter and glider squares: nothing an aeroplane lines up on.
      note(ap.icao, `${le}/${he}: only ${length.toFixed(0)} m long, left out`);
      continue;
    }
    const oaLen = Number(row.length_ft) * FT;
    if (oaLen && Math.abs(oaLen - length) > Math.max(30, 0.03 * length))
      note(
        ap.icao,
        `${le}/${he}: length ${length.toFixed(0)} m from the ends, OurAirports says ${oaLen.toFixed(0)} m`,
      );
    const oaWidth = Number(row.width_ft) * FT || undefined;
    const osmWidth = chain?.width;
    if (oaWidth && osmWidth && Math.abs(oaWidth - osmWidth) > 3)
      note(
        ap.icao,
        `${le}/${he}: width OSM ${osmWidth} m, OurAirports ${oaWidth.toFixed(0)} m (OSM used)`,
      );
    const oaSurface = normSurface(row.surface);
    const surface = chain?.surface ?? oaSurface ?? (length > 800 ? 'asphalt' : 'grass');
    if (oaSurface && chain?.surface && oaSurface !== chain.surface)
      note(
        ap.icao,
        `${le}/${he}: surface OSM ${chain.surface}, OurAirports ${oaSurface} (OSM used)`,
      );
    let width = osmWidth ?? oaWidth ?? (length > 2000 ? 45 : length > 1000 ? 23 : 18);
    if (!paved(surface) && width < 15) width = Math.max(width, 15);
    ap.runways.push({
      le,
      he,
      ends,
      displaced,
      width,
      length,
      surface,
      lighted: row.lighted === '1',
      oaRow: row,
    });
  }
  // OSM runways that OurAirports does not have.
  for (const c of ap.chains) {
    if (c.used || c.length < 150) continue;
    const isHeli =
      /^h/i.test(c.tags.ref ?? '') || /heli|fato/i.test(`${c.tags.name} ${c.tags.description}`);
    if (isHeli) continue;
    let ids = c.ref;
    if (!ids) {
      if (ap.runways.length > 0) continue; // unnamed extra strip next to known runways
      ids = [identFor(bearing(c.a, c.b)), identFor(bearing(c.b, c.a))];
    }
    let [a, b] = [c.a, c.b];
    let dsp = c.displaced;
    if (angleDiff(bearing(a, b), identNumber(ids[0]) * 10 + VARIATION) > 90) {
      [a, b] = [b, a];
      dsp = [dsp[1], dsp[0]];
    }
    c.used = true;
    const surface = c.surface ?? 'grass';
    note(ap.icao, `${ids.join('/')}: only in OSM (${c.length.toFixed(0)} m ${surface}), added`);
    ap.runways.push({
      le: ids[0],
      he: ids[1],
      ends: [a, b],
      displaced: dsp,
      width: c.width ?? (paved(surface) ? 18 : 20),
      length: c.length,
      surface,
      lighted: false,
    });
  }
}

// ---------------------------------------------------------------- per end: lights, approaches

for (const ap of airports) {
  const instrument = INSTRUMENT[ap.icao] ?? {};
  for (const r of ap.runways) {
    r.endInfo = [0, 1].map((i) => {
      const end = r.ends[i];
      const other = r.ends[1 - i];
      const ident = i === 0 ? r.le : r.he;
      const brg = bearing(end, other);
      const thr = r.displaced[i];
      // Mapped approach lights in front of the threshold, on the extended centre line.
      const als = lightsNear(ap, end, brg, ['als'], -1100, thr - 20, 60);
      const alsExtent = als.length ? -Math.min(...als.map((l) => alongCross(end, brg, l.p)[0])) : 0;
      const papiNodes = lightsNear(ap, end, brg, ['papi', 'vasi'], thr - 50, thr + 700, 120);
      const approach = instrument[ident];
      const info = { ident, approach };
      if (r.lighted) {
        if (als.length >= 5) info.als = alsExtent > 600 ? 'precision' : 'simple';
        else if (approach === 'ils') info.als = r.length >= 1800 ? 'precision' : 'simple';
        else if (approach === 'npa' && r.length >= 1500) info.als = 'simple';
        if (als.length >= 5 && approach !== 'ils' && alsExtent > 600)
          note(
            ap.icao,
            `${ident}: ${als.length} approach lights mapped in OSM over ${alsExtent.toFixed(0)} m but no ILS listed`,
          );
      }
      if (papiNodes.length && paved(r.surface)) {
        const side = papiNodes.map((l) => alongCross(end, brg, l.p)[1]);
        const left = side.filter((x) => x < 0).length;
        info.papi = left >= side.length - left ? 'left' : 'right';
      } else if (r.lighted && paved(r.surface) && r.length >= 800) info.papi = 'left';
      if (approach && !r.lighted)
        note(ap.icao, `${ident}: instrument approach listed but OurAirports says unlit`);
      return info;
    });
    // Centre line lights: mapped in OSM, or a precision runway at least 45 m wide.
    const rwc = ap.lights.filter((l) => {
      if (l.kind !== 'rwc') return false;
      const [s, x] = alongCross(r.ends[0], bearing(r.ends[0], r.ends[1]), l.p);
      return s > 0 && s < r.length && Math.abs(x) < 3;
    });
    r.centerLights =
      r.lighted &&
      (rwc.length > 5 || (r.width >= 45 && r.endInfo.some((e) => e.approach === 'ils')));
    // Designator sanity: the number is the magnetic heading in tens of degrees.
    for (let i = 0; i < 2; i++) {
      const ident = r.endInfo[i].ident;
      const brg = bearing(r.ends[i], r.ends[1 - i]);
      const off = angleDiff(identNumber(ident) * 10, brg - VARIATION);
      if (off > 8)
        note(
          ap.icao,
          `${ident}: true bearing ${brg.toFixed(1)}° is ${off.toFixed(0)}° off its designator`,
        );
    }
  }
  ap.runways.sort(
    (p, q) => Number(paved(q.surface)) - Number(paved(p.surface)) || q.length - p.length,
  );
}

// ---------------------------------------------------------------- names

const PREFIX =
  /^(Flughafen|Flugplatz|Flugfeld|Sportflugplatz|Militärflugplatz|Segelflugplatz|Aéroport de|Aérodrome de|Aeroporto di|Aéroport international de|Base aérienne de)\s+/i;
function nameOf(ap) {
  if (NAMES[ap.icao]) return NAMES[ap.icao];
  const raw = ap.osm?.tags['name:de'] ?? ap.osm?.tags.name ?? ap.oa.name;
  return raw.replace(PREFIX, '').replace(/\s+(Airport|Airfield|Aerodrome|Air Base)$/i, '');
}

// ---------------------------------------------------------------- output

const out = airports
  .filter((ap) => ap.runways.length > 0)
  .sort((p, q) => p.icao.localeCompare(q.icao));
for (const ap of airports)
  if (ap.runways.length === 0 && ap.oa.type !== 'heliport')
    report.push(`${ap.icao}: no runway with geometry, left out (${ap.oa.name})`);

const icaos = new Set();
for (const ap of out) {
  if (icaos.has(ap.icao)) throw new Error(`duplicate ICAO ${ap.icao}`);
  icaos.add(ap.icao);
}

/** Integer offsets from the origin in 1e-7 degrees (1 cm): small numbers, exact to 1 cm. */
const Q = 1e7;
const enc = (o, line) =>
  line.flatMap((p) => [Math.round((p[0] - o[0]) * Q), Math.round((p[1] - o[1]) * Q)]);

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of fs.readdirSync(OUT_DIR))
  if (f.endsWith('.json')) fs.unlinkSync(path.join(OUT_DIR, f));
let detailBytes = 0;
const withDetail = new Set();
for (const ap of out) {
  const o = [round6(ap.pos[0]), round6(ap.pos[1])];
  const large = ap.oa.type === 'large_airport';
  const medium = ap.oa.type === 'medium_airport';
  // At a grass airfield an untagged taxiway is grass too: only paved ones are drawn.
  const hasPaved = ap.runways.some((r) => paved(r.surface));
  const taxiways = ap.taxiways
    .filter(({ tags }) => hasPaved || paved(normSurface(tags.surface)))
    .map(({ line, tags }) => ({
      w: round1(
        Number.parseFloat(tags.width) ||
          (tags.aeroway === 'taxilane' ? 10 : large ? 23 : medium ? 15 : 10.5),
      ),
      c: enc(o, line),
    }));
  const aprons = ap.aprons.map(({ ring }) => ({ c: enc(o, ring.slice(0, -1)) }));
  const detail = {
    v: 1,
    icao: ap.icao,
    origin: o,
    scale: 1 / Q,
    taxiways,
    aprons,
    windsocks: ap.windsocks.map((p) => enc(o, [p])),
    holds: ap.holds.map((p) => enc(o, [p])),
    towers: ap.towers.map((p) => enc(o, [p])),
  };
  if (!taxiways.length && !aprons.length && !detail.windsocks.length) continue;
  const text = JSON.stringify(detail);
  fs.writeFileSync(path.join(OUT_DIR, `${ap.icao}.json`), text);
  detailBytes += text.length;
  withDetail.add(ap.icao);
}

const ft = (v) => (v ? Math.round(Number(v) * FT * 10) / 10 : undefined);
const tsAirports = out.map((ap) => {
  const military =
    ap.osm?.tags.military === 'airfield' ||
    /air base|militär|base aérienne/i.test(`${ap.oa.name} ${ap.osm?.tags.name ?? ''}`);
  return {
    icao: ap.icao,
    name: nameOf(ap),
    country: BORDER_AIRPORTS.includes(ap.icao) ? ap.oa.iso_country : ap.oa.iso_country,
    kind:
      ap.oa.type === 'large_airport'
        ? 'major'
        : ap.oa.type === 'medium_airport'
          ? 'regional'
          : 'airfield',
    military,
    lon: round6(ap.pos[0]),
    lat: round6(ap.pos[1]),
    elevation: ft(ap.oa.elevation_ft) ?? 0,
    detail: withDetail.has(ap.icao),
    runways: ap.runways.map((r) => ({
      width: round1(r.width),
      length: Math.round(r.length),
      surface: r.surface,
      lighted: r.lighted,
      centerLights: r.centerLights || undefined,
      ends: r.endInfo.map((e, i) => ({
        ident: e.ident,
        lon: round6(r.ends[i][0]),
        lat: round6(r.ends[i][1]),
        displaced: r.displaced[i] > 1 ? Math.round(r.displaced[i]) : undefined,
        elevation: r.oaRow
          ? ft(i === 0 ? r.oaRow.le_elevation_ft : r.oaRow.he_elevation_ft)
          : undefined,
        approach: e.approach,
        als: e.als,
        papi: e.papi,
      })),
    })),
  };
});

/** Compact TypeScript literal: one runway end per line, no undefined fields. */
function literal(v, indent = '') {
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const inner = indent + '  ';
    return '[\n' + v.map((x) => inner + literal(x, inner) + ',').join('\n') + '\n' + indent + ']';
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    const flat = entries.every(([, x]) => typeof x !== 'object');
    if (flat) return '{ ' + entries.map(([k, x]) => `${k}: ${literal(x)}`).join(', ') + ' }';
    const inner = indent + '  ';
    return (
      '{\n' +
      entries.map(([k, x]) => `${inner}${k}: ${literal(x, inner)},`).join('\n') +
      '\n' +
      indent +
      '}'
    );
  }
  return typeof v === 'string' ? `'${v.replace(/'/g, "\\'")}'` : String(v);
}

const ts = `// Generated by tools/airports/build.mjs from OurAirports (public domain) and OpenStreetMap
// (© OpenStreetMap contributors, ODbL 1.0). Do not edit: change the tool or its curated.mjs.
import type { AirportInfo } from './airports';

export const AIRPORT_DATA: AirportInfo[] = ${literal(tsAirports)};
`;
// Formatted like the rest of the code, so that a rebuild shows only real changes in a diff.
const prettier = await import('prettier');
const options = (await prettier.resolveConfig(OUT_TS)) ?? {};
const formatted = await prettier.format(ts, { ...options, filepath: OUT_TS });
fs.writeFileSync(OUT_TS, formatted);
fs.writeFileSync(path.join(CACHE, 'report.txt'), report.join('\n') + '\n');

const nRunways = tsAirports.reduce((s, a) => s + a.runways.length, 0);
console.log(`${tsAirports.length} airports, ${nRunways} runways`);
console.log(`${OUT_TS}: ${(formatted.length / 1024).toFixed(1)} KB`);
console.log(`${OUT_DIR}: ${withDetail.size} files, ${(detailBytes / 1024).toFixed(1)} KB`);
console.log(`${report.length} notes in ${CACHE}/report.txt`);
