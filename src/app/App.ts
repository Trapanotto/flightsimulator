import * as THREE from 'three';
import { WORLD_ORIGIN } from '../geo/constants';
import { EnuFrame } from '../geo/wgs84';
import { TerrainProvider } from '../terrain/provider';
import { TerrainQuadtree } from '../terrain/quadtree';
import { Ui } from '../ui/ui';
import { createAtmosphere, type Atmosphere } from './atmosphere';
import { FreeCamera, type CameraStart } from './freeCamera';

const DEFAULT_START: CameraStart = {
  lon: 7.85,
  lat: 46.72,
  height: 5_500,
  targetLon: 7.95,
  targetLat: 46.55,
  targetHeight: 4_000,
  headingDeg: 175,
  pitchDeg: -8,
};

function readStart(): CameraStart {
  const params = new URLSearchParams(location.search);
  const number = (key: string) => {
    const raw = params.get(key);
    if (raw === null) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const lat = number('lat') ?? DEFAULT_START.lat;
  const lon = number('lon') ?? DEFAULT_START.lon;
  const height = number('alt') ?? DEFAULT_START.height;
  const headingDeg = number('hdg') ?? DEFAULT_START.headingDeg;
  const pitchDeg = number('pitch') ?? DEFAULT_START.pitchDeg;

  return {
    ...DEFAULT_START,
    lat,
    lon,
    height,
    headingDeg,
    pitchDeg,
  };
}

export class App {
  private readonly canvas: HTMLCanvasElement;
  private readonly ui: Ui;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly frame: EnuFrame;
  private readonly provider = new TerrainProvider();
  private readonly atmosphere: Atmosphere;
  private readonly quadtree: TerrainQuadtree;
  private readonly freeCamera: FreeCamera;
  private readonly startedAt = performance.now();

  private fps = 60;
  private frameMs = 16.6;
  private lastTelemetry = 0;
  private lastDebug = 0;
  private lastFrameTime = performance.now();
  private running = true;
  private loadingHiddenAt = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, ui: Ui) {
    this.canvas = canvas;
    this.ui = ui;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      1,
      420_000,
    );

    this.frame = new EnuFrame(WORLD_ORIGIN);
    this.atmosphere = createAtmosphere(this.scene);

    this.quadtree = new TerrainQuadtree(
      this.scene,
      this.provider,
      this.frame,
      this.renderer,
    );

    this.freeCamera = new FreeCamera(
      this.camera,
      this.frame,
      canvas,
      readStart(),
    );

    this.bindEvents();
  }

  async init() {
    this.ui.setLoading('Verbinde mit swisstopo …', 6);
    await this.provider.init();
    this.ui.setSource(this.provider.isLive);
    this.ui.setLoading('Lade swissALTI3D-Terrain …', 12);
    this.lastFrameTime = performance.now();
    this.animate();
  }

  private bindEvents() {
    window.addEventListener('resize', this.onResize);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  private onPointerLockChange = () => {
    this.ui.setPointerLocked(document.pointerLockElement === this.canvas);
  };

  private onVisibilityChange = () => {
    this.lastFrameTime = performance.now();
  };

  private animate = () => {
    if (!this.running) return;
    requestAnimationFrame(this.animate);

    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    try {
      this.freeCamera.update(dt);
      this.quadtree.update(
        this.camera,
        this.renderer.domElement.clientHeight,
      );

      this.renderer.info.reset();
      const frameStart = performance.now();
      this.renderer.render(this.scene, this.camera);
      const frameEnd = performance.now();
      this.frameMs = this.frameMs * 0.9 + (frameEnd - frameStart) * 0.1;
    } catch (error) {
      console.error('[app] render loop stopped', error);
      this.running = false;
      this.ui.showError(
        `Die Welt-Engine ist auf einen Fehler gestoßen: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    this.fps = this.fps * 0.92 + (1 / Math.max(dt, 0.0001)) * 0.08;

    if (now - this.lastTelemetry > 90) {
      this.lastTelemetry = now;
      const geo = this.freeCamera.getGeodetic();
      this.ui.updateTelemetry({
        altitude: geo.height,
        lon: geo.lon,
        lat: geo.lat,
        heading: this.freeCamera.getHeading(),
        speed: this.freeCamera.getSpeed(),
        fps: this.fps,
      });
    }

    if (now - this.lastDebug > 240) {
      this.lastDebug = now;
      const stats = this.quadtree.getStats();
      this.ui.updateDebug({
        ...stats,
        calls: this.renderer.info.render.calls,
        frameMs: this.frameMs,
      });
    }

    this.updateLoading();
  };

  private updateLoading() {
    if (this.loadingHiddenAt > 0) return;

    const stats = this.quadtree.getStats();
    const elapsed = (performance.now() - this.startedAt) / 1000;
    const progress = Math.min(
      96,
      12 + stats.loaded * 1.8 + stats.textured * 0.35,
    );
    this.ui.setLoading(
      `Lade Terrain … ${stats.loaded} Kacheln · ${stats.pending} ausstehend`,
      progress,
    );

    const readyEnough =
      stats.loaded >= 40 &&
      stats.textured >= 30 &&
      stats.pending < Math.max(20, stats.loaded * 0.5);

    if ((stats.visible > 0 && readyEnough) || (elapsed > 14 && stats.loaded > 0)) {
      this.loadingHiddenAt = performance.now();
      this.ui.hideLoading();
      return;
    }

    if (elapsed > 25 && stats.loaded === 0) {
      this.ui.showError(
        'Der Terrain-Dienst antwortet nicht. Prüfe deine Internetverbindung und lade die Seite neu. Die swisstopo-Dienste sind nur innerhalb der Schweiz und der Grenzregion verfügbar.',
      );
    }
  }

  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  getScene(): THREE.Scene {
    return this.scene;
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  getQuadtree(): TerrainQuadtree {
    return this.quadtree;
  }

  getAtmosphere(): Atmosphere {
    return this.atmosphere;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.freeCamera.dispose();
    this.quadtree.dispose();
    this.renderer.dispose();
  }
}
