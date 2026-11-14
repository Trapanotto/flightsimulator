// Builds the navigation data of the game from open sources. Run by hand when the sources change
// (after tools/airports/build.mjs, whose runways it lines the localizers up with):
//
//   node tools/nav/build.mjs            uses the cached downloads in build/nav/
//   node tools/nav/build.mjs --refresh  downloads everything again
//
// Sources:
//   OurAirports (public domain), https://davidmegginson.github.io/ourairports-data/
//     navaids.csv: VOR, DME, NDB (ident, name, frequency, position, elevation, class);
//     airport-frequencies.csv: tower, ground, approach, ATIS ... of every airport.
//   OpenStreetMap via Overpass (ODbL 1.0, "© OpenStreetMap contributors"): beacons
//     (airmark=beacon) as a second source for the stations, and mapped localizer and glide
//     slope antennas.
//   Federal Office of Civil Aviation FOCA via api3.geo.admin.ch (Swiss open government data,
//     free use with attribution "© FOCA"): control zones, terminal areas, the Samedan FIZ.
//   swisstopo swissBOUNDARIES3D via api3.geo.admin.ch (open data, "© swisstopo"): the Swiss
//     border, to select the stations within 100 km of it.
//   tools/nav/curated.mjs: ILS frequencies, idents and glide path angles, corrections, the
//     fixes; each with its source and how sure it is.
//   FlightGear / X-Plane nav.dat (GPL) was consulted by hand for single facts only and is not
//     read by this script.
//
// Output:
//   src/geo/nav.generated.ts   stations, fixes, frequencies, airspaces (small, checked in)
//   build/nav/report.txt       where the sources disagree
import fs from 'node:fs';
import path from 'node:path';
import {
  CALLSIGNS,
  EXTRA_NAVAIDS,
  FIS,
  FIS_LINE,
  IFR_FIXES,
  ILS,
  NAVAID_FIXES,
  OA_TYPES,
  TMA_CLASS_C,
  VFR_AIRPORTS,
} from './curated.mjs';

const CACHE = 'build/nav';
const OUT_TS = 'src/geo/nav.generated.ts';
const AIRPORTS_TS = 'src/geo/airports.generated.ts';
const refresh = process.argv.includes('--refresh');
/** Stations up to this far outside the Swiss border are kept. */
const MARGIN = 100_000;
const FT = 0.3048;
const NM = 1852;

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
  const res = await fetch(url, { headers: { 'User-Agent': 'tfs-nav-tool' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const OVERPASS_QUERY = `[out:json][timeout:180];
(nwr["airmark"="beacon"](45.0,5.0,48.6,11.6););
out center tags;`;

async function overpass() {
  const servers = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = servers[attempt % servers.length];
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'tfs-nav-tool',
      },
      body: 'data=' + encodeURIComponent(OVERPASS_QUERY),
    }).catch((err) => ({ ok: false, status: String(err) }));
    if (res.ok) return res.text();
    console.log(`${url}: HTTP ${res.status}, retrying`);
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  throw new Error('Overpass: no server answered');
}

