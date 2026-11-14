/**
 * A two-axis autopilot with altitude preselect in the manner of the Bendix/King KAP 140:
 * ROL, HDG, NAV and APR laterally; VS, ALT and GS vertically. It knows the aircraft only
 * through what its own sensors and the pilot's instruments tell it, so a toppled gyro or a
 * wrong altimeter mislead it just as they would the real one.
 *
 * Pitch is flown the way the real servo pair does it: a pitch servo with little authority
 * moves the elevator, and the trim servo runs (slowly) to take the load off it, so in steady
 * flight the trim holds the aircraft and the pitch servo sits near zero.
 */
import type { AutopilotCommand, AutopilotTelemetry, AvionicsInput } from '../avionicsTypes';
import { DEG, FPM, FT, KT, wrap180 } from './geo';

/** Step of the UP/DN buttons in VS mode, ft/min (KAP 140 Pilot's Guide). */
export const VS_STEP_FPM = 100;
/** Step of the UP/DN buttons in ALT mode, ft (KAP 140 Pilot's Guide: 20 ft per press). */
export const ALT_STEP_FT = 20;
/** Bank the lateral modes command at most, degrees (KAP 140: about 20). */
export const MAX_BANK_DEG = 20;
/** The disconnect tone sounds this long, s. */
export const DISCONNECT_WARNING_S = 2;

/** Course guidance for NAV and APR from the selected source. */
export interface LateralGuidance {
  valid: boolean;
  /** Course to fly along, degrees magnetic. */
  course: number;
  /** How far the course lies to the right, m. */
  offset: number;
  /** Indicator needle -1..1, for the capture decision. */
  needle: number;
  /** Overhead a VOR: hold the heading until the signal makes sense again. */
  frozen: boolean;
}

/** Glide slope guidance for APR. */
export interface VerticalGuidance {
  valid: boolean;
  /** Height above the glide path, m. */
  heightError: number;
  needle: number;
  angleDeg: number;
}

/** What the buttons of this step did (presses, not levels). */
export interface AutopilotButtons {
  engage: boolean;
  hdg: boolean;
  nav: boolean;
  apr: boolean;
  alt: boolean;
  up: boolean;
  down: boolean;
}

/** Tuning for one aircraft; the defaults fly the C172. */
export interface AutopilotConfig {
  /** Bank commanded per degree of heading error. */
  headingGain: number;
  /** Bank command slew, degrees per second (the roll servo's rate). */
  rollRate: number;
  /** Distance off course (m) per radian of intercept angle: NAV and APR. */
  navDistance: number;
  aprDistance: number;
  /** Largest intercept angle the course laws command, degrees. */
  navIntercept: number;
  aprIntercept: number;
  /** Seconds the vertical speed takes to settle in ALT hold and on the glide slope. */
  altTimeConstant: number;
  gsTimeConstant: number;
  /** Climb or descent ALT hold commands at most to get back, ft/min. */
  altMaxVs: number;
  /** Pitch servo authority (ControlInput units) and the trim servo's rate (per second). */
  pitchAuthority: number;
  trimRate: number;
  /** Roll servo authority, ControlInput units. */
  rollAuthority: number;
  /** Pitch attitude limits, degrees. */
  pitchUp: number;
  pitchDown: number;
  /** Selected vertical speed limits, ft/min. */
  maxVs: number;
  /**
   * Airspeed protection, knots: below `minSpeed` the climb is given up (1 ft/min per
   * `speedVs`), above `maxSpeed` the descent likewise.
   */
  minSpeed: number;
  maxSpeed: number;
  /** Firm pilot input (ControlInput units) held this long (s) disconnects. */
  overrideInput: number;
  overrideTime: number;
}

export const C172_AUTOPILOT: AutopilotConfig = {
  headingGain: 1,
  rollRate: 5,
  navDistance: 1600,
  aprDistance: 700,
  navIntercept: 45,
  aprIntercept: 30,
  altTimeConstant: 6,
  gsTimeConstant: 5,
  altMaxVs: 700,
  pitchAuthority: 0.25,
  trimRate: 0.1,
  rollAuthority: 0.5,
  pitchUp: 15,
  pitchDown: -10,
  maxVs: 1600,
  minSpeed: 65,
  maxSpeed: 140,
  overrideInput: 0.4,
  overrideTime: 0.25,
};

