/**
 * Contracts of the avionics (phase 3): radios, navigation receivers, transponder, GPS and
 * autopilot. The simulation knows no map: the app hands it the stations and the flight plan
 * (from the `geo` package) through these types.
 */
import type { Telemetry } from './types';

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
  /** Phase 4: go-around mode: wings level and the go-around pitch on the flight director. */
  goAround?: boolean;
  /** Phase 4: the Airbus A320's flight guidance, flight controls and ECAM (see below). */
  airbus?: AirbusTelemetry;
}

// ---- Airbus A320 (Phase 4) ---------------------------------------------------------------
// What the A320's primary flight display, navigation display, ECAM, FCU, the sound and the
// interface read. The flight guidance computer (src/sim/a320/fmgc.ts) writes `fma`, `speeds`,
// `fcu` and `guidance`; the flight control and system computers (src/sim/a320/computers.ts)
// write `controls`, `systems` and `ecam`. Strings are what the real display shows, in its
// own (English) words; the interface translates around them if it wants to.

/** The five columns of the flight mode annunciator. '' shows nothing. */
export interface AirbusFma {
  /**
   * Column 1, autothrust: 'MAN TOGA', 'MAN FLX', 'MAN MCT', 'MAN THR', 'THR CLB', 'THR MCT',
   * 'THR IDLE', 'THR LVR', 'SPEED', 'MACH', 'A.FLOOR', 'TOGA LK'. Blue armed: 'A/THR' style
   * text goes to column 5; `thrustCaution` is the amber 'LVR CLB' / 'LVR MCT' / 'LVR ASYM' request.
   */
  thrust: string;
  thrustCaution: string;
  /** Column 2, vertical: 'SRS', 'CLB', 'OP CLB', 'DES', 'OP DES', 'ALT*', 'ALT', 'ALT CST', 'V/S +1500', 'EXP CLB', 'EXP DES', 'G/S*', 'G/S', 'LAND', 'FLARE', 'ROLL OUT'. */
  vertical: string;
  /** Armed vertical modes in blue: 'ALT', 'G/S', 'CLB', 'DES', 'ALT G/S', 'FINAL' (several separated by a space). */
  verticalArmed: string;
  /** Column 3, lateral: 'RWY', 'RWY TRK', 'HDG', 'NAV', 'LOC*', 'LOC', 'GA TRK', 'LAND', 'FLARE', 'ROLL OUT'. */
  lateral: string;
  lateralArmed: string;
  /** LAND, FLARE and ROLL OUT span columns 2 and 3: `vertical` and `lateral` then hold the same text. */
  combined: boolean;
  /** Column 4: approach capability 'CAT 1', 'CAT 2', 'CAT 3 SINGLE', 'CAT 3 DUAL' and the minimum ('DH 100', 'NO DH', ''). */
  capability: string;
  minimum: string;
  /** Column 5: 'AP1', 'AP2', 'AP1+2' or ''; '1 FD 2', '1 FD -', '- FD 2' or ''; autothrust 'A/THR' white (active) or blue (armed). */
  autopilot: string;
  flightDirectors: string;
  autothrust: 'active' | 'armed' | 'off';
  /** A mode has just changed in each column (a white box is drawn around it for ten seconds). */
  changed: [boolean, boolean, boolean, boolean, boolean];
}

/** Characteristic speeds of the speed tape, knots IAS (NaN where the display hides them). */
export interface AirbusSpeeds {
  /** Lowest selectable speed (top of the amber strip), stall warning (VSW) and the red and black VMAX barber pole. */
  vls: number;
  vsw: number;
  vmax: number;
  /** Alpha protection and alpha max (tops of the amber-black and red strips) in normal law. */
  alphaProt: number;
  alphaMax: number;
  /** Flap and slat retraction speeds and green dot (best lift-to-drag clean); only in the configuration that uses each. */
  f: number;
  s: number;
  greenDot: number;
  /** Approach speed for the landing configuration (VLS + 5 kt) from the mass. */
  vapp: number;
  /** Take-off speeds (the computer's V1, VR, V2 for the mass and CONF 1+F), shown on the ground. */
  v1: number;
  vr: number;
  v2: number;
  /** Next flap speed maximum (VFE of the next lever position), amber '=' on the tape. */
  vfeNext: number;
  /** Speed target: magenta when managed, blue when selected; Mach target when `mach`. */
  target: number;
  targetMach: number;
  managed: boolean;
  mach: boolean;
  /** Speed trend arrow: the speed in ten seconds, knots. */
  trend: number;
  /** Gross mass the speeds are computed for, kg. */
  mass: number;
}

/** What the flight control unit's windows show. NaN shows dashes (a managed value). */
export interface AirbusFcu {
  speed: number;
  mach: boolean;
  heading: number;
  altitude: number;
  verticalSpeed: number;
  /** The dots beside a window: that axis is managed. */
  speedDot: boolean;
  headingDot: boolean;
  altitudeDot: boolean;
  /** LOC, APPR, EXPED, AP1, AP2, A/THR buttons lit. */
  loc: boolean;
  appr: boolean;
  exped: boolean;
  ap1: boolean;
  ap2: boolean;
  athr: boolean;
}

