/**
 * Stand-alone page for the building layer: the app's renderer set-up (WebGPU, reversed depth,
 * no MSAA, sky post chain with haze from depth, shadows), the real World with its terrain and
 * the real Sky. Served by Vite at /flightsimulator/demo/buildings.html.
 *
 * URL switches:
 *   ?view=bern|belp|zurich|emmental|grindelwald|street|fly|far   camera preset (default bern)
 *   ?agl=500            camera height above the ground, metres (default from the view)
 *   ?at=8.53,47.37      camera lon,lat (default from the view)
 *   ?look=8.54,47.37,420  looks at lon,lat,metres above sea level (default from the view)
 *   ?fov=20             vertical field of view, degrees (a telephoto look at far tiles)
 *   ?hour=14            local (Swiss) time of day, hours (default 10.5)
 *   ?season=winter      season (default from the date: summer); winter also moves the date
 *   ?night=0..1         override the night factor (default from the sun)
 *   ?device=mobile      mobile presets (world and buildings)
 *   ?webgl=1            force the WebGL 2 fallback
 *   ?buildings=0        hide the building layer (frame cost without it)
 *   ?shadows=0          no shadow map
 *   ?clean=1            hide the text overlay
 *
 * window.__demo exposes stats for tools/world/buildings-shots.mjs.
 */
