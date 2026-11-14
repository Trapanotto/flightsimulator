/**
 * The aircraft's systems as one unit the flight model drives: it reads the switches from the
 * cockpit by name, runs electrical, fuel, engine management, vacuum and icing around the
 * engine evaluation, and fills the systems and instrument telemetry.
 */
import type { Cockpit } from '../cockpit';
import type { PistonEngine } from '../engine';
import { clamp } from '../math';
import type { Failures, SystemsTelemetry } from '../systemsTypes';
import type { AirSample } from '../types';
import type { SystemsData } from './data';
import { Electrical } from './electrical';
import { EngineManagement, MAG_START } from './engineManagement';
import { FuelSystem } from './fuel';
import { Icing, icingSeverity, meltRate } from './icing';
import { Instruments, newInstrumentInput, type InstrumentInput } from './instruments';

/** What the flight model knows after the engine step. */
export interface AfterEngine {
  /** kg/s burnt by the engine. */
  fuelFlow: number;
  /** Brake power over rated power. */
  load: number;
  /** True airspeed and the slipstream's extra speed, m/s. */
  tas: number;
  slipstream: number;
  /** Equivalence ratio of the mixture burning. */
  phi: number;
}

export class AircraftSystems {
  readonly electrical: Electrical;
  readonly fuel: FuelSystem;
  readonly engine: EngineManagement;
  readonly icing = new Icing();
  readonly instruments = new Instruments();
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
  /** Suction, in Hg. */
  suction = 0;
  /** The starter turns the engine this step. */
  cranking = false;
  /** The flap motor has power. */
  flapsPowered = false;
  /** The flaps are moving (set by the flight model; the motor draws current). */
  flapsMoving = false;

  // Switch positions read once per step.
  private magnetos = 0;
  private selector = 1;
  private crankRequested = false;

  constructor(
    readonly data: SystemsData,
    private readonly cockpit: Cockpit,
    private readonly failures: Failures,
  ) {
    this.electrical = new Electrical(data.electrical);
    this.fuel = new FuelSystem(data.fuel);
    this.engine = new EngineManagement(data.engine);
  }

  reset(running: boolean, inAir: boolean, air: AirSample) {
    const ambient = air.temperature - 273.15;
    this.electrical.reset(1);
    this.fuel.reset(this.data.fuel.tankUsable, this.data.fuel.tankUsable);
    this.engine.reset(running, ambient, inAir);
    this.icing.reset();
    this.suction = running ? this.data.vacuum.suction : 0;
    this.cranking = false;
    this.flapsMoving = false;
  }

  /**
   * Before the engine is evaluated: bus voltage, starter, ignition, induction and fuel
   * supply. Returns whether the starter turns the engine.
   */
  beforeEngine(dt: number, eng: PistonEngine, starterInput: boolean, time: number): boolean {
    const c = this.cockpit;
    const loads = this.data.electrical.loads;
    const bus = this.electrical.busPowered;
    this.magnetos = c.get('magnetos');
    this.selector = c.get('fuelSelector');
    // ControlInput's starter is the key held in START, whatever the switch shows.
    this.crankRequested = starterInput || this.magnetos === MAG_START;
    const battery = c.get('battery') === 1;
    let load = loads.base + loads.panelLights * c.get('lightPanel');
    if (c.get('lightBeacon')) load += loads.beacon;
    if (c.get('lightStrobe')) load += loads.strobe;
    if (c.get('lightNav')) load += loads.nav;
    if (c.get('lightLanding')) load += loads.landing;
    if (c.get('lightTaxi')) load += loads.taxi;
    if (c.get('pitotHeat')) load += loads.pitotHeat;
    if (c.get('fuelPump')) load += loads.fuelPump;
    if (this.flapsMoving && bus) load += loads.flapsMotor;
    if (this.crankRequested && battery)
      // Once the engine runs past the starter's speed the pinion overruns and the draw falls.
      load += eng.rpm < eng.data.starterRpm ? loads.starter : loads.starter * 0.15;
    this.electrical.step(dt, {
      battery,
      alternator: c.get('alternator') === 1,
      alternatorFailed: this.failures.active('alternator'),
      rpm: eng.rpm,
      mainLoad: load,
      avionicsSwitch: c.get('avionics') === 1,
    });
    const volts = this.electrical.volts;
    this.flapsPowered = this.electrical.busPowered;
    eng.starterPower = clamp((volts - 10) / 9, 0, 1);
    this.cranking = this.crankRequested && battery && eng.starterPower > 0;
    this.fuel.updateSupply(this.selector, c.get('fuelShutoff') === 1);
    eng.ignition = this.engine.ignition(
      this.crankRequested ? MAG_START : this.magnetos,
      this.failures.active('magnetoLeft'),
      time,
    );
    eng.intake = this.engine.intake(c.get('carbHeat'));
    eng.fireable = this.engine.fireable;
    eng.failed = this.failures.active('engine');
    return this.cranking;
  }

