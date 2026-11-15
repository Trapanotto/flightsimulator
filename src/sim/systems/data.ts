/**
 * Figures of an aircraft's systems, and the names of the cockpit controls that drive them.
 * The systems code is generic; a type lists its batteries, generators, tanks, pumps,
 * hydraulic systems, pressurisation and ice protection here (the C172S ones, with their
 * sources, are in c172.ts; the PC-12's in pc12.ts).
 */
import type { FailureId } from '../systemsTypes';

export interface BatteryData {
  /** The cockpit switch that connects it to the bus. */
  switch: string;
  /** Capacity, ampere hours, and internal resistance, ohm. */
  ampHours: number;
  resistance: number;
  /** Open-circuit voltage of a full battery and of one at 20 % charge (below, it collapses). */
  fullVolts: number;
  lowVolts: number;
}

export interface GeneratorData {
  /** The cockpit switch that puts it on line. */
  switch: string;
  /** The engine whose accessory drive turns it (its `accessorySpeed`: rpm or per cent). */
  engine: number;
  /** Regulated voltage and maximum output, A. */
  volts: number;
  amps: number;
  /** Drive speed where it starts to give current and where it gives all of it. */
  cutIn: number;
  full: number;
  /** The failure that takes it off line. */
  failure?: FailureId;
}

/** A consumer switched by a cockpit control: draws `amps` times the control's value. */
export interface ElectricalLoad {
  control: string;
  amps: number;
}

export interface ElectricalData {
  batteries: BatteryData[];
  generators: GeneratorData[];
  /** Below this the low-voltage annunciator lights. */
  lowVolts: number;
  /** Below these the avionics drop off, and then everything else on the main bus. */
  avionicsMinVolts: number;
  busMinVolts: number;
  /** The switch that feeds the avionics bus from the main bus. */
  avionicsSwitch: string;
  /** Current of each consumer at bus voltage, A. */
  loads: {
    /** Engine instruments, annunciators, turn coordinator, fuel gauges: always on with the master. */
    base: number;
    avionics: number;
    flapsMotor: number;
    /** A piston starter at full draw; a turbine's starter-generator cranking. */
    starter: number;
    /** The gear motor or the electric hydraulic pump while it runs. */
    gearMotor?: number;
    /** Lights, heaters, pumps: in the order they are summed. */
    switched: ElectricalLoad[];
  };
}

export interface TankData {
  id: string;
  /** Usable fuel, kg. */
  usable: number;
  /** Where its fuel sits, body frame, m (its weight off the centre line rolls the aircraft). */
  position: { x: number; y: number; z: number };
}

export interface FuelData {
  /**
   * Shorthand for the usual two wing tanks (left, then right): usable fuel of each (kg) and
   * their lateral arm (m). `tanks` replaces them for other layouts.
   */
  tankUsable: number;
  tankArm: number;
  tanks?: TankData[];
  /** The low-fuel annunciator of a tank lights below this, kg. */
  lowFuel: number;
  /** What the fuel leak failure loses from the first tank, kg/s. */
  leakRate: number;
  /** Fuel in the lines and the fuel control after the supply stops, kg. */
  lineFuel: number;
  /** Fuel selector: its control and the tanks each position feeds. Without one, all tanks feed. */
  selector?: { control: string; feeds: number[][] };
  /** Shutoff (firewall) valve control, 1 = open. Without one the valve is always open. */
  shutoff?: string;
  /** Tanks each engine may draw from (default: every tank the selector allows). */
  engineFeeds?: number[][];
  /** Automatic balancing keeps the tanks within this many kg of each other. */
  balance?: number;
  /** Electric boost pumps: control and current. */
  pumps?: ElectricalLoad[];
}

/** Engine accessories of a piston engine: magnetos, induction, oil. */
export interface PistonSystemsData {
  kind?: 'piston';
  /** Power lost on one magneto (one spark plug per cylinder burns slower). */
  singleMagnetoLoss: number;
  /** Power lost with the alternate air door open (warmer, unfiltered air). */
  alternateAirLoss: number;
  /** Oil pressure, psi: warm at rated rpm, and the relief valve's limit. */
  oilPressure: number;
  oilPressureMax: number;
  /** Annunciator thresholds: oil pressure (psi). */
  lowOilPressure: number;
}

/** Engine accessories of a turbine: start, ignition, inlet, oil. */
export interface TurbineSystemsData {
  kind: 'turbine';
  /** Cockpit controls: start button, ignition selector (0 auto, 1 on), inertial separator. */
  starter: string;
  ignition: string;
  separator?: string;
  /** Oil pressure (psi) at and above `normalSpeed` (per cent of the accessory drive), and the low warning. */
  oilPressure: number;
  normalSpeed: number;
  lowOilPressure: number;
  /** Warm oil temperature at cruise, °C. */
  oilTemperature: number;
}

export interface VacuumData {
  /** Regulated suction, in Hg, the engine rpm it is reached at, and the annunciator limit. */
  suction: number;
  fullRpm: number;
  low: number;
}

export interface HydraulicData {
  id: string;
  /** Nominal pressure, psi. */
  pressure: number;
  /** Engine-driven pumps (engine index, minimum accessory speed) and an electric pump's current. */
  enginePumps?: { engine: number; minSpeed: number }[];
  /** An electric pump that runs on demand (while the gear moves), its current, A. */
  electricPump?: number;
}

export interface PressurisationData {
  /** Maximum cabin differential pressure, Pa. */
  maxDifferential: number;
  /** Cabin climb and descent rates the controller holds, m/s. */
  climbRate: number;
  descentRate: number;
  /** The cabin altitude warning lights above this, m. */
  warning: number;
  /** Bleed air for heating and pressurisation, as shaft power off the gas generator, W. */
  bleedPower: number;
  /** Controls: ECS (bleed) switch, mode selector (0 auto, 1 dump), cabin altitude knob (ft). */
  ecs: string;
  mode: string;
  cabinAltitude: string;
}

export interface IcingData {
  /** Extra mass of heavy airframe ice, kg. */
  iceMass: number;
  /** Pneumatic de-icing boots: selector control and the cycle period of each position, s (0 off). */
  boots?: { control: string; cycles: number[] };
}

export interface SystemsData {
  electrical: ElectricalData;
  fuel: FuelData;
  /** Accessories of the engines (all engines of a type are alike). */
  engine: PistonSystemsData | TurbineSystemsData;
  /** Vacuum pump for the gyros; without one the attitude and heading come from an AHRS on the bus. */
  vacuum?: VacuumData;
  icing: IcingData;
  hydraulics?: HydraulicData[];
  pressurisation?: PressurisationData;
  /** What can fail on this type (default: the C172S's list). */
  failures?: readonly FailureId[];
}
