import { ALL_RUNWAYS } from './aerodromes.generated';
import { type Runway, bearingDeg, distanceM } from './airports';

/** One other aircraft: where it is and how it moves (geographic, SI units). */
export interface TrafficTarget {
  id: string;
  callsign: string;
  /** Fleet model to draw (c172, pc12, phenom100, f35, a320, b747). */
  typeId: string;
  /** ICAO type designator as reported (or of the model), for the label. */
  icaoType: string;
  lon: number;
  lat: number;
  /** Altitude m above sea level; NaN = on the ground (placed on the terrain). */
  alt: number;
  /** Track over the ground, degrees; ground speed m/s; vertical speed m/s. */
  heading: number;
  gs: number;
  vs: number;
  onGround: boolean;
}

const FT = 0.3048;
const KT = 0.514444;
const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (lat: number) => 111_320 * Math.cos(lat * DEG);

// ---------------------------------------------------------------------------
// Real traffic (ADS-B, readsb "aircraft" JSON as served by adsb.lol / adsb.fi)
// ---------------------------------------------------------------------------

/** ICAO type designator / ADS-B emitter category -> one of the fleet models (null = skip). */
export function fleetModelFor(t: string | undefined, category: string | undefined): string | null {
  const type = (t ?? '').toUpperCase();
  if (/^(A3[3-5]|A38|B74|B77|B78|B76|MD11|IL96|A30|A31[0-9]?$)/.test(type)) return 'b747';
  if (
    /^(A1[89]|A2[01]|A3[12]|A20N|A21N|B73|B38|B39|B3XM|BCS|E1[79]|E19|E29|E75|CRJ|BA4|RJ|A22)/.test(
      type,
    )
  )
    return 'a320';
  if (/^(F35|F16|F18|FA18|F5|EUFI|RFAL|M200|M346|PC21|TOR|GRIF|JAS|HAWK)/.test(type)) return 'f35';
  if (
    /^(E5[05]|E55P|C5[0-9]|C6[58]|C25|CL3|CL6|GL|GLF|FA[0-9]|F2TH|F900|LJ|PC24|HDJT|PRM1|SF50|BE40|H25)/.test(
      type,
    )
  )
    return 'phenom100';
  if (
    /^(PC12|PC6|PC7|PC9|TBM|C208|B190|BE20|BE9|DHC|AT[47]|DH8|SW4|D228|P180|KODI|P46T|PA46|C441)/.test(
      type,
    )
  )
    return 'pc12';
  if (
    /^(C1[5-9]|C2[0-9]|P28|PA2|PA3|DA[2-6]|SR2|BE3|M20|DR4|ROBN|AQUI|TB[12]|RF|DV20|G1|C42|EV97|WT9|DIMO|ASK|DG|LS|ARCP|PIVI|AT3)/.test(
      type,
    )
  )
    return 'c172';
  switch (category) {
    case 'A1':
      return 'c172';
    case 'A2':
      return 'pc12';
    case 'A3':
      return 'a320';
    case 'A4':
    case 'A5':
      return 'b747';
    case 'A6':
      return 'f35';
    // Helicopters (A7), gliders (B1), balloons, drones: no model.
    default:
      return type ? 'c172' : null;
  }
}

interface ReadsbAircraft {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  category?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  alt_geom?: number;
  gs?: number;
  track?: number;
  true_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
  seen_pos?: number;
}

/** Parses an adsb.lol / adsb.fi response ({ac: [...]} or {aircraft: [...]}). */
export function parseReadsb(json: {
  ac?: ReadsbAircraft[];
  aircraft?: ReadsbAircraft[];
}): TrafficTarget[] {
  const out: TrafficTarget[] = [];
  for (const a of json.ac ?? json.aircraft ?? []) {
    if (a.lat === undefined || a.lon === undefined || (a.seen_pos ?? 0) > 30) continue;
    const model = fleetModelFor(a.t, a.category);
    if (!model) continue;
    const onGround = a.alt_baro === 'ground';
    const altFt =
      typeof a.alt_geom === 'number'
        ? a.alt_geom
        : typeof a.alt_baro === 'number'
          ? a.alt_baro
          : NaN;
    out.push({
      id: a.hex,
      callsign: (a.flight ?? a.r ?? a.hex).trim(),
      typeId: model,
      icaoType: a.t ?? '',
      lon: a.lon,
      lat: a.lat,
      alt: onGround ? NaN : altFt * FT,
      heading: a.track ?? a.true_heading ?? 0,
      gs: (a.gs ?? 0) * KT,
      vs: ((a.geom_rate ?? a.baro_rate ?? 0) * FT) / 60,
      onGround,
    });
  }
  return out;
}

