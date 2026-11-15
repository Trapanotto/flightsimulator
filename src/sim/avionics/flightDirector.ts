/**
 * A two-axis autopilot with flight director and yaw damper in the manner of the PC-12 NG's
 * (Honeywell Primus Apex): ROL, HDG, NAV and APR laterally; PIT, VS, FLC, ALT and GS
 * vertically, with altitude preselect (ALTS arms by itself whenever the selected altitude
 * lies ahead of the climb or descent) and go-around. The flight director computes its
 * commands whenever its bars are on; the autopilot flies them when engaged. Engaging the
 * autopilot also engages the flight director and the yaw damper.
 *
 * Like the KAP 140 it knows the aircraft only through its sensors and the pilot's
 * instruments, and it flies pitch through a pitch servo with the trim servo unloading it.
 */
import type { AutopilotCommand, AutopilotTelemetry, AvionicsInput } from '../avionicsTypes';
import type { LateralGuidance, VerticalGuidance } from './autopilot';
import type { AutopilotComputer, AutopilotContext } from './config';
import { DEG, FPM, FT, KT, wrap180, wrap360 } from './geo';

/** Steps of the pitch wheel: vertical speed, airspeed and pitch attitude. */
export const FD_VS_STEP_FPM = 100;
export const FD_SPEED_STEP_KT = 1;
export const FD_PITCH_STEP_DEG = 0.5;
export const FD_DISCONNECT_WARNING_S = 2;

export interface FlightDirectorConfig {
  /** Bank per degree of heading error, the largest bank, and the bank command's slew, deg/s. */
  headingGain: number;
  maxBank: number;
  rollRate: number;
  /** Course laws as the KAP 140's: metres off course per radian of intercept, intercept limits. */
  navDistance: number;
  aprDistance: number;
  navIntercept: number;
  aprIntercept: number;
  /** Seconds the vertical speed takes to settle in ALT and on the glide slope; ALT's largest correction, ft/min. */
  altTimeConstant: number;
  gsTimeConstant: number;
  altMaxVs: number;
  /** Pitch per m/s of vertical speed error at 100 kt (scaled with speed), deg. */
  vsGain: number;
  /** FLC: pitch per knot of speed error, and its integral, per second. */
  flcGain: number;
  flcIntegral: number;
  /** Servos: authority (ControlInput units), trim rate (per s), loop gains per rad and per rad/s. */
  pitchAuthority: number;
  trimRate: number;
  pitchGain: number;
  pitchDamping: number;
  rollAuthority: number;
  rollGain: number;
  rollDamping: number;
  /** Pitch attitude limits and the go-around pitch, degrees. */
  pitchUp: number;
  pitchDown: number;
  goAroundPitch: number;
  /** Largest selectable vertical speed, ft/min; airspeed protection, kt. */
  maxVs: number;
  minSpeed: number;
  maxSpeed: number;
  /** Firm pilot input (ControlInput units) held this long (s) disconnects. */
  overrideInput: number;
  overrideTime: number;
}

/** Tuning for the PC-12 NG. */
export const PC12_FLIGHT_DIRECTOR: FlightDirectorConfig = {
  headingGain: 1.5,
  maxBank: 25,
  rollRate: 6,
  navDistance: 2500,
  aprDistance: 900,
  navIntercept: 45,
  aprIntercept: 30,
  altTimeConstant: 8,
  gsTimeConstant: 5,
  altMaxVs: 1000,
  vsGain: 0.6,
  flcGain: 0.25,
  flcIntegral: 0.04,
  pitchAuthority: 0.3,
  trimRate: 0.08,
  pitchGain: 2.5,
  pitchDamping: 0.8,
  rollAuthority: 0.5,
  rollGain: 2.0,
  rollDamping: 0.4,
  pitchUp: 20,
  pitchDown: -15,
  goAroundPitch: 10,
  maxVs: 4000,
  minSpeed: 90,
  maxSpeed: 235,
  overrideInput: 0.4,
  overrideTime: 0.25,
};

