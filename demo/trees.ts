/**
 * Test bench of the tree layer: the real World (terrain and its layers) under the real Sky with
 * its post chain, wired like src/app/App.ts. Served at /flightsimulator/demo/trees.html.
 *
 * URL switches:
 *   view=belpberg|edge|kandersteg|treeline|high|top|fly   camera preset (default belpberg)
 *   season=spring|summer|autumn|winter                  (default summer; also sets the date)
 *   night=1                                             late evening instead of afternoon
 *   t=2026-06-21T14:00Z                                 explicit time (UTC)
 *   device=mobile   webgl=1   trees=0 (hide the trees)   clean=1 (no text)
 *   speed=60        metres per second for view=fly
 *
 * window.__demo exposes stats and a bench for tools/world/trees-shots.mjs.
 */
import {
  ACESFilmicToneMapping,
  type Object3D,
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
  lon: number;
  lat: number;
  /** Metres above ground (agl) or above sea level. */
  h: number;
  agl: boolean;
  /** Degrees from north, clockwise; degrees above the horizon. */
  heading: number;
  pitch: number;
}

const VIEWS: Record<string, View> = {
  // Low over the wooded Belpberg south of Bern, looking east along the hill.
  belpberg: { lon: 7.508, lat: 46.872, h: 110, agl: true, heading: 95, pitch: -10 },
  // 30 m above a field at the forest edge of the Belpberg.
  edge: { lon: 7.5045, lat: 46.8795, h: 30, agl: true, heading: 140, pitch: -6 },
  // Kandersteg: up the valley, conifers on the slopes, the tree line above.
  kandersteg: { lon: 7.672, lat: 46.505, h: 1500, agl: false, heading: 175, pitch: 2 },
  // Over the slopes east of Kandersteg towards the tree line.
  treeline: { lon: 7.655, lat: 46.488, h: 1900, agl: false, heading: 95, pitch: -4 },
  // 1000 m above the Belpberg, looking down the Aare valley.
  high: { lon: 7.47, lat: 46.9, h: 1000, agl: true, heading: 140, pitch: -25 },
  // Straight down from 450 m: does the forest edge match the photo?
  top: { lon: 7.5045, lat: 46.877, h: 450, agl: true, heading: 0, pitch: -89.9 },
  // Flying at 150 m over the Mittelland towards the Gürbetal.
  fly: { lon: 7.44, lat: 46.9, h: 150, agl: true, heading: 150, pitch: -6 },
};

const SEASON_DATES: Record<Season, string> = {
  spring: '2026-05-05',
  summer: '2026-06-21',
  autumn: '2026-10-18',
  winter: '2026-01-20',
};
const SNOW_LINE: Record<Season, number> = { winter: 900, spring: 1800, summer: 2900, autumn: 2300 };

const q = new URLSearchParams(location.search);
const view = VIEWS[q.get('view') ?? 'belpberg'] ?? VIEWS.belpberg!;
const season = (q.get('season') ?? 'summer') as Season;
const mobile = q.get('device') === 'mobile';
const night = q.has('night');
const speed = Number(q.get('speed') ?? 60);
const fly = q.get('view') === 'fly';
if (q.has('clean')) document.body.classList.add('clean');
const quality = WORLD_QUALITY[mobile ? 'mobile' : 'desktop'];
const date = new Date(
  q.get('t') ?? `${SEASON_DATES[season] ?? SEASON_DATES.summer}T${night ? '20:15' : '13:30'}:00Z`,
);

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;

const renderer = new WebGPURenderer({
  canvas,
  antialias: false,
  powerPreference: 'high-performance',
  forceWebGL: q.has('webgl'),
  reversedDepthBuffer: true,
  trackTimestamp: q.has('gpu'),
});
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
  ? 'WebGPU'
  : 'WebGL 2';
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;

const scene = new Scene();
const camera = new PerspectiveCamera(55, 1, 0.1, quality.viewDistance * 1.5);
let frame = new LocalFrame(view.lon, view.lat, 0);
const sky = new Sky(date, view.lon, view.lat, SKY_QUALITY[mobile ? 'mobile' : 'desktop']);
sky.setWeather(WEATHER_PRESETS.clear);
const world = new World(frame, quality);
await world.init();
scene.add(sky.object, world.object);
scene.environment = sky.environment;
const scenePass = pass(scene, camera);
const pipeline = new RenderPipeline(renderer);
pipeline.outputNode = sky.post(
  scenePass.getTextureNode('output'),
  scenePass.getTextureNode('depth'),
  camera,
);

const trees = world.object.getObjectByName('Trees') as Object3D;
if (q.get('trees') === '0') trees.visible = false;
const treeStats = () =>
  (trees.userData.treeStats as (() => Record<string, unknown>) | undefined)?.() ?? {};

// ---- camera ----
const geo = { lon: view.lon, lat: view.lat, h: 0 };
const guessGround = seaLevelToEllipsoid(view.lon, view.lat, 600);
geo.h = view.agl ? guessGround + view.h : seaLevelToEllipsoid(view.lon, view.lat, view.h);
let heading = view.heading;
const place = () => {
  frame.fromGeodetic(geo.lon, geo.lat, geo.h, camera.position);
  const hr = (heading * Math.PI) / 180;
  const pr = (view.pitch * Math.PI) / 180;
  const dir = new Vector3(Math.sin(hr) * Math.cos(pr), Math.sin(pr), -Math.cos(hr) * Math.cos(pr));
  camera.up.set(0, 1, 0);
  if (Math.abs(view.pitch) > 89) camera.up.set(0, 0, -1);
  camera.lookAt(camera.position.clone().add(dir));
  camera.updateMatrixWorld();
};
place();

