/**
 * The C172's avionics stack as one unit: two NAV/COM radios, DME, ADF, transponder, a panel
 * GPS, marker beacons and the autopilot. The flight model steps it once per simulation step;
 * it reads its knobs and buttons from the cockpit by name and writes back what a press
 * changes.
 */
import type {
  AutopilotCommand,
  AvionicsInput,
  AvionicsTelemetry,
  AvionicsUnit,
  NavDatabase,
  NavStation,
  Waypoint,
} from '../avionicsTypes';
import type { Cockpit } from '../cockpit';
import { smoothstep } from '../math';
import {
  Autopilot,
  type AutopilotButtons,
  type LateralGuidance,
  type VerticalGuidance,
} from './autopilot';
import { KT, NM, type RangeBearing, rangeBearing, wrap360 } from './geo';
import { Gps } from './gps';
import { NavReceiver } from './navReceiver';

/** IDENT keeps the special position pulse going this long, s (KT 76C and GTX 327: 18 s). */
export const IDENT_DURATION_S = 18;
/** Secondary radar interrogates once a sweep (an approach radar turns in about 4 s). */
const RADAR_SWEEP_S = 4;
const REPLY_LIGHT_S = 0.2;
/** The ADF needle wanders by up to this much near the edge of the NDB's range, degrees. */
const ADF_WANDER_DEG = 8;
/** Below this closure the DME shows no time to the station, m/s (about 10 kt). */
const DME_MIN_CLOSURE = 5;
const LOOKUP_INTERVAL = 1;

const XPDR_MODES = ['off', 'standby', 'on', 'alt'] as const;

const BUTTONS = [
  'com1Swap',
  'com2Swap',
  'nav1Swap',
  'nav2Swap',
  'xpdrIdent',
  'apEngage',
  'apHdg',
  'apNav',
  'apApr',
  'apAlt',
  'apVsUp',
  'apVsDown',
] as const;
type Button = (typeof BUTTONS)[number];

export function createAvionics(): AvionicsUnit {
  return new C172Avionics();
}

class C172Avionics implements AvionicsUnit {
  readonly telemetry: AvionicsTelemetry;
  private readonly nav1 = new NavReceiver();
  private readonly nav2 = new NavReceiver();
  private readonly gps = new Gps();
  private readonly autopilot = new Autopilot();
  private db: NavDatabase | undefined;
  private time = 0;
  private readonly lastButton = new Float64Array(BUTTONS.length);
  private readonly pressed = new Uint8Array(BUTTONS.length);
  private readonly apButtons: AutopilotButtons = {
    engage: false,
    hdg: false,
    nav: false,
    apr: false,
    alt: false,
    up: false,
    down: false,
  };
  private readonly lateral: LateralGuidance = {
    valid: false,
    course: 0,
    offset: 0,
    needle: 0,
    frozen: false,
  };
  private readonly vertical: VerticalGuidance = {
    valid: false,
    heightError: 0,
    needle: 0,
    angleDeg: 3,
  };
  private ndb: NavStation | undefined;
  private adfFrequency = -1;
  private adfTimer = 0;
  private identTimer = 0;
  private readonly rb: RangeBearing = { distance: 0, bearing: 0 };

  constructor() {
    const ap = this.autopilot.telemetry;
    this.telemetry = {
      powered: false,
      com1: { active: 0, standby: 0 },
      com2: { active: 0, standby: 0 },
      nav1: this.nav1.telemetry,
      nav2: this.nav2.telemetry,
      dme: { source: 'nav1', distanceNm: undefined, groundSpeedKt: undefined, minutes: undefined },
      adf: { frequency: 0, valid: false, ident: '', relativeBearing: undefined },
      transponder: { code: 0, mode: 'off', ident: false, reply: false },
      markers: { outer: false, middle: false, inner: false },
      autopilot: ap,
      gps: this.gps.telemetry,
    };
  }

  get command(): AutopilotCommand | undefined {
    return this.autopilot.engaged ? this.autopilot.command : undefined;
  }

  setDatabase(db: NavDatabase) {
    this.db = db;
    // Retune at once, not at the next periodic lookup.
    this.nav1.reset();
    this.nav2.reset();
    this.adfFrequency = -1;
  }

  setFlightPlan(plan: readonly Waypoint[]) {
    this.gps.setPlan(plan);
  }

