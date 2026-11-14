/**
 * Stand-alone page for the world package: the streamed terrain under the real sky (scene pass,
 * then the sky's air and clouds, as the game draws it) with camera presets. Served by Vite at
 * /flightsimulator/demo/world.html.
 *
 * URL switches:
 *   ?view=belp|thun|alps|...                   camera preset (see VIEWS; default belp)
 *   ?season=spring|summer|autumn|winter        season of the ground (default summer); also picks
 *                                              a date in that season for the sun
 *   ?hour=22                                   Swiss local hour on that date (default 11)
 *   ?t=2026-06-21T10:00Z                       exact time instead of season date and hour
 *   ?night=0..1                                override the night factor (default from the sun)
 *   ?snowline=1500                             override the snow line (m above sea level)
 *   ?weather=clear|fair|cloudy|overcast        default clear
 *   ?device=mobile                             mobile quality preset
 *   ?webgl=1                                   force the WebGL 2 fallback
 *   ?clean=1                                   hide the text overlay
 *   ?fly=1                                     fly the view direction at 120 m/s
 *   ?marks=1                                   labels on known summits
 *   ?shadow=1                                  a red block in front of the camera (shadow map)
 *
 * window.__demo exposes stats for tools/world/shots.mjs and tools/world/ground-shots.mjs.
 */
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Mesh,
  MeshStandardNodeMaterial,
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
import { SKY_QUALITY, Sky, WEATHER_PRESETS, type WeatherPreset } from '@sky';
import { type Season, WORLD_QUALITY, World, type WorldStats } from '@world';

interface View {
  /** Camera: lon/lat and height above sea level, or above ground with `agl`. */
  lon: number;
  lat: number;
  h: number;
  agl?: boolean;
  /** Looks at this point (height above sea level). */
  look: { lon: number; lat: number; h: number };
}

const VIEWS: Record<string, View> = {
  // Above Bern-Belp, looking south-east along the valley to Thun and the Alps.
  belp: { lon: 7.455, lat: 46.945, h: 1300, look: { lon: 7.62, lat: 46.8, h: 600 } },
  // Over Lake Thun's north shore, looking south-east to Eiger, Mönch and Jungfrau.
  thun: { lon: 7.64, lat: 46.74, h: 1500, look: { lon: 7.98, lat: 46.56, h: 3600 } },
  // 120 m over the lake near Spiez, looking north-east along the shore.
  shore: { lon: 7.69, lat: 46.69, h: 120, agl: true, look: { lon: 7.75, lat: 46.72, h: 560 } },
  // 60 m over fields and forest in the Aare valley near Kiesen, looking south-east.
  low: { lon: 7.585, lat: 46.815, h: 60, agl: true, look: { lon: 7.6, lat: 46.805, h: 540 } },
  // Over the lake towards the sun (south-east in the morning): glint on the water.
  glint: { lon: 7.64, lat: 46.74, h: 900, look: { lon: 7.72, lat: 46.69, h: 560 } },
  // High over the Niesen, looking east into the Bernese Alps.
  alps: { lon: 7.6, lat: 46.62, h: 4200, look: { lon: 7.95, lat: 46.56, h: 3000 } },
  // On runway 14 of Bern-Belp, 2 m above the asphalt, looking along it (south-east).
  runway: {
    lon: 7.49727,
    lat: 46.9143,
    h: 2,
    agl: true,
    look: { lon: 7.50968, lat: 46.9038, h: 512 },
  },
  // Straight down on Belp from 2500 m: north must be up on the screen.
  top: { lon: 7.4972, lat: 46.9122, h: 2500, look: { lon: 7.4972, lat: 46.91221, h: 510 } },
  // Lake Thun from 600 m above the water, looking south across it to the Niesen.
  lake: { lon: 7.66, lat: 46.73, h: 1150, look: { lon: 7.66, lat: 46.66, h: 900 } },

  // ---- Phase 2: seasons, night, the ground up close ----
  // Bern from 1500 m above the town, 4 km south-west of the old town, looking at it.
  bern1500: { lon: 7.41, lat: 46.925, h: 2050, look: { lon: 7.45, lat: 46.95, h: 540 } },
  // Bern from 300 m, 1.2 km south of the old town (over the Aare at the Marzili).
  bern300: { lon: 7.445, lat: 46.938, h: 840, look: { lon: 7.452, lat: 46.95, h: 530 } },
  // The Mittelland from 3000 m over Burgdorf, looking north-east towards Olten and Zurich.
  mittelland: { lon: 7.55, lat: 47.02, h: 3000, look: { lon: 7.95, lat: 47.25, h: 450 } },
  // Zurich and its lake from 1600 m over the lake near Thalwil, looking north-west.
  zurich: { lon: 8.6, lat: 47.27, h: 1600, look: { lon: 8.53, lat: 47.38, h: 410 } },
  // The valley of Grindelwald from the slopes towards First, looking south-west to the village.
  grindelwald: { lon: 8.075, lat: 46.645, h: 2100, look: { lon: 8.035, lat: 46.622, h: 1050 } },
  // The Bernese Alps from 4000 m over the Niesen, for the seasons.
  alps4000: { lon: 7.62, lat: 46.63, h: 4000, look: { lon: 7.96, lat: 46.55, h: 2800 } },
  // The Aare valley at Belp from 600 m above ground, looking south-east up the valley.
  belp600: { lon: 7.47, lat: 46.9, h: 600, agl: true, look: { lon: 7.56, lat: 46.84, h: 540 } },
  // A meadow at 30 m above ground (Belpmoos, north of the airfield), looking south-east.
  meadow30: {
    lon: 7.488,
    lat: 46.928,
    h: 30,
    agl: true,
    look: { lon: 7.493, lat: 46.926, h: 515 },
  },
  // Fields at 30 m in the Aare valley near Kiesen, looking south.
  field30: { lon: 7.58, lat: 46.818, h: 30, agl: true, look: { lon: 7.582, lat: 46.814, h: 540 } },
  // A main road at 50 m: the Bernstrasse near Wichtrach, looking along it.
  road50: {
    lon: 7.5632,
    lat: 46.8505,
    h: 50,
    agl: true,
    look: { lon: 7.5717, lat: 46.8425, h: 545 },
  },
  // The grass beside runway 14 of Bern-Belp, 2 m above ground, 50 m north-east of the centre line.
  runwaygrass: {
    lon: 7.49778,
    lat: 46.91458,
    h: 2,
    agl: true,
    look: { lon: 7.51019, lat: 46.90408, h: 512 },
  },
  // The Eiger north face from the north (above Grindelwald), for low sun.
  northface: { lon: 7.995, lat: 46.635, h: 2300, look: { lon: 8.005, lat: 46.578, h: 2900 } },
};

