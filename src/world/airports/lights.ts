/**
 * All ground lights of an airport as flat arrays for one instanced draw: runway lights from
 * the layout (layout.ts), blue taxiway edge lights along the taxiways, the aerodrome beacon.
 * Pure function of the data: heights come later from the terrain, like the surfaces.
 */
import { type AirportInfo, LocalFrame, isPaved } from '@geo';
import type { AirportDetail } from './detail';
import { type RunwayAxes, runwayAxes, runwayPoint } from './geometry';
import { LIGHT_COLOURS, type Light, LightKind, runwayLights } from './layout';

export interface LightOptionsAll {
  centreSpacing: number;
  touchdownZone: boolean;
  /** Metres between taxiway edge lights; 0 = none. */
  taxiSpacing: number;
}

export interface LightBuffers {
  count: number;
  lon: Float64Array;
  lat: Float64Array;
  /** Metres above the ground. */
  height: Float32Array;
  /** Colour times intensity (candela) seen from ahead of the axis, and from behind. */
  colourA: Float32Array;
  colourB: Float32Array;
  /** Axis (x, z in the airport frame), kind, parameter. */
  params: Float32Array;
  /** Physical radius of the light, metres (how big it looks up close). */
  size: Float32Array;
}

/** Physical radius by kind of light. */
const SIZE: Record<number, number> = {
  [LightKind.Omni]: 0.12,
  [LightKind.Bidirectional]: 0.22,
  [LightKind.Unidirectional]: 0.25,
  [LightKind.Papi]: 0.45,
  [LightKind.Flasher]: 0.35,
  [LightKind.Beacon]: 0.6,
};

class Collector {
  readonly lon: number[] = [];
  readonly lat: number[] = [];
  readonly height: number[] = [];
  readonly colourA: number[] = [];
  readonly colourB: number[] = [];
  readonly params: number[] = [];
  readonly size: number[] = [];
  private readonly p = { x: 0, y: 0, z: 0 };

  constructor(private readonly frame: LocalFrame) {}

  add(x: number, z: number, l: Light, axisX: number, axisZ: number) {
    this.p.x = x;
    this.p.y = 0;
    this.p.z = z;
    const g = this.frame.toGeodetic(this.p);
    this.lon.push(g.lon);
    this.lat.push(g.lat);
    this.height.push(l.height);
    const a = LIGHT_COLOURS[l.colourA];
    const b = LIGHT_COLOURS[l.colourB];
    this.colourA.push(a[0] * l.intensity, a[1] * l.intensity, a[2] * l.intensity);
    this.colourB.push(b[0] * l.intensity, b[1] * l.intensity, b[2] * l.intensity);
    this.params.push(axisX, axisZ, l.kind, l.param);
    this.size.push(SIZE[l.kind] ?? 0.2);
  }

  finish(): LightBuffers {
    return {
      count: this.lon.length,
      lon: Float64Array.from(this.lon),
      lat: Float64Array.from(this.lat),
      height: Float32Array.from(this.height),
      colourA: Float32Array.from(this.colourA),
      colourB: Float32Array.from(this.colourB),
      params: Float32Array.from(this.params),
      size: Float32Array.from(this.size),
    };
  }
}

/** Every light of the airport. */
export function buildLights(
  frame: LocalFrame,
  airport: AirportInfo,
  detail: AirportDetail | undefined,
  opt: LightOptionsAll,
): LightBuffers {
  const c = new Collector(frame);
  const axesAll: RunwayAxes[] = [];
  for (const r of airport.runways) {
    const axes = runwayAxes(frame, r);
    if (isPaved(r.surface)) axesAll.push(axes);
    for (const l of runwayLights(r, opt, axes.length)) {
      const [x, z] = runwayPoint(axes, l.s, l.t);
      c.add(x, z, l, axes.dx * l.axis, axes.dz * l.axis);
    }
  }
  const lit = airport.runways.some((r) => r.lighted);
  if (lit && detail && opt.taxiSpacing > 0)
    taxiwayLights(c, frame, detail, axesAll, airport, opt.taxiSpacing);
  if (lit) {
    // The aerodrome beacon: on the tower if the map has one, else over the reference point.
    const at = detail?.towers[0];
    const p = frame.fromGeodetic(at?.[0] ?? airport.lon, at?.[1] ?? airport.lat, frame.origin.h, {
      x: 0,
      y: 0,
      z: 0,
    });
    c.add(
      p.x,
      p.z,
      {
        s: 0,
        t: 0,
        height: at ? 22 : 12,
        colourA: 'white',
        colourB: 'green',
        intensity: 100000,
        kind: LightKind.Beacon,
        axis: 1,
        param: 0,
      },
      1,
      0,
    );
  }
  return c.finish();
}