  directTo(index: number) {
    this.gps.directTo(index);
  }

  reset() {
    this.time = 0;
    this.lastButton.fill(0);
    this.nav1.reset();
    this.nav2.reset();
    this.gps.reset();
    this.autopilot.reset();
    this.ndb = undefined;
    this.adfFrequency = -1;
    this.identTimer = 0;
  }

  step(dt: number, input: AvionicsInput, cockpit: Cockpit) {
    this.time += dt;
    const t = this.telemetry;
    const powered = input.powered;
    t.powered = powered;
    this.readButtons(cockpit);

    // ---- COM ----
    const com1Works = powered && !input.com1Failed;
    if (com1Works && this.wasPressed('com1Swap')) swap(cockpit, 'com1Active', 'com1Standby');
    if (powered && this.wasPressed('com2Swap')) swap(cockpit, 'com2Active', 'com2Standby');
    t.com1.active = input.com1Failed ? 0 : cockpit.get('com1Active');
    t.com1.standby = input.com1Failed ? 0 : cockpit.get('com1Standby');
    t.com2.active = cockpit.get('com2Active');
    t.com2.standby = cockpit.get('com2Standby');

    // ---- NAV ----
    if (powered && this.wasPressed('nav1Swap')) swap(cockpit, 'nav1Active', 'nav1Standby');
    if (powered && this.wasPressed('nav2Swap')) swap(cockpit, 'nav2Active', 'nav2Standby');
    this.nav1.update(
      dt,
      input,
      this.db,
      cockpit.get('nav1Active'),
      cockpit.get('nav1Standby'),
      cockpit.get('obs1'),
    );
    this.nav2.update(
      dt,
      input,
      this.db,
      cockpit.get('nav2Active'),
      cockpit.get('nav2Standby'),
      cockpit.get('obs2'),
    );

    // ---- GPS ----
    this.gps.update(input);
    const gpsSource = cockpit.get('navSource') === 1;
    if (gpsSource) this.showGpsOnNav1();

    // ---- DME, ADF, transponder, markers ----
    this.updateDme(cockpit.get('dmeSource') === 1 ? this.nav2 : this.nav1, cockpit, powered);
    this.updateAdf(dt, input, cockpit.get('adfFrequency'));
    this.updateTransponder(dt, cockpit, powered);
    const m = t.markers;
    m.outer = m.middle = m.inner = false;
    if (powered) {
      this.nav1.markers(input, m);
      this.nav2.markers(input, m);
    }

    // ---- autopilot ----
    this.guidance(gpsSource);
    const b = this.apButtons;
    b.engage = this.wasPressed('apEngage');
    b.hdg = this.wasPressed('apHdg');
    b.nav = this.wasPressed('apNav');
    b.apr = this.wasPressed('apApr');
    b.alt = this.wasPressed('apAlt');
    b.up = this.wasPressed('apVsUp');
    b.down = this.wasPressed('apVsDown');
    this.autopilot.step(
      dt,
      input,
      b,
      cockpit.get('apAltitude'),
      cockpit.get('headingBug'),
      cockpit.get('trim'),
      this.lateral,
      this.vertical,
    );
  }

  private readButtons(cockpit: Cockpit) {
    for (let i = 0; i < BUTTONS.length; i++) {
      const v = cockpit.get(BUTTONS[i]!);
      this.pressed[i] = v >= 0.5 && this.lastButton[i]! < 0.5 ? 1 : 0;
      this.lastButton[i] = v;
    }
  }

  private wasPressed(id: Button): boolean {
    return this.pressed[BUTTONS.indexOf(id)] === 1;
  }

  /** With NAV source on GPS, indicator 1 shows the GPS course and its deviation. */
  private showGpsOnNav1() {
    const n = this.telemetry.nav1;
    const g = this.gps;
    n.localizer = false;
    n.glideSlope = undefined;
    if (!g.valid) {
      n.valid = false;
      n.deviation = 0;
      n.toFrom = 'off';
      n.bearing = undefined;
      return;
    }
    n.valid = true;
    n.course = g.desiredTrack;
    n.deviation = clamp1(-g.crossTrack / NM / g.fullScaleNm());
    n.toFrom = g.from ? 'from' : 'to';
    n.bearing = g.bearing;
  }

