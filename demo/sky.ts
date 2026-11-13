/**
 * Sky test bench: the sky with stand-in scenery that makes the air visible (a curved ground,
 * mountains at 2, 10, 40 and 100 km, a glossy and a rough sphere), set up the way the app
 * drives the sky: scene pass -> sky.post() -> tone mapping.
 *
 * URL switches:
 *   t=2026-06-21T18:45Z  time (UTC)          weather=clear|fair|cloudy|overcast
 *   alt=600              camera m above sea   heading=180 (deg, 0 north)   pitch=5 (deg)
 *   device=mobile        quality preset       webgl=1 (WebGL 2 fallback)
 *   depth=reversed|log|standard              fov=55
 *   lapse=600            time-lapse, seconds of sky time per real second
 *   speed=120&turn=3     fly forward (m/s) and turn (deg/s), with floating-origin rebasing
 *   shot=1               hide the text
 */
import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardNodeMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  RenderPipeline,
  Scene,
  SphereGeometry,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { pass } from 'three/tsl';
import { SKY_QUALITY, Sky, WEATHER_PRESETS, type WeatherPreset } from '@sky';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const GROUND = 500; // m above sea level; the render origin lies on the ground
const EARTH = 6_360_000;

const depthMode = q.get('depth') ?? 'reversed';
const device = q.get('device') === 'mobile' ? 'mobile' : 'desktop';
if (q.has('shot')) document.body.classList.add('shot');

const canvas = document.getElementById('c') as HTMLCanvasElement;
const info = document.getElementById('info')!;

interface DemoDebug {
  ready: boolean;
  frames: number;
  backend: string;
  error?: string;
  measure?: (frames: number) => Promise<number>;
}
// No global declaration: every demo page has its own shape of __demo.
const demoWindow = window as unknown as { __demo?: DemoDebug };
const debug: DemoDebug = { ready: false, frames: 0, backend: '' };
demoWindow.__demo = debug;
window.addEventListener('error', (e) => (debug.error = String(e.message)));

/** Height of the curved ground below a point at horizontal distance d (render y). */
const drop = (x: number, z: number) => -(x * x + z * z) / (2 * EARTH);

function ground(): Mesh {
  // Polar grid, dense near the centre: follows the Earth's curvature out to 160 km.
  const rings = 160;
  const segs = 128;
  const pos: number[] = [0, 0, 0];
  for (let i = 1; i <= rings; i++) {
    const r = 160_000 * (i / rings) ** 2.2;
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      pos.push(x, drop(x, z), z);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 1; i < rings; i++)
    for (let j = 0; j < segs; j++) {
      const a = 1 + (i - 1) * segs + j;
      const b = 1 + (i - 1) * segs + ((j + 1) % segs);
      const c = 1 + i * segs + j;
      const d = 1 + i * segs + ((j + 1) % segs);
      idx.push(a, b, c, b, d, c);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new MeshStandardNodeMaterial({ color: new Color(0.11, 0.16, 0.07), roughness: 0.95 });
  const mesh = new Mesh(g, m);
  mesh.receiveShadow = true;
  return mesh;
}

/** A ridge of peaks: noisy cone heights, snow above 2600 m. */
function mountain(cx: number, cz: number, radius: number, height: number, seed: number): Mesh {
  const n = 96;
  const pos: number[] = [];
  const col: number[] = [];
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const bumps = Array.from({ length: 9 }, () => [rnd() * 2 - 1, rnd() * 2 - 1, 0.25 + rnd() * 0.5]);
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const u = (i / n) * 2 - 1;
      const v = (j / n) * 2 - 1;
      let h = 0;
      for (const [bx, by, br] of bumps) {
        const d = Math.hypot(u - bx! * 0.5, v - by! * 0.5) / br!;
        h = Math.max(h, Math.max(0, 1 - d) ** 1.6);
      }
      h *= 1 + 0.08 * Math.sin(u * 23 + seed) * Math.cos(v * 19);
      const x = cx + u * radius;
      const z = cz + v * radius;
      const y = h * height;
      pos.push(x, drop(x, z) + y - 30, z);
      const alt = y + GROUND;
      const snow = alt > 2700 ? 1 : alt > 2300 ? (alt - 2300) / 400 : 0;
      const rock = [0.16, 0.14, 0.12];
      const grass = [0.1, 0.14, 0.07];
      const base = alt > 1800 ? rock : grass;
      col.push(...base.map((c) => c + (0.85 - c) * snow));
    }
  const idx: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9 });
  const mesh = new Mesh(g, m);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

