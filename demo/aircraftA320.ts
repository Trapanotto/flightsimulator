// The A320 in the aircraft demo (demo/aircraft.html?type=a320): its own scene sized for a
// 37 m aircraft, fake telemetry for its engines, high lift, gear and the flight guidance that
// is being built elsewhere (the `avionics.a320` block, see src/aircraft/a320Format.ts), and the
// same click rules as the other types.
//   ?state=parked|ramp|takeoff|climb|cruise|approach|landing|rollout
//   ?view=front-left|side|front|top|rear|rear-left|tail|low|nose|engine|wing|gear|far|distant|
//         cockpit|panel|overhead|pedestal|glareshield
//   ?orbit=az,el,dist ?cam=x,y,z&target=x,y,z ?aim=<node> ?look=yaw,pitch ?fov=
//   ?gear=0..1 ?flaps=0..1 ?sb=0..1 ?rev=1 ?night=1 ?shot=1 ?webgl=1 ?quality=low ?noshadow=1
//   ?page=0..9 (SD page) ?nd=0..4 (ND mode) ?highlight=<control>
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
  pressControl,
  wheelControl,
} from '@aircraft';
import {
  A320_CONTROLS,
  type AvionicsTelemetry,
  CockpitPanel,
  type ControlInput,
  type EngineTelemetry,
  type Telemetry,
  type Waypoint,
} from '@sim';
import { loadA320 } from '../src/aircraft/A320Visual';

const demoWindow = window as unknown as { __demo?: Record<string, unknown> };
const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'front-left';
const stateName = q.get('state') ?? 'climb';
const night = q.has('night');
const shot = q.has('shot');
if (shot) document.body.classList.add('shot');
const KT = 0.514444;
const FT = 0.3048;
const DEG = Math.PI / 180;

interface A320State {
  telemetry: Partial<Telemetry>;
  controls: Partial<ControlInput>;
  /** Cockpit switches beyond a reset with the engines running (or cold and dark). */
  panel: Record<string, number>;
  running: boolean;
  /** The flight guidance's FMA and engagement. */
  fma: string[][];
  athr: 'off' | 'armed' | 'active';
  ap: [boolean, boolean];
  turnRate: number;
  height: number;
  ils: boolean;
  /** The ND shows the approach (ROSE ILS) and the SD page. */
  apu: boolean;
}