/** A date in each season for the sun's path (2026). */
const SEASON_DATE: Record<Season, string> = {
  winter: '2026-01-20',
  spring: '2026-04-22',
  summer: '2026-07-10',
  autumn: '2026-10-18',
};
/** Same values as the app (src/app/season.ts), so the demo shows what the game shows. */
const SNOW_LINE: Record<Season, number> = {
  winter: 900,
  spring: 1800,
  summer: 2900,
  autumn: 2300,
};
function nightFactor(sunElevation: number): number {
  const t = Math.min(1, Math.max(0, (2 - sunElevation) / 8));
  return t * t * (3 - 2 * t);
}

// No global declaration: every demo page has its own shape of __demo.
type DemoStats = {
  ready: boolean;
  frames: number;
  backend: string;
  loading: boolean;
  progress: number;
  world: WorldStats;
  drawCalls: number;
  triangles: number;
  /** Mean frame interval and mean CPU time of update + render submission, ms. */
  frameMs: number;
  cpuMs: number;
  /** Worst CPU time of a frame since the page started (uploads, hitches), ms. */
  cpuMaxMs: number;
  /** Frames whose CPU time exceeded 8 ms: [frame, ms, tiles uploaded so far, world.update ms]. */
  hitches: Array<[number, number, number, number]>;
  gpuMs: number | null;
  /** Moves the render origin by (east, north) metres without moving the camera. */
  rebase: (east: number, north: number) => void;
  ground: (lon: number, lat: number) => unknown;
  /** Renders n frames back to back and waits for the GPU: ms per frame (GPU-bound cost). */
  bench: (n: number) => Promise<number>;
  adapter: string;
  conditions: { night: number; exposure: number; season: Season; snowLine: number };
};

