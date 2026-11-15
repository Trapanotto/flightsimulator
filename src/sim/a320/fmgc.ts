/**
 * The A320's flight guidance (FMGC with the FCU) as the type's autopilot computer: two
 * autopilots, the flight directors and the autothrust, driven by the flight control unit.
 * There is no flight management computer to program: the GPS flight plan the app hands over
 * stands in for it, managed guidance follows that plan, its altitude constraints and the
 * managed speeds below.
 *
 * Modes (FCOM DSC-22_30, the subset a flight from runway to runway uses):
 * - lateral: RWY, RWY TRK, HDG (selected), NAV (managed: the GPS plan), LOC*, LOC, LAND,
 *   FLARE, ROLL OUT, GA TRK;
 * - vertical: SRS (take-off and go-around), CLB / DES (managed: open climb or descent that
 *   levels at the plan's altitude constraints), OP CLB / OP DES (selected), EXP CLB / EXP
 *   DES, V/S, ALT* and ALT (ALT CST* / ALT CST at a constraint), G/S* and G/S, LAND, FLARE,
 *   ROLL OUT;
 * - autothrust: armed with the levers at FLX or TOGA (MAN TOGA, MAN FLX), active in the CLB
 *   detent or below: THR CLB in a climb mode, THR IDLE in a descent mode, SPEED / MACH
 *   otherwise, THR LVR where the levers limit it; A.FLOOR and TOGA LK; RETARD at 10 ft in
 *   an automatic landing;
 * - speeds: managed 250 kt below 10 000 ft, 300 kt / Mach 0.78 above with the crossover;
 *   V2 + 10 in SRS; in the approach the speed of the configuration (green dot, S, F, VAPP);
 * - CAT 3 DUAL with both autopilots, the autothrust and the approach mode engaged.
 *
 * The autopilot flies through the fly-by-wire law, as the real one does: its pitch output is
 * a load factor demand and its roll output a roll rate demand, in sidestick units. While it
 * is not engaged the pilot's sidestick passes through unchanged.
 */
import type {
  AirbusTelemetry,
  AutopilotCommand,
  AutopilotTelemetry,
  AvionicsInput,
} from '../avionicsTypes';
import type { LateralGuidance, VerticalGuidance } from '../avionics/autopilot';
import type { AutopilotComputer, AutopilotContext } from '../avionics/config';
import { DEG, FPM, FT, KT, NM, wrap180, wrap360 } from '../avionics/geo';
import { clamp, lookup } from '../math';
import {
  CLIMB_RATING,
  characteristicSpeeds,
  deltaNToStick,
  newSpeeds,
  type A320Config,
} from './speeds';
import { newAirbusTelemetry } from './telemetry';

const G = 9.80665;
/** Thrust lever detents (cockpitA320.ts) and how close counts as in one. */
const CLB = 0.62;
const MCT = 0.82;
const IN_DETENT = 0.04;
const IDLE = 0.04;
/** Thrust reduction and acceleration altitude above the runway, ft (the usual default). */
const REDUCTION_FT = 1500;
const MAX_BANK = 25;
/** Climb and cruise speeds of the managed profile (a typical cost index). */
const CLIMB_KT = 300;
const CLIMB_MACH = 0.78;
const LIMIT_KT = 250;
const LIMIT_ALT_FT = 10_000;
const DT = 1 / 120;
/** Time constant of the automatic flare, s: it starts at about 40 ft on a 3° path. */
const FLARE_TAU = 3.4;
const CALLOUTS = [1000, 500, 400, 300, 200, 100, 50, 40, 30, 20, 10];
const CALLOUT_TEXT = CALLOUTS.map(String);

type Lateral =
  | ''
  | 'RWY'
  | 'RWY TRK'
  | 'HDG'
  | 'NAV'
  | 'LOC*'
  | 'LOC'
  | 'LAND'
  | 'FLARE'
  | 'ROLL OUT'
  | 'GA TRK';
type Vertical =
  | ''
  | 'SRS'
  | 'CLB'
  | 'OP CLB'
  | 'DES'
  | 'OP DES'
  | 'EXP CLB'
  | 'EXP DES'
  | 'V/S'
  | 'ALT*'
  | 'ALT'
  | 'ALT CST*'
  | 'ALT CST'
  | 'G/S*'
  | 'G/S'
  | 'LAND'
  | 'FLARE'
  | 'ROLL OUT';
type Athr = 'off' | 'armed' | 'active';
export type FmgcPhase =
  | 'preflight'
  | 'takeoff'
  | 'climb'
  | 'cruise'
  | 'descent'
  | 'approach'
  | 'goAround'
  | 'done';

const APPROACH_VERTICAL: readonly Vertical[] = ['G/S*', 'G/S', 'LAND', 'FLARE', 'ROLL OUT'];
const LANDING: readonly Vertical[] = ['LAND', 'FLARE', 'ROLL OUT'];
const OPEN: readonly Vertical[] = ['CLB', 'OP CLB', 'EXP CLB', 'DES', 'OP DES', 'EXP DES', 'V/S'];

