/**
 * Generic strip-theory flight model. Every lifting strip, the fuselage and the propeller
 * quadrants see their own airflow (aircraft motion, rotation, local wind, slipstream and
 * swirl, wing downwash, crossflow around the cabin); stall, wing drop, spin, ground effect,
 * adverse yaw, P-factor and crosswind behaviour come out of that instead of being added.
 *
 * Integration: aerodynamics and engine once per fixed step, then the rigid body in sub-steps
 * with the gear and contact points recomputed each sub-step (they are stiff). Semi-implicit
 * Euler, which keeps the phugoid and the gear oscillation from gaining energy.
 */
import type { Avionics, AvionicsInput, AvionicsUnit } from './avionicsTypes';
import { C172_CONTROLS, CockpitPanel } from './cockpit';
import { AircraftSystems } from './systems/systems';
import { FailureSet } from './systems/failures';
import {
  sectionCoefficients,
  staticSeparation,
  updateSeparation,
  type SectionCoefficients,
} from './airfoil';
import type { AircraftDefinition, ContactPoint, WheelDef } from './definition';
import { PistonEngine, propellerForces, type EngineOutput, type PropellerOutput } from './engine';
import {
  DEG,
  KT,
  add,
  addScaled,
  clamp,
  copy,
  cross,
  dot,
  integrateOrientation,
  length,
  lookup,
  normalize,
  quatFromAxes,
  rotate,
  rotateInverse,
  scale,
  set,
  smoothstep,
  sub,
  vec,
} from './math';
import type {
  AirSample,
  AircraftInfo,
  AircraftState,
  ControlInput,
  Environment,
  GroundSample,
  InitialCondition,
  SimAircraft,
  Surface,
  Telemetry,
  Vec3,
} from './types';

const G0 = 9.80665;
const EARTH_RADIUS = 6_371_000;
const SEA_LEVEL_DENSITY = 1.225;
/** Below this height of the centre of gravity the gear and contact points are evaluated. */
const CONTACT_RANGE = 60;
const GEAR_SUBSTEPS = 4;
const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
/** What `avionics` hands out while no avionics unit is plugged in. */
const NO_AVIONICS: Avionics = { setDatabase() {}, setFlightPlan() {}, directTo() {} };
/** Heavy airframe ice: how much it lowers the stall angle, adds profile drag and body drag. */
const ICE_STALL = 0.25;
const ICE_DRAG = 0.012;
const ICE_BODY_DRAG = 0.3;
const X_AXIS: Vec3 = { x: 1, y: 0, z: 0 };
const Y_AXIS: Vec3 = { x: 0, y: 1, z: 0 };
const Z_AXIS: Vec3 = { x: 0, y: 0, z: 1 };

/** Tyre friction (dry, fully wet) and rolling resistance per surface. */
const SURFACES: Record<Surface, { dry: number; wet: number; rolling: number }> = {
  asphalt: { dry: 0.8, wet: 0.5, rolling: 0.025 },
  concrete: { dry: 0.8, wet: 0.55, rolling: 0.025 },
  grass: { dry: 0.5, wet: 0.3, rolling: 0.05 },
  gravel: { dry: 0.55, wet: 0.45, rolling: 0.04 },
  snow: { dry: 0.25, wet: 0.15, rolling: 0.07 },
  water: { dry: 0.05, wet: 0.05, rolling: 0.5 },
  terrain: { dry: 0.5, wet: 0.35, rolling: 0.08 },
};

/** Tyre bristle stiffness (N/m), damping (N s/m) and relaxation length (m). */
const TYRE_STIFFNESS = 80_000;
const TYRE_DAMPING = 3_500;
const TYRE_RELAXATION = 0.35;

/** A ground plane under one wheel or contact point, valid for one step. */
interface Plane {
  valid: boolean;
  point: Vec3;
  normal: Vec3;
  surface: Surface;
  wetness: number;
}

const newPlane = (): Plane => ({
  valid: false,
  point: vec(),
  normal: vec(),
  surface: 'asphalt',
  wetness: 0,
});

const newAir = (): AirSample => ({
  wind: vec(),
  density: 1.225,
  temperature: 288.15,
  pressure: 101325,
});

export class FlightModel implements SimAircraft {
  readonly info: AircraftInfo;
  readonly state: AircraftState = {
    position: vec(),
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: vec(),
    angularVelocity: vec(),
  };
  readonly controls: ControlInput;
  readonly telemetry: Telemetry;
  readonly cockpit: CockpitPanel = new CockpitPanel(C172_CONTROLS);
  readonly failures = new FailureSet();
  /**
   * The avionics (radios, navigation, transponder, GPS, autopilot), plugged in by whoever
   * builds the aircraft. Without one the aircraft flies as before, with dark avionics.
   */
  avionicsUnit: AvionicsUnit | undefined;
  readonly systems: AircraftSystems;

  private readonly engine: PistonEngine;
  private time = 0;
  private crashed: string | undefined;
  /** Waiting for the terrain to load while standing: the aircraft is held in place. */
  private held = false;
  private placeWhenGroundLoads = false;
  private heldStart: InitialCondition | undefined;

  // Control surface positions actually reached.
  private elevator = 0; // rad, positive nose up (trailing edge up), trim included
  private aileron = 0; // -1..1, positive roll right
  private rudder = 0; // -1..1, positive nose right
  private flap = 0; // rad

  // Aerodynamic state.
  private readonly separation: Float64Array;
  private readonly stripCl: Float64Array;
  private readonly stripAlpha: Float64Array;
  private readonly groupCl: Float64Array;
  private readonly groupInduced: Float64Array;
  private readonly groupPoint: Vec3[];
  private readonly inducedRelaxation: Float64Array;
  private downwash = 0;
  private stallHornAlpha = 0;

  // Gear state.
  private readonly bristleLong: Float64Array;
  private readonly bristleLat: Float64Array;
  private readonly compression: Float64Array;
  private readonly wheelPlanes: Plane[];
  private readonly contactPlanes: Plane[];
  private readonly contactTouching: Uint8Array;
  private cgPlane = newPlane();

  // Per-step results.
  private readonly forceBody = vec();
  private readonly momentBody = vec();
  private readonly gearForce = vec();
  private readonly gearMoment = vec();
  private propTorque = 0;
  private thrust = 0;
  private slipDelta = 0;
  private slipRadius = 0;
  private swirl = 0;
  private fuelFlow = 0;
  private enginePower = 0;
  private specificForceZ = -G0;
  /** Specific force (aero and gear over mass), world frame, averaged over the sub-steps. */
  private readonly specificForce = vec();
  private specificForceY = 0;
  private wheelsLoaded = 0;
  /** Stick input actually flown this step: the pilot's, or the autopilot's while engaged. */
  private pitchIn = 0;
  private rollIn = 0;
  private readonly avionicsInput: AvionicsInput = {
    powered: false,
    com1Failed: false,
    lon: 0,
    lat: 0,
    altitude: 0,
    heading: 0,
    track: 0,
    groundSpeed: 0,
    verticalSpeed: 0,
    ias: 0,
    pitch: 0,
    bank: 0,
    turnRate: 0,
    onGround: false,
    declination: 0,
    indicatedHeading: 0,
    indicatedAltitude: 0,
    pilotPitch: 0,
    pilotRoll: 0,
  };
  private readonly afterEngine = { fuelFlow: 0, load: 0, tas: 0, slipstream: 0, phi: 1 };

  // Air samples: centre, left tip, right tip, tail.
  private readonly air = [newAir(), newAir(), newAir(), newAir()];
  private readonly airPoints: Vec3[];
  private readonly windBody = [vec(), vec(), vec(), vec()];

