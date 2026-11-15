/**
 * The aircraft's systems as one unit the flight model drives: it reads the switches from the
 * cockpit by name, runs electrical, fuel, engine accessories, vacuum, hydraulics,
 * pressurisation and icing around the engine step, and fills the systems and instrument
 * telemetry. Which of them a type has, and what its switches are called, is its
 * `SystemsData`.
 */
import type { Cockpit } from '../cockpit';
import { clamp } from '../math';
import type { Powerplant, PowerplantInput } from '../propulsion';
import type { PistonPowerplant } from '../propulsion/piston';
import type { FailureId, Failures, SystemsTelemetry } from '../systemsTypes';
import type { AirSample } from '../types';
import type { PistonSystemsData, SystemsData, TurbineSystemsData } from './data';
import { Electrical, type GeneratorInput } from './electrical';
import { EngineManagement, MAG_START } from './engineManagement';
import { FuelSystem } from './fuel';
import { Hydraulics } from './hydraulics';
import { Icing, icingSeverity, meltRate } from './icing';
import { Instruments, newInstrumentInput, type InstrumentInput } from './instruments';
import { Pressurisation } from './pressurisation';

/** What the flight model knows after the engine step. */
export interface AfterEngine {
  /** True airspeed and the first propeller's slipstream speed increment, m/s. */
  tas: number;
  slipstream: number;
  /** Equivalence ratio of the first piston engine's mixture. */
  phi: number;
}

/** What the flight model tells the systems about the gear. */
export interface GearState {
  /** The lever and the gear disagree: it is (or should be) moving. */
  moving: boolean;
  /** Neither up nor down and locked. */
  unsafe: boolean;
}

/** The failure that stops each engine (the interface names only the first so far). */
const ENGINE_FAILURES: readonly FailureId[] = ['engine'];

export class AircraftSystems {
  readonly electrical: Electrical;
  readonly fuel: FuelSystem;
  /** The piston engine's magnetos, priming, induction and oil (the first engine's). */
  readonly engine: EngineManagement;
  readonly icing = new Icing();
  readonly instruments = new Instruments();
  readonly hydraulics: Hydraulics;
  readonly pressurisation: Pressurisation | undefined;
  /** The flight model fills the truth in here before `stepInstruments`. */
  readonly instrumentInput: InstrumentInput = newInstrumentInput();
  readonly telemetry: SystemsTelemetry = {
    busVolts: 0,
    batteryAmps: 0,
    batteryCharge: 1,
    avionicsPowered: false,
    fuelLeft: 0,
    fuelRight: 0,
    fuelAvailable: true,
    vacuum: 0,
    oilTemperature: 15,
    oilPressure: 0,
    egt: 0,
    carbIce: 0,
    airframeIce: 0,
    pitotBlocked: false,
    lights: { beacon: false, landing: false, taxi: false, nav: false, strobe: false },
    panelLight: 0,
    annunciators: {
      lowVolts: false,
      lowFuelLeft: false,
      lowFuelRight: false,
      lowVacuum: false,
      oilPressure: false,
    },
  };
  /** Suction, in Hg (an AHRS's power stands in for it on types without a vacuum pump). */
  suction = 0;
  /** The starter turns the first engine this step. */
  cranking = false;
  /** The flap motor has power. */
  flapsPowered = false;
  /** The flaps are moving (set by the flight model; the motor draws current). */
  flapsMoving = false;
  /** The gear can move, and what the flight model reports of it. */
  gearPowered = false;
  readonly gear: GearState = { moving: false, unsafe: false };
  /** The altimeters show standard pressure (BARO STD pressed). */
  baroStd = false;

  // Switch positions read once per step.
  private magnetos = 0;
  private selector = 1;
  private crankRequested = false;
  private lastStdButton = 0;
  /** Oil of each turbine: pressure psi, temperature °C. */
  private readonly oilPressure: Float64Array;
  private readonly oilTemperature: Float64Array;
  private readonly flows: Float64Array;
  private readonly speeds: Float64Array;
  private readonly generatorInputs: GeneratorInput[];
  private readonly batteryInputs: boolean[];
  private readonly piston: PistonSystemsData | undefined;
  private readonly turbine: TurbineSystemsData | undefined;

