import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import {
  DEG,
  enuFrame,
  ecefToGeodetic,
  ecefToLocal,
  geodeticToEcef,
  localToEcef,
} from '../geo/ellipsoid';
import { wgs84ToLv95 } from '../geo/lv95';
import { TerrainLoader } from '../terrain/TerrainLoader';
import { regionCenter, regionTiles } from '../terrain/region';
import { loadTerrainSource } from '../terrain/sources';

/** Sun for phase 1: fixed late afternoon light from the west-south-west. */
const SUN_AZIMUTH = 240 * DEG;
const SUN_ELEVATION = 22 * DEG;

const LOOK_AT = { lon: 7.9625, lat: 46.5367, h: 2600 }; // Jungfrau
const START = { lon: 7.9, lat: 46.665, h: 4200 }; // above Interlaken

export interface WorldStats {
  fps: number;
  frameMs: number;
  calls: number;
  triangles: number;
  textures: number;
  geometries: number;
  tilesLoaded: number;
  tilesTotal: number;
  tilesFailed: number;
  requestsInFlight: number;
  queued: number;
  altitude: number;
  lv95: [number, number];
  reversedDepth: boolean;
}

function supportsClipControl(): boolean {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ok = !!gl?.getExtension('EXT_clip_control');
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return ok;
}

export class World {
  readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly sky = new Sky();
  private readonly frame = enuFrame(...regionCenter(), 0);
  private terrain?: TerrainLoader;
  private running = false;
  private active = false;
  private raf = 0;
  private lastTime = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fps = 0;
  private frameMs = 0;
  private readonly reversedDepth: boolean;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.reversedDepth = supportsClipControl();
    this.renderer = new WebGLRenderer({
      canvas,
      // MSAA is expensive on integrated GPUs; post-process AA follows in phase 5.
      antialias: false,
      powerPreference: 'high-performance',
      // Reversed-Z keeps depth precise from 3 m to 600 km. Without it, fall back to a log buffer.
      reversedDepthBuffer: this.reversedDepth,
      logarithmicDepthBuffer: !this.reversedDepth,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;

    this.camera = new PerspectiveCamera(55, 1, 3, 600_000);
    this.camera.position.copy(this.local(START.lon, START.lat, START.h));

    const sunDir = new Vector3(
      Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
      Math.sin(SUN_ELEVATION),
      -Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH),
    );

    // Sky dome: drawn first (renderOrder) and without depth writes, so terrain always covers it.
    this.sky.scale.setScalar(450_000);
    this.sky.renderOrder = -1;
    const u = this.sky.material.uniforms;
    u.turbidity!.value = 3;
    u.rayleigh!.value = 1.2;
    u.mieCoefficient!.value = 0.004;
    u.mieDirectionalG!.value = 0.85;
    // The built-in sky clouds cost ~6 ms per frame on Intel UHD; own cheap clouds follow in phase 5.
    u.cloudCoverage!.value = 0;
    u.sunPosition!.value.copy(sunDir);
    this.scene.add(this.sky);

    // The orthophotos already contain real shadows, so direct light stays soft and ambient high.
    const sun = new DirectionalLight(0xfff1dc, 2.2);
    sun.position.copy(sunDir).multiplyScalar(10_000);
    this.scene.add(sun, sun.target);
    this.scene.add(new HemisphereLight(0xdfe9ff, 0x8a7a66, 2.6));

    // Haze for distance; colour close to the sky near the horizon.
    const haze = new Color(0x9fb3c8);
    this.scene.fog = new FogExp2(haze, 1 / 65_000);
    this.scene.background = haze;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.local(LOOK_AT.lon, LOOK_AT.lat, LOOK_AT.h));
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 300;
    this.controls.maxDistance = 120_000;
    this.controls.maxPolarAngle = 88 * DEG;
    this.controls.zoomSpeed = 1.2;
    this.controls.update();

    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
  }

  /** Starts streaming the phase 1 region. onProgress gets (loaded, total). */
  async init(onProgress: (loaded: number, total: number) => void) {
    const source = await loadTerrainSource();
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.terrain = new TerrainLoader(source, this.frame, anisotropy);
    this.scene.add(this.terrain.group);

    const target = this.controls.target;
    const tiles = regionTiles().map((key) => {
      const span = 180 / 2 ** key.z;
      const c = this.local(-180 + (key.x + 0.5) * span, -90 + (key.y + 0.5) * span, 0);
      const km = Math.hypot(c.x - target.x, c.z - target.z) / 1000;
      // Close tiles first; coarse far tiles get a boost so the horizon fills in early.
      return { key, priority: -(key.z >= 12 ? km : km * 0.35) };
    });
    this.terrain.load(tiles, () => {
      const s = this.terrain!.stats;
      onProgress(s.loaded + s.failed, s.total);
    });
  }

  /** Shows the world: renders until stop(). Pauses by itself while the tab is hidden. */
  start() {
    this.active = true;
    this.run();
  }

  stop() {
    this.active = false;
    this.halt();
  }

  private run() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dt = now - this.lastTime;
      this.lastTime = now;
      this.fpsAcc += dt;
      this.fpsFrames++;
      if (this.fpsAcc >= 500) {
        this.fps = (this.fpsFrames * 1000) / this.fpsAcc;
        this.frameMs = this.fpsAcc / this.fpsFrames;
        this.fpsAcc = 0;
        this.fpsFrames = 0;
      }
      this.controls.update();
      this.sky.position.copy(this.camera.position);
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private halt() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  stats(): WorldStats {
    const info = this.renderer.info;
    const ecef = localToEcef(
      this.frame,
      this.camera.position.x,
      this.camera.position.y,
      this.camera.position.z,
    );
    const [lon, lat, h] = ecefToGeodetic(...ecef);
    const t = this.terrain?.stats;
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      calls: info.render.calls,
      triangles: info.render.triangles,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      tilesLoaded: t?.loaded ?? 0,
      tilesTotal: t?.total ?? 0,
      tilesFailed: t?.failed ?? 0,
      requestsInFlight: (t?.terrainInFlight ?? 0) + (t?.imageryInFlight ?? 0),
      queued: t?.queued ?? 0,
      altitude: h,
      lv95: wgs84ToLv95(lon, lat),
      reversedDepth: this.reversedDepth,
    };
  }

  private local(lon: number, lat: number, h: number): Vector3 {
    return new Vector3(...ecefToLocal(this.frame, ...geodeticToEcef(lon, lat, h)));
  }

  private readonly resize = () => {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private readonly onVisibility = () => {
    if (document.hidden) this.halt();
    else if (this.active) this.run();
  };
}
