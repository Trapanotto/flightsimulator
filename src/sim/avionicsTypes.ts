/**
 * Contracts of the avionics (phase 3): radios, navigation receivers, transponder, GPS and
 * autopilot. The simulation knows no map: the app hands it the stations and the flight plan
 * (from the `geo` package) through these types.
 */

/** A ground station a receiver can tune. All bearings and courses in degrees TRUE. */
export interface NavStation {
  ident: string;
  name: string;
  /** 'ILS' is a localizer with a glide slope; 'LOC' one without. */
  type: 'VOR' | 'VOR-DME' | 'DME' | 'NDB' | 'LOC' | 'ILS';
  /** kHz: 108 000 .. 117 950 for VOR, LOC and ILS; 190 .. 1750 for NDB. */
  frequency: number;
  lon: number;
  lat: number;
  /** Metres above sea level. */
  elevation: number;
  /** Nautical miles at which it can still be received. */
  rangeNm: number;
  /** LOC/ILS: the runway's true course the localizer guides along. */
  course?: number;
  /** ILS: where the glide slope antenna stands and its angle (usually 3 degrees). */
  glideSlope?: { lon: number; lat: number; elevation: number; angleDeg: number };
  /** A DME paired with the station (VOR-DME, most ILS). */
  dme?: { lon: number; lat: number; elevation: number };
  /** LOC/ILS: the airport and runway it serves. */
  airport?: string;
  runway?: string;
}

/** The stations the receivers can hear. Implemented by the app over the geo package's data. */
export interface NavDatabase {
  /** Every station on a frequency (kHz); the receiver picks the nearest one in range. */
  onFrequency(frequency: number): readonly NavStation[];
}

/** A point of the GPS flight plan. */
export interface Waypoint {
  ident: string;
  lon: number;
  lat: number;
  /** Planned altitude, metres above sea level, if any. */
  altitude?: number;
}

/** One NAV receiver with its course indicator. */
export interface NavReceiverTelemetry {
  /** kHz */
  frequency: number;
  /** A station is received; without one the indicator shows its flag. */
  valid: boolean;
  /** The station's ident (also what its Morse code spells), '' without a signal. */
  ident: string;
  /** The tuned station is a localizer: the course knob has no effect. */
  localizer: boolean;
  /** Selected course (the OBS), degrees magnetic. */
  course: number;
  /** Needle: -1 full left .. 1 full right (fly towards the needle). Full scale is 10 degrees for a VOR, about 2.5 for a localizer. */
  deviation: number;
  toFrom: 'to' | 'from' | 'off';
  /** Magnetic bearing from the aircraft to the station, degrees; undefined without a signal. */
  bearing: number | undefined;
  /** Glide slope needle: -1 full down .. 1 full up (fly towards it); undefined without one. */
  glideSlope: number | undefined;
}

export type AutopilotLateral = 'roll' | 'hdg' | 'nav' | 'apr';
/** 'flc' (phase 4): flight level change, a climb or descent at a held airspeed. */
export type AutopilotVertical = 'pitch' | 'vs' | 'alt' | 'gs' | 'flc';

export interface AutopilotTelemetry {
  engaged: boolean;
  lateral: AutopilotLateral;
  /** NAV or APR is armed and waits to capture the course. */
  lateralArmed: 'nav' | 'apr' | undefined;
  vertical: AutopilotVertical;
  /** ALT is armed to capture the selected altitude; GS waits for the glide slope. */
  verticalArmed: 'alt' | 'gs' | undefined;
  /** Selected altitude (feet) and vertical speed (feet per minute). */
  selectedAltitude: number;
  selectedVerticalSpeed: number;
  /** It has just disconnected: the warning tone sounds while true (a few seconds). */
  disconnectWarning: boolean;
  /** Phase 4, on types that have them. */
  yawDamper?: boolean;
  /** Flight director bars: commanded pitch and bank, radians; undefined when off. */
  flightDirector?: { pitch: number; bank: number };
  /** Selected airspeed (knots) for FLC and the autothrottle; Mach when `selectedMach` is set. */
  selectedSpeed?: number;
  selectedMach?: number;
  /** Autothrottle or autothrust. */
  autothrottle?: { engaged: boolean; mode: 'speed' | 'thrust' | 'idle' | 'off' };
}

