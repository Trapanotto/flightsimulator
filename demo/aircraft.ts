// Demo of the aircraft package: one Cessna 172S on a ground plane, fed with fake telemetry.
// Served by Vite at /flightsimulator/demo/aircraft.html.
//   ?view=front-left|side|top|rear|front|cockpit|panel|tail|orbit   camera
//   ?state=parked|cruise|climb-turn|landing                         fake telemetry
//   ?webgl=1        force the WebGL 2 fallback      ?device=mobile   low quality
//   ?night=1        dark scene to judge the lights   ?shot=1          fixed frame, no text
//   ?look=yaw,pitch  cockpit look (the app's drag-to-look values)   ?fov=55   cockpit field of view
//   ?quality=low    low quality on a desktop          ?highlight=<control>  checklist highlight
//   ?nosystems ?noinstruments ?noavionics  leave a fake out (the cockpit then shows the plain telemetry)
// In the cockpit view: drag to look, click or tap controls, wheel on knobs; the panel on the
// right switches the fake systems and avionics.
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardNodeMaterial,
  PCFSoftShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  type ControlHit,
  REPEAT,
  dragControl,
  isDragged,
  loadAircraftVisual,
  pressControl,
  wheelControl,
} from '@aircraft';
import {
  type AutopilotTelemetry,
  type AvionicsTelemetry,
  C172_CONTROLS,
  CockpitPanel,
  type ControlInput,
  type SystemsTelemetry,
  type Telemetry,
  type Waypoint,
} from '@sim';

// No global declaration: every demo page has its own shape of __demo.
const demoWindow = window as unknown as {
  __demo?: {
    ready: boolean;
    backend: string;
    telemetry: Telemetry;
    ac?: unknown;
    [k: string]: unknown;
  };
};

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'front-left';
const stateName = q.get('state') ?? 'climb-turn';
const night = q.has('night');
const shot = q.has('shot');
if (shot) document.body.classList.add('shot');
const KT = 0.514444;
const FT = 0.3048;
const DEG = Math.PI / 180;

interface DemoState {
  telemetry: Partial<Telemetry>;
  controls: Partial<ControlInput>;
  /** Heading change, deg/s (for the turn coordinator). */
  turnRate: number;
  /** Height of the wheels above the ground plane in the picture, m. */
  height: number;
}

const STATES: Record<string, DemoState> = {
  parked: {
    telemetry: {
      ias: 0,
      groundSpeed: 0,
      altitude: 510,
      verticalSpeed: 0,
      headingDeg: 140,
      pitch: 0,
      bank: 0,
      onGround: true,
      flaps: 0,
      elevator: -0.15,
      aileron: 0,
      rudder: 0,
      fuel: 100,
      engines: [{ running: false, rpm: 0, power: 0, fuelFlow: 0 }],
    },
    controls: { throttle: [0], mixture: [0], flaps: 0, pitch: -0.15, parkingBrake: true },
    turnRate: 0,
    height: 0,
  },
  cruise: {
    telemetry: {
      ias: 110 * KT,
      groundSpeed: 120 * KT,
      altitude: 4500 * FT,
      verticalSpeed: 0,
      headingDeg: 90,
      pitch: 1.5 * DEG,
      bank: 0,
      onGround: false,
      flaps: 0,
      elevator: 0.05,
      aileron: 0,
      rudder: 0.02,
      fuel: 110,
      agl: 900,
      engines: [{ running: true, rpm: 2400, power: 0.7, fuelFlow: 0.0085 }],
    },
    controls: { throttle: [0.75], mixture: [0.85], flaps: 0, pitch: 0.05, pitchTrim: 0.1 },
    turnRate: 0,
    height: 1.5,
  },
  'climb-turn': {
    telemetry: {
      ias: 80 * KT,
      groundSpeed: 85 * KT,
      altitude: 2500 * FT,
      verticalSpeed: (700 * FT) / 60,
      headingDeg: 210,
      pitch: 7 * DEG,
      bank: 25 * DEG,
      beta: 2 * DEG,
      onGround: false,
      flaps: 0,
      elevator: 0.35,
      aileron: 0.35,
      rudder: 0.25,
      fuel: 130,
      agl: 250,
      engines: [{ running: true, rpm: 2550, power: 0.92, fuelFlow: 0.011 }],
    },
    controls: {
      throttle: [1],
      mixture: [1],
      flaps: 0,
      pitch: 0.35,
      roll: 0.35,
      yaw: 0.25,
      pitchTrim: 0.3,
    },
    turnRate: 3,
    height: 1.5,
  },
  landing: {
    telemetry: {
      ias: 65 * KT,
      groundSpeed: 60 * KT,
      altitude: 1200 * FT,
      verticalSpeed: (-500 * FT) / 60,
      headingDeg: 320,
      pitch: 2 * DEG,
      bank: -10 * DEG,
      beta: -1 * DEG,
      onGround: false,
      flaps: 1,
      elevator: 0.25,
      aileron: -0.3,
      rudder: -0.3,
      fuel: 60,
      agl: 120,
      engines: [{ running: true, rpm: 1500, power: 0.3, fuelFlow: 0.004 }],
    },
    controls: {
      throttle: [0.3],
      mixture: [1],
      flaps: 1,
      pitch: 0.25,
      roll: -0.3,
      yaw: -0.3,
      pitchTrim: 0.5,
    },
    turnRate: -1.5,
    height: 1.5,
  },
};

