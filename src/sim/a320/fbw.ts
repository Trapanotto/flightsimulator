/**
 * The A320's flight control laws (ELAC, SEC and FAC together), after the FCOM's description
 * of normal and direct law (DSC-27-20):
 *
 * Normal law, pitch: the sidestick asks for a load factor (C*: at low speed the pitch rate
 * weighs more); hands off, the flight path is held, corrected for bank up to 33°. The
 * trimmable stabiliser follows the elevator so the stick is always neutral (automatic
 * trim), except where a protection must not be trimmed against. Protections: load factor
 * (+2.5 / -1 g clean, +2 / 0 g with slats out), pitch attitude (30° nose up, 25° in CONF
 * FULL, 15° down), high angle of attack (from alpha prot the stick commands angle of attack,
 * full back is alpha max; alpha floor sets take-off thrust, through the flight guidance),
 * high speed (above VMO + 6 kt or MMO + 0.01 a nose-up order, the stick's nose-down
 * authority shrinks, bank limited to 45°). Flare mode below 50 ft radio height: the law
 * memorises the attitude and lowers it to -2° over 8 s, so the pilot has to flare. Ground
 * mode: stick straight to the elevator, blended into the flight law within 5 s of lift-off.
 *
 * Normal law, roll and yaw: the stick asks for a roll rate, 15°/s at full deflection; hands
 * off the bank is held up to 33° and returns to 33° beyond; 67° is the limit (45° in a
 * protection). The rudder coordinates the turn and damps the Dutch roll; the pedals and the
 * rudder trim add to it, through a travel limiter that closes with speed.
 *
 * Direct law (no air data and inertial reference, no computer power, two hydraulic systems
 * lost): stick and pedals straight to the surfaces, the stabiliser by the trim wheel.
 */
import type { ControlLawContext, SurfaceCommand } from '../controlLaw';
import type { AirbusControls } from '../avionicsTypes';
import type { AircraftDefinition } from '../definition';
import { DEG, KT, clamp, smoothstep } from '../math';
import {
  ALPHA_FLOOR,
  ALPHA_MAX,
  ALPHA_PROT,
  SLATS_FLAPS,
  VMO,
  MMO,
  type A320Config,
  loadFactorLimits,
  stickToDeltaN,
} from './speeds';
import type { SystemsState } from './systems';

const G = 9.80665;
/** C*'s crossover speed: below it the pitch rate dominates what the stick asks for, m/s. */
const V_CROSSOVER = 120;
/** Dynamic pressure the gains are tuned at, Pa (250 kt at sea level). */
const Q_REF = 10_000;
const ROLL_RATE = 15 * DEG;
const BANK_NEUTRAL = 33 * DEG;
const BANK_MAX = 67 * DEG;
const BANK_PROTECTED = 45 * DEG;
/** Thrust lever at or below this counts as idle (ground spoilers, autobrake). */
const LEVER_IDLE = 0.04;
/** Autobrake decelerations, m/s² (FCOM: LO 1.7, MED 3; MAX the maximum braking). */
export const AUTOBRAKE_DECEL = { low: 1.7, medium: 3.0, max: 6.0 } as const;
const AUTOBRAKE_MODES = ['off', 'low', 'medium', 'max'] as const;

export class FlyByWire {
  config: A320Config = '0';
  private lever = 0;
  private ths = NaN;
  private integral = 0;
  private rollIntegral = 0;
  private bankHold = 0;
  private groundBlend = 0;
  private airTime = 0;
  private groundTime = 0;
  private alphaMode = false;
  private flare = false;
  private flareTime = 0;
  private flarePitch = 0;
  private yawWashout = 0;
  private groundSpoilers = false;
  private autobrakeTimer = 0;
  private brakeIntegral = 0;
  private lastGs = 0;
  private decel = 0;
  private alphaFloor = false;
  private slatPosition = 0;
  /** The sidestick asks for alpha above alpha prot (the flight guidance's alpha floor needs it). */
  alphaFloorActive = false;

  constructor(readonly def: AircraftDefinition) {}

  reset() {
    this.config = '0';
    this.lever = -1;
    this.ths = NaN;
    this.integral = 0;
    this.rollIntegral = 0;
    this.bankHold = 0;
    this.groundBlend = 0;
    this.airTime = 0;
    this.groundTime = 0;
    this.alphaMode = false;
    this.flare = false;
    this.flareTime = 0;
    this.yawWashout = 0;
    this.groundSpoilers = false;
    this.autobrakeTimer = 0;
    this.brakeIntegral = 0;
    this.lastGs = 0;
    this.decel = 0;
    this.alphaFloor = false;
    this.alphaFloorActive = false;
  }