export class A320Fmgc implements AutopilotComputer {
  readonly telemetry: AutopilotTelemetry & { airbus: AirbusTelemetry } = {
    engaged: false,
    lateral: 'roll',
    lateralArmed: undefined,
    vertical: 'pitch',
    verticalArmed: undefined,
    selectedAltitude: 0,
    selectedVerticalSpeed: 0,
    disconnectWarning: false,
    flightDirector: undefined,
    selectedSpeed: 0,
    autothrottle: { engaged: false, mode: 'off' },
    goAround: false,
    airbus: newAirbusTelemetry(),
  };
  private readonly out: AutopilotCommand = { roll: 0, pitch: 0, pitchTrim: 0 };
  private readonly bars = { pitch: 0, bank: 0 };
  private readonly speeds = newSpeeds();
  private powered = false;
  private ap1 = false;
  private ap2 = false;
  private athr: Athr = 'off';
  private floor = false;
  private togaLock = false;
  private lateral: Lateral = '';
  private vertical: Vertical = '';
  private navArmed = false;
  private locArmed = false;
  private gsArmed = false;
  private exped = false;
  private phase: FmgcPhase = 'preflight';
  private speedManaged = true;
  private headingManaged = true;
  private altitudeManaged = true;
  private machMode = false;
  private selected = 250;
  private targetVs = 0;
  private captureRate = 0;
  private altitudeTarget = 0;
  private constraint = false;
  private holdTrack = 0;
  private runwayElevation = 0;
  private goAroundSpeed = 0;
  private flareRetard = false;
  private athrLever = 0;
  private athrIntegral = 0;
  private accel = 0;
  private lastIas = NaN;
  private warning = 0;
  private override = 0;
  private callout = '';
  private calloutTimer = 0;
  private lastAgl = Infinity;
  private airTime = 0;
  private shownVs = 0;
  private readonly lastFma = ['', '', '', '', ''];
  private readonly changeTimer = [0, 0, 0, 0, 0];
  private readonly toggles = { speed: 1, heading: 1, altitude: 1 };

  get command(): AutopilotCommand | undefined {
    return this.powered ? this.out : undefined;
  }

  /** The approach is armed or flown. */
  private get approach() {
    return this.locArmed || this.gsArmed || APPROACH_VERTICAL.includes(this.vertical);
  }

  reset() {
    this.powered = false;
    this.ap1 = this.ap2 = false;
    this.athr = 'off';
    this.floor = this.togaLock = false;
    this.lateral = '';
    this.vertical = '';
    this.navArmed = this.locArmed = this.gsArmed = this.exped = false;
    this.phase = 'preflight';
    this.speedManaged = this.headingManaged = this.altitudeManaged = true;
    this.machMode = false;
    this.flareRetard = false;
    this.athrIntegral = 0;
    this.lastIas = NaN;
    this.accel = 0;
    this.warning = 0;
    this.override = 0;
    this.callout = '';
    this.calloutTimer = 0;
    this.lastAgl = Infinity;
    this.airTime = 0;
    this.lastFma.fill('');
    this.changeTimer.fill(0);
    this.toggles.speed = this.toggles.heading = this.toggles.altitude = 1;
    const t = this.telemetry;
    t.engaged = false;
    t.disconnectWarning = false;
    t.goAround = false;
    t.flightDirector = undefined;
  }

  step(dt: number, ctx: AutopilotContext) {
    const input = ctx.input;
    const cockpit = ctx.cockpit;
    const b = this.telemetry.airbus;
    const tel = input.telemetry;
    const sys = b.systems;
    this.warning = Math.max(0, this.warning - dt);
    this.calloutTimer = Math.max(0, this.calloutTimer - dt);
    if (this.calloutTimer === 0) this.callout = '';
    this.airTime = input.onGround ? 0 : this.airTime + dt;
    // The flight guidance computers run on AC (as the system computers reported it at the
    // end of the last step; before their first report, from the avionics bus alone).
    const ac = sys.grossMass > 0 ? sys.electrical.acEss : true;
    if (!(input.powered && ac)) {
      if (this.ap1 || this.ap2) this.disconnect();
      this.athr = 'off';
      this.powered = false;
      this.lateral = '';
      this.vertical = '';
      this.fill(input, ctx, false, NaN, 0, 0);
      return;
    }
    this.powered = true;
    const ias = input.ias / KT;
    if (Number.isNaN(this.lastIas)) this.lastIas = ias;
    this.accel += ((ias - this.lastIas) / dt - this.accel) * (1 - Math.exp(-dt / 1.5));
    this.lastIas = ias;
    const mach = tel?.mach ?? 0;
    const altFt = input.indicatedAltitude / FT;
    const aglFt = tel?.agl !== undefined ? tel.agl / FT : Infinity;
    const config = (b.controls.config || '0') as A320Config;
    const mass = sys.grossMass > 0 ? sys.grossMass : 60_000;
    const leverMax = Math.max(cockpit.get('throttle1'), cockpit.get('throttle2'));
    const toga = leverMax >= 0.95;
    const flx = !toga && leverMax >= MCT - IN_DETENT;
    const normalLaw = b.controls.law === 'normal';
    const fd = cockpit.get('flightDirector') === 1;
    characteristicSpeeds(
      mass,
      config,
      altFt,
      this.phase === 'takeoff' || this.phase === 'preflight',
      (tel?.gear ?? 1) > 0.01,
      mach,
      ias,
      this.speeds,
    );

    this.fcu(ctx, input, altFt);
    this.autopilotButtons(ctx, input, normalLaw && sys.adirs.aligned);
    const guiding = this.ap1 || this.ap2 || fd;

    // ---- take-off, rejected take-off, go-around ----
    if (input.onGround && this.phase !== 'takeoff' && (toga || flx)) {
      this.phase = 'takeoff';
      this.runwayElevation = altFt;
      this.holdTrack = input.indicatedHeading;
      if (this.athr === 'off') this.athr = 'armed';
      if (fd) {
        this.vertical = 'SRS';
        this.lateral = 'RWY';
        this.navArmed = this.headingManaged;
      }
    }
    if (input.onGround && this.phase === 'takeoff' && leverMax < IDLE) {
      this.phase = 'preflight';
      this.vertical = '';
      this.lateral = '';
      this.athr = 'off';
    }
    if (
      !input.onGround &&
      toga &&
      config !== '0' &&
      this.phase !== 'takeoff' &&
      this.phase !== 'goAround' &&
      (this.phase === 'approach' || this.phase === 'descent' || this.approach)
    ) {
      this.phase = 'goAround';
      this.runwayElevation = altFt - Math.min(aglFt, altFt);
      this.goAroundSpeed = Math.max(ias, this.speeds.vapp);
      this.vertical = 'SRS';
      this.lateral = 'GA TRK';
      this.holdTrack = this.magneticTrack(input);
      this.locArmed = this.gsArmed = false;
      this.navArmed = this.headingManaged;
      this.flareRetard = false;
      if (this.athr !== 'off') this.athr = 'armed';
      this.telemetry.goAround = true;
    }
    if (this.phase === 'done' && !input.onGround) this.phase = 'climb';

    // ---- autothrust ----
    if (ctx.pressed('athrDisconnect')) {
      this.athr = 'off';
      this.togaLock = this.floor = false;
    }
    if (ctx.pressed('athr')) {
      if (this.athr !== 'off') {
        this.athr = 'off';
        this.togaLock = false;
      } else this.athr = toga || flx ? 'armed' : 'active';
      this.athrIntegral = Math.min(leverMax, CLB);
    }
    if (this.athr === 'armed' && !input.onGround && leverMax <= CLB + IN_DETENT && leverMax > IDLE) {
      this.athr = 'active';
      this.athrIntegral = Math.min(leverMax, CLB);
    }
    if (this.athr === 'active' && (toga || flx) && !this.floor && !this.togaLock) this.athr = 'armed';
    if (this.athr === 'active' && leverMax <= IDLE && !this.floor && !this.togaLock) this.athr = 'off';
    // Alpha floor: take-off thrust whatever the levers say, then locked until disconnected.
    if (b.controls.alphaFloor && !input.onGround && aglFt > 100 && normalLaw) {
      this.floor = true;
      this.athr = 'active';
    } else if (this.floor) {
      this.floor = false;
      this.togaLock = true;
    }

    const target = this.speedTarget(input, altFt, ias, mach, config);
    if (guiding) {
      this.lateralModes(ctx, input, aglFt);
      this.verticalModes(ctx, input, altFt, aglFt);
    } else {
      this.lateral = '';
      this.vertical = '';
    }
    if (input.onGround && (this.lateral === 'ROLL OUT' || this.phase === 'approach') && ias < 40)
      this.phase = 'done';

    this.flyLateral(ctx, input, aglFt);
    this.flyVertical(ctx, input, altFt, aglFt, ias, target, config);
    this.flyThrust(dt, ias, target, leverMax, aglFt, altFt);
    this.out.pitchTrim = cockpit.get('trim');
    this.fill(input, ctx, true, target, mach, ias);
  }

