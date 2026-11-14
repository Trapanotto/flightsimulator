/**
 * The flight instruments: what the pilot reads, built from the truth through each
 * instrument's own physics. Vacuum gyros that run down and topple, a directional gyro that
 * drifts with the Earth's rotation, a pendulous magnetic compass whose card hangs along the
 * apparent gravity (which is where its turning and acceleration errors come from), a
 * barometric altimeter and vertical speed indicator, a pitot-static airspeed indicator that
 * can freeze, and the electric turn coordinator.
 */
import { DEG, clamp, cross, dot, normalize, vec } from '../math';
import type { InstrumentTelemetry } from '../systemsTypes';
import type { Vec3 } from '../types';

const G0 = 9.80665;
/** Earth's rotation, degrees per second. */
const EARTH_RATE = 360 / 86_164;
// ISA constants for the altimeter (ICAO Doc 7488).
const T0 = 288.15;
const LAPSE = 0.0065;
const R_AIR = 287.053;
const ALT_EXPONENT = (R_AIR * LAPSE) / G0;
const SEA_LEVEL_DENSITY = 1.225;

/** The truth and the conditions the instruments work from, refreshed by the caller each step. */
export interface InstrumentInput {
  /** True attitude, radians, and true heading, degrees. */
  pitch: number;
  bank: number;
  headingDeg: number;
  /** Body rates, rad/s. */
  p: number;
  q: number;
  r: number;
  /** Indicated airspeed the pitot-static system gives when clear, m/s. */
  ias: number;
  /** Static pressure, Pa; air density, kg/m^3. */
  staticPressure: number;
  density: number;
  /** Local frame and the body's forward axis, world frame. */
  up: Vec3;
  north: Vec3;
  forward: Vec3;
  /** Specific force (what an accelerometer feels), world frame, m/s^2; body y component. */
  specificForce: Vec3;
  lateralSpecificForce: number;
  /** Geodetic latitude, degrees; magnetic declination, degrees east. */
  latitude: number;
  declination: number;
  /** Vacuum suction, in Hg; the turn coordinator has power. */
  suction: number;
  turnPowered: boolean;
  lowSuction: number;
  pitotBlocked: boolean;
  /** Altimeter setting, hPa; directional gyro adjustment, degrees. */
  altimeterSetting: number;
  gyroAdjust: number;
  /** Fuel gauges, 0..1 of a full tank, and whether they have power. */
  fuelLeft: number;
  fuelRight: number;
  gaugesPowered: boolean;
}

export const newInstrumentInput = (): InstrumentInput => ({
  pitch: 0,
  bank: 0,
  headingDeg: 0,
  p: 0,
  q: 0,
  r: 0,
  ias: 0,
  staticPressure: 101_325,
  density: SEA_LEVEL_DENSITY,
  up: vec(),
  north: vec(),
  forward: vec(),
  specificForce: vec(),
  lateralSpecificForce: 0,
  latitude: 0,
  declination: 0,
  suction: 0,
  turnPowered: false,
  lowSuction: 3,
  pitotBlocked: false,
  altimeterSetting: 1013,
  gyroAdjust: 0,
  fuelLeft: 0,
  fuelRight: 0,
  gaugesPowered: false,
});

/** Shortest signed difference of two angles in degrees, -180..180. */
const wrap180 = (a: number) => a - 360 * Math.floor((a + 180) / 360);
const wrap360 = (a: number) => a - 360 * Math.floor(a / 360);
const wrapPi = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));

/** Altitude (m) a barometric altimeter shows at a static pressure for a setting (hPa). */
export function altimeterReading(staticPressure: number, settingHpa: number): number {
  return (T0 / LAPSE) * (1 - (staticPressure / (settingHpa * 100)) ** ALT_EXPONENT);
}

export class Instruments {
  readonly telemetry: InstrumentTelemetry = {
    airspeed: 0,
    pitch: 0,
    bank: 0,
    altitude: 0,
    verticalSpeed: 0,
    heading: 0,
    compass: 0,
    turnRate: 0,
    slip: 0,
    fuelLeft: 0,
    fuelRight: 0,
    gyroFlag: false,
    turnFlag: false,
  };
  /** Rotor speed of the vacuum gyros and of the turn coordinator, 0..1. */
  gyroSpin = 1;
  turnSpin = 1;
  // Errors of the vacuum gyros against the truth.
  private pitchError = 0;
  private bankError = 0;
  private headingError = 0;
  private lastPitch = 0;
  private lastBank = 0;
  private lastHeading = 0;
  // Compass card and its swing.
  private card = 0;
  private cardRate = 0;
  private pressureAltitude = 0;
  private trappedPressure = 0;
  private turnRate = 0;
  private slip = 0;
  private readonly t0 = vec();
  private readonly t1 = vec();
  private readonly t2 = vec();
  private readonly t3 = vec();