const query = new URLSearchParams(location.search);
const view = VIEWS[query.get('view') ?? 'belp'] ?? VIEWS.belp!;
const mobile = query.get('device') === 'mobile';
const quality = {
  ...WORLD_QUALITY[mobile ? 'mobile' : 'desktop'],
  ...(query.get('detail') === '0' ? { detail: false } : {}),
  ...(query.has('tiles') ? { maxTiles: Number(query.get('tiles')) } : {}),
};
if (query.has('clean')) document.body.classList.add('clean');

const season = (query.get('season') ?? 'summer') as Season;
const hour = Number(query.get('hour') ?? 11);
// Swiss local time: UTC+1 in winter, UTC+2 in summer time (late March to late October).
const summerTime = season !== 'winter';
const date = query.has('t')
  ? new Date(query.get('t')!)
  : new Date(
      Date.parse(`${SEASON_DATE[season]}T00:00:00Z`) + (hour - (summerTime ? 2 : 1)) * 3_600_000,
    );

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;

const renderer = new WebGPURenderer({
  canvas,
  // As in the game: no multisampling, the scene goes through the sky's post chain.
  antialias: false,
  forceWebGL: query.has('webgl'),
  reversedDepthBuffer: true,
  trackTimestamp: query.has('gpu'),
});
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
  ? 'WebGPU'
  : 'WebGL 2';
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;

const scene = new Scene();
const sky = new Sky(date, view.lon, view.lat, SKY_QUALITY[mobile ? 'mobile' : 'desktop']);
sky.setWeather(WEATHER_PRESETS[(query.get('weather') ?? 'clear') as WeatherPreset]);
scene.add(sky.object);
scene.environment = sky.environment;

const groundGuess = seaLevelToEllipsoid(view.lon, view.lat, 550);
let frame = new LocalFrame(view.lon, view.lat, groundGuess);
/** A fixed frame: the clouds are anchored to it. */
const anchor = new LocalFrame(view.lon, view.lat, 0);
const world = new World(frame, quality);
await world.init();
scene.add(world.object);

const camera = new PerspectiveCamera(55, 1, 0.1, quality.viewDistance * 1.5);
const scenePass = pass(scene, camera);
const pipeline = new RenderPipeline(renderer);
pipeline.outputNode = sky.post(
  scenePass.getTextureNode('output'),
  scenePass.getTextureNode('depth'),
  camera,
);
{
  // Same shadow setup as the game: a small map around the point of interest.
  const s = sky.sun.shadow;
  sky.sun.castShadow = true;
  const size = mobile ? 1024 : 2048;
  s.mapSize.set(size, size);
  s.camera.left = s.camera.bottom = -16;
  s.camera.right = s.camera.top = 16;
  s.camera.near = 1;
  s.camera.far = 400;
  s.bias = -0.0005;
  s.normalBias = 0.03;
}

const camGeo = { lon: view.lon, lat: view.lat, h: 0 };
const camH = (agl: number | undefined) =>
  view.agl ? (agl ?? groundGuess) + view.h : seaLevelToEllipsoid(view.lon, view.lat, view.h);