  // Scratch vectors.
  private readonly t0 = vec();
  private readonly t1 = vec();
  private readonly t2 = vec();
  private readonly t3 = vec();
  private readonly t4 = vec();
  private readonly up = vec();
  private readonly north = vec();
  private readonly vBody = vec();
  private readonly aeroWorld = vec();
  private readonly accel = vec();
  private readonly mBody = vec();
  private readonly coeff: SectionCoefficients = { cl: 0, cd: 0, cm: 0 };
  private readonly engineOut: EngineOutput = {
    torque: 0,
    power: 0,
    fuelFlow: 0,
    manifoldPressure: 0,
    running: true,
  };
  private readonly propOut: PropellerOutput = { thrust: 0, torque: 0 };

  constructor(
    readonly def: AircraftDefinition,
    avionicsUnit?: AvionicsUnit,
  ) {
    this.info = def.info;
    this.avionicsUnit = avionicsUnit;
    const span = def.wingSpan / 2;
    this.airPoints = [vec(0, 0, 0), vec(0, -span, 0), vec(0, span, 0), vec(-def.tailArm, 0, 0)];
    this.engine = new PistonEngine(def.engine);
    this.systems = new AircraftSystems(def.systems, this.cockpit, this.failures);
    const n = def.strips.length;
    this.separation = new Float64Array(n).fill(1);
    this.stripCl = new Float64Array(n);
    this.stripAlpha = new Float64Array(n);
    this.groupCl = new Float64Array(def.groups.length);
    this.groupInduced = new Float64Array(def.groups.length);
    this.inducedRelaxation = new Float64Array(
      def.groups.map((grp, g) => {
        const strip = def.strips.find((st) => st.group === g);
        const gain =
          (strip?.foil.liftSlope ?? 2 * Math.PI) / (Math.PI * grp.aspectRatio * grp.oswald);
        return 1 / (1 + gain);
      }),
    );
    this.groupPoint = def.groups.map((_, g) => {
      const members = def.strips.filter((s) => s.group === g);
      const p = vec();
      for (const s of members) addScaled(p, p, s.position, 1 / members.length);
      return p;
    });
    const w = def.wheels.length;
    this.bristleLong = new Float64Array(w);
    this.bristleLat = new Float64Array(w);
    this.compression = new Float64Array(w);
    this.wheelPlanes = def.wheels.map(newPlane);
    this.contactPlanes = def.contacts.map(newPlane);
    this.contactTouching = new Uint8Array(def.contacts.length);
    this.controls = {
      pitch: 0,
      roll: 0,
      yaw: 0,
      throttle: [0],
      flaps: 0,
      gearDown: true,
      brakeLeft: 0,
      brakeRight: 0,
      parkingBrake: false,
      pitchTrim: 0,
      mixture: [1],
      starter: [false],
    };
    this.telemetry = {
      time: 0,
      ias: 0,
      tas: 0,
      groundSpeed: 0,
      altitude: 0,
      agl: undefined,
      verticalSpeed: 0,
      headingDeg: 0,
      trackDeg: 0,
      pitch: 0,
      bank: 0,
      alpha: 0,
      beta: 0,
      loadFactor: 1,
      onGround: false,
      stallWarning: false,
      flaps: 0,
      gear: 1,
      elevator: 0,
      aileron: 0,
      rudder: 0,
      engines: [{ running: true, rpm: 0, power: 0, fuelFlow: 0 }],
      fuel: this.fuel,
      crashed: undefined,
      systems: this.systems.telemetry,
      instruments: this.systems.instruments.telemetry,
    };
    this.bindCockpit();
  }

  /** Total usable fuel, kg. */
  private get fuel() {
    return this.systems.fuel.total;
  }

  get mass() {
    const ice = this.systems.icing.airframe;
    return this.def.mass + this.fuel + (ice > 0 ? ice * this.def.systems.icing.iceMass : 0);
  }

  /** The navigation database and the flight plan go to the avionics unit, if there is one. */
  get avionics(): Avionics {
    return this.avionicsUnit ?? NO_AVIONICS;
  }

  /**
   * Fuel in the tanks, kg (the planned fuel load; a reset fills both). Usable fuel only,
   * clamped to a tank's capacity.
   */
  setFuel(left: number, right: number) {
    this.systems.fuel.reset(left, right);
    this.systems.fillTelemetry();
    this.telemetry.fuel = this.fuel;
  }

  /** The levers of ControlInput appear in the cockpit under their names. */
  private bindCockpit() {
    const p = this.cockpit;
    const c = this.controls;
    const detents = this.def.controls.flapDetents.length - 1;
    p.bind(
      'throttle',
      () => c.throttle[0] ?? 0,
      (v) => (c.throttle[0] = v),
    );
    p.bind(
      'mixture',
      () => c.mixture[0] ?? 0,
      (v) => (c.mixture[0] = v),
    );
    // The selector's positions are the flap detents; ControlInput spreads them over 0..1.
    p.bind(
      'flaps',
      () => Math.round(clamp(c.flaps, 0, 1) * detents),
      (v) => (c.flaps = v / detents),
    );
    p.bind(
      'trim',
      () => c.pitchTrim,
      (v) => (c.pitchTrim = v),
    );
    p.bind(
      'parkingBrake',
      () => (c.parkingBrake ? 1 : 0),
      (v) => (c.parkingBrake = v >= 0.5),
    );
  }

  // ---------------------------------------------------------------------------------------
  // Controls

  private flapTarget(): number {
    const detents = this.def.controls.flapDetents;
    // The lever has detents; the input is snapped to the nearest one.
    const i = Math.round(clamp(this.controls.flaps, 0, 1) * (detents.length - 1));
    return detents[i]!;
  }

  private elevatorTarget(hold = 1): number {
    const c = this.def.controls;
    const trim = clamp(this.controls.pitchTrim, -1, 1);
    const trimAngle = trim >= 0 ? trim * c.trimUp : trim * c.trimDown;
    const p = clamp(this.pitchIn, -1, 1) * hold;
    const stick = p >= 0 ? p * c.elevatorUp : p * c.elevatorDown;
    return clamp(trimAngle + stick, -c.elevatorDown, c.elevatorUp);
  }

  /**
   * Surfaces follow the yoke at a finite rate, and at high dynamic pressure the pilot cannot
   * hold full deflection against the air loads (reversible controls).
   */
  private moveSurfaces(dt: number, q: number) {
    const c = this.def.controls;
    const hold = Math.min(1, c.holdLimitPressure / Math.max(q, 1));
    const rate = c.surfaceRate * dt;
    // Trim tabs take the load off, so only the yoke's share is limited by the air load.
    const eTarget = this.elevatorTarget(hold);
    const eRange = c.elevatorUp + c.elevatorDown;
    this.elevator += clamp(eTarget - this.elevator, -rate * eRange, rate * eRange);
    const aTarget = clamp(clamp(this.rollIn, -1, 1) * hold + c.aileronRigging, -1, 1);
    this.aileron += clamp(aTarget - this.aileron, -rate * 2, rate * 2);
    const rTarget = clamp(clamp(this.controls.yaw, -1, 1) * hold + c.rudderRigging, -1, 1);
    this.rudder += clamp(rTarget - this.rudder, -rate * 2, rate * 2);
    // The flaps are electric: without power they stay where they are.
    const fTarget = this.flapTarget();
    const moving = Math.abs(fTarget - this.flap) > 1e-9;
    if (this.systems.flapsPowered)
      this.flap += clamp(fTarget - this.flap, -c.flapRate * dt, c.flapRate * dt);
    this.systems.flapsMoving = moving;
  }

  /** Change of zero-lift angle of a strip from its control surface, rad. */
  private controlAlpha(kind: string, effectiveness: number, side: number | undefined): number {
    const c = this.def.controls;
    switch (kind) {
      case 'flap': {
        // Slotted flaps lose effectiveness towards full deflection.
        const d = this.flap;
        return effectiveness * d * (1 - 0.25 * (d / (30 * DEG)));
      }
      case 'aileron': {
        // Right roll: right aileron up, left aileron down (differential travel).
        const a = this.aileron * (side ?? 1);
        const d = a >= 0 ? -a * c.aileronUp : -a * c.aileronDown;
        return effectiveness * d;
      }
      case 'elevator':
        // Trailing edge up (nose up) is negative lift on the tailplane.
        return -effectiveness * this.elevator;
      case 'rudder':
        return effectiveness * this.rudder * c.rudder;
    }
    return 0;
  }