  step(ctx: ControlLawContext, out: SurfaceCommand, sys: SystemsState, report: AirbusControls) {
    const t = ctx.telemetry;
    const c = this.def.controls;
    const dt = ctx.dt;
    const cockpit = ctx.cockpit;
    const ias = t.ias / KT;
    const onGround = t.onGround;
    this.airTime = onGround ? 0 : this.airTime + dt;
    this.groundTime = onGround ? this.groundTime + dt : 0;
    const config = this.configuration(ctx, ias, onGround);
    const [slats, flaps] = SLATS_FLAPS[config];
    out.leadingEdge = slats * DEG;
    out.flap = flaps * DEG;

    // Which law: the computers need the inertial reference, power and two hydraulic systems.
    const hyd = (sys.green > 1500 ? 1 : 0) + (sys.blue > 1500 ? 1 : 0) + (sys.yellow > 1500 ? 1 : 0);
    const normal = sys.adirsAligned && sys.dcEssPowered && hyd >= 2;
    const law = normal ? 'normal' : 'direct';
    if (Number.isNaN(this.ths)) this.ths = this.trimWheel(ctx);

    const pitch = clamp(ctx.pitch, -1, 1);
    const roll = clamp(ctx.roll, -1, 1);
    const yaw = clamp(ctx.yaw, -1, 1);
    const apEngaged = t.avionics?.autopilot.engaged ?? false;
    const q = Math.max(ctx.q, 50);
    const gain = clamp(Q_REF / q, 0.25, 5);
    const w = ctx.state.angularVelocity;

    // ---- ground mode and its blend into the flight law ----
    const inFlight = !onGround || (this.groundBlend > 0 && this.groundTime < 0.5);
    if (onGround && this.groundTime > 0.5) this.groundBlend = Math.max(0, this.groundBlend - dt / 2);
    else if (!onGround) this.groundBlend = Math.min(1, this.groundBlend + dt / 5);
    const blend = law === 'normal' ? this.groundBlend : 0;

    let elevator: number;
    let protectedBank = false;
    report.alphaProtection = false;
    report.highSpeedProtection = false;
    report.pitchLimit = false;
    const direct = pitch >= 0 ? pitch * c.elevatorUp : pitch * c.elevatorDown;
    if (blend <= 0 || !inFlight) {
      elevator = direct;
      this.integral = direct;
      this.alphaMode = false;
      this.flare = false;
      // On the ground and in direct law the trim wheel sets the stabiliser.
      this.ths = this.trimWheel(ctx);
    } else {
      const law = this.pitchLaw(ctx, config, pitch, ias, apEngaged, gain, report);
      elevator = blend * law + (1 - blend) * direct;
      protectedBank = report.alphaProtection || report.highSpeedProtection;
      // Automatic trim: the stabiliser takes over what the elevator holds.
      const trimmable =
        blend >= 1 &&
        !this.flare &&
        (t.agl ?? 100) > 15 &&
        t.loadFactor > 0.5 &&
        Math.abs(t.bank) < BANK_NEUTRAL;
      if (trimmable) {
        let rate = clamp(0.6 * elevator, -0.7 * DEG, 0.7 * DEG);
        // Never trim nose up into alpha prot, nor nose down into the high speed protection.
        if (report.alphaProtection && rate > 0) rate = 0;
        if (report.highSpeedProtection && rate < 0) rate = 0;
        this.ths = clamp(this.ths + rate * dt, -c.trimDown, c.trimUp);
        this.integral -= rate * dt;
      }
    }
    out.elevator = clamp(elevator, -c.elevatorDown, c.elevatorUp);
    out.stabiliser = this.ths;
    // The trim wheels turn with the stabiliser.
    ctx.controls.pitchTrim = this.ths >= 0 ? this.ths / c.trimUp : this.ths / c.trimDown;

    // ---- roll ----
    if (law === 'normal' && !onGround) out.aileron = this.rollLaw(ctx, roll, protectedBank, gain, report);
    else {
      out.aileron = roll;
      this.bankHold = t.bank;
      this.rollIntegral = 0;
      report.bankLimit = false;
    }

    // ---- yaw: pedals and trim through the travel limiter, damper and coordination ----
    const limiter = 1 - (1 - 3.4 / 30) * smoothstep(160, 380, ias);
    const trim = (c.yawTrim ?? 0) * clamp(ctx.controls.yawTrim ?? 0, -1, 1);
    let rudder = yaw + trim;
    const rTurn = t.tas > 30 ? (G / t.tas) * Math.sin(t.bank) * Math.cos(t.pitch) : 0;
    this.yawWashout += (w.z - rTurn - this.yawWashout) * (1 - Math.exp(-dt / 4));
    if (law === 'normal' && !onGround && sys.green + sys.yellow > 1500) {
      const damper = clamp(-1.6 * gain * (w.z - rTurn - this.yawWashout), -0.25, 0.25);
      const coordination = clamp(1.2 * gain * t.beta, -0.3, 0.3);
      rudder += damper + coordination;
    }
    out.rudder = clamp(rudder, -limiter, limiter);
    report.rudderTrim = (trim * c.rudder) / DEG;

    // ---- spoilers: speed brake, ground spoilers ----
    out.spoilers = this.spoilers(ctx, config, ias, report);
    out.speedbrake = out.spoilers;
    out.differentialTail = 0;

    // ---- brakes and steering ----
    out.brake = this.autobrake(ctx, cockpit.get('autobrake'), report, sys);
    const gs = t.groundSpeed / KT;
    const tiller = 1 - smoothstep(20, 70, gs);
    const pedal = (6 / 75) * (1 - smoothstep(40, 130, gs));
    const steering = sys.yellow > 1500 && onGround ? yaw * Math.max(tiller, pedal) : 0;
    out.steering = steering;
    report.steering = steering * 75;

    // ---- the flight controls in the telemetry ----
    report.law = law;
    report.flareMode = this.flare;
    report.groundMode = blend < 1;
    report.config = config;
    // The slats run at the flaps' rate (the flight model moves both alike).
    const rate = (c.flapRate / DEG) * dt;
    if (sys.dcEssPowered) this.slatPosition += clamp(slats - this.slatPosition, -rate, rate);
    report.slats = this.slatPosition;
    report.flaps = (t.flaps * c.flapDetents[c.flapDetents.length - 1]!) / DEG;
    report.stabiliser = (t.stabiliser ?? 0) / DEG;
    report.spoilersArmed = cockpit.get('spoilersArmed') === 1;
    report.groundSpoilers = this.groundSpoilers;
    report.speedbrake = t.speedbrake ?? 0;
    report.alphaFloor = this.alphaFloor;
  }

