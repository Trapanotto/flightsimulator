/**
 * A simple panel GPS that follows the flight plan: great-circle legs, cross-track error,
 * automatic sequencing with turn anticipation, and direct-to.
 */
import type { AvionicsInput, GpsTelemetry, Waypoint } from '../avionicsTypes';
import {
  DEG,
  EARTH_RADIUS,
  KT,
  NM,
  centralAngle,
  destination,
  initialCourse,
  rangeBearing,
  wrap180,
  wrap360,
  type RangeBearing,
} from './geo';

/**
 * CDI full scale, NM, by the distance to the last waypoint: en route, terminal (within 30
 * NM) and approach (within 2 NM), the TSO-C129 sensitivities of 5, 1 and 0.3 NM.
 */
export const GPS_FULL_SCALE = {
  enRoute: 5,
  terminal: 1,
  approach: 0.3,
  terminalNm: 30,
  approachNm: 2,
};
/** Turn anticipation plans a standard rate turn, 3 degrees per second. */
const STANDARD_RATE = 3 * DEG;
/** The largest turn anticipated; beyond it the lead distance would run away. */
const MAX_ANTICIPATED_TURN = 150;

export class Gps {
  readonly telemetry: GpsTelemetry = {
    plan: [],
    active: -1,
    distanceNm: undefined,
    bearing: undefined,
    desiredTrack: undefined,
    crossTrackNm: undefined,
    groundSpeedKt: 0,
    track: 0,
    lon: 0,
    lat: 0,
  };
  /** A leg is being flown and the values below mean something. */
  valid = false;
  /** Cross-track error, m, positive right of the course. */
  crossTrack = 0;
  /** Desired track, degrees magnetic. */
  desiredTrack = 0;
  /** Bearing to the active waypoint, degrees magnetic. */
  bearing = 0;
  /** The active waypoint is behind (only past the last one, which does not sequence). */
  from = false;
  /** Distance to the last waypoint, m. */
  toLast = 0;
  ident = '';

  private plan: Waypoint[] = [];
  private active = -1;
  /** Start of a direct-to leg; NaN until the next step knows the position. */
  private originLat = NaN;
  private originLon = NaN;
  private direct = false;
  private lat = NaN;
  private lon = NaN;
  private readonly rb: RangeBearing = { distance: 0, bearing: 0 };
  private readonly point = { lat: 0, lon: 0 };

  setPlan(plan: readonly Waypoint[]) {
    this.plan = plan.map((w) => ({ ...w }));
    this.telemetry.plan = this.plan;
    this.direct = this.plan.length === 1;
    this.active = this.plan.length === 0 ? -1 : this.plan.length === 1 ? 0 : 1;
    this.originLat = this.lat;
    this.originLon = this.lon;
  }

  directTo(index: number) {
    if (index < 0 || index >= this.plan.length) return;
    this.active = index;
    this.direct = true;
    this.originLat = this.lat;
    this.originLon = this.lon;
  }

  /** Back to the start of the plan, as after switching on. */
  reset() {
    this.setPlan(this.plan);
  }

  update(input: AvionicsInput) {
    const t = this.telemetry;
    this.lat = input.lat;
    this.lon = input.lon;
    t.lat = input.lat;
    t.lon = input.lon;
    t.groundSpeedKt = input.groundSpeed / KT;
    t.track = wrap360(input.track - input.declination);
    t.active = this.active;
    this.valid = false;
    if (!input.powered || this.active < 0) {
      this.clear();
      return;
    }
    if ((this.direct || this.active === 0) && Number.isNaN(this.originLat)) {
      this.originLat = input.lat;
      this.originLon = input.lon;
    }
    this.leg(input);
    // Sequencing may move on by a leg; a second look at the new leg keeps the display in
    // step with it.
    if (this.sequence(input)) this.leg(input);
    t.active = this.active;
    t.distanceNm = this.distanceTo / NM;
    t.bearing = this.bearing;
    t.desiredTrack = this.desiredTrack;
    t.crossTrackNm = this.crossTrack / NM;
    this.valid = true;
  }