import {
  ACESFilmicToneMapping,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  RenderPipeline,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { pass } from 'three/tsl';
import { LocalFrame, ellipsoidToSeaLevel, seaLevelToEllipsoid } from '@geo';
import { SKY_QUALITY, Sky, WEATHER_PRESETS } from '@sky';
import { type Season, WORLD_QUALITY, World } from '@world';

interface View {
  /** Camera position: lon/lat, metres above the ground. */
  lon: number;
  lat: number;
  agl: number;
  /** Looks at this point (metres above sea level). */
  look: { lon: number; lat: number; h: number };
  /** Moves the camera along its view at this speed, m/s (horizontal). */
  speed?: number;
}

const VIEWS: Record<string, View> = {
  // The old town of Bern in the loop of the Aare, from 300 m, looking east along it.
  bern: { lon: 7.4405, lat: 46.9445, agl: 300, look: { lon: 7.4535, lat: 46.9478, h: 540 } },
  // Belp village next to the airport, from 150 m.
  belp: { lon: 7.488, lat: 46.884, agl: 150, look: { lon: 7.5, lat: 46.8915, h: 520 } },
  // Zurich: the old town on both sides of the Limmat, from 600 m.
  zurich: { lon: 8.528, lat: 47.36, agl: 600, look: { lon: 8.543, lat: 47.3715, h: 420 } },
  // A farm hamlet in the Emmental hills (near Rüegsau), from 120 m.
  emmental: { lon: 7.668, lat: 47.0045, agl: 120, look: { lon: 7.6765, lat: 47.0085, h: 680 } },
  // Grindelwald under the Eiger, from 250 m.
  grindelwald: { lon: 8.025, lat: 46.6195, agl: 250, look: { lon: 8.039, lat: 46.6245, h: 1040 } },
  // A low pass at 80 m along Kramgasse in Bern's old town.
  street: { lon: 7.4462, lat: 46.9474, agl: 80, look: { lon: 7.4545, lat: 46.9483, h: 545 } },
  // Moving at 60 m/s over Bern at 200 m: streaming under way.
  fly: {
    lon: 7.405,
    lat: 46.95,
    agl: 200,
    look: { lon: 7.5, lat: 46.95, h: 560 },
    speed: 60,
  },
  // From 1500 m over the Plateau west of Bern, looking at the city 15 km away.
  far: { lon: 7.255, lat: 46.975, agl: 1500, look: { lon: 7.44, lat: 46.95, h: 560 } },
};

type DemoStats = {
  ready: boolean;
  frames: number;
  backend: string;
  loading: boolean;
  progress: number;
  /** Seconds from the start until nothing was loading any more (-1 while loading). */
  loadedAt: number;
  buildings: Record<string, number>;
  drawCalls: number;
  triangles: number;
  frameMs: number;
  cpuMs: number;
  cpuMaxMs: number;
  hitches: Array<[number, number]>;
  bench: (n: number) => Promise<number>;
  setBuildings: (on: boolean) => void;
  adapter: string;
  sunElevation: number;
  night: number;
  exposure: number;
};

const query = new URLSearchParams(location.search);
const viewName = query.get('view') ?? 'bern';
const view = { ...(VIEWS[viewName] ?? VIEWS.bern!) };
if (query.has('agl')) view.agl = Number(query.get('agl'));
if (query.has('at'))
  [view.lon, view.lat] = query.get('at')!.split(',').map(Number) as [number, number];
if (query.has('look')) {
  const [lon, lat, h] = query.get('look')!.split(',').map(Number) as [number, number, number];
  view.look = { lon, lat, h };
}
const mobile = query.get('device') === 'mobile';
const device = mobile ? 'mobile' : 'desktop';
if (query.has('clean')) document.body.classList.add('clean');

const season = (query.get('season') ?? 'summer') as Season;
const hour = Number(query.get('hour') ?? 10.5);
// Summer: 21 June; winter: 15 January (CET, UTC+1); spring and autumn near the equinoxes.
const day = {
  summer: '2026-06-21',
  winter: '2026-01-15',
  spring: '2026-04-15',
  autumn: '2026-10-10',
}[season];
const utcOffset = season === 'winter' ? 1 : 2;
const date = new Date(`${day}T00:00:00Z`);
date.setUTCMinutes(Math.round((hour - utcOffset) * 60));
const SNOW_LINE: Record<Season, number> = { winter: 900, spring: 1800, summer: 2900, autumn: 2300 };
const nightFactor = (sunElevation: number) => {
  const t = Math.min(1, Math.max(0, (2 - sunElevation) / 8));
  return t * t * (3 - 2 * t);
};

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;

const renderer = new WebGPURenderer({
  canvas,
  antialias: false,
  powerPreference: 'high-performance',
  forceWebGL: query.has('webgl'),
  reversedDepthBuffer: true,
});
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
  ? 'WebGPU'
  : 'WebGL 2';
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
const shadows = query.get('shadows') !== '0';
renderer.shadowMap.enabled = shadows;
renderer.shadowMap.type = PCFShadowMap;

const scene = new Scene();
const quality = WORLD_QUALITY[device];
const camera = new PerspectiveCamera(55, 1, 0.1, quality.viewDistance * 1.5);
let frame = new LocalFrame(view.lon, view.lat, 0);
const sky = new Sky(date, view.lon, view.lat, SKY_QUALITY[device]);
sky.setWeather(WEATHER_PRESETS.clear);
const world = new World(frame, quality);
scene.add(sky.object, world.object);
scene.environment = sky.environment;
const anchor = new LocalFrame(view.lon, view.lat, 0);
const buildingGroup = world.object.getObjectByName('Buildings') as Object3D;
buildingGroup.visible = query.get('buildings') !== '0';

const scenePass = pass(scene, camera);
const pipeline = new RenderPipeline(renderer);
pipeline.outputNode = sky.post(
  scenePass.getTextureNode('output'),
  scenePass.getTextureNode('depth'),
  camera,
);
if (shadows) {
  const s = sky.sun.shadow;
  sky.sun.castShadow = true;
  s.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
  // Wider than the app's 32 m around the aircraft: the demo has no aircraft, and building
  // shadows should be seen somewhere in the picture.
  s.camera.left = s.camera.bottom = -150;
  s.camera.right = s.camera.top = 150;
  s.camera.near = 1;
  s.camera.far = 1500;
  s.bias = -0.0005;
  s.normalBias = 0.03;
}

// ---- camera ----
const camGeo = {
  lon: view.lon,
  lat: view.lat,
  h: seaLevelToEllipsoid(view.lon, view.lat, 600) + view.agl,
};
let seated = false;
const lookTarget = new Vector3();
const placeCamera = () => {
  frame.fromGeodetic(camGeo.lon, camGeo.lat, camGeo.h, camera.position);
  const t = view.look;
  frame.fromGeodetic(t.lon, t.lat, seaLevelToEllipsoid(t.lon, t.lat, t.h), lookTarget);
  camera.up.set(0, 1, 0);
  camera.lookAt(lookTarget);
  camera.updateMatrixWorld();
};
placeCamera();

const resize = () => {
  const w = Math.max(1, canvas.clientWidth);
  const h = Math.max(1, canvas.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = query.has('fov') ? Number(query.get('fov')) : w < h ? 70 : 55;
  camera.updateProjectionMatrix();
  const size = renderer.getDrawingBufferSize(new Vector2());
  world.setViewport(size.x, size.y);
};
new ResizeObserver(resize).observe(canvas);
resize();

function rebase() {
  frame = new LocalFrame(camGeo.lon, camGeo.lat, 0);
  world.setFrame(frame);
  sky.setLocation(camGeo.lon, camGeo.lat);
  placeCamera();
}

async function adapterName(): Promise<string> {
  const b = renderer.backend as unknown as {
    adapter?: { info?: GPUAdapterInfo };
    gl?: WebGL2RenderingContext;
  };
  if (b.adapter?.info) {
    const i = b.adapter.info;
    return [i.vendor, i.architecture, i.description].filter(Boolean).join(' ');
  }
  const gl = b.gl;
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
}

const t0 = performance.now();
const stats: DemoStats = {
  ready: false,
  frames: 0,
  backend,
  loading: true,
  progress: 0,
  loadedAt: -1,
  buildings: {},
  drawCalls: 0,
  triangles: 0,
  frameMs: 0,
  cpuMs: 0,
  cpuMaxMs: 0,
  hitches: [],
  bench,
  setBuildings: (on) => (buildingGroup.visible = on),
  adapter: await adapterName(),
  sunElevation: 0,
  night: 0,
  exposure: 1,
};
(window as unknown as { __demo: DemoStats }).__demo = stats;
// For poking around from the console or a test script.
(window as unknown as { __debug: unknown }).__debug = {
  scene,
  camera,
  world,
  getFrame: () => frame,
};

let appTime = 0;
function step(dt: number) {
  if (view.speed) {
    // Fly level along the view direction, keeping the height above the ground.
    const f = new Vector3();
    camera.getWorldDirection(f);
    f.y = 0;
    f.normalize().multiplyScalar(view.speed * dt);
    const p = camera.position.clone().add(f);
    const g = frame.toGeodetic(p);
    camGeo.lon = g.lon;
    camGeo.lat = g.lat;
    const dLon = view.look.lon - view.lon;
    const dLat = view.look.lat - view.lat;
    view.look.lon = g.lon + dLon;
    view.look.lat = g.lat + dLat;
    view.lon = g.lon;
    view.lat = g.lat;
    if (Math.hypot(camera.position.x, camera.position.z) > 3000) rebase();
  }
  const ground = world.groundHeight(camGeo.lon, camGeo.lat);
  if (ground !== undefined) {
    camGeo.h = ground + view.agl;
    seated = true;
  }
  placeCamera();
  appTime += dt;
  const night = query.has('night')
    ? Number(query.get('night'))
    : nightFactor(sky.state.sunElevation);
  world.setConditions({
    night,
    exposure: sky.state.exposure,
    season,
    snowLine: SNOW_LINE[season],
    lightDirection: sky.state.lightDirection,
    time: appTime,
    wind: { fromDeg: 250, speed: 3 },
  });
  world.update(camera);
  const origin = anchor.fromGeodetic(frame.origin.lon, frame.origin.lat, 0, new Vector3());
  sky.update(camera, {
    dt,
    altitude: ellipsoidToSeaLevel(camGeo.lon, camGeo.lat, camGeo.h),
    origin: { x: origin.x, z: origin.z },
  });
  // The shadow map covers the ground a little ahead of the camera.
  const focus = new Vector3();
  camera.getWorldDirection(focus);
  focus.multiplyScalar(Math.min(view.agl * 1.2, 400)).add(camera.position);
  const fg = frame.toGeodetic(focus);
  const fh = world.groundHeight(fg.lon, fg.lat);
  if (fh !== undefined) frame.fromGeodetic(fg.lon, fg.lat, fh, focus);
  sky.sun.target.position.copy(focus);
  sky.sun.position.copy(focus).addScaledVector(sky.state.lightDirection, 600);
  stats.night = night;
}

async function bench(n: number): Promise<number> {
  const b = renderer.backend as unknown as { device?: GPUDevice; gl?: WebGL2RenderingContext };
  const finish = async () => {
    if (b.device) await b.device.queue.onSubmittedWorkDone();
    else if (b.gl) b.gl.readPixels(0, 0, 1, 1, b.gl.RGBA, b.gl.UNSIGNED_BYTE, new Uint8Array(4));
  };
  await finish();
  const start = performance.now();
  for (let i = 0; i < n; i++) {
    step(0);
    pipeline.render();
  }
  await finish();
  return (performance.now() - start) / n;
}

let last = performance.now();
let frameAcc = 0;
let cpuAcc = 0;
let samples = 0;
renderer.setAnimationLoop((now: number) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const c0 = performance.now();
  step(dt);
  pipeline.render();
  const cpu = performance.now() - c0;

  stats.frames++;
  if (stats.frames > 5 && seated) stats.ready = true;
  frameAcc += dt * 1000;
  cpuAcc += cpu;
  samples++;
  if (stats.frames > 30) stats.cpuMaxMs = Math.max(stats.cpuMaxMs, cpu);
  if (cpu > 12 && stats.hitches.length < 40)
    stats.hitches.push([stats.frames, Math.round(cpu * 10) / 10]);
  if (samples >= 30) {
    stats.frameMs = frameAcc / samples;
    stats.cpuMs = cpuAcc / samples;
    frameAcc = cpuAcc = samples = 0;
  }
  stats.loading = world.loading;
  stats.progress = world.progress;
  if (!stats.loading && stats.loadedAt < 0 && seated)
    stats.loadedAt = (performance.now() - t0) / 1000;
  if (stats.loading) stats.loadedAt = -1;
  const bs = (buildingGroup.userData.stats as () => Record<string, number>)();
  stats.buildings = bs;
  stats.drawCalls = renderer.info.render.drawCalls;
  stats.triangles = renderer.info.render.triangles;
  stats.sunElevation = sky.state.sunElevation;
  stats.exposure = sky.state.exposure;
  if (stats.frames % 10 === 0)
    hud.textContent =
      `${backend}  ${device}  view ${viewName}  ${hour} h ${season}  night ${stats.night.toFixed(2)}\n` +
      `buildings ${bs.buildings}  3D cells ${bs.cells}  footprint tiles ${bs.footprintTiles}\n` +
      `building triangles ${(bs.triangles! / 1e6).toFixed(2)} M  gpu ~${(bs.gpuBytes! / 2 ** 20).toFixed(0)} MB\n` +
      `queue ${bs.queued}  in flight ${bs.inFlight}  uploads ${bs.pendingUploads}  downloaded ${(bs.downloaded! / 2 ** 20).toFixed(1)} MB\n` +
      `${stats.loading ? 'loading' : 'done'}  draw calls ${stats.drawCalls}  triangles ${(stats.triangles / 1e6).toFixed(2)} M\n` +
      `frame ${stats.frameMs.toFixed(1)} ms  cpu ${stats.cpuMs.toFixed(1)} ms`;
});
