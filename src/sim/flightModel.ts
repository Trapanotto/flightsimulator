/**
 * Generic strip-theory flight model. Every lifting strip, the fuselage and the propeller
 * quadrants see their own airflow (aircraft motion, rotation, local wind, slipstream and
 * swirl, wing downwash, crossflow around the cabin); stall, wing drop, spin, ground effect,
 * adverse yaw, P-factor and crosswind behaviour come out of that instead of being added.
 * Sections that fly fast carry their compressibility (Prandtl-Glauert lift, drag rise and
 * wave drag, the aft shift of the centre of pressure, the loss of control power), swept
 * strips work on the flow normal to their span, and strakes add vortex lift.
 *
 * A type is data (`AircraftDefinition`) plus, where it needs one, a module of its own: its
 * engines are `Powerplant`s, its control law turns the pilot's input into surface commands,
 * its avionics unit carries its autopilot.
 *
 * Integration: aerodynamics and engines once per fixed step, then the rigid body in sub-steps
 * with the gear and contact points recomputed each sub-step (they are stiff). Semi-implicit
 * Euler, which keeps the phugoid and the gear oscillation from gaining energy.
 */
import type { Avionics, AvionicsInput, AvionicsUnit } from './avionicsTypes';
import { C172_CONTROLS, CockpitPanel, type ControlSpec } from './cockpit';
import {
  createControlLaw,
  newSurfaceCommand,
  trimAngle,
  type ControlLaw,
  type ControlLawContext,
  type TypeSystemsContext,
} from './controlLaw';
import { AircraftSystems } from './systems/systems';
import { ALL_FAILURES, FailureSet } from './systems/failures';
import {
  machEffects,
  sectionCoefficients,
  staticSeparation,
  updateSeparation,
  vortexLift,
  type MachEffects,
  type SectionCoefficients,
} from './airfoil';
import type { AircraftDefinition, ContactPoint, StripControl, WheelDef } from './definition';
import {
  bladeForces,
  createPowerplant,
  newPowerplantInput,
  propellerForces,
  type EngineDef,
  type Powerplant,
  type PowerplantInput,
  type PropellerData,
  type PropellerMount,
  type PropellerOutput,
  type Rotor,
} from './propulsion';
import type { PistonPowerplant } from './propulsion/piston';
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
  Exceedance,
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
const SEA_LEVEL_PRESSURE = 101_325;
const SEA_LEVEL_SOUND = 340.294;
const R_AIR = 287.053;
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
/** The gear counts as down and locked from here; below, the wheels carry nothing. */
const GEAR_LOCKED = 0.999;

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

/** A propeller on the airframe and what it did in the last step. */
interface PropState {
  /** Index of the engine that turns it. */
  engine: number;
  data: PropellerData & PropellerMount;
  position: Vec3;
  /** +1 clockwise seen from behind. */
  rotation: number;
  thrust: number;
  torque: number;
  slipDelta: number;
  slipRadius: number;
  swirl: number;
  /** Induced velocity of each quadrant (variable pitch), carried between calls. */
  inflow: { vi: number }[];
  rotor: Rotor;
}

