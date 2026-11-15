// The F/A-18C's fakes for the aircraft demo (demo/aircraft.ts, ?type=fa18): plausible telemetry
// for two F404s with their nozzles and afterburners, the flight control surfaces, gear, hook,
// canopy, the systems and the avionics with the F/A-18 block the head-up display reads
// (telemetry.avionics.fa18). The flight model is not involved.
//   ?state=parked|ramp|takeoff|cruise|climb-turn|landing|afterburner|highaoa
//   ?ab=0..1 ?nozzle=0..1 ?gear=0..1 ?aoa=deg ?g=n ?canopy=0..1 ?hook=1 ?fail=1,2 (FCS channels)
import {
  type AutopilotTelemetry,
  type AvionicsTelemetry,
  CockpitPanel,
  type ControlInput,
  type EngineTelemetry,
  FA18_CONTROLS,
  type SystemsTelemetry,
  type Telemetry,
  type Waypoint,
} from '@sim';
import type { AircraftVisual, AircraftVisualOptions } from '@aircraft';
import { loadFa18 } from '../src/aircraft/Fa18Visual';

const KT = 0.514444;
const FT = 0.3048;
const DEG = Math.PI / 180;
const q = new URLSearchParams(location.search);
const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);

export const CONTROLS = FA18_CONTROLS;
/** The Hornet is about 1.9 times the Cessna: the demo's framings from further away. */
export const SCALE = 1.9;

export function load(options: AircraftVisualOptions): Promise<AircraftVisual> {
  return loadFa18(options);
}

/** One F404: N2, EGT, fuel flow, the nozzle (0.78 idle, 0.08 military, 1 full afterburner). */
export function f404(running: boolean, n2: number, ab = 0): EngineTelemetry {
  const mil = Math.min(Math.max((n2 - 70) / 27, 0), 1);
  return {
    running,
    rpm: n2,
    n1: running ? n2 * 0.92 : 0,
    n2: running ? n2 : 0,
    power: running ? (ab > 0 ? 1 + 0.6 * ab : mil) : 0,
    fuelFlow: running ? (900 + 9000 * mil + 30000 * ab) / 2.20462 / 3600 : 0,
    turbineTemperature: running ? 420 + 420 * mil + 40 * ab : 18,
    afterburner: running ? ab : 0,
    nozzle: !running ? 0.78 : ab > 0 ? 0.08 + 0.92 * ab : 0.78 - 0.7 * mil,
    oilPressure: running ? 40 + 45 * mil : 0,
  };
}

interface State {
  telemetry: Partial<Telemetry>;
  controls: Partial<ControlInput>;
  turnRate: number;
  height: number;
}