  // ---------------------------------------------------------------------------------------
  // Aerodynamics and propulsion

  private sampleAir(env: Environment) {
    const s = this.state;
    for (let i = 0; i < 4; i++) {
      const p = rotate(this.t0, s.orientation, this.airPoints[i]!);
      add(p, p, s.position);
      env.air(p, this.air[i]!);
      rotateInverse(this.windBody[i]!, s.orientation, this.air[i]!.wind);
    }
  }

  /** Wind (body frame) at a body point, interpolated between the samples. */
  private windAt(p: Vec3, out: Vec3): Vec3 {
    const w = this.windBody;
    if (p.x < -2) return copy(out, w[3]!);
    const half = this.def.wingSpan / 2;
    const t = clamp(Math.abs(p.y) / half, 0, 1);
    const tip = p.y < 0 ? w[1]! : w[2]!;
    out.x = w[0]!.x + (tip.x - w[0]!.x) * t;
    out.y = w[0]!.y + (tip.y - w[0]!.y) * t;
    out.z = w[0]!.z + (tip.z - w[0]!.z) * t;
    return out;
  }

  /** Velocity of a body point relative to the local air, body frame. */
  private airVelocityAt(p: Vec3, out: Vec3): Vec3 {
    cross(out, this.state.angularVelocity, p);
    add(out, out, this.vBody);
    const w = this.windAt(p, this.t4);
    return sub(out, out, w);
  }

  /** Height of a body point above the ground plane under the centre, or Infinity. */
  private heightAboveGround(p: Vec3): number {
    const plane = this.cgPlane;
    if (!plane.valid) return Infinity;
    const w = rotate(this.t3, this.state.orientation, p);
    add(w, w, this.state.position);
    sub(w, w, plane.point);
    return dot(w, plane.normal);
  }

  /**
   * Propeller: the disk is split into four quadrants, each at 3/4 radius with its own inflow.
   * At an angle of attack the descending blade meets the air faster than the rising one and
   * makes more thrust: P-factor. Returns the torque absorbed and accumulates forces.
   */
  private propeller(omega: number, density: number, accumulate: boolean): number {
    const prop = this.def.propeller;
    const r = 0.375 * prop.diameter;
    const n = omega / (2 * Math.PI);
    let torque = 0;
    let thrust = 0;
    const p = this.t1;
    const dir = this.t2;
    const vel = this.t0;
    for (let k = 0; k < 4; k++) {
      // Quadrant directions: right, down, left, up; blade motion = x × dir.
      const dy = k === 0 ? 1 : k === 2 ? -1 : 0;
      const dz = k === 1 ? 1 : k === 3 ? -1 : 0;
      set(dir, 0, dy, dz);
      addScaled(p, prop.position, dir, r);
      this.airVelocityAt(p, vel);
      // Tangential direction of the blade (clockwise seen from the cockpit) is (0, -dz, dy).
      const vt = -dz * vel.y + dy * vel.z;
      const bladeSpeed = omega * r;
      const s = bladeSpeed > 5 ? clamp(1 + vt / bladeSpeed, 0.3, 3) : 1;
      propellerForces(prop, n * s, vel.x, density, this.propOut);
      const tq = this.propOut.thrust / 4;
      const qq = this.propOut.torque / 4;
      thrust += tq;
      torque += qq;
      if (accumulate) {
        // Thrust acts at the quadrant (its asymmetry is the P-factor moment); the blade drag
        // goes into the shaft as torque, and only what does not cancel between quadrants,
        // the propeller's normal force, reaches the airframe, at the hub.
        const f = this.t3;
        set(f, tq, 0, 0);
        this.addForce(p, f);
        set(f, 0, (qq / r) * dz, (-qq / r) * dy);
        this.addForce(prop.position, f);
      }
    }
    if (accumulate) this.thrust = thrust;
    return torque;
  }

  private addForce(p: Vec3, f: Vec3) {
    const F = this.forceBody;
    const M = this.momentBody;
    F.x += f.x;
    F.y += f.y;
    F.z += f.z;
    M.x += p.y * f.z - p.z * f.y;
    M.y += p.z * f.x - p.x * f.z;
    M.z += p.x * f.y - p.y * f.x;
  }

  /** Ground-effect factor on induced angle and downwash for a body point (1 = free air). */
  private groundEffect(p: Vec3, span: number): number {
    const h = this.heightAboveGround(p);
    if (!isFinite(h)) return 1;
    const x = (16 * Math.max(h, 0.1)) / span;
    return (x * x) / (1 + x * x);
  }