  private guidance(gpsSource: boolean) {
    const l = this.lateral;
    const v = this.vertical;
    v.valid = false;
    if (gpsSource) {
      const g = this.gps;
      l.valid = g.valid;
      l.course = g.desiredTrack;
      l.offset = -g.crossTrack;
      l.needle = this.telemetry.nav1.deviation;
      l.frozen = false;
      return;
    }
    const n = this.nav1;
    // The autopilot couples to a localizer's front course only (no back-course mode).
    l.valid = n.courseValid && (!n.telemetry.localizer || n.frontCourse);
    l.course = n.guidedCourse;
    l.offset = n.offset;
    l.needle = n.telemetry.deviation;
    l.frozen = n.inCone;
    if (n.gsValid) {
      v.valid = true;
      v.heightError = n.gsHeightError;
      v.needle = n.gsNeedle;
      v.angleDeg = n.gsAngle;
    }
  }

  private updateDme(n: NavReceiver, cockpit: Cockpit, powered: boolean) {
    const d = this.telemetry.dme;
    d.source = cockpit.get('dmeSource') === 1 ? 'nav2' : 'nav1';
    if (!powered || !n.dmeValid) {
      d.distanceNm = undefined;
      d.groundSpeedKt = undefined;
      d.minutes = undefined;
      return;
    }
    d.distanceNm = n.dmeDistance / NM;
    d.groundSpeedKt = n.dmeClosure / KT;
    d.minutes = n.dmeClosure > DME_MIN_CLOSURE ? n.dmeDistance / n.dmeClosure / 60 : undefined;
  }

  private updateAdf(dt: number, input: AvionicsInput, frequency: number) {
    const a = this.telemetry.adf;
    a.frequency = frequency;
    this.adfTimer -= dt;
    if (frequency !== this.adfFrequency || this.adfTimer <= 0) {
      this.adfFrequency = frequency;
      this.adfTimer = LOOKUP_INTERVAL;
      this.ndb = this.findNdb(input, frequency);
    }
    const s = this.ndb;
    a.valid = false;
    a.ident = '';
    a.relativeBearing = undefined;
    if (!input.powered || !s) return;
    rangeBearing(input.lat, input.lon, s.lat, s.lon, this.rb);
    // Low frequency travels as a ground wave: no line of sight, only the published range.
    const share = this.rb.distance / (s.rangeNm * NM);
    if (share > 1) return;
    a.valid = true;
    a.ident = s.ident;
    // Near the edge of range the weak signal lets the needle hunt; two incommensurate
    // periods keep it from looking mechanical while staying a function of time.
    const t = this.time;
    const wander =
      ADF_WANDER_DEG *
      smoothstep(0.7, 1, share) *
      (0.65 * Math.sin(0.83 * t) + 0.35 * Math.sin(2.31 * t + 1.7));
    a.relativeBearing = wrap360(this.rb.bearing - input.heading + wander);
  }

  private findNdb(input: AvionicsInput, frequency: number): NavStation | undefined {
    if (!this.db) return undefined;
    let best: NavStation | undefined;
    let bestDistance = Infinity;
    for (const s of this.db.onFrequency(frequency)) {
      if (s.type !== 'NDB') continue;
      rangeBearing(input.lat, input.lon, s.lat, s.lon, this.rb);
      if (this.rb.distance > s.rangeNm * NM || this.rb.distance >= bestDistance) continue;
      bestDistance = this.rb.distance;
      best = s;
    }
    return best;
  }

  private updateTransponder(dt: number, cockpit: Cockpit, powered: boolean) {
    const x = this.telemetry.transponder;
    x.code = cockpit.get('xpdrCode');
    x.mode = powered ? (XPDR_MODES[cockpit.get('xpdrMode')] ?? 'off') : 'off';
    const replying = x.mode === 'on' || x.mode === 'alt';
    if (replying && this.wasPressed('xpdrIdent')) this.identTimer = IDENT_DURATION_S;
    this.identTimer = replying ? Math.max(0, this.identTimer - dt) : 0;
    x.ident = this.identTimer > 0;
    x.reply = replying && (this.time % RADAR_SWEEP_S < REPLY_LIGHT_S || x.ident);
  }
}

function swap(cockpit: Cockpit, active: string, standby: string) {
  const a = cockpit.get(active);
  cockpit.set(active, cockpit.get(standby));
  cockpit.set(standby, a);
}

const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);