/** Every feature of a geo.admin.ch layer over Switzerland, as GeoJSON in WGS84. */
function geoAdmin(layer, geometryType = 'esriGeometryEnvelope', geometry = '5.8,45.7,10.6,47.9') {
  const q = new URLSearchParams({
    geometryType,
    geometry,
    geometryFormat: 'geojson',
    imageDisplay: '1000,1000,96',
    mapExtent: '5.8,45.7,10.6,47.9',
    tolerance: '0',
    layers: `all:${layer}`,
    returnGeometry: 'true',
    sr: '4326',
    limit: '200',
  });
  return download(`https://api3.geo.admin.ch/rest/services/api/MapServer/identify?${q}`);
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
const oaNavaids = parseCsv(await cached('navaids.csv', () => download(OA_BASE + 'navaids.csv')));
const oaFreqs = parseCsv(
  await cached('airport-frequencies.csv', () => download(OA_BASE + 'airport-frequencies.csv')),
);
const oaAirportElevation = new Map(
  parseCsv(await cached('airports.csv', () => download(OA_BASE + 'airports.csv'))).map((a) => [
    a.ident,
    a.elevation_ft,
  ]),
);
const osm = JSON.parse(await cached('overpass.json', overpass)).elements;
const airspaceLayers = {
  CTR: 'ch.bazl.luftraeume-kontrollzonen',
  TMA: 'ch.bazl.luftraeume-nahkontrollbezirke',
  FIZ: 'ch.bazl.luftraeume-fluginformationszonen',
};
const focaFeatures = [];
for (const [type, layer] of Object.entries(airspaceLayers)) {
  const json = JSON.parse(await cached(`${layer}.json`, () => geoAdmin(layer)));
  for (const f of json.results) focaFeatures.push({ ...f, kind: type });
}
const border = JSON.parse(
  await cached('border.json', () =>
    geoAdmin('ch.swisstopo.swissboundaries3d-land-flaeche.fill', 'esriGeometryPoint', '8.2,46.8'),
  ),
).results[0].geometry.coordinates[0][0];

// The airports as the game draws them: the localizers must line up with these runways.
const airportsText = fs.readFileSync(AIRPORTS_TS, 'utf8');
const AIRPORTS = new Function(
  'return ' + /AIRPORT_DATA: AirportInfo\[\] = ([\s\S]*);\s*$/.exec(airportsText)[1],
)();
const airportByIcao = new Map(AIRPORTS.map((a) => [a.icao, a]));

// ---------------------------------------------------------------- geometry

const RAD = Math.PI / 180;
const R = 6_371_000;
function dist(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a, b) {
  const dLon = (b[0] - a[0]) * RAD;
  const y = Math.sin(dLon) * Math.cos(b[1] * RAD);
  const x =
    Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) -
    Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos(dLon);
  return (((Math.atan2(y, x) / RAD) % 360) + 360) % 360;
}
function offset(p, brg, m) {
  const d = m / R;
  const b = brg * RAD;
  const lat1 = p[1] * RAD;
  const lat = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon =
    p[0] * RAD +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat),
    );
  return [lon / RAD, lat / RAD];
}
/** Local east/north metres of p relative to o. */
function en(o, p) {
  return [(p[0] - o[0]) * RAD * R * Math.cos(o[1] * RAD), (p[1] - o[1]) * RAD * R];
}
/** Along-track and cross-track (positive right) metres of p from a on bearing brg. */
function alongCross(a, brg, p) {
  const [e, n] = en(a, p);
  const s = Math.sin(brg * RAD);
  const c = Math.cos(brg * RAD);
  return [e * s + n * c, e * c - n * s];
}
function inside(p, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
/** Metres from p to the segment a-b (flat locally). */
function segmentDist(p, a, b) {
  const [ax, ay] = en(p, a);
  const [bx, by] = en(p, b);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
/** Douglas-Peucker on [lon, lat] points; returns the kept points. */
function simplify(points, tol) {
  if (points.length < 3) return points.slice();
  let worst = 0;
  let at = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = segmentDist(points[i], a, b);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= tol) return [a, b];
  const left = simplify(points.slice(0, at + 1), tol);
  return left.slice(0, -1).concat(simplify(points.slice(at), tol));
}
/** Simplifies a closed ring (first == last or not); returns the open ring. */
function simplifyRing(ring, tol) {
  const open = dist(ring[0], ring.at(-1)) < 1 ? ring.slice(0, -1) : ring.slice();
  // Split at the point farthest from the first, so that both halves are open lines.
  let far = 0;
  for (let i = 1; i < open.length; i++)
    if (dist(open[0], open[i]) > dist(open[0], open[far])) far = i;
  const a = simplify(open.slice(0, far + 1), tol);
  const b = simplify(open.slice(far).concat([open[0]]), tol);
  return a.slice(0, -1).concat(b.slice(0, -1));
}
/** Largest distance of any original point from the simplified ring's outline. */
function ringError(orig, simple) {
  let worst = 0;
  for (const p of orig) {
    let best = Infinity;
    for (let i = 0; i < simple.length; i++)
      best = Math.min(best, segmentDist(p, simple[i], simple[(i + 1) % simple.length]));
    worst = Math.max(worst, best);
  }
  return worst;
}
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r2 = (v) => Math.round(v * 100) / 100;

const report = [];
const note = (text) => report.push(text);

// ---------------------------------------------------------------- the border

const borderLine = simplifyRing(border, 2000);
function distanceToSwitzerland(p) {
  if (inside(p, borderLine)) return 0;
  let best = Infinity;
  for (let i = 0; i < borderLine.length; i++)
    best = Math.min(best, segmentDist(p, borderLine[i], borderLine[(i + 1) % borderLine.length]));
  return best;
}

// ---------------------------------------------------------------- radio stations

/** OSM beacons with a code, for the cross-check. */
const osmBeacons = osm
  .map((e) => ({
    t: e.tags ?? {},
    p: [e.lon ?? e.center?.lon, e.lat ?? e.center?.lat],
  }))
  .filter((b) => b.p[0] !== undefined);
/** kHz from an OSM frequency tag: "113.90 MHz", "375 kHz", "0.337", "116". */
function osmKhz(s) {
  // A TACAN channel ("108X") is no frequency.
  if (/\d\s*[XY]\b/i.test(s ?? '')) return undefined;
  const m = /([\d.]+)\s*(mhz|khz)?/i.exec(s ?? '');
  if (!m) return undefined;
  const v = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  if (unit === 'mhz' || (!unit && v >= 100 && v < 140 && String(m[1]).includes('.')))
    return Math.round(v * 1000);
  if (unit === 'khz') return v;
  if (v < 2) return Math.round(v * 1000); // "0.337" MHz for an NDB
  if (v >= 108 && v < 118) return Math.round(v * 1000); // "116"
  return v;
}

/** VHF frequency (kHz) of a DME channel like "037Y". */
function channelKhz(ch) {
  const m = /^0*(\d{1,3})([XY])$/i.exec(ch ?? '');
  if (!m) return undefined;
  const n = Number(m[1]);
  const y = m[2].toUpperCase() === 'Y' ? 50 : 0;
  if (n >= 17 && n <= 59) return 108000 + (n - 17) * 100 + y;
  if (n >= 70 && n <= 126) return 112300 + (n - 70) * 100 + y;
  return undefined;
}

/** Nautical miles a station is received at, by type and class. */
function rangeFor(type, power, usage) {
  if (type === 'NDB') return power === 'HIGH' ? 75 : power === 'MEDIUM' ? 50 : 25;
  if (usage === 'TERMINAL') return 25;
  return power === 'HIGH' ? 130 : power === 'MEDIUM' ? 80 : 40;
}

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/(^|[\s/-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())
    .replace(/\bDu\b/g, 'du');

const stations = [];
for (const row of oaNavaids) {
  const type = OA_TYPES[row.type];
  if (!type) continue;
  const p = [Number(row.longitude_deg), Number(row.latitude_deg)];
  if (!(p[1] > 44 && p[1] < 49.5 && p[0] > 4 && p[0] < 12.5)) continue;
  if (distanceToSwitzerland(p) > MARGIN) continue;
  const key = `${row.ident} ${row.type}`;
  let freq = Number(row.frequency_khz);
  const fix = NAVAID_FIXES[key];
  if (fix) {
    note(`${key}: OurAirports ${freq} kHz replaced by ${fix.freq} (curated)`);
    freq = fix.freq;
  } else if (type !== 'NDB' && row.dme_channel) {
    const ch = channelKhz(row.dme_channel);
    if (ch && ch !== freq)
      note(`${key}: frequency ${freq} vs DME channel ${row.dme_channel} (${ch})`);
  }
  // Some NDBs have no elevation: their airport's is close enough for line of sight.
  let elevation = Number(row.elevation_ft) * FT;
  if (!row.elevation_ft) {
    const apElev = Number(oaAirportElevation.get(row.associated_airport)) * FT;
    elevation = apElev || 0;
    note(`${key}: no elevation in OurAirports, ${apElev ? 'its airport' : 'sea level'} used`);
  }
  const name = titleCase(row.name) + (row.type === 'TACAN' ? ' TACAN' : '');
  stations.push({
    ident: row.ident,
    name,
    type,
    frequency: freq,
    lon: r5(p[0]),
    lat: r5(p[1]),
    elevation: Math.round(elevation),
    rangeNm: rangeFor(type, row.power, row.usageType),
    dme:
      type === 'VOR-DME' && row.dme_latitude_deg
        ? {
            lon: r5(Number(row.dme_longitude_deg)),
            lat: r5(Number(row.dme_latitude_deg)),
            elevation: Math.round(Number(row.dme_elevation_ft || row.elevation_ft) * FT),
          }
        : undefined,
  });
}
for (const x of EXTRA_NAVAIDS) {
  stations.push({
    ident: x.ident,
    name: x.name,
    type: x.type,
    frequency: x.freq,
    lon: x.lon,
    lat: x.lat,
    elevation: x.elev,
    rangeNm: rangeFor(x.type, x.power, 'BOTH'),
  });
}
// A VOR-DME's DME stands at the VOR when the source gives no separate position.
for (const s of stations)
  if (s.type === 'VOR-DME' && !s.dme) s.dme = { lon: s.lon, lat: s.lat, elevation: s.elevation };

// Cross-check with OSM: same code within 3 km.
for (const s of stations) {
  const near = osmBeacons.filter(
    (b) =>
      (b.t['beacon:code'] ?? b.t.ref ?? '').toUpperCase() === s.ident &&
      dist([s.lon, s.lat], b.p) < 3000,
  );
  const sameKind = near.filter((b) => /NDB/i.test(b.t['beacon:type'] ?? '') === (s.type === 'NDB'));
  if (sameKind.length === 0) {
    note(`${s.ident} ${s.type}: not in OSM`);
    continue;
  }
  const khz = sameKind.map((b) => osmKhz(b.t['beacon:frequency'])).filter((v) => v !== undefined);
  if (khz.length && !khz.some((v) => Math.abs(v - s.frequency) <= 1))
    note(`${s.ident} ${s.type}: OSM says ${khz.join('/')} kHz, kept ${s.frequency}`);
  const d = Math.min(...sameKind.map((b) => dist([s.lon, s.lat], b.p)));
  if (d > 200) note(`${s.ident} ${s.type}: OSM position ${d.toFixed(0)} m away`);
}

// ---------------------------------------------------------------- ILS

function runwayEnds(icao, ident) {
  const ap = airportByIcao.get(icao);
  if (!ap) throw new Error(`ILS: unknown airport ${icao}`);
  for (const r of ap.runways) {
    const i = r.ends.findIndex((e) => e.ident === ident);
    if (i >= 0) return { ap, runway: r, end: r.ends[i], opposite: r.ends[1 - i] };
  }
  throw new Error(`ILS: ${icao} has no runway ${ident}`);
}

const ilsAntennas = osmBeacons.filter(
  (b) =>
    /ILS|LOC/i.test(b.t['beacon:type'] ?? '') ||
    /^(GP|LOC)\b/i.test(b.t.name ?? '') ||
    b.t.localizer === 'yes' ||
    b.t.glideslope === 'yes',
);
const isGlide = (b) => b.t.glideslope === 'yes' || /^GP\b/i.test(b.t.name ?? '');
const isLoc = (b) => b.t.localizer === 'yes' || /^LOC\b/i.test(b.t.name ?? '');

for (const ils of ILS) {
  const { ap, runway, end, opposite } = runwayEnds(ils.icao, ils.runway);
  const a = [end.lon, end.lat];
  const b = [opposite.lon, opposite.lat];
  const rwyCourse = bearing(a, b);
  const thr = end.displaced ? offset(a, rwyCourse, end.displaced) : a;
  const elev = end.elevation ?? ap.elevation;
  const farElev = opposite.elevation ?? ap.elevation;
  // Localizer: beyond the far end, near the centre line.
  const locs = ilsAntennas
    .filter(isLoc)
    .map((x) => ({ x, ac: alongCross(a, rwyCourse, x.p) }))
    .filter(
      ({ ac }) => ac[0] > runway.length && ac[0] < runway.length + 1500 && Math.abs(ac[1]) < 60,
    );
  let loc;
  if (locs.length && !ils.course) loc = locs[0].x.p;
  else {
    loc = offset(b, rwyCourse, 300);
    if (!ils.course)
      note(
        `${ils.icao} ${ils.runway}: localizer not mapped in OSM, placed 300 m beyond the far end`,
      );
  }
  if (locs.length) {
    const tagged = osmKhz(locs[0].x.t['beacon:frequency']);
    if (tagged && tagged !== ils.freq)
      note(`${ils.icao} ${ils.runway}: OSM tags the localizer ${tagged} kHz, curated ${ils.freq}`);
  }
  // Glide slope: 100-600 m past the threshold, 60-250 m beside the centre line.
  const gss = ilsAntennas
    .filter(isGlide)
    .map((x) => ({ x, ac: alongCross(thr, rwyCourse, x.p) }))
    .filter(
      ({ ac }) => ac[0] > 100 && ac[0] < 600 && Math.abs(ac[1]) > 60 && Math.abs(ac[1]) < 250,
    );
  let gs;
  if (gss.length) gs = gss[0].x.p;
  else {
    const side = end.papi === 'right' ? 90 : -90;
    gs = offset(offset(thr, rwyCourse, 300), rwyCourse + side, 120);
    note(`${ils.icao} ${ils.runway}: glide slope not mapped in OSM, placed by rule`);
  }
  const course = ils.course ?? rwyCourse;
  if (ils.course)
    note(
      `${ils.icao} ${ils.runway}: offset course ${ils.course} T, runway ${rwyCourse.toFixed(2)} T`,
    );
  stations.push({
    ident: ils.ident,
    name: `${ap.name} ILS ${ils.runway}`,
    type: 'ILS',
    frequency: ils.freq,
    lon: r5(loc[0]),
    lat: r5(loc[1]),
    elevation: Math.round(farElev),
    rangeNm: 25,
    course: r2(course),
    glideSlope: { lon: r5(gs[0]), lat: r5(gs[1]), elevation: Math.round(elev), angleDeg: ils.gs },
    dme:
      ils.dme === false
        ? undefined
        : { lon: r5(gs[0]), lat: r5(gs[1]), elevation: Math.round(elev) },
    airport: ils.icao,
    runway: ils.runway,
  });
  if (end.approach !== 'ils')
    note(`${ils.icao} ${ils.runway}: airports.generated.ts does not mark an ILS here`);
}
for (const ap of AIRPORTS)
  for (const r of ap.runways)
    for (const e of r.ends)
      if (e.approach === 'ils' && !ILS.some((i) => i.icao === ap.icao && i.runway === e.ident))
        note(
          `${ap.icao} ${e.ident}: marked ILS in airports.generated.ts, but no frequency verified`,
        );

stations.sort((p, q) => p.type.localeCompare(q.type) || p.ident.localeCompare(q.ident));

// ---------------------------------------------------------------- airspaces

const airspaces = [];
for (const f of focaFeatures) {
  const p = f.properties;
  const designator = p.designator;
  const icao = designator.slice(0, 4);
  if (f.kind !== 'FIZ' && !/^(LS|LFSB|EDNY)/.test(icao)) continue;
  const airport = f.kind === 'FIZ' ? 'LSZS' : icao;
  const limit = (value, type) => ({ ref: type === 'AMSL' ? 'MSL' : type, value });
  const polys =
    f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
  for (const poly of polys) {
    const outer = poly[0].map((c) => [c[0], c[1]]);
    // A dozen points or so: start fine and coarsen until it fits. Long thin sectors lose
    // kilometres that way; they may keep up to 28 points to stay within about a kilometre.
    const fit = (maxPoints) => {
      let tol = 150;
      let ring = simplifyRing(outer, tol);
      while (ring.length > maxPoints) {
        tol *= 1.3;
        ring = simplifyRing(outer, tol);
      }
      return { ring, err: ringError(outer, ring) };
    };
    let { ring, err } = fit(16);
    if (err > 800) ({ ring, err } = fit(28));
    airspaces.push({
      name: titleCase(p.name)
        .replace(/\bCtr\b/, 'CTR')
        .replace(/\bTma\b/, 'TMA')
        .replace(/\bFiz\b/, 'FIZ'),
      designator,
      type: f.kind,
      class: f.kind === 'FIZ' ? 'G' : f.kind === 'TMA' && TMA_CLASS_C.includes(icao) ? 'C' : 'D',
      airport,
      lower: limit(p.loli_value, p.loli_type),
      upper: limit(p.upli_value, p.upli_type),
      ring: ring.flatMap((q) => [r5(q[0]), r5(q[1])]),
      toleranceM: Math.ceil(err / 50) * 50,
    });
  }
}
airspaces.sort(
  (p, q) =>
    p.type.localeCompare(q.type) ||
    p.designator.localeCompare(q.designator) ||
    p.lower.value - q.lower.value,
);

// ---------------------------------------------------------------- fixes

const fixes = [];
for (const f of IFR_FIXES)
  fixes.push({
    ident: f.ident,
    name: f.ident,
    kind: f.role,
    lon: f.lon,
    lat: f.lat,
    airport: f.airport,
  });

// Final approach fixes 6 NM out on the localizer course (or the centre line of a non-precision
// runway), at the glide path height: computed, not the published fix.
for (const ap of AIRPORTS)
  for (const r of ap.runways)
    for (let i = 0; i < 2; i++) {
      const end = r.ends[i];
      if (!end.approach) continue;
      const opp = r.ends[1 - i];
      const a = [end.lon, end.lat];
      const rc = bearing(a, [opp.lon, opp.lat]);
      const thr = end.displaced ? offset(a, rc, end.displaced) : a;
      const ils = ILS.find((x) => x.icao === ap.icao && x.runway === end.ident);
      const course = ils?.course ?? rc;
      const angle = ils?.gs ?? 3;
      const p = offset(thr, course + 180, 6 * NM);
      const elev = end.elevation ?? ap.elevation;
      fixes.push({
        ident: `FF${end.ident}`,
        name: `Final approach fix ${end.ident}`,
        kind: 'faf',
        lon: r5(p[0]),
        lat: r5(p[1]),
        airport: ap.icao,
        runway: end.ident,
        altitude: Math.round(elev + 15 + Math.tan(angle * RAD) * 6 * NM),
        approximate: true,
      });
    }

// VFR reporting points where the cardinal lines leave the control zone (see curated.mjs).
const CARDINAL = [
  ['N', 'November', 0],
  ['E', 'Echo', 90],
  ['S', 'Sierra', 180],
  ['W', 'Whiskey', 270],
];
for (const icao of VFR_AIRPORTS) {
  const ap = airportByIcao.get(icao);
  const ctr = focaFeatures.find((f) => f.kind === 'CTR' && f.properties.designator === icao);
  if (!ap || !ctr) {
    note(`${icao}: no CTR, no VFR points`);
    continue;
  }
  const rings = (
    ctr.geometry.type === 'MultiPolygon' ? ctr.geometry.coordinates : [ctr.geometry.coordinates]
  ).map((poly) => poly[0]);
  for (const [ident, word, brg] of CARDINAL) {
    // Walk out in 200 m steps; the last step inside the zone is the boundary.
    let last;
    for (let m = 0; m < 40_000; m += 200) {
      const p = offset([ap.lon, ap.lat], brg, m);
      if (rings.some((ring) => inside(p, ring))) last = p;
    }
    if (!last) continue;
    fixes.push({
      ident,
      name: word,
      kind: 'vfr',
      lon: r5(last[0]),
      lat: r5(last[1]),
      airport: icao,
      approximate: true,
    });
  }
}
fixes.sort(
  (p, q) =>
    p.airport.localeCompare(q.airport) ||
    p.kind.localeCompare(q.kind) ||
    p.ident.localeCompare(q.ident),
);

// ---------------------------------------------------------------- frequencies

/** Snaps to the nearest channel name of the 25 / 8.33 kHz raster (as dialled). */
function channelName(khz) {
  const base = Math.floor(khz / 25) * 25;
  const names = [];
  for (const b of [base - 25, base, base + 25]) for (const n of [0, 5, 10, 15]) names.push(b + n);
  // 8.33 channel names end in 05, 10, 15 (after 00) etc.; plain 25 kHz names are b + 0.
  return names.reduce((best, n) => (Math.abs(n - khz) < Math.abs(best - khz) ? n : best));
}

const FIS_KHZ = new Set(FIS.map((f) => f.freq));
const OTHER_UNITS = /^(ZURICH|GENEVA|BERN|SWISS|LANGEN|MILANO|STRASBOURG)\b/i;
const SUFFIX = {
  atis: 'ATIS',
  delivery: 'Delivery',
  ground: 'Ground',
  apron: 'Apron',
  tower: 'Tower',
  approach: 'Approach',
  arrival: 'Arrival',
  departure: 'Departure',
  info: 'Information',
};
function kindOf(type, desc) {
  const t = type.toUpperCase();
  const d = desc.toUpperCase();
  if (/^(TWR|TOWER)$/.test(t)) return 'tower';
  if (/^(GND|GROUND)$/.test(t)) return 'ground';
  if (/^(CLD|DEL|CLNC)$/.test(t)) return 'delivery';
  if (/^(RMP|GTE|APRON)/.test(t) || /APRON|APN/.test(d)) return 'apron';
  if (t === 'ATIS') return 'atis';
  if (t === 'DEP') return 'departure';
  if (t === 'ARR' || (/ARR\b/.test(d) && !/DEP/.test(d))) return 'arrival';
  if (/^(APP|A\/D|APCH)/.test(t)) return 'approach';
  if (/^(AFIS|INFO|AD|A\/A|AERODROME)$/.test(t) || /AERODROME|AÉRODROME|AIRFIELD/.test(d))
    return 'info';
  return undefined;
}

const frequencies = [];
for (const row of oaFreqs) {
  const ap = airportByIcao.get(row.airport_ident);
  if (!ap) continue;
  const raw = Math.round(Number(row.frequency_mhz) * 1000);
  // Military UHF and VHF outside the airband (the simulation's radios cannot tune them).
  if (!(raw >= 118000 && raw <= 136990)) continue;
  if (FIS_KHZ.has(raw)) continue;
  const kind = kindOf(row.type, row.description);
  if (!kind) {
    note(`${ap.icao}: frequency ${row.type} "${row.description}" ${row.frequency_mhz} left out`);
    continue;
  }
  const khz = channelName(raw);
  if (khz !== raw) note(`${ap.icao}: ${row.frequency_mhz} MHz is no channel, ${khz / 1000} used`);
  const other = OTHER_UNITS.exec(row.description)?.[1];
  const base =
    other && other.toUpperCase() !== (CALLSIGNS[ap.icao] ?? '').toUpperCase()
      ? titleCase(other)
      : (CALLSIGNS[ap.icao] ?? ap.name);
  let suffix = SUFFIX[kind];
  if (kind === 'approach' && /FINAL/i.test(row.description)) suffix = 'Final';
  if (kind === 'info' && /\bINFO\b/i.test(row.description) && !/INFORMATION/i.test(row.description))
    suffix = 'Info';
  if (other && /RADAR/i.test(row.description)) suffix = 'Radar';
  const name = `${base} ${suffix}`;
  if (frequencies.some((f) => f.airport === ap.icao && f.frequency === khz)) continue;
  frequencies.push({ airport: ap.icao, type: kind, name, frequency: khz });
}
const ORDER = Object.keys(SUFFIX);
frequencies.sort(
  (p, q) =>
    p.airport.localeCompare(q.airport) ||
    ORDER.indexOf(p.type) - ORDER.indexOf(q.type) ||
    p.frequency - q.frequency,
);

// ---------------------------------------------------------------- output

function literal(v, indent = '') {
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.every((x) => typeof x === 'number')) return '[' + v.join(', ') + ']';
    const inner = indent + '  ';
    return '[\n' + v.map((x) => inner + literal(x, inner) + ',').join('\n') + '\n' + indent + ']';
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    return '{ ' + entries.map(([k, x]) => `${k}: ${literal(x, indent)}`).join(', ') + ' }';
  }
  return typeof v === 'string' ? `'${v.replace(/'/g, "\\'")}'` : String(v);
}