const STATES: Record<string, State> = {
  parked: {
    telemetry: {
      onGround: true,
      gear: 1,
      flaps: 0,
      fuel: 4900,
      altitude: 450,
      headingDeg: 140,
      engines: [f404(false, 0), f404(false, 0)],
    },
    controls: { throttle: [0, 0], flaps: 1, parkingBrake: true },
    turnRate: 0,
    height: 0,
  },
  ramp: {
    telemetry: {
      onGround: true,
      gear: 1,
      flaps: 1,
      fuel: 4800,
      altitude: 450,
      headingDeg: 140,
      groundSpeed: 5,
      ias: 5,
      agl: 0,
      engines: [f404(true, 70), f404(true, 70)],
    },
    controls: { throttle: [0.02, 0.02], flaps: 0.5 },
    turnRate: 0,
    height: 0,
  },
  takeoff: {
    telemetry: {
      onGround: true,
      gear: 1,
      flaps: 0.5,
      fuel: 4700,
      altitude: 450,
      headingDeg: 140,
      groundSpeed: 120 * KT,
      ias: 120 * KT,
      agl: 0,
      elevator: 0.3,
      engines: [f404(true, 101, 1), f404(true, 101, 1)],
    },
    controls: { throttle: [1, 1], flaps: 0.5, pitch: 0.3 },
    turnRate: 0,
    height: 0,
  },
  cruise: {
    telemetry: {
      gear: 0,
      flaps: 0,
      fuel: 3900,
      altitude: 25000 * FT,
      agl: 23500 * FT,
      headingDeg: 64,
      ias: 330 * KT,
      groundSpeed: 480 * KT,
      mach: 0.82,
      pitch: 2 * DEG,
      alpha: 2.2 * DEG,
      engines: [f404(true, 88), f404(true, 88)],
    },
    controls: { throttle: [0.6, 0.6], gearDown: false, flaps: 0 },
    turnRate: 0,
    height: 4,
  },
  'climb-turn': {
    telemetry: {
      gear: 0,
      flaps: 0,
      fuel: 4300,
      altitude: 9000 * FT,
      agl: 7000 * FT,
      headingDeg: 210,
      ias: 360 * KT,
      groundSpeed: 400 * KT,
      mach: 0.66,
      pitch: 12 * DEG,
      bank: 55 * DEG,
      alpha: 8 * DEG,
      beta: 0.5 * DEG,
      loadFactor: 3.2,
      verticalSpeed: (6000 * FT) / 60,
      elevator: 0.45,
      aileron: 0.15,
      rudder: 0.05,
      engines: [f404(true, 97), f404(true, 97)],
    },
    controls: { throttle: [0.75, 0.75], gearDown: false, flaps: 0, pitch: 0.45, roll: 0.15 },
    turnRate: 6,
    height: 4,
  },
  landing: {
    telemetry: {
      gear: 1,
      flaps: 1,
      fuel: 2300,
      altitude: 1900 * FT,
      agl: 420 * FT,
      headingDeg: 316,
      ias: 138 * KT,
      groundSpeed: 132 * KT,
      mach: 0.21,
      pitch: 5 * DEG,
      bank: -3 * DEG,
      alpha: 8.1 * DEG,
      verticalSpeed: (-700 * FT) / 60,
      elevator: 0.15,
      aileron: -0.05,
      engines: [f404(true, 84), f404(true, 84)],
    },
    controls: { throttle: [0.45, 0.45], flaps: 1, pitch: 0.15 },
    turnRate: -0.3,
    height: 4,
  },
  afterburner: {
    telemetry: {
      gear: 0,
      flaps: 0,
      fuel: 4000,
      altitude: 3000 * FT,
      agl: 2000 * FT,
      headingDeg: 90,
      ias: 420 * KT,
      groundSpeed: 440 * KT,
      mach: 0.68,
      pitch: 25 * DEG,
      alpha: 5 * DEG,
      loadFactor: 1.4,
      verticalSpeed: 90,
      engines: [f404(true, 102, 1), f404(true, 102, 1)],
    },
    controls: { throttle: [1, 1], gearDown: false, flaps: 0 },
    turnRate: 0,
    height: 4,
  },
  highaoa: {
    telemetry: {
      gear: 0,
      flaps: 0,
      fuel: 3600,
      altitude: 6000 * FT,
      agl: 4500 * FT,
      headingDeg: 300,
      ias: 250 * KT,
      groundSpeed: 260 * KT,
      mach: 0.43,
      pitch: 18 * DEG,
      bank: -70 * DEG,
      alpha: 24 * DEG,
      loadFactor: 6.5,
      elevator: 0.9,
      aileron: -0.2,
      rudder: -0.1,
      engines: [f404(true, 99, 0.4), f404(true, 99, 0.4)],
    },
    controls: { throttle: [0.85, 0.85], gearDown: false, flaps: 0, pitch: 0.9, roll: -0.2 },
    turnRate: -12,
    height: 4,
  },
};

export function state(name: string): State {
  const st = STATES[name] ?? STATES['climb-turn']!;
  const t = st.telemetry;
  t.agl ??= t.onGround ? 0 : 1000;
  t.verticalSpeed ??= 0;
  t.trackDeg = t.headingDeg;
  return st;
}