const st = STATES[stateName] ?? STATES['climb-turn']!;
const telemetry: Telemetry = {
  time: 0,
  ias: 0,
  tas: 0,
  groundSpeed: 0,
  altitude: 0,
  agl: 0,
  verticalSpeed: 0,
  headingDeg: 0,
  trackDeg: 0,
  pitch: 0,
  bank: 0,
  alpha: 0,
  beta: 0,
  loadFactor: 1,
  onGround: true,
  stallWarning: false,
  flaps: 0,
  gear: 1,
  elevator: 0,
  aileron: 0,
  rudder: 0,
  engines: [{ running: false, rpm: 0, power: 0, fuelFlow: 0 }],
  fuel: 100,
  crashed: undefined,
  ...st.telemetry,
};
telemetry.tas = telemetry.ias;
telemetry.trackDeg = telemetry.headingDeg;
const controls: ControlInput = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: [0],
  flaps: 0,
  gearDown: true,
  brakeLeft: 0,
  brakeRight: 0,
  parkingBrake: false,
  pitchTrim: 0,
  mixture: [1],
  ...st.controls,
};

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: q.has('webgl') });
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
  ? 'WebGPU'
  : 'WebGL 2';
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = night ? 1.0 : 0.85;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new Scene();
scene.background = new Color(night ? 0x070b14 : 0x9fb8d0);
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = night ? 0.03 : 0.55;
const sun = new DirectionalLight(0xfff4e6, night ? 0 : 3.2);
sun.position.set(-12, 22, 14);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -9;
sc.right = sc.top = 9;
sc.near = 1;
sc.far = 80;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
scene.add(new HemisphereLight(0xc9dcf0, 0x5a5348, night ? 0.02 : 0.6));

