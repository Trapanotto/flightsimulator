import {
  ACESFilmicToneMapping,
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PCFSoftShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  ShadowMaterial,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Aircraft } from '../aircraft/Aircraft';

/** Ground height in the model (gear down), metres below the origin. */
const GROUND_Y = -1.53;

export const AIRCRAFT_URL = `${import.meta.env.BASE_URL}assets/aircraft/tr1.glb`;

/** Studio view of the TR-1 with live controls, used for design review (phase 3). */
export class Hangar {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 0.1, 500);
  readonly controls: OrbitControls;
  aircraft?: Aircraft;
  /** Animate the control surfaces in a loop. */
  demo = true;
  forcedLod: number | null = null;
  private running = false;
  private raf = 0;
  private last = 0;
  private t = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.background = new Color(0x1b2233);

    this.scene.add(new HemisphereLight(0xdfe8ff, 0x3a3328, 0.6));
    const key = new DirectionalLight(0xfff2e0, 2.4);
    key.position.set(-8, 12, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = key.shadow.camera;
    s.left = s.bottom = -9;
    s.right = s.top = 9;
    s.near = 1;
    s.far = 40;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);

    const floor = new Mesh(new CircleGeometry(14, 64), new ShadowMaterial({ opacity: 0.35 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = GROUND_Y;
    floor.receiveShadow = true;
    this.scene.add(floor);

    this.camera.position.set(-9, 2.2, 11);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, -0.2, 0.3);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.6;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 400;
    this.controls.maxPolarAngle = 92 * (Math.PI / 180);
    this.controls.update();

    window.addEventListener('resize', this.resize);
    this.resize();
  }

  async load() {
    this.aircraft = await Aircraft.load(AIRCRAFT_URL, this.scene.environment ?? undefined);
    this.scene.add(this.aircraft.root);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.tick(dt);
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private tick(dt: number) {
    this.controls.update();
    const a = this.aircraft;
    if (!a) return;
    this.t += dt;
    if (this.demo) {
      const c = a.controls;
      c.aileron = Math.sin(this.t * 1.3);
      c.elevator = Math.sin(this.t * 0.9 + 1);
      c.rudder = Math.sin(this.t * 0.7 + 2);
    }
    if (this.forcedLod !== null) {
      a.lod.autoUpdate = false;
      a.lod.levels.forEach((l, i) => (l.object.visible = i === this.forcedLod));
    } else {
      a.lod.autoUpdate = true;
    }
    a.update(dt);
  }

  private readonly resize = () => {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };
}
