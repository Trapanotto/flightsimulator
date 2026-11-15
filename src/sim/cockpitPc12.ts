import { type ControlSpec, controlSpec } from './cockpit';

const { toggle, button, com, nav, course } = controlSpec;

/**
 * The Pilatus PC-12 NG: a single PT6A-67P turboprop, pressurised, retractable gear, with a
 * glass cockpit in the manner of the Honeywell Primus Apex (two primary flight displays and
 * a multi-function display fed by the avionics telemetry) and a two-axis autopilot with yaw
 * damper and flight director.
 *
 * `throttle` is the power control lever from flight idle (0) to maximum power (1); lifting
 * it over the gate (`reverse`) makes the same travel command beta and reverse on the ground.
 * `throttle`, `flaps`, `gear`, `trim`, `parkingBrake`, `reverse` and `condition` mirror
 * ControlInput. Names shared with the Cessna (radios, autopilot basics, lights) mean the
 * same thing, so panels and checklists can treat them alike.
 */
export const PC12_CONTROLS: readonly ControlSpec[] = [
  // ---- electrical ----
  toggle('battery', 0, 1),
  /** The second battery. */
  toggle('battery2', 0, 1),
  /** Generator 1 (starter-generator) and generator 2 (alternator). */
  toggle('generator1', 0, 1),
  toggle('generator2', 0, 1),
  toggle('avionics', 0, 1),
  /** Emergency power supply for the standby instruments. */
  { id: 'eps', kind: 'selector', positions: ['off', 'armed', 'test'], initial: 0, running: 1 },
  // ---- engine ----
  /** Held while pressed; the start sequence latches by itself once it turns. */
  button('starter'),
  { id: 'ignition', kind: 'selector', positions: ['auto', 'on'], initial: 0 },
  {
    id: 'condition',
    kind: 'selector',
    positions: ['cutoff', 'groundIdle', 'flightIdle'],
    initial: 0,
    running: 2,
  },
  { id: 'throttle', kind: 'lever', min: 0, max: 1, initial: 0 },
  /** The power lever is lifted over the idle gate: its travel commands beta and reverse. */
  toggle('reverse'),
  { id: 'fuelPumpLeft', kind: 'selector', positions: ['auto', 'on'], initial: 0 },
  { id: 'fuelPumpRight', kind: 'selector', positions: ['auto', 'on'], initial: 0 },
  /** Fuel firewall shutoff: 1 = open. */
  toggle('fuelShutoff', 1),
  /** Deflects ice and debris past the engine inlet; costs a little power. */
  toggle('inertialSeparator'),
  // ---- flight controls ----
  { id: 'flaps', kind: 'selector', positions: ['0', '15', '30', '40'], initial: 0 },
  /** 1 = down. */
  toggle('gear', 1),
  { id: 'trim', kind: 'knob', min: -1, max: 1, step: 0.01, initial: 0 },
  { id: 'aileronTrim', kind: 'knob', min: -1, max: 1, step: 0.02, initial: 0 },
  { id: 'rudderTrim', kind: 'knob', min: -1, max: 1, step: 0.02, initial: 0 },
  toggle('parkingBrake', 1, 0),
  // ---- lights ----
  toggle('lightBeacon'),
  toggle('lightStrobe'),
  toggle('lightNav'),
  toggle('lightLanding'),
  toggle('lightTaxi'),
  /** Recognition lights in the wing tips. */
  toggle('lightRecognition'),
  /** Lights the wing leading edge to look for ice at night. */
  toggle('lightIce'),
  { id: 'lightPanel', kind: 'knob', min: 0, max: 1, step: 0.1, initial: 0 },
  { id: 'lightCabin', kind: 'knob', min: 0, max: 1, step: 0.1, initial: 0 },
  // ---- ice protection ----
  /** Pitot, static and angle-of-attack probe heat. */
  toggle('pitotHeat'),
  toggle('propDeice'),
  { id: 'bootsDeice', kind: 'selector', positions: ['off', '3min', '1min'], initial: 0 },
  toggle('windshieldHeat'),
  // ---- cabin ----
  /** Environmental control: bleed air for heating and pressurisation. */
  toggle('ecs', 0, 1),
  { id: 'pressurisation', kind: 'selector', positions: ['auto', 'dump'], initial: 0 },
  /** Cabin altitude selector, feet. */
  { id: 'cabinAltitude', kind: 'knob', min: 0, max: 10_000, step: 500, initial: 1500 },
  toggle('oxygen'),
  // ---- flight displays ----
  /** Altimeter setting, hPa; `baroStd` switches between it and 1013. */
  { id: 'altimeterSetting', kind: 'knob', min: 950, max: 1050, step: 1, initial: 1013 },
  button('baroStd'),
  course('headingBug'),
  button('headingSync'),
  course('obs1'),
  course('obs2'),
  /** What the primary flight display's course indicator and the autopilot follow. */
  { id: 'navSource', kind: 'selector', positions: ['nav1', 'gps', 'nav2'], initial: 1 },
  /** Range of the map, nautical miles. */
  { id: 'mapRange', kind: 'knob', min: 5, max: 320, step: 5, initial: 20 },
  /** Decision altitude bug on the radar altimeter, feet above ground. */
  { id: 'minimums', kind: 'knob', min: 0, max: 2500, step: 10, initial: 200 },
  // ---- radios (frequencies in kHz) ----
  com('com1Active', 118_100),
  com('com1Standby', 121_500),
  button('com1Swap'),
  com('com2Active', 121_500),
  com('com2Standby', 121_500),
  button('com2Swap'),
  nav('nav1Active', 110_000),
  nav('nav1Standby', 110_000),
  button('nav1Swap'),
  nav('nav2Active', 110_000),
  nav('nav2Standby', 110_000),
  button('nav2Swap'),
  { id: 'dmeSource', kind: 'selector', positions: ['nav1', 'nav2'], initial: 0 },
  { id: 'adfFrequency', kind: 'knob', min: 190, max: 1750, step: 1, initial: 300 },
  { id: 'xpdrCode', kind: 'knob', min: 0, max: 7777, step: 1, initial: 7000 },
  {
    id: 'xpdrMode',
    kind: 'selector',
    positions: ['off', 'standby', 'on', 'alt'],
    initial: 0,
    running: 3,
  },
  button('xpdrIdent'),
  // ---- autopilot and flight director ----
  button('apEngage'),
  button('yawDamper'),
  /** Flight director bars on or off (the autopilot needs them on). */
  button('flightDirector'),
  button('apHdg'),
  button('apNav'),
  button('apApr'),
  button('apAlt'),
  button('apVs'),
  /** Flight level change: climbs or descends at the selected airspeed. */
  button('apFlc'),
  /** The pitch wheel: vertical speed in VS, airspeed in FLC. */
  button('apVsUp'),
  button('apVsDown'),
  /** Selected altitude, feet. */
  { id: 'apAltitude', kind: 'knob', min: 0, max: 30_000, step: 100, initial: 5000 },
  /** The red button on the yoke. */
  button('apDisconnect'),
  /** Control wheel steering and go-around on the yoke and power lever. */
  button('goAround'),
];