  constructor(
    readonly data: SystemsData,
    private readonly cockpit: Cockpit,
    private readonly failures: Failures,
    private readonly plants: readonly Powerplant[] = [],
    options: { retractableGear?: boolean } = {},
  ) {
    const n = Math.max(1, plants.length);
    this.electrical = new Electrical(data.electrical);
    this.fuel = new FuelSystem(data.fuel, n);
    this.piston = data.engine.kind === 'turbine' ? undefined : data.engine;
    this.turbine = data.engine.kind === 'turbine' ? data.engine : undefined;
    this.engine = new EngineManagement(
      this.piston ?? {
        singleMagnetoLoss: 0,
        alternateAirLoss: 0,
        oilPressure: 0,
        oilPressureMax: 0,
        lowOilPressure: 0,
      },
    );
    this.hydraulics = new Hydraulics(data.hydraulics ?? []);
    this.pressurisation = data.pressurisation ? new Pressurisation(data.pressurisation) : undefined;
    this.oilPressure = new Float64Array(n);
    this.oilTemperature = new Float64Array(n);
    this.flows = new Float64Array(n);
    this.speeds = new Float64Array(n);
    this.generatorInputs = data.electrical.generators.map(() => ({
      on: false,
      failed: false,
      speed: 0,
    }));
    this.batteryInputs = data.electrical.batteries.map(() => false);
    const t = this.telemetry;
    if (data.electrical.generators.length > 1) {
      t.annunciators.generators = data.electrical.generators.map(() => false);
      t.generatorAmps = data.electrical.generators.map(() => 0);
      t.batteryCharges = data.electrical.batteries.map(() => 1);
    }
    if (this.fuel.tanks.length > 2) t.fuelTanks = this.fuel.tanks.map(() => 0);
    if (this.hydraulics.systems.length > 0) t.hydraulics = this.hydraulics.systems.map(() => 0);
    if (this.pressurisation) {
      t.cabinAltitude = 0;
      t.cabinDifferential = 0;
      t.cabinRate = 0;
      t.annunciators.cabinAltitude = false;
    }
    if (this.turbine) {
      t.annunciators.starter = false;
      t.annunciators.ignition = false;
      if (this.turbine.separator) t.annunciators.inertialSeparator = false;
    }
    if (data.icing.boots) t.annunciators.deice = false;
    if (options.retractableGear) t.annunciators.gearUnsafe = false;
    if (cockpit.has('lightRecognition')) t.lights.recognition = false;
    if (cockpit.has('lightIce')) t.lights.ice = false;
    if (cockpit.has('baroStd')) this.instruments.telemetry.baroStd = false;
  }

  reset(running: boolean, inAir: boolean, air: AirSample) {
    const ambient = air.temperature - 273.15;
    this.electrical.reset(1);
    this.fuel.fill(this.fuel.tanks.map((t) => t.usable));
    this.engine.reset(running, ambient, inAir);
    this.icing.reset();
    this.hydraulics.reset(running);
    this.suction = running ? (this.data.vacuum?.suction ?? 5) : 0;
    this.cranking = false;
    this.flapsMoving = false;
    this.gear.moving = false;
    this.gear.unsafe = false;
    this.baroStd = false;
    this.lastStdButton = 0;
    const tb = this.turbine;
    this.oilPressure.fill(running && tb ? tb.oilPressure : 0);
    this.oilTemperature.fill(
      running && tb ? (inAir ? tb.oilTemperature : tb.oilTemperature - 15) : ambient,
    );
    this.pressurisation?.reset(
      air.pressure,
      running && inAir,
      this.cockpit.get(this.data.pressurisation?.cabinAltitude ?? ''),
    );
  }

  /** Accessory speed of every engine, for generators and pumps. */
  private readSpeeds() {
    for (let i = 0; i < this.speeds.length; i++)
      this.speeds[i] = this.plants[i]?.accessorySpeed ?? 0;
  }

