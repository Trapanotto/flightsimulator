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
import { Vector3 as V3 } from 'three';
import { Aircraft } from '../aircraft/Aircraft';
import { type AircraftType, loadAircraftChoice } from '../aircraft/types';
import { BuildingSet, CHURCH_TYPES, HOUSE_TYPES, type HouseType } from '../buildings/BuildingSet';

/** Ground height for the building review (#buildings), metres below the origin. */
const GROUND_Y = -1.53;

/** Studio view of the fleet: pick an aircraft, watch its controls, gear and propeller move. */
export class Hangar {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 0.1, 500);
  readonly controls: OrbitControls;
  aircraft?: Aircraft;
  type: AircraftType = loadAircraftChoice();
  private readonly floor: Mesh;
  private readonly key: DirectionalLight;
  private loading = 0;
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
    this.key = key;

    const floor = new Mesh(new CircleGeometry(14, 64), new ShadowMaterial({ opacity: 0.35 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = GROUND_Y;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.floor = floor;

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

  /** Design review of the building set (#buildings): all types in a row at typical sizes. */
  async showBuildings() {
    const set = await BuildingSet.load();
    this.renderer.toneMappingExposure = 0.62;
    const sizes: Record<HouseType, [number, number, number]> = {
      farmhouse: [24, 17, 4.8],
      chalet: [12, 10, 6.5],
      valais: [8, 7, 6.5],
      engadin: [15, 12, 7.5],
      rustico: [8, 6, 5],
      ticino: [12, 10, 7],
      urban: [17, 11, 12],
      block: [26, 14, 19],
      hall: [42, 26, 8],
      shed: [6, 4, 3],
    };
    let x = 0;
    const houses = HOUSE_TYPES.map((type) => {
      const [length, width, height] = sizes[type];
      const h = {
        type,
        x: x + length / 2,
        y: -1.53,
        z: 0,
        yaw: 0,
        length,
        width,
        height,
        tint: new Color(1, 0.93, 0.82),
      };
      x += length + 8;
      return h;
    });
    const up = new V3(0, 1, 0);
    const meshes = [
      ...set.createHouses(houses, up),
      ...set.createChurches(
        CHURCH_TYPES.map((type, i) => ({
          type,
          x: x + 20 + i * 45,
          y: -1.53,
          z: 0,
          yaw: 0,
          size: 26,
        })),
        up,
      ),
    ];
    for (const m of meshes) {
      m.castShadow = m.receiveShadow = true;
      this.scene.add(m);
    }
    const total = x + 110;
    this.controls.target.set(total / 2, 6, 0);
    this.camera.position.set(total / 2 - 40, 70, 150);
    this.camera.far = 3000;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = 1500;
    this.controls.autoRotate = false;
    const s = this.scene.children.find(
      (o) => (o as { isDirectionalLight?: boolean }).isDirectionalLight,
    ) as unknown as {
      shadow: {
        camera: {
          left: number;
          right: number;
          top: number;
          bottom: number;
          far: number;
          updateProjectionMatrix(): void;
        };
      };
      position: V3;
    };
    s.position.set(total / 2 - 80, 120, 90);
    const c = s.shadow.camera;
    c.left = c.bottom = -total / 2 - 20;
    c.right = c.top = total / 2 + 20;
    c.far = 600;
    c.updateProjectionMatrix();
    (s as unknown as { target: { position: V3 } }).target.position.set(total / 2, 0, 0);
  }

  /** Loads an aircraft type (replacing the shown one) and frames it. */
  async load(type: AircraftType = this.type) {
    this.type = type;
    const ticket = ++this.loading;
    const a = await Aircraft.load(type, this.scene.environment ?? undefined);
    if (ticket !== this.loading) return; // a newer choice won
    if (this.aircraft) this.scene.remove(this.aircraft.root);
    this.aircraft = a;
    this.scene.add(a.root);
    this.frame(type);
  }

  /** Floor, shadow box and camera follow the aircraft's size. */
  private frame(type: AircraftType) {
    const size = Math.max(type.length, type.span);
    const g = type.physics.gearHeight;
    this.floor.position.y = -g;
    this.floor.scale.setScalar(Math.max(1, size / 18));
    const s = this.key.shadow.camera;
    s.left = s.bottom = -size * 0.8;
    s.right = s.top = size * 0.8;
    s.far = size * 6;
    s.updateProjectionMatrix();
    this.key.position.set(-8, 12, 6).multiplyScalar(Math.max(1, size / 12));
    const k = size / 11;
    this.camera.position.set(-9 * k, 2.2 * k, 11 * k);
    this.camera.far = Math.max(500, size * 30);
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, -g * 0.15, 0.3 * k);
    this.controls.minDistance = size * 0.35;
    this.controls.update();
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