  /** After the engine step: fuel burnt, temperatures, vacuum, priming and ice. */
  afterEngine(dt: number, eng: PistonEngine, out: AfterEngine, air: AirSample) {
    const c = this.cockpit;
    const d = this.data;
    const failures = this.failures;
    this.fuel.consume(dt, out.fuelFlow, this.selector, failures.active('fuelLeak'));
    const rpm = eng.rpm;
    const suctionTarget = failures.active('vacuum')
      ? 0
      : d.vacuum.suction * clamp(rpm / d.vacuum.fullRpm, 0, 1);
    this.suction += (suctionTarget - this.suction) * (1 - Math.exp(-dt / 1));
    const pump = c.get('fuelPump') === 1 && this.electrical.busPowered;
    this.engine.stepPrime(
      dt,
      pump,
      c.get('mixture'),
      this.fuel.fuelAvailable,
      this.cranking,
      eng.running,
    );
    const ambient = air.temperature - 273.15;
    this.engine.stepTemperatures(dt, {
      running: eng.running,
      rpm,
      load: out.load,
      coolingSpeed: Math.hypot(out.tas, out.slipstream),
      ambientC: ambient,
      phi: out.phi,
    });
    const severity = icingSeverity(ambient, air.moisture ?? 0);
    const melt = meltRate(ambient);
    const pitotHeat = c.get('pitotHeat') === 1 && this.electrical.busPowered;
    this.icing.step(dt, severity, melt, out.tas / 55, pitotHeat, failures.active('pitot'));
    this.engine.stepInductionIce(
      dt,
      severity,
      melt,
      c.get('carbHeat'),
      eng.running ? clamp(rpm / 2700, 0, 1) : 0,
    );
    this.fillTelemetry();
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
    i.suction = this.suction;
    i.lowSuction = this.data.vacuum.low;
    i.turnPowered = this.electrical.busPowered;
    i.pitotBlocked = this.icing.pitotBlocked;
    i.altimeterSetting = c.get('altimeterSetting');
    i.gyroAdjust = c.get('gyroAdjust');
    const full = this.data.fuel.tankUsable;
    i.fuelLeft = this.fuel.left / full;
    i.fuelRight = this.fuel.right / full;
    i.gaugesPowered = this.electrical.busPowered;
  }

  fillTelemetry() {
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
    t.vacuum = this.suction;
    t.oilTemperature = this.engine.oilTemperature;
    t.oilPressure = this.engine.oilPressure;
    t.egt = this.engine.egt;
    t.carbIce = this.engine.inductionIce;
    t.airframeIce = this.icing.airframe;
    t.pitotBlocked = this.icing.pitotBlocked;
    const l = t.lights;
    l.beacon = bus && c.get('lightBeacon') === 1;
    l.landing = bus && c.get('lightLanding') === 1;
    l.taxi = bus && c.get('lightTaxi') === 1;
    l.nav = bus && c.get('lightNav') === 1;
    l.strobe = bus && c.get('lightStrobe') === 1;
    t.panelLight = bus ? c.get('lightPanel') : 0;
    // The annunciator lamps need some voltage to light, but far less than the rest of the bus.
    const lit = e.volts > 8;
    const a = t.annunciators;
    a.lowVolts = lit && e.volts < d.electrical.lowVolts;
    a.lowFuelLeft = lit && this.fuel.left < d.fuel.lowFuel;
    a.lowFuelRight = lit && this.fuel.right < d.fuel.lowFuel;
    a.lowVacuum = lit && this.suction < d.vacuum.low;
    a.oilPressure = lit && this.engine.oilPressure < d.engine.lowOilPressure;
  }
}