  /** CDI full scale for the present position, NM. */
  fullScaleNm(): number {
    const nm = this.toLast / NM;
    if (nm <= GPS_FULL_SCALE.approachNm) return GPS_FULL_SCALE.approach;
    if (nm <= GPS_FULL_SCALE.terminalNm) return GPS_FULL_SCALE.terminal;
    return GPS_FULL_SCALE.enRoute;
  }

  private distanceTo = 0;
  /** Along-track distance still to go to the active waypoint, m. */
  private remaining = 0;
  /** Final true course of the leg into the active waypoint, degrees. */
  private inbound = 0;

  private leg(input: AvionicsInput) {
    const to = this.plan[this.active]!;
    const fromDirect = this.direct || this.active === 0;
    const aLat = fromDirect ? this.originLat : this.plan[this.active - 1]!.lat;
    const aLon = fromDirect ? this.originLon : this.plan[this.active - 1]!.lon;
    rangeBearing(input.lat, input.lon, to.lat, to.lon, this.rb);
    this.distanceTo = this.rb.distance;
    this.bearing = wrap360(this.rb.bearing - input.declination);
    this.ident = to.ident;
    const last = this.plan[this.plan.length - 1]!;
    this.toLast =
      this.active === this.plan.length - 1
        ? this.rb.distance
        : centralAngle(input.lat * DEG, input.lon * DEG, last.lat * DEG, last.lon * DEG) *
          EARTH_RADIUS;

    const la = aLat * DEG;
    const oa = aLon * DEG;
    const lb = to.lat * DEG;
    const ob = to.lon * DEG;
    const lp = input.lat * DEG;
    const op = input.lon * DEG;
    const legAngle = centralAngle(la, oa, lb, ob);
    if (legAngle * EARTH_RADIUS < 1) {
      // A leg of no length (direct-to from on top of the waypoint): fly the bearing.
      this.crossTrack = 0;
      this.desiredTrack = this.bearing;
      this.remaining = this.rb.distance;
      this.inbound = this.rb.bearing;
      this.from = false;
      return;
    }
    const course = initialCourse(la, oa, lb, ob);
    const d13 = centralAngle(la, oa, lp, op);
    const c13 = initialCourse(la, oa, lp, op);
    const xt = Math.asin(Math.sin(d13) * Math.sin(c13 - course));
    // Signed along-track angle: cos(d13) = cos(xt) cos(at) and sin(d13) cos(dc) = cos(xt) sin(at).
    const at = Math.atan2(Math.sin(d13) * Math.cos(c13 - course), Math.cos(d13));
    this.crossTrack = xt * EARTH_RADIUS;
    this.remaining = (legAngle - at) * EARTH_RADIUS;
    this.inbound = wrap360(initialCourse(lb, ob, la, oa) / DEG + 180);
    let dtk = course / DEG;
    if (at * EARTH_RADIUS > 1000) {
      // On a long leg the great circle's course changes; take it abeam the aircraft.
      destination(aLat, aLon, course / DEG, at * EARTH_RADIUS, this.point);
      dtk = initialCourse(this.point.lat * DEG, this.point.lon * DEG, la, oa) / DEG + 180;
    }
    this.desiredTrack = wrap360(dtk - input.declination);
    this.from = this.remaining < 0;
  }

  private sequence(input: AvionicsInput): boolean {
    if (this.active >= this.plan.length - 1) return false;
    const to = this.plan[this.active]!;
    const next = this.plan[this.active + 1]!;
    const outbound = initialCourse(to.lat * DEG, to.lon * DEG, next.lat * DEG, next.lon * DEG);
    const turn = Math.min(Math.abs(wrap180(outbound / DEG - this.inbound)), MAX_ANTICIPATED_TURN);
    const v = Math.max(input.groundSpeed, 30);
    const lead = (v / STANDARD_RATE) * Math.tan((turn * DEG) / 2);
    if (this.remaining > lead) return false;
    this.active++;
    this.direct = false;
    return true;
  }

  private clear() {
    const t = this.telemetry;
    t.distanceNm = undefined;
    t.bearing = undefined;
    t.desiredTrack = undefined;
    t.crossTrackNm = undefined;
    this.from = false;
    this.ident = '';
  }
}