export class FlightDirectorAutopilot implements AutopilotComputer {
  readonly telemetry: AutopilotTelemetry = {
    engaged: false,
    lateral: 'roll',
    lateralArmed: undefined,
    vertical: 'pitch',
    verticalArmed: undefined,
    selectedAltitude: 0,
    selectedVerticalSpeed: 0,
    disconnectWarning: false,
    yawDamper: false,
    flightDirector: undefined,
    selectedSpeed: 0,
    goAround: false,
  };
  private readonly config: FlightDirectorConfig;
  private readonly bars = { pitch: 0, bank: 0 };
  private readonly out: AutopilotCommand = { roll: 0, pitch: 0, pitchTrim: 0 };
  private fd = false;
  private targetAltitude = 0;
  private gsArmed = false;
  private bankCommand = 0;
  private rollIntegral = 0;
  private lastBank = NaN;
  private lastPitch = NaN;
  private rollRate = 0;
  private pitchRate = 0;
  private pitchBase = 0;
  private pitchReference = 0;
  private trim = 0;
  private windCorrection = 0;
  private frozenHeading = 0;
  private warning = 0;
  private override = 0;

  constructor(config: Partial<FlightDirectorConfig> = {}) {
    this.config = { ...PC12_FLIGHT_DIRECTOR, ...config };
  }

  get command(): AutopilotCommand | undefined {
    return this.telemetry.engaged ? this.out : undefined;
  }

  reset() {
    const t = this.telemetry;
    t.engaged = false;
    t.lateral = 'roll';
    t.lateralArmed = undefined;
    t.vertical = 'pitch';
    t.verticalArmed = undefined;
    t.selectedVerticalSpeed = 0;
    t.selectedSpeed = 0;
    t.disconnectWarning = false;
    t.yawDamper = false;
    t.flightDirector = undefined;
    t.goAround = false;
    this.fd = false;
    this.gsArmed = false;
    this.warning = 0;
    this.override = 0;
    this.lastBank = NaN;
    this.lastPitch = NaN;
    this.rollRate = 0;
    this.pitchRate = 0;
  }

  step(dt: number, ctx: AutopilotContext) {
    const t = this.telemetry;
    const c = this.config;
    const input = ctx.input;
    const cockpit = ctx.cockpit;
    t.selectedAltitude = cockpit.get('apAltitude');
    this.warning = Math.max(0, this.warning - dt);
    this.trackRates(dt, input);
    if (!input.powered) {
      if (t.engaged) this.disconnect(false);
      this.fd = false;
      t.yawDamper = false;
      t.goAround = false;
    } else {
      if (ctx.pressed('headingSync'))
        cockpit.set('headingBug', Math.round(wrap360(input.indicatedHeading)) % 360);
      if (ctx.pressed('yawDamper')) t.yawDamper = !t.yawDamper;
      if (ctx.pressed('flightDirector')) {
        if (this.fd && !t.engaged) this.fd = false;
        else if (!this.fd) this.activate(input, cockpit.get('trim'));
      }
      if (ctx.pressed('goAround')) this.goAround(input);
      if (t.engaged) {
        const firm =
          Math.abs(input.pilotPitch) > c.overrideInput ||
          Math.abs(input.pilotRoll) > c.overrideInput;
        this.override = firm ? this.override + dt : 0;
        if (
          ctx.pressed('apEngage') ||
          ctx.pressed('apDisconnect') ||
          this.override >= c.overrideTime
        )
          this.disconnect(true);
      } else if (ctx.pressed('apEngage') && !input.onGround) {
        if (!this.fd) this.activate(input, cockpit.get('trim'));
        t.engaged = true;
        t.yawDamper = true;
        t.goAround = false;
        this.trim = cockpit.get('trim');
        this.override = 0;
        this.rollIntegral = 0;
      }
      if (t.engaged || this.fd) {
        this.buttons(ctx);
        this.lateralModes(ctx.lateral, input);
        this.verticalModes(input, ctx.vertical, t.selectedAltitude);
        this.flyLateral(dt, input, cockpit.get('headingBug'), ctx.lateral);
        this.flyVertical(dt, input, ctx.vertical);
      }
    }
    t.disconnectWarning = this.warning > 0;
    t.flightDirector = this.fd || t.engaged ? this.bars : undefined;
    t.verticalArmed = this.gsArmed ? 'gs' : this.altitudeArmed(input) ? 'alt' : undefined;
  }

