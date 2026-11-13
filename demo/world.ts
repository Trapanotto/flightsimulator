/**
 * Stand-alone page for the world package: renderer, a simple sun and sky, the streamed terrain
 * and camera presets. Served by Vite at /flightsimulator/demo/world.html.
 *
 * URL switches:
 *   ?view=belp|thun|low|alps|runway|top|lake  camera preset (default belp)
 *   ?device=mobile                             mobile quality preset
 *   ?webgl=1                                   force the WebGL 2 fallback
 *   ?depth=reversed|log|standard               depth buffer mode (default reversed)
 *   ?sun=azimuth,elevation                     degrees (default 140,48)
 *   ?clean=1                                   hide the text overlay
 *   ?fly=1                                     fly the view direction at 120 m/s
 *
 * window.__demo exposes stats for tools/world/shots.mjs.
 */
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { LocalFrame, seaLevelToEllipsoid } from '@geo';
import { WORLD_QUALITY, World, type WorldStats } from '@world';

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
};

declare global {
  interface Window {
    __demo?: {
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
      /** Frames whose CPU time exceeded 8 ms: [frame, ms, tiles uploaded so far]. */
      hitches: Array<[number, number, number]>;
      gpuMs: number | null;
      /** Moves the render origin by (east, north) metres without moving the camera. */
      rebase: (east: number, north: number) => void;
      ground: (lon: number, lat: number) => unknown;
      /** Renders n frames back to back and waits for the GPU: ms per frame (GPU-bound cost). */
      bench: (n: number) => Promise<number>;
      adapter: string;
    };
  }
}

const query = new URLSearchParams(location.search);
const view = VIEWS[query.get('view') ?? 'belp'] ?? VIEWS.belp!;
const mobile = query.get('device') === 'mobile';
const quality = {
  ...WORLD_QUALITY[mobile ? 'mobile' : 'desktop'],
  ...(query.get('detail') === '0' ? { detail: false } : {}),
  ...(query.has('tiles') ? { maxTiles: Number(query.get('tiles')) } : {}),
};
const depth = query.get('depth') ?? 'reversed';
if (query.has('clean')) document.body.classList.add('clean');

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;

const renderer = new WebGPURenderer({
  canvas,
  antialias: true,
  forceWebGL: query.has('webgl'),
  reversedDepthBuffer: depth === 'reversed',
  logarithmicDepthBuffer: depth === 'log',
  trackTimestamp: query.has('gpu'),
});
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
  ? 'WebGPU'
  : 'WebGL 2';
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

const scene = new Scene();
const skyHorizon = new Color(0.62, 0.76, 0.92);
const skyZenith = new Color(0.12, 0.3, 0.7);
scene.background = skyHorizon.clone();
const sun = new DirectionalLight(new Color(1, 0.96, 0.88), 3.2);
const ambient = new HemisphereLight(0xbfd4ff, 0x6b6257, 1);
scene.add(sun, sun.target, ambient);
const [az, el] = (query.get('sun') ?? '140,48').split(',').map(Number) as [number, number];
const sunDir = new Vector3(
  Math.cos((el * Math.PI) / 180) * Math.sin((az * Math.PI) / 180),
  Math.sin((el * Math.PI) / 180),
  -Math.cos((el * Math.PI) / 180) * Math.cos((az * Math.PI) / 180),
);
sun.position.copy(sunDir).multiplyScalar(1000);

const groundGuess = seaLevelToEllipsoid(view.lon, view.lat, 550);
let frame = new LocalFrame(view.lon, view.lat, groundGuess);
const world = new World(frame, quality);
world.setSkyColors(skyZenith, skyHorizon);
await world.init();
scene.add(world.object);

const camera = new PerspectiveCamera(55, 1, 0.5, quality.viewDistance * 1.5);
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
  renderer.shadowMap.enabled = true;
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = sun.shadow.camera;
  s.left = s.bottom = -20;
  s.right = s.top = 20;
  s.near = 1;
  s.far = 400;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
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
  for (let i = 0; i < n; i++) {
    world.update(camera);
    renderer.render(scene, camera);
  }
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
const stats = {
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
  hitches: [] as Array<[number, number, number]>,
  gpuMs: gpuMs as number | null,
  rebase,
  ground: (lon: number, lat: number) => world.ground(lon, lat),
  bench,
  adapter: await adapterName(),
};
window.__demo = stats;

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
  if (query.has('shadow')) {
    const ahead = camera.getWorldDirection(new Vector3()).setY(0).normalize().multiplyScalar(25);
    const at = camera.position.clone().add(ahead);
    const g = frame.toGeodetic(at);
    const h = world.groundHeight(g.lon, g.lat);
    if (h !== undefined) frame.fromGeodetic(g.lon, g.lat, h + 2, block.position);
    sun.target.position.copy(block.position);
    sun.position.copy(block.position).addScaledVector(sunDir, 200);
  }
  world.update(camera);
  renderer.render(scene, camera);
  const cpu = performance.now() - t0;

  frames++;
  stats.frames = frames;
  if (frames > 5) stats.ready = true;
  frameAcc += dt * 1000;
  cpuAcc += cpu;
  if (frames > 10) stats.cpuMaxMs = Math.max(stats.cpuMaxMs, cpu);
  if (cpu > 8 && stats.hitches.length < 40)
    stats.hitches.push([frames, Math.round(cpu * 10) / 10, stats.world.uploaded]);
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
      `${backend}  ${mobile ? 'mobile' : 'desktop'}  depth ${depth}\n` +
      `tiles ${s.tilesDrawn} drawn / ${s.tilesLoaded} loaded  z<=${s.maxZoom}\n` +
      `queue ${s.queued}  in flight ${s.inFlight}  uploads ${s.pendingUploads}\n` +
      `progress ${(stats.progress * 100).toFixed(0)} %  ${stats.loading ? 'loading' : 'done'}\n` +
      `draw calls ${stats.drawCalls}  triangles ${(stats.triangles / 1e6).toFixed(2)} M\n` +
      `gpu memory ~${(s.gpuBytes / 2 ** 20).toFixed(0)} MB\n` +
      `frame ${stats.frameMs.toFixed(1)} ms  cpu ${stats.cpuMs.toFixed(1)} ms` +
      (gpuMs !== null ? `  gpu ${gpuMs.toFixed(1)} ms` : '');
  }
});