  // ---------------------------------------------------------------------------------------

  private magneticTrack(input: AvionicsInput) {
    return input.groundSpeed > 15
      ? wrap360(input.track - input.declination)
      : input.indicatedHeading;
  }

  /**
   * The FCU. Each knob is pushed for managed and pulled for selected: by its push and pull
   * buttons, or by flipping its toggle (which the computer sets back to show the state).
   */
  private fcu(ctx: AutopilotContext, input: AvionicsInput, altFt: number) {
    const c = ctx.cockpit;
    const p = this.toggles;
    this.selected = c.get('fcuSpeed');
    const flip = (id: string, last: number, to: number) => c.get(id) === to && last !== to;
    const speedPush = ctx.pressed('fcuSpeedPush') || flip('fcuSpeedManaged', p.speed, 1);
    const speedPull = ctx.pressed('fcuSpeedPull') || flip('fcuSpeedManaged', p.speed, 0);
    const hdgPush = ctx.pressed('fcuHeadingPush') || flip('fcuHeadingManaged', p.heading, 1);
    const hdgPull = ctx.pressed('fcuHeadingPull') || flip('fcuHeadingManaged', p.heading, 0);
    const altPush = ctx.pressed('fcuAltitudePush') || flip('fcuAltitudeManaged', p.altitude, 1);
    const altPull = ctx.pressed('fcuAltitudePull') || flip('fcuAltitudeManaged', p.altitude, 0);
    const tel = input.telemetry;
    const m = tel?.mach ?? 0;
    const ias = input.ias / KT;
    if (speedPull) {
      // The window opens on the speed being flown.
      if (this.speedManaged) {
        const t = this.telemetry.airbus.speeds;
        const v = Number.isFinite(t.target) ? t.target : ias;
        c.set('fcuSpeed', this.machMode && m > 0.1 ? Math.round(((v * m) / ias) * 100) : Math.round(v));
        this.selected = c.get('fcuSpeed');
      }
      this.speedManaged = false;
    }
    if (speedPush) this.speedManaged = true;
    if (ctx.pressed('fcuMach') && m > 0.1) {
      if (!this.speedManaged)
        c.set(
          'fcuSpeed',
          this.machMode ? Math.round(((this.selected / 100) * ias) / m) : Math.round(((this.selected * m) / ias) * 100),
        );
      this.selected = c.get('fcuSpeed');
      this.machMode = !this.machMode;
    }
    if (hdgPull) {
      this.headingManaged = false;
      this.navArmed = false;
      if (!LANDING.includes(this.vertical)) {
        this.lateral = 'HDG';
        this.locArmed = false;
      }
    }
    if (hdgPush) {
      this.headingManaged = true;
      if (this.lateral !== 'NAV' && !LANDING.includes(this.vertical)) this.navArmed = true;
    }
    const sel = c.get('fcuAltitude');
    const away = Math.abs(sel - altFt) > 50;
    const free = !APPROACH_VERTICAL.includes(this.vertical) && this.vertical !== 'SRS';
    if (altPull || altPush) {
      this.altitudeManaged = altPush;
      this.exped = false;
      if (away && free) this.vertical = this.openMode(sel > altFt, altPush);
    }
    if (ctx.pressed('fcuVsPull') && free) {
      this.vertical = 'V/S';
      this.targetVs = Math.round(input.verticalSpeed / FPM / 100) * 100;
      c.set('fcuVerticalSpeed', this.targetVs);
    }
    if (ctx.pressed('fcuVsPush') && free) {
      this.vertical = 'V/S';
      this.targetVs = 0;
      c.set('fcuVerticalSpeed', 0);
    }
    if (this.vertical === 'V/S') this.targetVs = c.get('fcuVerticalSpeed');
    if (ctx.pressed('fcuExped') && free && away) {
      this.exped = !this.exped;
      this.vertical = this.exped
        ? sel > altFt
          ? 'EXP CLB'
          : 'EXP DES'
        : this.openMode(sel > altFt, this.altitudeManaged);
    }
    if (!this.vertical.startsWith('EXP')) this.exped = false;
    if (ctx.pressed('fcuLoc')) {
      this.locArmed = !this.locArmed || this.gsArmed;
      this.gsArmed = false;
    }
    if (ctx.pressed('fcuAppr')) {
      const on = !(this.gsArmed || this.vertical === 'G/S*' || this.vertical === 'G/S');
      this.locArmed = on && !['LOC*', 'LOC'].includes(this.lateral);
      this.gsArmed = on;
      if (!on && (this.vertical === 'G/S*' || this.vertical === 'G/S')) {
        this.vertical = 'V/S';
        this.targetVs = Math.round(input.verticalSpeed / FPM / 100) * 100;
      }
      if (on && this.phase !== 'preflight' && this.phase !== 'takeoff') this.phase = 'approach';
    }
    c.set('fcuSpeedManaged', this.speedManaged ? 1 : 0);
    c.set('fcuHeadingManaged', this.headingManaged ? 1 : 0);
    c.set('fcuAltitudeManaged', this.altitudeManaged ? 1 : 0);
    p.speed = this.speedManaged ? 1 : 0;
    p.heading = this.headingManaged ? 1 : 0;
    p.altitude = this.altitudeManaged ? 1 : 0;
  }