const counts = {};
for (const s of stations) counts[s.type] = (counts[s.type] ?? 0) + 1;
const countText = Object.entries(counts)
  .map(([k, v]) => `${v} ${k}`)
  .join(', ');
const maxTol = Math.max(...airspaces.map((a) => a.toleranceM));
const medTol = airspaces.map((a) => a.toleranceM).sort((a, b) => a - b)[
  Math.floor(airspaces.length / 2)
];

const ts = `// Generated by tools/nav/build.mjs. Do not edit: change the tool or tools/nav/curated.mjs.
//
// Sources and licences:
//   OurAirports navaids.csv and airport-frequencies.csv (public domain): VOR, DME, NDB and the
//     airport frequencies; stations within ${MARGIN / 1000} km of the Swiss border.
//   OpenStreetMap (© OpenStreetMap contributors, ODbL 1.0): second source for the stations,
//     positions of mapped localizer and glide slope antennas, stations OurAirports lacks.
//   Federal Office of Civil Aviation FOCA via geo.admin.ch (open government data, © FOCA):
//     CTR, TMA and FIZ outlines and limits, simplified to 16 points (28 for long thin sectors)
//     or fewer (median error ${medTol} m, worst ${maxTol} m; each airspace carries its own
//     toleranceM). Lower and upper limits as published; classes curated.
//   swisstopo swissBOUNDARIES3D (open data, © swisstopo): the border used for the selection.
//   tools/nav/curated.mjs: ILS frequencies, idents and glide paths, corrections, named fixes,
//     from the AIPs as published, with the source and confidence of each entry.
// Localizer courses follow the runways of airports.generated.ts (except published offsets).
// Final approach fixes and VFR reporting points are placed by rule (approximate: true).
// ${countText}; ${fixes.length} fixes; ${frequencies.length} frequencies; ${airspaces.length} airspaces.
// Not for real navigation.
import type { Airspace, AirportFrequency, FisStation, NavFix, NavStationInfo } from './nav';

export const NAV_STATION_DATA: NavStationInfo[] = ${literal(stations)};

export const NAV_FIX_DATA: NavFix[] = ${literal(fixes)};

export const AIRPORT_FREQUENCY_DATA: AirportFrequency[] = ${literal(frequencies)};

export const FIS_DATA: FisStation[] = ${literal(FIS.map((f) => ({ name: f.name, frequency: f.freq })))};

/** North to south; west of it is Geneva Information (approximate). */
export const FIS_LINE_DATA: Array<[number, number]> = ${JSON.stringify(FIS_LINE)};

export const AIRSPACE_DATA: Airspace[] = ${literal(airspaces)};
`;
const prettier = await import('prettier');
const options = (await prettier.resolveConfig(OUT_TS)) ?? {};
const formatted = await prettier.format(ts, { ...options, filepath: OUT_TS });
fs.writeFileSync(OUT_TS, formatted);
fs.writeFileSync(path.join(CACHE, 'report.txt'), report.join('\n') + '\n');

console.log(countText);
console.log(
  `${fixes.length} fixes, ${frequencies.length} frequencies, ${airspaces.length} airspaces`,
);
console.log(`${OUT_TS}: ${(formatted.length / 1024).toFixed(1)} KB`);
console.log(`${report.length} notes in ${CACHE}/report.txt`);