camGeo.h = camH(undefined);
const lookAt = (target: { lon: number; lat: number; h: number }) => {
  const t = frame.fromGeodetic(
    target.lon,
    target.lat,
    seaLevelToEllipsoid(target.lon, target.lat, target.h),
    new Vector3(),
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(t);
};
const placeCamera = () => {
  frame.fromGeodetic(camGeo.lon, camGeo.lat, camGeo.h, camera.position);
  lookAt(view.look);
};
placeCamera();

// ?shadow=1: a 4 m block 25 m ahead on the ground, casting the sun's shadow onto the terrain.
const block = new Mesh(new BoxGeometry(4, 4, 4), new MeshStandardNodeMaterial({ color: 0xc03020 }));
if (query.has('shadow')) {
  block.castShadow = true;
  scene.add(block);
}

const resize = () => {
  const w = Math.max(1, canvas.clientWidth);
  const h = Math.max(1, canvas.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? 70 : 55;
  camera.updateProjectionMatrix();
  const size = renderer.getDrawingBufferSize(new Vector2());
  world.setViewport(size.x, size.y);
};
new ResizeObserver(resize).observe(canvas);
resize();

/** Moves the render origin; the camera keeps its place on Earth. */
function rebase(east: number, north: number) {
  const ecef = frame.toEcef(camera.position, { x: 0, y: 0, z: 0 });
  const fwd = frame.dirToEcef(camera.getWorldDirection(new Vector3()), { x: 0, y: 0, z: 0 });
  const o = frame.toGeodetic({ x: east, y: 0, z: -north });
  frame = new LocalFrame(o.lon, o.lat, o.h);
  world.setFrame(frame);
  sky.setLocation(o.lon, o.lat);
  frame.toLocal(ecef, camera.position);
  const f = frame.dirToLocal(fwd, new Vector3());
  camera.up.set(0, 1, 0);
  camera.lookAt(camera.position.clone().add(f));
  camera.updateMatrixWorld();
}

/** GPU name, for performance notes. */
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

const conditions = {
  night: 0,
  exposure: 1,
  season,
  snowLine: query.has('snowline') ? Number(query.get('snowline')) : SNOW_LINE[season],
  lightDirection: sky.state.lightDirection,
  time: 0,
  wind: { fromDeg: 250, speed: 3 },
};
const geo = { lon: 0, lat: 0, h: 0 };
const local = new Vector3();
/** One frame as the game does it: conditions, world, sky, then the post chain. */
function step(dt: number) {
  conditions.night = query.has('night')
    ? Number(query.get('night'))
    : nightFactor(sky.state.sunElevation);
  conditions.exposure = sky.state.exposure;
  conditions.time += dt;
  world.setConditions(conditions);
  world.update(camera);
  frame.toGeodetic(camera.position, geo);
  anchor.fromGeodetic(frame.origin.lon, frame.origin.lat, 0, local);
  sky.update(camera, {
    dt,
    altitude: ellipsoidToSeaLevel(geo.lon, geo.lat, geo.h),
    origin: { x: local.x, z: local.z },
  });
  // The shadow map covers the ground in front of the camera.
  const ahead = camera.getWorldDirection(new Vector3()).setY(0).normalize().multiplyScalar(25);
  const at = camera.position.clone().add(ahead);
  if (query.has('shadow')) {
    const g = frame.toGeodetic(at);
    const h = world.groundHeight(g.lon, g.lat);
    if (h !== undefined) frame.fromGeodetic(g.lon, g.lat, h + 2, block.position);
    at.copy(block.position);
  }
  sky.sun.target.position.copy(at);
  sky.sun.position.copy(at).addScaledVector(sky.state.lightDirection, 200);
  sky.sun.target.updateMatrixWorld();
  pipeline.render();
}

async function bench(n: number): Promise<number> {
  const b = renderer.backend as unknown as {
    device?: GPUDevice;
    gl?: WebGL2RenderingContext;
  };
  const finish = async () => {
    if (b.device) await b.device.queue.onSubmittedWorkDone();
    else if (b.gl) b.gl.readPixels(0, 0, 1, 1, b.gl.RGBA, b.gl.UNSIGNED_BYTE, new Uint8Array(4));
  };
  await finish();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) step(1 / 60);
  await finish();
  return (performance.now() - t0) / n;
}

/**
 * ?marks=1: labels on known summits (heights above sea level from swisstopo), to check that the
 * mountains stand where they belong.
 */
const PEAKS = [
  { name: 'Niesen', lon: 7.6513, lat: 46.6453, h: 2362 },
  { name: 'Stockhorn', lon: 7.5383, lat: 46.6939, h: 2190 },
  { name: 'Eiger', lon: 8.0053, lat: 46.5776, h: 3967 },
  { name: 'Mönch', lon: 7.9975, lat: 46.5585, h: 4107 },
  { name: 'Jungfrau', lon: 7.9625, lat: 46.5367, h: 4158 },
  { name: 'Gurten', lon: 7.4397, lat: 46.9188, h: 858 },
];
const marks = query.has('marks')
  ? PEAKS.map((p) => {
      const el = document.createElement('div');
      el.textContent = p.name;
      el.style.cssText =
        'position:fixed;font:11px sans-serif;color:#fff;background:#c00;padding:0 3px;' +
        'transform:translate(-50%,-100%);pointer-events:none;white-space:nowrap';
      document.body.appendChild(el);
      return { p, el };
    })
  : [];
function placeMarks() {
  const v = new Vector3();
  for (const { p, el } of marks) {
    frame.fromGeodetic(p.lon, p.lat, seaLevelToEllipsoid(p.lon, p.lat, p.h), v);
    const ahead = v.clone().sub(camera.position).dot(camera.getWorldDirection(new Vector3())) > 0;
    v.project(camera);
    const visible = ahead && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
    el.style.display = visible ? 'block' : 'none';
    el.style.left = `${((v.x + 1) / 2) * canvas.clientWidth}px`;
    el.style.top = `${((1 - v.y) / 2) * canvas.clientHeight}px`;
  }
}

const fly = query.has('fly');
let last = performance.now();
let frames = 0;
let frameAcc = 0;
let cpuAcc = 0;
let samples = 0;
let gpuMs: number | null = null;
const stats: DemoStats = {
  ready: false,
  frames: 0,
  backend,
  loading: true,
  progress: 0,
  world: world.stats(),
  drawCalls: 0,
  triangles: 0,
  frameMs: 0,
  cpuMs: 0,
  cpuMaxMs: 0,
  hitches: [],
  gpuMs,
  rebase,
  ground: (lon: number, lat: number) => world.ground(lon, lat),
  bench,
  adapter: await adapterName(),
  conditions,
};
(window as unknown as { __demo: DemoStats }).__demo = stats;

renderer.setAnimationLoop((now: number) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const t0 = performance.now();
  if (fly) {
    const f = camera.getWorldDirection(new Vector3());
    f.y = 0;
    camera.position.addScaledVector(f.normalize(), 120 * dt);
    if (Math.hypot(camera.position.x, camera.position.z) > 3000)
      rebase(camera.position.x, -camera.position.z);
  }
  if (view.agl) {
    // Sit at a fixed height over the loaded ground: exercises groundHeight every frame.
    const g = world.groundHeight(camGeo.lon, camGeo.lat);
    if (g !== undefined && Math.abs(camH(g) - camGeo.h) > 0.01) {
      camGeo.h = camH(g);
      placeCamera();
    }
  }
  const tu = performance.now();
  step(dt);
  const updateMs = performance.now() - tu;
  const cpu = performance.now() - t0;

  frames++;
  stats.frames = frames;
  if (frames > 5) stats.ready = true;
  frameAcc += dt * 1000;
  cpuAcc += cpu;
  if (frames > 10) stats.cpuMaxMs = Math.max(stats.cpuMaxMs, cpu);
  if (cpu > 8 && stats.hitches.length < 40)
    stats.hitches.push([
      frames,
      Math.round(cpu * 10) / 10,
      stats.world.uploaded,
      Math.round(updateMs * 10) / 10,
    ]);
  samples++;
  if (samples >= 30) {
    stats.frameMs = frameAcc / samples;
    stats.cpuMs = cpuAcc / samples;
    frameAcc = cpuAcc = samples = 0;
    if (query.has('gpu') && backend === 'WebGPU')
      void renderer.resolveTimestampsAsync().then((ms) => {
        if (typeof ms === 'number') gpuMs = stats.gpuMs = ms;
      });
  }
  stats.loading = world.loading;
  stats.progress = world.progress;
  stats.world = world.stats();
  stats.drawCalls = renderer.info.render.drawCalls;
  stats.triangles = renderer.info.render.triangles;
  if (marks.length) placeMarks();
  if (frames % 10 === 0) {
    const s = stats.world;
    hud.textContent =
      `${backend}  ${mobile ? 'mobile' : 'desktop'}  ${season}  night ${conditions.night.toFixed(2)}  ` +
      `exposure ${conditions.exposure.toPrecision(3)}\n` +
      `tiles ${s.tilesDrawn} drawn / ${s.tilesLoaded} loaded  z<=${s.maxZoom}\n` +
      `queue ${s.queued}  in flight ${s.inFlight}  uploads ${s.pendingUploads}\n` +
      `progress ${(stats.progress * 100).toFixed(0)} %  ${stats.loading ? 'loading' : 'done'}\n` +
      `draw calls ${stats.drawCalls}  triangles ${(stats.triangles / 1e6).toFixed(2)} M\n` +
      `gpu memory ~${(s.gpuBytes / 2 ** 20).toFixed(0)} MB\n` +
      `frame ${stats.frameMs.toFixed(1)} ms  cpu ${stats.cpuMs.toFixed(1)} ms` +
      (gpuMs !== null ? `  gpu ${gpuMs.toFixed(1)} ms` : '');
  }
});