  private openMode(up: boolean, managed: boolean): Vertical {
    return up ? (managed ? 'CLB' : 'OP CLB') : managed ? 'DES' : 'OP DES';
  }

  private autopilotButtons(ctx: AutopilotContext, input: AvionicsInput, available: boolean) {
    const engageable = available && !input.onGround && this.airTime > 5;
    for (let which = 1; which <= 2; which++) {
      if (!ctx.pressed(which === 1 ? 'ap1' : 'ap2')) continue;
      const on = which === 1 ? this.ap1 : this.ap2;
      if (on) {
        if (which === 1) this.ap1 = false;
        else this.ap2 = false;
        if (!(this.ap1 || this.ap2)) this.warning = 1.5;
        continue;
      }
      if (!engageable) continue;
      // The second autopilot joins only for the approach; otherwise it takes over.
      if (which === 1) {
        this.ap1 = true;
        if (!this.approach) this.ap2 = false;
      } else {
        this.ap2 = true;
        if (!this.approach) this.ap1 = false;
      }
      if (this.lateral === '')
        this.lateral = this.headingManaged && ctx.sources.gps.lateral.valid ? 'NAV' : 'HDG';
      if (this.vertical === '') {
        this.vertical = 'V/S';
        this.targetVs = Math.round(input.verticalSpeed / FPM / 100) * 100;
        ctx.cockpit.set('fcuVerticalSpeed', this.targetVs);
      }
      this.override = 0;
    }
    if (this.ap1 || this.ap2) {
      if (ctx.pressed('apDisconnect') || !available) this.disconnect();
      // A firm sidestick input takes over (and disconnects).
      const firm = Math.abs(input.pilotPitch) > 0.5 || Math.abs(input.pilotRoll) > 0.5;
      this.override = firm ? this.override + DT : 0;
      if (this.override > 0.1) this.disconnect();
      if (this.ap1 && this.ap2 && !this.approach) this.ap2 = false;
    }
  }

  private disconnect() {
    this.ap1 = this.ap2 = false;
    this.warning = 1.5;
  }

  /** Managed or selected speed, knots IAS, kept within VLS and VMAX. */
  private speedTarget(
    input: AvionicsInput,
    altFt: number,
    ias: number,
    mach: number,
    config: A320Config,
  ) {
    const c = this.speeds;
    const machToIas = (m: number) => (mach > 0.1 ? (ias * m) / mach : Infinity);
    let target: number;
    if (this.speedManaged) {
      let useMach = false;
      switch (this.phase) {
        case 'preflight':
        case 'takeoff':
          target = this.vertical === 'SRS' || input.onGround ? c.v2 + 10 : LIMIT_KT;
          break;
        case 'goAround':
          target = this.vertical === 'SRS' ? this.goAroundSpeed : c.greenDot;
          break;
        case 'approach':
          target =
            config === '0'
              ? c.greenDot
              : config === '1'
                ? c.s
                : config === '3' || config === 'FULL'
                  ? c.vapp
                  : c.f;
          break;
        default:
          if (altFt < LIMIT_ALT_FT - 100) target = LIMIT_KT;
          else {
            const m = machToIas(CLIMB_MACH);
            useMach = m < CLIMB_KT;
            target = Math.min(CLIMB_KT, m);
          }
      }
      this.machMode = useMach;
      if (this.phase !== 'approach') target = Math.min(target, c.vmax - 5);
    } else target = this.machMode ? machToIas(this.selected / 100) : this.selected;
    if (this.vertical === 'EXP CLB') target = c.greenDot;
    if (this.vertical === 'EXP DES') target = Math.min(340, c.vmax - 5);
    if (!input.onGround) target = clamp(target, c.vls, c.vmax - 3);
    return target;
  }