  /**
   * Back to a working panel showing the truth (`running`), or to one just switched on: the
   * gyros stopped, the directional gyro and the attitude indicator wherever they came to rest.
   */
  reset(running: boolean, input: InstrumentInput) {
    this.gyroSpin = running ? 1 : 0;
    this.turnSpin = running ? 1 : 0;
    this.pitchError = running ? 0 : -8 * DEG - input.pitch;
    this.bankError = running ? 0 : 12 * DEG - input.bank;
    const magnetic = wrap360(input.headingDeg - input.declination);
    // A gyro that was not running points anywhere; this one at north, a fixed choice.
    this.headingError = running ? 0 : -magnetic;
    this.lastPitch = input.pitch;
    this.lastBank = input.bank;
    this.lastHeading = input.headingDeg;
    this.card = this.compassTarget(input);
    this.cardRate = 0;
    this.pressureAltitude = altimeterReading(input.staticPressure, 1013.25);
    this.trappedPressure = 0;
    this.turnRate = running ? this.trueTurnRate(input) : 0;
    this.slip = 0;
    this.verticalSpeed = 0;
    this.output(input);
  }

  private verticalSpeed = 0;

  step(dt: number, input: InstrumentInput) {
    this.gyros(dt, input);
    this.compass(dt, input);
    this.pitotStatic(dt, input);
    this.turnCoordinator(dt, input);
    this.output(input);
  }

  /**
   * Vacuum gyros: the rotor follows the suction (spins up in about a minute, runs down over
   * several: the instruments stay usable for a minute or two after the pump fails). Spinning, it holds its orientation in space and the erection mechanism slowly
   * pulls out any error; run down, it is dragged along with the aircraft and tumbles.
   */
  private gyros(dt: number, input: InstrumentInput) {
    const spinTarget = clamp(input.suction / 4, 0, 1);
    const tau = spinTarget > this.gyroSpin ? 40 : 180;
    this.gyroSpin += (spinTarget - this.gyroSpin) * (1 - Math.exp(-dt / tau));
    const hold = clamp((this.gyroSpin - 0.25) / 0.35, 0, 1);
    const loose = 1 - hold;
    // Only a rotor that still turns precesses; a stopped one just sits where it is.
    const tumble = loose * clamp(this.gyroSpin / 0.15, 0, 1);
    const dPitch = input.pitch - this.lastPitch;
    const dBank = wrapPi(input.bank - this.lastBank);
    const dHeading = wrap180(input.headingDeg - this.lastHeading);
    this.lastPitch = input.pitch;
    this.lastBank = input.bank;
    this.lastHeading = input.headingDeg;
    const erect = 0.05 * hold * dt;
    this.pitchError += -loose * dPitch - erect * this.pitchError - tumble * 0.01 * dt;
    this.bankError += -loose * dBank - erect * this.bankError + tumble * 0.03 * dt;
    this.bankError = wrapPi(this.bankError);
    // The directional gyro holds a direction in space, so the Earth turns under it: the
    // reading falls by the Earth's rate times the sine of the latitude (11 °/h in Switzerland).
    const drift = -EARTH_RATE * Math.sin(input.latitude * DEG) * hold;
    this.headingError = wrap180(
      this.headingError - loose * dHeading + drift * dt + tumble * 0.5 * dt,
    );
  }

  /** Heading the compass card would settle on now: magnetic north projected onto the card. */
  private compassTarget(input: InstrumentInput): number {
    const up = input.up;
    const north = input.north;
    const east = cross(this.t0, north, up);
    // Earth's field: towards magnetic north and down by the dip (tan dip = 2 tan latitude).
    const dec = input.declination * DEG;
    const lat = input.latitude * DEG;
    const dip = Math.atan(2 * Math.tan(lat));
    const cd = Math.cos(dip);
    const sd = Math.sin(dip);
    const b = this.t1;
    b.x = cd * (Math.cos(dec) * north.x + Math.sin(dec) * east.x) - sd * up.x;
    b.y = cd * (Math.cos(dec) * north.y + Math.sin(dec) * east.y) - sd * up.y;
    b.z = cd * (Math.cos(dec) * north.z + Math.sin(dec) * east.z) - sd * up.z;
    // The card hangs along the apparent gravity (against the specific force).
    const n = this.t2;
    const sf = input.specificForce;
    const sfl = Math.hypot(sf.x, sf.y, sf.z);
    if (sfl > 2) {
      n.x = -sf.x / sfl;
      n.y = -sf.y / sfl;
      n.z = -sf.z / sfl;
    } else {
      n.x = -up.x;
      n.y = -up.y;
      n.z = -up.z;
    }
    const f = this.t3;
    const fn = dot(input.forward, n);
    f.x = input.forward.x - fn * n.x;
    f.y = input.forward.y - fn * n.y;
    f.z = input.forward.z - fn * n.z;
    normalize(f, f);
    // Right of the nose on the card: down × forward.
    const right = cross(this.t0, n, f);
    const bf = dot(b, f);
    const br = dot(b, right);
    // Magnetic north to the right of the nose means a heading west of north.
    return wrap360(Math.atan2(-br, bf) / DEG);
  }