export class Autopilot {
  readonly telemetry: AutopilotTelemetry = {
    engaged: false,
    lateral: 'roll',
    lateralArmed: undefined,
    vertical: 'vs',
    verticalArmed: undefined,
    selectedAltitude: 0,
    selectedVerticalSpeed: 0,
    disconnectWarning: false,
  };
  readonly command: AutopilotCommand = { roll: 0, pitch: 0, pitchTrim: 0 };

  /** Altitude ALT holds, ft. */
  private targetAltitude = 0;
  private gsArmed = false;
  private bankCommand = 0;
  private rollIntegral = 0;
  private lastBank = NaN;
  private rollRate = 0;
  private lastPitch = NaN;
  private pitchRate = 0;
  /** Pitch attitude the vertical laws work around, degrees (integrates the VS error). */
  private pitchBase = 0;
  private trim = 0;
  /** Crab angle NAV has learnt for the wind, degrees. */
  private windCorrection = 0;
  private frozenHeading = 0;
  private warning = 0;
  private override = 0;

  constructor(private readonly config: AutopilotConfig = C172_AUTOPILOT) {}

  get engaged() {
    return this.telemetry.engaged;
  }

  reset() {
    const t = this.telemetry;
    t.engaged = false;
    t.lateral = 'roll';
    t.lateralArmed = undefined;
    t.vertical = 'vs';
    t.verticalArmed = undefined;
    t.selectedVerticalSpeed = 0;
    t.disconnectWarning = false;
    this.gsArmed = false;
    this.warning = 0;
    this.override = 0;
    this.lastBank = NaN;
    this.lastPitch = NaN;
    this.rollRate = 0;
    this.pitchRate = 0;
  }

  /**
   * @param trim the trim's present position, taken over on engagement
   */
  step(
    dt: number,
    input: AvionicsInput,
    buttons: AutopilotButtons,
    selectedAltitude: number,
    headingBug: number,
    trim: number,
    lateral: LateralGuidance,
    vertical: VerticalGuidance,
  ) {
    const t = this.telemetry;
    const c = this.config;
    t.selectedAltitude = selectedAltitude;
    this.warning = Math.max(0, this.warning - dt);
    this.trackRates(dt, input);

    if (t.engaged) {
      const firm =
        Math.abs(input.pilotPitch) > c.overrideInput || Math.abs(input.pilotRoll) > c.overrideInput;
      this.override = firm ? this.override + dt : 0;
      if (!input.powered) this.disconnect(false);
      else if (buttons.engage || this.override >= c.overrideTime) this.disconnect(true);
    } else if (buttons.engage && input.powered) {
      this.engage(input, trim);
    }
    t.disconnectWarning = this.warning > 0;
    if (!t.engaged) return;

    this.buttons(input, buttons);
    this.lateralModes(lateral, input);
    this.verticalModes(input, vertical, selectedAltitude);
    this.flyLateral(dt, input, headingBug, lateral);
    this.flyVertical(dt, input, vertical);
    t.verticalArmed = this.gsArmed
      ? 'gs'
      : this.altitudeArmed(input, selectedAltitude)
        ? 'alt'
        : undefined;
  }

  /** The selected altitude is armed while the selected vertical speed heads for it. */
  private altitudeArmed(input: AvionicsInput, selected: number): boolean {
    const t = this.telemetry;
    if (t.vertical !== 'vs' || t.selectedVerticalSpeed === 0) return false;
    return (
      Math.sign(selected - input.indicatedAltitude / FT) === Math.sign(t.selectedVerticalSpeed)
    );
  }

  private engage(input: AvionicsInput, trim: number) {
    const t = this.telemetry;
    t.engaged = true;
    t.lateral = 'roll';
    t.lateralArmed = undefined;
    t.vertical = 'vs';
    this.gsArmed = false;
    // Engages synchronised to the present vertical speed, in the display's 100 ft/min steps.
    t.selectedVerticalSpeed = this.clampVs(
      Math.round(input.verticalSpeed / FPM / VS_STEP_FPM) * VS_STEP_FPM,
    );
    this.bankCommand = input.bank / DEG;
    this.rollIntegral = 0;
    this.pitchBase = input.pitch / DEG;
    this.trim = trim;
    this.windCorrection = 0;
    this.override = 0;
    this.command.roll = 0;
    this.command.pitch = 0;
    this.command.pitchTrim = trim;
  }