const groundMat = new MeshStandardNodeMaterial({
  color: night ? 0x2a2a2c : 0x8d8c86,
  roughness: 0.92,
});
const ground = new Mesh(new PlaneGeometry(400, 400), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const quality = q.get('device') === 'mobile' || q.get('quality') === 'low' ? 'low' : 'high';
const ac = await loadAircraftVisual('c172', { quality, landingLightSpot: night });
scene.add(ac.object);
const wheelY = Math.min(...ac.wheelContacts.map((w) => w.y));
ac.object.position.y = -wheelY + st.height;
// Model frame: nose up = negative about +x, right bank = positive about +z (forward). The
// heading is left out so the cameras keep their framing.
ac.object.rotation.set(-telemetry.pitch, 0, telemetry.bank, 'YXZ');
ac.setLights('auto');
ac.setExposure(night ? 400 : 4.2);

// ---- the cockpit's controls, bound to the control input as the simulation does ----------
const engineRunning = telemetry.engines[0]!.running;
const panel = new CockpitPanel(C172_CONTROLS);
panel.bind(
  'throttle',
  () => controls.throttle[0] ?? 0,
  (v) => (controls.throttle[0] = v),
);
panel.bind(
  'mixture',
  () => controls.mixture[0] ?? 1,
  (v) => (controls.mixture[0] = v),
);
panel.bind(
  'flaps',
  () => Math.round(controls.flaps * 3),
  (v) => (controls.flaps = v / 3),
);
panel.bind(
  'trim',
  () => controls.pitchTrim,
  (v) => (controls.pitchTrim = v),
);
panel.bind(
  'parkingBrake',
  () => (controls.parkingBrake ? 1 : 0),
  (v) => (controls.parkingBrake = v >= 0.5),
);
{
  const keep = { ...controls, throttle: [...controls.throttle], mixture: [...controls.mixture] };
  panel.reset(engineRunning);
  // The demo state's levers win over the reset.
  Object.assign(controls, keep);
  if (night) for (const id of ['lightPanel']) panel.set(id, 0.8);
  if (night && engineRunning)
    for (const id of ['lightNav', 'lightBeacon', 'lightStrobe']) panel.set(id, 1);
}

// ---- fake systems, instruments and avionics (the real ones are connected in the app) ---------
const ui = {
  systems: !q.has('nosystems'),
  instruments: !q.has('noinstruments'),
  avionics: !q.has('noavionics'),
  nav1: q.get('nav1') !== '0',
  ils: true,
  dev1: 0.25,
  gs1: -0.3,
  nav2: true,
  dev2: -0.5,
  dme: 12.4,
  adf: true,
  adfBearing: 35,
  vacuumFail: q.has('vacfail'),
  altFail: false,
  fuelL: 20,
  fuelR: 14,
  markers: q.get('markers') ?? '',
  highlight: q.get('highlight') ?? '',
};
const GAL = 2.7255;
const fake = {
  rpm: telemetry.engines[0]!.rpm,
  oilT: engineRunning ? 85 : 15,
  identUntil: -1,
  wasPressed: new Map<string, boolean>(),
  ap: {
    engaged: stateName === 'cruise',
    lateral: 'hdg' as AutopilotTelemetry['lateral'],
    lateralArmed: undefined as AutopilotTelemetry['lateralArmed'],
    vertical: 'alt' as AutopilotTelemetry['vertical'],
    verticalArmed: undefined as AutopilotTelemetry['verticalArmed'],
    vs: 500,
    armedAt: 0,
    offAt: -10,
  },
  lon: 7.42,
  lat: 46.95,
  drift: 0,
};
const PLAN: Waypoint[] = [
  { ident: 'LSZB', lon: 7.4997, lat: 46.9141 },
  { ident: 'HOC', lon: 7.31, lat: 47.07 },
  { ident: 'WIL', lon: 7.13, lat: 47.18 },
  { ident: 'LSGG', lon: 6.109, lat: 46.238 },
];

/** A button's press (rising edge): what the avionics act on. */
const pressed = (id: string) => {
  const now = panel.get(id) >= 0.5;
  const was = fake.wasPressed.get(id) ?? false;
  fake.wasPressed.set(id, now);
  return now && !was;
};

function fakeStep(dt: number) {
  const t = telemetry;
  const mag = Math.round(panel.get('magnetos'));
  const fuelOk = panel.get('fuelShutoff') >= 0.5 && ui.fuelL + ui.fuelR > 0;
  const eng = t.engines[0]!;
  if (ui.systems) {
    // Runs with ignition and fuel; START cranks it.
    const canRun = mag >= 1 && (controls.mixture[0] ?? 0) > 0.15 && fuelOk;
    eng.running = canRun && (eng.running || mag === 4);
    const target = eng.running ? 650 + 2000 * (controls.throttle[0] ?? 0) : mag === 4 ? 250 : 0;
    fake.rpm += (target - fake.rpm) * Math.min(1, dt * 2);
    eng.rpm = fake.rpm;
    eng.power = eng.running ? (controls.throttle[0] ?? 0) : 0;
    eng.fuelFlow = eng.running ? (0.0015 + 0.011 * eng.power) * (controls.mixture[0] ?? 1) : 0;
  }
  const running = eng.running;
  const bat = panel.get('battery') >= 0.5;
  const alt = panel.get('alternator') >= 0.5 && running && !ui.altFail;
  const bus = alt ? 28.2 : bat ? 24.2 : 0;
  const avionicsOn = bus > 20 && panel.get('avionics') >= 0.5;
  const vacuum = running && !ui.vacuumFail ? 5 * Math.min(fake.rpm / 900, 1) : 0;
  fake.oilT += ((running ? 80 + 30 * eng.power : 15) - fake.oilT) * Math.min(1, dt / 30);
  const oilP = running ? 55 + 25 * Math.min(fake.rpm / 2700, 1) : 0;
  const lit = (id: string) => panel.get(id) >= 0.5 && bus > 8;
  const systems: SystemsTelemetry = {
    busVolts: bus,
    batteryAmps: alt ? 2.5 : bat ? -6 - (avionicsOn ? 4 : 0) : 0,
    batteryCharge: 0.9,
    avionicsPowered: avionicsOn,
    fuelLeft: ui.fuelL * GAL,
    fuelRight: ui.fuelR * GAL,
    fuelAvailable: fuelOk,
    vacuum,
    oilTemperature: fake.oilT,
    oilPressure: oilP,
    egt: running
      ? Math.max(
          0,
          0.45 + 0.4 * eng.power - 1.2 * Math.abs((controls.mixture[0] ?? 1) - 0.72) * eng.power,
        )
      : 0,
    carbIce: 0,
    airframeIce: 0,
    pitotBlocked: false,
    lights: {
      beacon: lit('lightBeacon'),
      landing: lit('lightLanding'),
      taxi: lit('lightTaxi'),
      nav: lit('lightNav'),
      strobe: lit('lightStrobe'),
    },
    panelLight: bus > 8 ? panel.get('lightPanel') : 0,
    annunciators: {
      lowVolts: bus > 0 && bus < 25,
      lowFuelLeft: ui.fuelL < 5,
      lowFuelRight: ui.fuelR < 5,
      lowVacuum: vacuum < 3.5,
      oilPressure: oilP < 20,
    },
  };
  t.systems = ui.systems ? systems : undefined;
  // Instruments: the truth, with toppling gyros without suction and a dead turn coordinator.
  if (ui.vacuumFail) fake.drift += dt * 2;
  const tcPower = bus > 8;
  t.instruments = ui.instruments
    ? {
        airspeed: t.ias,
        pitch: t.pitch + (ui.vacuumFail ? Math.min(fake.drift, 25) * DEG : 0),
        bank: t.bank + (ui.vacuumFail ? Math.min(fake.drift * 1.5, 40) * DEG : 0),
        altitude: t.altitude - 49 + (panel.get('altimeterSetting') - 1013.25) * 8.43,
        verticalSpeed: t.verticalSpeed,
        heading: t.headingDeg + panel.get('gyroAdjust') + (ui.vacuumFail ? fake.drift * 3 : 0),
        compass: t.headingDeg,
        turnRate: tcPower ? st.turnRate : 0,
        slip: Math.max(-1, Math.min(1, t.beta * 10)),
        fuelLeft: ui.fuelL / 26.5,
        fuelRight: ui.fuelR / 26.5,
        gyroFlag: vacuum < 3,
        turnFlag: !tcPower,
      }
    : undefined;
  // Avionics: swaps on the key's press, the autopilot's modes, a fake ILS and a flight plan.
  for (const r of ['com1', 'com2', 'nav1', 'nav2']) {
    if (pressed(`${r}Swap`) && avionicsOn) {
      const a = panel.get(`${r}Active`);
      panel.set(`${r}Active`, panel.get(`${r}Standby`));
      panel.set(`${r}Standby`, a);
    }
  }
  const ap = fake.ap;
  if (pressed('apEngage') && avionicsOn) {
    ap.engaged = !ap.engaged;
    if (!ap.engaged) ap.offAt = t.time;
    else {
      ap.lateral = 'roll';
      ap.vertical = 'vs';
      ap.vs = Math.round((t.verticalSpeed * 196.85) / 100) * 100;
    }
  }
  if (ap.engaged) {
    if (pressed('apHdg')) ap.lateral = ap.lateral === 'hdg' ? 'roll' : 'hdg';
    if (pressed('apNav')) [ap.lateralArmed, ap.armedAt] = ['nav', t.time];
    if (pressed('apApr')) [ap.lateralArmed, ap.armedAt] = ['apr', t.time];
    if (pressed('apAlt')) ap.vertical = ap.vertical === 'alt' ? 'vs' : 'alt';
    if (pressed('apVsUp')) [ap.vertical, ap.vs] = ['vs', ap.vs + 100];
    if (pressed('apVsDown')) [ap.vertical, ap.vs] = ['vs', ap.vs - 100];
    if (ap.lateralArmed && t.time - ap.armedAt > 3) {
      ap.lateral = ap.lateralArmed;
      if (ap.lateralArmed === 'apr') ap.verticalArmed = 'gs';
      ap.lateralArmed = undefined;
    }
  } else for (const id of ['apHdg', 'apNav', 'apApr', 'apAlt', 'apVsUp', 'apVsDown']) pressed(id);
  if (pressed('xpdrIdent')) fake.identUntil = t.time + 18;
  // The flight plan's position moves with the aircraft.
  const gsMs = t.groundSpeed;
  fake.lon += (gsMs * dt * Math.sin(t.trackDeg * DEG)) / 1852 / 60 / Math.cos(fake.lat * DEG);
  fake.lat += (gsMs * dt * Math.cos(t.trackDeg * DEG)) / 1852 / 60;
  const active = 2;
  const wp = PLAN[active]!;
  const prev = PLAN[active - 1]!;
  const dE = (wp.lon - fake.lon) * 60 * Math.cos(fake.lat * DEG);
  const dN = (wp.lat - fake.lat) * 60;
  const legE = (wp.lon - prev.lon) * 60 * Math.cos(fake.lat * DEG);
  const legN = (wp.lat - prev.lat) * 60;
  const legLen = Math.hypot(legE, legN);
  const dtk = (Math.atan2(legE, legN) / DEG + 360) % 360;
  const nav = (n: 1 | 2) => {
    const valid = n === 1 ? ui.nav1 : ui.nav2;
    return {
      frequency: panel.get(`nav${n}Active`),
      standby: panel.get(`nav${n}Standby`),
      valid,
      ident: valid ? (n === 1 ? 'IBE' : 'WIL') : '',
      localizer: n === 1 && ui.ils,
      course: panel.get(`obs${n}`),
      deviation: n === 1 ? ui.dev1 : ui.dev2,
      toFrom: valid ? ('to' as const) : ('off' as const),
      bearing: valid ? 140 : undefined,
      glideSlope: n === 1 && valid && ui.ils ? ui.gs1 : undefined,
    };
  };
  const dmeNav = panel.get('dmeSource') >= 0.5 ? ui.nav2 : ui.nav1;
  const kt = t.groundSpeed * MS_TO_KT_DEMO;
  const avionics: AvionicsTelemetry = {
    powered: avionicsOn,
    com1: { active: panel.get('com1Active'), standby: panel.get('com1Standby') },
    com2: { active: panel.get('com2Active'), standby: panel.get('com2Standby') },
    nav1: nav(1),
    nav2: nav(2),
    dme: {
      source: panel.get('dmeSource') >= 0.5 ? 'nav2' : 'nav1',
      distanceNm: dmeNav ? ui.dme : undefined,
      groundSpeedKt: dmeNav ? kt : undefined,
      minutes: dmeNav && kt > 30 ? (ui.dme / kt) * 60 : undefined,
    },
    adf: {
      frequency: panel.get('adfFrequency'),
      valid: ui.adf,
      ident: ui.adf ? 'BER' : '',
      relativeBearing: ui.adf ? ui.adfBearing : undefined,
    },
    transponder: {
      code: panel.get('xpdrCode'),
      mode: (['off', 'standby', 'on', 'alt'] as const)[Math.round(panel.get('xpdrMode'))]!,
      ident: t.time < fake.identUntil,
      reply: panel.get('xpdrMode') >= 2 && t.time % 2 < 0.12,
    },
    markers: {
      outer: ui.markers.includes('o'),
      middle: ui.markers.includes('m'),
      inner: ui.markers.includes('i'),
    },
    autopilot: {
      engaged: ap.engaged,
      lateral: ap.lateral,
      lateralArmed: ap.lateralArmed,
      vertical: ap.vertical,
      verticalArmed: ap.verticalArmed,
      selectedAltitude: panel.get('apAltitude'),
      selectedVerticalSpeed: ap.vs,
      disconnectWarning: t.time - ap.offAt < 2.5,
    },
    gps: {
      plan: PLAN,
      active,
      distanceNm: Math.hypot(dE, dN),
      bearing: (Math.atan2(dE, dN) / DEG + 360) % 360,
      desiredTrack: dtk,
      // Positive right of the leg.
      crossTrackNm: legLen > 0 ? (dN * legE - dE * legN) / legLen : 0,
      groundSpeedKt: kt,
      track: t.trackDeg,
      lon: fake.lon,
      lat: fake.lat,
    },
  };
  t.avionics = ui.avionics ? avionics : undefined;
}
const MS_TO_KT_DEMO = 1 / KT;

// ---- camera ---------------------------------------------------------------------------------
const camera = new PerspectiveCamera(40, 1, 0.05, 2000);
const target = new Vector3(0, ac.object.position.y - 0.2, 0.4);
const cams: Record<string, [number, number, number]> = {
  'front-left': [7.5, 1.6, 9.5],
  side: [17, 0.4, 0.4],
  front: [0, 0.6, 18],
  top: [0.01, 22, 0.6],
  rear: [-6.5, 2.8, -10],
  tail: [3.0, 1.6, -7.8],
  low: [4.2, -0.6, 4.6],
  // Beyond the LOD distances: 60 m (LOD1) and 200 m (LOD2).
  far: [35, 6, 48],
  distant: [120, 20, 160],
};
/** The app's cockpit look (src/app/camera.ts): yaw +-2.5 rad, pitch -1.2..1.3, 0.8 of it applied. */
const look = { yaw: 0, pitch: -0.28 };
const lookArg = q.get('look')?.split(',').map(Number);
if (lookArg && lookArg.length === 2) [look.yaw, look.pitch] = lookArg as [number, number];
const UP = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const applyLook = () => {
  look.yaw = Math.min(2.5, Math.max(-2.5, look.yaw));
  look.pitch = Math.min(1.3, Math.max(-1.2, look.pitch));
  camera.quaternion
    .setFromAxisAngle(UP, Math.PI + look.yaw)
    .multiply(new Quaternion().setFromAxisAngle(X, look.pitch * 0.8));
};
/** Points the eye at a model-frame point (as far as the app's limits allow). */
const aimAt = (p: { x: number; y: number; z: number }) => {
  const e = ac.view.eye;
  const dx = p.x - e.x;
  const dy = p.y - e.y;
  const dz = p.z - e.z;
  look.yaw = Math.atan2(dx, dz);
  look.pitch = Math.atan2(dy, Math.hypot(dx, dz)) / 0.8;
  applyLook();
};
const inCockpit = view === 'cockpit' || view === 'panel';
let controlsOrbit: OrbitControls | undefined;
if (inCockpit) {
  ac.setCockpitView(true);
  ac.object.add(camera);
  const e = ac.view.eye;
  camera.position.set(e.x, e.y, e.z);
  ac.object.updateMatrixWorld(true);
  if (view === 'cockpit') {
    camera.fov = Number(q.get('fov') ?? 55);
    applyLook();
  } else {
    camera.up.set(0, 1, 0).applyQuaternion(ac.object.quaternion);
    camera.fov = 28;
    camera.lookAt(ac.object.localToWorld(new Vector3(e.x - 0.03, e.y - 0.62, e.z + 0.98)));
  }
} else {
  const p = cams[view] ?? cams['front-left']!;
  camera.position.set(p[0], ac.object.position.y + p[1], p[2]);
  if (view === 'side') camera.fov = 30;
  // Zoomed in, so the reduced models can be judged at their switching distance.
  if (view === 'far') camera.fov = 12;
  if (view === 'distant') camera.fov = 4;
  if (view === 'top') camera.up.set(0, 0, 1);
  camera.lookAt(target);
  if (!shot) {
    controlsOrbit = new OrbitControls(camera, canvas);
    controlsOrbit.target.copy(target);
    controlsOrbit.update();
  }
}

const resize = () => {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
};
new ResizeObserver(resize).observe(canvas);
resize();

// ---- clicking the cockpit: the rules the app will use (src/aircraft/controlClicks.ts) --------
const SPECS = new Map(C172_CONTROLS.map((s) => [s.id, s]));
const raycaster = new Raycaster();
const ndc = new Vector2();
const clicks: { control: string; side: number; step?: number; value: number }[] = [];
const hitAt = (x: number, y: number): ControlHit | null => {
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  camera.updateMatrixWorld();
  raycaster.setFromCamera(ndc, camera);
  return ac.pickControl(raycaster);
};
/** The control the pointer holds: momentary release value, repeating knobs, dragged levers. */
let held:
  { hit: ControlHit; release?: number; repeatAt: number; drag: boolean; y: number } | undefined;
let looking: { x: number; y: number } | undefined;
const press = (hit: ControlHit) => {
  const spec = SPECS.get(hit.control)!;
  const res = pressControl(spec, panel.get(spec.id), hit);
  panel.set(spec.id, res.value);
  clicks.push({ control: hit.control, side: hit.side, step: hit.step, value: panel.get(spec.id) });
  return res;
};
canvas.addEventListener('pointerdown', (e) => {
  if (!inCockpit) return;
  const hit = hitAt(e.clientX, e.clientY);
  canvas.setPointerCapture(e.pointerId);
  if (!hit) {
    looking = { x: e.clientX, y: e.clientY };
    return;
  }
  const spec = SPECS.get(hit.control)!;
  if (isDragged(spec)) {
    // Levers move with the drag; a tap without moving steps them (see pointerup).
    held = { hit, repeatAt: Infinity, drag: true, y: e.clientY };
    return;
  }
  const res = press(hit);
  held = {
    hit,
    release: res.release,
    repeatAt: spec.kind === 'knob' ? performance.now() / 1000 + REPEAT.delay : Infinity,
    drag: false,
    y: e.clientY,
  };
});
let dragged = 0;
canvas.addEventListener('pointermove', (e) => {
  if (looking && view === 'cockpit') {
    // As the app: 0.0045 rad per pixel.
    look.yaw -= (e.clientX - looking.x) * 0.0045;
    look.pitch += (e.clientY - looking.y) * 0.0045;
    looking = { x: e.clientX, y: e.clientY };
    applyLook();
    return;
  }
  if (held?.drag) {
    const spec = SPECS.get(held.hit.control)!;
    const dy = e.clientY - held.y;
    dragged += Math.abs(dy);
    panel.set(spec.id, dragControl(spec, panel.get(spec.id), dy, canvas.clientHeight));
    held.y = e.clientY;
    return;
  }
  const hover = hitAt(e.clientX, e.clientY);
  canvas.style.cursor = hover ? 'pointer' : looking ? 'grabbing' : 'default';
});
const release = () => {
  if (held) {
    const spec = SPECS.get(held.hit.control)!;
    if (held.drag && dragged < 4) press(held.hit);
    if (held.release !== undefined) panel.set(spec.id, held.release);
  }
  held = undefined;
  looking = undefined;
  dragged = 0;
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener(
  'wheel',
  (e) => {
    if (!inCockpit) return;
    e.preventDefault();
    const hit = hitAt(e.clientX, e.clientY);
    if (hit) {
      const spec = SPECS.get(hit.control)!;
      panel.set(spec.id, wheelControl(spec, panel.get(spec.id), -Math.sign(e.deltaY), hit));
    } else if (view === 'cockpit') {
      // Nothing under the pointer: zoom, as the app could offer for the far corners.
      camera.fov = Math.min(75, Math.max(25, camera.fov * Math.exp(e.deltaY * 0.001)));
      camera.updateProjectionMatrix();
    }
  },
  { passive: false },
);
const repeatHeld = () => {
  if (!held || held.repeatAt === Infinity) return;
  const now = performance.now() / 1000;
  if (now >= held.repeatAt) {
    press(held.hit);
    held.repeatAt = now + REPEAT.interval;
  }
};

// ---- the fake's switches -------------------------------------------------------------------
const box = document.getElementById('fake')!;
const addCheck = (key: keyof typeof ui, label: string) => {
  const l = document.createElement('label');
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = ui[key] as boolean;
  i.onchange = () => ((ui as Record<string, unknown>)[key] = i.checked);
  l.append(i, ` ${label}`);
  box.append(l);
};
const addSlider = (
  key: keyof typeof ui,
  label: string,
  min: number,
  max: number,
  stepSize: number,
) => {
  const l = document.createElement('label');
  const i = document.createElement('input');
  i.type = 'range';
  i.min = String(min);
  i.max = String(max);
  i.step = String(stepSize);
  i.value = String(ui[key]);
  i.oninput = () => ((ui as Record<string, unknown>)[key] = Number(i.value));
  l.append(`${label} `, i);
  box.append(l);
};
if (!shot) {
  addCheck('systems', 'fake systems');
  addCheck('instruments', 'fake instruments');
  addCheck('avionics', 'fake avionics');
  addCheck('vacuumFail', 'vacuum failed');
  addCheck('altFail', 'alternator failed');
  addCheck('nav1', 'NAV 1 signal');
  addCheck('ils', 'NAV 1 is an ILS');
  addSlider('dev1', 'NAV 1 dev', -1, 1, 0.05);
  addSlider('gs1', 'GS', -1, 1, 0.05);
  addCheck('nav2', 'NAV 2 signal');
  addSlider('dev2', 'NAV 2 dev', -1, 1, 0.05);
  addSlider('dme', 'DME NM', 0, 120, 0.1);
  addCheck('adf', 'ADF signal');
  addSlider('adfBearing', 'ADF rel brg', 0, 359, 1);
  addSlider('fuelL', 'fuel L gal', 0, 26.5, 0.5);
  addSlider('fuelR', 'fuel R gal', 0, 26.5, 0.5);
  const sel = document.createElement('select');
  for (const id of ['', ...C172_CONTROLS.map((c) => c.id)])
    sel.add(new Option(id || '(no highlight)', id));
  sel.value = ui.highlight;
  sel.onchange = () => ac.highlightControl(sel.value || null);
  box.append(sel);
} else box.style.display = 'none';
ac.highlightControl(ui.highlight || null);

// ---- loop ------------------------------------------------------------------------------------
// Deterministic time: fixed steps, so screenshots repeat.
const DT = 1 / 60;
const startHeading = telemetry.headingDeg;
const step = () => {
  telemetry.time += DT;
  telemetry.headingDeg = (((startHeading + st.turnRate * telemetry.time) % 360) + 360) % 360;
  telemetry.trackDeg = telemetry.headingDeg;
  fakeStep(DT);
  ac.update(DT, telemetry, controls, panel);
};
// Let the instrument lags settle.
for (let i = 0; i < 360; i++) step();
if (shot) {
  // Freeze on a frame where beacon and strobes flash, so the lights can be judged.
  telemetry.time = 24.02;
  ac.update(0, telemetry, controls, panel);
}
demoWindow.__demo = {
  ready: false,
  backend,
  telemetry,
  ac,
  renderer,
  scene,
  camera,
  panel,
  clicks,
  ui,
  look,
  applyLook,
  /** Points the eye at a control's hit box and returns its screen position (CSS pixels). */
  aim(id: string, offset = 0) {
    const boxes = (
      ac as unknown as {
        hitBoxes: { control: string; center: number[]; half: number[]; step?: number }[];
      }
    ).hitBoxes;
    const b =
      boxes.find((h) => h.control === id && h.step === undefined) ??
      boxes.find((h) => h.control === id);
    if (!b) return null;
    const p = new Vector3(b.center[0], b.center[1], b.center[2]);
    aimAt(p);
    ac.object.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    const s = ac.object
      .localToWorld(p.clone().add(new Vector3(-offset * b.half[0]!, 0, 0)))
      .project(camera);
    const r = canvas.getBoundingClientRect();
    return {
      x: r.left + ((s.x + 1) / 2) * r.width,
      y: r.top + ((1 - s.y) / 2) * r.height,
      look: { ...look },
    };
  },
} as typeof demoWindow.__demo;
const info = document.getElementById('info')!;
info.textContent = `${backend} · state ${stateName} · view ${view} · ${quality}`;
let frames = 0;
renderer.setAnimationLoop(() => {
  if (!shot) {
    repeatHeld();
    step();
  }
  controlsOrbit?.update();
  renderer.render(scene, camera);
  if (++frames === 5) demoWindow.__demo!.ready = true;
});
