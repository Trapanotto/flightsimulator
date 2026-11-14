/**
 * Stand-alone page for the airports: the real World (terrain and all layers) and the real Sky
 * with its post-processing chain, wired like src/app/App.ts, and camera presets at any airport.
 * Served by Vite at /flightsimulator/demo/airports.html.
 *
 * URL switches:
 *   ?airport=LSZB          ICAO code (default LSZB)
 *   ?rwy=14                runway end the views refer to (default: the first end)
 *   ?view=eye              eye      1.2 m above the threshold, looking down the runway
 *                          final100 / final1500   on a 3 degree path, 100 m / 1.5 km out
 *                          app5k    3 degrees from 5 km; low (2 degrees) and high (4 degrees)
 *                          overhead 600 m above the middle of the runway
 *                          far      15 km out on the extended centre line, 3 degrees
 *                          taxi     on a taxiway near the threshold, 3 m up
 *                          side     200 m beside the runway, 30 m up, looking across
 *                          thr      140 m above, just before the threshold, looking down at it
 *   ?fov=8                 vertical field of view in degrees (binoculars for the PAPI at 5 km)
 *   ?time=13               Swiss local hour (decimal), today's date in June (default 13)
 *   ?device=mobile         mobile presets
 *   ?webgl=1               force the WebGL 2 fallback
 *   ?noairports=1          hide the airport layer (for comparing frame times)
 *   ?clean=1               hide the text overlay
 *
 * window.__demo exposes the state for tools/airports/shots.mjs.
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
import {
  type AirportInfo,
  LocalFrame,
  bearingDeg,
  ellipsoidToSeaLevel,
  findAirport,
  findRunwayEnd,
  offsetPoint,
  seaLevelToEllipsoid,
  thresholdOf,
} from '@geo';
import { SKY_QUALITY, Sky, WEATHER_PRESETS } from '@sky';
import { WORLD_QUALITY, World } from '@world';

const query = new URLSearchParams(location.search);
const mobile = query.get('device') === 'mobile';
if (query.has('clean')) document.body.classList.add('clean');
const airport: AirportInfo = findAirport(query.get('airport') ?? 'LSZB') ?? findAirport('LSZB')!;
const rwyIdent = query.get('rwy') ?? airport.runways[0]!.ends[0].ident;
const runwayEnd =
  findRunwayEnd(airport, rwyIdent) ?? findRunwayEnd(airport, airport.runways[0]!.ends[0].ident)!;
const viewName = query.get('view') ?? 'eye';
const hour = Number(query.get('time') ?? '13');

// ---- renderer, like the app ----
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const renderer = new WebGPURenderer({
  canvas,
  antialias: false,
  powerPreference: 'high-performance',
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

const quality = WORLD_QUALITY[mobile ? 'mobile' : 'desktop'];
const scene = new Scene();
const camera = new PerspectiveCamera(55, 1, 0.1, quality.viewDistance * 1.5);

// ---- the view ----
const { end, opposite, runway } = runwayEnd;
const heading = bearingDeg(end, opposite);
const threshold = thresholdOf(end, opposite);
const elevation = end.elevation ?? airport.elevation;
const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
/** Aim point of the approach: where a 3 degree path from the PAPI meets the runway. */
const aimDistance = runway.length >= 1800 ? 300 : runway.length >= 1200 ? 250 : 180;
const aim = offsetPoint(threshold, heading, aimDistance);
interface View {
  lon: number;
  lat: number;
  /** Height above the ground (agl) or above sea level. */
  h: number;
  agl: boolean;
  look: { lon: number; lat: number; h: number; agl: boolean };
}
const onPath = (distOut: number, angle: number): View => {
  const p = offsetPoint(threshold, heading + 180, distOut);
  return {
    ...p,
    h: elevation + (distOut + aimDistance) * tan(angle),
    agl: false,
    look: { ...aim, h: elevation, agl: false },
  };
};
const mid = offsetPoint(end, heading, runway.length / 2);
const VIEWS: Record<string, () => View> = {
  eye: () => ({
    ...offsetPoint(threshold, heading, 0.5),
    h: 1.2,
    agl: true,
    look: { ...offsetPoint(threshold, heading, 2000), h: 1.2, agl: true },
  }),
  final100: () => onPath(100, 3),
  final1500: () => onPath(1500, 3),
  app5k: () => onPath(5000, 3),
  low: () => onPath(5000, 2),
  high: () => onPath(5000, 4),
  far: () => onPath(15000, 3),
  overhead: () => ({
    ...offsetPoint(mid, heading + 180, 250),
    h: 600,
    agl: true,
    look: { ...offsetPoint(mid, heading, 100), h: 0, agl: true },
  }),
  thr: () => ({
    ...offsetPoint(threshold, heading + 180, 60),
    h: 140,
    agl: true,
    look: { ...offsetPoint(threshold, heading, 50), h: 0, agl: true },
  }),
  // ?view=look&along=150&up=25&back=40: looking at the centre line `along` metres past the
  // threshold from `back` metres before that point and `up` metres high.
  look: () => {
    const along = Number(query.get('along') ?? '150');
    const target = offsetPoint(threshold, heading, along);
    return {
      ...offsetPoint(target, heading + 180, Number(query.get('back') ?? '40')),
      h: Number(query.get('up') ?? '25'),
      agl: true,
      look: { ...target, h: 0, agl: true },
    };
  },
  side: () => ({
    ...offsetPoint(offsetPoint(end, heading, runway.length * 0.12), heading - 90, 200),
    h: 30,
    agl: true,
    look: { ...offsetPoint(end, heading, runway.length * 0.12 + 10), h: 0, agl: true },
  }),
  taxi: () => taxiView ?? VIEWS.side!(),
};
let taxiView: View | undefined;
if (viewName === 'taxi' && airport.detail) {
  // The taxiway point nearest the threshold, looking along the taxiway.
  const r = await fetch(`${import.meta.env.BASE_URL}assets/world/airports/${airport.icao}.json`);
  const d = (await r.json()) as {
    origin: [number, number];
    scale: number;
    taxiways: Array<{ c: number[] }>;
  };
  let best = Infinity;
  for (const t of d.taxiways)
    for (let i = 0; i + 3 < t.c.length; i += 2) {
      const a = { lon: d.origin[0] + t.c[i]! * d.scale, lat: d.origin[1] + t.c[i + 1]! * d.scale };
      const b = {
        lon: d.origin[0] + t.c[i + 2]! * d.scale,
        lat: d.origin[1] + t.c[i + 3]! * d.scale,
      };
      const dist = Math.hypot((a.lon - threshold.lon) * 75000, (a.lat - threshold.lat) * 111000);
      const len = Math.hypot((a.lon - b.lon) * 75000, (a.lat - b.lat) * 111000);
      if (dist < best && len > 25) {
        best = dist;
        const brg = bearingDeg(a, b);
        taxiView = {
          ...a,
          h: 3,
          agl: true,
          look: { ...offsetPoint(a, brg, 150), h: 0, agl: true },
        };
      }
    }
}
const view = (VIEWS[viewName] ?? VIEWS.eye!)();