/** The levers bound to the control input as the simulation binds them. */
export function bind(panel: CockpitPanel, c: ControlInput) {
  for (const [id, i] of [
    ['throttle1', 0],
    ['throttle2', 1],
  ] as const)
    panel.bind(
      id,
      () => c.throttle[i] ?? 0,
      (v) => (c.throttle[i] = v),
    );
  panel.bind(
    'flaps',
    () => (c.flaps < 0.25 ? 0 : c.flaps < 0.75 ? 1 : 2),
    (v) => (c.flaps = v / 2),
  );
  panel.bind(
    'gear',
    () => (c.gearDown ? 1 : 0),
    (v) => (c.gearDown = v >= 0.5),
  );
  panel.bind(
    'speedbrake',
    () => ((c.speedbrake ?? 0) >= 0.5 ? 1 : 0),
    (v) => (c.speedbrake = v >= 0.5 ? 1 : 0),
  );
}

const PLAN: Waypoint[] = [
  { ident: 'LSMP', lon: 6.9196, lat: 46.8432 },
  { ident: 'GVA', lon: 6.24, lat: 46.25 },
  { ident: 'SPR', lon: 7.13, lat: 46.6 },
  { ident: 'TRA', lon: 8.44, lat: 47.69 },
  { ident: 'LSME', lon: 8.413, lat: 46.6 },
];

const fake = {
  name: 'climb-turn',
  n2: [0, 0],
  ab: [0, 0],
  hook: 0,
  peakG: 1,
  lon: 7.0,
  lat: 46.75,
  ap: {
    engaged: false,
    lateral: 'roll' as AutopilotTelemetry['lateral'],
    vertical: 'pitch' as AutopilotTelemetry['vertical'],
  },
  pressed: new Map<string, boolean>(),
};

/** What a pilot would have set by now in the state. */
export function setup(
  panel: CockpitPanel,
  name: string,
  night: boolean,
  running: boolean,
  t: Telemetry,
) {
  fake.name = name;
  fake.n2 = t.engines.map((e) => e.n2 ?? 0);
  fake.ab = t.engines.map((e) => e.afterburner ?? 0);
  if (running) {
    for (const id of [
      'battery',
      'generatorLeft',
      'generatorRight',
      'seatArmed',
      'oxygen',
      'pitotHeat',
    ])
      panel.set(id, 1);
    panel.set('canopy', 2);
    panel.set('hudBrightness', 0.8);
    panel.set('ddiLeftPage', name === 'landing' ? 2 : 3);
    panel.set('ddiRightPage', name === 'cruise' ? 6 : 1);
    panel.set('mpcdPage', 1);
    panel.set('mapRange', name === 'cruise' ? 3 : 1);
    panel.set('headingBug', Math.round(t.headingDeg + 20) % 360);
    panel.set('obs1', 316);
    panel.set('navSource', name === 'landing' ? 0 : 1);
    panel.set('ilsOn', name === 'landing' ? 1 : 0);
    panel.set('hudAltitude', name === 'landing' ? 1 : 0);
    panel.set('xpdrMode', 3);
    panel.set('xpdrCode', 4521);
    panel.set('tacanChannel', 63);
    panel.set('lightNav', 1);
    panel.set('lightStrobe', t.onGround ? 0 : 1);
    if (name === 'landing' || name === 'takeoff') panel.set('lightLanding', 2);
    if (name === 'ramp') panel.set('lightLanding', 1);
    if (name === 'cruise') {
      fake.ap.engaged = true;
      fake.ap.lateral = 'nav';
      fake.ap.vertical = 'alt';
    }
  }
  if (night) {
    panel.set('lightPanel', 0.8);
    panel.set('lightConsole', 0.7);
    panel.set('lightFlood', 0.4);
    if (running) panel.set('lightFormation', 0.6);
  }
  if (q.has('hook')) panel.set('hook', Number(q.get('hook')));
  // ?pages=left,right,mpcd: the display pages by index (FA18_CONTROLS' positions).
  const pages = q.get('pages')?.split(',').map(Number);
  if (pages?.length === 3)
    for (const [i, id] of ['ddiLeftPage', 'ddiRightPage', 'mpcdPage'].entries())
      panel.set(id, pages[i]!);
  if (q.has('canopy')) panel.set('canopy', Number(q.get('canopy')));
  if (name === 'takeoff' || name === 'ramp') panel.set('flaps', 1);
}

