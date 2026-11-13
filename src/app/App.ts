import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createReferenceMarker } from '@aircraft';
import { AudioEngine } from '@audio';
import { LocalFrame } from '@geo';
import { FixedStep, SIM_HZ } from '@sim';
import { Sky } from '@sky';
import { mountUi, status } from '@ui';
import { World } from '@world';
import { PROFILES, detectDevice } from './device';

/** Bern-Belp (LSZB): the home airport of phase 1. */
const HOME = { lon: 7.4972, lat: 46.9122, h: 510 };

/** What tests and the screenshot tool can reach from the page (`window.__app`). */
export interface AppDebug {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /** True once the scene has been drawn a few times. */
  ready: boolean;
  frames: number;
  backend: string;
}

declare global {
  interface Window {
    __app?: AppDebug;
  }
}

/**
 * Builds the renderer, the scene and the interface and starts the loop.
 *
 * URL switches for testing: `?device=mobile|desktop`, `?webgl=1` (force the fallback),
 * `?t=2026-06-21T10:00Z` (time), `?shot=1` (fixed time and camera, no changing text).
 */
export async function startApp(canvas: HTMLCanvasElement, uiRoot: HTMLElement): Promise<void> {
  const query = new URLSearchParams(location.search);
  const shot = query.has('shot');
  const profile = PROFILES[detectDevice()];
  status.device.value = profile.device;
  status.version.value = __APP_VERSION__;
  status.simHz.value = SIM_HZ;
  if (shot) document.body.classList.add('shots');
  mountUi(uiRoot);

  const renderer = new WebGPURenderer({
    canvas,
    antialias: profile.antialias,
    powerPreference: 'high-performance',
    forceWebGL: query.has('webgl'),
  });
  try {
    await renderer.init();
  } catch (err) {
    status.renderer.value = '–';
    throw err;
  }
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'WebGPU'
    : 'WebGL 2';
  status.renderer.value = backend;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = profile.shadowMapSize > 0;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  const camera = new PerspectiveCamera(55, 1, 0.5, profile.world.viewDistance * 1.5);

  const frame = new LocalFrame(HOME.lon, HOME.lat, HOME.h);
  const time = query.get('t');
  const date = shot ? new Date('2026-06-21T09:30:00Z') : time ? new Date(time) : new Date();
  const sky = new Sky(Number.isNaN(date.getTime()) ? new Date() : date, HOME.lon, HOME.lat);
  const world = new World(frame, profile.world);
  const marker = createReferenceMarker();
  marker.object.position.set(0, 3, 0);
  scene.add(sky.object, world.object, marker.object);

  if (profile.shadowMapSize > 0) {
    const s = sky.sun.shadow;
    sky.sun.castShadow = true;
    s.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
    s.camera.left = s.camera.bottom = -16;
    s.camera.right = s.camera.top = 16;
    s.camera.near = 1;
    s.camera.far = 400;
    s.bias = -0.0005;
    s.normalBias = 0.03;
  }

  camera.position.set(-15, 6.5, 19);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(marker.object.position);
  controls.enableDamping = !shot;
  controls.enablePan = false;
  controls.minDistance = 12;
  controls.maxDistance = 600;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.update();

  // Browsers start audio only after a gesture.
  const audio = new AudioEngine();
  const unlock = () => void audio.resume();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  const resize = () => {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, profile.maxPixelRatio));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Portrait screens: keep the horizontal view from getting too narrow.
    camera.fov = w < h ? 70 : 55;
    camera.updateProjectionMatrix();
    const size = renderer.getDrawingBufferSize(new Vector2());
    status.resolution.value = [Math.round(size.x), Math.round(size.y)];
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const debug: AppDebug = { renderer, scene, camera, ready: false, frames: 0, backend };
  window.__app = debug;

  const sim = new FixedStep();
  const sunTarget = new Vector3();
  let last = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;

  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    // Phase 0 has nothing to simulate yet; the loop already runs at its fixed rate.
    sim.advance(dt, () => {});

    controls.update();
    world.update(camera);
    sky.update(camera);
    // The shadow map covers the aircraft and the ground around it.
    sunTarget.copy(marker.object.position);
    sky.sun.target.position.copy(sunTarget);
    sky.sun.position.copy(sunTarget).addScaledVector(sky.state.sunDirection, 200);

    renderer.render(scene, camera);

    debug.frames++;
    if (debug.frames === 5) debug.ready = true;
    fpsFrames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
      status.fps.value = fpsFrames / fpsTime;
      fpsFrames = 0;
      fpsTime = 0;
    }
  });
}