  /**
   * One pass over all elements. `steady` puts every lagging state (separation, downwash,
   * induced angle) at its equilibrium instead of moving it by dt; the trim solver uses it.
   */
  private aerodynamics(dt: number, steady: boolean) {
    const def = this.def;
    const air = this.air[0]!;
    const rho = air.density;
    const ice = this.systems.icing.airframe;
    set(this.forceBody, 0, 0, 0);
    set(this.momentBody, 0, 0, 0);

    // Free stream at the centre of gravity.
    const vc = sub(this.t0, this.vBody, this.windBody[0]!);
    const speed = length(vc);

    // Slipstream from momentum theory: fully developed speed increment and swirl.
    const prop = def.propeller;
    const disk = (Math.PI * prop.diameter * prop.diameter) / 4;
    const va = Math.max(vc.x, 0);
    const radicand = va * va + (2 * this.thrust) / (rho * disk);
    this.slipDelta = Math.sqrt(Math.max(radicand, 0)) - va;
    const vDisk = Math.max(va + this.slipDelta / 2, 1);
    this.slipRadius = (prop.diameter / 2) * Math.sqrt(vDisk / Math.max(va + this.slipDelta, 1));
    const massFlow = rho * disk * vDisk;
    this.swirl =
      (prop.swirlFactor * 2 * Math.max(this.propTorque, 0)) /
      (massFlow * this.slipRadius * this.slipRadius);

    // Lagged wing downwash at the tail; it reaches the tail after the tail arm's travel time.
    const groups = def.groups;
    let wingCl = 0;
    let wingArea = 0;
    for (const g of def.wingGroups)
      for (let i = 0; i < def.strips.length; i++)
        if (def.strips[i]!.group === g) {
          wingCl += this.stripCl[i]! * def.strips[i]!.area;
          wingArea += def.strips[i]!.area;
        }
    wingCl /= wingArea;
    const wingAspect = groups[def.wingGroups[0]!]!.aspectRatio;
    const gePoint = this.groupPoint[def.wingGroups[0]!]!;
    const geWing = this.groundEffect(gePoint, def.wingSpan);
    const downwashTarget = ((def.downwashFactor * 2 * wingCl) / (Math.PI * wingAspect)) * geWing;
    if (steady) this.downwash = downwashTarget;
    else {
      const tau = def.tailArm / Math.max(speed, 5);
      this.downwash += (downwashTarget - this.downwash) * (1 - Math.exp(-dt / tau));
    }

    const ve = this.t1;
    const sideSpeed = vc.y;
    const crossflow = def.wingRoot;
    for (let i = 0; i < def.strips.length; i++) {
      const strip = def.strips[i]!;
      const r = strip.position;
      this.airVelocityAt(r, ve);
      // Slipstream: faster axial flow and swirl inside the contracted tube behind the disk.
      if (r.x < prop.position.x && this.slipRadius > 0) {
        const ry = r.y - prop.position.y;
        const rz = r.z - prop.position.z;
        const d = Math.sqrt(ry * ry + rz * rz);
        const inside =
          (1 - smoothstep(0.8 * this.slipRadius, 1.2 * this.slipRadius, d)) *
          strip.slipstreamDevelopment;
        if (inside > 0) {
          ve.x += this.slipDelta * inside;
          // Air rotating with the propeller: velocity Ω x̂ × r; the strip moves against it.
          ve.y += this.swirl * rz * inside;
          ve.z -= this.swirl * ry * inside;
        }
      }
      if (strip.downwash) ve.z -= this.downwash * ve.x;
      if (strip.wingRoot) {
        // Crossflow over the cabin rises on the windward side of a high wing: the windward
        // root gains angle of attack, which is most of a high wing's dihedral effect.
        const y = r.y;
        ve.z +=
          (crossflow.strength * sideSpeed * crossflow.radius * crossflow.radius) /
          (y * Math.abs(y));
      }
      const uc = dot(ve, strip.chordAxis);
      const un = dot(ve, strip.liftAxis);
      const v2 = uc * uc + un * un;
      const alphaGeo = Math.atan2(-un, uc);
      const alpha = alphaGeo - this.groupInduced[strip.group]!;
      const ctrl = strip.control
        ? this.controlAlpha(strip.control.kind, strip.control.effectiveness, strip.control.side)
        : 0;
      const alphaControl = alpha + def.controls.stallShift * ctrl;
      let alphaSep = alphaControl;
      // Ice roughens the leading edge: the flow separates at a smaller angle. The stall
      // horn's reed does not know that, which is why it warns late on an iced wing.
      if (ice > 0) alphaSep /= 1 - ICE_STALL * ice;
      if (steady) this.separation[i] = staticSeparation(strip.foil, alphaSep);
      const f = this.separation[i]!;
      const c = sectionCoefficients(strip.foil, alpha, ctrl, f, this.coeff);
      if (!steady)
        this.separation[i] = updateSeparation(
          strip.foil,
          f,
          alphaSep,
          Math.sqrt(v2),
          strip.chord,
          dt,
        );
      const cl = c.cl * (strip.liftFactor ?? 1);
      let cd = c.cd;
      if (ice > 0) cd += ICE_DRAG * ice;
      if (strip.control?.kind === 'flap') {
        const sf = Math.sin(this.flap);
        cd += def.controls.flapDrag * sf * sf;
      }
      this.stripCl[i] = cl;
      this.stripAlpha[i] = alphaControl;
      const qS = 0.5 * rho * v2 * strip.area * (strip.qFactor ?? 1);
      // Lift is normal to the effective flow (tilted by the induced angle): induced drag.
      const ca = Math.cos(alpha);
      const sa = Math.sin(alpha);
      const ch = strip.chordAxis;
      const la = strip.liftAxis;
      // Effective flow direction (element motion) is ca*chord - sa*lift; drag opposes it.
      const fx = qS * (cl * (sa * ch.x + ca * la.x) - cd * (ca * ch.x - sa * la.x));
      const fy = qS * (cl * (sa * ch.y + ca * la.y) - cd * (ca * ch.y - sa * la.y));
      const fz = qS * (cl * (sa * ch.z + ca * la.z) - cd * (ca * ch.z - sa * la.z));
      set(this.t2, fx, fy, fz);
      this.addForce(r, this.t2);
      // Section moment about the span axis (chord × lift).
      const m = qS * strip.chord * c.cm;
      cross(this.t3, ch, la);
      addScaled(this.momentBody, this.momentBody, this.t3, m);
    }

    // Induced angle per group from the lift of the groups it listens to.
    for (let g = 0; g < groups.length; g++) {
      let sum = 0;
      let area = 0;
      const from = groups[g]!.inducedFrom;
      for (let i = 0; i < def.strips.length; i++) {
        const sg = def.strips[i]!.group;
        if (from ? from.includes(sg) : sg === g) {
          sum += this.stripCl[i]! * def.strips[i]!.area;
          area += def.strips[i]!.area;
        }
      }
      this.groupCl[g] = sum / area;
    }
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g]!;
      const ge = this.groundEffect(this.groupPoint[g]!, grp.span);
      const target = clamp(
        (this.groupCl[g]! / (Math.PI * grp.aspectRatio * grp.oswald)) * ge,
        -0.3,
        0.3,
      );
      // The induced angle feeds back on the lift that makes it (for a low aspect ratio fin
      // with a loop gain above one). Relaxing by 1 / (1 + gain) is the Newton step of that
      // loop for attached flow: it lands on the fixed point at once instead of ringing.
      this.groupInduced[g]! += (target - this.groupInduced[g]!) * this.inducedRelaxation[g]!;
    }

    this.stallHornAlpha = this.stripAlpha[def.stallWarning.strip]!;

    // Fuselage: parasite drag of everything that is not a strip, crossflow drag at two
    // stations (damping and side force), and the destabilising Munk moments of the body.
    const fus = def.fuselage;
    const vf = this.airVelocityAt(fus.dragPoint, this.t1);
    const vfl = length(vf);
    const dragArea = ice > 0 ? fus.dragArea * (1 + ICE_BODY_DRAG * ice) : fus.dragArea;
    scale(this.t2, vf, -0.5 * rho * vfl * dragArea);
    this.addForce(fus.dragPoint, this.t2);
    for (const [station, share] of [
      [fus.front, fus.frontShare],
      [fus.rear, 1 - fus.frontShare],
    ] as const) {
      const vs = this.airVelocityAt(station, this.t1);
      const perp = Math.sqrt(vs.y * vs.y + vs.z * vs.z);
      const k = -0.5 * rho * fus.crossflowCd * share * perp;
      set(this.t2, 0, k * fus.sideArea * vs.y, k * fus.planArea * vs.z);
      this.addForce(station, this.t2);
    }
    const q = 0.5 * rho * speed * speed;
    const uw = vc.x * vc.x + vc.z * vc.z;
    const uv = vc.x * vc.x + vc.y * vc.y;
    if (uw > 1)
      this.momentBody.y += q * def.wingArea * def.meanChord * fus.pitchMunk * ((vc.x * vc.z) / uw);
    if (uv > 1)
      this.momentBody.z -= q * def.wingArea * def.wingSpan * fus.yawMunk * ((vc.x * vc.y) / uv);
  }

  private engineStep(dt: number, steady: boolean, starter = false) {
    const c = this.controls;
    const air = this.air[0]!;
    const hasFuel = this.systems.fuel.engineHasFuel;
    if (steady) {
      // Shaft speed where engine and propeller torque balance (bisection).
      let lo = 0;
      let hi = 420;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        this.engine.omega = mid;
        this.engine.running = true;
        const e = this.engine.evaluate(
          c.throttle[0] ?? 0,
          c.mixture[0] ?? 1,
          false,
          air.pressure,
          air.temperature,
          air.density,
          hasFuel,
          this.engineOut,
        );
        const prop = this.propeller(mid, air.density, false);
        if (e.torque - prop > 0) lo = mid;
        else hi = mid;
      }
      this.engine.omega = (lo + hi) / 2;
    }
    const e = this.engine.evaluate(
      c.throttle[0] ?? 0,
      c.mixture[0] ?? 1,
      starter,
      air.pressure,
      air.temperature,
      air.density,
      hasFuel,
      this.engineOut,
    );
    const absorbed = this.propeller(this.engine.omega, air.density, true);
    this.propTorque = absorbed;
    if (!steady) {
      this.engine.omega += ((e.torque - absorbed) / this.def.engine.inertia) * dt;
      // A fixed-pitch propeller on a piston engine never turns backwards.
      if (this.engine.omega < 0) this.engine.omega = 0;
    }
    this.fuelFlow = e.fuelFlow;
    this.enginePower = Math.max(0, e.power);
    // Reaction of the engine torque on the airframe rolls it against the propeller.
    this.momentBody.x -= e.torque;
  }

  // ---------------------------------------------------------------------------------------
  // Gear and ground contact

  /** Samples the ground under a body point into a local plane. */
  private sampleGround(env: Environment, p: Vec3, plane: Plane): void {
    const w = rotate(this.t0, this.state.orientation, p);
    add(w, w, this.state.position);
    const g = env.ground(w);
    if (!g) {
      plane.valid = false;
      return;
    }
    this.setPlane(env, w, g, plane);
  }

  private setPlane(env: Environment, w: Vec3, g: GroundSample, plane: Plane) {
    const up = env.up(w, this.t1);
    const h = env.altitude(w) - g.height;
    addScaled(plane.point, w, up, -h);
    copy(plane.normal, g.normal);
    plane.surface = g.surface;
    plane.wetness = g.wetness;
    plane.valid = true;
  }

  /** Gear and contact forces for the current state, world frame (force) and body (moment). */
  private contactForces(dt: number) {
    const s = this.state;
    const def = this.def;
    set(this.gearForce, 0, 0, 0);
    set(this.gearMoment, 0, 0, 0);
    this.wheelsLoaded = 0;
    const arm = this.t0;
    const pv = this.t1;
    const tmp = this.t2;
    for (let i = 0; i < def.wheels.length; i++) {
      const wheel = def.wheels[i]!;
      const plane = this.wheelPlanes[i]!;
      if (!plane.valid) {
        this.compression[i] = 0;
        this.bristleLat[i] = 0;
        this.bristleLong[i] = 0;
        continue;
      }
      rotate(arm, s.orientation, wheel.position);
      // Penetration of the extended tyre bottom into the ground plane.
      add(tmp, arm, s.position);
      sub(tmp, plane.point, tmp);
      const depth = dot(tmp, plane.normal);
      if (depth <= 0) {
        this.compression[i] = 0;
        this.bristleLat[i] = 0;
        this.bristleLong[i] = 0;
        continue;
      }
      this.wheelForce(i, wheel, plane, arm, depth, pv, dt);
    }
    for (let i = 0; i < def.contacts.length; i++) {
      const plane = this.contactPlanes[i]!;
      if (!plane.valid) continue;
      const cp = def.contacts[i]!;
      rotate(arm, s.orientation, cp.position);
      add(tmp, arm, s.position);
      sub(tmp, plane.point, tmp);
      const depth = dot(tmp, plane.normal);
      if (depth <= 0) {
        this.contactTouching[i] = 0;
        continue;
      }
      this.contactForce(i, cp, plane, arm, depth, pv);
    }
  }

  private pointVelocity(arm: Vec3, out: Vec3): Vec3 {
    const s = this.state;
    rotate(out, s.orientation, s.angularVelocity);
    cross(out, out, arm);
    return add(out, out, s.velocity);
  }

  private applyGround(arm: Vec3, f: Vec3) {
    add(this.gearForce, this.gearForce, f);
    const m = cross(this.t3, arm, f);
    add(this.gearMoment, this.gearMoment, m);
  }

  private wheelForce(
    i: number,
    wheel: WheelDef,
    plane: Plane,
    arm: Vec3,
    depth: number,
    pv: Vec3,
    dt: number,
  ) {
    const n = plane.normal;
    this.pointVelocity(arm, pv);
    const rate = -dot(pv, n);
    let normal = wheel.spring * Math.min(depth, wheel.travel) + wheel.damper * rate;
    // Bottoming out: the tyre and the structure take over, much stiffer.
    if (depth > wheel.travel)
      normal += 20 * wheel.spring * (depth - wheel.travel) + 4 * wheel.damper * rate;
    normal = Math.max(0, normal);
    this.compression[i] = depth;
    if (normal > wheel.breakingForce) this.crash('gear');
    if (plane.surface === 'water' && length(pv) > 2) this.crash('water');
    if (normal > 0) this.wheelsLoaded++;

    // Rolling direction: body x turned by the steering angle, laid into the ground plane.
    const steer = (wheel.steering ?? 0) * clamp(this.controls.yaw, -1, 1);
    const fwd = this.t2;
    set(fwd, Math.cos(steer), Math.sin(steer), 0);
    rotate(fwd, this.state.orientation, fwd);
    addScaled(fwd, fwd, n, -dot(fwd, n));
    normalize(fwd, fwd);
    const side = cross(this.t4, fwd, n);
    const vLong = dot(pv, fwd);
    const vLat = dot(pv, side);

    const surf = SURFACES[plane.surface];
    const mu = surf.dry + (surf.wet - surf.dry) * plane.wetness;
    const rolling = surf.rolling * (1 + plane.wetness);
    const c = this.controls;
    const pedal = wheel.brake === 'left' ? c.brakeLeft : wheel.brake === 'right' ? c.brakeRight : 0;
    // Brake pads hold a standing wheel harder than they slow a turning one (static friction
    // of the pads): the brakes hold a full-power run-up but still let a landing roll out.
    const stiction = 1 + 0.5 * (1 - smoothstep(0.05, 0.5, Math.abs(vLong)));
    const brake = (c.parkingBrake ? 1 : clamp(pedal, 0, 1)) * (wheel.brakeForce ?? 0) * stiction;

    // Tyre as a bristle: a spring that holds the aircraft still on a slope or against idle
    // thrust, and that relaxes over a rolling length so a rolling tyre grips by slip angle.
    let lat =
      this.bristleLat[i]! + (vLat - (Math.abs(vLong) * this.bristleLat[i]!) / TYRE_RELAXATION) * dt;
    const latDamping = TYRE_DAMPING / (1 + Math.abs(vLong) / 0.5);
    let fLat = -(TYRE_STIFFNESS * lat + latDamping * vLat);
    const capLat = mu * normal;
    if (Math.abs(fLat) > capLat) {
      fLat = Math.sign(fLat) * capLat;
      lat = clamp(lat, -capLat / TYRE_STIFFNESS, capLat / TYRE_STIFFNESS);
    }
    let lon = this.bristleLong[i]! + vLong * dt;
    let fLon = -(TYRE_STIFFNESS * lon + TYRE_DAMPING * vLong);
    const capLon = Math.min(mu * normal, rolling * normal + brake);
    if (Math.abs(fLon) > capLon) {
      fLon = Math.sign(fLon) * capLon;
      lon = clamp(lon, -capLon / TYRE_STIFFNESS, capLon / TYRE_STIFFNESS);
    }
    // Friction circle: braking and cornering share the grip.
    const total = Math.hypot(fLon, fLat);
    if (total > capLat && total > 0) {
      fLon *= capLat / total;
      fLat *= capLat / total;
    }
    this.bristleLat[i] = lat;
    this.bristleLong[i] = lon;
    const f = this.t3;
    set(
      f,
      n.x * normal + fwd.x * fLon + side.x * fLat,
      n.y * normal + fwd.y * fLon + side.y * fLat,
      n.z * normal + fwd.z * fLon + side.z * fLat,
    );
    copy(this.t4, f);
    this.applyGround(arm, this.t4);
  }

  private contactForce(
    i: number,
    cp: ContactPoint,
    plane: Plane,
    arm: Vec3,
    depth: number,
    pv: Vec3,
  ) {
    const n = plane.normal;
    this.pointVelocity(arm, pv);
    const rate = -dot(pv, n);
    if (!this.contactTouching[i]) {
      this.contactTouching[i] = 1;
      if (rate > cp.crashSpeed || cp.crashSpeed === 0) this.crash(cp.reason);
    }
    if (depth > (cp.maxDepth ?? 0.3)) this.crash(cp.reason);
    const normal = Math.max(0, 200_000 * depth + 20_000 * rate);
    // Scraping: Coulomb friction against the sliding velocity.
    const f = this.t3;
    addScaled(f, pv, n, -dot(pv, n));
    const slide = length(f);
    scale(f, f, slide > 1e-6 ? (-0.5 * normal * Math.tanh(slide / 0.2)) / slide : 0);
    addScaled(f, f, n, normal);
    copy(this.t4, f);
    this.applyGround(arm, this.t4);
  }

  private crash(reason: string) {
    if (!this.crashed) this.crashed = reason;
  }

  // ---------------------------------------------------------------------------------------
  // Step

  step(dt: number, env: Environment): void {
    const s = this.state;
    this.time += dt;
    if (this.crashed) {
      this.fillTelemetry(env);
      return;
    }
    env.up(s.position, this.up);

    // Ground under the centre of gravity.
    const g = env.ground(s.position);
    if (!g) {
      this.cgPlane.valid = false;
      if (this.held || this.placeWhenGroundLoads || this.telemetry.onGround) {
        // Terrain not loaded under an aircraft on the ground: hold it rather than let it sink.
        this.held = true;
        set(s.velocity, 0, 0, 0);
        set(s.angularVelocity, 0, 0, 0);
        this.fillTelemetry(env);
        return;
      }
    } else {
      this.setPlane(env, s.position, g, this.cgPlane);
      if (this.placeWhenGroundLoads && this.heldStart) {
        this.placeWhenGroundLoads = false;
        this.placeOnGround(this.heldStart, env, g);
      }
      this.held = false;
    }

    rotateInverse(this.vBody, s.orientation, s.velocity);
    this.sampleAir(env);
    const air = this.air[0]!;
    const vc = sub(this.t0, this.vBody, this.windBody[0]!);
    const q = 0.5 * air.density * dot(vc, vc);
    const tas = length(vc);
    this.stepAvionics(dt, env);
    const starter = this.systems.beforeEngine(
      dt,
      this.engine,
      this.controls.starter?.[0] ?? false,
      this.time,
    );
    this.moveSurfaces(dt, q);

    this.aerodynamics(dt, false);
    this.engineStep(dt, false, starter);
    this.fuelImbalance();

    // Fuel burns off and lightens the aircraft; the systems follow the engine.
    const ae = this.afterEngine;
    ae.fuelFlow = this.fuelFlow;
    ae.load = this.enginePower / this.def.engine.ratedPower;
    ae.tas = tas;
    ae.slipstream = this.slipDelta;
    ae.phi = this.engine.equivalenceRatio(this.controls.mixture[0] ?? 1, air.density);
    this.systems.afterEngine(dt, this.engine, ae, air);

    const agl = this.cgPlane.valid ? this.heightAboveGround(ORIGIN) : Infinity;
    if (agl < 0) this.crash('terrain');
    const near = agl < CONTACT_RANGE;
    if (near) {
      for (let i = 0; i < this.def.wheels.length; i++)
        this.sampleGround(env, this.def.wheels[i]!.position, this.wheelPlanes[i]!);
      for (let i = 0; i < this.def.contacts.length; i++)
        this.sampleGround(env, this.def.contacts[i]!.position, this.contactPlanes[i]!);
    } else {
      for (const p of this.wheelPlanes) p.valid = false;
      for (const p of this.contactPlanes) p.valid = false;
      this.contactTouching.fill(0);
    }

    this.integrate(dt, env, near ? GEAR_SUBSTEPS : 1);
    this.checkStructure();
    if (this.crashed) {
      set(s.velocity, 0, 0, 0);
      set(s.angularVelocity, 0, 0, 0);
      this.engine.omega = 0;
      this.engine.running = false;
    }
    this.fillTelemetry(env);
    this.updateInstruments(env, dt);
  }

  /**
   * The avionics unit sees the aircraft as it was at the end of the last step; while its
   * autopilot is engaged it flies pitch and roll, and it turns the trim wheel itself (so the
   * trim stays where it left it when it lets go).
   */
  private stepAvionics(dt: number, env: Environment) {
    const c = this.controls;
    this.pitchIn = c.pitch;
    this.rollIn = c.roll;
    const unit = this.avionicsUnit;
    if (!unit) return;
    const t = this.telemetry;
    const s = this.state;
    const i = this.avionicsInput;
    const shown = this.systems.instruments.telemetry;
    i.powered = this.systems.electrical.avionicsPowered;
    i.com1Failed = this.failures.active('com1');
    i.lon = Math.atan2(s.position.y, s.position.x) / DEG;
    // The local vertical is the ellipsoid normal: its z component is the sine of latitude.
    i.lat = Math.asin(clamp(this.up.z, -1, 1)) / DEG;
    i.altitude = t.altitude - (env.geoidHeight?.(s.position) ?? 0);
    i.heading = t.headingDeg;
    i.track = t.trackDeg;
    i.groundSpeed = t.groundSpeed;
    i.verticalSpeed = t.verticalSpeed;
    i.ias = t.ias;
    i.pitch = t.pitch;
    i.bank = t.bank;
    const w = s.angularVelocity;
    i.turnRate =
      (w.y * Math.sin(t.bank) + w.z * Math.cos(t.bank)) / Math.max(Math.cos(t.pitch), 0.1) / DEG;
    i.onGround = t.onGround;
    i.declination = env.magneticDeclination?.(s.position) ?? 0;
    i.indicatedHeading = shown.heading;
    i.indicatedAltitude = shown.altitude;
    i.pilotPitch = c.pitch;
    i.pilotRoll = c.roll;
    unit.step(dt, i, this.cockpit);
    t.avionics = unit.telemetry;
    const cmd = unit.command;
    if (cmd) {
      this.pitchIn = cmd.pitch;
      this.rollIn = cmd.roll;
      c.pitchTrim = clamp(cmd.pitchTrim, -1, 1);
    }
  }

  /**
   * Fuel in one wing heavier than in the other: its weight acts off the centre line and
   * rolls the aircraft towards the heavy wing.
   */
  private fuelImbalance() {
    const f = this.systems.fuel;
    const dm = f.right - f.left;
    if (dm === 0) return;
    const upBody = rotateInverse(this.t0, this.state.orientation, this.up);
    const arm = this.def.systems.fuel.tankArm;
    // Weight -dm g up acting at y = arm: moment arm × force.
    this.momentBody.x -= arm * dm * G0 * upBody.z;
    this.momentBody.z += arm * dm * G0 * upBody.x;
  }

  /** The instruments read the truth of this step through their own physics. */
  private updateInstruments(env: Environment, dt: number, resetRunning?: boolean) {
    const s = this.state;
    const t = this.telemetry;
    const i = this.systems.instrumentInput;
    const air = this.air[0]!;
    i.pitch = t.pitch;
    i.bank = t.bank;
    i.headingDeg = t.headingDeg;
    i.p = s.angularVelocity.x;
    i.q = s.angularVelocity.y;
    i.r = s.angularVelocity.z;
    i.ias = t.ias;
    i.staticPressure = air.pressure;
    i.density = air.density;
    copy(i.up, this.up);
    copy(i.north, this.north);
    rotate(i.forward, s.orientation, X_AXIS);
    copy(i.specificForce, this.specificForce);
    i.lateralSpecificForce = this.specificForceY;
    i.latitude = Math.asin(clamp(this.up.z, -1, 1)) / DEG;
    i.declination = env.magneticDeclination?.(s.position) ?? 0;
    if (resetRunning === undefined) this.systems.stepInstruments(dt);
    else this.systems.resetInstruments(resetRunning);
  }

  private integrate(dt: number, env: Environment, substeps: number) {
    const s = this.state;
    const def = this.def;
    const m = this.mass;
    const h = dt / substeps;
    const alt = env.altitude(s.position);
    const g = G0 * (EARTH_RADIUS / (EARTH_RADIUS + alt)) ** 2;
    const aeroWorld = rotate(this.aeroWorld, s.orientation, this.forceBody);
    const I = def.inertia;
    const hProp = def.engine.inertia * this.engine.omega;
    const accel = this.accel;
    const mBody = this.mBody;
    let specific = 0;
    let specificY = 0;
    const sf = set(this.specificForce, 0, 0, 0);
    for (let k = 0; k < substeps; k++) {
      this.contactForces(h);
      add(accel, aeroWorld, this.gearForce);
      // Specific force (before gravity): along body z for the load factor, across for the
      // ball, and whole for the compass card.
      addScaled(sf, sf, accel, 1 / (m * substeps));
      const body = rotateInverse(this.t0, s.orientation, accel);
      specific += body.z / m;
      specificY += body.y / m;
      scale(accel, accel, 1 / m);
      addScaled(accel, accel, this.up, -g);
      addScaled(s.velocity, s.velocity, accel, h);
      addScaled(s.position, s.position, s.velocity, h);

      rotateInverse(mBody, s.orientation, this.gearMoment);
      add(mBody, mBody, this.momentBody);
      const w = s.angularVelocity;
      // Euler's equations with the spinning propeller's angular momentum along x.
      const hx = I.x * w.x + hProp;
      const hy = I.y * w.y;
      const hz = I.z * w.z;
      const gx = w.y * hz - w.z * hy;
      const gy = w.z * hx - w.x * hz;
      const gz = w.x * hy - w.y * hx;
      w.x += ((mBody.x - gx) / I.x) * h;
      w.y += ((mBody.y - gy) / I.y) * h;
      w.z += ((mBody.z - gz) / I.z) * h;
      integrateOrientation(s.orientation, w, h);
    }
    this.specificForceZ = specific / substeps;
    this.specificForceY = specificY / substeps;
  }

  private checkStructure() {
    const n = -this.specificForceZ / G0;
    const lim = this.def.ultimateLoad;
    if (n > lim.positive || n < lim.negative) this.crash('overstress');
  }

  // ---------------------------------------------------------------------------------------
  // Telemetry

  private fillTelemetry(env: Environment) {
    const s = this.state;
    const t = this.telemetry;
    const def = this.def;
    const up = env.up(s.position, this.up);
    const north = env.north(s.position, this.north);
    const east = cross(this.t2, north, up);
    t.time = this.time;
    t.altitude = env.altitude(s.position);
    rotateInverse(this.vBody, s.orientation, s.velocity);
    const air = this.air[0]!;
    const va = sub(this.t0, this.vBody, this.windBody[0]!);
    const tas = length(va);
    t.tas = tas;
    const cas = tas * Math.sqrt(air.density / SEA_LEVEL_DENSITY);
    t.ias = this.indicated(cas);
    t.alpha = Math.atan2(va.z, va.x);
    t.beta = tas > 0.1 ? Math.asin(clamp(va.y / tas, -1, 1)) : 0;
    t.verticalSpeed = dot(s.velocity, up);
    const vn = dot(s.velocity, north);
    const vEast = dot(s.velocity, east);
    t.groundSpeed = Math.hypot(vn, vEast);
    t.trackDeg = t.groundSpeed > 0.1 ? (Math.atan2(vEast, vn) / DEG + 360) % 360 : t.headingDeg;
    const bx = rotate(this.t1, s.orientation, X_AXIS);
    t.headingDeg = (Math.atan2(dot(bx, east), dot(bx, north)) / DEG + 360) % 360;
    t.pitch = Math.asin(clamp(dot(bx, up), -1, 1));
    const by = rotate(this.t1, s.orientation, Y_AXIS);
    const byUp = dot(by, up);
    const bz = rotate(this.t1, s.orientation, Z_AXIS);
    t.bank = Math.atan2(-byUp, -dot(bz, up));
    t.loadFactor = -this.specificForceZ / G0;
    // Height of the lowest wheel bottom above the ground.
    if (this.cgPlane.valid && !this.held) {
      let lowest = Infinity;
      for (let i = 0; i < def.wheels.length; i++) {
        const plane = this.wheelPlanes[i]!.valid ? this.wheelPlanes[i]! : this.cgPlane;
        const w = rotate(this.t3, s.orientation, def.wheels[i]!.position);
        add(w, w, s.position);
        sub(w, w, plane.point);
        lowest = Math.min(lowest, dot(w, plane.normal));
      }
      t.agl = Math.max(0, lowest);
    } else t.agl = undefined;
    t.onGround = this.held || this.compression.some((c) => c > 0);
    t.stallWarning = this.stallHornAlpha > def.stallWarning.alpha && tas > 10 && !this.crashed;
    t.flaps = this.flap / def.controls.flapDetents[def.controls.flapDetents.length - 1]!;
    t.gear = 1;
    const c = def.controls;
    t.elevator = this.elevator >= 0 ? this.elevator / c.elevatorUp : this.elevator / c.elevatorDown;
    t.aileron = this.aileron;
    t.rudder = this.rudder;
    const e = t.engines[0]!;
    e.running = this.engine.running;
    e.rpm = this.engine.rpm;
    e.power = this.enginePower / def.engine.ratedPower;
    e.fuelFlow = this.engine.running ? this.fuelFlow : 0;
    t.fuel = this.fuel;
    t.crashed = this.crashed;
  }

  /** Indicated airspeed from calibrated through the handbook calibration, by flap position. */
  private indicated(cas: number): number {
    const cal = this.def.airspeedCalibration;
    const detents = this.def.controls.flapDetents;
    const kcas = cas / KT;
    let i = 0;
    while (i < detents.length - 2 && this.flap > detents[i + 1]!) i++;
    const a = lookup(cal[i]!, kcas);
    const b = lookup(cal[i + 1]!, kcas);
    const t = clamp((this.flap - detents[i]!) / (detents[i + 1]! - detents[i]!), 0, 1);
    return (a + (b - a) * t) * KT;
  }

  // ---------------------------------------------------------------------------------------
  // Reset

  reset(start: InitialCondition, env: Environment): void {
    const s = this.state;
    this.time = 0;
    this.crashed = undefined;
    this.held = false;
    this.placeWhenGroundLoads = false;
    this.heldStart = undefined;
    const running = start.enginesRunning ?? true;
    // Every switch to the start condition. The flap lever is kept: a start in the air or on
    // the runway is asked for with the flaps it should have (set before the reset).
    const flapLever = this.controls.flaps;
    this.cockpit.reset(running);
    this.controls.flaps = flapLever;
    if (running) this.setRunningLights(start.onGround);
    this.sampleAirAt(env, start.position);
    this.systems.reset(running, !start.onGround, this.air[0]!);
    this.avionicsUnit?.reset();
    this.telemetry.avionics = this.avionicsUnit?.telemetry;
    this.separation.fill(1);
    this.stripCl.fill(0);
    this.groupCl.fill(0);
    this.groupInduced.fill(0);
    this.downwash = 0;
    this.bristleLat.fill(0);
    this.bristleLong.fill(0);
    this.compression.fill(0);
    this.contactTouching.fill(0);
    this.thrust = 0;
    this.propTorque = 0;
    set(s.angularVelocity, 0, 0, 0);
    const c = this.controls;
    c.pitch = 0;
    c.roll = 0;
    c.yaw = 0;
    c.brakeLeft = 0;
    c.brakeRight = 0;
    c.gearDown = true;
    if (c.starter) c.starter[0] = false;
    this.pitchIn = 0;
    this.rollIn = 0;
    this.engine.running = running;
    this.engine.omega = 0;
    // Bus, ignition and fuel supply as the switches now stand, before anything is trimmed.
    this.systems.beforeEngine(0, this.engine, false, 0);
    this.flap = this.flapTarget();
    this.aileron = this.def.controls.aileronRigging;
    this.rudder = this.def.controls.rudderRigging;
    if (start.onGround) {
      c.throttle[0] = 0;
      c.pitchTrim = 0;
      this.elevator = this.elevatorTarget();
      this.engine.omega = running ? 650 * ((2 * Math.PI) / 60) : 0;
      const g = env.ground(start.position);
      if (g) this.placeOnGround(start, env, g);
      else {
        // Stand at the given point until the terrain arrives, then settle on the wheels.
        this.heldStart = { ...start, position: { ...start.position } };
        this.placeWhenGroundLoads = true;
        this.held = true;
        this.orient(env, start.position, start.headingDeg, 0, undefined);
        copy(s.position, start.position);
        set(s.velocity, 0, 0, 0);
      }
    } else {
      this.trimInAir(start, env, running);
    }
    this.sampleAir(env);
    env.up(s.position, this.up);
    scale(this.specificForce, this.up, G0);
    this.specificForceY = 0;
    this.specificForceZ = -G0;
    // Once more with the engine turning: the alternator now carries the bus.
    this.systems.beforeEngine(0, this.engine, false, 0);
    this.fillTelemetry(env);
    this.systems.fillTelemetry();
    this.updateInstruments(env, 0, running);
  }

  /** Lights as a pilot has them: lined up on the runway, or cruising. */
  private setRunningLights(onGround: boolean) {
    const p = this.cockpit;
    p.set('lightBeacon', 1);
    p.set('lightNav', 1);
    p.set('lightStrobe', 1);
    p.set('lightLanding', onGround ? 1 : 0);
    p.set('lightTaxi', onGround ? 1 : 0);
  }

  /** Orientation from heading and pitch, laid on a ground normal if given (bank 0 otherwise). */
  private orient(
    env: Environment,
    p: Vec3,
    headingDeg: number,
    pitch: number,
    normal: Vec3 | undefined,
  ) {
    const up = env.up(p, vec());
    const north = env.north(p, vec());
    const east = cross(vec(), north, up);
    const h = headingDeg * DEG;
    const fwd = addScaled(vec(), scale(vec(), north, Math.cos(h)), east, Math.sin(h));
    const ref = normal ?? up;
    // Forward laid into the reference plane, then pitched about the right axis.
    addScaled(fwd, fwd, ref, -dot(fwd, ref));
    normalize(fwd, fwd);
    const right = cross(vec(), fwd, ref);
    normalize(right, right);
    const bx = addScaled(vec(), scale(vec(), fwd, Math.cos(pitch)), ref, Math.sin(pitch));
    const bz = cross(vec(), bx, right);
    quatFromAxes(this.state.orientation, bx, right, bz);
  }

  /**
   * Places the aircraft at rest on its wheels: strut loads from the moment balance on the
   * wheel base, compressions from the springs, attitude from the compressed wheel heights.
   */
  private placeOnGround(start: InitialCondition, env: Environment, g: GroundSample) {
    const s = this.state;
    const wheels = this.def.wheels;
    const nose = wheels.find((w) => w.steering !== undefined) ?? wheels[0]!;
    const mains = wheels.filter((w) => w !== nose);
    const xMain = mains.reduce((a, w) => a + w.position.x, 0) / mains.length;
    const weight = this.mass * G0;
    const noseLoad = (weight * -xMain) / (nose.position.x - xMain);
    const mainLoad = (weight - noseLoad) / mains.length;
    const zNose = nose.position.z - noseLoad / nose.spring;
    const zMain = mains.reduce((a, w) => a + w.position.z - mainLoad / w.spring, 0) / mains.length;
    // Pitch so both compressed wheel bottoms lie on the ground (z grows downwards).
    const pitch = Math.atan2(zNose - zMain, nose.position.x - xMain);
    const groundPoint = vec();
    const tmpPlane = newPlane();
    this.setPlane(env, start.position, g, tmpPlane);
    copy(groundPoint, tmpPlane.point);
    this.orient(env, groundPoint, start.headingDeg, pitch, g.normal);
    // Height of the centre above the plane: the compressed main wheel bottom touches it.
    const heightCg = zMain * Math.cos(pitch) - xMain * Math.sin(pitch);
    // Report the static strut compressions until the first step computes them.
    wheels.forEach((w, i) => {
      this.compression[i] = (w === nose ? noseLoad : mainLoad) / w.spring;
    });
    addScaled(s.position, groundPoint, g.normal, heightCg);
    set(s.velocity, 0, 0, 0);
    set(s.angularVelocity, 0, 0, 0);
  }

  /**
   * Places the aircraft in level flight at the given true airspeed and solves angle of
   * attack, elevator (as pitch trim) and throttle so forces and pitching moment balance.
   * The solved throttle and trim are written into `controls`.
   */
  private trimInAir(start: InitialCondition, env: Environment, running: boolean) {
    const s = this.state;
    const c = this.controls;
    copy(s.position, start.position);
    const speed = Math.max(start.speed, 15);
    const up = env.up(s.position, vec());
    const north = env.north(s.position, vec());
    const east = cross(vec(), north, up);
    const h = start.headingDeg * DEG;
    const dir = addScaled(vec(), scale(vec(), north, Math.cos(h)), east, Math.sin(h));
    this.cgPlane.valid = false;
    const g = env.ground(s.position);
    if (g) this.setPlane(env, s.position, g, this.cgPlane);
    for (const p of this.wheelPlanes) p.valid = false;
    for (const p of this.contactPlanes) p.valid = false;

    const residual = (x: number[], out: number[]) => {
      const [alpha, elev, thr] = x as [number, number, number];
      this.orient(env, s.position, start.headingDeg, alpha, undefined);
      // Air-relative velocity along the heading; the wind is added on top.
      this.sampleAirAt(env);
      addScaled(s.velocity, this.air[0]!.wind, dir, speed);
      rotateInverse(this.vBody, s.orientation, s.velocity);
      this.sampleAir(env);
      this.elevator = elev;
      c.throttle[0] = clamp(thr, 0, 1);
      for (let k = 0; k < 8; k++) {
        this.aerodynamics(0, true);
        if (running) this.engineStep(0, true);
        else {
          this.engine.omega = 0;
          this.engineStep(0, false);
        }
      }
      const grav = rotateInverse(vec(), s.orientation, scale(vec(), up, -G0 * this.mass));
      const m = this.mass * G0;
      out[0] = (this.forceBody.x + grav.x) / m;
      out[1] = (this.forceBody.z + grav.z) / m;
      out[2] = this.momentBody.y / (m * this.def.meanChord);
      // Beyond full throttle the residual keeps pulling, so the solver settles at the limit.
      if (thr > 1) out[0] -= (thr - 1) * 0.5;
      if (thr < 0) out[0] -= thr * 0.5;
    };

    const x = [4 * DEG, 0, 0.6];
    const r = [0, 0, 0];
    const r2 = [0, 0, 0];
    for (let iter = 0; iter < 30; iter++) {
      residual(x, r);
      if (Math.abs(r[0]!) + Math.abs(r[1]!) + Math.abs(r[2]!) < 1e-7) break;
      const J: number[][] = [[], [], []];
      const steps = [1e-4, 1e-4, 1e-3];
      for (let j = 0; j < 3; j++) {
        const xp = [...x];
        xp[j]! += steps[j]!;
        residual(xp, r2);
        for (let i = 0; i < 3; i++) J[i]![j] = (r2[i]! - r[i]!) / steps[j]!;
      }
      const dx = solve3(J, r);
      const limit = [3 * DEG, 3 * DEG, 0.3];
      for (let j = 0; j < 3; j++) x[j]! -= clamp(dx[j]!, -limit[j]!, limit[j]!);
      x[0] = clamp(x[0]!, -10 * DEG, 25 * DEG);
      x[1] = clamp(x[1]!, -this.def.controls.elevatorDown, this.def.controls.elevatorUp);
    }
    residual(x, r);
    const cc = this.def.controls;
    const elev = x[1]!;
    c.pitchTrim = clamp(elev >= 0 ? elev / cc.trimUp : elev / cc.trimDown, -1, 1);
    c.throttle[0] = clamp(x[2]!, 0, 1);
    // Whatever trim cannot reach stays with the surface for now; the pilot must hold it.
    this.elevator = elev;
    set(s.angularVelocity, 0, 0, 0);
    if (!running) this.engine.running = false;
  }

  private sampleAirAt(env: Environment, position: Vec3 = this.state.position) {
    env.air(position, this.air[0]!);
  }
}

/** Solves J dx = r for a 3x3 system (Cramer's rule). */
function solve3(J: number[][], r: number[]): number[] {
  const a = J as [[number, number, number], [number, number, number], [number, number, number]];
  const det = (m: typeof a) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(a);
  if (Math.abs(d) < 1e-14) return [0, 0, 0];
  const out = [0, 0, 0];
  for (let j = 0; j < 3; j++) {
    const m = a.map((row, i) => row.map((v, k) => (k === j ? r[i]! : v))) as typeof a;
    out[j] = det(m) / d;
  }
  return out;
}
