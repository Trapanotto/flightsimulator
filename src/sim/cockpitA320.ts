import { type ControlSpec, controlSpec } from './cockpit';

const { toggle, button, com, nav, course } = controlSpec;

/** A push button with a light that stays in: on or off (most of the Airbus overhead). */
const korry = (id: string, initial = 0, running?: number) => toggle(id, initial, running);

/**
 * The Airbus A320-214 (two CFM56-5B4), simplified where a real airliner has hundreds of
 * controls, but with everything a flight from cold and dark to shutdown touches: the
 * overhead panel's electrical, fuel, hydraulic, air and anti-ice rows, the APU, the engine
 * masters, the flight control unit with managed and selected guidance, the EFIS control
 * panel, thrust levers with their detents, flaps, speed brake with ground spoiler arming,
 * autobrake and gear.
 *
 * Fly-by-wire: the sidestick commands load factor and roll rate (normal law with its
 * protections), the thrust levers stay in the CLIMB detent while autothrust sets the thrust.
 * There is no flight management computer to program: the GPS flight plan the app hands over
 * stands in for it, and 'managed' guidance follows that plan and its speeds.
 *
 * `throttle1`, `throttle2`, `flaps`, `gear`, `speedbrake`, `reverse`, `trim`, `rudderTrim`,
 * `parkingBrake`, `engineMaster1` and `engineMaster2` mirror ControlInput (throttle per
 * engine, condition per engine). Thrust lever detents on the 0..1 travel: idle 0, CLIMB
 * 0.62, FLX/MCT 0.82, TOGA 1.
 */
