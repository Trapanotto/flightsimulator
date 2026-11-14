/**
 * One VHF NAV receiver: VOR, localizer and glide slope, the DME paired with the tuned
 * station, and the marker positions of a tuned ILS. Station lookups run only when the
 * frequency changes or once a second; between them the step does a few trig calls.
 */
import type {
  AvionicsInput,
  NavDatabase,
  NavReceiverTelemetry,
  NavStation,
} from '../avionicsTypes';
import {
  DEG,
  FT,
  NM,
  type RangeBearing,
  radioHorizonNm,
  rangeBearing,
  wrap180,
  wrap360,
} from './geo';

/** A VOR indicator deflects fully 10 degrees off the selected radial (5 dots of 2 degrees). */
export const VOR_FULL_SCALE_DEG = 10;
/** Localizer full scale when the station does not say where the threshold is. */
export const LOC_DEFAULT_FULL_SCALE_DEG = 2.5;
/**
 * Half the course width at the threshold, m. ICAO Annex 10 Vol I 3.1.3.7.1 sets the
 * displacement sensitivity to 0.00145 DDM/m at the ILS reference datum; full scale on the
 * indicator is 0.155 DDM (150 microamps), which is 107 m: the familiar 700 ft wide course.
 */
export const LOC_HALF_WIDTH_AT_THRESHOLD = (700 / 2) * FT;
/**
 * Localizer courses are tailored to between 3 and 6 degrees wide (FAA practice; ICAO Annex
 * 10 3.1.3.7.1 caps the half sector at 3 degrees), so full scale lies within these.
 */
export const LOC_FULL_SCALE_MIN_DEG = 1.5;
export const LOC_FULL_SCALE_MAX_DEG = 3;
/**
 * Glide slope full scale as a share of the path angle. ICAO Annex 10 Vol I 3.1.5.6.2:
 * 0.0875 DDM at 0.12 theta; the indicator's full scale is 0.175 DDM, so 0.24 theta (0.72
 * degrees on a 3 degree path).
 */
export const GS_FULL_SCALE_PER_ANGLE = 0.24;
/** ILS reference datum height over the threshold, m (ICAO Annex 10 Vol I 3.1.5.1.4: 15 m). */
export const ILS_REFERENCE_DATUM_HEIGHT = 15;
/**
 * Localizer coverage, ICAO Annex 10 Vol I 3.1.3.3.1: 25 NM within 10 degrees of the course,
 * 17 NM out to 35 degrees.
 */
const LOC_COVERAGE = { innerDeg: 10, innerNm: 25, outerDeg: 35, outerNm: 17 };
/** Glide slope coverage, ICAO Annex 10 Vol I 3.1.5.3.1: 8 degrees either side, 10 NM. */
const GS_COVERAGE = { azimuthDeg: 8, rangeNm: 10 };
/**
 * Half-angle of the VOR's cone of confusion from the vertical: overhead the station the
 * radials crowd together and the TO/FROM flag drops out.
 */
const VOR_CONE_DEG = 40;
/** Around abeam the TO/FROM sense is ambiguous and the flag shows OFF. */
const TO_FROM_AMBIGUITY_DEG = 2;
/** Marker distances from the threshold, m: ICAO Annex 10 3.1.7.6 puts the outer at about 3.9 NM (6.5 to 11.1 km), the middle at 1050 +- 150 m and the inner 75 to 450 m from it. */
export const MARKER_DISTANCES = { outer: 4 * NM, middle: 0.5 * NM, inner: 300 };
/**
 * Length of the course each marker lights at the glide path height, m. ICAO Annex 10 Vol I
 * 3.1.7.3.2: outer 600 +- 200 m, middle 300 +- 100 m, inner 150 +- 50 m.
 */
export const MARKER_COVERAGE = { outer: 600, middle: 300, inner: 150 };
/** Antenna height above its surroundings, ft, for the radio horizon. */
const AIRCRAFT_ANTENNA_FT = 6;
const STATION_ANTENNA_FT = 20;
/** Station lookups at most this often, s, besides on a frequency change. */
const LOOKUP_INTERVAL = 1;

const isNavType = (s: NavStation) => s.type !== 'NDB';