  /** Bars on: ROL and PIT synchronised to the attitude flown. */
  private activate(input: AvionicsInput, trim: number) {
    const t = this.telemetry;
    this.fd = true;
    t.lateral = 'roll';
    t.lateralArmed = undefined;
    t.vertical = 'pitch';
    this.gsArmed = false;
    this.pitchReference = input.pitch / DEG;
    this.pitchBase = input.pitch / DEG;
    this.bankCommand = 0;
    this.trim = trim;
    this.out.pitchTrim = trim;
    t.selectedSpeed = Math.round(input.ias / KT);
    t.selectedVerticalSpeed =
      Math.round(input.verticalSpeed / FPM / FD_VS_STEP_FPM) * FD_VS_STEP_FPM;
  }

  /** Go-around: the autopilot lets go, the bars show wings level and the go-around pitch. */
  private goAround(input: AvionicsInput) {
    const t = this.telemetry;
    if (t.engaged) this.disconnect(true);
    if (!this.fd) this.activate(input, this.trim);
    t.goAround = true;
    t.lateral = 'roll';
    t.lateralArmed = undefined;
    t.vertical = 'pitch';
    this.gsArmed = false;
    this.pitchReference = this.config.goAroundPitch;
  }

  private disconnect(warn: boolean) {
    const t = this.telemetry;
    t.engaged = false;
    this.override = 0;
    if (warn) this.warning = FD_DISCONNECT_WARNING_S;
  }

  private buttons(ctx: AutopilotContext) {
    const t = this.telemetry;
    const input = ctx.input;
    const pressed = ctx.pressed;
    const leaveGa = () => {
      t.goAround = false;
    };
    if (pressed('apHdg')) {
      leaveGa();
      if (t.lateral === 'hdg') t.lateral = 'roll';
      else {
        if (t.lateral === 'nav' || t.lateral === 'apr') {
          t.lateralArmed = undefined;
          this.gsArmed = false;
        }
        t.lateral = 'hdg';
      }
    }
    if (pressed('apNav')) {
      leaveGa();
      this.toggleCourseMode('nav');
    }
    if (pressed('apApr')) {
      leaveGa();
      this.toggleCourseMode('apr');
    }
    if (pressed('apAlt')) {
      leaveGa();
      if (t.vertical === 'alt') this.toPitch(input);
      else {
        t.vertical = 'alt';
        this.targetAltitude = input.indicatedAltitude / FT;
      }
    }
    if (pressed('apVs')) {
      leaveGa();
      if (t.vertical === 'vs') this.toPitch(input);
      else {
        t.vertical = 'vs';
        t.selectedVerticalSpeed = this.clampVs(
          Math.round(input.verticalSpeed / FPM / FD_VS_STEP_FPM) * FD_VS_STEP_FPM,
        );
      }
    }
    if (pressed('apFlc')) {
      leaveGa();
      if (t.vertical === 'flc') this.toPitch(input);
      else {
        t.vertical = 'flc';
        t.selectedSpeed = Math.round(input.ias / KT);
        this.pitchBase = input.pitch / DEG;
      }
    }
    const up = pressed('apVsUp');
    const down = pressed('apVsDown');
    if (up || down) {
      const sign = up ? 1 : -1;
      if (t.vertical === 'vs')
        t.selectedVerticalSpeed = this.clampVs(t.selectedVerticalSpeed + sign * FD_VS_STEP_FPM);
      // The wheel rolled up in FLC asks for less speed: the nose goes up.
      else if (t.vertical === 'flc')
        t.selectedSpeed = (t.selectedSpeed ?? 0) - sign * FD_SPEED_STEP_KT;
      else if (t.vertical === 'pitch') this.pitchReference += sign * FD_PITCH_STEP_DEG;
    }
  }

  private toPitch(input: AvionicsInput) {
    this.telemetry.vertical = 'pitch';
    this.pitchReference = input.pitch / DEG;
  }

  private toggleCourseMode(mode: 'nav' | 'apr') {
    const t = this.telemetry;
    if (t.lateral === mode || t.lateralArmed === mode) {
      if (t.lateral === mode) t.lateral = 'roll';
      t.lateralArmed = undefined;
      if (mode === 'apr') {
        this.gsArmed = false;
        if (t.vertical === 'gs') t.vertical = 'alt';
      }
      return;
    }
    if (t.lateral === 'nav' || t.lateral === 'apr') t.lateral = 'roll';
    t.lateralArmed = mode;
    this.gsArmed = mode === 'apr';
  }

