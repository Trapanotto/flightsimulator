/**
 * The F/A-18's flight control system (two quadruplex digital flight control computers, as the
 * control laws are described in NASA TM-4789 and the NATOPS manual's FCS chapter; the gains
 * here are this model's own).
 *
 * Up and away (flaps AUTO): the stick commands load factor, blended with pitch rate at low
 * speed and handing over to angle of attack above about 22°; neutral stick holds 1 g on the
 * flight path, corrected for bank. The g limiter allows 7.5 g at the design mass and less
 * above it (the same wing load), -3 g, a third more with the paddle. Lateral stick commands
 * roll rate about the velocity vector, up to about 220°/s, less at low dynamic pressure, at
 * high angle of attack and supersonic; the aileron-rudder interconnect yaws the nose into a
 * roll at high angle of attack, the rolling-surface-to-rudder interconnect cancels the
 * ailerons' adverse yaw, and a yaw rate and sideslip feedback keeps the turn coordinated.
 * Leading-edge flaps (to 34°) and trailing-edge flaps (to 17.5°) follow angle of attack and
 * Mach.
 *
 * Powered approach (flaps HALF or FULL below 240 KCAS): the stick commands angle of attack,
 * the trim sets the one it holds at neutral stick (8.1° on-speed with the trim centred).
 *
 * Spin recovery (the SPIN switch in RCVY with a spin's yaw rate at low speed): full authority
 * stick to surfaces, so the pilot's lateral stick into the spin drives full aileron and
 * differential stabilator. Without the flight control computers' power the stabilators are
 * mechanically linked to the stick, pitch and roll only (the mechanical backup).
 *
 * Each axis is an inverse of its own control power (estimated from the strips once, scaled
 * by dynamic pressure and Mach) around a proportional-integral loop on its rate: the gains then
 * hold from the approach to Mach 1.8.
 */
import { machEffects } from '../airfoil';
import type { ControlLaw, ControlLawContext, SurfaceCommand } from '../controlLaw';
import { trimAngle } from '../controlLaw';
import type { AircraftDefinition } from '../definition';
import { DEG, KT, clamp, smoothstep } from '../math';

const G = 9.80665;

export type FcsMode = 'ua' | 'pa' | 'spin' | 'mech' | 'ground';

/** Published and chosen figures of the control laws. */
export const FA18_FCS = {
  /** NATOPS: 7.5 g up to 32 357 lb, -3 g; the paddle allows a third more. */
  gLimit: 7.5,
  negativeG: -3,
  overrideFactor: 4 / 3,
  designMass: 32_357 * 0.45359237,
  /** On-speed approach angle of attack (NATOPS) and what full trim adds or takes. */
  onSpeedAlpha: 8.1 * DEG,
  trimAlpha: 6 * DEG,
  /** Angle of attack limits: up and away, and with the flaps down. */
  alphaMax: 45 * DEG,
  alphaMaxPa: 15 * DEG,
  alphaMin: -12 * DEG,
  /** Above this the stick commands angle of attack instead of load factor. */
  alphaCommand: 22 * DEG,
  rollRate: 220 * DEG,
  rollRatePa: 120 * DEG,
  /** The flaps follow the AUTO schedule above this calibrated airspeed whatever the selector. */
  flapsBlowUp: 240 * KT,
  /** Speed brake retracts above these. */
  speedbrakeG: 6,
  speedbrakeAlpha: 28 * DEG,
  /** Spin recovery mode: yaw rate and airspeed it engages within. */
  spinYawRate: 15 * DEG,
  spinSpeed: 120 * KT,
  /** Leading-edge and trailing-edge flap limits in AUTO. */
  lefMax: 34 * DEG,
  tefAuto: 17.5 * DEG,
};

/** Lift slope of a strip on a finite surface, per rad. */
function slope3d(def: AircraftDefinition, i: number): number {
  const s = def.strips[i]!;
  const a = s.foil.liftSlope * (s.sweep ? Math.cos(s.sweep) : 1);
  const g = def.groups[s.group]!;
  return a / (1 + a / (Math.PI * g.aspectRatio * g.oswald));
}

