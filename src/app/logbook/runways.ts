import { airportsNear, bearingDeg, thresholdOf } from '@geo';

/** Where on a runway a point lies, seen in the direction of travel. */
export interface RunwayHit {
  airport: string;
  /** Designator of the end the aircraft is moving away from (the landing direction). */
  runway: string;
  /** Metres right (+) or left (-) of the centre line. */
  centreline: number;
  /** Metres past the landing threshold (negative before a displaced threshold). */
  pastThreshold: number;
}

/** What the logger asks about places; injected so tests can use a fake. */
export interface RunwayFinder {
  /** The runway the point is on, given the direction of travel (degrees true). */
  runwayAt(lon: number, lat: number, headingDeg: number): RunwayHit | undefined;
  /** The ICAO of the aerodrome the point is at (on or off a runway). */
  airportAt(lon: number, lat: number): string | undefined;
}

const RAD = Math.PI / 180;
// The same sphere as the geo package's distanceM/offsetPoint, so positions built with those
// come back to within centimetres.
const EARTH_R = 6_371_000;
/** Longest runway plus margin: airports farther away cannot contain the point. */
const SEARCH_RADIUS = 6000;
/** A touchdown on the grass beside the pavement still counts as on that runway. */
const MIN_HALF_WIDTH = 40;
/** How far from the reference point a place still belongs to an aerodrome. */
const AIRPORT_RADIUS = 2500;

/** Runways of the geo package's airport data. */
export class GeoRunwayFinder implements RunwayFinder {
  runwayAt(lon: number, lat: number, headingDeg: number): RunwayHit | undefined {
    let best: RunwayHit | undefined;
    let bestCross = Infinity;
    for (const { airport } of airportsNear(lon, lat, SEARCH_RADIUS)) {
      for (const runway of airport.runways) {
        const [a, b] = runway.ends;
        // Equirectangular metres around end a: exact enough over a few kilometres.
        const k = Math.cos(a.lat * RAD) * EARTH_R * RAD;
        const bx = (b.lon - a.lon) * k;
        const by = (b.lat - a.lat) * EARTH_R * RAD;
        const len = Math.hypot(bx, by);
        if (len < 1) continue;
        const ux = bx / len;
        const uy = by / len;
        const px = (lon - a.lon) * k;
        const py = (lat - a.lat) * EARTH_R * RAD;
        const along = px * ux + py * uy;
        const cross = px * uy - py * ux;
        const halfWidth = Math.max(0.75 * runway.width, MIN_HALF_WIDTH);
        if (along < 0 || along > len || Math.abs(cross) > halfWidth) continue;
        if (Math.abs(cross) >= bestCross) continue;
        // Moving from a towards b means landing on a's designator.
        const towardsB = angleDiff(headingDeg, bearingDeg(a, b)) <= 90;
        const end = towardsB ? a : b;
        const opposite = towardsB ? b : a;
        const t = thresholdOf(end, opposite);
        const tx = (t.lon - a.lon) * k;
        const ty = (t.lat - a.lat) * EARTH_R * RAD;
        const sign = towardsB ? 1 : -1;
        bestCross = Math.abs(cross);
        best = {
          airport: airport.icao,
          runway: end.ident,
          // Right of the direction of travel: the cross product flips with the direction.
          centreline: sign * cross,
          pastThreshold: sign * ((px - tx) * ux + (py - ty) * uy),
        };
      }
    }
    return best;
  }

  airportAt(lon: number, lat: number): string | undefined {
    return airportsNear(lon, lat, AIRPORT_RADIUS)[0]?.airport.icao;
  }
}

function angleDiff(a: number, b: number): number {
  const d = (((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}
