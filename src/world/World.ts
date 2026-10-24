import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  FogExp2,
  Frustum,
  HemisphereLight,
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
import { DEFAULT_TERRAIN, TerrainEngine } from '../terrain/TerrainEngine';
import { loadTerrainSource } from '../terrain/sources';
import type { FlightGame } from '../game/FlightGame';
import { type Basis, FreeCamera } from './FreeCamera';
import { PLACES, type Place, TEST_ROUTE } from './places';

/** Sun for now: fixed late afternoon light from the west-south-west. */
const SUN_AZIMUTH = 240 * DEG;
const SUN_ELEVATION = 22 * DEG;
/** Base frame: centre of Switzerland. Its axes stay fixed; only the origin moves (floating origin). */
const BASE = { lon: 8.2275, lat: 46.8182 };
/** Re-centre the render origin when the camera is this far from it. */
const REBASE_DISTANCE = 5000;
/** Lowest dynamic render scale (share of the base pixel ratio). */
const MIN_RENDER_SCALE = 0.6;

export interface WorldStats {
  fps: number;
  frameMs: number;
  worstFrameMs: number;
  renderScale: number;
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
  const gl = document.createElement('canvas').getContext('webgl2');
  const ok = !!gl?.getExtension('EXT_clip_control');
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return ok;
}

export class World {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly fly: FreeCamera;
  readonly sky = new Sky();
  readonly frame: EnuFrame = enuFrame(BASE.lon, BASE.lat, 0);
  terrain?: TerrainEngine;
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
  private renderScale = 1;
  private lastDownscale = 0;
  private lastUpscale = 0;
  private readonly basePixelRatio = Math.min(window.devicePixelRatio, 1.5);
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
  game?: FlightGame;

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
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;

    this.camera = new PerspectiveCamera(60, 1, 3, 600_000);
    this.fly = new FreeCamera(this.camera, canvas);

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

    // Lights are tuned for PBR materials (aircraft). The orthophotos are dark and already contain
    // shadows, so the terrain material brightens itself instead (TERRAIN_GAIN).
    const sun = new DirectionalLight(0xfff1dc, 1.1);
    sun.position.copy(sunDir).multiplyScalar(10_000);
    this.scene.add(sun, sun.target);
    this.scene.add(new HemisphereLight(0xdfe9ff, 0x8a7a66, 1.3));

    const haze = new Color(0x9fb3c8);
    this.scene.fog = new FogExp2(haze, 1 / 65_000);
    this.scene.background = haze;

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
    this.terrain = new TerrainEngine(source, this.frame, anisotropy, {
      ...DEFAULT_TERRAIN,
      tau: num('tau', DEFAULT_TERRAIN.tau),
      uploadsPerFrame: num('uploads', DEFAULT_TERRAIN.uploadsPerFrame),
      maxTiles: num('tiles', DEFAULT_TERRAIN.maxTiles),
    });
    this.terrain.rebase(this.shift);
    this.scene.add(this.terrain.group);
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
      renderScale: this.renderScale,
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
      this.measure(dtMs);
      const t0 = performance.now();
      this.tick(Math.min(dtMs, 100) / 1000, dtMs);
      const t1 = performance.now();
      this.renderer.render(this.scene, this.camera);
      const t2 = performance.now();
      // Smoothed CPU cost of our update and of three.js render submission.
      this.tickMs += (t1 - t0 - this.tickMs) * 0.05;
      this.renderMs += (t2 - t1 - this.renderMs) * 0.05;
    };
    this.raf = requestAnimationFrame(loop);
  }

  private tick(dt: number, dtMs: number) {
    this.updateBasis();
    if (this.game) this.game.update(dt);
    else if (this.route) this.flyRoute(dt, dtMs);
    else this.fly.update(dt, this.basis, this.geo[2], this.ground);
    this.rebaseIfNeeded();
    this.sky.position.copy(this.camera.position);

    this.camera.updateMatrixWorld();
    this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.camera.getWorldDirection(this.forward);
    this.terrain?.update(
      this.camera.position,
      this.forward,
      this.frustum,
      // LOD uses the full-resolution height so dynamic resolution does not change detail.
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
      this.adaptResolution();
    }
  }

  /**
   * Dynamic resolution (concept ch. 16): drop render scale by 5 % when frames are too slow,
   * raise it again after a few seconds at full frame rate. rAF is capped by the display,
   * so "fast enough" means frames land at the refresh interval.
   */
  private adaptResolution() {
    const now = performance.now();
    if (this.frameMs > 18.5 && this.renderScale > MIN_RENDER_SCALE) {
      this.setRenderScale(this.renderScale - 0.05);
      this.lastDownscale = now;
    } else if (
      this.frameMs < 17.2 &&
      this.renderScale < 1 &&
      now - this.lastDownscale > 6000 &&
      now - this.lastUpscale > 3000
    ) {
      this.setRenderScale(this.renderScale + 0.05);
      this.lastUpscale = now;
    }
  }

  private setRenderScale(scale: number) {
    this.renderScale = Math.min(1, Math.max(MIN_RENDER_SCALE, Math.round(scale * 100) / 100));
    this.renderer.setPixelRatio(this.basePixelRatio * this.renderScale);
    this.resize();
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
    this.camera.position.sub(delta);
    this.game?.rebase(delta);
  }

  // ---- queries for the flight game (render coordinates) ----

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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private readonly onVisibility = () => {
    if (document.hidden) this.halt();
    else if (this.active) this.run();
  };
}