export class Fa18Fcs implements ControlLaw {
  readonly shaker = false;
  readonly pusher = false;
  /** Set by the type's systems from the cockpit each step. */
  paddle = false;
  spinSwitch = false;
  mode: FcsMode = 'ground';
  /** The g limit allowed now (for the HUD). */
  gLimit = 7.5;
  /** Leading-edge flap and trailing-edge flap commanded, rad. */
  lef = 0;
  tef = 0;

  // Control power estimates: moment per unit of dynamic pressure and surface command.
  private readonly pitchPower: number;
  private readonly rollPower: number;
  private readonly rollDamping: number;
  private readonly yawPower: number;
  private readonly yawDamping: number;

  private fresh = true;
  private pitchIntegral = 0;
  private rollIntegral = 0;
  private yawIntegral = 0;
  private nzIntegral = 0;
  debug: number[] = [];
  /** The pilot's load factor command through the command model (a first-order lag). */
  private nzModel = 1;
  /** Filtered rates of load factor and angle of attack: the limiters look ahead with them. */
  private nzRate = 0;
  private alphaRate = 0;
  private lastNz = NaN;
  private lastAlpha = NaN;
  private speedbrakeInhibit = false;
  private spinTimer = 0;
  private paLatched = false;
  private readonly machOut = { lift: 1, drag: 0, cpShift: 0, control: 1 };

  constructor(readonly def: AircraftDefinition) {
    const c = def.controls;
    let pitch = 0;
    let roll = 0;
    let rollDamping = 0;
    let yaw = 0;
    let yawDamping = 0;
    def.strips.forEach((s, i) => {
      const a = slope3d(def, i) * (s.qFactor ?? 1);
      const k = s.control?.kind;
      const eff = s.control?.effectiveness ?? 0;
      const y = s.position.y;
      const x = s.position.x;
      if (k === 'elevator') {
        pitch += s.area * a * eff * Math.abs(x);
        roll += s.area * a * eff * (s.control?.roll ?? 0) * Math.abs(y) * c.elevatorDown;
      }
      if (k === 'aileron')
        roll += s.area * a * eff * Math.abs(y) * 0.5 * (c.aileronUp + c.aileronDown);
      if (k === 'rudder') {
        yaw += s.area * a * eff * Math.abs(x) * c.rudder * Math.abs(s.liftAxis.y);
        yawDamping += s.area * a * x * x * Math.abs(s.liftAxis.y);
      }
      if (Math.abs(s.liftAxis.z) > 0.7) rollDamping += s.area * a * y * y;
    });
    this.pitchPower = pitch;
    this.rollPower = roll;
    this.rollDamping = rollDamping;
    this.yawPower = yaw;
    this.yawDamping = yawDamping;
  }

  reset() {
    this.fresh = true;
    this.pitchIntegral = 0;
    this.rollIntegral = 0;
    this.yawIntegral = 0;
    this.nzIntegral = 0;
    this.nzRate = 0;
    this.nzModel = NaN;
    this.alphaRate = 0;
    this.lastNz = NaN;
    this.lastAlpha = NaN;
    this.speedbrakeInhibit = false;
    this.spinTimer = 0;
    this.mode = 'ground';
    this.paLatched = false;
  }

  private mass(ctx: ControlLawContext) {
    return this.def.mass + ctx.telemetry.fuel;
  }

  /** Factor on a tail surface's lift slope at this Mach (Prandtl-Glauert, then Ackeret). */
  private machFactor(mach: number) {
    const tail = this.def.strips.find((s) => s.control?.kind === 'elevator');
    const m = tail?.foil.mach;
    if (!m || !tail) return 1;
    const sweep = tail.sweep ?? 0;
    return machEffects(m, tail.foil.liftSlope, mach * Math.cos(sweep), this.machOut).lift;
  }