  /**
   * Before the engines are evaluated: bus voltage, starter, ignition, induction, bleed and
   * fuel supply, into each engine's input. `starterInput`: ControlInput's starter per engine.
   */
  beforeEngines(
    dt: number,
    inputs: PowerplantInput[],
    starterInput: readonly boolean[] | undefined,
    time: number,
  ) {
    const c = this.cockpit;
    const d = this.data;
    const loads = d.electrical.loads;
    const bus = this.electrical.busPowered;
    this.readSpeeds();
    const first = this.plants[0];
    const piston = first?.kind === 'piston' ? (first as PistonPowerplant) : undefined;
    this.selector = d.fuel.selector ? c.get(d.fuel.selector.control) : 1;
    let battery = false;
    for (let i = 0; i < d.electrical.batteries.length; i++) {
      this.batteryInputs[i] = c.get(d.electrical.batteries[i]!.switch) === 1;
      battery ||= this.batteryInputs[i]!;
    }
    let load = loads.base;
    for (const l of loads.switched) load += l.amps * c.get(l.control);
    for (const l of d.fuel.pumps ?? []) load += l.amps * c.get(l.control);
    if (this.flapsMoving && bus) load += loads.flapsMotor;
    if (loads.gearMotor && bus) {
      for (let i = 0; i < this.hydraulics.systems.length; i++)
        if (this.hydraulics.pumping[i]) load += loads.gearMotor;
      if (d.hydraulics === undefined && this.gear.moving && this.gearPowered)
        load += loads.gearMotor;
    }
    if (piston) {
      this.magnetos = c.get('magnetos');
      // ControlInput's starter is the key held in START, whatever the switch shows.
      this.crankRequested = (starterInput?.[0] ?? false) || this.magnetos === MAG_START;
      if (this.crankRequested && battery)
        // Once the engine runs past the starter's speed the pinion overruns and the draw falls.
        load +=
          piston.engine.rpm < piston.def.engine.starterRpm ? loads.starter : loads.starter * 0.15;
    } else if (this.turbine && battery) {
      // A starter-generator draws most while it breaks the gas generator loose.
      for (let i = 0; i < this.plants.length; i++) {
        const p = this.plants[i]!;
        if (
          p.cranking ||
          (starterInput?.[i] ?? false) ||
          (i === 0 && c.get(this.turbine.starter) === 1)
        )
          load += loads.starter * (1 - 0.6 * clamp(p.accessorySpeed / 50, 0, 1));
      }
    }
    for (let k = 0; k < d.electrical.generators.length; k++) {
      const g = d.electrical.generators[k]!;
      const gi = this.generatorInputs[k]!;
      gi.on = c.get(g.switch) === 1;
      gi.failed = g.failure !== undefined && this.failures.active(g.failure);
      gi.speed = this.speeds[g.engine] ?? 0;
      // A starter-generator is a motor while it cranks.
      if (this.plants[g.engine]?.cranking && this.turbine) gi.speed = 0;
    }
    this.electrical.step(dt, {
      battery,
      alternator: this.generatorInputs[0]?.on ?? false,
      alternatorFailed: this.generatorInputs[0]?.failed ?? false,
      rpm: this.speeds[0] ?? 0,
      batteries: this.batteryInputs,
      generators: this.generatorInputs,
      mainLoad: load,
      avionicsSwitch: c.get(d.electrical.avionicsSwitch) === 1,
    });
    const volts = this.electrical.volts;
    const powered = this.electrical.busPowered;
    this.flapsPowered = powered;
    const starterPower = clamp((volts - 10) / 9, 0, 1);
    this.fuel.updateSupply(this.selector, d.fuel.shutoff ? c.get(d.fuel.shutoff) === 1 : true);
    this.gearPowered = this.gearPower(powered);
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      input.hasFuel = this.fuel.hasFuel(i);
      const failure = ENGINE_FAILURES[i];
      input.failed = failure !== undefined && this.failures.active(failure);
      input.starterPower = starterPower;
      if (piston && i === 0) {
        this.cranking = this.crankRequested && battery && starterPower > 0;
        input.starter = this.cranking;
        input.ignition = this.engine.ignition(
          this.crankRequested ? MAG_START : this.magnetos,
          this.failures.active('magnetoLeft'),
          time,
        );
        input.intake = this.engine.intake(c.get('carbHeat'));
        input.fireable = this.engine.fireable;
      } else if (this.turbine) {
        const tb = this.turbine;
        input.starter =
          battery && ((starterInput?.[i] ?? false) || (i === 0 && c.get(tb.starter) === 1));
        input.ignition = powered ? 1 : 0;
        input.continuousIgnition = c.get(tb.ignition) === 1;
        input.inertialSeparator = tb.separator !== undefined && c.get(tb.separator) === 1;
        input.bleed = i === 0 ? this.bleed() : 0;
        if (i === 0) this.cranking = this.plants[0]?.cranking ?? false;
      } else {
        input.starter = starterInput?.[i] ?? false;
      }
    }
  }

  /** Bleed air off the first engine for the cabin, W of shaft power. */
  private bleed(): number {
    const p = this.data.pressurisation;
    if (!p) return 0;
    return this.cockpit.get(p.ecs) === 1 ? p.bleedPower : 0;
  }

  private gearPower(bus: boolean): boolean {
    const h = this.data.hydraulics;
    if (!h || h.length === 0) return bus;
    // The gear's own system: the first one (the type names it in its gear definition).
    return this.hydraulics.pressure[0]! > 0.6 * h[0]!.pressure;
  }

  /** Pressure share of a hydraulic system (1 if the type has no such system). */
  hydraulicShare(id: string) {
    return this.hydraulics.share(id);
  }

  /** After the engine step: fuel burnt, temperatures, vacuum, priming, hydraulics, cabin, ice. */
  afterEngines(dt: number, out: AfterEngine, air: AirSample) {
    const c = this.cockpit;
    const d = this.data;
    const failures = this.failures;
    for (let i = 0; i < this.flows.length; i++) this.flows[i] = this.plants[i]?.fuelFlow ?? 0;
    this.fuel.consume(dt, this.flows, this.selector, failures.active('fuelLeak'));
    this.readSpeeds();
    const first = this.plants[0];
    const ambient = air.temperature - 273.15;
    if (d.vacuum) {
      const rpm = first?.accessorySpeed ?? 0;
      const suctionTarget = failures.active('vacuum')
        ? 0
        : d.vacuum.suction * clamp(rpm / d.vacuum.fullRpm, 0, 1);
      this.suction += (suctionTarget - this.suction) * (1 - Math.exp(-dt / 1));
    } else {
      // An AHRS: what it needs is power, not suction.
      this.suction = this.electrical.busPowered ? 5 : 0;
    }
    if (first?.kind === 'piston') {
      const piston = first as PistonPowerplant;
      const rpm = piston.engine.rpm;
      const pump = c.get('fuelPump') === 1 && this.electrical.busPowered;
      this.engine.stepPrime(
        dt,
        pump,
        c.get('mixture'),
        this.fuel.fuelAvailable,
        this.cranking,
        piston.engine.running,
      );
      this.engine.stepTemperatures(dt, {
        running: piston.engine.running,
        rpm,
        load: piston.load,
        coolingSpeed: Math.hypot(out.tas, out.slipstream),
        ambientC: ambient,
        phi: out.phi,
      });
    } else if (this.turbine) this.turbineOil(dt, ambient);
    const severity = icingSeverity(ambient, air.moisture ?? 0);
    const melt = meltRate(ambient);
    const probe = d.icing.probeHeat;
    const pitotHeat =
      (c.get(probe?.control ?? 'pitotHeat') === 1 ||
        (probe?.auto === true && this.plants.some((p) => p.running))) &&
      this.electrical.busPowered;
    const boots = d.icing.boots;
    const bootCycle =
      boots && this.electrical.busPowered && (first?.running ?? false)
        ? (boots.cycles[c.get(boots.control)] ?? 0)
        : 0;
    this.icing.step(
      dt,
      severity,
      melt,
      out.tas / 55,
      pitotHeat,
      failures.active('pitot'),
      bootCycle,
    );
    if (first?.kind === 'piston')
      this.engine.stepInductionIce(
        dt,
        severity,
        melt,
        c.get('carbHeat'),
        first.running ? clamp(first.accessorySpeed / 2700, 0, 1) : 0,
      );
    this.hydraulics.step(dt, this.speeds, () => this.gear.moving, this.electrical.busPowered);
    const p = this.pressurisation;
    if (p) {
      const pd = p.data;
      const bleed =
        c.get(pd.ecs) === 1 && (first?.running ?? false) && (first?.accessorySpeed ?? 0) > 55;
      const before = p.cabinAltitude;
      p.step(dt, air.pressure, bleed, c.get(pd.mode) === 1, c.get(pd.cabinAltitude));
      this.telemetry.cabinRate = dt > 0 ? (p.cabinAltitude - before) / dt : 0;
    }
    this.fillTelemetry(air.pressure);
  }

  /** Turbine oil: pressure with the gas generator, temperature with the load. */
  private turbineOil(dt: number, ambient: number) {
    const tb = this.turbine!;
    for (let i = 0; i < this.plants.length; i++) {
      const p = this.plants[i]!;
      const share = clamp(p.accessorySpeed / tb.normalSpeed, 0, 1);
      const pTarget = tb.oilPressure * share ** 1.5;
      this.oilPressure[i] =
        this.oilPressure[i]! + (pTarget - this.oilPressure[i]!) * (1 - Math.exp(-dt / 1));
      const tTarget = p.running
        ? ambient + (tb.oilTemperature - 15) * (0.6 + 0.4 * clamp(p.load, 0, 1.1)) + 15
        : ambient;
      const tau = p.running ? 300 : 1200;
      this.oilTemperature[i] =
        this.oilTemperature[i]! + (tTarget - this.oilTemperature[i]!) * (1 - Math.exp(-dt / tau));
      p.telemetry.oilPressure = this.oilPressure[i]!;
      p.telemetry.oilTemperature = this.oilTemperature[i]!;
    }
  }

  /** The instruments, from the truth the flight model wrote into `instrumentInput`. */
  stepInstruments(dt: number) {
    this.prepareInstruments();
    this.instruments.step(dt, this.instrumentInput);
  }

  resetInstruments(running: boolean) {
    this.prepareInstruments();
    this.instruments.reset(running, this.instrumentInput);
  }

  private prepareInstruments() {
    const i = this.instrumentInput;
    const c = this.cockpit;
    if (c.has('baroStd')) {
      const b = c.get('baroStd');
      if (b >= 0.5 && this.lastStdButton < 0.5) this.baroStd = !this.baroStd;
      this.lastStdButton = b;
      this.instruments.telemetry.baroStd = this.baroStd;
    }
    i.suction = this.suction;
    i.lowSuction = this.data.vacuum?.low ?? 3;
    i.slaved = this.data.vacuum === undefined;
    i.turnPowered = this.electrical.busPowered;
    i.pitotBlocked = this.icing.pitotBlocked;
    i.altimeterSetting = this.baroStd ? 1013.25 : c.get('altimeterSetting');
    i.gyroAdjust = c.get('gyroAdjust');
    const tanks = this.fuel.tanks;
    i.fuelLeft = this.fuel.left / (tanks[0]?.usable ?? 1);
    i.fuelRight = this.fuel.right / (tanks[1]?.usable ?? 1);
    i.gaugesPowered = this.electrical.busPowered;
  }

  fillTelemetry(outsidePressure?: number) {
    const t = this.telemetry;
    const c = this.cockpit;
    const e = this.electrical;
    const d = this.data;
    const bus = e.busPowered;
    t.busVolts = e.volts;
    t.batteryAmps = e.amps;
    t.batteryCharge = e.charge;
    t.avionicsPowered = e.avionicsPowered;
    t.fuelLeft = this.fuel.left;
    t.fuelRight = this.fuel.right;
    t.fuelAvailable = this.fuel.fuelAvailable;
    t.vacuum = d.vacuum ? this.suction : 0;
    const tb = this.turbine;
    const first = this.plants[0];
    if (tb) {
      t.oilTemperature = this.oilTemperature[0]!;
      t.oilPressure = this.oilPressure[0]!;
      const itt = first?.telemetry.turbineTemperature ?? 15;
      t.egt = clamp(itt / 850, 0, 1.5);
    } else {
      t.oilTemperature = this.engine.oilTemperature;
      t.oilPressure = this.engine.oilPressure;
      t.egt = this.engine.egt;
    }
    t.carbIce = this.engine.inductionIce;
    t.airframeIce = this.icing.airframe;
    t.pitotBlocked = this.icing.pitotBlocked;
    const l = t.lights;
    l.beacon = bus && c.get('lightBeacon') === 1;
    l.landing = bus && c.get('lightLanding') === 1;
    l.taxi = bus && c.get('lightTaxi') === 1;
    l.nav = bus && c.get('lightNav') === 1;
    l.strobe = bus && c.get('lightStrobe') === 1;
    if (l.recognition !== undefined) l.recognition = bus && c.get('lightRecognition') === 1;
    if (l.ice !== undefined) l.ice = bus && c.get('lightIce') === 1;
    t.panelLight = bus ? c.get('lightPanel') : 0;
    // The annunciator lamps need some voltage to light, but far less than the rest of the bus.
    const lit = e.volts > 8;
    const a = t.annunciators;
    a.lowVolts = lit && e.volts < d.electrical.lowVolts;
    a.lowFuelLeft = lit && this.fuel.left < d.fuel.lowFuel;
    a.lowFuelRight = lit && this.fuel.right < d.fuel.lowFuel;
    a.lowVacuum = lit && d.vacuum !== undefined && this.suction < d.vacuum.low;
    a.oilPressure =
      lit &&
      (tb
        ? this.oilPressure[0]! < tb.lowOilPressure
        : this.engine.oilPressure < (d.engine as PistonSystemsData).lowOilPressure);
    if (a.generators) {
      for (let k = 0; k < a.generators.length; k++) {
        a.generators[k] = lit && e.generatorOnline[k] === 0;
        t.generatorAmps![k] = e.generatorAmps[k]!;
      }
      for (let k = 0; k < e.charges.length; k++) t.batteryCharges![k] = e.charges[k]!;
    }
    if (t.fuelTanks)
      for (let k = 0; k < t.fuelTanks.length; k++) t.fuelTanks[k] = this.fuel.amount[k]!;
    if (t.hydraulics) {
      let low = false;
      for (let k = 0; k < t.hydraulics.length; k++) {
        t.hydraulics[k] = this.hydraulics.pressure[k]!;
        // Only systems with an engine pump are expected to hold pressure all the time.
        if (
          this.hydraulics.systems[k]!.enginePumps?.length &&
          this.hydraulics.pressure[k]! < 0.5 * this.hydraulics.systems[k]!.pressure
        )
          low = true;
      }
      a.hydraulics = lit && low;
    }
    if (a.gearUnsafe !== undefined) a.gearUnsafe = lit && this.gear.unsafe;
    const p = this.pressurisation;
    if (p) {
      t.cabinAltitude = p.cabinAltitude;
      if (outsidePressure !== undefined) t.cabinDifferential = p.cabinPressure - outsidePressure;
      a.cabinAltitude = lit && p.cabinAltitude > p.data.warning;
    }
    if (tb) {
      a.starter = lit && (first?.cranking ?? false);
      a.ignition = lit && bus && ((first?.cranking ?? false) || c.get(tb.ignition) === 1);
      if (tb.separator) a.inertialSeparator = lit && c.get(tb.separator) === 1;
    }
    if (d.icing.boots) a.deice = lit && c.get(d.icing.boots.control) > 0;
  }
}