  private clampVs(fpm: number) {
    return Math.max(-this.config.maxVs, Math.min(this.config.maxVs, fpm));
  }

  /** ALTS: the selected altitude lies ahead of the climb or descent being flown. */
  private altitudeArmed(input: AvionicsInput): boolean {
    const t = this.telemetry;
    if (!(t.engaged || this.fd) || t.goAround) return false;
    if (t.vertical === 'alt' || t.vertical === 'gs') return false;
    const toGo = t.selectedAltitude - input.indicatedAltitude / FT;
    const vs = input.verticalSpeed / FPM;
    return Math.abs(toGo) > 50 && Math.sign(toGo) === Math.sign(vs) && Math.abs(vs) > 100;
  }

  private courseHeading(g: LateralGuidance, mode: 'nav' | 'apr', withWind: boolean): number {
    const c = this.config;
    const distance = mode === 'apr' ? c.aprDistance : c.navDistance;
    const limit = mode === 'apr' ? c.aprIntercept : c.navIntercept;
    const intercept = Math.max(-limit, Math.min(limit, g.offset / distance / DEG));
    return g.course + intercept + (withWind ? this.windCorrection : 0);
  }

  private lateralModes(g: LateralGuidance, input: AvionicsInput) {
    const t = this.telemetry;
    const armed = t.lateralArmed;
    if (armed && g.valid && !g.frozen) {
      const intercept = Math.abs(
        wrap180(this.courseHeading(g, armed, false) - input.indicatedHeading),
      );
      if (Math.abs(g.needle) < 0.25 || (Math.abs(g.needle) < 0.95 && intercept < 10)) {
        t.lateral = armed;
        t.lateralArmed = undefined;
        this.windCorrection = 0;
      }
    }
    if ((t.lateral === 'nav' || t.lateral === 'apr') && !g.valid) {
      t.lateral = 'roll';
      this.gsArmed = false;
    }
  }

  private verticalModes(input: AvionicsInput, g: VerticalGuidance, selected: number) {
    const t = this.telemetry;
    const altitude = input.indicatedAltitude / FT;
    if (this.gsArmed && t.lateral === 'apr' && g.valid && g.needle < 0.1 && g.needle > -0.5) {
      t.vertical = 'gs';
      this.gsArmed = false;
    }
    if (t.vertical === 'gs' && !g.valid) {
      t.vertical = 'alt';
      this.targetAltitude = altitude;
    }
    if (this.altitudeArmed(input)) {
      const vs = input.verticalSpeed / FPM;
      const toGo = selected - altitude;
      // Level off where ALT's own law asks for the vertical speed now flown.
      const lead = (Math.abs(vs) * this.config.altTimeConstant) / 60;
      if (Math.abs(toGo) <= lead + 20) {
        t.vertical = 'alt';
        this.targetAltitude = selected;
      }
    }
  }

  private flyLateral(dt: number, input: AvionicsInput, bug: number, g: LateralGuidance) {
    const t = this.telemetry;
    const c = this.config;
    const heading = input.indicatedHeading;
    let bank = 0;
    if (t.lateral === 'hdg') bank = c.headingGain * wrap180(bug - heading);
    else if (t.lateral === 'nav' || t.lateral === 'apr') {
      if (g.frozen) bank = c.headingGain * wrap180(this.frozenHeading - heading);
      else {
        const distance = t.lateral === 'apr' ? c.aprDistance : c.navDistance;
        const limit = t.lateral === 'apr' ? c.aprIntercept : c.navIntercept;
        const angle = g.offset / distance / DEG;
        if (Math.abs(angle) < limit / 3) {
          const learn = t.lateral === 'apr' ? 40 : 60;
          this.windCorrection = Math.max(
            -30,
            Math.min(30, this.windCorrection + (angle / learn) * dt),
          );
        }
        const target = this.courseHeading(g, t.lateral, true);
        this.frozenHeading = target;
        bank = c.headingGain * wrap180(target - heading);
      }
    } else if (t.lateralArmed && g.valid && !g.frozen) {
      const side = g.offset >= 0 ? 1 : -1;
      bank = c.headingGain * wrap180(g.course + side * c.navIntercept - heading);
    }
    bank = Math.max(-c.maxBank, Math.min(c.maxBank, bank));
    const slew = c.rollRate * dt;
    this.bankCommand += Math.max(-slew, Math.min(slew, bank - this.bankCommand));
    this.bars.bank = this.bankCommand * DEG;
    const error = (this.bankCommand - input.bank / DEG) * DEG;
    if (t.engaged)
      this.rollIntegral = Math.max(-0.2, Math.min(0.2, this.rollIntegral + 0.3 * error * dt));
    const roll = c.rollGain * error - c.rollDamping * this.rollRate + this.rollIntegral;
    this.out.roll = Math.max(-c.rollAuthority, Math.min(c.rollAuthority, roll));
  }