// ---- world and sky, like the app ----
const date = new Date(Date.UTC(2026, 5, 21, 0, 0, 0) + (hour - 2) * 3600_000);
let frame = new LocalFrame(view.lon, view.lat, seaLevelToEllipsoid(view.lon, view.lat, elevation));
const sky = new Sky(date, view.lon, view.lat, SKY_QUALITY[mobile ? 'mobile' : 'desktop']);
sky.setWeather(WEATHER_PRESETS.clear);
const world = new World(frame, quality);
scene.add(sky.object, world.object);
scene.environment = sky.environment;
const scenePass = pass(scene, camera);
const pipeline = new RenderPipeline(renderer);
pipeline.outputNode = sky.post(
  scenePass.getTextureNode('output'),
  scenePass.getTextureNode('depth'),
  camera,
);

const airportsGroup = world.object.getObjectByName('Airports') as Object3D;
const layer = airportsGroup.userData.layer as {
  stats(): {
    airports: number;
    shown: number;
    vertices: number;
    triangles: number;
    lights: number;
    draws: number;
  };
  loading: boolean;
};
if (query.has('noairports')) airportsGroup.visible = false;

const nightFactor = (sunElevation: number) => {
  const t = Math.min(1, Math.max(0, (2 - sunElevation) / 8));
  return t * t * (3 - 2 * t);
};

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

const ground = (lon: number, lat: number) => world.groundHeight(lon, lat);
const heightOf = (p: { lon: number; lat: number; h: number; agl: boolean }) => {
  if (!p.agl) return seaLevelToEllipsoid(p.lon, p.lat, p.h);
  const g = ground(p.lon, p.lat);
  return (g ?? seaLevelToEllipsoid(p.lon, p.lat, elevation)) + p.h;
};
const placeCamera = () => {
  frame.fromGeodetic(view.lon, view.lat, heightOf(view), camera.position);
  const t = frame.fromGeodetic(view.look.lon, view.look.lat, heightOf(view.look), new Vector3());
  camera.up.set(0, 1, 0);
  camera.lookAt(t);
  camera.updateMatrixWorld();
};
placeCamera();