async function main() {
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL: q.has('webgl'),
    powerPreference: 'high-performance',
    reversedDepthBuffer: depthMode === 'reversed',
    logarithmicDepthBuffer: depthMode === 'log',
    trackTimestamp: q.has('timing'),
  } as ConstructorParameters<typeof WebGPURenderer>[0]);
  await renderer.init();
  debug.backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'WebGPU'
    : 'WebGL 2';
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const quality = { ...SKY_QUALITY[device] };
  if (q.has('steps')) quality.cloudSteps = num('steps', quality.cloudSteps);
  if (q.has('lsteps')) quality.cloudLightSteps = num('lsteps', quality.cloudLightSteps);
  if (q.has('detail')) quality.cloudDetail = q.get('detail') === '1';
  const scene = new Scene();
  const camera = new PerspectiveCamera(num('fov', 55), 1, 0.5, 225_000);
  let time = new Date(q.get('t') ?? '2026-06-21T11:30:00Z');
  const sky = new Sky(time, 7.44, 46.95, quality);
  const preset = (q.get('weather') ?? 'clear') as WeatherPreset;
  sky.setWeather(WEATHER_PRESETS[preset] ?? WEATHER_PRESETS.clear);
  scene.add(sky.object);
  (debug as unknown as Record<string, unknown>).sky = sky;
  (debug as unknown as Record<string, unknown>).renderer = renderer;
  scene.environment = sky.environment;

  scene.add(ground());
  // Mountains to the south (the Alps seen from the Plateau) at 2, 10, 40 and 100 km, and a
  // few in other directions so every view has some.
  const ranges: [number, number, number, number][] = [
    [2000, 1100, 600, 0.0],
    [10_000, 3500, 1700, 0.35],
    [40_000, 9000, 3000, -0.3],
    [100_000, 22_000, 4000, 0.12],
    [100_000, 22_000, 3800, -0.45],
    [40_000, 9000, 2600, Math.PI],
    [100_000, 22_000, 3500, Math.PI * 0.5],
    [100_000, 22_000, 3500, -Math.PI * 0.5],
    [40_000, 9000, 2500, Math.PI * 0.6],
  ];
  ranges.forEach(([d, r, h, a], i) =>
    scene.add(mountain(Math.sin(a) * d, Math.cos(a) * d, r, h, 1000 + i * 77)),
  );

  const glossy = new Mesh(
    new SphereGeometry(4, 64, 32),
    new MeshStandardNodeMaterial({ color: 0xffffff, metalness: 1, roughness: 0.08 }),
  );
  const rough = new Mesh(
    new SphereGeometry(4, 64, 32),
    new MeshStandardNodeMaterial({ color: 0xcccccc, metalness: 0, roughness: 0.85 }),
  );
  const heading = num('heading', 180) * (Math.PI / 180);
  const pitch = num('pitch', 3) * (Math.PI / 180);
  const fwd = new Vector3(Math.sin(heading), 0, -Math.cos(heading));
  const right = new Vector3(Math.cos(heading), 0, Math.sin(heading));
  const alt = num('alt', GROUND + 2);
  camera.position.set(0, alt - GROUND, 0);
  glossy.position.copy(camera.position).addScaledVector(fwd, 30).addScaledVector(right, -6);
  rough.position.copy(camera.position).addScaledVector(fwd, 30).addScaledVector(right, 6);
  glossy.position.y = rough.position.y = Math.max(camera.position.y - 2, 4);
  for (const m of [glossy, rough]) {
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  camera.lookAt(
    camera.position
      .clone()
      .addScaledVector(fwd, Math.cos(pitch))
      .add(new Vector3(0, Math.sin(pitch), 0)),
  );

  const sun = sky.sun;
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -60;
  sc.right = sc.top = 60;
  sc.near = 1;
  sc.far = 600;

  const scenePass = pass(scene, camera);
  const color = scenePass.getTextureNode('output');
  const depth = scenePass.getTextureNode('depth');
  const pipeline = new RenderPipeline(renderer);
  (debug as unknown as Record<string, unknown>).scenePass = scenePass;
  pipeline.outputNode = q.get('debug') === 'scene' ? color : sky.post(color, depth, camera);

  const resize = () => {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  const lapse = num('lapse', 0);
  // Fly: the camera moves forward at this speed (m/s) and turns (deg/s), the floating
  // origin is rebased every 2 km like the app will do (scenery stays where it is).
  const speed = num('speed', 0);
  const turn = num('turn', 0) * (Math.PI / 180);
  const origin = { x: 0, z: 0 };
  const scenery = scene.children.filter((o) => o !== sky.object);
  const frame = (dt: number) => {
    if (speed || turn) {
      camera.position.addScaledVector(fwd, speed * dt);
      camera.rotateY(-turn * dt);
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      fwd.normalize();
      if (Math.hypot(camera.position.x, camera.position.z) > 2000) {
        const shift = new Vector3(camera.position.x, 0, camera.position.z);
        origin.x += shift.x;
        origin.z += shift.z;
        camera.position.sub(shift);
        for (const o of scenery) o.position.sub(shift);
      }
    }
    if (lapse) {
      time = new Date(time.getTime() + dt * lapse * 1000);
      sky.setTime(time);
    }
    sky.update(camera, { dt, altitude: camera.position.y + GROUND, origin });
    const focus = camera.position.clone().addScaledVector(fwd, 30);
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(sky.state.lightDirection, 300);
    pipeline.render();
  };

  /**
   * GPU time per frame from timestamp queries (`?timing=1`), averaged over `frames` frames of
   * the running animation loop (the sky's per-frame passes run once per animation frame).
   * Returns -1 where the backend has no timestamp queries.
   */
  let samples: number[] | null = null;
  debug.measure = async (frames: number) => {
    if (!(renderer.backend as { trackTimestamp?: boolean }).trackTimestamp) return -1;
    samples = [];
    const s = samples;
    while (s.length < frames) await new Promise((r) => setTimeout(r, 50));
    samples = null;
    s.sort((a, b) => a - b);
    // The 10th percentile: the GPU is shared (other pages, other processes); the fastest
    // frames show the cost of this one, the slow ones show contention.
    return s[Math.floor(s.length / 10)]!;
  };

  let last = performance.now();
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    frame(dt);
    if (samples) {
      const s = samples;
      void renderer.resolveTimestampsAsync('render').then((v) => {
        if (v) s.push(v);
      });
    }
    debug.frames++;
    if (debug.frames === 30) debug.ready = true;
    const s = sky.state;
    info.textContent =
      `${debug.backend}  ${device}  depth=${depthMode}\n` +
      `${time.toISOString()}  sun ${s.sunElevation.toFixed(1)}°  moon ${s.moonElevation.toFixed(1)}° (${(s.moonPhase * 100).toFixed(0)}%)\n` +
      `exposure ${s.exposure.toExponential(2)}  ${s.illuminance.toPrecision(3)} lx  weather ${preset}`;
  });
}

main().catch((e: unknown) => {
  console.error(e);
  debug.error = String(e);
});
