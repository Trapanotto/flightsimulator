/**
 * The Hornet's own systems, beyond the generic electrical, fuel, hydraulic and engine
 * accessories: the APU and the crank start, the throttles' fuel cut-off, fuel dump and bingo,
 * the environmental system and OBOGS oxygen, canopy, arresting hook, nosewheel steering and
 * anti-skid, take-off trim, the flight control system's cockpit switches, and the mission
 * computer's head-up display and caution data (`AvionicsTelemetry.fa18`).
 *
 * Start (NATOPS normal procedures, in that order): battery ON, APU ON (ready after about
 * 15 s), crank switch to R, right throttle to IDLE at 15 % N2 minimum, the crank switch
 * drops back to OFF at about 60 % N2; then the left engine the same way. The APU shuts down
 * by itself a minute after both generators are on line.
 */
import { isa } from '../atmosphere';
import type { Fa18HudTelemetry } from '../avionicsTypes';
import type { TypeSystems } from '../definition';
import type { FlightModel } from '../flightModel';
import { DEG, FT, KT, clamp } from '../math';
import { FA18_FCS, Fa18Fcs } from './fcs';

const PSI = 6894.757;
/** APU start to ready, s; it runs on a minute after both generators are on line. */
const APU_START = 15;
const APU_RUN_ON = 60;
/** NWS: high gain ±75° against the low gain's ±16°. */
const NWS_HIGH = 75 / 16;
/** Dump rate, kg/s (about 1000 lb/min), stopping at the bingo setting. */
const DUMP_RATE = 7.5;
/** ECS: unpressurised to 8000 ft, then 8000 ft cabin until 5 psi differential (from memory). */
const CABIN_HOLD = 8000 * FT;
const CABIN_DIFFERENTIAL = 5 * PSI;
/** Radar altimeter range, m. */
const RADAR_RANGE = 5000 * FT;
/** Take-off trim: 4° stabilator nose up (NATOPS), as a share of the trim range. */
export const TAKEOFF_TRIM = 4 / 24;
const CRANK_CUTOUT = 0.6;

const FLAP_MODES = ['auto', 'half', 'full'] as const;

/** Cabin altitude (m) for an outside pressure, from the ECS schedule. */
export function cabinAltitudeFor(pressure: number): number {
  const hold = isa(CABIN_HOLD).pressure;
  const cabin = pressure >= hold ? pressure : Math.min(hold, pressure + CABIN_DIFFERENTIAL);
  return pressureAltitude(cabin);
}

function pressureAltitude(p: number) {
  return 44_330.8 * (1 - (p / 101_325) ** 0.190263);
}

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

export class Fa18Systems implements TypeSystems {
  apu: 'off' | 'starting' | 'ready' = 'off';
  canopy = 1;
  hook = 0;
  cabinAltitude = 0;
  oxygen = true;
  nws: 'off' | 'low' | 'high' = 'low';
  dumping = false;
  peakG = 1;
  private apuTimer = 0;
  private apuRunOn = 0;
  private nwsEngaged = true;
  private readonly last = new Map<string, number>();
  readonly hud: Fa18HudTelemetry = {
    flightPath: 0,
    drift: 0,
    alpha: 0,
    onSpeed: undefined,
    g: 1,
    peakG: 1,
    mach: 0,
    airspeed: 0,
    altitude: 0,
    radarAltitude: undefined,
    radarAltitudeShown: false,
    verticalVelocity: 0,
    bank: 0,
    pitch: 0,
    heading: 0,
    steering: {
      source: 'wypt',
      valid: false,
      bearing: undefined,
      rangeNm: undefined,
      minutes: undefined,
    },
    ils: { localizer: undefined, glideSlope: undefined },
    flapMode: 'auto',
    trailingEdgeFlap: 0,
    leadingEdgeFlap: 0,
    gear: 'down',
    fcsMode: 'ua',
    gLimit: 7.5,
    cautions: [],
    advisories: [],
    modes: [],
    fuel: 0,
    bingoSetting: 0,
    bingo: false,
    apu: 'off',
    canopy: 1,
    hook: 0,
    cabinAltitude: 0,
    oxygen: true,
    nosewheelSteering: 'low',
    antiSkid: true,
    fuelDumping: false,
  };