const resize = () => {
  const w = Math.max(1, canvas.clientWidth);
  const h = Math.max(1, canvas.clientHeight);
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? 70 : 55;
  camera.updateProjectionMatrix();
  const size = renderer.getDrawingBufferSize(new Vector2());
  world.setViewport(size.x, size.y);
};
new ResizeObserver(resize).observe(canvas);
resize();

function rebase() {
  frame = new LocalFrame(geo.lon, geo.lat, 0);
  world.setFrame(frame);
  sky.setLocation(geo.lon, geo.lat);
}

const anchor = new LocalFrame(view.lon, view.lat, 0);
const local = new Vector3();
let appTime = 0;
const nightFactor = (el: number) => {
  const t = Math.min(1, Math.max(0, (2 - el) / 8));
  return t * t * (3 - 2 * t);
};
function step(dt: number) {
  appTime += dt;
  if (fly) {
    const hr = (heading * Math.PI) / 180;
    const m = speed * dt;
    geo.lat += (Math.cos(hr) * m) / 111_200;
    geo.lon += (Math.sin(hr) * m) / (111_200 * Math.cos((geo.lat * Math.PI) / 180));
    heading += dt * 1.5;
    const p = frame.fromGeodetic(geo.lon, geo.lat, geo.h, new Vector3());
    if (p.x * p.x + p.z * p.z > 2000 * 2000) rebase();
  }
  if (view.agl) {
    const g = world.groundHeight(geo.lon, geo.lat);
    if (g !== undefined) geo.h = g + view.h;
  }
  place();
  world.setConditions({
    night: nightFactor(sky.state.sunElevation),
    exposure: sky.state.exposure,
    season,
    snowLine: SNOW_LINE[season] ?? 2900,
    lightDirection: sky.state.lightDirection,
    time: appTime,
  });
  world.update(camera);
  anchor.fromGeodetic(frame.origin.lon, frame.origin.lat, 0, local);
  sky.update(camera, {
    dt,
    altitude: ellipsoidToSeaLevel(geo.lon, geo.lat, geo.h),
    origin: { x: local.x, z: local.z },
  });
  pipeline.render();
}

async function finish() {
  const b = renderer.backend as unknown as { device?: GPUDevice; gl?: WebGL2RenderingContext };
  if (b.device) await b.device.queue.onSubmittedWorkDone();
  else if (b.gl) b.gl.readPixels(0, 0, 1, 1, b.gl.RGBA, b.gl.UNSIGNED_BYTE, new Uint8Array(4));
}

const stats = {
  ready: false,
  frames: 0,
  backend,
  loading: true,
  worldLoading: true,
  frameMs: 0,
  cpuMs: 0,
  cpuMaxMs: 0,
  drawCalls: 0,
  triangles: 0,
  trees: {} as Record<string, unknown>,
  world: world.stats(),
  hitches: [] as Array<[number, number]>,
  /** Renders n frames back to back and waits for the GPU: ms per frame. */
  bench: async (n: number, withTrees = true) => {
    const was = trees.visible;
    trees.visible = withTrees && q.get('trees') !== '0';
    await finish();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) step(0);
    await finish();
    trees.visible = was;
    return (performance.now() - t0) / n;
  },
  setVisible: (v: boolean) => (trees.visible = v),
  probe: () => {
    const b = renderer.backend as unknown as { device?: GPUDevice; gl?: unknown };
    return { device: !!b.device, gl: !!b.gl };
  },
  /** GPU time of the last frames from timestamp queries (needs ?gpu=1), ms per frame. */
  gpuMs: async (frames: number) => {
    let total = 0;
    for (let i = 0; i < frames; i++) {
      step(0);
      const ms = await renderer.resolveTimestampsAsync();
      total += typeof ms === 'number' ? ms : NaN;
    }
    return total / frames;
  },
};
(window as unknown as { __demo: typeof stats }).__demo = stats;

let last = performance.now();
let acc = 0;
let cpuAcc = 0;
let n = 0;
renderer.setAnimationLoop((now: number) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const t0 = performance.now();
  step(dt);
  const cpu = performance.now() - t0;
  stats.frames++;
  if (stats.frames > 5) stats.ready = true;
  if (stats.frames > 30) stats.cpuMaxMs = Math.max(stats.cpuMaxMs, cpu);
  if (cpu > 12 && stats.hitches.length < 40) stats.hitches.push([stats.frames, Math.round(cpu)]);
  acc += dt * 1000;
  cpuAcc += cpu;
  if (++n >= 30) {
    stats.frameMs = acc / n;
    stats.cpuMs = cpuAcc / n;
    acc = cpuAcc = n = 0;
  }
  stats.worldLoading = world.loading;
  stats.trees = treeStats();
  stats.loading = world.loading;
  stats.world = world.stats();
  stats.drawCalls = renderer.info.render.drawCalls;
  stats.triangles = renderer.info.render.triangles;
  if (stats.frames % 10 === 0) {
    const t = stats.trees as Record<string, number>;
    hud.textContent =
      `${backend} ${mobile ? 'mobile' : 'desktop'} ${season}${night ? ' night' : ''}\n` +
      `trees ${t.instances} (${t.instancesDrawn} drawn) chunks ${t.chunksReady}/${t.chunks}\n` +
      `queue ${t.queued} flight ${t.inFlight} uploads ${t.pendingUploads} seating ${t.seating}\n` +
      `tree draws ${t.draws} gpu ~${((t.gpuBytes ?? 0) / 2 ** 20).toFixed(0)} MB\n` +
      `draw calls ${stats.drawCalls} tris ${(stats.triangles / 1e6).toFixed(2)} M\n` +
      `frame ${stats.frameMs.toFixed(1)} ms cpu ${stats.cpuMs.toFixed(1)} ms ${stats.loading ? 'loading' : 'done'}`;
  }
});