  private lateralModes(ctx: AutopilotContext, input: AvionicsInput, aglFt: number) {
    const gps = ctx.sources.gps.lateral;
    const loc = ctx.sources.nav1.lateral;
    const track = this.magneticTrack(input);
    if (this.lateral === 'RWY' && !input.onGround && aglFt > 30) {
      this.lateral = 'RWY TRK';
      this.holdTrack = track;
    }
    if (this.navArmed && gps.valid && !input.onGround && aglFt > 30 && !this.lateral.startsWith('LOC')) {
      // NAV captures near the course, or at once from the take-off and go-around modes.
      if (Math.abs(gps.offset) < 3 * NM || ['', 'RWY TRK', 'GA TRK'].includes(this.lateral)) {
        this.lateral = 'NAV';
        this.navArmed = false;
      }
    }
    if (this.lateral === 'NAV' && !gps.valid) this.lateral = 'HDG';
    if (this.locArmed && loc.valid && !loc.frozen && !input.onGround) {
      const closing = Math.abs(wrap180(loc.course - track)) < 90;
      if (Math.abs(loc.needle) < 0.25 || (closing && Math.abs(loc.needle) < 0.8)) {
        this.lateral = 'LOC*';
        this.locArmed = false;
        this.navArmed = false;
        if (this.phase !== 'takeoff') this.phase = 'approach';
      }
    }
    if (this.lateral === 'LOC*' && Math.abs(loc.needle) < 0.1 && Math.abs(wrap180(loc.course - track)) < 6)
      this.lateral = 'LOC';
    if ((this.lateral === 'LOC*' || this.lateral === 'LOC') && !loc.valid) this.lateral = 'HDG';
  }

  private verticalModes(ctx: AutopilotContext, input: AvionicsInput, altFt: number, aglFt: number) {
    const sel = ctx.cockpit.get('fcuAltitude');
    const gs = ctx.sources.nav1.vertical;
    const vs = input.verticalSpeed / FPM;
    if (this.vertical === 'SRS' && !input.onGround && altFt > this.runwayElevation + REDUCTION_FT) {
      // Acceleration altitude.
      this.vertical = Math.abs(sel - altFt) < 100 ? 'ALT' : this.openMode(sel > altFt, this.altitudeManaged);
      this.altitudeTarget = sel;
      this.phase = 'climb';
      this.telemetry.goAround = false;
    }
    // Altitude constraints of the plan, in the managed modes.
    this.constraint = false;
    let levelAt = sel;
    if (['CLB', 'DES', 'ALT CST*', 'ALT CST'].includes(this.vertical)) {
      const c = this.nextConstraint(ctx, altFt, sel);
      if (c !== undefined) {
        levelAt = c;
        this.constraint = true;
      } else if (this.vertical === 'ALT CST' || this.vertical === 'ALT CST*')
        this.vertical = this.openMode(sel > altFt, true);
    }
    // Glide slope capture, from below or above.
    if (this.gsArmed && gs.valid && (this.lateral === 'LOC*' || this.lateral === 'LOC')) {
      const lead = Math.max(15, Math.abs(input.verticalSpeed) * 3);
      if (gs.heightError < lead && gs.heightError > -2 * lead) {
        this.vertical = 'G/S*';
        this.gsArmed = false;
        this.phase = 'approach';
      }
    }
    if (this.vertical === 'G/S*' && Math.abs(gs.heightError) < 4) this.vertical = 'G/S';
    if (
      (this.vertical === 'G/S' || this.vertical === 'G/S*') &&
      this.lateral === 'LOC' &&
      aglFt < 400
    ) {
      this.vertical = 'LAND';
      this.lateral = 'LAND';
    }
    if (this.vertical === 'LAND' && aglFt < Math.max(30, (-vs / 60) * FLARE_TAU)) {
      // Flare height from the sink rate.
      this.vertical = 'FLARE';
      this.lateral = 'FLARE';
    }
    if ((this.vertical === 'FLARE' || this.vertical === 'LAND') && input.onGround) {
      this.vertical = 'ROLL OUT';
      this.lateral = 'ROLL OUT';
    }
    if ((this.vertical === 'G/S' || this.vertical === 'G/S*') && !gs.valid) {
      this.vertical = 'V/S';
      this.targetVs = Math.round(vs / 100) * 100;
    }
    // Altitude capture ahead of the climb or descent.
    if (OPEN.includes(this.vertical)) {
      const toGo = levelAt - altFt;
      const lead = (Math.abs(vs) / 60) * 8;
      if (Math.sign(toGo) === Math.sign(vs) && Math.abs(vs) > 100 && Math.abs(toGo) <= lead + 30) {
        this.vertical = this.constraint ? 'ALT CST*' : 'ALT*';
        this.altitudeTarget = levelAt;
        this.captureRate = vs;
      } else if (this.vertical !== 'V/S') {
        // A climb mode never descends and a descent mode never climbs.
        if (this.vertical.includes('CLB') && toGo < -50) this.vertical = this.openMode(false, false);
        if (this.vertical.includes('DES') && toGo > 50) this.vertical = this.openMode(true, false);
      }
    }
    if (this.vertical === 'ALT*' || this.vertical === 'ALT CST*') {
      if (Math.abs(this.altitudeTarget - altFt) < 20 && Math.abs(vs) < 300)
        this.vertical = this.vertical === 'ALT*' ? 'ALT' : 'ALT CST';
      else if (!this.constraint && Math.abs(sel - this.altitudeTarget) > 50)
        this.vertical = this.openMode(sel > altFt, this.altitudeManaged);
    }
    if (this.vertical === 'ALT' && this.phase === 'climb') this.phase = 'cruise';
    if (this.vertical.includes('DES') && this.phase !== 'approach') this.phase = 'descent';
    if (this.vertical.includes('CLB') && this.phase !== 'takeoff' && this.phase !== 'goAround')
      this.phase = 'climb';
  }

