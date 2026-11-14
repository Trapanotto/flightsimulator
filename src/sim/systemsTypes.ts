/**
 * Contracts of the aircraft systems (phase 3): what the electrical, fuel and vacuum systems
 * report, what the instruments show (which is not always the truth), and what can fail.
 */

/** The state of the systems, refreshed every step. */
export interface SystemsTelemetry {
  /** Main bus voltage, V (0 with the battery off and the alternator not charging). */
  busVolts: number;
  /** Ammeter: positive charges the battery, negative drains it, A. */
  batteryAmps: number;
  /** Battery charge 0..1. */
  batteryCharge: number;
  /** The avionics bus is powered (master switch, avionics switch and enough voltage). */
  avionicsPowered: boolean;
  /** Usable fuel in the left and right tank, kg. */
  fuelLeft: number;
  fuelRight: number;
  /** Fuel reaches the engine (selector, shutoff valve, a tank that is not empty). */
  fuelAvailable: boolean;
  /** Suction of the vacuum pump, inches of mercury (about 5 in flight, 0 when it fails). */
  vacuum: number;
  /** Oil temperature (°C) and pressure (psi). */
  oilTemperature: number;
  oilPressure: number;
  /** Exhaust gas temperature as a share of its peak, 0..1 (leaning moves it). */
  egt: number;
  /** Ice in the carburettor, 0 clear .. 1 choked. */
  carbIce: number;
  /** Ice on the airframe, 0 clean .. 1 heavy. */
  airframeIce: number;
  /** The pitot tube is blocked by ice: the airspeed indicator is wrong. */
  pitotBlocked: boolean;
  /** Which exterior lights are lit (switch on and the bus powered). */
  lights: { beacon: boolean; landing: boolean; taxi: boolean; nav: boolean; strobe: boolean };
  /** Panel lighting 0..1 (knob and power). */
  panelLight: number;
  /** The annunciator panel. */
  annunciators: {
    lowVolts: boolean;
    lowFuelLeft: boolean;
    lowFuelRight: boolean;
    lowVacuum: boolean;
    oilPressure: boolean;
  };
}

/**
 * What the flight instruments show. Mostly the truth, but a gyro without suction topples, a
 * blocked pitot tube freezes the airspeed, an unpowered turn coordinator stops, and the
 * altimeter reads for its setting. The 3D gauges and any on-screen instruments read these.
 */
export interface InstrumentTelemetry {
  /** Airspeed indicator, m/s. */
  airspeed: number;
  /** Attitude indicator: pitch and bank, radians. */
  pitch: number;
  bank: number;
  /** Altimeter, metres, for the altimeter setting. */
  altitude: number;
  /** Vertical speed indicator, m/s (lags a few seconds). */
  verticalSpeed: number;
  /** Directional gyro, degrees magnetic (drifts; `gyroAdjust` corrects it). */
  heading: number;
  /** Magnetic compass, degrees (lags and swings in turns and accelerations). */
  compass: number;
  /** Turn coordinator: rate of turn in degrees per second (3 = standard rate), positive right. */
  turnRate: number;
  /** The ball: -1 full left .. 1 full right. */
  slip: number;
  /** Fuel gauges, 0..1 of a full tank. */
  fuelLeft: number;
  fuelRight: number;
  /** Flags on the gauges: no suction for the gyros, no power for the turn coordinator. */
  gyroFlag: boolean;
  turnFlag: boolean;
}

/** What can be made to fail. */
export type FailureId =
  /** The engine stops producing power. */
  | 'engine'
  /** The alternator stops charging: the battery drains. */
  | 'alternator'
  /** The vacuum pump fails: attitude indicator and directional gyro topple slowly. */
  | 'vacuum'
  /** The pitot tube blocks whatever the heat does. */
  | 'pitot'
  /** A fuel leak in the left tank. */
  | 'fuelLeak'
  /** COM 1 goes dead. */
  | 'com1'
  /** The left magneto fails (rough running and a power loss on LEFT, a stop on LEFT alone). */
  | 'magnetoLeft';

export interface Failures {
  /** The failures this aircraft knows. */
  readonly ids: readonly FailureId[];
  active(id: FailureId): boolean;
  /** Fails or repairs something. Unknown names are ignored. */
  set(id: FailureId, failed: boolean): void;
  /** Everything works again. */
  clear(): void;
}