  /** At a reset the slats stand where the flap lever puts them. */
  initialSlats(slats: number) {
    this.slatPosition = slats;
  }

  /** The trim wheel's stabiliser angle, rad. */
  private trimWheel(ctx: ControlLawContext) {
    const c = this.def.controls;
    const p = clamp(ctx.controls.pitchTrim, -1, 1);
    return p >= 0 ? p * c.trimUp : p * c.trimDown;
  }

  /**
   * CONF from the flap lever (FCOM DSC-27-50): position 1 selects 1+F on the ground or when
   * coming back from 2, CONF 1 in flight from 0; 1+F retracts to 1 by itself at 210 kt.
   */
  private configuration(ctx: ControlLawContext, ias: number, onGround: boolean): A320Config {
    const lever = Math.round(clamp(ctx.controls.flaps, 0, 1) * 4);
    if (lever !== this.lever) {
      const from = this.lever;
      this.lever = lever;
      if (lever === 0) this.config = '0';
      else if (lever === 1)
        this.config = onGround || from > 1 || (from < 0 && ias < 100) ? '1+F' : '1';
      else this.config = lever === 2 ? '2' : lever === 3 ? '3' : 'FULL';
    }
    if (this.config === '1+F' && ias > 210 && !onGround) this.config = '1';
    return this.config;
  }

