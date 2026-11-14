/**
 * The ground detail of one airport (taxiways, aprons, windsocks, holding positions, tower),
 * written by tools/airports/build.mjs to public/assets/world/airports/<ICAO>.json from
 * OpenStreetMap. Coordinates there are integer offsets from an origin in 1e-7 degrees (1 cm),
 * which keeps the files small; here they become plain lon/lat again.
 */

export interface AirportDetail {
  taxiways: Array<{ width: number; line: Float64Array }>;
  /** Outer rings, lon/lat pairs, not closed. */
  aprons: Float64Array[];
  windsocks: Array<[number, number]>;
  holds: Array<[number, number]>;
  towers: Array<[number, number]>;
}

interface DetailFile {
  v: number;
  icao: string;
  origin: [number, number];
  scale: number;
  taxiways: Array<{ w: number; c: number[] }>;
  aprons: Array<{ c: number[] }>;
  windsocks: number[][];
  holds: number[][];
  towers: number[][];
}

export function detailUrl(icao: string): string {
  return `${import.meta.env.BASE_URL}assets/world/airports/${icao}.json`;
}

export function decodeDetail(json: unknown): AirportDetail {
  const f = json as DetailFile;
  if (f.v !== 1) throw new Error(`airport detail: unknown version ${f.v}`);
  const [lon0, lat0] = f.origin;
  const k = f.scale;
  const line = (c: number[]) => {
    const out = new Float64Array(c.length);
    for (let i = 0; i < c.length; i += 2) {
      out[i] = lon0 + c[i]! * k;
      out[i + 1] = lat0 + c[i + 1]! * k;
    }
    return out;
  };
  const point = (c: number[]): [number, number] => [lon0 + c[0]! * k, lat0 + c[1]! * k];
  return {
    taxiways: f.taxiways.map((t) => ({ width: t.w, line: line(t.c) })),
    aprons: f.aprons.map((a) => line(a.c)),
    windsocks: f.windsocks.map(point),
    holds: f.holds.map(point),
    towers: f.towers.map(point),
  };
}