  /** The next altitude of the plan between here and the FCU altitude, feet. */
  private nextConstraint(ctx: AutopilotContext, altFt: number, sel: number): number | undefined {
    const g = ctx.gps;
    if (g.active < 0) return undefined;
    const up = sel > altFt + 50;
    for (let i = g.active; i < g.plan.length; i++) {
      const a = g.plan[i]!.altitude;
      if (a === undefined) continue;
      const ft = a / FT;
      if (up && ft > altFt - 100 && ft < sel - 50) return ft;
      if (!up && ft < altFt + 100 && ft > sel + 50) return ft;
      return undefined;
    }
    return undefined;
  }

  private flyLateral(ctx: AutopilotContext, input: AvionicsInput, aglFt: number) {
    const o = this.out;
    const track = this.magneticTrack(input);
    let bank: number;
    let yaw: number | undefined;
    const course = (l: LateralGuidance, distance: number, limit: number) =>
      l.course + clamp(l.offset / distance / DEG, -limit, limit);
    const loc = ctx.sources.nav1.lateral;
    switch (this.lateral) {
      case 'HDG':
        bank = 1.5 * wrap180(ctx.cockpit.get('fcuHeading') - input.indicatedHeading);
        break;
      case 'NAV':
        bank = 2 * wrap180(course(ctx.sources.gps.lateral, 2500, 45) - track);
        break;
      case 'LOC*':
      case 'LOC':
      case 'LAND':
        bank = 2.5 * wrap180(course(loc, 700, 30) - track);
        if (this.lateral === 'LAND') bank = clamp(bank, -10, 10);
        break;
      case 'FLARE':
        bank = clamp(2 * wrap180(course(loc, 700, 10) - track), -3, 3);
        // Aligned with the runway in the flare (the de-crab).
        yaw = clamp(
          0.06 * wrap180(loc.course - input.indicatedHeading) - 0.6 * input.turnRate * DEG,
          -0.5,
          0.5,
        );
        break;
      case 'ROLL OUT':
        bank = 0;
        yaw = clamp(
          0.02 * loc.offset +
            0.12 * wrap180(loc.course - input.indicatedHeading) -
            1.5 * input.turnRate * DEG,
          -1,
          1,
        );
        break;
      case 'RWY':
        bank = 1.5 * wrap180(this.holdTrack - input.indicatedHeading);
        break;
      case 'RWY TRK':
      case 'GA TRK':
        bank = 1.5 * wrap180(this.holdTrack - track);
        break;
      default:
        bank = input.bank / DEG;
    }
    bank = clamp(bank, -MAX_BANK, MAX_BANK);
    if (this.lateral === 'RWY' || aglFt < 30) bank = clamp(bank, -5, 5);
    this.bars.bank = bank * DEG;
    if (this.ap1 || this.ap2) {
      // A roll rate demand of at most 5°/s; the law turns it into aileron.
      const rate = clamp(0.5 * (bank - input.bank / DEG), -5, 5);
      o.roll = input.onGround ? 0 : rate / 15;
      o.yaw = yaw;
    } else {
      o.roll = input.pilotRoll;
      o.yaw = undefined;
    }
  }

  private flyVertical(
    ctx: AutopilotContext,
    input: AvionicsInput,
    altFt: number,
    aglFt: number,
    ias: number,
    target: number,
    config: A320Config,
  ) {
    const o = this.out;
    const tas = Math.max(input.telemetry?.tas ?? input.ias, 30);
    const gamma = Math.asin(clamp(input.verticalSpeed / tas, -1, 1));
    const pitch = input.pitch;
    const path = (fpm: number) => Math.asin(clamp((fpm * FPM) / tas, -0.3, 0.3));
    let gammaCmd = gamma;
    let tau = 3;
    let limitN = 0.15;
    let feedForward = 0;
    switch (this.vertical) {
      case 'SRS':
      case 'CLB':
      case 'OP CLB':
      case 'EXP CLB':
      case 'DES':
      case 'OP DES':
      case 'EXP DES': {
        // Speed on the elevator: too fast, pitch up.
        const aTarget = clamp((target - ias) * 0.12, -1.2, 1.2);
        gammaCmd = gamma + (((this.accel - aTarget) * KT) / G) * 1.5;
        if (this.vertical === 'SRS' || this.vertical.includes('CLB'))
          gammaCmd = Math.max(gammaCmd, path(this.vertical === 'SRS' ? 0 : 200));
        else gammaCmd = Math.min(gammaCmd, path(-500));
        if (this.vertical === 'SRS') {
          gammaCmd = Math.min(gammaCmd, gamma + (18 * DEG - pitch));
          limitN = 0.25;
        }
        tau = 4;
        break;
      }
      case 'V/S':
        gammaCmd = path(this.targetVs);
        break;
      case 'ALT*':
      case 'ALT CST*': {
        // An exponential capture whose time constant matches the rate it started with.
        const toGo = this.altitudeTarget - altFt;
        const rate = Math.abs(this.captureRate) + 100;
        gammaCmd = path(clamp((toGo * 60) / 8, -rate, rate));
        break;
      }
      case 'ALT':
      case 'ALT CST':
        gammaCmd = path(clamp((this.altitudeTarget - altFt) * 8, -1000, 1000));
        break;
      case 'G/S*':
      case 'G/S':
      case 'LAND': {
        const gs: VerticalGuidance = ctx.sources.nav1.vertical;
        const along = -input.groundSpeed * Math.tan((gs.valid ? gs.angleDeg : 3) * DEG);
        const correction = gs.valid ? clamp(-gs.heightError / 6, -2, 2) : 0;
        gammaCmd = Math.asin(clamp((along + correction) / tas, -0.3, 0.3));
        tau = 2.5;
        break;
      }
      case 'FLARE':
        // ḣ = -h/τ - 2 ft/s: an exponential flare onto the runway, with the load factor the
        // law needs for it fed forward (d²h/dt² = -ḣ/τ).
        gammaCmd = path((-aglFt / FLARE_TAU - 2) * 60);
        feedForward = -input.verticalSpeed / FLARE_TAU / G;
        tau = 1;
        limitN = 0.3;
        break;
      default:
        gammaCmd = gamma;
    }
    this.shownVs = (Math.sin(gammaCmd) * tas) / FPM;
    const dn = clamp(((tas / G) * (gammaCmd - gamma)) / tau + feedForward, -limitN, limitN);
    this.bars.pitch = pitch + (gammaCmd - gamma);
    if (this.ap1 || this.ap2) {
      if (this.vertical === 'ROLL OUT') o.pitch = pitch > 0.5 * DEG ? -0.12 : 0;
      else o.pitch = input.onGround ? 0 : deltaNToStick(dn, config);
    } else o.pitch = input.pilotPitch;
  }