const stats = {
  ready: false,
  frames: 0,
  backend,
  airport: airport.icao,
  view: viewName,
  loading: true,
  worldLoading: true,
  airportsLoading: true,
  drawCalls: 0,
  triangles: 0,
  frameMs: 0,
  cpuMs: 0,
  /** Worst CPU time of one frame (update + render submission) after the first 30, ms. */
  cpuMaxMs: 0,
  /** Worst time of the airport layer alone in one frame, ms (measured around world.update with
   * and without it is not possible from outside; this is world.update as a whole). */
  updateMaxMs: 0,
  layer: layer.stats(),
  camera: { lon: 0, lat: 0, hAsl: 0 },
  sun: 0,
  /** The layer's internal state of one airport (for debugging from the console). */
  site: (icao: string) =>
    airportsGroup.getObjectByName(`Airport ${icao}`)?.userData.site as unknown,
  /** PAPI units of the airport: setting and the elevation angle the camera sees them at. */
  papi: () => {
    const out: Array<{ setting: number; elevation: number; distance: number }> = [];
    const site = airportsGroup.getObjectByName(`Airport ${airport.icao}`);
    const lights = site?.getObjectByName('Lights') as
      (Object3D & { geometry: { getAttribute(n: string): { array: Float32Array } } }) | undefined;
    if (!lights) return out;
    lights.updateWorldMatrix(true, false);
    const pos = lights.geometry.getAttribute('iPos').array;
    const par = lights.geometry.getAttribute('iParam').array;
    const up = new Vector3(0, 1, 0).transformDirection(lights.matrixWorld);
    for (let i = 0; i < par.length / 4; i++) {
      if (par[i * 4 + 2] !== 3) continue;
      const w = new Vector3(pos[i * 4]!, pos[i * 4 + 1]!, pos[i * 4 + 2]!).applyMatrix4(
        lights.matrixWorld,
      );
      const to = camera.position.clone().sub(w);
      const d = to.length();
      out.push({
        setting: par[i * 4 + 3]!,
        elevation: (Math.asin(to.dot(up) / d) * 180) / Math.PI,
        distance: d,
      });
    }
    return out;
  },
  /** Moves the render origin by (east, north) metres; the picture must not change. */
  rebase: (east: number, north: number) => {
    const o = frame.toGeodetic({ x: east, y: 0, z: -north });
    frame = new LocalFrame(o.lon, o.lat, o.h);
    world.setFrame(frame);
  },
  /** Renders n frames back to back and waits for the GPU: ms per frame. */
  bench: async (n: number, withAirports = true) => {
    const was = airportsGroup.visible;
    airportsGroup.visible = withAirports;
    const b = renderer.backend as unknown as { device?: GPUDevice; gl?: WebGL2RenderingContext };
    const finish = async () => {
      if (b.device) await b.device.queue.onSubmittedWorkDone();
      else if (b.gl) b.gl.readPixels(0, 0, 1, 1, b.gl.RGBA, b.gl.UNSIGNED_BYTE, new Uint8Array(4));
    };
    await finish();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      world.update(camera);
      pipeline.render();
    }
    await finish();
    airportsGroup.visible = was;
    return (performance.now() - t0) / n;
  },
};
(window as unknown as { __demo: typeof stats }).__demo = stats;

let last = performance.now();
let appTime = 0;
let frameAcc = 0;
let cpuAcc = 0;
let samples = 0;
renderer.setAnimationLoop((now: number) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  appTime += dt;
  const t0 = performance.now();
  placeCamera();
  world.setConditions({
    night: nightFactor(sky.state.sunElevation),
    exposure: sky.state.exposure,
    season: 'summer',
    snowLine: 2900,
    lightDirection: sky.state.lightDirection,
    time: appTime,
  });
  const tu = performance.now();
  world.update(camera);
  const updateMs = performance.now() - tu;
  const g = frame.toGeodetic(camera.position);
  sky.update(camera, {
    dt,
    altitude: ellipsoidToSeaLevel(g.lon, g.lat, g.h),
    origin: { x: 0, z: 0 },
  });
  sky.sun.target.position.copy(camera.position);
  sky.sun.position.copy(camera.position).addScaledVector(sky.state.lightDirection, 200);
  pipeline.render();
  const cpu = performance.now() - t0;

  stats.frames++;
  if (stats.frames > 30) {
    stats.cpuMaxMs = Math.max(stats.cpuMaxMs, cpu);
    stats.updateMaxMs = Math.max(stats.updateMaxMs, updateMs);
  }
  if (stats.frames > 5) stats.ready = true;
  stats.worldLoading = world.loading;
  stats.airportsLoading = layer.loading;
  stats.loading = world.loading;
  stats.layer = layer.stats();
  stats.drawCalls = renderer.info.render.drawCalls;
  stats.triangles = renderer.info.render.triangles;
  stats.camera = { lon: g.lon, lat: g.lat, hAsl: ellipsoidToSeaLevel(g.lon, g.lat, g.h) };
  stats.sun = sky.state.sunElevation;
  frameAcc += dt * 1000;
  cpuAcc += cpu;
  if (++samples >= 30) {
    stats.frameMs = frameAcc / samples;
    stats.cpuMs = cpuAcc / samples;
    frameAcc = cpuAcc = samples = 0;
  }
  if (stats.frames % 10 === 0) {
    const l = stats.layer;
    hud.textContent =
      `${backend}  ${mobile ? 'mobile' : 'desktop'}  ${airport.icao} ${end.ident} ${viewName}\n` +
      `${stats.loading ? 'loading' : 'done'}  sun ${stats.sun.toFixed(1)}°\n` +
      `airports ${l.shown}/${l.airports}  lights ${l.lights}  draws ${l.draws}\n` +
      `draw calls ${stats.drawCalls}  triangles ${(stats.triangles / 1e6).toFixed(2)} M\n` +
      `frame ${stats.frameMs.toFixed(1)} ms  cpu ${stats.cpuMs.toFixed(1)} ms`;
  }
});