/**
 * Blue edge lights on both sides of every taxiway, left out where they would stand on other
 * pavement: inside a runway (and its strip), on another taxiway, or on an apron.
 */
function taxiwayLights(
  c: Collector,
  frame: LocalFrame,
  detail: AirportDetail,
  runways: RunwayAxes[],
  airport: AirportInfo,
  spacing: number,
) {
  const p = { x: 0, y: 0, z: 0 };
  const local = (lon: number, lat: number): [number, number] => {
    frame.fromGeodetic(lon, lat, frame.origin.h, p);
    return [p.x, p.z];
  };
  const lines = detail.taxiways.map((t) => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < t.line.length; i += 2) pts.push(local(t.line[i]!, t.line[i + 1]!));
    return { pts, half: t.width / 2 };
  });
  const aprons = detail.aprons.map((ring) => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < ring.length; i += 2) pts.push(local(ring[i]!, ring[i + 1]!));
    return pts;
  });
  const widths = airport.runways.filter((r) => isPaved(r.surface)).map((r) => r.width);

  // Segment index on a 50 m grid: "is this point on some other taxiway" stays cheap.
  const CELL = 50;
  const grid = new Map<string, Array<[number, number, number, number, number, number]>>();
  lines.forEach(({ pts, half }, li) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i]!;
      const [bx, bz] = pts[i + 1]!;
      const pad = half + 2;
      for (
        let gx = Math.floor((Math.min(ax, bx) - pad) / CELL);
        gx <= Math.floor((Math.max(ax, bx) + pad) / CELL);
        gx++
      )
        for (
          let gz = Math.floor((Math.min(az, bz) - pad) / CELL);
          gz <= Math.floor((Math.max(az, bz) + pad) / CELL);
          gz++
        ) {
          const key = `${gx},${gz}`;
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push([ax, az, bx, bz, half, li]);
        }
    }
  });
  const onOtherPavement = (x: number, z: number, own: number) => {
    for (const s of grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []) {
      if (s[5] === own) continue;
      const ex = s[2] - s[0];
      const ez = s[3] - s[1];
      const l2 = ex * ex + ez * ez;
      const f = Math.max(0, Math.min(1, ((x - s[0]) * ex + (z - s[1]) * ez) / l2));
      if (Math.hypot(s[0] + ex * f - x, s[1] + ez * f - z) < s[4] - 0.3) return true;
    }
    for (let i = 0; i < runways.length; i++) {
      const r = runways[i]!;
      const sx = (x - r.ax) * r.dx + (z - r.az) * r.dz;
      const tx = (x - r.ax) * r.rx + (z - r.az) * r.rz;
      if (sx > -60 && sx < r.length + 60 && Math.abs(tx) < widths[i]! / 2 + 10) return true;
    }
    for (const ring of aprons) if (insideRing(x, z, ring)) return true;
    return false;
  };

  const light: Light = {
    s: 0,
    t: 0,
    height: 0.3,
    colourA: 'blue',
    colourB: 'blue',
    intensity: 50,
    kind: LightKind.Omni,
    axis: 1,
    param: 0,
  };
  lines.forEach(({ pts, half }, li) => {
    let carry = spacing / 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i]!;
      const [bx, bz] = pts[i + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const nx = -(bz - az) / len;
      const nz = (bx - ax) / len;
      let d = carry;
      for (; d <= len; d += spacing) {
        const cx = ax + ((bx - ax) * d) / len;
        const cz = az + ((bz - az) * d) / len;
        for (const side of [-1, 1]) {
          const x = cx + nx * side * (half + 0.6);
          const z = cz + nz * side * (half + 0.6);
          if (!onOtherPavement(x, z, li)) c.add(x, z, light, 1, 0);
        }
      }
      carry = d - len;
    }
  });
}

function insideRing(x: number, z: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!;
    const [xj, zj] = ring[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