export const A320_CONTROLS: readonly ControlSpec[] = [
  // ---- overhead: electrical ----
  korry('battery', 0, 1),
  korry('battery2', 0, 1),
  korry('externalPower'),
  korry('generator1', 1),
  korry('generator2', 1),
  korry('apuGenerator', 1),
  /** Air data and inertial reference: OFF or NAV (alignment takes a while). */
  { id: 'adirs', kind: 'selector', positions: ['off', 'nav'], initial: 0, running: 1 },
  // ---- overhead: APU ----
  korry('apuMaster'),
  button('apuStart'),
  korry('apuBleed'),
  // ---- overhead: fuel ----
  korry('fuelPumpsLeft', 0, 1),
  korry('fuelPumpsRight', 0, 1),
  korry('fuelPumpsCenter', 0, 1),
  korry('fuelCrossfeed'),
  // ---- overhead: hydraulics (green: engine 1, yellow: engine 2 and an electric pump, blue: electric) ----
  korry('hydGreen', 1),
  korry('hydYellow', 1),
  korry('hydBlue', 1),
  korry('hydYellowElectric'),
  // ---- overhead: air ----
  korry('bleed1', 1),
  korry('bleed2', 1),
  korry('pack1', 1),
  korry('pack2', 1),
  korry('crossbleed'),
  // ---- overhead: anti-ice ----
  korry('wingAntiIce'),
  korry('engineAntiIce1'),
  korry('engineAntiIce2'),
  /** Probe and window heat: AUTO or ON. */
  korry('probeHeat'),
  // ---- overhead: lights and signs ----
  toggle('lightBeacon'),
  { id: 'lightStrobe', kind: 'selector', positions: ['off', 'auto', 'on'], initial: 0, running: 1 },
  toggle('lightNav'),
  toggle('lightLanding'),
  { id: 'lightNose', kind: 'selector', positions: ['off', 'taxi', 'takeoff'], initial: 0 },
  toggle('lightRunwayTurnoff'),
  toggle('lightWing'),
  { id: 'lightPanel', kind: 'knob', min: 0, max: 1, step: 0.1, initial: 0 },
  { id: 'lightDome', kind: 'selector', positions: ['off', 'dim', 'bright'], initial: 0 },
  { id: 'seatBelts', kind: 'selector', positions: ['off', 'auto', 'on'], initial: 0, running: 2 },
  // ---- pedestal: engines and thrust ----
  /** Engine masters: 1 = on. */
  toggle('engineMaster1', 0, 1),
  toggle('engineMaster2', 0, 1),
  {
    id: 'engineMode',
    kind: 'selector',
    positions: ['crank', 'normal', 'ignitionStart'],
    initial: 1,
  },
  { id: 'throttle1', kind: 'lever', min: 0, max: 1, initial: 0 },
  { id: 'throttle2', kind: 'lever', min: 0, max: 1, initial: 0 },
  /** The reverse levers are pulled: the thrust levers' travel commands reverse. */
  toggle('reverse'),
  /** The red buttons on the thrust levers: autothrust off. */
  button('athrDisconnect'),
  // ---- pedestal: flight controls ----
  { id: 'flaps', kind: 'selector', positions: ['0', '1', '2', '3', 'full'], initial: 0 },
  { id: 'speedbrake', kind: 'lever', min: 0, max: 1, initial: 0 },
  /** The speed brake lever is pulled up: ground spoilers deploy at touch-down. */
  toggle('spoilersArmed'),
  toggle('gear', 1),
  { id: 'autobrake', kind: 'selector', positions: ['off', 'low', 'medium', 'max'], initial: 0 },
  { id: 'trim', kind: 'knob', min: -1, max: 1, step: 0.005, initial: 0 },
  { id: 'rudderTrim', kind: 'knob', min: -1, max: 1, step: 0.02, initial: 0 },
  toggle('parkingBrake', 1, 0),
  /** The red button on the sidestick: autopilot off (and sidestick priority). */
  button('apDisconnect'),
  // ---- flight control unit ----
  /** Speed window, knots (or hundredths of Mach while `fcuMach` is on). */
  { id: 'fcuSpeed', kind: 'knob', min: 100, max: 399, step: 1, initial: 250 },
  /** Pushed in: managed speed (the plan's); pulled: the selected one. 1 = managed. */
  toggle('fcuSpeedManaged', 1),
  button('fcuMach'),
  course('fcuHeading'),
  /** 1 = managed (follows the flight plan), 0 = selected heading. */
  toggle('fcuHeadingManaged', 1),
  /** Selected altitude, feet. */
  { id: 'fcuAltitude', kind: 'knob', min: 100, max: 39_800, step: 100, initial: 5000 },
  /** 1 = managed climb or descent, 0 = open climb or descent. */
  toggle('fcuAltitudeManaged', 1),
  /** Vertical speed, feet per minute; pulling the knob engages V/S, pushing levels off. */
  { id: 'fcuVerticalSpeed', kind: 'knob', min: -6000, max: 6000, step: 100, initial: 0 },
  button('fcuVsPull'),
  button('fcuVsPush'),
  button('ap1'),
  button('ap2'),
  button('athr'),
  button('fcuLoc'),
  button('fcuAppr'),
  button('fcuExped'),
  // ---- EFIS control panel ----
  /** Altimeter setting, hPa; pull for standard. */
  { id: 'altimeterSetting', kind: 'knob', min: 950, max: 1050, step: 1, initial: 1013 },
  button('baroStd'),
  /** Flight director and landing system scales on the primary flight display. */
  toggle('flightDirector', 1),
  toggle('ls'),
  {
    id: 'ndMode',
    kind: 'selector',
    positions: ['ils', 'vor', 'nav', 'arc', 'plan'],
    initial: 3,
  },
  {
    id: 'ndRange',
    kind: 'selector',
    positions: ['10', '20', '40', '80', '160', '320'],
    initial: 1,
  },
  /** Which system page the lower ECAM display shows. */
  {
    id: 'ecamPage',
    kind: 'selector',
    positions: [
      'engine',
      'bleed',
      'press',
      'elec',
      'hyd',
      'fuel',
      'apu',
      'wheel',
      'fctl',
      'status',
    ],
    initial: 0,
  },
  button('masterWarning'),
  button('masterCaution'),
  // ---- radios (frequencies in kHz); the ILS is tuned on NAV 1 ----
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
  course('obs1'),
  course('obs2'),
  { id: 'adfFrequency', kind: 'knob', min: 190, max: 1750, step: 1, initial: 300 },
  { id: 'xpdrCode', kind: 'knob', min: 0, max: 7777, step: 1, initial: 2000 },
  {
    id: 'xpdrMode',
    kind: 'selector',
    positions: ['off', 'standby', 'on', 'alt'],
    initial: 1,
    running: 3,
  },
  button('xpdrIdent'),
];