  /** A liquid-damped card: it swings after the target with some overshoot. */
  private compass(dt: number, input: InstrumentInput) {
    const target = this.compassTarget(input);
    const wn = 2;
    const zeta = 0.45;
    const err = wrap180(target - this.card);
    this.cardRate += (wn * wn * err - 2 * zeta * wn * this.cardRate) * dt;
    this.card = wrap360(this.card + this.cardRate * dt);
  }

  private pitotStatic(dt: number, input: InstrumentInput) {
    const h = altimeterReading(input.staticPressure, 1013.25);
    const rate = dt > 0 ? (h - this.pressureAltitude) / dt : 0;
    this.pressureAltitude = h;
    // The capillary leak of the VSI's case: a lag of a few seconds.
    this.verticalSpeed += (rate - this.verticalSpeed) * (1 - Math.exp(-dt / 3));
    if (input.pitotBlocked) {
      // The trapped total pressure leaks out through the drain hole: the airspeed falls away
      // slowly in level flight, and rises in a climb as the static pressure drops.
      const static0 = input.staticPressure;
      if (this.trappedPressure === 0)
        this.trappedPressure = static0 + 0.5 * SEA_LEVEL_DENSITY * input.ias * input.ias;
      this.trappedPressure += (static0 - this.trappedPressure) * (1 - Math.exp(-dt / 90));
    } else this.trappedPressure = 0;
  }

  private trueTurnRate(input: InstrumentInput): number {
    const cosTheta = Math.max(Math.cos(input.pitch), 0.1);
    const yaw = (input.q * Math.sin(input.bank) + input.r * Math.cos(input.bank)) / cosTheta;
    // The gyro is canted, so the needle also answers the roll rate (it leads into a turn).
    return (yaw + 0.15 * input.p) / DEG;
  }

  private turnCoordinator(dt: number, input: InstrumentInput) {
    const target = input.turnPowered ? 1 : 0;
    this.turnSpin += (target - this.turnSpin) * (1 - Math.exp(-dt / (input.turnPowered ? 5 : 30)));
    const rate = this.trueTurnRate(input) * clamp(this.turnSpin * 1.5, 0, 1);
    this.turnRate += (rate - this.turnRate) * (1 - Math.exp(-dt / 0.5));
    // The ball rolls towards the apparent gravity across the tube; full scale is about 0.2 g.
    const ball = clamp(-input.lateralSpecificForce / (0.2 * G0), -1, 1);
    this.slip += (ball - this.slip) * (1 - Math.exp(-dt / 0.3));
  }

  private output(input: InstrumentInput) {
    const t = this.telemetry;
    t.pitch = clamp(input.pitch + this.pitchError, -80 * DEG, 80 * DEG);
    t.bank = wrapPi(input.bank + this.bankError);
    const magnetic = input.headingDeg - input.declination;
    t.heading = wrap360(magnetic + this.headingError + input.gyroAdjust);
    t.compass = this.card;
    t.altitude = altimeterReading(input.staticPressure, input.altimeterSetting);
    t.verticalSpeed = this.verticalSpeed;
    if (this.trappedPressure > 0) {
      const q = Math.max(0, this.trappedPressure - input.staticPressure);
      t.airspeed = Math.sqrt((2 * q) / SEA_LEVEL_DENSITY);
    } else t.airspeed = input.ias;
    t.turnRate = this.turnRate;
    t.slip = this.slip;
    t.fuelLeft = input.gaugesPowered ? input.fuelLeft : 0;
    t.fuelRight = input.gaugesPowered ? input.fuelRight : 0;
    t.gyroFlag = input.suction < input.lowSuction;
    t.turnFlag = !input.turnPowered;
  }
}