  step(ctx: ControlLawContext, out: SurfaceCommand) {
    const def = this.def;
    const c = def.controls;
    const t = ctx.telemetry;
    const w = ctx.state.angularVelocity;
    const ci = ctx.controls;
    const dt = ctx.dt;
    const flapIndex = Math.round(clamp(ci.flaps, 0, 1) * (c.flapDetents.length - 1));
    const ias = t.ias;
    const alpha = t.alpha;
    const onGround = t.onGround;
    const V = Math.max(t.tas, 30);
    const q = Math.max(ctx.q, 300);
    const mf = Math.max(0.5, this.machFactor(ctx.mach));
    const I = def.inertia;

    // ---- mode ----
    // PA with the flaps down below the blow-up speed, with a little hysteresis.
    if (flapIndex === 0) this.paLatched = false;
    else if (ias < FA18_FCS.flapsBlowUp - 5 * KT) this.paLatched = true;
    else if (ias > FA18_FCS.flapsBlowUp + 5 * KT) this.paLatched = false;
    const spinning =
      this.spinSwitch &&
      !onGround &&
      ias < FA18_FCS.spinSpeed &&
      Math.abs(w.z) > FA18_FCS.spinYawRate;
    if (spinning) this.spinTimer = 1;
    else this.spinTimer = Math.max(0, this.spinTimer - dt);
    let mode: FcsMode;
    if (!ctx.stallProtection) mode = 'mech';
    else if (onGround) mode = 'ground';
    else if (this.spinTimer > 0 && this.spinSwitch) mode = 'spin';
    else mode = this.paLatched ? 'pa' : 'ua';
    const wasDirect = this.mode === 'ground' || this.mode === 'mech' || this.mode === 'spin';
    this.mode = mode;

    if (Number.isNaN(this.lastNz) || dt <= 0) {
      this.lastNz = t.loadFactor;
      this.lastAlpha = alpha;
    }
    const k = dt > 0 ? Math.min(1, dt / 0.08) : 0;
    if (dt > 0) {
      this.nzRate += k * ((t.loadFactor - this.lastNz) / dt - this.nzRate);
      this.alphaRate += k * ((alpha - this.lastAlpha) / dt - this.alphaRate);
    }
    this.lastNz = t.loadFactor;
    this.lastAlpha = alpha;
    const nzAhead = t.loadFactor + 0.15 * this.nzRate;
    const alphaAhead = alpha + 0.35 * this.alphaRate;
    const p = clamp(ctx.pitch, -1, 1);
    const r = clamp(ctx.roll, -1, 1);
    const yawIn = clamp(ctx.yaw, -1, 1);
    const elevatorNow = t.elevator >= 0 ? t.elevator * c.elevatorUp : t.elevator * c.elevatorDown;

    // ---- flaps ----
    this.schedule(ctx, flapIndex, out);

    // ---- speed brake ----
    const sbIn = clamp(ci.speedbrake ?? 0, 0, 1);
    if (t.loadFactor > FA18_FCS.speedbrakeG || alpha > FA18_FCS.speedbrakeAlpha)
      this.speedbrakeInhibit = true;
    else if (sbIn < 0.05) this.speedbrakeInhibit = false;
    out.spoilers = 0;
    out.speedbrake = this.speedbrakeInhibit ? 0 : sbIn;
    out.stabiliser = 0;

    if (mode === 'mech' || mode === 'ground' || mode === 'spin') {
      // Stick straight to the surfaces (mechanical link, weight on wheels, spin recovery).
      const trim = mode === 'spin' ? 0 : trimAngle(def, ci.pitchTrim);
      const stick = p >= 0 ? p * c.elevatorUp : p * c.elevatorDown;
      out.elevator = clamp(trim + stick, -c.elevatorDown, c.elevatorUp);
      out.differentialTail = r;
      out.aileron = mode === 'mech' ? 0 : r;
      out.rudder = mode === 'mech' ? 0 : yawIn;
      if (mode === 'mech') {
        out.flap = undefined;
        out.leadingEdge = undefined;
      }
      this.fresh = true;
      return;
    }

    const theta = t.pitch;
    const phi = t.bank;
    const cosT = Math.cos(theta);
    const cosP = Math.cos(phi);
    const gravityNormal = cosT * cosP;

    // ---- pitch ----
    let qDes: number;
    const mass = this.mass(ctx);
    const nMax =
      FA18_FCS.gLimit *
      Math.min(1, FA18_FCS.designMass / mass) *
      (this.paddle ? FA18_FCS.overrideFactor : 1);
    this.gLimit = nMax;
    if (mode === 'ua') {
      // 1 g on the flight path in a bank (the turn's g) up to 60°, gravity's share beyond.
      const bankShare = 1 - smoothstep(45 * DEG, 75 * DEG, Math.abs(phi));
      const nRef =
        cosT * (cosP + (1 / Math.max(Math.abs(cosP), 0.3) - cosP) * bankShare) + 0.5 * ci.pitchTrim;
      const shaped = p * (0.35 + 0.65 * Math.abs(p));
      const nCmd =
        shaped >= 0 ? nRef + shaped * (nMax - nRef) : nRef + shaped * (nRef - FA18_FCS.negativeG);
      const nz = t.loadFactor;
      // The command model: the stick's g arrives in about a third of a second, so the loop
      // does not overshoot what the airframe can follow (and the leading-edge flaps keep up).
      if (Number.isNaN(this.nzModel) || this.fresh || wasDirect) this.nzModel = nz;
      this.nzModel += (nCmd - this.nzModel) * Math.min(1, dt / 0.3);
      const nM = this.nzModel;
      // Load factor at speed, pitch rate at low speed.
      const blend = smoothstep(85 * KT, 150 * KT, ias);
      const before = this.nzIntegral;
      // Integrates only near the command, so the onset of a pull does not wind it up.
      if (blend > 0.5 && Math.abs(nM - nz) < 0.8)
        this.nzIntegral = clamp(this.nzIntegral + 1.5 * (nM - nz) * dt, -1.5, 1.5);
      else this.nzIntegral *= 1 - dt;
      // More load factor feedback where the airframe answers it quickly (high dynamic pressure).
      const kn = 1 + 1.0 * smoothstep(9000, 20000, ctx.q);
      const qG = (G / V) * (nM - gravityNormal + kn * (nM - nzAhead) + this.nzIntegral);
      const qRate = shaped * 0.6 + (G / V) * (nRef - gravityNormal);
      qDes = blend * qG + (1 - blend) * qRate;
      // Angle of attack: above 22° the stick asks for angle of attack, full aft the limit.
      const aCmd =
        FA18_FCS.alphaCommand +
        (FA18_FCS.alphaMax - FA18_FCS.alphaCommand) * clamp((p - 0.55) / 0.45, 0, 1);
      const path = (G / V) * (nz - gravityNormal);
      const qAlpha = 1.6 * (aCmd - alphaAhead) + path;
      const alphaLimited = (alpha > 12 * DEG || qDes > qAlpha) && qAlpha < qDes;
      if (alphaLimited) qDes = qAlpha;
      qDes = Math.max(qDes, 1.6 * (FA18_FCS.alphaMin - alphaAhead) + path);
      // The g limiter also holds against what the pilot's pull would overshoot.
      qDes = Math.min(qDes, path + (G / V) * (2 * (nMax - nzAhead) + Math.max(0, this.nzIntegral)));
      qDes = Math.max(qDes, path + (G / V) * 3 * (FA18_FCS.negativeG - nzAhead));
      // Held by the angle of attack limit: the load factor integrator must not wind up.
      if (alphaLimited && this.nzIntegral > before) this.nzIntegral = before;
    } else {
      // Powered approach: angle of attack command around the trimmed one.
      const aTrim = FA18_FCS.onSpeedAlpha + FA18_FCS.trimAlpha * clamp(ci.pitchTrim, -1, 1);
      const aCmd =
        p >= 0 ? aTrim + p * (FA18_FCS.alphaMaxPa - aTrim) : aTrim + p * (aTrim - 0 * DEG);
      const path = (G / V) * (t.loadFactor - gravityNormal);
      qDes = 1.4 * (aCmd - alpha) + clamp(path, -0.2, 0.3);
      this.nzIntegral = 0;
    }
    qDes = clamp(qDes, -0.9, 0.9);
    this.debug = [qDes, this.nzIntegral, this.nzModel];
    const pitchScale = I.y / (this.pitchPower * q * mf);
    const qErr = qDes - w.y;
    if (this.fresh || wasDirect) {
      // Take over where the surfaces are: the trim solver's or the ground's stabilator angle.
      this.pitchIntegral = elevatorNow - pitchScale * 5 * qErr;
      this.rollIntegral = 0;
      this.yawIntegral = 0;
      this.fresh = false;
    }
    this.pitchIntegral = clamp(
      this.pitchIntegral + pitchScale * 14 * qErr * dt,
      -c.elevatorDown,
      c.elevatorUp,
    );
    out.elevator = clamp(this.pitchIntegral + pitchScale * 5 * qErr, -c.elevatorDown, c.elevatorUp);

    // ---- roll, about the velocity vector ----
    let pMax: number;
    if (mode === 'ua') {
      pMax =
        FA18_FCS.rollRate *
        (0.35 + 0.65 * smoothstep(2500, 9000, ctx.q)) *
        (1 - 0.8 * smoothstep(15 * DEG, 35 * DEG, alpha)) *
        (1 - 0.45 * smoothstep(1.0, 1.6, ctx.mach));
    } else pMax = FA18_FCS.rollRatePa * (1 - 0.5 * smoothstep(10 * DEG, 15 * DEG, alpha));
    const rollShaped = r * (0.3 + 0.7 * Math.abs(r));
    const pStab = rollShaped * pMax;
    const ca = Math.cos(alpha);
    const sa = Math.sin(alpha);
    const pCmd = pStab * ca;
    // Aileron-rudder interconnect: the nose yaws with the roll at angle of attack.
    const turnYaw = (G * Math.sin(phi) * cosT) / V;
    const rCmd = pStab * sa + turnYaw * (1 - smoothstep(60 * DEG, 90 * DEG, Math.abs(phi)));
    const rollScale = I.x / (this.rollPower * q * mf);
    const pErr = pCmd - w.x;
    this.rollIntegral = clamp(this.rollIntegral + rollScale * 3 * pErr * dt, -0.3, 0.3);
    const rollFf = (this.rollDamping * pCmd) / (this.rollPower * 2 * V);
    const u = clamp(rollScale * 9 * pErr + rollFf + this.rollIntegral, -1, 1);
    out.aileron = u;
    out.differentialTail = u;

    // ---- yaw ----
    const yawScale = I.z / (this.yawPower * q * mf);
    const rErr = rCmd - w.z;
    // Pedals: sideslip command, washed out at high angle of attack where they would depart it.
    const pedal = yawIn * (1 - 0.8 * smoothstep(20 * DEG, 35 * DEG, alpha));
    this.yawIntegral = clamp(this.yawIntegral + yawScale * 2 * rErr * dt, -0.3, 0.3);
    // Rolling-surface-to-rudder interconnect against the ailerons' adverse yaw at high alpha.
    const rsri = 0.25 * u * smoothstep(5 * DEG, 25 * DEG, alpha);
    const yawFf = (this.yawDamping * rCmd) / (this.yawPower * 2 * V);
    out.rudder = clamp(
      yawScale * 6 * rErr + yawFf + this.yawIntegral + rsri + 1.5 * t.beta + 0.6 * pedal,
      -1,
      1,
    );
    if (pedal !== 0) this.yawIntegral *= 1 - 2 * dt;
  }

  /** Leading- and trailing-edge flaps with angle of attack and Mach (AUTO), or the PA settings. */
  private schedule(ctx: ControlLawContext, flapIndex: number, out: SurfaceCommand) {
    const t = ctx.telemetry;
    // Scheduled on the angle of attack a moment ahead: the flaps then keep up with a pull.
    const a = (t.alpha + 0.3 * this.alphaRate) / DEG;
    const m = ctx.mach;
    const c = this.def.controls;
    let lef = clamp(1.3 * (a - 1), 0, 34) * DEG * (1 - 0.7 * smoothstep(0.8, 1.1, m));
    let tef = clamp(1.4 * (a - 2), 0, 17.5) * DEG * (1 - smoothstep(0.6, 0.85, m));
    if (this.paLatched || (t.onGround && flapIndex > 0)) {
      tef = c.flapDetents[flapIndex]!;
      lef = t.onGround ? 12 * DEG : Math.max(lef, 4 * DEG);
    }
    this.lef = lef;
    this.tef = tef;
    out.flap = tef;
    out.leadingEdge = lef;
  }
}