  private pitchLaw(
    ctx: ControlLawContext,
    config: A320Config,
    stick: number,
    ias: number,
    apEngaged: boolean,
    gain: number,
    report: AirbusControls,
  ): number {
    const t = ctx.telemetry;
    const c = this.def.controls;
    const dt = ctx.dt;
    const V = Math.max(t.tas, 40);
    const theta = t.pitch;
    const phi = t.bank;
    const mach = ctx.mach;
    const [nMin, nMax] = loadFactorLimits(config);
    const cosPhi = Math.cos(Math.min(Math.abs(phi), BANK_NEUTRAL));
    const gamma = Math.asin(clamp(t.verticalSpeed / V, -1, 1));
    // Hands off: hold the flight path, corrected for bank up to 33°.
    const nRef = Math.cos(gamma) / cosPhi;
    let s = stick;

    // ---- high speed protection ----
    const overspeed = Math.max(ias - (VMO + 6), ((mach - (MMO + 0.01)) / Math.max(mach, 0.1)) * ias);
    let dnProtect = 0;
    if (overspeed > 0) {
      report.highSpeedProtection = true;
      dnProtect = clamp(0.06 * overspeed, 0, 0.6);
      if (s < 0) s *= Math.max(0.1, 1 - overspeed / 10);
    }
    let dn = stickToDeltaN(s, config) + dnProtect;

    // ---- flare mode: the attitude, lowered to -2° in 8 s, plus what the stick asks ----
    const agl = (t.agl ?? 1000) / 0.3048;
    if (!this.flare && !apEngaged && agl < 50 && t.verticalSpeed < 0 && t.gear > 0.99) {
      this.flare = true;
      this.flareTime = 0;
      this.flarePitch = theta;
    } else if (this.flare && (agl > 80 || apEngaged)) this.flare = false;
    if (this.flare) {
      this.flareTime += dt;
      const lowered = this.flarePitch - (this.flarePitch + 2 * DEG) * Math.min(1, this.flareTime / 8);
      const target = lowered + stick * 12 * DEG;
      dn = ((V / G) * (target - theta)) / 1.2;
    }

    // ---- high angle of attack: from alpha prot the stick asks for angle of attack ----
    const alpha = t.alpha;
    const prot = ALPHA_PROT[config];
    const amax = ALPHA_MAX[config];
    if (!this.alphaMode && alpha > prot && (t.agl ?? 1000) > 30) this.alphaMode = true;
    if (this.alphaMode && (stick < -0.5 || (alpha < prot - 2 * DEG && stick <= 0.05)))
      this.alphaMode = false;
    let nTarget = nRef + dn;
    // Lift per angle of attack, in g per rad: what an angle error costs in load factor.
    const mass = this.def.mass + t.fuel;
    const nAlpha = (5.2 * ctx.q * 122.6) / (mass * G);
    const alphaCmd = stick >= 0 ? prot + stick * (amax - prot) : prot + stick * prot;
    const nAlphaLimit = t.loadFactor + clamp(0.8 * nAlpha * (alphaCmd - alpha), -0.5, 0.5);
    if (this.alphaMode) {
      nTarget = nAlphaLimit;
      report.alphaProtection = true;
    } else nTarget = Math.min(nTarget, t.loadFactor + 0.8 * nAlpha * (amax - alpha));
    this.alphaFloorActive = alpha > ALPHA_FLOOR[config] && (t.agl ?? 1000) > 30;
    this.alphaFloor = this.alphaFloorActive;

    // ---- pitch attitude: 30° up (25° in CONF FULL), 15° down ----
    const up = (config === 'FULL' ? 25 : 30) * DEG;
    const down = -15 * DEG;
    if (theta > up - 5 * DEG && nTarget > Math.cos(gamma)) {
      report.pitchLimit = theta > up - 1 * DEG;
      nTarget = Math.min(nTarget, Math.cos(gamma) + ((up - theta) / (5 * DEG)) * (nTarget - Math.cos(gamma)));
    }
    if (theta < down + 5 * DEG && nTarget < Math.cos(gamma)) {
      report.pitchLimit = theta < down + 1 * DEG;
      nTarget = Math.max(nTarget, Math.cos(gamma) - ((theta - down) / (5 * DEG)) * (Math.cos(gamma) - nTarget));
    }
    nTarget = clamp(nTarget, nMin, nMax);

    // ---- C*: load factor error plus pitch rate error weighed by the crossover speed ----
    const qRef = (G / V) * (nTarget - Math.cos(theta) * Math.cos(phi));
    const e = t.loadFactor - nTarget + (V_CROSSOVER / G) * (ctx.state.angularVelocity.y - qRef);
    const kp = 0.035 * gain;
    const ki = 0.06 * gain;
    const raw = this.integral - kp * e;
    // Anti-windup: the integrator stops where the elevator does.
    if (!((raw >= c.elevatorUp && e < 0) || (raw <= -c.elevatorDown && e > 0)))
      this.integral -= ki * e * dt;
    this.integral = clamp(this.integral, -c.elevatorDown, c.elevatorUp);
    return this.integral - kp * e;
  }