/** The propeller of an engine definition, if it has one. */
function propellerOf(def: EngineDef): (PropellerData & PropellerMount) | undefined {
  return def.kind === 'piston' || def.kind === 'turboprop' ? def.propeller : undefined;
}

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
  readonly cockpit: CockpitPanel;
  readonly failures: FailureSet;
  /**
   * The avionics (radios, navigation, transponder, GPS, autopilot), plugged in by whoever
   * builds the aircraft. Without one the aircraft flies as before, with dark avionics.
   */
  avionicsUnit: AvionicsUnit | undefined;
  readonly systems: AircraftSystems;
  /** The engines, in the order of the definition. */
  readonly engines: Powerplant[];
  readonly controlLaw: ControlLaw;

  private time = 0;
  private crashed: string | undefined;
  /** Waiting for the terrain to load while standing: the aircraft is held in place. */
  private held = false;
  private placeWhenGroundLoads = false;
  private heldStart: InitialCondition | undefined;

  // Control surface positions actually reached.
  private elevator = 0; // rad, positive nose up (trailing edge up), a tab's trim included
  private stabiliser = 0; // rad, positive nose up (movable stabiliser)
  private aileron = 0; // -1..1, positive roll right
  private rudder = 0; // -1..1, positive nose right
  private flap = 0; // rad
  private slat = 0; // rad
  private spoiler = 0; // 0..1
  private speedbrake = 0; // 0..1
  private differentialTail = 0; // -1..1
  /** Gear 0 up .. 1 down and locked. */
  private gear = 1;
  private readonly surfaceCommand = newSurfaceCommand();
  private readonly lawContext: ControlLawContext & {
    telemetry: Telemetry;
    pitch: number;
    roll: number;
    yaw: number;
    q: number;
    mach: number;
    vaneAlpha: number;
    powered: boolean;
    yawDamper: boolean;
    stallProtection: boolean;
    dt: number;
  };
  private readonly systemsContext: TypeSystemsContext & { dt: number };
  /** Every device of each strip (its `controls`, or its one `control`). */
  private readonly stripControls: StripControl[][];

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
  private mach = 0;
  private readonly machOut: MachEffects = { lift: 1, drag: 0, cpShift: 0, control: 1 };
  /** Any section carries compressibility data: the airspeed indicator reads true CAS. */
  private readonly compressible: boolean;

  // Gear state.
  private readonly bristleLong: Float64Array;
  private readonly bristleLat: Float64Array;
  private readonly compression: Float64Array;
  private readonly wheelPlanes: Plane[];
  private readonly contactPlanes: Plane[];
  private readonly contactTouching: Uint8Array;
  private cgPlane = newPlane();

  // Propulsion.
  private readonly props: PropState[];
  private readonly engineInputs: PowerplantInput[];
  /** Lever positions flown: the pilot's, or an autothrottle's. */
  private readonly throttleIn: Float64Array;

  // Per-step results.
  private readonly forceBody = vec();
  private readonly momentBody = vec();
  private readonly gearForce = vec();
  private readonly gearMoment = vec();
  private specificForceZ = -G0;
  /** Specific force (aero and gear over mass), world frame, averaged over the sub-steps. */
  private readonly specificForce = vec();
  private specificForceY = 0;
  private wheelsLoaded = 0;
  /** Stick input actually flown this step: the pilot's, or the autopilot's while engaged. */
  private pitchIn = 0;
  private rollIn = 0;
  private yawIn = 0;
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
  private readonly afterEngine = { tas: 0, slipstream: 0, phi: 1 };
  private readonly exceedances: Exceedance[] = [];

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
  private readonly t5 = vec();
  private readonly up = vec();
  private readonly north = vec();
  private readonly vBody = vec();
  private readonly aeroWorld = vec();
  private readonly accel = vec();
  private readonly mBody = vec();
  private readonly coeff: SectionCoefficients = { cl: 0, cd: 0, cm: 0 };
  private readonly propOut: PropellerOutput = { thrust: 0, torque: 0 };

  constructor(
    readonly def: AircraftDefinition,
    avionicsUnit?: AvionicsUnit,
  ) {
    this.info = def.info;
    this.avionicsUnit = avionicsUnit;
    this.cockpit = new CockpitPanel(def.cockpit ?? C172_CONTROLS);
    this.failures = new FailureSet(def.systems.failures ?? ALL_FAILURES);
    const span = def.wingSpan / 2;
    this.airPoints = [vec(0, 0, 0), vec(0, -span, 0), vec(0, span, 0), vec(-def.tailArm, 0, 0)];
    this.engines = def.engines.map(createPowerplant);
    this.props = [];
    def.engines.forEach((e, i) => {
      const data = propellerOf(e);
      if (!data) return;
      const k = this.props.length;
      this.props.push({
        engine: i,
        data,
        position: e.position,
        rotation: data.rotation ?? 1,
        thrust: 0,
        torque: 0,
        slipDelta: 0,
        slipRadius: 0,
        swirl: 0,
        inflow: [{ vi: 0 }, { vi: 0 }, { vi: 0 }, { vi: 0 }],
        rotor: { absorb: (omega, beta, apply) => this.propeller(k, omega, beta, apply) },
      });
    });
    const n = def.engines.length;
    this.engineInputs = def.engines.map(() => newPowerplantInput());
    this.throttleIn = new Float64Array(n);
    this.systems = new AircraftSystems(def.systems, this.cockpit, this.failures, this.engines, {
      retractableGear: def.gear !== undefined,
    });
    this.controlLaw = createControlLaw(def);
    this.compressible = def.strips.some((s) => s.foil.mach !== undefined);
    const ns = def.strips.length;
    this.separation = new Float64Array(ns).fill(1);
    this.stripCl = new Float64Array(ns);
    this.stripAlpha = new Float64Array(ns);
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
    const turbine = def.engines.some((e) => e.kind !== 'piston');
    this.controls = {
      pitch: 0,
      roll: 0,
      yaw: 0,
      throttle: Array.from({ length: n }, () => 0),
      flaps: 0,
      gearDown: true,
      brakeLeft: 0,
      brakeRight: 0,
      parkingBrake: false,
      pitchTrim: 0,
      mixture: Array.from({ length: n }, () => 1),
      starter: Array.from({ length: n }, () => false),
    };
    if (turbine) {
      this.controls.condition = Array.from({ length: n }, () => 1);
      this.controls.reverse = false;
    }
    if (
      def.speedbrake ||
      def.strips.some((s) => (s.controls ?? [s.control]).some((c) => c?.kind === 'spoiler'))
    )
      this.controls.speedbrake = 0;
    if (def.controls.rollTrim) this.controls.rollTrim = 0;
    if (def.controls.yawTrim) this.controls.yawTrim = 0;
    this.lawContext = {
      controls: this.controls,
      pitch: 0,
      roll: 0,
      yaw: 0,
      state: this.state,
      telemetry: undefined as unknown as Telemetry,
      q: 0,
      mach: 0,
      vaneAlpha: 0,
      powered: true,
      yawDamper: false,
      stallProtection: false,
      dt: 0,
      cockpit: this.cockpit,
    };
    this.stripControls = def.strips.map((s) => s.controls ?? (s.control ? [s.control] : []));
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
      engines: this.engines.map((e) => e.telemetry),
      fuel: this.fuel,
      crashed: undefined,
      systems: this.systems.telemetry,
      instruments: this.systems.instruments.telemetry,
    };
    const t = this.telemetry;
    if (this.compressible || turbine) t.mach = 0;
    if (this.controls.speedbrake !== undefined) t.speedbrake = 0;
    if (def.stallProtection) {
      t.stickShaker = false;
      t.stickPusher = false;
    }
    if (def.controls.trim === 'stabiliser') t.stabiliser = 0;
    if (def.limits) t.exceedances = this.exceedances;
    this.lawContext.telemetry = t;
    this.avionicsInput.telemetry = t;
    this.systemsContext = {
      controls: this.controls,
      cockpit: this.cockpit,
      telemetry: t,
      systems: this.systems,
      engines: this.engines,
      engineInputs: this.engineInputs,
      failures: this.failures,
      dt: 0,
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
   * Fuel in the tanks, kg (the planned fuel load; a reset fills them all). Usable fuel only,
   * clamped to a tank's capacity. Two numbers fill the two wing tanks.
   */
  setFuel(left: number, right: number) {
    this.systems.fuel.reset(left, right);
    this.systems.fillTelemetry();
    this.telemetry.fuel = this.fuel;
  }

  /** Fuel in every tank, kg, in the order of the type's tanks. */
  setFuelTanks(amounts: readonly number[]) {
    this.systems.fuel.fill(amounts);
    this.systems.fillTelemetry();
    this.telemetry.fuel = this.fuel;
  }

  /**
   * The levers of ControlInput appear in the cockpit under their names: `throttle`,
   * `mixture` and `condition` (every engine, or `throttle1`, `throttle2`... one each),
   * `flaps`, `trim`, `aileronTrim`, `rudderTrim`, `gear`, `reverse`, `speedbrake` and
   * `parkingBrake`. A control the type's cockpit does not list is not bound.
   */
  private bindCockpit() {
    const p = this.cockpit;
    const c = this.controls;
    const n = this.engines.length;
    const detents = this.def.controls.flapDetents.length - 1;
    // A selector's positions spread over 0..1 (cut-off, ground idle, flight idle).
    const positions = (spec: ControlSpec) =>
      spec.kind === 'selector' ? (spec.positions?.length ?? 1) - 1 : 0;
    const toLever = (last: number, v: number) => (last > 0 ? v / last : v);
    const fromLever = (last: number, v: number) =>
      last > 0 ? Math.round(clamp(v, 0, 1) * last) : v;
    const bindLever = (id: string, arr: () => number[] | undefined) => {
      const spec = p.specs.find((s) => s.id === id);
      if (spec) {
        const last = positions(spec);
        p.bind(
          id,
          () => fromLever(last, arr()?.[0] ?? 0),
          (v) => {
            const a = arr();
            if (a) for (let i = 0; i < n; i++) a[i] = toLever(last, v);
          },
        );
      }
      // One lever per engine (`throttle1`, `throttle2`...), also where there is no common one.
      for (let i = 0; i < n; i++) {
        const one = p.specs.find((s) => s.id === `${id}${i + 1}`);
        if (!one) continue;
        const last = positions(one);
        p.bind(
          one.id,
          () => fromLever(last, arr()?.[i] ?? 0),
          (v) => {
            const a = arr();
            if (a) a[i] = toLever(last, v);
          },
        );
      }
    };
    bindLever('throttle', () => c.throttle);
    bindLever('mixture', () => c.mixture);
    bindLever('condition', () => c.condition);
    // A jet's engine masters are its condition levers.
    if (!p.has('condition1')) bindLever('engineMaster', () => c.condition);
    // The selector's positions are the flap detents; ControlInput spreads them over 0..1.
    if (p.has('flaps'))
      p.bind(
        'flaps',
        () => Math.round(clamp(c.flaps, 0, 1) * detents),
        (v) => (c.flaps = v / detents),
      );
    if (p.has('trim'))
      p.bind(
        'trim',
        () => c.pitchTrim,
        (v) => (c.pitchTrim = v),
      );
    if (p.has('aileronTrim'))
      p.bind(
        'aileronTrim',
        () => c.rollTrim ?? 0,
        (v) => (c.rollTrim = v),
      );
    if (p.has('rudderTrim'))
      p.bind(
        'rudderTrim',
        () => c.yawTrim ?? 0,
        (v) => (c.yawTrim = v),
      );
    if (p.has('parkingBrake'))
      p.bind(
        'parkingBrake',
        () => (c.parkingBrake ? 1 : 0),
        (v) => (c.parkingBrake = v >= 0.5),
      );
    if (p.has('gear'))
      p.bind(
        'gear',
        () => (c.gearDown ? 1 : 0),
        (v) => (c.gearDown = v >= 0.5),
      );
    if (p.has('reverse'))
      p.bind(
        'reverse',
        () => (c.reverse ? 1 : 0),
        (v) => (c.reverse = v >= 0.5),
      );
    if (p.has('speedbrake'))
      p.bind(
        'speedbrake',
        () => c.speedbrake ?? 0,
        (v) => (c.speedbrake = v),
      );
  }

  // ---------------------------------------------------------------------------------------
  // Controls

  private flapIndex(): number {
    const detents = this.def.controls.flapDetents;
    // The lever has detents; the input is snapped to the nearest one.
    return Math.round(clamp(this.controls.flaps, 0, 1) * (detents.length - 1));
  }

  private flapTarget(): number {
    return this.def.controls.flapDetents[this.flapIndex()]!;
  }

  /** Elevator angle the trim (and a centred yoke) asks for, rad. */
  private elevatorTarget(): number {
    const c = this.def.controls;
    if (c.trim === 'stabiliser') return 0;
    return clamp(trimAngle(this.def, this.controls.pitchTrim), -c.elevatorDown, c.elevatorUp);
  }

  /** The control law decides where the surfaces go; they follow at their rates. */
  private moveSurfaces(dt: number, q: number) {
    const def = this.def;
    const c = def.controls;
    const ctx = this.lawContext;
    ctx.pitch = this.pitchIn;
    ctx.roll = this.rollIn;
    ctx.yaw = this.yawIn;
    ctx.q = q;
    ctx.mach = this.mach;
    ctx.vaneAlpha = this.stallHornAlpha;
    ctx.powered =
      c.holdLimitPressure === Infinity ? this.systems.hydraulicShare('controls') > 0.5 : true;
    ctx.yawDamper = this.telemetry.avionics?.autopilot.yawDamper ?? false;
    ctx.stallProtection = this.systems.electrical.busPowered;
    ctx.dt = dt;
    const cmd = this.surfaceCommand;
    this.controlLaw.step(ctx, cmd);
    const rate = c.surfaceRate * dt;
    if (ctx.powered) {
      const eRange = c.elevatorUp + c.elevatorDown;
      this.elevator += clamp(cmd.elevator - this.elevator, -rate * eRange, rate * eRange);
      this.aileron += clamp(cmd.aileron - this.aileron, -rate * 2, rate * 2);
      this.rudder += clamp(cmd.rudder - this.rudder, -rate * 2, rate * 2);
      this.differentialTail += clamp(
        cmd.differentialTail - this.differentialTail,
        -rate * 2,
        rate * 2,
      );
    }
    // The trim motor runs the stabiliser at about a degree a second.
    if (c.trim === 'stabiliser' && this.systems.electrical.busPowered) {
      const s = (c.trimUp + c.trimDown) / 12;
      this.stabiliser += clamp(cmd.stabiliser - this.stabiliser, -s * dt, s * dt);
    }
    const sr = (c.spoilerRate ?? 1) * dt;
    this.spoiler += clamp(cmd.spoilers - this.spoiler, -sr, sr);
    this.speedbrake += clamp(cmd.speedbrake - this.speedbrake, -sr, sr);
    // The flaps are electric (or hydraulic): without power they stay where they are.
    const fTarget = cmd.flap ?? this.flapTarget();
    const moving = Math.abs(fTarget - this.flap) > 1e-9;
    if (this.systems.flapsPowered)
      this.flap += clamp(fTarget - this.flap, -c.flapRate * dt, c.flapRate * dt);
    this.systems.flapsMoving = moving;
    const slats = c.slatDetents;
    if (slats || cmd.leadingEdge !== undefined) {
      const sTarget = cmd.leadingEdge ?? slats![this.flapIndex()]!;
      if (this.systems.flapsPowered)
        this.slat += clamp(sTarget - this.slat, -c.flapRate * dt, c.flapRate * dt);
    }
  }

  /** The gear follows its lever while it has power; the squat switch keeps it down on the ground. */
  private moveGear(dt: number) {
    const g = this.def.gear;
    if (!g) return;
    const down = this.controls.gearDown || (this.telemetry.onGround && this.gear >= GEAR_LOCKED);
    const target = down ? 1 : 0;
    const s = this.systems;
    s.gear.moving = Math.abs(target - this.gear) > 1e-9;
    if (s.gearPowered) {
      const rate = dt / (target > this.gear ? g.extendTime : g.retractTime);
      this.gear += clamp(target - this.gear, -rate, rate);
    }
    s.gear.unsafe = this.gear > 1e-6 && this.gear < GEAR_LOCKED;
  }

  /** Change of zero-lift angle of a strip from its control surface, rad. */
  private controlAlpha(
    kind: string,
    effectiveness: number,
    side: number | undefined,
    roll = 0,
  ): number {
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
      case 'elevator': {
        // Trailing edge up (nose up) is negative lift on the tailplane; a differential tail
        // adds the opposite on each side to roll.
        let e = -effectiveness * this.elevator;
        if (roll && side)
          e += effectiveness * roll * side * -this.differentialTail * c.elevatorDown;
        return e;
      }
      case 'rudder':
        return effectiveness * this.rudder * c.rudder;
    }
    return 0;
  }

  /** Raised share of a spoiler strip: the speed brake, and on the down-going wing, the roll. */
  private spoilerShare(side: number | undefined, roll: number | undefined): number {
    let s = this.spoiler;
    if (roll && side) s = Math.max(s, clamp(this.aileron * side * roll, 0, 1));
    return s;
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
   * Propeller `k`: the disk is split into four quadrants, each at 3/4 radius with its own
   * inflow. At an angle of attack the descending blade meets the air faster than the rising
   * one and makes more thrust: P-factor. Returns the torque absorbed and accumulates forces.
   */
  private propeller(k: number, omega: number, beta: number, accumulate: boolean): number {
    const ps = this.props[k]!;
    const prop = ps.data;
    const rot = ps.rotation;
    const r = 0.375 * prop.diameter;
    const n = omega / (2 * Math.PI);
    const air = this.air[0]!;
    const sound = Math.sqrt(1.4 * R_AIR * air.temperature);
    let torque = 0;
    let thrust = 0;
    const p = this.t1;
    const dir = this.t2;
    const vel = this.t0;
    for (let q = 0; q < 4; q++) {
      // Quadrant directions: right, down, left, up; blade motion = x × dir.
      const dy = q === 0 ? 1 : q === 2 ? -1 : 0;
      const dz = q === 1 ? 1 : q === 3 ? -1 : 0;
      set(dir, 0, dy, dz);
      addScaled(p, ps.position, dir, r);
      this.airVelocityAt(p, vel);
      // Tangential direction of the blade (clockwise seen from the cockpit) is (0, -dz, dy).
      const vt = rot * (-dz * vel.y + dy * vel.z);
      const bladeSpeed = omega * r;
      const s = bladeSpeed > 5 ? clamp(1 + vt / bladeSpeed, 0.3, 3) : 1;
      if (prop.kind === 'variable')
        bladeForces(
          prop,
          n * s,
          vel.x,
          air.density,
          beta,
          sound,
          0.25,
          ps.inflow[q]!,
          this.propOut,
        );
      else {
        propellerForces(prop, n * s, vel.x, air.density, this.propOut);
        this.propOut.thrust /= 4;
        this.propOut.torque /= 4;
      }
      const tq = this.propOut.thrust;
      const qq = this.propOut.torque;
      thrust += tq;
      torque += qq;
      if (accumulate) {
        // Thrust acts at the quadrant (its asymmetry is the P-factor moment); the blade drag
        // goes into the shaft as torque, and only what does not cancel between quadrants,
        // the propeller's normal force, reaches the airframe, at the hub.
        const f = this.t3;
        set(f, tq, 0, 0);
        this.addForce(p, f);
        set(f, 0, rot * (qq / r) * dz, rot * (-qq / r) * dy);
        this.addForce(ps.position, f);
      }
    }
    if (accumulate) {
      ps.thrust = thrust;
      ps.torque = torque;
    }
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

  /** Slipstream of every propeller from momentum theory: speed increment, contraction, swirl. */
  private slipstreams(vc: Vec3, rho: number) {
    for (const ps of this.props) {
      const prop = ps.data;
      const disk = (Math.PI * prop.diameter * prop.diameter) / 4;
      const va = Math.max(vc.x, 0);
      const radicand = va * va + (2 * ps.thrust) / (rho * disk);
      ps.slipDelta = Math.sqrt(Math.max(radicand, 0)) - va;
      const vDisk = Math.max(va + ps.slipDelta / 2, 1);
      ps.slipRadius = (prop.diameter / 2) * Math.sqrt(vDisk / Math.max(va + ps.slipDelta, 1));
      const massFlow = rho * disk * vDisk;
      ps.swirl =
        (ps.rotation * prop.swirlFactor * 2 * Math.max(ps.torque, 0)) /
        (massFlow * ps.slipRadius * ps.slipRadius);
    }
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
    this.mach = speed / Math.sqrt(1.4 * R_AIR * air.temperature);
    this.slipstreams(vc, rho);

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
    const sound = Math.sqrt(1.4 * R_AIR * air.temperature);
    const mo = this.machOut;
    for (let i = 0; i < def.strips.length; i++) {
      const strip = def.strips[i]!;
      const r = strip.position;
      this.airVelocityAt(r, ve);
      // Slipstream: faster axial flow and swirl inside the contracted tube behind each disk.
      for (const ps of this.props) {
        if (r.x >= ps.position.x || ps.slipRadius <= 0) continue;
        const ry = r.y - ps.position.y;
        const rz = r.z - ps.position.z;
        const d = Math.sqrt(ry * ry + rz * rz);
        const inside =
          (1 - smoothstep(0.8 * ps.slipRadius, 1.2 * ps.slipRadius, d)) *
          strip.slipstreamDevelopment;
        if (inside > 0) {
          ve.x += ps.slipDelta * inside;
          // Air rotating with the propeller: velocity Ω x̂ × r; the strip moves against it.
          ve.y += ps.swirl * rz * inside;
          ve.z -= ps.swirl * ry * inside;
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
      const foil = strip.foil;
      const devices = this.stripControls[i]!;
      let alpha = alphaGeo - this.groupInduced[strip.group]!;
      let ctrl = 0;
      let sepShift = 0;
      let spoiled = 0;
      let hinged = false;
      let flap: StripControl | undefined;
      for (let k = 0; k < devices.length; k++) {
        const control = devices[k]!;
        // A movable stabiliser turns the whole tailplane: nose-up trim is leading edge down.
        if (control.kind === 'elevator' && def.controls.trim === 'stabiliser')
          alpha -= this.stabiliser;
        if (control.kind === 'slat') sepShift += control.effectiveness * this.slat;
        else if (control.kind === 'spoiler')
          spoiled = Math.max(spoiled, this.spoilerShare(control.side, control.roll));
        else {
          ctrl += this.controlAlpha(control.kind, control.effectiveness, control.side, control.roll);
          if (control.effectiveness < 0.95) hinged = true;
          if (control.kind === 'flap') flap = control;
        }
      }
      // Compressibility on the flow normal to the sweep.
      const cosSweep = strip.sweep ? Math.cos(strip.sweep) : 1;
      let liftScale = cosSweep;
      let extraDrag = 0;
      let cpShift = 0;
      if (foil.mach) {
        const mn = (Math.sqrt(v2) / sound) * cosSweep;
        machEffects(foil.mach, foil.liftSlope, mn, mo);
        liftScale *= mo.lift;
        extraDrag = mo.drag;
        cpShift = mo.cpShift;
        // An all-moving tail keeps its power; a hinged surface loses it behind the shock.
        if (hinged) ctrl *= mo.control;
      }
      // A raised spoiler destroys most of the lift behind it.
      if (spoiled > 0) ctrl -= 0.6 * spoiled * (alpha - foil.alpha0) + 4 * DEG * spoiled;
      const alphaControl = alpha + def.controls.stallShift * ctrl;
      let alphaSep = alphaControl - sepShift;
      // Ice roughens the leading edge: the flow separates at a smaller angle. The stall
      // horn's reed does not know that, which is why it warns late on an iced wing.
      if (ice > 0) alphaSep /= 1 - ICE_STALL * ice;
      if (steady) this.separation[i] = staticSeparation(foil, alphaSep);
      const f = this.separation[i]!;
      const c = sectionCoefficients(foil, alpha, ctrl, f, this.coeff);
      if (!steady)
        this.separation[i] = updateSeparation(foil, f, alphaSep, Math.sqrt(v2), strip.chord, dt);
      let cl = c.cl * (strip.liftFactor ?? 1);
      if (liftScale !== 1) cl *= liftScale;
      if (strip.vortexLift) cl += vortexLift(strip.vortexLift, alpha);
      let cd = c.cd + extraDrag;
      if (ice > 0) cd += ICE_DRAG * ice;
      let area = strip.area;
      if (flap) {
        const sf = Math.sin(this.flap);
        cd += def.controls.flapDrag * sf * sf;
        // A Fowler flap runs out behind the wing: more area as it extends.
        if (flap.extension) {
          const travel = def.controls.flapDetents[def.controls.flapDetents.length - 1]!;
          area *= 1 + flap.extension * clamp(this.flap / travel, 0, 1);
        }
      }
      if (spoiled > 0) cd += (def.controls.spoilerDrag ?? 0.1) * spoiled;
      this.stripCl[i] = cl;
      this.stripAlpha[i] = alphaControl;
      const qS = 0.5 * rho * v2 * area * (strip.qFactor ?? 1);
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
      // Section moment about the span axis (chord × lift); the shock moves it aft.
      const m = qS * strip.chord * (cpShift > 0 ? c.cm - cpShift * cl : c.cm);
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
    let dragArea = ice > 0 ? fus.dragArea * (1 + ICE_BODY_DRAG * ice) : fus.dragArea;
    if (fus.machDrag)
      dragArea *= 1 + fus.machDrag.rise * smoothstep(fus.machDrag.critical, 1.05, this.mach);
    scale(this.t2, vf, -0.5 * rho * vfl * dragArea);
    this.addForce(fus.dragPoint, this.t2);
    this.extraDrag(rho);
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

  /** Drag of the extended gear and the speed brake, each at its own point. */
  private extraDrag(rho: number) {
    const def = this.def;
    const parts: [Vec3, number][] = [];
    if (def.gear && this.gear > 0) parts.push([def.gear.dragPoint, def.gear.dragArea * this.gear]);
    if (def.speedbrake && this.speedbrake > 0)
      parts.push([def.speedbrake.position, def.speedbrake.dragArea * this.speedbrake]);
    for (const [point, area] of parts) {
      const v = this.airVelocityAt(point, this.t5);
      scale(this.t2, v, -0.5 * rho * length(v) * area);
      this.addForce(point, this.t2);
    }
  }

  /** Every engine with its own levers and inflow; jets push along their axis at their nozzle. */
  private enginesStep(dt: number, steady: boolean) {
    const c = this.controls;
    const air = this.air[0]!;
    for (let i = 0; i < this.engines.length; i++) {
      const plant = this.engines[i]!;
      const def = this.def.engines[i]!;
      const input = this.engineInputs[i]!;
      input.throttle = this.throttleIn[i]!;
      input.reverse = c.reverse ?? false;
      input.condition = c.condition?.[i] ?? 1;
      input.mixture = c.mixture[i] ?? 1;
      input.pressure = air.pressure;
      input.temperature = air.temperature;
      input.density = air.density;
      input.mach = this.mach;
      const v = this.airVelocityAt(def.position, this.t5);
      input.airspeed = def.axis ? dot(v, def.axis) : v.x;
      input.onGround = this.telemetry.onGround;
      const prop = this.props.find((p) => p.engine === i);
      const rotor = prop?.rotor;
      if (steady) {
        if (plant.kind === 'piston' && !plant.running) {
          (plant as PistonPowerplant).engine.omega = 0;
          plant.step(0, input, rotor);
        } else plant.settle(input, rotor);
      } else plant.step(dt, input, rotor);
      // Reaction of the shaft torque on the airframe rolls it against the propeller.
      this.momentBody.x += (prop?.rotation ?? 1) * plant.reactionTorque;
      if (plant.thrust !== 0) {
        const axis = def.axis ?? X_AXIS;
        scale(this.t2, axis, plant.thrust);
        this.addForce(def.position, this.t2);
      }
    }
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
    const locked = this.gear >= GEAR_LOCKED;
    for (let i = 0; i < def.wheels.length; i++) {
      const wheel = def.wheels[i]!;
      const plane = this.wheelPlanes[i]!;
      if (!plane.valid || !locked) {
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
    const steering = this.surfaceCommand.steering ?? this.controls.yaw;
    const steer = (wheel.steering ?? 0) * clamp(steering, -1, 1);
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
    let pedal = wheel.brake === 'left' ? c.brakeLeft : wheel.brake === 'right' ? c.brakeRight : 0;
    const auto = this.surfaceCommand.brake;
    if (auto !== undefined && wheel.brake) pedal = Math.max(pedal, auto);
    // Brake pads hold a standing wheel harder than they slow a turning one (static friction
    // of the pads): the brakes hold a full-power run-up but still let a landing roll out.
    const stiction = 1 + 0.5 * (1 - smoothstep(0.05, 0.5, Math.abs(vLong)));
    const brake = (c.parkingBrake ? 1 : clamp(pedal, 0, 1)) * (wheel.brakeForce ?? 0) * stiction;

    // Tyre as a bristle: a spring that holds the aircraft still on a slope or against idle
    // thrust, and that relaxes over a rolling length so a rolling tyre grips by slip angle.
    const stiffness = wheel.tyre?.stiffness ?? TYRE_STIFFNESS;
    const damping = wheel.tyre?.damping ?? TYRE_DAMPING;
    let lat =
      this.bristleLat[i]! + (vLat - (Math.abs(vLong) * this.bristleLat[i]!) / TYRE_RELAXATION) * dt;
    const latDamping = damping / (1 + Math.abs(vLong) / 0.5);
    let fLat = -(stiffness * lat + latDamping * vLat);
    const capLat = mu * normal;
    if (Math.abs(fLat) > capLat) {
      fLat = Math.sign(fLat) * capLat;
      lat = clamp(lat, -capLat / stiffness, capLat / stiffness);
    }
    let lon = this.bristleLong[i]! + vLong * dt;
    let fLon = -(stiffness * lon + damping * vLong);
    const capLon = Math.min(mu * normal, rolling * normal + brake);
    if (Math.abs(fLon) > capLon) {
      fLon = Math.sign(fLon) * capLon;
      lon = clamp(lon, -capLon / stiffness, capLon / stiffness);
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
    // A skid slides on a runway or grass; water and rough ground wreck it unless barely moving.
    const rough = plane.surface === 'water' || plane.surface === 'terrain';
    const sliding = cp.skid && !(rough && length(pv) > 5);
    if (!this.contactTouching[i]) {
      this.contactTouching[i] = 1;
      if (rate > cp.crashSpeed || (cp.crashSpeed === 0 && !sliding)) this.crash(cp.reason);
    }
    if (cp.skid && !sliding) this.crash(cp.reason);
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
    this.systems.beforeEngines(dt, this.engineInputs, this.controls.starter, this.time);
    if (this.controlLaw.systems) {
      this.systemsContext.dt = dt;
      this.controlLaw.systems(this.systemsContext);
    }
    this.moveSurfaces(dt, q);
    this.moveGear(dt);

    this.aerodynamics(dt, false);
    this.enginesStep(dt, false);
    this.fuelImbalance();

    // Fuel burns off and lightens the aircraft; the systems follow the engines.
    const ae = this.afterEngine;
    ae.tas = tas;
    ae.slipstream = this.props[0]?.slipDelta ?? 0;
    const first = this.engines[0];
    ae.phi =
      first?.kind === 'piston'
        ? (first as PistonPowerplant).engine.equivalenceRatio(
            this.controls.mixture[0] ?? 1,
            air.density,
          )
        : 1;
    this.systems.afterEngines(dt, ae, air);

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
      for (const e of this.engines) e.stop();
    }
    this.fillTelemetry(env);
    this.updateInstruments(env, dt);
  }

  /**
   * The avionics unit sees the aircraft as it was at the end of the last step; while its
   * autopilot is engaged it flies pitch and roll, and it turns the trim wheel itself (so the
   * trim stays where it left it when it lets go). An autothrottle flies the thrust levers.
   */
  private stepAvionics(dt: number, env: Environment) {
    const c = this.controls;
    this.pitchIn = c.pitch;
    this.rollIn = c.roll;
    this.yawIn = c.yaw;
    for (let i = 0; i < this.throttleIn.length; i++) this.throttleIn[i] = c.throttle[i] ?? 0;
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
      if (cmd.yaw !== undefined) this.yawIn = cmd.yaw;
      if (cmd.throttle !== undefined) this.throttleIn.fill(clamp(cmd.throttle, 0, 1));
    }
  }

  /**
   * Fuel off the centre of gravity (one wing heavier than the other, a tank drawn before the
   * others): its weight acts off the centre and rolls or pitches the aircraft.
   */
  private fuelImbalance() {
    const r = this.systems.fuel.imbalance(this.t5);
    if (r.x === 0 && r.y === 0 && r.z === 0) return;
    const u = rotateInverse(this.t0, this.state.orientation, this.up);
    // Weight -m g up acting at r: moment r × (-g u).
    this.momentBody.x -= G0 * (r.y * u.z - r.z * u.y);
    this.momentBody.y -= G0 * (r.z * u.x - r.x * u.z);
    this.momentBody.z -= G0 * (r.x * u.y - r.y * u.x);
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

  /** Angular momentum of every spinning engine part along body x, kg m²/s. */
  private engineMomentum(): number {
    let h = 0;
    for (let i = 0; i < this.engines.length; i++) {
      const prop = this.props.find((p) => p.engine === i);
      h += (prop?.rotation ?? 1) * this.engines[i]!.angularMomentum;
    }
    return h;
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
    const hProp = this.engineMomentum();
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
    t.ias = this.indicated(this.calibrated(tas, air));
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
    // Height of the lowest wheel bottom above the ground; with the gear up, of the lowest
    // skid (what touches first).
    if (this.cgPlane.valid && !this.held) {
      const up = this.gear >= GEAR_LOCKED;
      let lowest = Infinity;
      const n = up ? def.wheels.length : def.contacts.length;
      for (let i = 0; i < n; i++) {
        const point = up ? def.wheels[i]!.position : def.contacts[i]!.position;
        if (!up && !def.contacts[i]!.skid) continue;
        const own = up ? this.wheelPlanes[i]! : this.contactPlanes[i]!;
        const plane = own.valid ? own : this.cgPlane;
        const w = rotate(this.t3, s.orientation, point);
        add(w, w, s.position);
        sub(w, w, plane.point);
        lowest = Math.min(lowest, dot(w, plane.normal));
      }
      t.agl = Number.isFinite(lowest) ? Math.max(0, lowest) : undefined;
    } else t.agl = undefined;
    // On the ground: a wheel carries weight, or, wheels up, a skid scrapes.
    t.onGround =
      this.held ||
      this.compression.some((c) => c > 0) ||
      this.contactTouching.some((c, i) => c > 0 && def.contacts[i]!.skid === true);
    const horn = this.stallHornAlpha > def.stallWarning.alpha && tas > 10 && !this.crashed;
    t.stallWarning = horn || this.controlLaw.shaker;
    if (t.stickShaker !== undefined) {
      t.stickShaker = this.controlLaw.shaker;
      t.stickPusher = this.controlLaw.pusher;
    }
    t.flaps = this.flap / def.controls.flapDetents[def.controls.flapDetents.length - 1]!;
    t.gear = this.gear;
    const c = def.controls;
    t.elevator = this.elevator >= 0 ? this.elevator / c.elevatorUp : this.elevator / c.elevatorDown;
    t.aileron = this.aileron;
    t.rudder = this.rudder;
    if (t.stabiliser !== undefined) t.stabiliser = this.stabiliser;
    if (t.mach !== undefined) t.mach = tas / Math.sqrt(1.4 * R_AIR * air.temperature);
    if (t.speedbrake !== undefined) t.speedbrake = Math.max(this.speedbrake, this.spoiler);
    t.fuel = this.fuel;
    t.crashed = this.crashed;
    if (def.limits) this.checkLimits();
  }

  /** Calibrated airspeed: from the impact pressure where the type flies fast enough to need it. */
  private calibrated(tas: number, air: AirSample): number {
    if (!this.compressible) return tas * Math.sqrt(air.density / SEA_LEVEL_DENSITY);
    const a = Math.sqrt(1.4 * R_AIR * air.temperature);
    const m = tas / a;
    // Impact pressure: isentropic below the speed of sound, Rayleigh's pitot formula above.
    const ratio = m < 1 ? (1 + 0.2 * m * m) ** 3.5 : (166.921 * m ** 7) / (7 * m * m - 1) ** 2.5;
    const qc = air.pressure * (ratio - 1);
    return SEA_LEVEL_SOUND * Math.sqrt(5 * ((qc / SEA_LEVEL_PRESSURE + 1) ** (2 / 7) - 1));
  }

  /** The placard limits being exceeded now. */
  private checkLimits() {
    const lim = this.def.limits!;
    const t = this.telemetry;
    const x = this.exceedances;
    x.length = 0;
    if (this.crashed || t.onGround) return;
    const ias = t.ias;
    if (ias > lim.vmo) x.push('overspeed');
    if (lim.mmo !== undefined && (t.mach ?? 0) > lim.mmo) x.push('mach');
    const detents = this.def.controls.flapDetents;
    let i = 0;
    while (i < detents.length - 1 && this.flap > detents[i]! + 0.5 * DEG) i++;
    if (i > 0 && ias > (lim.vfe[i] ?? Infinity)) x.push('flaps');
    const g = this.def.gear;
    if (g && ((this.gear > 0.01 && ias > g.vle) || (this.systems.gear.moving && ias > g.vlo)))
      x.push('gear');
    let torque = false;
    let itt = false;
    let ng = false;
    let prop = false;
    let n1 = false;
    for (const e of t.engines) {
      if (lim.torque !== undefined && (e.torque ?? 0) > lim.torque) torque = true;
      if (lim.itt !== undefined && (e.turbineTemperature ?? -273) + 273.15 > lim.itt) itt = true;
      if (lim.egt !== undefined && (e.turbineTemperature ?? -273) + 273.15 > lim.egt) itt = true;
      if (lim.ng !== undefined && (e.n2 ?? 0) > lim.ng) ng = true;
      if (lim.propRpm !== undefined && (e.propRpm ?? 0) > lim.propRpm) prop = true;
      if (lim.n1 !== undefined && (e.n1 ?? 0) > lim.n1) n1 = true;
    }
    if (torque) x.push('torque');
    if (itt) x.push(lim.egt !== undefined ? 'egt' : 'itt');
    if (ng) x.push('ng');
    if (prop) x.push('propeller');
    if (n1) x.push('n1');
    if (
      t.loadFactor > this.def.ultimateLoad.positive / 1.5 ||
      t.loadFactor < this.def.ultimateLoad.negative / 1.5
    )
      x.push('load');
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
    this.controlLaw.reset();
    this.separation.fill(1);
    this.stripCl.fill(0);
    this.groupCl.fill(0);
    this.groupInduced.fill(0);
    this.downwash = 0;
    this.bristleLat.fill(0);
    this.bristleLong.fill(0);
    this.compression.fill(0);
    this.contactTouching.fill(0);
    for (const p of this.props) {
      p.thrust = 0;
      p.torque = 0;
      for (const f of p.inflow) f.vi = 0;
    }
    set(s.angularVelocity, 0, 0, 0);
    const c = this.controls;
    c.pitch = 0;
    c.roll = 0;
    c.yaw = 0;
    c.brakeLeft = 0;
    c.brakeRight = 0;
    c.gearDown = start.onGround || !this.def.gear ? true : (start.gearDown ?? false);
    if (c.starter) c.starter.fill(false);
    if (c.reverse !== undefined) c.reverse = false;
    if (c.speedbrake !== undefined) c.speedbrake = 0;
    this.pitchIn = 0;
    this.rollIn = 0;
    this.yawIn = 0;
    for (const e of this.engines) e.reset(running, !start.onGround);
    this.gear = c.gearDown ? 1 : 0;
    this.spoiler = 0;
    this.speedbrake = 0;
    this.differentialTail = 0;
    this.surfaceCommand.brake = undefined;
    this.surfaceCommand.steering = undefined;
    // Bus, ignition and fuel supply as the switches now stand, before anything is trimmed.
    this.systems.beforeEngines(0, this.engineInputs, undefined, 0);
    this.flap = this.flapTarget();
    this.slat = this.def.controls.slatDetents?.[this.flapIndex()] ?? 0;
    this.aileron = this.def.controls.aileronRigging;
    this.rudder = this.def.controls.rudderRigging;
    if (start.onGround) {
      c.throttle.fill(0);
      this.throttleIn.fill(0);
      c.pitchTrim = 0;
      this.elevator = this.elevatorTarget();
      this.stabiliser = trimAngle(this.def, 0);
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
      this.groundIdle(running, env);
    } else {
      this.trimInAir(start, env, running);
    }
    this.sampleAir(env);
    env.up(s.position, this.up);
    scale(this.specificForce, this.up, G0);
    this.specificForceY = 0;
    this.specificForceZ = -G0;
    // Once more with the engines turning: the generators now carry the bus.
    this.systems.beforeEngines(0, this.engineInputs, undefined, 0);
    this.fillTelemetry(env);
    this.systems.fillTelemetry();
    this.updateInstruments(env, 0, running);
  }

  /** On the ground the engines idle: a piston at its idle stop's rpm, a turbine settled at idle. */
  private groundIdle(running: boolean, env: Environment) {
    this.telemetry.onGround = true;
    for (let i = 0; i < this.engines.length; i++) {
      const plant = this.engines[i]!;
      if (plant.kind === 'piston') {
        (plant as PistonPowerplant).idle(running);
        continue;
      }
      if (!running) continue;
      rotateInverse(this.vBody, this.state.orientation, this.state.velocity);
      this.sampleAir(env);
      set(this.forceBody, 0, 0, 0);
      set(this.momentBody, 0, 0, 0);
      this.enginesStep(0, true);
    }
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
   * attack, pitch trim (elevator or stabiliser) and throttle so forces and pitching moment
   * balance. The solved throttle and trim are written into `controls`.
   */
  private trimInAir(start: InitialCondition, env: Environment, running: boolean) {
    const s = this.state;
    const c = this.controls;
    const def = this.def;
    const stabiliser = def.controls.trim === 'stabiliser';
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
    this.telemetry.onGround = false;
    const trimLo = stabiliser ? -def.controls.trimDown : -def.controls.elevatorDown;
    const trimHi = stabiliser ? def.controls.trimUp : def.controls.elevatorUp;

    const residual = (x: number[], out: number[]) => {
      const [alpha, trim, thr] = x as [number, number, number];
      this.orient(env, s.position, start.headingDeg, alpha, undefined);
      // Air-relative velocity along the heading; the wind is added on top.
      this.sampleAirAt(env);
      addScaled(s.velocity, this.air[0]!.wind, dir, speed);
      rotateInverse(this.vBody, s.orientation, s.velocity);
      this.sampleAir(env);
      if (stabiliser) {
        this.stabiliser = trim;
        this.elevator = 0;
      } else this.elevator = trim;
      const t = clamp(thr, 0, 1);
      c.throttle.fill(t);
      this.throttleIn.fill(t);
      // Stopped engines are only stepped: they stand, windmill or feather as they are.
      for (let k = 0; k < 8; k++) {
        this.aerodynamics(0, true);
        this.enginesStep(0, running);
      }
      const grav = rotateInverse(vec(), s.orientation, scale(vec(), up, -G0 * this.mass));
      const m = this.mass * G0;
      out[0] = (this.forceBody.x + grav.x) / m;
      out[1] = (this.forceBody.z + grav.z) / m;
      out[2] = this.momentBody.y / (m * def.meanChord);
      // Beyond full throttle the residual keeps pulling, so the solver settles at the limit.
      // Past what the engines can give (full throttle, a turbine's temperature limit) the
      // residual carries on as if they could, so the solver comes back from there.
      let short = 0;
      for (const e of this.engines) short += e.shortfall;
      if (running && short > 0) out[0] += (short / this.engines.length) * 0.5;
      if (thr > 1) out[0] += (thr - 1) * 0.5;
      if (thr < 0) out[0] += thr * 0.5;
    };

    const x = [4 * DEG, 0, 0.6];
    const r = [0, 0, 0];
    const r2 = [0, 0, 0];
    const limit = [3 * DEG, 3 * DEG, 0.3];
    const last = [0, 0, 0];
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
      for (let j = 0; j < 3; j++) {
        const step = clamp(dx[j]!, -limit[j]!, limit[j]!);
        // A kinked response (an engine control's lever detent) makes Newton jump to and fro
        // across the kink: each reversal halves the step allowed from then on.
        if (step * last[j]! < 0) limit[j] = Math.min(limit[j]!, Math.abs(last[j]!) / 2);
        last[j] = step;
        x[j]! -= step;
      }
      x[0] = clamp(x[0]!, -10 * DEG, 25 * DEG);
      x[1] = clamp(x[1]!, trimLo, trimHi);
    }
    // A type with aileron and rudder trim starts with them set for the condition too, as a
    // pilot of a powerful single would have them: no roll or yaw moment left at zero slip.
    const cc = def.controls;
    if (cc.rollTrim && cc.yawTrim) {
      const lateral = (rt: number, yt: number, out: number[]) => {
        this.aileron = clamp(cc.aileronRigging + cc.rollTrim! * rt, -1, 1);
        this.rudder = clamp(cc.rudderRigging + cc.yawTrim! * yt, -1, 1);
        residual(x, r);
        const m = this.mass * G0;
        out[0] = this.momentBody.x / (m * def.wingSpan);
        out[1] = this.momentBody.z / (m * def.wingSpan);
      };
      let rt = 0;
      let yt = 0;
      const a = [0, 0];
      const b = [0, 0];
      for (let iter = 0; iter < 4; iter++) {
        lateral(rt, yt, a);
        lateral(rt + 0.01, yt, b);
        const j00 = (b[0]! - a[0]!) / 0.01;
        const j10 = (b[1]! - a[1]!) / 0.01;
        lateral(rt, yt + 0.01, b);
        const j01 = (b[0]! - a[0]!) / 0.01;
        const j11 = (b[1]! - a[1]!) / 0.01;
        const det = j00 * j11 - j01 * j10;
        if (Math.abs(det) < 1e-12) break;
        rt = clamp(rt - (j11 * a[0]! - j01 * a[1]!) / det, -1, 1);
        yt = clamp(yt - (-j10 * a[0]! + j00 * a[1]!) / det, -1, 1);
      }
      c.rollTrim = rt;
      c.yawTrim = yt;
      this.aileron = clamp(cc.aileronRigging + cc.rollTrim * rt, -1, 1);
      this.rudder = clamp(cc.rudderRigging + cc.yawTrim * yt, -1, 1);
    }
    residual(x, r);
    const trim = x[1]!;
    c.pitchTrim = clamp(trim >= 0 ? trim / cc.trimUp : trim / cc.trimDown, -1, 1);
    const thr = clamp(x[2]!, 0, 1);
    c.throttle.fill(thr);
    this.throttleIn.fill(thr);
    // Whatever trim cannot reach stays with the surface for now; the pilot must hold it.
    if (stabiliser) {
      this.stabiliser = trim;
      this.elevator = 0;
    } else this.elevator = trim;
    set(s.angularVelocity, 0, 0, 0);
    if (!running)
      for (const e of this.engines)
        if (e.kind === 'piston') (e as PistonPowerplant).engine.running = false;
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
