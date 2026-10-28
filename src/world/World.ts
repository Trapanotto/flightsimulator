import {
  Color,
  DirectionalLight,
  Frustum,
  HemisphereLight,
  PCFSoftShadowMap,
  Matrix4,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import {
  DEG,
  type EnuFrame,
  ecefDirToLocal,
  ecefToGeodetic,
  ecefToLocal,
  enuFrame,
  geodeticToEcef,
  localToEcef,
} from '../geo/ellipsoid';
import { wgs84ToLv95 } from '../geo/lv95';
import {
  type Quality,
  type QualityLevel,
  type Settings,
  WEATHER_COVERAGE,
  loadSettings,
  resolveQuality,
  timeSpec,
} from '../core/settings';
import { BuildingLayer } from '../buildings/BuildingLayer';
import { updateRunways } from './runwayMarkings';
import { Atmosphere } from '../render/Atmosphere';
import { CloudLayer } from '../render/CloudLayer';
import { PostFX } from '../render/PostFX';
import { SunFlare } from '../render/SunFlare';
import { resolveTime } from '../render/sun';
import { DEFAULT_TERRAIN, TerrainEngine } from '../terrain/TerrainEngine';
import { loadTerrainSource } from '../terrain/sources';
import type { Quality as WorldQuality } from '../core/settings';

/** Something that drives the camera and the floating origin: the flight game or the showcase. */
export interface WorldDriver {
  update(dt: number): void;
  /** The point the floating origin follows. */
  readonly anchor: Vector3;
  /** While true, the camera (not the anchor) is the origin. */
  readonly waitingForTerrain: boolean;
  rebase(delta: Vector3): void;
  applyQuality(q: WorldQuality): void;
}
import { type Basis, FreeCamera } from './FreeCamera';
import { PLACES, type Place, TEST_ROUTE } from './places';

/** Base frame: centre of Switzerland. Its axes stay fixed; only the origin moves (floating origin). */
const BASE = { lon: 8.2275, lat: 46.8182 };
/** Re-centre the render origin when the camera is this far from it. */
const REBASE_DISTANCE = 5000;

export interface WorldStats {
  fps: number;
  frameMs: number;
  worstFrameMs: number;
  /** Pixel ratio we render at (full device resolution, capped at 2). */
  pixelRatio: number;
  /** CPU ms per frame: our update / three.js render call. */
  tickMs: number;
  renderMs: number;
  calls: number;
  triangles: number;
  textures: number;
  geometries: number;
  tilesRendered: number;
  tilesReady: number;
  tilesLoading: number;
  tilesFailed: number;
  maxZoom: number;
  /** Share of drawn tiles already at their wanted detail (1 = nothing pending). */
  coverage: number;
  uploads: number;
  requestsInFlight: number;
  queued: number;
  altitude: number;
  agl: number | undefined;
  speedKmh: number;
  lv95: [number, number];
  originKm: number;
  reversedDepth: boolean;
  quality: QualityLevel;
  sunElevation: number;
  route?: RouteStats;
}

export interface RouteStats {
  leg: number;
  legs: number;
  distanceKm: number;
  seconds: number;
  frames: number;
  /** Frames where some drawn tile was still waiting for more detail. */
  pendingFrames: number;
  minCoverage: number;
  worstFrameMs: number;
  done: boolean;
}

function supportsClipControl(): boolean {
  // ?depth=log forces the logarithmic depth buffer (debugging).
  if (location.search.includes('depth=log')) return false;
  const gl = document.createElement('canvas').getContext('webgl2');
  const ok = !!gl?.getExtension('EXT_clip_control');
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return ok;
}

const TIME_SCALE = Math.min(
  5,
  Math.max(1, Number(new URLSearchParams(location.search).get('timescale')) || 1),
);
export class World {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly fly: FreeCamera;
  readonly sky = new Sky();
  readonly atmosphere: Atmosphere;
  readonly clouds: CloudLayer;
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly post: PostFX;
  readonly flare: SunFlare;
  settings: Settings;
  quality: Quality;
  qualityLevel: QualityLevel;
  private flareOcclusion = 0;
  private frameCount = 0;
  readonly frame: EnuFrame = enuFrame(BASE.lon, BASE.lat, 0);
  terrain?: TerrainEngine;
  buildings?: BuildingLayer;
  private running = false;
  private active = false;
  private raf = 0;
  private lastTime = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fps = 0;
  private frameMs = 0;
  private worstMs = 0;
  private worstAcc = 0;
  private basePixelRatio = 1;
  private tickMs = 0;
  private renderMs = 0;
  private readonly reversedDepth: boolean;
  private readonly frustum = new Frustum();
  private readonly projView = new Matrix4();
  private readonly basis: Basis = { up: new Vector3(), north: new Vector3(), east: new Vector3() };
  private readonly forward = new Vector3();
  /** Render origin relative to the base frame origin: render = base - shift. */
  private readonly shift = new Vector3();
  private geo: [number, number, number] = [0, 0, 0];
  private ground: number | undefined;
  private route?: { leg: number; stats: RouteStats; speed: number };
  /** When set, the world is in flight mode: the game moves the camera and anchors the origin. */
  game?: WorldDriver;

  constructor(readonly canvas: HTMLCanvasElement) {
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
    this.settings = loadSettings();
    const { level, quality } = resolveQuality(this.settings);
    this.qualityLevel = level;
    this.quality = quality;
    this.basePixelRatio = Math.min(window.devicePixelRatio, quality.maxPixelRatio);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.camera = new PerspectiveCamera(60, 1, 3, 600_000);
    this.fly = new FreeCamera(this.camera, canvas);

    this.atmosphere = new Atmosphere(resolveTime(timeSpec(this.settings)), BASE.lat, BASE.lon);

    // Sky dome: drawn first (renderOrder) and without depth writes, so terrain always covers it.
    this.sky.scale.setScalar(450_000);
    this.sky.renderOrder = -1;
    // The built-in sky clouds cost ~6 ms per frame on Intel UHD; we draw our own cloud deck.
    this.sky.material.uniforms.cloudCoverage!.value = 0;
    this.scene.add(this.sky);

    // Lights are tuned for PBR materials (aircraft). The orthophotos are dark and already contain
    // shadows, so the terrain material brightens itself instead (TERRAIN_GAIN).
    this.sun = new DirectionalLight(0xfff1dc, 1.1);
    this.sun.shadow.camera.left = this.sun.shadow.camera.bottom = -14;
    this.sun.shadow.camera.right = this.sun.shadow.camera.top = 14;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 800;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new HemisphereLight(0xdfe9ff, 0x8a7a66, 1.3);
    this.scene.add(this.hemi);
    this.scene.background = new Color(0x9fb3c8);

    this.clouds = new CloudLayer(this.atmosphere.uniforms, quality.cloudLayers);
    this.scene.add(this.clouds.group);
    this.post = new PostFX(this.renderer, this.scene, this.camera);
    this.flare = new SunFlare(document.body);
    this.applySettings(this.settings);

    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
    this.goTo(PLACES[3]!);
  }

  async init() {
    const source = await loadTerrainSource();
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    // Tuning knobs for testing, e.g. ?tau=8&uploads=2&tiles=300
    const q = new URLSearchParams(location.search);
    const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
    const q2 = this.quality;
    this.terrain = new TerrainEngine(
      source,
      this.frame,
      anisotropy,
      this.atmosphere.uniforms,
      { detail: q2.terrainDetail, cloudShadows: q2.cloudShadows, water: q2.water },
      {
        ...DEFAULT_TERRAIN,
        tau: num('tau', q2.tau),
        maxZoom: q2.maxZoom,
        uploadsPerFrame: num('uploads', DEFAULT_TERRAIN.uploadsPerFrame),
        maxTiles: num('tiles', q2.maxTiles),
      },
    );
    this.terrain.setReceiveShadow(q2.shadowMap > 0);
    this.buildings = new BuildingLayer(this, this.atmosphere.uniforms);
    this.buildings.radius = q2.buildingRadius;
    this.buildings.treeRadius = q2.treeRadius;
    this.buildings.treeSpacing = q2.treeSpacing;
    this.scene.add(this.buildings.group);
    this.terrain.rebase(this.shift);
    this.scene.add(this.terrain.group);
  }

  /** Shows the world: renders until stop(). Pauses by itself while the tab is hidden. */
  start() {
    this.active = true;
    this.flare.el.hidden = false;
    // The canvas may have been hidden (zero size) when the world was built.
    this.resize();
    this.run();
  }

  stop() {
    this.active = false;
    this.flare.el.hidden = true;
    this.halt();
  }

  /** Applies settings: quality preset, time of day, weather. Safe to call at any time. */
  applySettings(s: Settings) {
    this.settings = s;
    const { level, quality } = resolveQuality(s);
    this.qualityLevel = level;
    this.quality = quality;
    this.basePixelRatio = Math.min(window.devicePixelRatio, quality.maxPixelRatio);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.shadowMap.enabled = quality.shadowMap > 0;
    if (quality.shadowMap > 0) {
      this.sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.castShadow = quality.shadowMap > 0;
    this.atmosphere.setDate(resolveTime(timeSpec(s)));
    this.atmosphere.apply(this.sun, this.hemi, this.sky);
    this.renderer.toneMappingExposure = this.atmosphere.exposure;
    this.atmosphere.uniforms.uCloudCoverage.value = WEATHER_COVERAGE[s.weather];
    this.clouds.setLayers(quality.cloudLayers);
    this.post.configure(quality);
    this.flare.enabled = quality.flare;
    this.terrain?.applyQuality(quality);
    if (this.buildings) {
      this.buildings.radius = quality.buildingRadius;
      this.buildings.treeRadius = quality.treeRadius;
      this.buildings.treeSpacing = quality.treeSpacing;
    }
    this.game?.applyQuality(quality);
    this.resize();
  }

  goTo(p: Place) {
    this.route = undefined;
    this.fly.autoForward = false;
    this.camera.position.copy(this.fromGeo(p.lon, p.lat, p.h));
    this.fly.yaw = p.heading * DEG;
    this.fly.pitch = (p.pitch ?? -8) * DEG;
    this.rebaseIfNeeded(true);
    this.updateBasis();
    this.fly.aim(this.basis);
  }

  /** Autopilot along TEST_ROUTE at `kmh` (default 500 km/h) to check streaming. */
  startRoute(kmh = 500) {
    const a = TEST_ROUTE[0]!;
    this.goTo({ name: 'route', lon: a.lon, lat: a.lat, h: a.h, heading: 45 });
    this.route = {
      leg: 1,
      speed: kmh / 3.6,
      stats: {
        leg: 1,
        legs: TEST_ROUTE.length - 1,
        distanceKm: 0,
        seconds: 0,
        frames: 0,
        pendingFrames: 0,
        minCoverage: 1,
        worstFrameMs: 0,
        done: false,
      },
    };
  }

  stopRoute() {
    this.route = undefined;
  }

  get routeActive() {
    return !!this.route && !this.route.stats.done;
  }

  stats(): WorldStats {
    const info = this.renderer.info;
    const t = this.terrain;
    const ts = t?.tree.stats;
    const rendered = ts?.rendered ?? 0;
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      worstFrameMs: this.worstMs,
      pixelRatio: this.basePixelRatio,
      tickMs: this.tickMs,
      renderMs: this.renderMs,
      calls: info.render.calls,
      triangles: info.render.triangles,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      tilesRendered: rendered,
      tilesReady: ts?.ready ?? 0,
      tilesLoading: ts?.loading ?? 0,
      tilesFailed: t?.failed ?? 0,
      maxZoom: ts?.maxZoomRendered ?? 0,
      coverage: rendered ? 1 - (ts?.pending ?? 0) / rendered : 0,
      uploads: t?.pendingUploads ?? 0,
      requestsInFlight: t?.inFlight ?? 0,
      queued: t?.queued ?? 0,
      altitude: this.geo[2],
      agl: this.ground === undefined ? undefined : this.geo[2] - this.ground,
      speedKmh: (this.route ? this.route.speed : this.fly.velocity.length()) * 3.6,
      lv95: wgs84ToLv95(this.geo[0], this.geo[1]),
      originKm: this.shift.length() / 1000,
      reversedDepth: this.reversedDepth,
      quality: this.qualityLevel,
      sunElevation: this.atmosphere.sunElevation,
      route: this.route?.stats,
    };
  }

  // ---- loop ----

  private run() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dtMs = now - this.lastTime;
      this.lastTime = now;
      const dt = Math.min(dtMs, 100) / 1000;
      this.measure(dtMs);
      const t0 = performance.now();
      this.tick(dt, dtMs);
      const t1 = performance.now();
      this.post.render(dt);
      const t2 = performance.now();
      // Smoothed CPU cost of our update and of three.js render submission.
      this.tickMs += (t1 - t0 - this.tickMs) * 0.05;
      this.renderMs += (t2 - t1 - this.renderMs) * 0.05;
    };
    this.raf = requestAnimationFrame(loop);
  }

  /**
   * Video capture (tools/capture-showcase.mjs): one frame with a fixed time step while the
   * loop is stopped, so the recording is smooth however slow each frame is to grab.
   */
  captureFrame(dt: number) {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.tick(dt, dt * 1000);
    this.post.render(dt);
  }

  private tick(dt: number, dtMs: number) {
    this.updateBasis();
    // ?timescale=3 runs the flight faster (automated test flights only).
    if (this.game) this.game.update(dt * TIME_SCALE);
    else if (this.route) this.flyRoute(dt, dtMs);
    else this.fly.update(dt, this.basis, this.geo[2], this.ground);
    this.rebaseIfNeeded();
    updateRunways(this, this.geo[0], this.geo[1]);
    this.sky.position.copy(this.camera.position);
    this.updateEnvironment(dt);
    this.buildings?.update(performance.now());

    this.camera.updateMatrixWorld();
    this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.camera.getWorldDirection(this.forward);
    this.terrain?.update(
      this.camera.position,
      this.forward,
      this.frustum,
      this.canvas.clientHeight * this.basePixelRatio,
      this.camera.fov * DEG,
    );
  }

  private flyRoute(dt: number, dtMs: number) {
    const r = this.route!;
    const s = r.stats;
    if (s.done) return;
    const wp = TEST_ROUTE[r.leg]!;
    const toTarget = this.fromGeo(wp.lon, wp.lat, wp.h).sub(this.camera.position);
    const up = this.basis.up;
    const horizontal = toTarget.addScaledVector(up, -toTarget.dot(up));
    const dist = horizontal.length();

    if (dist < 1500) {
      r.leg++;
      s.leg = Math.min(r.leg, s.legs);
      if (r.leg >= TEST_ROUTE.length) s.done = true;
      return;
    }
    // Head for the waypoint and look slightly down at the terrain.
    const dir = horizontal.normalize();
    this.fly.yaw = Math.atan2(dir.dot(this.basis.east), dir.dot(this.basis.north));
    this.fly.pitch = -10 * DEG;
    const step = r.speed * dt;
    this.camera.position.addScaledVector(dir, step);
    // Climb/descend towards the waypoint height, but stay 300 m above ground.
    const want = Math.max(wp.h, (this.ground ?? 0) + 300);
    this.camera.position.addScaledVector(up, Math.max(-15, Math.min(25, want - this.geo[2])) * dt);
    this.fly.aim(this.basis);

    s.distanceKm += step / 1000;
    s.seconds += dt;
    s.frames++;
    const ts = this.terrain?.tree.stats;
    // Ignore the first seconds while the start area loads.
    if (ts && ts.rendered && s.seconds > 10) {
      if (ts.pending > 0) s.pendingFrames++;
      s.minCoverage = Math.min(s.minCoverage, 1 - ts.pending / ts.rendered);
      s.worstFrameMs = Math.max(s.worstFrameMs, dtMs);
    }
  }

  /** Clouds, shadow camera, sun glare: everything that follows the camera or the aircraft. */
  private updateEnvironment(dt: number) {
    const camGeo = this.toGeo(this.camera.position);
    this.atmosphere.tick(dt, this.shift, camGeo[2]);
    const u = this.atmosphere.uniforms;
    const sunDir = u.uSunDir.value;

    const cloudBase = this.fromGeo(camGeo[0], camGeo[1], u.uCloudAltitude.value);
    this.clouds.update(cloudBase, this.upAt(this.camera.position, new Vector3()), camGeo[2]);

    // The shadow map only covers the aircraft and its surroundings.
    if (this.sun.castShadow) {
      const anchor =
        this.game && !this.game.waitingForTerrain ? this.game.anchor : this.camera.position;
      this.sun.target.position.copy(anchor);
      this.sun.position.copy(anchor).addScaledVector(sunDir, 300);
      this.sun.target.updateMatrixWorld();
    } else {
      this.sun.position.copy(sunDir).multiplyScalar(10_000);
      this.sun.target.position.set(0, 0, 0);
    }

    // Sun glare: hidden behind mountains or clouds (checked every few frames).
    if (this.flare.enabled && this.frameCount++ % 6 === 0)
      this.flareOcclusion = this.sunOcclusion(camGeo[2]);
    this.flare.update(dt, this.camera, sunDir, this.flareOcclusion);
  }

  private sunOcclusion(cameraElevation: number): number {
    const sunDir = this.atmosphere.uniforms.uSunDir.value;
    if (this.atmosphere.sunElevation < -1) return 1;
    const p = new Vector3();
    for (const d of [150, 400, 900, 1800, 3500, 6000, 10_000, 16_000, 25_000, 40_000]) {
      p.copy(this.camera.position).addScaledVector(sunDir, d);
      const h = this.heightAboveGround(p);
      if (h !== undefined && h < 0) return 1;
    }
    const u = this.atmosphere.uniforms;
    const toCloud = (u.uCloudAltitude.value - cameraElevation) / Math.max(sunDir.y, 0.05);
    if (toCloud > 0 && u.uCloudCoverage.value > 0) {
      p.copy(this.camera.position).addScaledVector(sunDir, toCloud);
      const s = this.shift;
      return Math.min(1, this.atmosphere.cloudDensityAt(p.x + s.x, p.z + s.z) * 1.2);
    }
    return 0;
  }

  private measure(dtMs: number) {
    this.fpsAcc += dtMs;
    this.fpsFrames++;
    this.worstAcc = Math.max(this.worstAcc, dtMs);
    if (this.fpsAcc >= 500) {
      this.fps = (this.fpsFrames * 1000) / this.fpsAcc;
      this.frameMs = this.fpsAcc / this.fpsFrames;
      this.worstMs = this.worstAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
      this.worstAcc = 0;
    }
  }

  private halt() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  // ---- coordinates ----

  /** Geodetic -> render coordinates. */
  fromGeo(lon: number, lat: number, h: number): Vector3 {
    return new Vector3(...ecefToLocal(this.frame, ...geodeticToEcef(lon, lat, h))).sub(this.shift);
  }

  /** Render coordinates -> [lon, lat, h]. */
  toGeo(p: Vector3): [number, number, number] {
    const s = this.shift;
    return ecefToGeodetic(...localToEcef(this.frame, p.x + s.x, p.y + s.y, p.z + s.z));
  }

  private updateBasis() {
    this.geo = this.toGeo(this.camera.position);
    const lon = this.geo[0] * DEG;
    const lat = this.geo[1] * DEG;
    const sl = Math.sin(lon);
    const cl = Math.cos(lon);
    const sp = Math.sin(lat);
    const cp = Math.cos(lat);
    this.basis.up.set(...ecefDirToLocal(this.frame, cp * cl, cp * sl, sp));
    this.basis.north.set(...ecefDirToLocal(this.frame, -sp * cl, -sp * sl, cp));
    this.basis.east.set(...ecefDirToLocal(this.frame, -sl, cl, 0));
    this.ground = this.terrain?.tree.heightAt(this.geo[0], this.geo[1]);
  }

  /**
   * Floating origin: move everything so the anchor (camera, or the aircraft in flight mode)
   * sits at (0,0,0) again.
   */
  private rebaseIfNeeded(force = false) {
    const anchor =
      this.game && !this.game.waitingForTerrain ? this.game.anchor : this.camera.position;
    if (!force && anchor.length() < REBASE_DISTANCE) return;
    const delta = anchor.clone();
    this.shift.add(delta);
    this.terrain?.rebase(delta);
    this.buildings?.rebase(delta);
    this.camera.position.sub(delta);
    this.game?.rebase(delta);
  }

  // ---- queries for the flight game (render coordinates) ----

  /** Render origin relative to the base frame (render = base - shift). */
  get originShift(): Vector3 {
    return this.shift;
  }

  /** Local vertical at a point. */
  upAt(p: Vector3, out: Vector3): Vector3 {
    const [lon, lat] = this.toGeo(p);
    const l = lon * DEG;
    const b = lat * DEG;
    return out.set(
      ...ecefDirToLocal(
        this.frame,
        Math.cos(b) * Math.cos(l),
        Math.cos(b) * Math.sin(l),
        Math.sin(b),
      ),
    );
  }

  /** Local up/north/east at a point. */
  basisAt(p: Vector3): Basis {
    const [lon, lat] = this.toGeo(p);
    const sl = Math.sin(lon * DEG);
    const cl = Math.cos(lon * DEG);
    const sp = Math.sin(lat * DEG);
    const cp = Math.cos(lat * DEG);
    return {
      up: new Vector3(...ecefDirToLocal(this.frame, cp * cl, cp * sl, sp)),
      north: new Vector3(...ecefDirToLocal(this.frame, -sp * cl, -sp * sl, cp)),
      east: new Vector3(...ecefDirToLocal(this.frame, -sl, cl, 0)),
    };
  }

  /** Terrain height (m) at lon/lat from the loaded tiles. */
  groundAt(lon: number, lat: number): number | undefined {
    return this.terrain?.tree.heightAt(lon, lat);
  }

  /** Zoom level of the most detailed loaded tile at lon/lat (0 if none). */
  terrainDetailAt(lon: number, lat: number): number {
    return this.terrain?.tree.detailAt(lon, lat) ?? 0;
  }

  heightAboveGround(p: Vector3): number | undefined {
    const [lon, lat, h] = this.toGeo(p);
    const g = this.groundAt(lon, lat);
    return g === undefined ? undefined : h - g;
  }

  /** Moves the camera (and with it the streaming focus) to a place. */
  moveCameraTo(lon: number, lat: number, h: number) {
    this.camera.position.copy(this.fromGeo(lon, lat, h));
    this.rebaseIfNeeded(true);
    const b = this.basisAt(this.camera.position);
    this.camera.up.copy(b.up);
    this.camera.lookAt(this.camera.position.clone().add(b.north).addScaledVector(b.up, -0.3));
  }

  private readonly resize = () => {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private readonly onVisibility = () => {
    if (document.hidden) this.halt();
    else if (this.active) this.run();
  };
}