export interface GpsTelemetry {
  /** The flight plan and the index of the waypoint being flown to (-1 without a plan). */
  plan: readonly Waypoint[];
  active: number;
  /** To the active waypoint: distance (NM), magnetic bearing and desired track, degrees. */
  distanceNm: number | undefined;
  bearing: number | undefined;
  desiredTrack: number | undefined;
  /** Cross-track error, NM, positive = right of the course. */
  crossTrackNm: number | undefined;
  /** Ground speed (knots) and magnetic track, degrees. */
  groundSpeedKt: number;
  track: number;
  /** Position, for a moving map. */
  lon: number;
  lat: number;
}

/** Everything the avionics show, refreshed every step. All dark when `powered` is false. */
export interface AvionicsTelemetry {
  powered: boolean;
  /** kHz */
  com1: { active: number; standby: number };
  com2: { active: number; standby: number };
  nav1: NavReceiverTelemetry & { standby: number };
  nav2: NavReceiverTelemetry & { standby: number };
  /** Distance measuring equipment on the selected NAV; undefined values without a signal. */
  dme: {
    source: 'nav1' | 'nav2';
    distanceNm: number | undefined;
    groundSpeedKt: number | undefined;
    minutes: number | undefined;
  };
  adf: {
    /** kHz */
    frequency: number;
    valid: boolean;
    ident: string;
    /** Relative bearing to the station, degrees clockwise from the nose; undefined without a signal. */
    relativeBearing: number | undefined;
  };
  transponder: {
    code: number;
    mode: 'off' | 'standby' | 'on' | 'alt';
    /** Lit for a few seconds after IDENT, and briefly whenever it replies. */
    ident: boolean;
    reply: boolean;
  };
  /** Marker beacons of an ILS being overflown. */
  markers: { outer: boolean; middle: boolean; inner: boolean };
  autopilot: AutopilotTelemetry;
  gps: GpsTelemetry;
}

/** What the app sets up for a flight. */
export interface Avionics {
  /** The stations that can be received; none until this is called. */
  setDatabase(db: NavDatabase): void;
  /** The GPS flight plan (an empty list clears it). */
  setFlightPlan(plan: readonly Waypoint[]): void;
  /** Flies directly to a waypoint of the plan. */
  directTo(index: number): void;
}

/** What the avionics need from the aircraft every step. */
export interface AvionicsInput {
  /** The avionics bus has power. */
  powered: boolean;
  /** COM 1 has failed. */
  com1Failed: boolean;
  lon: number;
  lat: number;
  /** Metres above sea level. */
  altitude: number;
  /** Degrees true. */
  heading: number;
  track: number;
  /** m/s */
  groundSpeed: number;
  verticalSpeed: number;
  ias: number;
  /** Radians. */
  pitch: number;
  bank: number;
  /** Degrees per second, positive right. */
  turnRate: number;
  onGround: boolean;
  /** Magnetic declination here, degrees, positive east (magnetic = true - declination). */
  declination: number;
  /** What the pilot's instruments show: the autopilot flies by these, failures included. */
  indicatedHeading: number;
  indicatedAltitude: number;
  /** The pilot's own stick input, -1..1: a firm push disconnects the autopilot. */
  pilotPitch: number;
  pilotRoll: number;
}

/** What the autopilot does with the controls while engaged, in ControlInput's units. */
export interface AutopilotCommand {
  roll: number;
  /** The autopilot flies pitch through the trim, like the real one, plus a small elevator input. */
  pitch: number;
  pitchTrim: number;
}

/**
 * The avionics as a unit the flight model drives: it reads its knobs and buttons from the
 * cockpit by name (see C172_CONTROLS) and writes back what a button press changes (a swapped
 * frequency).
 */
export interface AvionicsUnit extends Avionics {
  readonly telemetry: AvionicsTelemetry;
  /** Set while the autopilot is engaged. */
  readonly command: AutopilotCommand | undefined;
  /** Back to the state after power-up; the database and the flight plan stay. */
  reset(): void;
  step(dt: number, input: AvionicsInput, cockpit: import('./cockpit').Cockpit): void;
}