  /** A cockpit button went down since the last look. */
  private pressed(ac: FlightModel, id: string): boolean {
    const v = ac.cockpit.get(id);
    const was = this.last.get(id) ?? 0;
    this.last.set(id, v);
    return v >= 0.5 && was < 0.5;
  }

  reset(ac: FlightModel) {
    const c = ac.cockpit;
    this.last.clear();
    for (const id of ['takeoffTrim', 'masterCaution', 'nosewheelSteering', 'apDisconnect'])
      this.last.set(id, c.get(id));
    this.applyThrottles(ac);
    ac.controls.starter?.fill(false);
    this.apu = 'off';
    this.apuTimer = 0;
    this.apuRunOn = 0;
    this.canopy = c.get('canopy') === 2 ? 1 : 0;
    this.hook = c.get('hook');
    this.nwsEngaged = true;
    this.nws = 'low';
    this.dumping = false;
    this.peakG = 1;
    this.oxygen = c.get('oxygen') === 1;
    ac.steeringScale = 1;
  }

  /** Throttles round the horn: fuel to the engine or cut off. */
  private applyThrottles(ac: FlightModel) {
    const cond = ac.controls.condition;
    if (!cond) return;
    for (let i = 0; i < cond.length; i++) cond[i] = ac.cockpit.get(`fuelCutoff${i + 1}`);
  }

  beforeEngines(dt: number, ac: FlightModel) {
    const c = ac.cockpit;
    const t = ac.telemetry;
    const bus = ac.systems.electrical.busPowered;
    this.applyThrottles(ac);

    // ---- APU and crank ----
    const gensOnline = ac.systems.electrical.generatorOnline;
    const bothGens = gensOnline.length > 1 && gensOnline[0] === 1 && gensOnline[1] === 1;
    if (c.get('apu') !== 1 || !bus) {
      this.apu = 'off';
      this.apuTimer = 0;
      this.apuRunOn = 0;
    } else if (this.apu !== 'off' || this.apuRunOn === 0) {
      this.apuTimer += dt;
      this.apu = this.apuTimer >= APU_START ? 'ready' : 'starting';
      if (this.apu === 'ready' && bothGens) {
        this.apuRunOn += dt;
        if (this.apuRunOn >= APU_RUN_ON) {
          // Off by itself; the switch follows.
          this.apu = 'off';
          c.set('apu', 0);
        }
      }
    }
    const crank = c.get('engineCrank');
    const starter = ac.controls.starter;
    if (starter) {
      for (let i = 0; i < starter.length; i++) {
        // Left engine is engine 0, crank position 0; right engine 1, position 2.
        const selected = crank === (i === 0 ? 0 : 2);
        const n2 = (ac.engines[i]?.telemetry.n2 ?? 0) / 100;
        starter[i] = selected && this.apu === 'ready' && n2 < CRANK_CUTOUT;
        // The crank switch is held by a solenoid that lets go at the cut-out speed.
        if (selected && (n2 >= CRANK_CUTOUT || this.apu !== 'ready')) c.set('engineCrank', 1);
      }
    }

    // ---- flight control switches ----
    const law = ac.controlLaw;
    if (law instanceof Fa18Fcs) {
      law.paddle = c.get('gLimiterOverride') >= 0.5;
      law.spinSwitch = c.get('spinRecovery') === 1;
    }
    if (this.pressed(ac, 'takeoffTrim') && t.onGround) ac.controls.pitchTrim = TAKEOFF_TRIM;

    // ---- nosewheel steering: low gain on the ground, high while the button is held ----
    const nwsButton = c.get('nosewheelSteering') >= 0.5;
    if (this.pressed(ac, 'nosewheelSteering')) this.nwsEngaged = true;
    if (this.pressed(ac, 'apDisconnect') && t.onGround) this.nwsEngaged = false;
    this.last.set('nosewheelSteering', c.get('nosewheelSteering'));
    this.nws = !this.nwsEngaged || !bus ? 'off' : nwsButton ? 'high' : 'low';
    ac.steeringScale = this.nws === 'off' ? 0 : this.nws === 'high' ? NWS_HIGH : 1;

    // ---- canopy (about 6 s) and hook (2 s) ----
    const canopySel = c.get('canopy');
    if (bus && canopySel !== 1)
      this.canopy = clamp(this.canopy + (canopySel === 2 ? dt : -dt) / 6, 0, 1);
    const hookTarget = c.get('hook') === 1 ? 1 : 0;
    this.hook = clamp(this.hook + clamp(hookTarget - this.hook, -dt / 2, dt / 2), 0, 1);

    // ---- fuel dump down to bingo, from everything but the feed tanks ----
    const fuel = ac.systems.fuel;
    const bingo = c.get('bingo');
    this.dumping = c.get('fuelDump') === 1 && bus && fuel.total > bingo;
    if (this.dumping) {
      let other = 0;
      for (let k = 2; k < fuel.amount.length; k++) other += fuel.amount[k]!;
      const take = Math.min(DUMP_RATE * dt, fuel.total - bingo);
      for (let k = 0; k < fuel.amount.length; k++) {
        const share =
          other > 0 ? (k >= 2 ? fuel.amount[k]! / other : 0) : fuel.amount[k]! / fuel.total;
        fuel.amount[k] = Math.max(0, fuel.amount[k]! - take * share);
      }
    }
  }