/**
 * Line-of-sight range between the aircraft and a station, NM. Heights count from the lower
 * of the two so that a station on a ridge reaches a valley but not through the mountain the
 * aircraft hides behind; terrain itself is not known here.
 */
export function lineOfSightNm(aircraftAltitude: number, stationElevation: number): number {
  const base = Math.min(aircraftAltitude, stationElevation);
  return radioHorizonNm(
    (aircraftAltitude - base) / FT + AIRCRAFT_ANTENNA_FT,
    (stationElevation - base) / FT + STATION_ANTENNA_FT,
  );
}

/** Reception range of a station from an aircraft at an altitude, NM. */
export function receptionRangeNm(s: NavStation, altitude: number): number {
  return Math.min(s.rangeNm, lineOfSightNm(altitude, s.elevation));
}

/**
 * Localizer full scale of a station, degrees: from the 700 ft course width at the threshold
 * when the glide slope antenna says where that is, otherwise the usual 2.5 degrees.
 */
export function localizerFullScale(s: NavStation): number {
  const d = thresholdDistance(s);
  if (d === undefined) return LOC_DEFAULT_FULL_SCALE_DEG;
  const fs = Math.atan(LOC_HALF_WIDTH_AT_THRESHOLD / d) / DEG;
  return Math.min(Math.max(fs, LOC_FULL_SCALE_MIN_DEG), LOC_FULL_SCALE_MAX_DEG);
}

const scratch: RangeBearing = { distance: 0, bearing: 0 };

/**
 * Distance from the localizer antenna back to the threshold, m: the glide slope antenna's
 * place along the course plus the run the path needs to sink from the reference datum.
 */
export function thresholdDistance(s: NavStation): number | undefined {
  const gs = s.glideSlope;
  if (!gs || s.course === undefined || gs.angleDeg <= 0) return undefined;
  rangeBearing(s.lat, s.lon, gs.lat, gs.lon, scratch);
  const along = scratch.distance * Math.cos(wrap180(scratch.bearing - s.course - 180) * DEG);
  return along + ILS_REFERENCE_DATUM_HEIGHT / Math.tan(gs.angleDeg * DEG);
}

export interface MarkerLights {
  outer: boolean;
  middle: boolean;
  inner: boolean;
}

export class NavReceiver {
  readonly telemetry: NavReceiverTelemetry & { standby: number } = {
    frequency: 0,
    standby: 0,
    valid: false,
    ident: '',
    localizer: false,
    course: 0,
    deviation: 0,
    toFrom: 'off',
    bearing: undefined,
    glideSlope: undefined,
  };

  /** The station tuned, received or not. */
  station: NavStation | undefined;
  /** The course signal is received (VOR or localizer). */
  courseValid = false;
  /** Signed deviation, degrees; positive: the course lies to the right. */
  deviationDeg = 0;
  /** The same as a distance, m: how far right the course lies. */
  offset = 0;
  /** Horizontal distance to the station, m. */
  distance = 0;
  /** Course the receiver guides along, degrees magnetic (OBS or localizer front course). */
  guidedCourse = 0;
  /** Overhead a VOR: the deviation means nothing. */
  inCone = false;
  /** On the localizer's front course (not behind the antenna). */
  frontCourse = false;
  gsValid = false;
  /** Height above the glide path, m; positive: above. */
  gsHeightError = 0;
  gsNeedle = 0;
  gsAngle = 3;
  /** DME */
  dmeValid = false;
  dmeDistance = 0;
  /** Rate of closure, m/s, positive towards the station. */
  dmeClosure = 0;

  private frequency = -1;
  private lookupTimer = 0;
  private locFullScale = LOC_DEFAULT_FULL_SCALE_DEG;
  private threshold: number | undefined;
  /** Along the approach from the threshold (m, positive before it) and across it. */
  private alongThreshold = 0;
  private across = 0;
  private readonly rb: RangeBearing = { distance: 0, bearing: 0 };
  private readonly rbGs: RangeBearing = { distance: 0, bearing: 0 };

  reset() {
    this.frequency = -1;
    this.station = undefined;
    this.lookupTimer = 0;
    this.clear();
  }