  private rollLaw(
    ctx: ControlLawContext,
    stick: number,
    protectedBank: boolean,
    gain: number,
    report: AirbusControls,
  ): number {
    const t = ctx.telemetry;
    const dt = ctx.dt;
    const p = ctx.state.angularVelocity.x;
    const phi = t.bank;
    const limit = protectedBank ? BANK_PROTECTED : BANK_MAX;
    let pCmd: number;
    if (Math.abs(stick) > 0.05) {
      pCmd = stick * ROLL_RATE;
      this.bankHold = phi;
    } else {
      // Hands off: the bank is held; beyond 33° it goes back to 33°.
      if (Math.abs(this.bankHold) > BANK_NEUTRAL)
        this.bankHold -= Math.sign(this.bankHold) * Math.min(5 * DEG * dt, Math.abs(this.bankHold) - BANK_NEUTRAL);
      pCmd = clamp(1.2 * (this.bankHold - phi), -ROLL_RATE, ROLL_RATE);
    }
    // The bank limit: the roll rate falls to nothing at the limit.
    if (phi > limit - 5 * DEG && pCmd > 0) pCmd = Math.min(pCmd, 1.5 * (limit - phi));
    if (phi < -limit + 5 * DEG && pCmd < 0) pCmd = Math.max(pCmd, 1.5 * (-limit - phi));
    report.bankLimit = Math.abs(phi) > limit - 1 * DEG;
    this.bankHold = clamp(this.bankHold, -limit, limit);
    const e = pCmd - p;
    this.rollIntegral = clamp(this.rollIntegral + 0.8 * gain * e * dt, -0.4, 0.4);
    return clamp(1.1 * gain * e + this.rollIntegral, -1, 1);
  }

  /**
   * Speed brake (spoilers 2 to 4, 40° in flight: about half of all five panels' full
   * travel here), retracted by itself in CONF FULL and in alpha prot; ground spoilers at
   * touch-down when armed with the levers at idle, or on a rejected take-off above 72 kt
   * (FCOM DSC-27-10).
   */
  private spoilers(
    ctx: ControlLawContext,
    config: A320Config,
    ias: number,
    report: AirbusControls,
  ): number {
    const t = ctx.telemetry;
    const lever = ctx.controls.speedbrake ?? 0;
    const armed = ctx.cockpit.get('spoilersArmed') === 1;
    const throttles = ctx.controls.throttle;
    const idle = throttles.every((x) => x <= LEVER_IDLE);
    const reverse = ctx.controls.reverse === true;
    if (t.onGround) {
      if (!this.groundSpoilers && (idle || reverse) && ((armed && this.groundTime > 0.1) || (ias > 72 && (reverse || armed))))
        this.groundSpoilers = true;
      if (this.groundSpoilers && !idle && !reverse) this.groundSpoilers = false;
      if (this.groundSpoilers && !armed && !reverse && ias < 72 && lever < 0.1) this.groundSpoilers = false;
    } else this.groundSpoilers = false;
    if (this.groundSpoilers) return 1;
    if (t.onGround) return lever;
    const inhibited = config === 'FULL' || report.alphaProtection || this.alphaFloor;
    return inhibited ? 0 : 0.5 * clamp(lever, 0, 1);
  }

  /**
   * Autobrake: armed by its selector, it starts with the ground spoilers (LO 4 s later, MED
   * 2 s, MAX at once) and holds the selected deceleration; the pilot's pedals take over, and
   * thrust levers advanced or the selector off release it.
   */
  private autobrake(
    ctx: ControlLawContext,
    selector: number,
    report: AirbusControls,
    sys: SystemsState,
  ): number | undefined {
    const t = ctx.telemetry;
    const dt = ctx.dt;
    const mode = AUTOBRAKE_MODES[selector] ?? 'off';
    report.autobrake = mode;
    const gs = t.groundSpeed;
    // Deceleration from the ground speed, filtered over half a second.
    if (dt > 0) {
      const a = (this.lastGs - gs) / dt;
      this.decel += (a - this.decel) * (1 - Math.exp(-dt / 0.5));
    }
    this.lastGs = gs;
    report.autobrakeArmed = mode !== 'off' && sys.brakePressure > 1000;
    const pedals = Math.max(ctx.controls.brakeLeft, ctx.controls.brakeRight);
    if (!report.autobrakeArmed || pedals > 0.6 || !t.onGround || !this.groundSpoilers) {
      this.autobrakeTimer = 0;
      this.brakeIntegral = 0;
      report.autobrakeDecel = false;
      return undefined;
    }
    this.autobrakeTimer += dt;
    const delay = mode === 'low' ? 4 : mode === 'medium' ? 2 : 0;
    if (this.autobrakeTimer < delay) {
      report.autobrakeDecel = false;
      return undefined;
    }
    if (gs < 0.5) return undefined;
    const target = AUTOBRAKE_DECEL[mode as 'low' | 'medium' | 'max'];
    const e = target - this.decel;
    this.brakeIntegral = clamp(this.brakeIntegral + 0.25 * e * dt, 0, 1);
    const cmd = clamp(this.brakeIntegral + 0.08 * e + target / 9, 0, 1);
    report.autobrakeDecel = this.decel > 0.8 * target;
    return mode === 'max' ? 1 : cmd;
  }
}