/** Where real traffic comes from: the Vite dev proxy, or a relay set at build time. */
export function liveTrafficUrl(lon: number, lat: number, radiusNm = 60): string | null {
  const base = import.meta.env.DEV
    ? `${import.meta.env.BASE_URL}adsb`
    : (import.meta.env.VITE_TRAFFIC_URL as string | undefined);
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/v2/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${radiusNm}`;
}

// ---------------------------------------------------------------------------
// Simulated traffic
// ---------------------------------------------------------------------------

interface Profile {
  typeId: string;
  icao: string;
  /** Approach / climb speed m/s, rotation speed m/s, climb gradient. */
  vapp: number;
  vr: number;
  climb: number;
}

const PROFILES: Record<string, Profile> = {
  c172: { typeId: 'c172', icao: 'C172', vapp: 33, vr: 28, climb: 0.08 },
  pc12: { typeId: 'pc12', icao: 'PC12', vapp: 50, vr: 42, climb: 0.1 },
  phenom100: { typeId: 'phenom100', icao: 'E50P', vapp: 58, vr: 50, climb: 0.1 },
  a320: { typeId: 'a320', icao: 'A320', vapp: 70, vr: 75, climb: 0.085 },
  b747: { typeId: 'b747', icao: 'B744', vapp: 77, vr: 82, climb: 0.065 },
  f35: { typeId: 'f35', icao: 'F35', vapp: 75, vr: 80, climb: 0.2 },
};

/** Which aircraft use which airport (scheduled traffic at the big ones, light aircraft elsewhere). */
const MIX: Record<string, Array<[string, number]>> = {
  LSZH: [
    ['a320', 0.7],
    ['b747', 0.12],
    ['phenom100', 0.1],
    ['pc12', 0.08],
  ],
  LSGG: [
    ['a320', 0.78],
    ['b747', 0.1],
    ['phenom100', 0.12],
  ],
  LFSB: [
    ['a320', 0.85],
    ['b747', 0.05],
    ['phenom100', 0.1],
  ],
  LSZB: [
    ['phenom100', 0.35],
    ['pc12', 0.35],
    ['a320', 0.15],
    ['c172', 0.15],
  ],
  LSZA: [
    ['phenom100', 0.4],
    ['pc12', 0.3],
    ['a320', 0.3],
  ],
  LSZS: [
    ['phenom100', 0.5],
    ['pc12', 0.4],
    ['c172', 0.1],
  ],
  LSGS: [
    ['phenom100', 0.3],
    ['pc12', 0.3],
    ['c172', 0.25],
    ['f35', 0.15],
  ],
  LSMP: [['f35', 1]],
  LSME: [
    ['f35', 0.8],
    ['pc12', 0.2],
  ],
  LSMM: [['f35', 1]],
};
const AIRLINE_PREFIX: Record<string, string[]> = {
  a320: ['SWR', 'EZS', 'EDW', 'DLH', 'AFR', 'BAW', 'KLM', 'AUA'],
  b747: ['SWR', 'DLH', 'CLX', 'BOX', 'UAE'],
  phenom100: ['HB-', 'HB-', 'D-I', 'OE-'],
  pc12: ['HB-F', 'HB-K', 'D-F'],
  c172: ['HB-C', 'HB-T', 'HB-K'],
  f35: ['SWISS', 'J-5'],
};

/** A path through time: where the aircraft is at age t, and when it is done. */
interface Flight {
  id: string;
  callsign: string;
  profile: Profile;
  age: number;
  done: boolean;
  /** Position at age t (geographic) and its motion. */
  sample(t: number): TrafficTarget;
}

/** Local runway frame: x along the runway from the threshold, y to the left, metres. */
function frame(r: Runway, reverse: boolean) {
  const a = reverse ? r.to : r.from;
  const b = reverse ? r.from : r.to;
  const hdg = bearingDeg(a, b);
  const len = distanceM(a, b);
  const h = hdg * DEG;
  const fx = Math.sin(h);
  const fy = Math.cos(h);
  const kx = mPerDegLon(a.lat);
  return {
    hdg,
    len,
    at(x: number, y: number) {
      // Forward (east, north) = (fx, fy); left = (-fy, fx).
      const e = x * fx - y * fy;
      const n = x * fy + y * fx;
      return { lon: a.lon + e / kx, lat: a.lat + n / M_PER_DEG_LAT };
    },
  };
}

/** Polyline path in the runway frame with an altitude profile and speeds. */
function pathFlight(
  base: Omit<Flight, 'sample' | 'age' | 'done'>,
  f: ReturnType<typeof frame>,
  elev: number,
  pts: Array<{ x: number; y: number; agl: number; v: number; ground?: boolean }>,
): Flight {
  // Distance along the path at each point and the time to get there.
  const dist = [0];
  const time = [0];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    dist.push(dist[i - 1]! + d);
    time.push(time[i - 1]! + d / Math.max(1, (pts[i]!.v + pts[i - 1]!.v) / 2));
  }
  const total = time[time.length - 1]!;
  const at = (t: number) => {
    let i = 1;
    while (i < time.length - 1 && time[i]! < t) i++;
    const t0 = time[i - 1]!;
    const k = Math.min(1, Math.max(0, (t - t0) / Math.max(1e-3, time[i]! - t0)));
    const p = pts[i - 1]!;
    const q = pts[i]!;
    return {
      x: p.x + (q.x - p.x) * k,
      y: p.y + (q.y - p.y) * k,
      agl: p.agl + (q.agl - p.agl) * k,
      v: p.v + (q.v - p.v) * k,
      ground: !!(p.ground && q.ground),
    };
  };
  const flight: Flight = {
    ...base,
    age: 0,
    done: false,
    sample(t: number) {
      if (t >= total) flight.done = true;
      const a = at(t);
      // Heading: towards a point a little ahead (smooth turns at the corners).
      const ahead = at(t + 6);
      const dx = ahead.x - a.x;
      const dy = ahead.y - a.y;
      const local = Math.atan2(-dy, dx) / DEG; // degrees right of the runway heading
      const g = f.at(a.x, a.y);
      const vs = (ahead.agl - a.agl) / 6;
      return {
        id: flight.id,
        callsign: base.callsign,
        typeId: base.profile.typeId,
        icaoType: base.profile.icao,
        lon: g.lon,
        lat: g.lat,
        alt: a.ground ? NaN : elev + a.agl,
        heading: (f.hdg + local + 360) % 360,
        gs: a.v,
        vs,
        onGround: a.ground,
      };
    },
  };
  return flight;
}

let serial = 0;
function callsignFor(typeId: string, rnd: () => number) {
  const p = AIRLINE_PREFIX[typeId] ?? ['HB-'];
  const prefix = p[Math.floor(rnd() * p.length)]!;
  if (prefix.endsWith('-') || prefix.length === 4) {
    const letters = 'ABCDEFGHIKLMNOPRSTUVWXYZ';
    let s = prefix;
    while (s.replace('-', '').length < 5) s += letters[Math.floor(rnd() * letters.length)];
    return s;
  }
  return `${prefix}${Math.floor(10 + rnd() * 980)}`;
}

function pick(mix: Array<[string, number]>, r: number) {
  let acc = 0;
  for (const [id, w] of mix) {
    acc += w;
    if (r < acc) return id;
  }
  return mix[mix.length - 1]![0];
}

/** Landing runway end for the wind: the one facing most into it. */
function intoWind(r: Runway, windFrom: number): boolean {
  const h = bearingDeg(r.from, r.to);
  return Math.cos((h - windFrom) * DEG) < 0;
}

/** Approach on a 3° glide path from ~16 km, landing, rollout to taxi speed. */
function arrival(r: Runway, reverse: boolean, elev: number, p: Profile, rnd: () => number): Flight {
  const f = frame(r, reverse);
  const d0 = 14_000 + rnd() * 6000;
  const glide = Math.tan(3 * DEG);
  const pts = [
    { x: -d0, y: 0, agl: d0 * glide, v: p.vapp * 1.35 },
    { x: -6000, y: 0, agl: 6000 * glide, v: p.vapp * 1.05 },
    { x: -400, y: 0, agl: 400 * glide + 6, v: p.vapp },
    { x: 300, y: 0, agl: 0, v: p.vapp * 0.95, ground: true },
    { x: Math.min(f.len * 0.75, 300 + p.vapp * 22), y: 0, agl: 0, v: 12, ground: true },
    { x: Math.min(f.len * 0.85, 400 + p.vapp * 26), y: 0, agl: 0, v: 8, ground: true },
  ];
  const id = `sim${++serial}`;
  return pathFlight({ id, callsign: callsignFor(p.typeId, rnd), profile: p }, f, elev, pts);
}

/** Takeoff roll, climb out straight ahead to ~2.5 km above the field, on for 25 km. */
function departure(
  r: Runway,
  reverse: boolean,
  elev: number,
  p: Profile,
  rnd: () => number,
): Flight {
  const f = frame(r, reverse);
  const roll = Math.min(f.len * 0.7, (p.vr * p.vr) / (2 * 2.2));
  const climbOut = 2500 / p.climb;
  const pts = [
    { x: 80, y: 0, agl: 0, v: 3, ground: true },
    { x: 80 + roll, y: 0, agl: 0, v: p.vr, ground: true },
    { x: 80 + roll + 600, y: 0, agl: 600 * p.climb, v: p.vr * 1.15 },
    { x: 80 + roll + climbOut, y: 0, agl: 2500, v: p.vr * 2 },
    { x: 80 + roll + climbOut + 25_000, y: (rnd() - 0.5) * 8000, agl: 3300, v: p.vr * 2.6 },
  ];
  const id = `sim${++serial}`;
  return pathFlight({ id, callsign: callsignFor(p.typeId, rnd), profile: p }, f, elev, pts);
}

/** Two left-hand circuits with touch-and-go, then a full stop (training at a small field). */
function circuits(
  r: Runway,
  reverse: boolean,
  elev: number,
  p: Profile,
  rnd: () => number,
): Flight {
  const f = frame(r, reverse);
  const L = f.len;
  const side = rnd() < 0.7 ? 1 : -1; // left-hand mostly
  const w = 900 * side;
  const pts: Array<{ x: number; y: number; agl: number; v: number; ground?: boolean }> = [];
  for (let lap = 0; lap < 2; lap++) {
    pts.push(
      { x: 150, y: 0, agl: 0, v: lap ? p.vapp : 3, ground: true },
      { x: 150 + Math.min(L * 0.6, 350), y: 0, agl: 0, v: p.vr, ground: true },
      { x: L + 900, y: 0, agl: 200, v: p.vapp * 1.15 },
      { x: L + 1300, y: w * 0.5, agl: 280, v: p.vapp * 1.2 },
      { x: L + 900, y: w, agl: 300, v: p.vapp * 1.3 },
      { x: -1300, y: w, agl: 300, v: p.vapp * 1.3 },
      { x: -1800, y: w * 0.5, agl: 220, v: p.vapp * 1.1 },
      { x: -1400, y: 0, agl: 1400 * Math.tan(3.5 * DEG), v: p.vapp },
      { x: 100, y: 0, agl: 0, v: p.vapp * 0.95, ground: true },
    );
  }
  pts.push({ x: Math.min(L * 0.8, 600), y: 0, agl: 0, v: 6, ground: true });
  const id = `sim${++serial}`;
  return pathFlight({ id, callsign: callsignFor(p.typeId, rnd), profile: p }, f, elev, pts);
}

/** Airliner overhead, straight and level at cruise height. */
function overflight(lon: number, lat: number, rnd: () => number): Flight {
  const hdg = rnd() * 360;
  const alt = 6000 + rnd() * 5000;
  const v = 210 + rnd() * 40;
  const typeId = rnd() < 0.8 ? 'a320' : 'b747';
  const p = PROFILES[typeId]!;
  // Starts 60 km before passing within ~15 km of the given point.
  const off = (rnd() - 0.5) * 30_000;
  const h = hdg * DEG;
  const e0 = -Math.sin(h) * 60_000 + Math.cos(h) * off;
  const n0 = -Math.cos(h) * 60_000 - Math.sin(h) * off;
  const id = `sim${++serial}`;
  const callsign = callsignFor(typeId, rnd);
  const flight: Flight = {
    id,
    callsign,
    profile: p,
    age: 0,
    done: false,
    sample(t: number) {
      if (t * v > 120_000) flight.done = true;
      const e = e0 + Math.sin(h) * v * t;
      const n = n0 + Math.cos(h) * v * t;
      return {
        id: flight.id,
        callsign,
        typeId,
        icaoType: p.icao,
        lon: lon + e / mPerDegLon(lat),
        lat: lat + n / M_PER_DEG_LAT,
        alt,
        heading: hdg,
        gs: v,
        vs: 0,
        onGround: false,
      };
    },
  };
  return flight;
}

/**
 * Simulated traffic around the player: arrivals and departures (landing into the wind) at the
 * airports within reach, training circuits at small fields, airliners overhead.
 */
export class SimTraffic {
  private readonly flights: Flight[] = [];
  private readonly timers = new Map<string, number>();
  private seed = 12345;
  private started = 0;
  private readonly rnd = () => {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  };

  constructor(
    /** Field elevation (m) or undefined while the terrain there is unknown. */
    private readonly elevation: (lon: number, lat: number) => number | undefined,
  ) {}

  /** Advances all flights; returns their current targets. */
  update(dt: number, lon: number, lat: number, windFrom: number): TrafficTarget[] {
    for (const f of this.flights) f.age += dt;
    this.spawn(dt, lon, lat, windFrom);
    const out: TrafficTarget[] = [];
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i]!;
      const t = f.sample(f.age);
      if (f.done) this.flights.splice(i, 1);
      else out.push(t);
    }
    return out;
  }

  private spawn(dt: number, lon: number, lat: number, windFrom: number) {
    const near = (rw: Runway) => distanceM(rw.from, { lon, lat });
    // One runway per airport (the longest), airports within 45 km.
    const byAirport = new Map<string, (typeof ALL_RUNWAYS)[number]>();
    for (const r of ALL_RUNWAYS) {
      if (near(r) > 45_000) continue;
      const cur = byAirport.get(r.icao);
      if (!cur || r.lengthM > cur.lengthM) byAirport.set(r.icao, r);
    }
    for (const [icao, r] of byAirport) {
      // First visit of an airport: traffic is already under way (flights started a while ago).
      const first = !this.timers.has(icao);
      const t = (this.timers.get(icao) ?? 0) - dt;
      if (t > 0) {
        this.timers.set(icao, t);
        continue;
      }
      const elev = this.elevation((r.from.lon + r.to.lon) / 2, (r.from.lat + r.to.lat) / 2);
      if (elev === undefined) {
        this.timers.set(icao, 5);
        continue;
      }
      const mix = MIX[icao];
      const reverse = !intoWind(r, windFrom);
      const busy = this.flights.filter((f) => f.id.startsWith(icao)).length;
      if (mix && r.lengthM > 1200) {
        // Scheduled airport: an arrival or a departure every ~1-2 minutes.
        const p = PROFILES[pick(mix, this.rnd())]!;
        for (let n = first ? 2 : 1; n > 0 && busy < 4; n--) {
          const make = this.rnd() < 0.5 ? arrival : departure;
          const fl = make(r, reverse, elev, PROFILES[pick(mix, this.rnd())] ?? p, this.rnd);
          fl.id = `${icao}-${fl.id}`;
          if (first) fl.age = this.rnd() * 140;
          this.flights.push(fl);
        }
        this.timers.set(icao, 60 + this.rnd() * 70);
      } else {
        // Small field: someone flying circuits now and then.
        if (busy < 1 && this.rnd() < 0.6) {
          const p = PROFILES[this.rnd() < 0.75 ? 'c172' : 'pc12']!;
          const fl = circuits(r, reverse, elev, p, this.rnd);
          fl.id = `${icao}-${fl.id}`;
          if (first) fl.age = this.rnd() * 300;
          this.flights.push(fl);
        }
        this.timers.set(icao, 90 + this.rnd() * 120);
      }
    }
    // Two or three airliners overhead.
    const over = this.flights.filter((f) => f.id.startsWith('over')).length;
    if (over < 3 && (this.started === 0 || this.rnd() < dt / 20)) {
      const fl = overflight(lon, lat, this.rnd);
      fl.id = `over-${fl.id}`;
      if (this.started === 0) fl.age = 120 + this.rnd() * 200;
      this.flights.push(fl);
    }
    this.started += dt;
  }
}