const COLD = { battery: 0, battery2: 0, adirs: 0 };
const STATES: Record<string, A320State> = {
  parked: {
    telemetry: { onGround: true, gear: 1, flaps: 0, fuel: 6400, headingDeg: 140, agl: 0 },
    controls: { throttle: [0, 0], parkingBrake: true, condition: [0, 0] },
    panel: { ...COLD },
    running: false,
    fma: [[], [], [], [], []],
    athr: 'off',
    ap: [false, false],
    turnRate: 0,
    height: 0,
    ils: false,
    apu: false,
  },
  ramp: {
    telemetry: { onGround: true, gear: 1, flaps: 0, fuel: 6400, headingDeg: 140, agl: 0 },
    controls: { throttle: [0, 0], parkingBrake: true, condition: [0, 0] },
    panel: {
      battery: 1,
      battery2: 1,
      adirs: 1,
      apuMaster: 1,
      apuBleed: 1,
      externalPower: 0,
      lightBeacon: 1,
      lightNav: 1,
      seatBelts: 2,
      ecamPage: 6,
      fuelPumpsLeft: 1,
      fuelPumpsRight: 1,
      fuelPumpsCenter: 1,
      fcuAltitude: 5000,
    },
    running: false,
    fma: [[], [], [], [], ['', '1 FD 2', '']],
    athr: 'off',
    ap: [false, false],
    turnRate: 0,
    height: 0,
    ils: false,
    apu: true,
  },
  takeoff: {
    telemetry: {
      onGround: true,
      gear: 1,
      flaps: 0.25,
      ias: 128 * KT,
      groundSpeed: 130 * KT,
      headingDeg: 137,
      fuel: 6200,
      agl: 0,
      elevator: 0.25,
    },
    controls: { throttle: [1, 1], flaps: 0.25, pitch: 0.25, condition: [1, 1] },
    panel: {
      lightLanding: 1,
      lightNose: 2,
      lightRunwayTurnoff: 1,
      lightStrobe: 2,
      spoilersArmed: 1,
      autobrake: 3,
      fcuAltitude: 5000,
      fcuSpeed: 150,
    },
    running: true,
    fma: [['MAN', 'TOGA'], ['SRS', 'CLB'], ['RWY', 'NAV'], [], ['', '1 FD 2', 'A/THR']],
    athr: 'armed',
    ap: [false, false],
    turnRate: 0,
    height: 0,
    ils: false,
    apu: false,
  },
  climb: {
    telemetry: {
      onGround: false,
      gear: 0,
      flaps: 0,
      ias: 250 * KT,
      groundSpeed: 268 * KT,
      altitude: 6200 * FT,
      verticalSpeed: (2200 * FT) / 60,
      pitch: 10 * DEG,
      bank: 18 * DEG,
      headingDeg: 20,
      fuel: 5900,
      agl: 4800 * FT,
      elevator: 0.08,
      aileron: 0.18,
      rudder: 0.03,
    },
    controls: {
      throttle: [0.62, 0.62],
      pitch: 0.08,
      roll: 0.18,
      gearDown: false,
      condition: [1, 1],
    },
    panel: {
      fcuAltitude: 15000,
      lightLanding: 0,
      lightNose: 0,
      lightRunwayTurnoff: 0,
      lightStrobe: 1,
      ndMode: 3,
      ndRange: 2,
    },
    running: true,
    fma: [['THR CLB'], ['CLB', 'ALT'], ['NAV'], [], ['AP1', '1 FD 2', 'A/THR']],
    athr: 'active',
    ap: [true, false],
    turnRate: 2,
    height: 9,
    ils: false,
    apu: false,
  },
  cruise: {
    telemetry: {
      onGround: false,
      gear: 0,
      flaps: 0,
      ias: 275 * KT,
      groundSpeed: 470 * KT,
      tas: 455 * KT,
      altitude: 35000 * FT,
      pitch: 2.5 * DEG,
      headingDeg: 64,
      fuel: 4800,
      agl: 33000 * FT,
      mach: 0.78,
      elevator: 0.03,
    },
    controls: { throttle: [0.62, 0.62], gearDown: false, condition: [1, 1] },
    panel: {
      fcuAltitude: 35000,
      fcuSpeed: 78,
      lightStrobe: 1,
      lightLanding: 0,
      lightNose: 0,
      ndMode: 3,
      ndRange: 4,
      baroStd: 0,
    },
    running: true,
    fma: [['MACH'], ['ALT CRZ'], ['NAV'], [], ['AP1', '1 FD 2', 'A/THR']],
    athr: 'active',
    ap: [true, false],
    turnRate: 0,
    height: 9,
    ils: false,
    apu: false,
  },
  approach: {
    telemetry: {
      onGround: false,
      gear: 1,
      flaps: 0.75,
      ias: 142 * KT,
      groundSpeed: 135 * KT,
      altitude: 2400 * FT,
      verticalSpeed: (-720 * FT) / 60,
      pitch: 2.2 * DEG,
      bank: -2 * DEG,
      headingDeg: 137,
      fuel: 3200,
      agl: 1050 * FT,
      elevator: 0.12,
      aileron: -0.05,
    },
    controls: { throttle: [0.62, 0.62], flaps: 0.75, gearDown: true, condition: [1, 1] },
    panel: {
      fcuAltitude: 5000,
      fcuSpeedManaged: 1,
      ls: 1,
      ndMode: 0,
      ndRange: 0,
      lightLanding: 1,
      lightNose: 1,
      lightRunwayTurnoff: 1,
      spoilersArmed: 1,
      autobrake: 2,
      nav1Active: 108_300,
      obs1: 137,
      ecamPage: 7,
    },
    running: true,
    fma: [['SPEED'], ['G/S'], ['LOC'], ['CAT 3', 'DUAL', 'DH 100'], ['AP1+2', '1 FD 2', 'A/THR']],
    athr: 'active',
    ap: [true, true],
    turnRate: 0,
    height: 9,
    ils: true,
    apu: false,
  },
  landing: {
    telemetry: {
      onGround: false,
      gear: 1,
      flaps: 1,
      ias: 133 * KT,
      groundSpeed: 128 * KT,
      altitude: 1450 * FT,
      verticalSpeed: (-260 * FT) / 60,
      pitch: 4.5 * DEG,
      headingDeg: 137,
      fuel: 3000,
      agl: 28 * FT,
      elevator: 0.3,
    },
    controls: { throttle: [0, 0], flaps: 1, gearDown: true, pitch: 0.3, condition: [1, 1] },
    panel: {
      fcuAltitude: 5000,
      ls: 1,
      ndMode: 0,
      ndRange: 0,
      lightLanding: 1,
      lightNose: 2,
      lightRunwayTurnoff: 1,
      spoilersArmed: 1,
      autobrake: 2,
      nav1Active: 108_300,
      obs1: 137,
    },
    running: true,
    fma: [
      ['SPEED'],
      ['FLARE'],
      ['FLARE'],
      ['CAT 3', 'DUAL', 'DH 100'],
      ['AP1+2', '1 FD 2', 'A/THR'],
    ],
    athr: 'active',
    ap: [true, true],
    turnRate: 0,
    height: 5,
    ils: true,
    apu: false,
  },
  rollout: {
    telemetry: {
      onGround: true,
      gear: 1,
      flaps: 1,
      ias: 95 * KT,
      groundSpeed: 92 * KT,
      altitude: 1416 * FT,
      headingDeg: 137,
      fuel: 2950,
      agl: 0,
      speedbrake: 1,
    },
    controls: { throttle: [0.8, 0.8], flaps: 1, reverse: true, speedbrake: 1, condition: [1, 1] },
    panel: {
      ls: 1,
      ndMode: 0,
      ndRange: 0,
      lightLanding: 1,
      lightNose: 2,
      lightRunwayTurnoff: 1,
      autobrake: 2,
      ecamPage: 7,
      nav1Active: 108_300,
      obs1: 137,
    },
    running: true,
    fma: [[], ['ROLL OUT'], ['ROLL OUT'], ['CAT 3', 'DUAL', 'DH 100'], ['AP1+2', '1 FD 2', '']],
    athr: 'off',
    ap: [true, true],
    turnRate: 0,
    height: 0,
    ils: true,
    apu: false,
  },
};
const st = STATES[stateName] ?? STATES.climb!;

const engine = (running: boolean): EngineTelemetry => ({
  running,
  rpm: 0,
  power: 0,
  fuelFlow: 0,
  n1: 0,
  n2: 0,
});
const telemetry: Telemetry = {
  time: 0,
  ias: 0,
  tas: 0,
  groundSpeed: 0,
  altitude: 1416 * FT,
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
  engines: [engine(st.running), engine(st.running)],
  fuel: 6000,
  crashed: undefined,
  speedbrake: 0,
  stabiliser: 2 * DEG,
  ...st.telemetry,
};
telemetry.tas = st.telemetry.tas ?? telemetry.ias * (1 + (telemetry.altitude / FT) * 0.00002);
telemetry.trackDeg = telemetry.headingDeg + (stateName === 'cruise' ? 4 : 0);
const controls: ControlInput = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: [0, 0],
  flaps: 0,
  gearDown: true,
  brakeLeft: 0,
  brakeRight: 0,
  parkingBrake: false,
  pitchTrim: 0,
  mixture: [1, 1],
  condition: [1, 1],
  reverse: false,
  speedbrake: 0,
  rollTrim: 0,
  yawTrim: 0,
  ...st.controls,
};