/** The flight guidance's own targets, for the flight director and the navigation display. */
export interface AirbusGuidance {
  /** Altitude target of the vertical mode, feet (the FCU's, or a constraint's), and whether it is a constraint. */
  altitudeTarget: number;
  altitudeConstraint: boolean;
  /** Track (degrees magnetic) or heading being flown, and the target vertical speed, ft/min. */
  lateralTarget: number;
  verticalSpeedTarget: number;
  /** Flight phase of the computer: 'preflight', 'takeoff', 'climb', 'cruise', 'descent', 'approach', 'goAround', 'done'. */
  phase: string;
  /** Callouts the sound plays once each (the 'RETARD' at 10 ft, the radio altitude calls). */
  callout: string;
}

/** The flight controls as the flight control computers report them. */
export interface AirbusControls {
  /** The law in force: pitch and roll ('normal', 'alternate', 'direct'), and the flare mode of the pitch law. */
  law: 'normal' | 'alternate' | 'direct';
  flareMode: boolean;
  /** The law flies the ground mode (direct stick on the ground, blended in after lift-off). */
  groundMode: boolean;
  /** Protections acting now. */
  alphaProtection: boolean;
  alphaFloor: boolean;
  highSpeedProtection: boolean;
  /** Bank and pitch attitude limits reached. */
  bankLimit: boolean;
  pitchLimit: boolean;
  /** Slat and flap configuration: '0', '1', '1+F', '2', '3', 'FULL'; positions in degrees. */
  config: string;
  slats: number;
  flaps: number;
  /** Trimmable horizontal stabiliser, degrees (positive nose up), and the rudder trim, degrees. */
  stabiliser: number;
  rudderTrim: number;
  /** Ground spoilers armed, deployed; speed brake extended share. */
  spoilersArmed: boolean;
  groundSpoilers: boolean;
  speedbrake: number;
  /** Autobrake selected (off, low, medium, max), armed, decelerating (the DECEL light). */
  autobrake: 'off' | 'low' | 'medium' | 'max';
  autobrakeArmed: boolean;
  autobrakeDecel: boolean;
  /** Nose wheel steering angle, degrees (positive right). */
  steering: number;
}

/** What the system pages of the lower ECAM show. Pressures psi, temperatures °C. */
export interface AirbusSystems {
  apu: {
    master: boolean;
    /** Speed and exhaust gas temperature, per cent and °C; AVAIL; bleed and generator on line. */
    n: number;
    egt: number;
    available: boolean;
    bleed: boolean;
    generator: boolean;
  };
  /** Bleed pressure in the left and right ducts. */
  bleed: [number, number];
  /** Engine start: valve open, igniters A/B firing, and the phase of the automatic start. */
  start: { valve: [boolean, boolean]; ignition: [boolean, boolean]; phase: [string, string] };
  /** Air data and inertial reference: aligned, seconds still to align (0 aligned). */
  adirs: { aligned: boolean; remaining: number };
  electrical: {
    ac1: boolean;
    ac2: boolean;
    acEss: boolean;
    dcEss: boolean;
    dcBat: boolean;
    /** Which source feeds the AC buses: 'gen1', 'gen2', 'apu', 'ext', 'none'. */
    source: [string, string];
    batteryVolts: [number, number];
  };
  hydraulics: { green: number; blue: number; yellow: number; ptu: boolean; rat: boolean };
  fuel: {
    /** Left wing, centre, right wing, kg, and the pumps running. */
    tanks: [number, number, number];
    pumps: { left: boolean; centre: boolean; right: boolean };
    crossfeed: boolean;
    /** Total fuel used since the engines started, kg. */
    used: number;
  };
  /** Packs on and flowing, cabin altitude ft, rate ft/min, differential psi. */
  air: {
    packs: [boolean, boolean];
    cabinAltitude: number;
    cabinRate: number;
    differential: number;
  };
  antiIce: { wing: boolean; engine: [boolean, boolean] };
  brakes: { pressure: number; antiSkid: boolean; parking: boolean };
  /** Gross mass, kg (the weight and balance the computers use). */
  grossMass: number;
}

/** ECAM: the upper display's warnings and memo, as plain lines. */
export interface AirbusEcam {
  /** Red warnings then amber cautions, most important first ('ENG 1 FAIL', 'HYD G SYS LO PR'). */
  warnings: string[];
  /** Memo lines: 'T.O MEMO', 'LDG MEMO' items, 'SPEED BRK', 'PARK BRK', 'APU AVAIL', 'SEAT BELTS'... */
  memo: string[];
  /** Master warning and master caution lights. */
  masterWarning: boolean;
  masterCaution: boolean;
}

export interface AirbusTelemetry {
  fma: AirbusFma;
  speeds: AirbusSpeeds;
  fcu: AirbusFcu;
  guidance: AirbusGuidance;
  controls: AirbusControls;
  systems: AirbusSystems;
  ecam: AirbusEcam;
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
  /**
   * Phase 4: the aircraft's whole telemetry of the last step (radio altitude, Mach, angle of
   * attack, flaps, engines, fuel), for flight guidance that needs more than the sensors above.
   */
  telemetry?: Telemetry;
}

/** What the autopilot does with the controls while engaged, in ControlInput's units. */
export interface AutopilotCommand {
  roll: number;
  /** The autopilot flies pitch through the trim, like the real one, plus a small elevator input. */
  pitch: number;
  pitchTrim: number;
  /**
   * Phase 4: an autothrottle's lever position for every engine, 0..1, while it is engaged
   * (the flight model then flies it instead of the pilot's levers). Undefined: hands off.
   */
  throttle?: number;
  /** Phase 4: the autopilot (not only the yaw damper) flies the rudder, -1..1. */
  yaw?: number;
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