  private flyThrust(
    dt: number,
    ias: number,
    target: number,
    leverMax: number,
    aglFt: number,
    altFt: number,
  ) {
    const o = this.out;
    if (this.athr !== 'active') {
      o.throttle = undefined;
      this.athrIntegral = Math.min(leverMax, CLB);
      return;
    }
    let lever: number;
    const mode = this.thrustMode();
    if (this.floor || this.togaLock) lever = 1;
    else if (this.vertical === 'FLARE' && aglFt < 10 && !this.flareRetard) {
      this.say('RETARD');
      this.flareRetard = true;
      lever = 0;
    } else if (mode === 'THR CLB') lever = lookup(CLIMB_RATING, altFt);
    else if (mode === 'THR IDLE') lever = 0;
    else {
      // SPEED / MACH: proportional and integral on the speed, damped by the acceleration.
      const e = target - ias;
      const raw = this.athrIntegral + 0.02 * e - 0.05 * this.accel;
      if (!((raw >= leverMax && e > 0) || (raw <= 0 && e < 0)))
        this.athrIntegral = clamp(this.athrIntegral + 0.005 * e * dt, 0, Math.max(leverMax, 0.05));
      lever = raw;
    }
    if (mode !== 'SPEED' && mode !== 'MACH') this.athrIntegral = clamp(lever, 0, leverMax);
    if (!this.floor && !this.togaLock) lever = Math.min(lever, leverMax);
    this.athrLever = clamp(lever, 0, 1);
    o.throttle = this.athrLever;
  }

  private thrustMode(): string {
    if (this.floor) return 'A.FLOOR';
    if (this.togaLock) return 'TOGA LK';
    if (this.flareRetard || this.vertical === 'ROLL OUT') return 'THR IDLE';
    switch (this.vertical) {
      case 'CLB':
      case 'OP CLB':
      case 'EXP CLB':
      case 'SRS':
        return 'THR CLB';
      case 'DES':
      case 'OP DES':
      case 'EXP DES':
        return 'THR IDLE';
    }
    return this.machMode ? 'MACH' : 'SPEED';
  }

  private say(text: string) {
    this.callout = text;
    this.calloutTimer = 1;
  }