  afterStep(dt: number, ac: FlightModel) {
    const t = ac.telemetry;
    const c = ac.cockpit;
    const s = ac.systems;
    if (dt === 0 && !t.onGround) {
      // After a reset in the air the trim solver's stabilator angle is the FCS's to hold: the
      // trim knob goes to what the FCS holds there (1 g up and away, the trimmed angle of
      // attack in the powered approach).
      const pa = ac.controls.flaps > 0.25;
      ac.controls.pitchTrim = pa
        ? clamp((t.alpha - FA18_FCS.onSpeedAlpha) / FA18_FCS.trimAlpha, -1, 1)
        : 0;
    }
    if (this.pressed(ac, 'masterCaution')) this.peakG = t.loadFactor;
    if (!t.onGround) this.peakG = Math.max(this.peakG, t.loadFactor);

    // ---- environment and oxygen ----
    const running = ac.engines.some((e) => e.running && (e.telemetry.n2 ?? 0) > 55);
    const pressure = isa(t.altitude).pressure;
    const outside = pressureAltitude(pressure);
    this.cabinAltitude =
      running && c.get('cabinPressure') === 0 && this.canopy > 0.99
        ? cabinAltitudeFor(pressure)
        : outside;
    this.oxygen = running && c.get('oxygen') === 1;

    const av = t.avionics;
    if (!av) return;
    const h = this.hud;
    av.fa18 = h;
    const law = ac.controlLaw instanceof Fa18Fcs ? ac.controlLaw : undefined;
    h.flightPath = Math.atan2(t.verticalSpeed, Math.max(t.groundSpeed, 1));
    h.drift = wrap180(t.trackDeg - t.headingDeg) * DEG;
    h.alpha = t.alpha;
    const a = t.alpha / DEG;
    h.onSpeed =
      t.gear < 0.99 || t.onGround
        ? undefined
        : a < 6.9
          ? 'fast'
          : a < 7.4
            ? 'slightlyFast'
            : a <= 8.8
              ? 'onSpeed'
              : a <= 9.3
                ? 'slightlySlow'
                : 'slow';
    h.g = t.loadFactor;
    h.peakG = this.peakG;
    h.mach = t.mach ?? 0;
    const ins = t.instruments;
    h.airspeed = ins?.airspeed ?? t.ias;
    h.altitude = ins?.altitude ?? t.altitude;
    h.radarAltitude =
      t.agl !== undefined &&
      t.agl < RADAR_RANGE &&
      Math.abs(t.bank) < 60 * DEG &&
      Math.abs(t.pitch) < 60 * DEG
        ? t.agl
        : undefined;
    h.radarAltitudeShown = c.get('hudAltitude') === 1 && h.radarAltitude !== undefined;
    h.verticalVelocity = t.verticalSpeed;
    h.bank = t.bank;
    h.pitch = t.pitch;
    h.heading = ins?.heading ?? t.headingDeg;

    // ---- steering to the selected source ----
    const src = c.get('navSource');
    const st = h.steering;
    if (src === 1) {
      const g = av.gps;
      st.source = 'wypt';
      st.valid = g.active >= 0 && g.distanceNm !== undefined;
      st.bearing = g.bearing;
      st.rangeNm = g.distanceNm;
      st.minutes =
        g.distanceNm !== undefined && g.groundSpeedKt > 30
          ? (g.distanceNm / g.groundSpeedKt) * 60
          : undefined;
    } else {
      const n = src === 2 ? av.nav2 : av.nav1;
      st.source = src === 2 ? 'tacan' : 'ils';
      st.valid = n.valid;
      st.bearing = n.bearing;
      const sameDme = av.dme.source === (src === 2 ? 'nav2' : 'nav1');
      st.rangeNm = sameDme ? av.dme.distanceNm : undefined;
      st.minutes = sameDme ? av.dme.minutes : undefined;
    }
    const ilsOn = c.get('ilsOn') === 1 && av.nav1.valid && av.nav1.localizer;
    h.ils.localizer = ilsOn ? av.nav1.deviation : undefined;
    h.ils.glideSlope = ilsOn ? av.nav1.glideSlope : undefined;

    // ---- configuration ----
    const flapIndex = Math.round(clamp(ac.controls.flaps, 0, 1) * 2);
    h.flapMode = FLAP_MODES[flapIndex] ?? 'auto';
    h.trailingEdgeFlap = law?.tef ?? 0;
    h.leadingEdgeFlap = law?.lef ?? 0;
    h.gear = t.gear >= 0.999 ? 'down' : t.gear <= 0.001 ? 'up' : 'transit';
    const m = law?.mode ?? 'ua';
    h.fcsMode = m === 'ground' ? (flapIndex > 0 ? 'pa' : 'ua') : m;
    h.gLimit = law?.gLimit ?? FA18_FCS.gLimit;

    // ---- fuel ----
    h.fuel = s.fuel.total;
    h.bingoSetting = c.get('bingo');
    h.bingo = h.fuel < h.bingoSetting;
    h.apu = this.apu;
    h.canopy = this.canopy;
    h.hook = this.hook;
    h.cabinAltitude = this.cabinAltitude;
    h.oxygen = this.oxygen;
    h.nosewheelSteering = this.nws;
    h.antiSkid = c.get('antiSkid') === 1;
    h.fuelDumping = this.dumping;

    // ---- cautions and advisories (plain text, as on the left DDI) ----
    const cautions = h.cautions;
    const adv = h.advisories;
    cautions.length = 0;
    adv.length = 0;
    const st2 = s.telemetry;
    const powered = s.electrical.busPowered;
    if (powered) {
      const gens = st2.annunciators.generators ?? [];
      if (gens[0]) cautions.push('L GEN');
      if (gens[1]) cautions.push('R GEN');
      const hyd = st2.hydraulics ?? [];
      if ((hyd[0] ?? 0) < 1500) cautions.push('HYD 1');
      if ((hyd[1] ?? 0) < 1500) cautions.push('HYD 2');
      if (st2.annunciators.lowFuelLeft || st2.annunciators.lowFuelRight) cautions.push('FUEL LO');
      if (h.bingo) cautions.push('BINGO');
      ac.engines.forEach((e, i) => {
        const side = i === 0 ? 'L' : 'R';
        if (!e.running && !t.onGround) cautions.push(`${side} ENG OUT`);
        if (e.running && (e.telemetry.oilPressure ?? 0) < 12) cautions.push(`${side} OIL PR`);
      });
      if (this.canopy < 0.99) cautions.push('CANOPY');
      if (m === 'spin') cautions.push('SPIN');
      if (!this.oxygen && !t.onGround) cautions.push('OBOGS');
      if (this.cabinAltitude > 23_000 * FT) cautions.push('CABIN ALT');
      if (c.get('antiSkid') !== 1) cautions.push('ANTI SKID');
      if (h.flapMode !== 'auto' && t.ias > 250 * KT) cautions.push('FLAPS');
      if (t.gear > 0.001 && t.gear < 0.999) adv.push('GEAR');
      if ((t.speedbrake ?? 0) > 0.02) adv.push('SPD BRK');
      if (this.hook > 0.02) adv.push('HOOK');
      if (this.apu !== 'off') adv.push('APU');
      if (this.dumping) adv.push('DUMP');
      if (c.get('launchBar') === 1) adv.push('LAUNCH BAR');
      if (this.nws === 'high') adv.push('NWS HI');
      if (law?.paddle) adv.push('G LIM OVRD');
    } else cautions.push('BATT SW');
    if (m === 'mech') cautions.push('FCS');
    const ann = av.autopilot.annunciations;
    h.modes.length = 0;
    if (ann) for (const x of ann) h.modes.push(x);
  }
}