  private disconnect(warn: boolean) {
    const t = this.telemetry;
    t.engaged = false;
    t.lateralArmed = undefined;
    t.verticalArmed = undefined;
    this.gsArmed = false;
    this.override = 0;
    if (warn) this.warning = DISCONNECT_WARNING_S;
  }

  private buttons(input: AvionicsInput, b: AutopilotButtons) {
    const t = this.telemetry;
    if (b.hdg) {
      if (t.lateral === 'hdg') t.lateral = 'roll';
      else {
        if (t.lateral === 'nav' || t.lateral === 'apr') {
          t.lateralArmed = undefined;
          this.gsArmed = false;
        }
        t.lateral = 'hdg';
      }
    }
    if (b.nav) this.toggleCourseMode('nav');
    if (b.apr) this.toggleCourseMode('apr');
    if (b.alt) {
      if (t.vertical === 'alt') this.toVs(input);
      else {
        t.vertical = 'alt';
        this.targetAltitude = input.indicatedAltitude / FT;
      }
    }
    if (b.up || b.down) {
      const sign = b.up ? 1 : -1;
      if (t.vertical === 'vs')
        t.selectedVerticalSpeed = this.clampVs(t.selectedVerticalSpeed + sign * VS_STEP_FPM);
      else if (t.vertical === 'alt') this.targetAltitude += sign * ALT_STEP_FT;
    }
  }