  /** The telemetry: the generic autopilot fields and the A320 block. */
  private fill(
    input: AvionicsInput,
    ctx: AutopilotContext,
    on: boolean,
    target: number,
    mach: number,
    ias: number,
  ) {
    const t = this.telemetry;
    const b = t.airbus;
    const c = ctx.cockpit;
    const engaged = this.ap1 || this.ap2;
    const fd = on && c.get('flightDirector') === 1;
    const thrust = this.athr === 'active' ? this.thrustMode() : '';
    t.engaged = engaged;
    t.disconnectWarning = this.warning > 0;
    t.selectedAltitude = c.get('fcuAltitude');
    t.selectedVerticalSpeed = this.targetVs;
    t.selectedSpeed = Number.isFinite(target) ? Math.round(target) : this.selected;
    t.selectedMach = this.machMode && ias > 1 ? (target * mach) / ias : undefined;
    const at = t.autothrottle!;
    at.engaged = this.athr === 'active';
    at.mode =
      this.athr !== 'active'
        ? 'off'
        : thrust === 'THR IDLE'
          ? 'idle'
          : thrust === 'SPEED' || thrust === 'MACH'
            ? 'speed'
            : 'thrust';
    t.lateral =
      this.lateral === 'NAV'
        ? 'nav'
        : this.lateral.startsWith('LOC') || LANDING.includes(this.vertical)
          ? 'apr'
          : this.lateral === ''
            ? 'roll'
            : 'hdg';
    t.lateralArmed = this.locArmed ? 'apr' : this.navArmed ? 'nav' : undefined;
    t.vertical = this.vertical.startsWith('ALT')
      ? 'alt'
      : this.vertical === 'V/S'
        ? 'vs'
        : APPROACH_VERTICAL.includes(this.vertical)
          ? 'gs'
          : this.vertical === 'SRS' || this.vertical === ''
            ? 'pitch'
            : 'flc';
    t.verticalArmed = this.gsArmed
      ? 'gs'
      : OPEN.includes(this.vertical) || this.vertical === 'SRS'
        ? 'alt'
        : undefined;
    t.flightDirector = fd && this.vertical !== '' ? this.bars : undefined;

    // ---- FMA ----
    const f = b.fma;
    const leverMax = Math.max(c.get('throttle1'), c.get('throttle2'));
    if (this.athr === 'armed')
      f.thrust =
        leverMax >= 0.95
          ? 'MAN TOGA'
          : leverMax >= MCT - IN_DETENT
            ? input.onGround || this.phase === 'takeoff'
              ? 'MAN FLX'
              : 'MAN MCT'
            : 'MAN THR';
    else if (this.athr === 'active')
      f.thrust =
        thrust !== 'THR IDLE' &&
        !this.floor &&
        !this.togaLock &&
        leverMax < CLB - IN_DETENT &&
        this.athrLever >= leverMax - 1e-6
          ? 'THR LVR'
          : thrust;
    else f.thrust = '';
    const aboveReduction = input.indicatedAltitude / FT > this.runwayElevation + REDUCTION_FT;
    f.thrustCaution =
      on && this.athr === 'armed' && !input.onGround && aboveReduction ? 'LVR CLB' : '';
    f.combined = LANDING.includes(this.vertical);
    f.vertical = this.vertical === 'V/S' ? `V/S ${this.targetVs >= 0 ? '+' : ''}${this.targetVs}` : this.vertical;
    f.lateral = f.combined ? this.vertical : this.lateral;
    f.verticalArmed = this.gsArmed
      ? OPEN.includes(this.vertical) || this.vertical.startsWith('ALT')
        ? 'ALT G/S'
        : 'G/S'
      : OPEN.includes(this.vertical) || this.vertical === 'SRS'
        ? 'ALT'
        : '';
    f.lateralArmed = this.locArmed ? 'LOC' : this.navArmed ? 'NAV' : '';
    f.capability = this.approach
      ? this.ap1 && this.ap2 && this.athr === 'active'
        ? 'CAT 3 DUAL'
        : engaged
          ? 'CAT 3 SINGLE'
          : fd
            ? 'CAT 1'
            : ''
      : '';
    f.minimum = f.capability === 'CAT 3 DUAL' ? 'NO DH' : f.capability === 'CAT 3 SINGLE' ? 'DH 50' : '';
    f.autopilot = this.ap1 && this.ap2 ? 'AP1+2' : this.ap1 ? 'AP1' : this.ap2 ? 'AP2' : '';
    f.flightDirectors = fd ? '1 FD 2' : '';
    f.autothrust = this.athr;
    for (let i = 0; i < 5; i++) {
      const text =
        i === 0
          ? f.thrust
          : i === 1
            ? f.vertical + f.verticalArmed
            : i === 2
              ? f.lateral + f.lateralArmed
              : i === 3
                ? f.capability
                : f.autopilot + f.flightDirectors + f.autothrust;
      if (text !== this.lastFma[i]) {
        this.lastFma[i] = text;
        this.changeTimer[i] = 10;
      } else this.changeTimer[i] = Math.max(0, this.changeTimer[i]! - DT);
      f.changed[i] = this.changeTimer[i]! > 0;
    }

    // ---- speeds ----
    const s = b.speeds;
    const k = this.speeds;
    const air = !input.onGround && on;
    const config = b.controls.config;
    s.vls = air ? k.vls : NaN;
    s.vsw = air ? k.vsw : NaN;
    s.vmax = on ? k.vmax : NaN;
    s.alphaProt = air ? k.alphaProt : NaN;
    s.alphaMax = air ? k.alphaMax : NaN;
    s.greenDot = on && config === '0' ? k.greenDot : NaN;
    s.s = on && (config === '1' || config === '1+F') ? k.s : NaN;
    s.f = on && (config === '1+F' || config === '2' || config === '3') ? k.f : NaN;
    s.vapp = on ? k.vapp : NaN;
    s.v1 = on ? k.v1 : NaN;
    s.vr = on ? k.vr : NaN;
    s.v2 = on ? k.v2 : NaN;
    s.vfeNext = air ? k.vfeNext : NaN;
    s.target = target;
    s.targetMach = this.machMode && ias > 1 ? (target * mach) / ias : NaN;
    s.managed = this.speedManaged;
    s.mach = this.machMode;
    s.trend = this.accel * 10;
    s.mass = b.systems.grossMass;

    // ---- FCU ----
    const u = b.fcu;
    u.speed = this.speedManaged ? NaN : this.selected;
    u.mach = this.machMode;
    u.heading = this.headingManaged && this.lateral === 'NAV' ? NaN : c.get('fcuHeading');
    u.altitude = c.get('fcuAltitude');
    u.verticalSpeed = this.vertical === 'V/S' ? this.targetVs : NaN;
    u.speedDot = this.speedManaged;
    u.headingDot = this.headingManaged;
    u.altitudeDot = this.altitudeManaged;
    u.loc = this.locArmed || this.lateral.startsWith('LOC');
    u.appr = this.gsArmed || APPROACH_VERTICAL.includes(this.vertical);
    u.exped = this.exped;
    u.ap1 = this.ap1;
    u.ap2 = this.ap2;
    u.athr = this.athr !== 'off';

    // ---- guidance ----
    const g = b.guidance;
    g.altitudeTarget = this.vertical.startsWith('ALT') ? this.altitudeTarget : c.get('fcuAltitude');
    g.altitudeConstraint = this.constraint;
    g.lateralTarget = this.lateral === 'HDG' ? c.get('fcuHeading') : this.holdTrack;
    g.verticalSpeedTarget = this.shownVs;
    g.phase = this.phase;
    // The radio altitude calls on the way down.
    const aglFt = input.telemetry?.agl !== undefined ? input.telemetry.agl / FT : Infinity;
    if (on && input.verticalSpeed < 0)
      for (let i = 0; i < CALLOUTS.length; i++)
        if (this.lastAgl > CALLOUTS[i]! && aglFt <= CALLOUTS[i]! && this.callout !== 'RETARD')
          this.say(CALLOUT_TEXT[i]!);
    this.lastAgl = aglFt;
    g.callout = this.callout;
  }
}
