import { type ControlSpec, controlSpec } from './cockpit';

const { toggle, button, com, nav, course } = controlSpec;

/**
 * The McDonnell Douglas F/A-18C Hornet as the Swiss Air Force flies it: two F404-GE-402
 * afterburning turbofans, fly-by-wire flight control system, a head-up display and three
 * multi-purpose displays, the up-front control for radios and autopilot. Unarmed: weapons
 * and sensors are not simulated, the master arm switch is there and does nothing.
 *
 * Throttles: 0 idle .. 0.75 military power, above that the afterburner up to 1. The flight
 * control system flies the aircraft: the stick commands load factor (with the g limiter) and
 * roll rate, the flaps in AUTO schedule themselves with angle of attack and Mach.
 *
 * `throttle1`, `throttle2`, `flaps`, `gear`, `speedbrake`, `trim` and `parkingBrake` mirror
 * ControlInput.
 */
export const FA18_CONTROLS: readonly ControlSpec[] = [
  // ---- left console: power, engines, fuel ----
  { id: 'battery', kind: 'selector', positions: ['off', 'on', 'override'], initial: 0, running: 1 },
  toggle('generatorLeft', 1),
  toggle('generatorRight', 1),
  toggle('apu'),
  /** Engine crank: springs back to OFF when the engine has started. */
  { id: 'engineCrank', kind: 'selector', positions: ['left', 'off', 'right'], initial: 1 },
  { id: 'throttle1', kind: 'lever', min: 0, max: 1, initial: 0 },
  { id: 'throttle2', kind: 'lever', min: 0, max: 1, initial: 0 },
  /** Throttles moved round the horn to OFF: fuel cut. 1 = at idle or above. */
  toggle('fuelCutoff1', 0, 1),
  toggle('fuelCutoff2', 0, 1),
  toggle('fuelDump'),
  /** Bingo fuel setting on the IFEI, kg of total internal fuel (the dump also stops there). */
  { id: 'bingo', kind: 'knob', min: 0, max: 5000, step: 50, initial: 1500 },
  { id: 'probeAir', kind: 'selector', positions: ['retract', 'extend'], initial: 0 },
  toggle('oxygen', 0, 1),
  // ---- flight controls ----
  { id: 'flaps', kind: 'selector', positions: ['auto', 'half', 'full'], initial: 2, running: 1 },
  toggle('gear', 1),
  toggle('hook'),
  toggle('launchBar'),
  /** The speed brake switch on the throttle: 1 = out. */
  toggle('speedbrake'),
  { id: 'trim', kind: 'knob', min: -1, max: 1, step: 0.01, initial: 0 },
  button('takeoffTrim'),
  button('fcsReset'),
  toggle('spinRecovery'),
  /** The paddle on the stick: lets the pilot pull a third more g than the limiter allows. */
  button('gLimiterOverride'),
  toggle('antiSkid', 1),
  button('nosewheelSteering'),
  toggle('parkingBrake', 1, 0),
  { id: 'canopy', kind: 'selector', positions: ['open', 'hold', 'close'], initial: 0, running: 2 },
  toggle('seatArmed', 0, 1),
  // ---- anti-ice and environment ----
  toggle('pitotHeat'),
  toggle('engineAntiIce'),
  { id: 'cabinPressure', kind: 'selector', positions: ['normal', 'dump', 'ram'], initial: 0 },
  // ---- lights ----
  toggle('lightNav'),
  toggle('lightStrobe'),
  { id: 'lightFormation', kind: 'knob', min: 0, max: 1, step: 0.1, initial: 0 },
  { id: 'lightLanding', kind: 'selector', positions: ['off', 'taxi', 'landing'], initial: 0 },
  { id: 'lightPanel', kind: 'knob', min: 0, max: 1, step: 0.1, initial: 0 },
  { id: 'lightConsole', kind: 'knob', min: 0, max: 1, step: 0.1, initial: 0 },
  { id: 'lightFlood', kind: 'knob', min: 0, max: 1, step: 0.1, initial: 0 },
  // ---- head-up display and displays ----
  { id: 'hudBrightness', kind: 'knob', min: 0, max: 1, step: 0.1, initial: 0.8 },
  { id: 'hudAltitude', kind: 'selector', positions: ['baro', 'radar'], initial: 0 },
  {
    id: 'ddiLeftPage',
    kind: 'selector',
    positions: ['off', 'hsi', 'fcs', 'engine', 'adi', 'checklist', 'fuel'],
    initial: 0,
    running: 2,
  },
  {
    id: 'ddiRightPage',
    kind: 'selector',
    positions: ['off', 'hsi', 'fcs', 'engine', 'adi', 'checklist', 'fuel'],
    initial: 0,
    running: 3,
  },
  {
    id: 'mpcdPage',
    kind: 'selector',
    positions: ['off', 'hsi', 'fuel', 'engine'],
    initial: 0,
    running: 1,
  },
  { id: 'mapRange', kind: 'selector', positions: ['10', '20', '40', '80', '160'], initial: 2 },
  toggle('masterArm'),
  button('masterCaution'),
  // ---- navigation and instruments ----
  { id: 'altimeterSetting', kind: 'knob', min: 950, max: 1050, step: 1, initial: 1013 },
  /** Low-altitude warning of the radar altimeter, feet. */
  { id: 'minimums', kind: 'knob', min: 0, max: 5000, step: 10, initial: 200 },
  course('headingBug'),
  course('obs1'),
  /** What the HSI's course line and the coupled autopilot follow. */
  { id: 'navSource', kind: 'selector', positions: ['nav1', 'gps', 'tacan'], initial: 1 },
  /** TACAN channel 1..126 (X); it tunes the paired VOR or DME frequency. */
  { id: 'tacanChannel', kind: 'knob', min: 1, max: 126, step: 1, initial: 1 },
  toggle('ilsOn'),
  // ---- up-front control: radios, autopilot ----
  com('com1Active', 118_100),
  com('com1Standby', 121_500),
  button('com1Swap'),
  com('com2Active', 121_500),
  com('com2Standby', 121_500),
  button('com2Swap'),
  nav('nav1Active', 110_000),
  nav('nav1Standby', 110_000),
  button('nav1Swap'),
  { id: 'xpdrCode', kind: 'knob', min: 0, max: 7777, step: 1, initial: 7000 },
  {
    id: 'xpdrMode',
    kind: 'selector',
    positions: ['off', 'standby', 'on', 'alt'],
    initial: 0,
    running: 3,
  },
  button('xpdrIdent'),
  /** Autopilot: engage, then the hold modes of the up-front control. */
  button('apEngage'),
  button('apAttitude'),
  button('apHdg'),
  /** Barometric altitude hold. */
  button('apAlt'),
  /** Radar altitude hold. */
  button('apRadarAlt'),
  /** Couples the steering to the selected navigation source. */
  button('apNav'),
  /** Automatic throttle control: holds the airspeed (cruise) or the angle of attack (approach). */
  button('athr'),
  /** The paddle switch on the stick: autopilot and nosewheel steering off. */
  button('apDisconnect'),
];
