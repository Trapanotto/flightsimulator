// Demo of the aircraft package: one Cessna 172S on a ground plane, fed with fake telemetry.
// Served by Vite at /flightsimulator/demo/aircraft.html.
//   ?view=front-left|side|top|rear|front|cockpit|panel|tail|orbit   camera
//   ?state=parked|cruise|climb-turn|landing                         fake telemetry
//   ?webgl=1        force the WebGL 2 fallback      ?device=mobile   low quality
//   ?night=1        dark scene to judge the lights   ?shot=1          fixed frame, no text
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
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadAircraftVisual } from '@aircraft';
import type { ControlInput, Telemetry } from '@sim';

declare global {
  interface Window {
    __demo?: { ready: boolean; backend: string; telemetry: Telemetry; ac?: unknown };
  }
}

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

const ac = await loadAircraftVisual('c172', {
  quality: q.get('device') === 'mobile' ? 'low' : 'high',
  landingLightSpot: night,
});
scene.add(ac.object);
const wheelY = Math.min(...ac.wheelContacts.map((w) => w.y));
ac.object.position.y = -wheelY + st.height;
// Model frame: nose up = negative about +x, right bank = positive about +z (forward). The
// heading is left out so the cameras keep their framing.
ac.object.rotation.set(-telemetry.pitch, 0, telemetry.bank, 'YXZ');
ac.setLights('auto');

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
};
let controlsOrbit: OrbitControls | undefined;
if (view === 'cockpit' || view === 'panel') {
  ac.setCockpitView(true);
  ac.object.add(camera);
  const e = ac.view.eye;
  camera.position.set(e.x, e.y, e.z);
  ac.object.updateMatrixWorld(true);
  // The pilot's head banks with the aircraft.
  camera.up.set(0, 1, 0).applyQuaternion(ac.object.quaternion);
  // lookAt takes world coordinates; the camera rides in the (banked) aircraft.
  if (view === 'cockpit') {
    camera.fov = 70;
    camera.lookAt(ac.object.localToWorld(new Vector3(e.x - 0.03, e.y - 0.17, e.z + 1)));
  } else {
    camera.fov = 28;
    camera.lookAt(ac.object.localToWorld(new Vector3(e.x - 0.03, e.y - 0.62, e.z + 0.98)));
  }
} else {
  const p = cams[view] ?? cams['front-left']!;
  camera.position.set(p[0], ac.object.position.y + p[1], p[2]);
  if (view === 'side') camera.fov = 30;
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

// Deterministic time: fixed steps, so screenshots repeat.
const DT = 1 / 60;
const startHeading = telemetry.headingDeg;
const step = () => {
  telemetry.time += DT;
  telemetry.headingDeg = (((startHeading + st.turnRate * telemetry.time) % 360) + 360) % 360;
  ac.update(DT, telemetry, controls);
};
// Let the instrument lags settle.
for (let i = 0; i < 360; i++) step();
if (shot) {
  // Freeze on a frame where beacon and strobes flash, so the lights can be judged.
  telemetry.time = 24.02;
  ac.update(0, telemetry, controls);
}
window.__demo = { ready: false, backend, telemetry, ac } as typeof window.__demo;
const info = document.getElementById('info')!;
info.textContent = `${backend} · state ${stateName} · view ${view}`;
let frames = 0;
renderer.setAnimationLoop(() => {
  if (!shot) step();
  controlsOrbit?.update();
  renderer.render(scene, camera);
  if (++frames === 5) window.__demo!.ready = true;
});
