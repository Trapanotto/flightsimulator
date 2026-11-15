/**
 * Where the aircraft is relative to a runway: off the centre line, past the threshold, above
 * or below the approach path. Flat-earth arithmetic around the threshold: within the few
 * kilometres a lesson looks at a runway from, it is centimetres off, and it allocates nothing
 * per frame.
 */
import { bearingDeg, findAirport, findRunwayEnd, ilsFor, thresholdOf } from '@geo';

const EARTH_R = 6_371_000;
const RAD = Math.PI / 180;
const FT = 3.28084;
/** Threshold crossing height of an approach path, m (the app's approach start uses it too). */
const CROSSING_HEIGHT = 15;

export interface RunwayPosition {
  centrelineM: number;
  alongM: number;
  pathFt: number;
  runwayHeightFt: number;
}

export class RunwayGeometry {
  readonly lon: number;
  readonly lat: number;
  /** Metres above sea level at the threshold. */
  readonly elevation: number;
  /** True course of the runway, degrees. */
  readonly course: number;
  readonly pathAngleDeg: number;
  readonly length: number;
  readonly width: number;
  private readonly sinC: number;
  private readonly cosC: number;
  private readonly mPerLon: number;
  private readonly tanPath: number;

  private constructor(
    t: { lon: number; lat: number },
    elevation: number,
    course: number,
    pathAngleDeg: number,
    length: number,
    width: number,
  ) {
    this.lon = t.lon;
    this.lat = t.lat;
    this.elevation = elevation;
    this.course = course;
    this.pathAngleDeg = pathAngleDeg;
    this.length = length;
    this.width = width;
    this.sinC = Math.sin(course * RAD);
    this.cosC = Math.cos(course * RAD);
    this.mPerLon = EARTH_R * RAD * Math.cos(t.lat * RAD);
    this.tanPath = Math.tan(pathAngleDeg * RAD);
  }

  /** The landing end `ident` of an airport (ICAO), or undefined if either is unknown. */
  static of(icao: string, ident: string): RunwayGeometry | undefined {
    const airport = findAirport(icao);
    const found = airport && findRunwayEnd(airport, ident);
    if (!airport || !found) return undefined;
    const { runway, end, opposite } = found;
    const angle = ilsFor(airport.icao, ident)?.glideSlope?.angleDeg ?? 3;
    return new RunwayGeometry(
      thresholdOf(end, opposite),
      end.elevation ?? airport.elevation,
      bearingDeg(end, opposite),
      angle,
      runway.length - (end.displaced ?? 0),
      runway.width,
    );
  }

  /** Fills `out` for a position (`msl` metres above sea level) and returns it. */
  measure(lon: number, lat: number, msl: number, out: RunwayPosition): RunwayPosition {
    const east = (lon - this.lon) * this.mPerLon;
    const north = (lat - this.lat) * EARTH_R * RAD;
    const along = east * this.sinC + north * this.cosC;
    out.alongM = along;
    out.centrelineM = east * this.cosC - north * this.sinC;
    const height = msl - this.elevation;
    out.runwayHeightFt = height * FT;
    out.pathFt = (height - (CROSSING_HEIGHT + Math.max(0, -along) * this.tanPath)) * FT;
    return out;
  }
}