  update(
    dt: number,
    input: AvionicsInput,
    db: NavDatabase | undefined,
    frequency: number,
    standby: number,
    obs: number,
  ) {
    const t = this.telemetry;
    t.frequency = frequency;
    t.standby = standby;
    t.course = obs;
    this.lookupTimer -= dt;
    if (frequency !== this.frequency || this.lookupTimer <= 0) {
      this.frequency = frequency;
      this.lookupTimer = LOOKUP_INTERVAL;
      this.tune(db, input);
    }
    const s = this.station;
    if (!input.powered || !s) {
      this.clear();
      return;
    }
    rangeBearing(s.lat, s.lon, input.lat, input.lon, this.rb);
    const range = receptionRangeNm(s, input.altitude) * NM;
    this.distance = this.rb.distance;
    const inRange = this.rb.distance <= range;
    this.updateDme(input, s, range);
    t.ident = inRange || this.dmeValid ? s.ident : '';
    const loc = s.type === 'LOC' || s.type === 'ILS';
    t.localizer = loc;
    this.courseValid = false;
    this.gsValid = false;
    if (inRange && s.type !== 'DME') {
      if (loc) this.localizer(input, s);
      else this.vor(input, s, obs);
    }
    t.valid = this.courseValid;
    if (!this.courseValid) {
      t.deviation = 0;
      t.toFrom = 'off';
      t.bearing = undefined;
    } else {
      t.bearing = wrap360(this.rb.bearing + 180 - input.declination);
    }
    t.glideSlope = this.gsValid ? this.gsNeedle : undefined;
  }

  /** Lights the markers of this receiver's ILS the aircraft is over. */
  markers(input: AvionicsInput, out: MarkerLights) {
    const s = this.station;
    if (!this.courseValid || !this.frontCourse || this.threshold === undefined || !s?.glideSlope)
      return;
    const h = input.altitude - s.glideSlope.elevation;
    if (h <= 0) return;
    const tanGs = Math.tan(s.glideSlope.angleDeg * DEG);
    if (this.overMarker(h, tanGs, MARKER_DISTANCES.outer, MARKER_COVERAGE.outer)) out.outer = true;
    if (this.overMarker(h, tanGs, MARKER_DISTANCES.middle, MARKER_COVERAGE.middle))
      out.middle = true;
    if (this.overMarker(h, tanGs, MARKER_DISTANCES.inner, MARKER_COVERAGE.inner)) out.inner = true;
  }

  private overMarker(height: number, tanGs: number, distance: number, coverage: number) {
    // The fan beam widens with height: as long as the published coverage at the path's
    // height over the marker, and some three times as wide across the course.
    const nominal = distance * tanGs + ILS_REFERENCE_DATUM_HEIGHT;
    const half = ((coverage / 2) * height) / nominal;
    return Math.abs(this.alongThreshold - distance) < half && Math.abs(this.across) < 3 * half;
  }

  private tune(db: NavDatabase | undefined, input: AvionicsInput) {
    let best: NavStation | undefined;
    let bestDistance = Infinity;
    if (db) {
      for (const s of db.onFrequency(this.frequency)) {
        if (!isNavType(s)) continue;
        rangeBearing(s.lat, s.lon, input.lat, input.lon, this.rb);
        if (this.rb.distance > receptionRangeNm(s, input.altitude) * NM) continue;
        if (this.rb.distance < bestDistance) {
          bestDistance = this.rb.distance;
          best = s;
        }
      }
    }
    // Out of range of everything: keep the last station so the flag and the ident come
    // back by themselves when it is in range again.
    if (!best && this.station && this.station.frequency === this.frequency) return;
    if (best !== this.station) {
      this.station = best;
      this.locFullScale = best ? localizerFullScale(best) : LOC_DEFAULT_FULL_SCALE_DEG;
      this.threshold = best ? thresholdDistance(best) : undefined;
    }
  }