  private flyVertical(dt: number, input: AvionicsInput, g: VerticalGuidance) {
    const t = this.telemetry;
    const c = this.config;
    const altitude = input.indicatedAltitude / FT;
    const kias = input.ias / KT;
    // Pitch per m/s of vertical speed falls with airspeed: a fixed flight path angle change.
    const k = (c.vsGain * 100) / Math.max(kias, 60);
    let command: number;
    if (t.vertical === 'pitch') command = this.pitchReference;
    else if (t.vertical === 'flc') {
      // Too fast: raise the nose.
      const e = kias - (t.selectedSpeed ?? kias);
      this.pitchBase += c.flcIntegral * e * dt;
      this.pitchBase = Math.max(c.pitchDown, Math.min(c.pitchUp, this.pitchBase));
      command = this.pitchBase + c.flcGain * e;
    } else {
      let vs: number;
      if (t.vertical === 'alt') {
        vs = ((this.targetAltitude - altitude) * 60) / c.altTimeConstant;
        vs = Math.max(-c.altMaxVs, Math.min(c.altMaxVs, vs));
      } else if (t.vertical === 'gs') {
        const along = -input.groundSpeed * Math.tan(g.angleDeg * DEG);
        const correction = Math.max(-1.5, Math.min(1.5, -g.heightError / c.gsTimeConstant));
        vs = (along + correction) / FPM;
      } else vs = t.selectedVerticalSpeed;
      if (kias < c.minSpeed) vs = Math.min(vs, (kias - c.minSpeed + 5) * 100);
      if (kias > c.maxSpeed) vs = Math.max(vs, -(c.maxSpeed + 10 - kias) * 100);
      const vsError = vs * FPM - input.verticalSpeed;
      this.pitchBase += 0.4 * k * vsError * dt;
      this.pitchBase = Math.max(c.pitchDown, Math.min(c.pitchUp, this.pitchBase));
      command = this.pitchBase + k * vsError;
    }
    // In PIT the other modes' integrator follows the attitude, so a switch starts from it.
    if (t.vertical === 'pitch') this.pitchBase = input.pitch / DEG;
    command = Math.max(c.pitchDown, Math.min(c.pitchUp, command));
    this.bars.pitch = command * DEG;
    const error = (command - input.pitch / DEG) * DEG;
    const servo = Math.max(
      -c.pitchAuthority,
      Math.min(c.pitchAuthority, c.pitchGain * error - c.pitchDamping * this.pitchRate),
    );
    if (t.engaged) {
      const trimRate = Math.max(-c.trimRate, Math.min(c.trimRate, 0.8 * servo));
      this.trim = Math.max(-1, Math.min(1, this.trim + trimRate * dt));
    }
    this.out.pitch = servo;
    this.out.pitchTrim = this.trim;
  }

  private trackRates(dt: number, input: AvionicsInput) {
    if (Number.isNaN(this.lastBank)) {
      this.lastBank = input.bank;
      this.lastPitch = input.pitch;
    }
    const k = Math.min(1, dt / 0.05);
    let db = input.bank - this.lastBank;
    if (db > Math.PI) db -= 2 * Math.PI;
    else if (db < -Math.PI) db += 2 * Math.PI;
    this.rollRate += k * (db / dt - this.rollRate);
    this.pitchRate += k * ((input.pitch - this.lastPitch) / dt - this.pitchRate);
    this.lastBank = input.bank;
    this.lastPitch = input.pitch;
  }
}