// ---- renderer and scene, sized for a 37 m aircraft ------------------------------------------
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: q.has('webgl') });
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
  ? 'WebGPU'
  : 'WebGL 2';
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = night ? 1.0 : 0.85;
renderer.shadowMap.enabled = !q.has('noshadow');
renderer.shadowMap.type = PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new Scene();
scene.background = new Color(night ? 0x070b14 : 0x9fb8d0);
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = night ? 0.03 : 0.55;
const sun = new DirectionalLight(0xfff4e6, night ? 0 : 3.2);
sun.position.set(-30, 50, 34);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -26;
sc.right = sc.top = 26;
sc.near = 1;
sc.far = 160;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
scene.add(new HemisphereLight(0xc9dcf0, 0x5a5348, night ? 0.02 : 0.6));
const ground = new Mesh(
  new PlaneGeometry(1200, 1200),
  new MeshStandardNodeMaterial({ color: night ? 0x2a2a2c : 0x8d8c86, roughness: 0.92 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const quality = q.get('device') === 'mobile' || q.get('quality') === 'low' ? 'low' : 'high';
const ac = await loadA320({ quality, landingLightSpot: night });
scene.add(ac.object);
const wheelY = Math.min(...ac.wheelContacts.map((w) => w.y));
ac.object.position.y = -wheelY + st.height;
ac.object.rotation.set(-telemetry.pitch, 0, telemetry.bank, 'YXZ');
ac.setLights('auto');
ac.setExposure(night ? 400 : 4.2);

// ---- the cockpit's controls, bound to the control input as the simulation does ------------------
const panel = new CockpitPanel(A320_CONTROLS);
panel.bind(
  'throttle1',
  () => controls.throttle[0] ?? 0,
  (v) => (controls.throttle[0] = v),
);
panel.bind(
  'throttle2',
  () => controls.throttle[1] ?? 0,
  (v) => (controls.throttle[1] = v),
);
panel.bind(
  'flaps',
  () => Math.round(controls.flaps * 4),
  (v) => (controls.flaps = v / 4),
);
panel.bind(
  'gear',
  () => (controls.gearDown ? 1 : 0),
  (v) => (controls.gearDown = v >= 0.5),
);
panel.bind(
  'speedbrake',
  () => controls.speedbrake ?? 0,
  (v) => (controls.speedbrake = v),
);
panel.bind(
  'reverse',
  () => (controls.reverse ? 1 : 0),
  (v) => (controls.reverse = v >= 0.5),
);
panel.bind(
  'trim',
  () => controls.pitchTrim,
  (v) => (controls.pitchTrim = v),
);
panel.bind(
  'rudderTrim',
  () => controls.yawTrim ?? 0,
  (v) => (controls.yawTrim = v),
);
panel.bind(
  'parkingBrake',
  () => (controls.parkingBrake ? 1 : 0),
  (v) => (controls.parkingBrake = v >= 0.5),
);
panel.bind(
  'engineMaster1',
  () => ((controls.condition?.[0] ?? 0) >= 0.5 ? 1 : 0),
  (v) => (controls.condition![0] = v),
);
panel.bind(
  'engineMaster2',
  () => ((controls.condition?.[1] ?? 0) >= 0.5 ? 1 : 0),
  (v) => (controls.condition![1] = v),
);
{
  const keep = {
    ...controls,
    throttle: [...controls.throttle],
    condition: [...(controls.condition ?? [1, 1])],
  };
  panel.reset(st.running);
  Object.assign(controls, keep);
  if (!st.running) for (const id of ['engineMaster1', 'engineMaster2']) panel.set(id, 0);
  if (st.running) {
    // What a crew has set up by now.
    for (const [id, v] of Object.entries({
      lightNav: 1,
      lightBeacon: 1,
      lightWing: 0,
      probeHeat: 0,
      fcuHeading: Math.round(telemetry.headingDeg),
      com1Active: 118_100,
      com1Standby: 120_225,
      nav1Active: 116_600,
      nav2Active: 115_000,
      xpdrCode: 1000,
      obs2: 280,
      apuMaster: 0,
    }))
      panel.set(id, v);
  }
  for (const [id, v] of Object.entries(st.panel)) panel.set(id, v);
  if (q.has('page')) panel.set('ecamPage', Number(q.get('page')));
  if (q.has('nd')) panel.set('ndMode', Number(q.get('nd')));
  if (night) panel.set('lightPanel', 0.8);
}

// ---- fakes: engines, high lift, gear, systems and the flight guidance ---------------------------
const ui = {
  gearPos: q.has('gear') ? Number(q.get('gear')) : -1,
  flapPos: q.has('flaps') ? Number(q.get('flaps')) : -1,
  sb: q.has('sb') ? Number(q.get('sb')) : -1,
  locDev: 0.06,
  gsDev: -0.12,
};
if (q.has('rev')) controls.reverse = true;
const PLAN: Waypoint[] = [
  { ident: 'LSGG', lon: 6.109, lat: 46.238 },
  { ident: 'PAS', lon: 6.66, lat: 46.42 },
  { ident: 'WIL', lon: 7.13, lat: 47.18 },
  { ident: 'TRA', lon: 8.44, lat: 47.69 },
  { ident: 'D137L', lon: 8.4, lat: 47.56 },
  { ident: 'LSZH', lon: 8.549, lat: 47.458 },
];
const fake = {
  n1: telemetry.engines.map(() => 0),
  n2: telemetry.engines.map(() => 0),
  egt: telemetry.engines.map(() => 15),
  lon: stateName === 'cruise' ? 7.0 : stateName === 'climb' ? 6.4 : 8.47,
  lat: stateName === 'cruise' ? 46.95 : stateName === 'climb' ? 46.33 : 47.53,
  apOffAt: -10,
  fma: st.fma.map((c) => [...c]),
  ap: [...st.ap] as [boolean, boolean],
  athr: st.athr,
  wasPressed: new Map<string, boolean>(),
  identUntil: -1,
};
const pressed = (id: string) => {
  const now = panel.get(id) >= 0.5;
  const was = fake.wasPressed.get(id) ?? false;
  fake.wasPressed.set(id, now);
  return now && !was;
};
const CONFIG_SPEEDS = [
  { vls: 205, vmax: 350 },
  { vls: 148, vmax: 230 },
  { vls: 138, vmax: 200 },
  { vls: 133, vmax: 185 },
  { vls: 128, vmax: 177 },
];

function fakeStep(dt: number) {
  const t = telemetry;
  const v = (id: string) => panel.get(id);
  // Engines: N1 follows the thrust levers (autothrust holds CLIMB thrust as the levers sit in CL).
  for (let i = 0; i < 2; i++) {
    const e = t.engines[i]!;
    const master = v(`engineMaster${i + 1}`) >= 0.5;
    e.running = master && st.running;
    const lever = controls.throttle[i] ?? 0;
    const rev = !!controls.reverse && t.onGround;
    const target = e.running
      ? rev
        ? 22 + 55 * lever
        : fake.athr === 'active'
          ? stateName === 'cruise'
            ? 84.5
            : stateName === 'approach'
              ? 52
              : stateName === 'landing'
                ? 30
                : 89.2
          : 19.5 + 76 * lever
      : 0;
    fake.n1[i]! += (target - fake.n1[i]!) * Math.min(1, dt * 0.8);
    fake.n2[i]! +=
      ((e.running ? 58 + 0.42 * fake.n1[i]! : 0) - fake.n2[i]!) * Math.min(1, dt * 0.8);
    fake.egt[i]! +=
      ((e.running ? 390 + 5.6 * fake.n1[i]! : 15) - fake.egt[i]!) * Math.min(1, dt * 0.5);
    e.n1 = fake.n1[i]!;
    e.n2 = fake.n2[i]!;
    e.rpm = (e.n1 / 100) * 5000;
    e.power = Math.max(0, (e.n1 - 19.5) / 76);
    e.turbineTemperature = fake.egt[i]!;
    e.fuelFlow = e.running ? (300 + 2600 * e.power ** 1.6) / 3600 : 0;
    e.reversing = e.running && rev;
  }
  // Gear, flaps and speed brake follow their levers.
  const gearT = controls.gearDown ? 1 : 0;
  t.gear =
    ui.gearPos >= 0
      ? ui.gearPos
      : t.gear + Math.sign(gearT - t.gear) * Math.min(Math.abs(gearT - t.gear), dt / 10);
  // telemetry.flaps is the share of 35 degrees; lever 1 is 1+F (10 degrees) at take-off speeds.
  const lever = Math.round(controls.flaps * 4);
  const flapT = ([0, t.ias < 210 * KT ? 10 : 0, 15, 20, 35][lever] ?? 0) / 35;
  t.flaps =
    ui.flapPos >= 0
      ? ui.flapPos
      : t.flaps + Math.sign(flapT - t.flaps) * Math.min(Math.abs(flapT - t.flaps), dt / 25);
  const sbT = controls.speedbrake ?? 0;
  t.speedbrake =
    ui.sb >= 0 ? ui.sb : (t.speedbrake ?? 0) + (sbT - (t.speedbrake ?? 0)) * Math.min(1, dt * 2);
  t.stabiliser =
    (stateName === 'takeoff' ? 4 : stateName === 'cruise' ? 1.8 : 3) * DEG +
    controls.pitchTrim * 4 * DEG;
  // Avionics power: batteries or generators.
  const powered = v('battery') >= 0.5 || t.engines.some((e) => e.running);
  // The flight guidance's buttons: AP1, AP2, A/THR toggle; the red buttons disconnect.
  if (pressed('ap1')) fake.ap[0] = !fake.ap[0];
  if (pressed('ap2')) fake.ap[1] = !fake.ap[1];
  if (pressed('apDisconnect') && (fake.ap[0] || fake.ap[1]))
    [fake.ap, fake.apOffAt] = [[false, false], t.time];
  if (pressed('athr')) fake.athr = fake.athr === 'off' ? 'active' : 'off';
  if (pressed('athrDisconnect')) fake.athr = 'off';
  if (pressed('fcuLoc')) fake.fma[2] = [fake.fma[2]![0] ?? 'HDG', 'LOC'];
  if (pressed('fcuAppr'))
    [fake.fma[1], fake.fma[2]] = [
      [fake.fma[1]![0] ?? 'ALT', 'G/S'],
      [fake.fma[2]![0] ?? 'HDG', 'LOC'],
    ];
  if (pressed('fcuExped')) fake.fma[1] = ['EXP CLB', 'ALT'];
  if (pressed('fcuVsPull'))
    fake.fma[1] = [`V/S ${v('fcuVerticalSpeed') >= 0 ? '+' : ''}${v('fcuVerticalSpeed')}`];
  if (pressed('fcuVsPush')) fake.fma[1] = ['ALT'];
  if (pressed('xpdrIdent')) fake.identUntil = t.time + 18;
  for (const axis of ['Speed', 'Heading', 'Altitude']) {
    if (pressed(`fcu${axis}Push`)) panel.set(`fcu${axis}Managed`, 1);
    if (pressed(`fcu${axis}Pull`)) panel.set(`fcu${axis}Managed`, 0);
  }
  pressed('fcuHeadingManaged');
  fake.fma[2]![0] = v('fcuHeadingManaged') >= 0.5 ? (st.fma[2]?.[0] ?? 'NAV') : 'HDG';
  const ap = fake.ap[0] && fake.ap[1] ? 'AP1+2' : fake.ap[0] ? 'AP1' : fake.ap[1] ? 'AP2' : '';
  const fd = v('flightDirector') >= 0.5 ? '1 FD 2' : '';
  fake.fma[4] = [ap, fd, fake.athr === 'off' ? '' : 'A/THR'];
  fake.fma[0] =
    fake.athr === 'active'
      ? st.fma[0]?.length
        ? st.fma[0]
        : ['SPEED']
      : fake.athr === 'armed'
        ? st.fma[0]!
        : [];
  // Position along the plan.
  fake.lon +=
    (t.groundSpeed * dt * Math.sin(t.trackDeg * DEG)) / 1852 / 60 / Math.cos(fake.lat * DEG);
  fake.lat += (t.groundSpeed * dt * Math.cos(t.trackDeg * DEG)) / 1852 / 60;
  const active = stateName === 'cruise' ? 3 : stateName === 'climb' ? 2 : 5;
  const wp = PLAN[active]!;
  const prev = PLAN[active - 1]!;
  const dE = (wp.lon - fake.lon) * 60 * Math.cos(fake.lat * DEG);
  const dN = (wp.lat - fake.lat) * 60;
  const legE = (wp.lon - prev.lon) * 60 * Math.cos(fake.lat * DEG);
  const legN = (wp.lat - prev.lat) * 60;
  const legLen = Math.hypot(legE, legN);
  const ils = st.ils;
  const conf = Math.round(controls.flaps * 4);
  const cs = CONFIG_SPEEDS[conf]!;
  const hdgErr = ((((v('fcuHeading') - t.headingDeg) % 360) + 540) % 360) - 180;
  const fdBank =
    v('fcuHeadingManaged') >= 0.5
      ? ils
        ? -ui.locDev * 10
        : t.bank / DEG
      : Math.max(-25, Math.min(25, hdgErr * 1.5));
  const fdPitch = t.pitch / DEG + (ils ? ui.gsDev * 2 : 0.4);
  const memo: string[] = [];
  if (v('seatBelts') >= 1) memo.push('SEAT BELTS', 'NO SMOKING');
  if (v('spoilersArmed') >= 0.5) memo.push('GND SPLRS ARMED');
  if (v('parkingBrake') >= 0.5 && t.onGround) memo.push('PARK BRK');
  if (st.apu) memo.push('APU AVAIL', 'APU BLEED');
  if (v('lightLanding') >= 0.5 && !t.onGround) memo.push('LDG LT');
  if (stateName === 'approach')
    memo.unshift('LDG MEMO', ' CABIN......READY', ' SPLRS........ARM', ' FLAPS.......FULL');
  const avionics: AvionicsTelemetry = {
    powered,
    com1: { active: v('com1Active'), standby: v('com1Standby') },
    com2: { active: v('com2Active'), standby: v('com2Standby') },
    nav1: {
      frequency: v('nav1Active'),
      standby: v('nav1Standby'),
      valid: powered,
      ident: ils ? 'IZH' : 'TRA',
      localizer: ils,
      course: ils ? 137 : v('obs1'),
      deviation: ils ? ui.locDev : 0.2,
      toFrom: 'to',
      bearing: ils ? 137 : 52,
      glideSlope: ils ? ui.gsDev : undefined,
    },
    nav2: {
      frequency: v('nav2Active'),
      standby: v('nav2Standby'),
      valid: powered,
      ident: 'KLO',
      localizer: false,
      course: v('obs2'),
      deviation: -0.3,
      toFrom: 'to',
      bearing: 70,
      glideSlope: undefined,
    },
    dme: {
      source: 'nav1',
      distanceNm: ils ? 4.2 : 18.5,
      groundSpeedKt: t.groundSpeed / KT,
      minutes: 4,
    },
    adf: { frequency: v('adfFrequency'), valid: false, ident: '', relativeBearing: undefined },
    transponder: {
      code: v('xpdrCode'),
      mode: (['off', 'standby', 'on', 'alt'] as const)[Math.round(v('xpdrMode'))]!,
      ident: t.time < fake.identUntil,
      reply: false,
    },
    markers: { outer: false, middle: false, inner: false },
    autopilot: {
      engaged: fake.ap[0] || fake.ap[1],
      lateral: ils ? 'apr' : 'nav',
      lateralArmed: undefined,
      vertical: ils ? 'gs' : stateName === 'cruise' ? 'alt' : 'flc',
      verticalArmed: undefined,
      selectedAltitude: v('fcuAltitude'),
      selectedVerticalSpeed: v('fcuVerticalSpeed'),
      disconnectWarning: t.time - fake.apOffAt < 2.5,
      flightDirector:
        v('flightDirector') >= 0.5 && st.running
          ? { pitch: fdPitch * DEG, bank: fdBank * DEG }
          : undefined,
      selectedSpeed:
        stateName === 'cruise'
          ? 0.78
          : stateName === 'approach'
            ? 138
            : stateName === 'landing'
              ? 133
              : 250,
      autothrottle: { engaged: fake.athr === 'active', mode: 'speed' },
    },
    gps: {
      plan: PLAN,
      active,
      distanceNm: Math.hypot(dE, dN),
      bearing: (Math.atan2(dE, dN) / DEG + 360) % 360,
      desiredTrack: (Math.atan2(legE, legN) / DEG + 360) % 360,
      crossTrackNm: legLen > 0 ? (dN * legE - dE * legN) / legLen : 0,
      groundSpeedKt: t.groundSpeed / KT,
      track: t.trackDeg,
      lon: fake.lon,
      lat: fake.lat,
    },
  };
  (avionics.autopilot as unknown as { airbus: unknown }).airbus = airbusBlock(t, v, cs, memo);
  t.avionics = powered ? avionics : { ...avionics, powered: false };
}

/** The flight guidance's block (AirbusTelemetry on main) as the fake fills it. */
const changedAt = [-100, -100, -100, -100, -100];
const lastFma: string[] = ['', '', '', '', ''];
function airbusBlock(
  t: Telemetry,
  v: (id: string) => number,
  cs: { vls: number; vmax: number },
  memo: string[],
) {
  const f = fake.fma;
  const col = (i: number, l: number) => f[i]?.[l] ?? '';
  const combined = ['LAND', 'FLARE', 'ROLL OUT'].includes(col(1, 0));
  const changed = [0, 1, 2, 3, 4].map((i) => {
    const now = col(i, 0);
    if (now !== lastFma[i]) {
      if (t.time > 11) changedAt[i] = t.time;
      lastFma[i] = now;
    }
    return t.time - changedAt[i]! < 10;
  });
  const lever = Math.round(controls.flaps * 4);
  const slats = [0, 18, 22, 22, 27][lever] ?? 0;
  const flaps = t.flaps * 35;
  const managed = v('fcuSpeedManaged') >= 0.5;
  const machTarget = stateName === 'cruise';
  const target =
    stateName === 'approach' ? 138 : stateName === 'landing' ? 133 : managed ? 250 : v('fcuSpeed');
  const NaN_ = Number.NaN;
  return {
    fma: {
      thrust: col(0, 0) + (col(0, 1) && col(0, 0) === 'MAN' ? ' ' + col(0, 1) : ''),
      thrustCaution: '',
      vertical: col(1, 0),
      verticalArmed: col(1, 1),
      lateral: combined ? col(1, 0) : col(2, 0),
      lateralArmed: col(2, 1),
      combined,
      capability: col(3, 0) && col(3, 1) ? col(3, 0) + ' ' + col(3, 1) : col(3, 0),
      minimum: col(3, 2),
      autopilot: col(4, 0),
      flightDirectors: col(4, 1),
      autothrust: fake.athr,
      changed,
    },
    speeds: {
      vls: cs.vls,
      vsw: Math.round(cs.vls * 0.8),
      vmax: cs.vmax,
      alphaProt: t.onGround ? NaN_ : Math.round(cs.vls * 0.9),
      alphaMax: t.onGround ? NaN_ : Math.round(cs.vls * 0.84),
      f: lever >= 1 && lever <= 2 && !t.onGround ? 160 : NaN_,
      s: lever === 1 && !t.onGround ? 205 : NaN_,
      greenDot: lever === 0 && !t.onGround ? 212 : NaN_,
      vapp: 138,
      v1: stateName === 'takeoff' ? 141 : NaN_,
      vr: stateName === 'takeoff' ? 145 : NaN_,
      v2: stateName === 'takeoff' ? 150 : NaN_,
      vfeNext: lever < 4 ? [230, 215, 200, 185][lever]! : NaN_,
      target: machTarget ? NaN_ : target,
      targetMach: machTarget ? 0.78 : NaN_,
      managed,
      mach: machTarget,
      trend: t.ias / KT,
      mass: 62000,
    },
    fcu: {
      speed: managed ? NaN_ : v('fcuSpeed'),
      mach: machTarget,
      heading: v('fcuHeadingManaged') >= 0.5 ? NaN_ : v('fcuHeading'),
      altitude: v('fcuAltitude'),
      verticalSpeed: /^V\/S/.test(col(1, 0)) ? v('fcuVerticalSpeed') : NaN_,
      speedDot: managed,
      headingDot: v('fcuHeadingManaged') >= 0.5,
      altitudeDot: v('fcuAltitudeManaged') >= 0.5,
      loc: /LOC/.test(col(2, 1)) || /LOC/.test(col(2, 0)),
      appr: /G\/S/.test(col(1, 1) + col(1, 0)) || combined,
      exped: /EXP/.test(col(1, 0)),
      ap1: fake.ap[0],
      ap2: fake.ap[1],
      athr: fake.athr !== 'off',
    },
    guidance: {
      altitudeTarget: v('fcuAltitude'),
      altitudeConstraint: false,
      lateralTarget: t.headingDeg,
      verticalSpeedTarget: 0,
      phase: stateName,
      callout: '',
    },
    controls: {
      law: 'normal',
      flareMode: stateName === 'landing',
      groundMode: t.onGround,
      alphaProtection: false,
      alphaFloor: false,
      highSpeedProtection: false,
      bankLimit: false,
      pitchLimit: false,
      config: ['0', t.ias < 210 * KT ? '1+F' : '1', '2', '3', 'FULL'][lever] ?? '0',
      slats,
      flaps,
      stabiliser: (t.stabiliser ?? 0) / DEG,
      rudderTrim: (controls.yawTrim ?? 0) * 20,
      spoilersArmed: v('spoilersArmed') >= 0.5,
      groundSpoilers: stateName === 'rollout',
      speedbrake: t.speedbrake ?? 0,
      autobrake: (['off', 'low', 'medium', 'max'] as const)[Math.round(v('autobrake'))],
      autobrakeArmed: v('autobrake') >= 1,
      autobrakeDecel: stateName === 'rollout',
      steering: 0,
    },
    systems: {
      apu: {
        master: v('apuMaster') >= 0.5,
        n: st.apu ? 100 : 0,
        egt: st.apu ? 410 : 15,
        available: st.apu,
        bleed: st.apu && v('apuBleed') >= 0.5,
        generator: st.apu,
      },
      bleed: [st.running ? 42 : st.apu ? 38 : 0, st.running ? 42 : st.apu ? 38 : 0],
      start: { valve: [false, false], ignition: [false, false], phase: ['', ''] },
      adirs: { aligned: v('adirs') >= 1, remaining: 0 },
      electrical: {
        ac1: st.running,
        ac2: st.running,
        acEss: true,
        dcEss: true,
        dcBat: true,
        source: st.running ? ['gen1', 'gen2'] : st.apu ? ['apu', 'apu'] : ['none', 'none'],
        batteryVolts: [28.2, 28.1],
      },
      hydraulics: {
        green: st.running ? 3000 : 0,
        blue: st.running ? 3000 : 0,
        yellow: st.running ? 3000 : 0,
        ptu: false,
        rat: false,
      },
      fuel: {
        tanks: [t.fuel * 0.42, t.fuel * 0.16, t.fuel * 0.42],
        pumps: { left: true, centre: true, right: true },
        crossfeed: v('fuelCrossfeed') >= 0.5,
        used: 6400 - t.fuel,
      },
      air: {
        packs: [v('pack1') >= 0.5, v('pack2') >= 0.5],
        cabinAltitude: Math.min(8000, (t.altitude / FT) * 0.22),
        cabinRate: (t.verticalSpeed / FT) * 60 * 0.2,
        differential: Math.min(8.1, t.altitude / FT / 4400),
      },
      antiIce: { wing: false, engine: [false, false] },
      brakes: { pressure: 0, antiSkid: true, parking: v('parkingBrake') >= 0.5 },
      grossMass: 52000 + t.fuel,
    },
    ecam: { warnings: [], memo, masterWarning: false, masterCaution: false },
  };
}
// ---- camera ------------------------------------------------------------------------------------
const camera = new PerspectiveCamera(40, 1, 0.05, 4000);
const target = new Vector3(0, ac.object.position.y - 0.4, 0);
const vec = (s: string | null) => {
  const v = s?.split(',').map(Number);
  return v && v.length === 3 && v.every(Number.isFinite)
    ? new Vector3(v[0], v[1], v[2])
    : undefined;
};
const cams: Record<
  string,
  { cam: [number, number, number]; target?: [number, number, number]; fov?: number }
> = {
  'front-left': { cam: [26, 6, 34] },
  side: { cam: [90, 1.5, 0], fov: 30 },
  front: { cam: [0, 2.5, 80], fov: 32 },
  top: { cam: [0.01, 90, 0], fov: 32 },
  rear: { cam: [0, 4, -80], fov: 32 },
  'rear-left': { cam: [-26, 8, -36] },
  'rear-right': { cam: [26, 8, -36] },
  'front-right': { cam: [-26, 6, 34] },
  tail: { cam: [-15, 6, -30], target: [0, 4.5, -18] },
  low: { cam: [14, -2.6, 14], target: [0, -1.5, 0] },
  nose: { cam: [4.5, 0.6, 21], target: [0, 1.2, 14] },
  engine: { cam: [10.5, -1.2, 10.5], target: [5.75, -1.5, 3.5] },
  wing: { cam: [14, 4.5, -10], target: [8, 0, 0] },
  gear: { cam: [-1.5, -2.3, 7], target: [3.8, -2.6, -1.2] },
  far: { cam: [120, 20, 160], fov: 12 },
  distant: { cam: [400, 70, 520], fov: 4 },
};
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
const aimAt = (p: { x: number; y: number; z: number }) => {
  const e = ac.view.eye;
  look.yaw = Math.atan2(p.x - e.x, p.z - e.z);
  look.pitch = Math.atan2(p.y - e.y, Math.hypot(p.x - e.x, p.z - e.z)) / 0.8;
  applyLook();
};
const COCKPIT_VIEWS: Record<string, { look: [number, number]; fov: number }> = {
  cockpit: { look: [0, -0.28], fov: 60 },
  panel: { look: [-0.12, -0.5], fov: 50 },
  overhead: { look: [-0.45, 1.3], fov: 70 },
  pedestal: { look: [-0.62, -1.2], fov: 58 },
  glareshield: { look: [-0.1, -0.3], fov: 45 },
};
const inCockpit = view in COCKPIT_VIEWS;
let controlsOrbit: OrbitControls | undefined;
if (inCockpit) {
  ac.setCockpitView(true);
  ac.object.add(camera);
  const e = ac.view.eye;
  camera.position.set(e.x, e.y, e.z);
  const cv = COCKPIT_VIEWS[view]!;
  if (!lookArg) [look.yaw, look.pitch] = cv.look;
  camera.fov = Number(q.get('fov') ?? cv.fov);
  applyLook();
  const aimNode = q.get('aim') ? ac.object.getObjectByName(q.get('aim')!) : undefined;
  if (aimNode) {
    ac.object.updateMatrixWorld(true);
    aimAt(ac.object.worldToLocal(aimNode.getWorldPosition(new Vector3())));
    camera.fov = Number(q.get('fov') ?? 30);
  }
} else {
  const c = cams[view] ?? cams['front-left']!;
  camera.position.set(c.cam[0], ac.object.position.y + c.cam[1], c.cam[2]);
  if (c.target) target.set(c.target[0], ac.object.position.y + c.target[1], c.target[2]);
  if (c.fov) camera.fov = c.fov;
  const orbit = q.get('orbit')?.split(',').map(Number);
  if (orbit && orbit.length === 3) {
    const [az, el, dist] = orbit.map((v, i) => (i < 2 ? v * DEG : v)) as [number, number, number];
    camera.position
      .set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
      .multiplyScalar(dist)
      .add(target);
  }
  const camArg = vec(q.get('cam'));
  const targetArg = vec(q.get('target'));
  if (camArg) camera.position.copy(camArg).add(ac.object.position);
  if (targetArg) target.copy(targetArg).add(ac.object.position);
  if (q.has('fov')) camera.fov = Number(q.get('fov'));
  if (view === 'top') camera.up.set(0, 0, 1);
  camera.lookAt(target);
  if (!shot) {
    controlsOrbit = new OrbitControls(camera, canvas);
    controlsOrbit.target.copy(target);
    controlsOrbit.update();
  }
}
const resize = () => {
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
};
new ResizeObserver(resize).observe(canvas);
resize();

// ---- clicking the cockpit (src/aircraft/controlClicks.ts) -------------------------------------
const SPECS = new Map(A320_CONTROLS.map((s) => [s.id, s]));
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
let held:
  { hit: ControlHit; release?: number; repeatAt: number; drag: boolean; y: number } | undefined;
let looking: { x: number; y: number } | undefined;
let dragged = 0;
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
canvas.addEventListener('pointermove', (e) => {
  if (looking) {
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
  canvas.style.cursor = inCockpit && hitAt(e.clientX, e.clientY) ? 'pointer' : 'default';
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
    } else {
      camera.fov = Math.min(75, Math.max(20, camera.fov * Math.exp(e.deltaY * 0.001)));
      camera.updateProjectionMatrix();
    }
  },
  { passive: false },
);
const box = document.getElementById('fake')!;
if (shot) box.style.display = 'none';
else {
  const sel = document.createElement('select');
  for (const id of ['', ...A320_CONTROLS.map((c) => c.id)])
    sel.add(new Option(id || '(no highlight)', id));
  sel.onchange = () => ac.highlightControl(sel.value || null);
  box.append(sel);
  for (const [key, label] of [
    ['gearPos', 'gear (-1 = lever)'],
    ['flapPos', 'flaps (-1 = lever)'],
    ['sb', 'speed brake (-1 = lever)'],
    ['locDev', 'LOC dev'],
    ['gsDev', 'G/S dev'],
  ] as const) {
    const l = document.createElement('label');
    const i = document.createElement('input');
    i.type = 'range';
    i.min = '-1';
    i.max = '1';
    i.step = '0.01';
    i.value = String(ui[key]);
    i.oninput = () => (ui[key] = Number(i.value));
    l.append(`${label} `, i);
    box.append(l);
  }
}
ac.highlightControl(q.get('highlight'));

// ---- loop --------------------------------------------------------------------------------------
const DT = 1 / 60;
const startHeading = telemetry.headingDeg;
const step = () => {
  telemetry.time += DT;
  telemetry.headingDeg = (((startHeading + st.turnRate * telemetry.time) % 360) + 360) % 360;
  telemetry.trackDeg = telemetry.headingDeg + (stateName === 'cruise' ? 4 : 0);
  fakeStep(DT);
  ac.update(DT, telemetry, controls, panel);
};
for (let i = 0; i < 600; i++) step();
if (shot) {
  telemetry.time = 24.02;
  ac.update(0, telemetry, controls, panel);
}
const handles = demoWindow;
handles.__demo = {
  ready: false,
  backend,
  telemetry,
  ac,
  renderer,
  scene,
  camera,
  panel,
  clicks,
  look,
  applyLook,
  /** Advances the fakes by n frames (the click test lets the displays catch up). */
  advance(n = 30) {
    for (let i = 0; i < n; i++) step();
  },
  stats() {
    const r = renderer.info.render as { drawCalls?: number; calls: number; triangles: number };
    const a = ac as unknown as { textureBytes?: number; canvasBytes?: number };
    return {
      drawCalls: r.drawCalls ?? r.calls,
      triangles: r.triangles,
      textureMB: Math.round(((a.textureBytes ?? 0) / 1048576) * 10) / 10,
      canvasMB: Math.round(((a.canvasBytes ?? 0) / 1048576) * 10) / 10,
    };
  },
  /** Points the eye at a hit box (offset: share of its half width to the left) and returns its screen position. */
  aim(id: string, offset = 0, suffixStep?: number) {
    const boxes = (
      ac as unknown as {
        hitBoxes: { control: string; center: number[]; half: number[]; step?: number }[];
      }
    ).hitBoxes;
    const b =
      (suffixStep !== undefined
        ? boxes.find((h) => h.control === id && h.step === suffixStep)
        : undefined) ??
      boxes.find((h) => h.control === id && h.step === undefined) ??
      boxes.find((h) => h.control === id);
    if (!b) return null;
    const p = new Vector3(b.center[0], b.center[1], b.center[2]);
    aimAt(p);
    ac.object.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    const s = ac.object
      .localToWorld(p.clone().add(new Vector3(offset * b.half[0]!, 0, 0)))
      .project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((s.x + 1) / 2) * r.width, y: r.top + ((1 - s.y) / 2) * r.height };
  },
};
document.getElementById('info')!.textContent =
  `a320 · ${backend} · state ${stateName} · view ${view} · ${quality}`;
let frames = 0;
renderer.setAnimationLoop(() => {
  if (held && held.repeatAt !== Infinity && performance.now() / 1000 >= held.repeatAt) {
    press(held.hit);
    held.repeatAt = performance.now() / 1000 + REPEAT.interval;
  }
  if (!shot) step();
  controlsOrbit?.update();
  renderer.render(scene, camera);
  if (++frames === 5) handles.__demo!.ready = true;
});