  private toggleCourseMode(mode: 'nav' | 'apr') {
    const t = this.telemetry;
    if (t.lateral === mode || t.lateralArmed === mode) {
      // Pressed again: cancelled, back to wings level.
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

  private toVs(input: AvionicsInput) {
    const t = this.telemetry;
    t.vertical = 'vs';
    t.selectedVerticalSpeed = this.clampVs(
      Math.round(input.verticalSpeed / FPM / VS_STEP_FPM) * VS_STEP_FPM,
    );
  }

  private clampVs(fpm: number) {
    return Math.max(-this.config.maxVs, Math.min(this.config.maxVs, fpm));
  }

  /** Arms turn into captures once the course comes in. */
  private lateralModes(g: LateralGuidance, input: AvionicsInput) {
    const t = this.telemetry;
    const armed = t.lateralArmed;
    if (armed && g.valid && !g.frozen) {
      const intercept = Math.abs(
        wrap180(this.courseHeading(g, armed, false) - input.indicatedHeading),
      );
      // Capture where the course law asks for no more turn than is already flown, or once
      // the needle is well in.
      if (Math.abs(g.needle) < 0.25 || (Math.abs(g.needle) < 0.95 && intercept < 10)) {
        t.lateral = armed;
        t.lateralArmed = undefined;
        this.windCorrection = 0;
      }
    }
    // A lost signal while coupled: hold what is flown, wings level, as the real one does.
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
      // Glide slope lost: hold the altitude reached rather than dive on a dead needle.
      t.vertical = 'alt';
      this.targetAltitude = altitude;
    }
    if (this.altitudeArmed(input, selected)) {
      const vs = input.verticalSpeed / FPM;
      const toGo = selected - altitude;
      // Start levelling where ALT hold's own law asks for the vertical speed now flown, so
      // the capture blends in without a bump.
      const lead = (Math.abs(vs) * this.config.altTimeConstant) / 60;
      if (Math.sign(toGo) === Math.sign(vs) && Math.abs(toGo) <= lead + 10) {
        t.vertical = 'alt';
        this.targetAltitude = selected;
      }
    }
  }

  /** The heading NAV or APR steers for the course, degrees magnetic. */
  private courseHeading(g: LateralGuidance, mode: 'nav' | 'apr', withWind: boolean): number {
    const c = this.config;
    const distance = mode === 'apr' ? c.aprDistance : c.navDistance;
    const limit = mode === 'apr' ? c.aprIntercept : c.navIntercept;
    const intercept = Math.max(-limit, Math.min(limit, g.offset / distance / DEG));
    return g.course + intercept + (withWind ? this.windCorrection : 0);
  }

  private flyLateral(dt: number, input: AvionicsInput, bug: number, g: LateralGuidance) {
    const t = this.telemetry;
    const c = this.config;
    let bank = 0;
    const heading = input.indicatedHeading;
    if (t.lateral === 'hdg') {
      bank = c.headingGain * wrap180(bug - heading);
    } else if (t.lateral === 'nav' || t.lateral === 'apr') {
      if (g.frozen) {
        bank = c.headingGain * wrap180(this.frozenHeading - heading);
      } else {
        const distance = t.lateral === 'apr' ? c.aprDistance : c.navDistance;
        const limit = t.lateral === 'apr' ? c.aprIntercept : c.navIntercept;
        const angle = g.offset / distance / DEG;
        // Learn the crab only close to the course, or the intercept itself would wind it up.
        if (Math.abs(angle) < limit / 3) {
          const learn = t.lateral === 'apr' ? 40 : 60;
          this.windCorrection += (angle / learn) * dt;
          this.windCorrection = Math.max(-30, Math.min(30, this.windCorrection));
        }
        const target = this.courseHeading(g, t.lateral, true);
        this.frozenHeading = target;
        bank = c.headingGain * wrap180(target - heading);
      }
    } else if (t.lateralArmed && t.lateral === 'roll' && g.valid && !g.frozen) {
      // Armed from ROL: turn onto a 45 degree intercept towards the course.
      const side = g.offset >= 0 ? 1 : -1;
      bank = c.headingGain * wrap180(g.course + side * c.navIntercept - heading);
    }
    bank = Math.max(-MAX_BANK_DEG, Math.min(MAX_BANK_DEG, bank));
    const slew = c.rollRate * dt;
    this.bankCommand += Math.max(-slew, Math.min(slew, bank - this.bankCommand));

    // Roll servo: proportional to the bank error, damped by the roll rate, with a slow
    // integral for the aileron the rigging and the slipstream ask for.
    const error = (this.bankCommand - input.bank / DEG) * DEG;
    this.rollIntegral = Math.max(-0.2, Math.min(0.2, this.rollIntegral + 0.3 * error * dt));
    const roll = 2.0 * error - 0.3 * this.rollRate + this.rollIntegral;
    this.command.roll = Math.max(-c.rollAuthority, Math.min(c.rollAuthority, roll));
  }

  private flyVertical(dt: number, input: AvionicsInput, g: VerticalGuidance) {
    const t = this.telemetry;
    const c = this.config;
    const altitude = input.indicatedAltitude / FT;
    let vs: number;
    if (t.vertical === 'alt') {
      vs = ((this.targetAltitude - altitude) * 60) / c.altTimeConstant;
      vs = Math.max(-c.altMaxVs, Math.min(c.altMaxVs, vs));
    } else if (t.vertical === 'gs') {
      // The descent the path asks for at this ground speed, plus a correction towards it.
      const along = -input.groundSpeed * Math.tan(g.angleDeg * DEG);
      const correction = Math.max(-1.5, Math.min(1.5, -g.heightError / c.gsTimeConstant));
      vs = (along + correction) / FPM;
    } else {
      vs = t.selectedVerticalSpeed;
    }
    const kias = input.ias / KT;
    if (kias < c.minSpeed) vs = Math.min(vs, (kias - c.minSpeed + 5) * 100);
    if (kias > c.maxSpeed) vs = Math.max(vs, -(c.maxSpeed + 15 - kias) * 100);

    const vsError = vs * FPM - input.verticalSpeed;
    // About 1 degree of pitch per m/s at these speeds; the base learns what attitude the
    // aircraft needs for the commanded vertical speed.
    this.pitchBase += 0.25 * vsError * dt;
    this.pitchBase = Math.max(c.pitchDown, Math.min(c.pitchUp, this.pitchBase));
    const pitchCommand = Math.max(c.pitchDown, Math.min(c.pitchUp, this.pitchBase + 0.6 * vsError));
    const error = (pitchCommand - input.pitch / DEG) * DEG;
    const servo = Math.max(
      -c.pitchAuthority,
      Math.min(c.pitchAuthority, 2.0 * error - 0.6 * this.pitchRate),
    );
    // The trim servo unloads the pitch servo at its own slow rate.
    const trimRate = Math.max(-c.trimRate, Math.min(c.trimRate, 0.8 * servo));
    this.trim = Math.max(-1, Math.min(1, this.trim + trimRate * dt));
    this.command.pitch = servo;
    this.command.pitchTrim = this.trim;
  }

  /** Roll and pitch rates from the attitude, low-passed: the unit has no rate gyros of its own. */
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