const pressed = (panel: CockpitPanel, id: string) => {
  const now = panel.get(id) >= 0.5;
  const was = fake.pressed.get(id) ?? false;
  fake.pressed.set(id, now);
  return now && !was;
};

/** One step of the fakes. */
export function step(dt: number, t: Telemetry, c: ControlInput, panel: CockpitPanel) {
  const v = (id: string) => panel.get(id);
  const bat = v('battery') >= 0.5;
  // --- engines: N2 follows the throttle, the afterburner lights above military ---
  for (let i = 0; i < 2; i++) {
    const e = t.engines[i]!;
    const thr = c.throttle[i] ?? 0;
    const cut = v(`fuelCutoff${i + 1}`) < 0.5;
    if (cut) e.running = false;
    else if (!e.running && fake.n2[i]! > 20) e.running = true;
    const crank = Math.round(v('engineCrank')) === (i === 0 ? 0 : 2) && v('apu') >= 0.5;
    const target = e.running
      ? 70 + 27 * Math.min(thr / 0.75, 1) + (thr > 0.75 ? 3 : 0)
      : crank
        ? 25
        : 0;
    fake.n2[i]! += (target - fake.n2[i]!) * Math.min(1, dt * (e.running ? 0.8 : 0.3));
    const abT = e.running && thr > 0.76 ? (thr - 0.75) / 0.25 : 0;
    fake.ab[i]! += (abT - fake.ab[i]!) * Math.min(1, dt * 3);
    const ab = num('ab') ?? fake.ab[i]!;
    const n = f404(e.running, fake.n2[i]!, ab);
    Object.assign(e, n, { running: e.running || (!cut && fake.n2[i]! > 20) });
    if (num('nozzle') !== undefined) e.nozzle = num('nozzle');
  }
  // --- gear, flaps, speed brake, hook, canopy ---
  const gT = c.gearDown ? 1 : 0;
  t.gear = num('gear') ?? t.gear + Math.sign(gT - t.gear) * Math.min(Math.abs(gT - t.gear), dt / 6);
  const flapSel = c.flaps < 0.25 ? 0 : c.flaps < 0.75 ? 1 : 2;
  // AUTO: up in flight; HALF and FULL to 30 and 45 degrees.
  const fT = flapSel === 0 ? 0 : flapSel === 1 ? 30 / 45 : 1;
  t.flaps += Math.sign(fT - t.flaps) * Math.min(Math.abs(fT - t.flaps), dt / 4);
  const sbT = c.speedbrake ?? 0;
  t.speedbrake =
    (t.speedbrake ?? 0) +
    Math.sign(sbT - (t.speedbrake ?? 0)) * Math.min(Math.abs(sbT - (t.speedbrake ?? 0)), dt / 2);
  if (num('aoa') !== undefined) t.alpha = num('aoa')! * DEG;
  if (num('g') !== undefined) t.loadFactor = num('g')!;
  // --- systems ---
  const genL = v('generatorLeft') >= 0.5 && t.engines[0]!.running;
  const genR = v('generatorRight') >= 0.5 && t.engines[1]!.running;
  const bus = genL || genR ? 28 : bat ? 24.5 : 0;
  const lit = (id: string) => v(id) >= 0.5 && bus > 18;
  const landingSel = Math.round(v('lightLanding'));
  const internal = t.fuel;
  const systems: SystemsTelemetry = {
    busVolts: bus,
    batteryAmps: genL || genR ? 4 : -15,
    batteryCharge: 0.9,
    avionicsPowered: bus > 20,
    fuelLeft: internal / 2,
    fuelRight: internal / 2,
    fuelAvailable: true,
    vacuum: 0,
    oilTemperature: 80,
    oilPressure: t.engines[0]!.oilPressure ?? 0,
    egt: 0,
    carbIce: 0,
    airframeIce: 0,
    pitotBlocked: false,
    lights: {
      beacon: false,
      landing: bus > 18 && landingSel === 2,
      taxi: bus > 18 && landingSel === 1,
      nav: lit('lightNav'),
      strobe: lit('lightStrobe'),
    },
    panelLight: bus > 18 ? v('lightPanel') : 0,
    annunciators: {
      lowVolts: bus < 25,
      lowFuelLeft: false,
      lowFuelRight: false,
      lowVacuum: false,
      oilPressure: false,
    },
    // Six tanks: the two feed tanks first (as the IFEI's L and R), then 1, 4 and the wings.
    fuelTanks: [
      Math.min(internal * 0.22, 590),
      Math.min(internal * 0.22, 590),
      internal * 0.18,
      internal * 0.18,
      internal * 0.1,
      internal * 0.1,
    ],
    hydraulics: [t.engines[0]!.running ? 3000 : 0, t.engines[1]!.running ? 3000 : 0],
  };
  t.systems = systems;
  t.instruments = undefined;
  // --- avionics, with the autopilot keys of the UFC ---
  const on = bus > 20;
  const ap = fake.ap;
  if (on) {
    if (pressed(panel, 'apEngage')) ap.engaged = !ap.engaged;
    if (pressed(panel, 'apDisconnect')) ap.engaged = false;
    if (pressed(panel, 'apAttitude'))
      [ap.engaged, ap.lateral, ap.vertical] = [true, 'roll', 'pitch'];
    if (pressed(panel, 'apHdg')) [ap.engaged, ap.lateral] = [true, 'hdg'];
    if (pressed(panel, 'apAlt')) [ap.engaged, ap.vertical] = [true, 'alt'];
    if (pressed(panel, 'apRadarAlt')) [ap.engaged, ap.vertical] = [true, 'vs'];
    if (pressed(panel, 'apNav')) [ap.engaged, ap.lateral] = [true, 'nav'];
    for (const r of ['com1', 'com2', 'nav1'])
      if (pressed(panel, `${r}Swap`)) {
        const a = v(`${r}Active`);
        panel.set(`${r}Active`, v(`${r}Standby`));
        panel.set(`${r}Standby`, a);
      }
  }
  fake.lon +=
    (t.groundSpeed * dt * Math.sin(t.trackDeg * DEG)) / 1852 / 60 / Math.cos(fake.lat * DEG);
  fake.lat += (t.groundSpeed * dt * Math.cos(t.trackDeg * DEG)) / 1852 / 60;
  const active = 3;
  const wp = PLAN[active]!;
  const prev = PLAN[active - 1]!;
  const dE = (wp.lon - fake.lon) * 60 * Math.cos(fake.lat * DEG);
  const dN = (wp.lat - fake.lat) * 60;
  const legE = (wp.lon - prev.lon) * 60 * Math.cos(fake.lat * DEG);
  const legN = (wp.lat - prev.lat) * 60;
  const legLen = Math.hypot(legE, legN);
  const ils = fake.name === 'landing';
  const gs = t.groundSpeed / KT;
  const nav1 = {
    frequency: v('nav1Active'),
    standby: v('nav1Standby'),
    valid: on,
    ident: ils ? 'IPAY' : 'FRI',
    localizer: ils,
    course: ils ? 316 : v('obs1'),
    deviation: ils ? 0.15 : -0.3,
    toFrom: 'to' as const,
    bearing: 312,
    glideSlope: ils ? -0.2 : undefined,
  };
  const avionics: AvionicsTelemetry = {
    powered: on,
    com1: { active: v('com1Active'), standby: v('com1Standby') },
    com2: { active: v('com2Active'), standby: v('com2Standby') },
    nav1,
    nav2: {
      ...nav1,
      valid: false,
      ident: '',
      localizer: false,
      glideSlope: undefined,
      bearing: undefined,
    },
    dme: {
      source: 'nav1',
      distanceNm: ils ? 5.2 : 18.4,
      groundSpeedKt: gs,
      minutes: gs > 30 ? ((ils ? 5.2 : 18.4) / gs) * 60 : undefined,
    },
    adf: { frequency: 300, valid: false, ident: '', relativeBearing: undefined },
    transponder: {
      code: v('xpdrCode'),
      mode: (['off', 'standby', 'on', 'alt'] as const)[Math.round(v('xpdrMode'))]!,
      ident: false,
      reply: false,
    },
    markers: { outer: false, middle: false, inner: false },
    autopilot: {
      engaged: ap.engaged,
      lateral: ap.lateral,
      lateralArmed: undefined,
      vertical: ap.vertical,
      verticalArmed: undefined,
      selectedAltitude: 25000,
      selectedVerticalSpeed: 0,
      disconnectWarning: false,
    },
    gps: {
      plan: PLAN,
      active,
      distanceNm: Math.hypot(dE, dN),
      bearing: (Math.atan2(dE, dN) / DEG + 360) % 360,
      desiredTrack: (Math.atan2(legE, legN) / DEG + 360) % 360,
      crossTrackNm: legLen > 0 ? (dN * legE - dE * legN) / legLen : 0,
      groundSpeedKt: gs,
      track: t.trackDeg,
      lon: fake.lon,
      lat: fake.lat,
    },
  };
  // The F/A-18 block, in the shape the simulation reports it.
  fake.peakG = Math.max(fake.peakG, t.loadFactor);
  const fails = (q.get('fail') ?? '').split(',').filter(Boolean).map(Number);
  const steerDist = Math.hypot(dE, dN);
  const block = {
    flightPath: Math.asin(Math.max(-1, Math.min(1, t.verticalSpeed / Math.max(t.tas, 1)))),
    drift: (fake.name === 'climb-turn' ? 2 : fake.name === 'landing' ? -3 : 0) * DEG,
    alpha: t.alpha,
    onSpeed:
      t.gear > 0.5 && !t.onGround
        ? t.alpha / DEG > 9.3
          ? 'slow'
          : t.alpha / DEG < 6.9
            ? 'fast'
            : 'onSpeed'
        : undefined,
    g: t.loadFactor,
    peakG: fake.peakG,
    gLimit: 7.5,
    mach: t.mach,
    radarAltitude: t.agl !== undefined && t.agl < 5000 * FT ? t.agl : undefined,
    verticalVelocity: t.verticalSpeed,
    steering: {
      source: ils ? 'ils' : 'wypt',
      valid: on,
      bearing: (Math.atan2(dE, dN) / DEG + 360) % 360,
      rangeNm: steerDist,
      minutes: gs > 30 ? (steerDist / gs) * 60 : undefined,
    },
    ils: ils ? { localizer: 0.15, glideSlope: -0.2 } : undefined,
    ilsOn: v('ilsOn') >= 0.5,
    flapMode: (['auto', 'half', 'full'] as const)[flapSel],
    gear: t.gear > 0.99 ? 'down' : t.gear < 0.01 ? 'up' : 'transit',
    cautions: [] as string[],
    advisories: ap.engaged ? [] : [],
    modes: ap.engaged
      ? [
          ap.lateral === 'hdg' ? 'HSEL' : ap.lateral === 'nav' ? 'CPL WYPT' : 'ATT',
          ap.vertical === 'alt' ? 'BALT' : '',
        ]
      : [],
    bingoSetting: v('bingo') || 1100,
    bingo: t.fuel < (v('bingo') || 1100),
    fcsFailed: fails,
  };
  (avionics as AvionicsTelemetry & { fa18?: never }).fa18 = block as never;
  t.avionics = avionics;
}