  private vor(input: AvionicsInput, s: NavStation, obs: number) {
    const t = this.telemetry;
    const radial = wrap360(this.rb.bearing - input.declination);
    const diff = wrap180(radial - obs);
    const from = Math.abs(diff) <= 90;
    const dev = from ? wrap180(obs - radial) : wrap180(radial + 180 - obs);
    const height = input.altitude - s.elevation;
    this.inCone = height > 0 && this.rb.distance < height * Math.tan(VOR_CONE_DEG * DEG);
    const ambiguous = Math.abs(Math.abs(diff) - 90) < TO_FROM_AMBIGUITY_DEG;
    t.toFrom = this.inCone || ambiguous ? 'off' : from ? 'from' : 'to';
    t.deviation = clamp1(dev / VOR_FULL_SCALE_DEG);
    this.deviationDeg = dev;
    this.offset = this.rb.distance * Math.sin(dev * DEG);
    this.guidedCourse = obs;
    this.frontCourse = true;
    this.courseValid = true;
  }

  private localizer(input: AvionicsInput, s: NavStation) {
    const t = this.telemetry;
    const course = s.course ?? 0;
    const rel = wrap180(this.rb.bearing - course);
    const front = Math.abs(rel) > 90;
    // On the back course the needle keeps the front course's sense: flown inbound from
    // behind the antenna it points away from the centreline (reverse sensing).
    const dev = front ? wrap180(rel - 180) : -rel;
    const off = Math.abs(front ? dev : rel);
    const nm = this.rb.distance / NM;
    if (
      off > LOC_COVERAGE.outerDeg ||
      nm > LOC_COVERAGE.innerNm ||
      (off > LOC_COVERAGE.innerDeg && nm > LOC_COVERAGE.outerNm)
    )
      return;
    this.courseValid = true;
    this.frontCourse = front;
    this.inCone = false;
    // A localizer has no TO/FROM; the flag stays out of view.
    t.toFrom = 'off';
    t.deviation = clamp1(dev / this.locFullScale);
    this.deviationDeg = dev;
    this.offset = this.rb.distance * Math.sin(dev * DEG);
    this.guidedCourse = wrap360(course - input.declination);
    if (front) {
      const along = this.rb.distance * Math.cos(dev * DEG);
      this.alongThreshold = along - (this.threshold ?? 0);
      this.across = -this.offset;
    }
    const gs = s.glideSlope;
    if (s.type !== 'ILS' || !gs || !front || off > GS_COVERAGE.azimuthDeg) return;
    rangeBearing(gs.lat, gs.lon, input.lat, input.lon, this.rbGs);
    if (this.rbGs.distance > GS_COVERAGE.rangeNm * NM) return;
    const h = input.altitude - gs.elevation;
    const angle = Math.atan2(h, this.rbGs.distance) / DEG;
    const fullScale = GS_FULL_SCALE_PER_ANGLE * gs.angleDeg;
    this.gsValid = true;
    this.gsAngle = gs.angleDeg;
    // Below the path the needle points up: fly towards it.
    this.gsNeedle = clamp1((gs.angleDeg - angle) / fullScale);
    this.gsHeightError = h - this.rbGs.distance * Math.tan(gs.angleDeg * DEG);
  }

  private updateDme(input: AvionicsInput, s: NavStation, range: number) {
    const d = s.dme ?? (s.type === 'DME' || s.type === 'VOR-DME' ? s : undefined);
    this.dmeValid = false;
    if (!d) return;
    let horizontal = this.rb.distance;
    let bearingFrom = this.rb.bearing;
    if (d !== s) {
      rangeBearing(d.lat, d.lon, input.lat, input.lon, this.rbGs);
      horizontal = this.rbGs.distance;
      bearingFrom = this.rbGs.bearing;
    }
    if (horizontal > range) return;
    const dh = input.altitude - d.elevation;
    const slant = Math.hypot(horizontal, dh);
    this.dmeValid = true;
    this.dmeDistance = slant;
    // Rate of change of the slant range from the velocity, not by differencing the
    // distance, so the readout is steady from the first step.
    const towards = input.groundSpeed * Math.cos((input.track - bearingFrom - 180) * DEG);
    this.dmeClosure = slant > 1 ? (horizontal * towards - dh * input.verticalSpeed) / slant : 0;
  }

  private clear() {
    const t = this.telemetry;
    t.valid = false;
    t.ident = '';
    t.localizer = false;
    t.deviation = 0;
    t.toFrom = 'off';
    t.bearing = undefined;
    t.glideSlope = undefined;
    this.courseValid = false;
    this.gsValid = false;
    this.dmeValid = false;
    this.inCone = false;
  }
}

const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);
