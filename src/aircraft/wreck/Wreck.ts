/**
 * A crashed aircraft: the model on screen breaks into pieces (gear legs, the propeller, wings,
 * the tail, the fuselage in jagged slabs, as the impact decides), which fly off, tumble, bounce
 * on the terrain, slide to rest and char. First dust and sparks from the impact, then,
 * EXPLOSION_DELAY later, the fuel goes up: a fireball and a flash; burning pieces under a
 * rising column of smoke, lit by a flickering fire light. In step with the crash sound
 * (audio: CrashSound).
 *
 * Nothing is uploaded at the impact: the pieces draw the geometry already on the graphics card
 * (the level of detail on screen), whole where a part is one piece, else as a new index over
 * the same vertex buffers; they keep the model's own materials, so no shader is built. The
 * model itself is only hidden, and comes back with `dispose()`.
 *
 * Render space: x east, y up, z south (metres, the app's moving origin).
 */
import {
  BufferAttribute,
  BufferGeometry,
  Box3,
  Color,
  Group,
  type InstancedMesh,
  type InterleavedBufferAttribute,
  type LOD,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  Quaternion,
  Sphere,
  Vector3,
} from 'three/webgpu';
import type { AircraftVisual } from '../AircraftVisual';
import {
  type BreakPlan,
  EXPLOSION_DELAY,
  type Impact,
  LAYOUTS,
  type Layout,
  type PieceKind,
  type Severity,
  type Vec3Like,
  baseName,
  kindOf,
  layoutFromBounds,
  pieceKey,
  planBreak,
  roleOf,
  sizeFactor,
  splitTriangles,
} from './breakup';
import { type ParticleSpec, seeded } from './particles';
import type { WreckFx } from './WreckFx';

/** What the wreck needs from the world. */
export interface WreckEnv {
  /** Height of the ground (or water surface) at x, z in render space; undefined if not loaded. */
  groundY(x: number, z: number): number | undefined;
  /** Wind at the ground in render space, m/s (drifts the smoke). Read every update. */
  wind?: Vec3Like;
}

export interface WreckOptions {
  /** Seed of the random choices (which wing, how pieces fly); by default from the impact. */
  seed?: number;
}

interface Piece {
  obj: Group;
  vel: Vector3;
  /** Angular velocity, rad/s (render axes). */
  spin: Vector3;
  /** Bounding box in the piece's own frame (its centre at the origin). */
  box: Box3;
  radius: number;
  kind: PieceKind;
  resting: boolean;
  /** Lowest point below the centre when last on the ground (for re-seating on new terrain). */
  low: number;
  /** Burns (emits fire and smoke) until this age. */
  burnUntil: number;
  /** Seconds since the last re-seat check while at rest. */
  check: number;
}

interface PartGeometry {
  geometry: BufferGeometry;
  material: Material;
  /** Mesh to model frame. */
  matrix: Matrix4;
  castShadow: boolean;
  receiveShadow: boolean;
  /** Bounds in the model frame. */
  box: Box3;
}

const CHAR = new Color(0.06, 0.055, 0.05);
const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);
const AXES = [
  new Vector3(1, 0, 0),
  new Vector3(-1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, -1, 0),
  new Vector3(0, 0, 1),
  new Vector3(0, 0, -1),
];
/** Sky units: solar illuminance = 1 (sky package, SOLAR_ILLUMINANCE_LUX). */
const LUX_PER_UNIT = 1e5;
/**
 * The fire light sees at most this exposure: the eye adapted to the fire does not see its
 * light grow without end as the night gets darker.
 */
const LIGHT_EXPOSURE_MAX = 400;
/** Beyond this distance from the camera (m) no new particles are made. */
const FAR = 6000;

const tmpV = new Vector3();
const tmpV2 = new Vector3();
const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const tmpM = new Matrix4();
const IDENTITY = new Quaternion();

/** The level of detail whose geometry is on screen now (and so on the graphics card). */
function levelOnScreen(root: Object3D): Object3D {
  let lod: LOD | undefined;
  root.traverse((o) => {
    if (!lod && (o as LOD).isLOD) lod = o as LOD;
  });
  if (!lod || lod.levels.length === 0) return root;
  // The last level is one merged skin (nothing to break apart); the one before it then.
  const most = Math.max(0, lod.levels.length - 2);
  const level = Math.min(lod.getCurrentLevel(), most);
  return lod.levels[level]!.object;
}

export class Wreck {
  readonly group = new Group();
  readonly severity: Severity;
  /** Length of the aircraft, m (for the camera's distance). */
  readonly extent: number;
  private readonly pieces: Piece[] = [];
  private readonly centre = new Vector3();
  private readonly plan: BreakPlan;
  private readonly rnd: () => number;
  /** Size relative to a 10 m aircraft (fire, debris speeds). */
  private readonly k: number;
  /** Size of the explosion (smaller when only a wing burns). */
  private readonly boomK: number;
  private readonly water: boolean;
  private readonly hidden: Object3D[] = [];
  private readonly charred: {
    m: Material & { color?: Color; roughness?: number };
    base: Color;
    rough: number;
  }[] = [];
  private readonly owned: BufferGeometry[] = [];
  private pendingExplosion?: Vector3;
  private boomAt = Infinity;
  private emitAcc = 0;
  private _age = 0;

  constructor(
    visual: AircraftVisual,
    velocity: Vec3Like,
    private readonly env: WreckEnv,
    private readonly fx: WreckFx,
    impact: Impact,
    options: WreckOptions = {},
  ) {
    this.group.name = 'Wreck';
    this.rnd = seeded(
      options.seed ??
        1 + Math.abs(Math.round(impact.speed * 977 + impact.sink * 131 + impact.bank * 7919)),
    );
    this.water = impact.reason === 'water';
    fx.reset();
    const root = visual.object;
    root.updateMatrixWorld(true);
    this.centre.copy(root.getWorldPosition(tmpV));
    const level = levelOnScreen(root);
    const parts = this.collect(level, root.matrixWorld);
    const layout = this.layoutOf(root.name, parts);
    this.extent = layout.zNose - layout.zTail;
    this.k = sizeFactor(this.extent);
    this.plan = planBreak(impact, layout, this.rnd);
    this.severity = this.plan.severity;
    this.boomK = this.severity === 2 ? this.k * 0.65 : this.k;
    this.breakUp(parts, root, layout, velocity);
    // The model goes out of sight (its lights are left alone: removing one would rebuild
    // every shader).
    for (const c of root.children) {
      if ((c as { isLight?: boolean }).isLight || !c.visible) continue;
      c.visible = false;
      this.hidden.push(c);
    }
    if (fx.light) {
      fx.light.position.copy(this.centre).addScaledVector(UP, 3 * this.k);
      // The fire lights its surroundings, not the whole valley.
      fx.light.distance = 160 * this.k;
    }
    this.impactDust(velocity);
    if (this.severity > 1 && !this.water) this.pendingExplosion = new Vector3().copy(velocity);
  }

  /** Seconds since the impact. */
  get age() {
    return this._age;
  }

  /** Old enough to be cleared away (the fire is out, the smoke gone). */
  get done() {
    return this._age > 90;
  }

  /**
   * Where the camera should look: the airframe if it stayed together (it slides on), else the
   * middle of the large pieces (they fly on along the track for a while).
   */
  get focus(): Vector3 {
    const hull = this.pieces.find((p) => p.kind === 'hull');
    if (hull) return hull.obj.position;
    return this.middle(this.focusPoint);
  }

  private readonly focusPoint = new Vector3();

  /** The middle of the wreckage, weighted by size (small debris hardly counts). */
  private middle(out: Vector3): Vector3 {
    out.set(0, 0, 0);
    let w = 0;
    for (const p of this.pieces) {
      const k = p.radius * p.radius;
      out.addScaledVector(p.obj.position, k);
      w += k;
    }
    return w > 0 ? out.divideScalar(w) : out.copy(this.centre);
  }

  /** Number of pieces (tests, debugging). */
  get pieceCount() {
    return this.pieces.length;
  }

  /** The pieces' centres, kinds and whether they lie still (tests, debugging). */
  get debugPieces(): { position: Vector3; kind: PieceKind; resting: boolean; low: number }[] {
    return this.pieces.map((p) => ({
      position: p.obj.position,
      kind: p.kind,
      resting: p.resting,
      low: this.lowestBelowCentre(p),
    }));
  }

  // ---------------------------------------------------------------------------------------
  // Breaking up

  /** Every mesh of the level that can become debris, with the part that owns it. */
  private collect(level: Object3D, rootWorld: Matrix4) {
    const rootInv = new Matrix4().copy(rootWorld).invert();
    const out: { mesh: Mesh; owner: string; pivot: boolean; matrix: Matrix4 }[] = [];
    for (const part of level.children) {
      const owner = baseName(part.name);
      if (roleOf(owner) === 'skip') continue;
      const pivot = !!(part.userData.axis || part.userData.slide);
      part.traverse((o) => {
        if (!(o instanceof Mesh) || (o as InstancedMesh).isInstancedMesh) return;
        if (Array.isArray(o.material)) return;
        let n: Object3D | null = o;
        // A skipped node anywhere between the part and the mesh (a disc inside the propeller).
        while (n && n !== part) {
          if (roleOf(n.name) === 'skip') return;
          n = n.parent;
        }
        if (roleOf(o.name, (o.material as Material).name) === 'skip') return;
        if (!o.geometry.getAttribute('position')) return;
        out.push({
          mesh: o,
          owner,
          pivot,
          matrix: new Matrix4().multiplyMatrices(rootInv, o.matrixWorld),
        });
      });
    }
    return out;
  }

  private layoutOf(name: string, parts: { mesh: Mesh; matrix: Matrix4 }[]): Layout {
    const known = LAYOUTS[name];
    if (known) return known;
    const box = new Box3();
    for (const p of parts) {
      p.mesh.geometry.computeBoundingBox();
      box.union(tmpBox.copy(p.mesh.geometry.boundingBox!).applyMatrix4(p.matrix));
    }
    return layoutFromBounds(box.min, box.max);
  }

  private breakUp(
    parts: { mesh: Mesh; owner: string; pivot: boolean; matrix: Matrix4 }[],
    root: Object3D,
    layout: Layout,
    velocity: Vec3Like,
  ) {
    const byKey = new Map<string, PartGeometry[]>();
    const add = (key: string, g: PartGeometry) => {
      let list = byKey.get(key);
      if (!list) byKey.set(key, (list = []));
      list.push(g);
    };
    for (const { mesh, owner, pivot, matrix } of parts) {
      const geo = mesh.geometry;
      const pos = geo.getAttribute('position');
      const index = geo.index ? (geo.index.array as ArrayLike<number>) : null;
      // Every vertex in the model frame once (the attributes are quantised: reading them
      // through getX for each triangle corner would cost several times as much).
      const P = modelPositions(pos, matrix);
      const role = roleOf(owner);
      const lists = splitTriangles(
        index,
        pos.count,
        (a, b, c, out) => {
          out.x = (P[a * 3]! + P[b * 3]! + P[c * 3]!) / 3;
          out.y = (P[a * 3 + 1]! + P[b * 3 + 1]! + P[c * 3 + 1]!) / 3;
          out.z = (P[a * 3 + 2]! + P[b * 3 + 2]! + P[c * 3 + 2]!) / 3;
        },
        (c) => pieceKey(owner, role, pivot, c, this.plan, layout),
      );
      const material = mesh.material as Material;
      for (const [key, list] of lists) {
        const whole = lists.size === 1 && list.length === (index ? index.length : pos.count);
        const box = boundsOf(P, whole ? null : list);
        const geometry = whole ? geo : this.subset(geo, list, box, matrix);
        add(key, {
          geometry,
          material,
          matrix,
          castShadow: mesh.castShadow,
          receiveShadow: mesh.receiveShadow,
          box,
        });
      }
    }
    const rootQ = root.getWorldQuaternion(new Quaternion());
    const horiz = new Vector3(velocity.x, 0, velocity.z);
    for (const [key, list] of byKey) this.addPiece(key, list, root.matrixWorld, rootQ, horiz);
  }

  /** The same vertex buffers (already on the graphics card) under a new index. */
  private subset(
    src: BufferGeometry,
    list: number[],
    modelBox: Box3,
    matrix: Matrix4,
  ): BufferGeometry {
    const g = new BufferGeometry();
    for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr);
    const count = src.getAttribute('position').count;
    g.setIndex(
      new BufferAttribute(count > 65535 ? new Uint32Array(list) : new Uint16Array(list), 1),
    );
    // Bounds of the subset only (three's would span the whole shared buffer), back in the
    // geometry's own frame: a little loose, which only matters for culling.
    const box = modelBox.clone().applyMatrix4(tmpM.copy(matrix).invert());
    g.boundingBox = box;
    g.boundingSphere = box.getBoundingSphere(new Sphere());
    this.owned.push(g);
    return g;
  }

  private addPiece(
    key: string,
    list: PartGeometry[],
    rootWorld: Matrix4,
    rootQ: Quaternion,
    horiz: Vector3,
  ) {
    const box = new Box3();
    for (const p of list) box.union(p.box);
    if (box.isEmpty()) return;
    const size = box.getSize(new Vector3());
    const radius = size.length() / 2;
    const kind = kindOf(key);
    // Too small to see fly: it is simply gone.
    if (radius < 0.12 * Math.sqrt(this.k) && kind === 'debris') return;
    const centreModel = box.getCenter(new Vector3());
    const obj = new Group();
    obj.name = `Wreck_${key}`;
    obj.position.copy(centreModel).applyMatrix4(rootWorld);
    obj.quaternion.copy(rootQ);
    const shift = new Matrix4().makeTranslation(-centreModel.x, -centreModel.y, -centreModel.z);
    for (const p of list) {
      const m = new Mesh(p.geometry, p.material);
      m.matrixAutoUpdate = false;
      m.matrix.multiplyMatrices(shift, p.matrix);
      m.castShadow = p.castShadow;
      m.receiveShadow = p.receiveShadow;
      obj.add(m);
      this.trackChar(p.material);
    }
    this.group.add(obj);
    const local = box.clone().translate(centreModel.negate());
    const sev = this.severity;
    const rnd = this.rnd;
    const light = 1 / Math.sqrt(Math.max(0.5, radius / this.k));
    const out = tmpV2.copy(obj.position).sub(this.centre).setY(0);
    if (out.lengthSq() < 1e-6) out.set(rnd() - 0.5, 0, rnd() - 0.5);
    out.normalize();
    const rand = () => new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
    let vel: Vector3;
    let spin: Vector3;
    if (kind === 'hull') {
      // Slides on along the ground, slowing with friction; a torn wing swings it round.
      vel = horiz
        .clone()
        .multiplyScalar(sev === 1 ? 0.9 : 0.65)
        .addScaledVector(UP, sev === 1 ? 0.3 : 1.5);
      spin = UP.clone().multiplyScalar((sev === 1 ? 0.15 : 0.8) * (rnd() < 0.5 ? -1 : 1));
    } else {
      const force = sev === 1 ? 0.35 : sev === 2 ? 0.7 : 1;
      vel = horiz
        .clone()
        .multiplyScalar(0.25 + rnd() * 0.45)
        .addScaledVector(UP, (4 + rnd() * 9) * light * Math.sqrt(this.k) * force)
        .addScaledVector(out, (3 + rnd() * 9) * light * force)
        .add(rand().multiplyScalar(6 * light * force));
      spin = rand().multiplyScalar((kind === 'section' ? 4 : 9) * light * force);
    }
    // After a bad crash many pieces burn; a mild one does not catch fire.
    const burnUntil = this.water
      ? 0
      : sev === 1
        ? 0
        : kind === 'hull' || rnd() < (sev === 3 ? 0.45 : 0.25)
          ? 15 + rnd() * 40
          : 2 + rnd() * 4;
    this.pieces.push({
      obj,
      vel,
      spin,
      box: local,
      radius,
      kind,
      resting: false,
      low: -size.y / 2,
      burnUntil,
      check: 0,
    });
  }

  private trackChar(m: Material) {
    const c = m as Material & { color?: Color; roughness?: number };
    if (!c.color || this.charred.some((x) => x.m === c)) return;
    this.charred.push({ m: c, base: c.color.clone(), rough: c.roughness ?? 0.5 });
  }

  // ---------------------------------------------------------------------------------------
  // Particles

  private emitFire(s: ParticleSpec) {
    this.fx.fire.emit(s);
  }

  private emitSmoke(s: ParticleSpec) {
    this.fx.smoke.emit(s);
  }

  /** How many of `n` particles this device draws. */
  private n(count: number) {
    return Math.max(1, Math.round(count * this.fx.budget));
  }

  private dir(upBias: number) {
    const r = this.rnd;
    return new Vector3(r() - 0.5, r() * 0.6, r() - 0.5)
      .normalize()
      .addScaledVector(UP, upBias)
      .normalize();
  }

  /** The impact: a cloud of dust and soil (spray on water), sparks scraping off the metal. */
  private impactDust(velocity: Vec3Like) {
    const k = this.k;
    const r = this.rnd;
    const c = this.centre;
    const drift = new Vector3(velocity.x, velocity.y, velocity.z).multiplyScalar(0.25).setY(0);
    // Soil thrown up at the ground, spray on water; broken up in the air, a grey cloud of
    // fragments and fuel mist.
    const gy = this.env.groundY(c.x, c.z);
    const aloft = gy !== undefined && c.y - gy > 6 * k;
    const col0 = this.water
      ? ([0.75, 0.78, 0.8, 0.7] as const)
      : aloft
        ? ([0.3, 0.3, 0.3, 0.5] as const)
        : ([0.3, 0.26, 0.21, 0.6] as const);
    const col1 = this.water
      ? ([0.85, 0.87, 0.9, 0] as const)
      : aloft
        ? ([0.45, 0.45, 0.45, 0] as const)
        : ([0.42, 0.38, 0.33, 0] as const);
    for (let i = 0; i < this.n(40); i++) {
      const dir = this.dir(0.4);
      this.emitSmoke({
        pos: c.clone().addScaledVector(dir, r() * 3 * k),
        vel: dir.multiplyScalar((4 + r() * 10) * k).add(drift),
        life: 3 + r() * 4,
        size0: 2 * k,
        size1: (7 + r() * 6) * k,
        color0: col0,
        color1: col1,
        drag: 1.6,
        lift: 0.6,
      });
    }
    if (this.water) return;
    for (let i = 0; i < this.n(50); i++) {
      const dir = this.dir(0.3);
      this.emitFire({
        pos: c.clone(),
        vel: dir.multiplyScalar(8 + r() * 20).add(drift),
        life: 0.4 + r() * 0.8,
        size0: 0.35 * k,
        size1: 0.1 * k,
        color0: [7, 4.5, 2, 1],
        color1: [3, 1, 0.2, 0],
        drag: 0.6,
        lift: -9.81,
      });
    }
  }

  private explode(velocity: Vector3) {
    const k = this.boomK;
    const r = this.rnd;
    const c = this.centre;
    const drift = velocity.clone().multiplyScalar(0.15).setY(0);
    const sphere = () => new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    // Fireball: a hot core, expanding and rising.
    for (let i = 0; i < this.n(70); i++) {
      const dir = sphere();
      if (dir.y < 0) dir.y *= -0.4;
      // From a yellow-white core to dull red at the rim of the ball.
      const hot = r();
      this.emitFire({
        pos: c.clone().addScaledVector(dir, r() * 2 * k),
        vel: dir.multiplyScalar((6 + r() * 22) * k).add(drift),
        life: 0.7 + r() * 1.3,
        size0: (2.5 + r() * 3) * k,
        size1: (9 + r() * 9) * k,
        color0: [2.2 + 1.6 * hot, 0.7 + 1.1 * hot, 0.15 + 0.35 * hot, 0.6],
        color1: [0.7, 0.12, 0.02, 0],
        drag: 2.2,
        lift: 7,
      });
    }
    // Sparks and burning bits on ballistic arcs.
    for (let i = 0; i < this.n(90); i++) {
      const dir = sphere().addScaledVector(UP, 0.8).normalize();
      this.emitFire({
        pos: c.clone(),
        vel: dir.multiplyScalar((12 + r() * 35) * Math.sqrt(k)).add(drift),
        life: 1 + r() * 2,
        size0: 0.5 * k,
        size1: 0.2 * k,
        color0: [6, 3, 1, 1],
        color1: [2.4, 0.5, 0.08, 0],
        drag: 0.35,
        lift: -9.81,
      });
    }
    // Black smoke bursting out of the fireball.
    for (let i = 0; i < this.n(45); i++) {
      const dir = sphere();
      if (dir.y < 0) dir.y *= -0.2;
      this.emitSmoke({
        pos: c.clone().addScaledVector(dir, 2 * k),
        vel: dir.multiplyScalar((3 + r() * 10) * k).add(drift),
        life: 7 + r() * 8,
        size0: 5 * k,
        size1: (22 + r() * 18) * k,
        color0: [0.04, 0.038, 0.036, 0.8],
        color1: [0.1, 0.096, 0.092, 0],
        drag: 1.2,
        lift: 2.5,
      });
    }
  }

  // ---------------------------------------------------------------------------------------
  // Every frame

  /** Lowest point of a piece below its centre, as it is turned now. */
  private lowestBelowCentre(p: Piece): number {
    const b = p.box;
    let low = Infinity;
    for (let i = 0; i < 8; i++) {
      tmpV.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      low = Math.min(low, tmpV.applyQuaternion(p.obj.quaternion).y);
    }
    return low;
  }

  /**
   * `dt` in seconds (pass 0 while paused); `camera` (render space) sorts the smoke and stops
   * new particles when far away. Call after the visual's own update.
   */
  update(dt: number, camera?: Vec3Like) {
    // The visual's update may have switched its glows back on.
    for (const h of this.hidden) h.visible = false;
    if (dt <= 0) return;
    this._age += dt;
    const age = this._age;
    if (this.pendingExplosion && age >= EXPLOSION_DELAY) {
      // The fuel explodes where the wreckage is now (the middle of the heavy parts).
      this.middle(this.centre);
      this.explode(this.pendingExplosion);
      this.pendingExplosion = undefined;
      this.boomAt = age;
    }
    this.updateLight(age);
    for (const p of this.pieces) this.move(p, dt);
    this.char(age);
    this.burn(dt, camera);
    this.fx.fire.update(dt, undefined, camera);
    this.fx.smoke.update(dt, this.env.wind, camera);
  }

  private updateLight(age: number) {
    const light = this.fx.light;
    if (!light) return;
    const since = age - this.boomAt;
    // Candela: a flash for a moment, then the flickering glow of the fire.
    const flash = since >= 0 ? Math.exp(-since * 6) * 3e6 : 0;
    const glow =
      since >= 0 && age < 50
        ? 4e4 *
          Math.min(1, since * 3) *
          (1 + 0.3 * Math.sin(age * 23) * Math.sin(age * 7.3)) *
          Math.min(1, (50 - age) / 20)
        : 0;
    const k2 = this.boomK * this.boomK;
    const exposure = Math.min(this.fx.exposure, LIGHT_EXPOSURE_MAX);
    light.intensity = ((flash + glow) * k2 * exposure) / LUX_PER_UNIT;
    light.position.copy(this.centre).addScaledVector(UP, 3 * this.k);
  }

  private move(p: Piece, dt: number) {
    if (p.resting) {
      // The terrain under it may still sharpen: sit on the new surface.
      p.check += dt;
      if (p.check > 0.5) {
        p.check = 0;
        const gy = this.env.groundY(p.obj.position.x, p.obj.position.z);
        if (gy !== undefined) p.obj.position.y = gy - p.low;
      }
      return;
    }
    p.vel.y -= 9.81 * dt;
    p.vel.multiplyScalar(Math.exp(-0.08 * dt));
    p.obj.position.addScaledVector(p.vel, dt);
    const w = p.spin.length();
    if (w > 1e-4)
      p.obj.quaternion.premultiply(
        tmpQ.setFromAxisAngle(tmpV.copy(p.spin).divideScalar(w), w * dt),
      );
    const gy = this.env.groundY(p.obj.position.x, p.obj.position.z);
    if (gy === undefined) return;
    const low = this.lowestBelowCentre(p);
    if (p.obj.position.y + low > gy) return;
    // On the ground.
    p.obj.position.y = gy - low;
    p.low = low;
    const hull = p.kind === 'hull';
    // A loose part hitting the ground digs in and loses much of its speed (a debris field
    // a few hundred metres long, not kilometres); a small bounce. The airframe slides on.
    if (!hull && p.vel.y < -2) {
      p.vel.x *= 0.6;
      p.vel.z *= 0.6;
    }
    if (p.vel.y < 0) p.vel.y = hull ? 0 : -p.vel.y * 0.3;
    // Sliding friction (about 0.5 g), the tumbling dies down.
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const dv = Math.min(speed, 0.5 * 9.81 * dt * (hull ? 1 : 2));
    if (speed > 0) {
      p.vel.x -= (p.vel.x / speed) * dv;
      p.vel.z -= (p.vel.z / speed) * dv;
    }
    p.spin.multiplyScalar(Math.exp(-dt * (hull ? 1.2 : 5)));
    // It settles onto the side it is lying on instead of balancing on an edge; the airframe
    // onto its belly.
    let best = AXES[3]!;
    let most = hull ? -tmpV.copy(best).applyQuaternion(p.obj.quaternion).y : -Infinity;
    if (!hull)
      for (const a of AXES) {
        const d = -tmpV.copy(a).applyQuaternion(p.obj.quaternion).y;
        if (d > most) {
          most = d;
          best = a;
        }
      }
    tmpV.copy(best).applyQuaternion(p.obj.quaternion);
    tmpQ2.setFromUnitVectors(tmpV, DOWN);
    tmpQ.copy(IDENTITY).slerp(tmpQ2, 1 - Math.exp(-dt * (hull ? 2 : 4)));
    p.obj.quaternion.premultiply(tmpQ).normalize();
    if (p.vel.lengthSq() < 0.3 && p.spin.lengthSq() < 0.05 && most > 0.995) {
      p.resting = true;
      p.vel.set(0, 0, 0);
      p.spin.set(0, 0, 0);
      p.low = this.lowestBelowCentre(p);
      p.obj.position.y = gy - p.low;
    }
  }

  private char(age: number) {
    const depth = this.severity === 1 || this.water ? 0.3 : 0.92;
    const burn = Math.min(1, Math.max(0, (age - 0.3) / 3)) * depth;
    for (const { m, base, rough } of this.charred) {
      m.color!.copy(base).lerp(CHAR, burn);
      if (m.roughness !== undefined) m.roughness = rough + (1 - rough) * burn;
    }
  }

  /** Burning pieces: flames and smoke, less and less; a mild crash only smoulders. */
  private burn(dt: number, camera?: Vec3Like) {
    this.emitAcc += dt;
    const far = !!camera && tmpV.set(camera.x, camera.y, camera.z).distanceTo(this.centre) > FAR;
    const step = 0.05 / this.fx.budget;
    const r = this.rnd;
    const age = this._age;
    while (this.emitAcc > step) {
      this.emitAcc -= step;
      if (far) continue;
      for (const p of this.pieces) {
        const pos = p.obj.position;
        const rr = Math.min(p.radius, 4 * this.k);
        if (this.severity === 1 && p.kind === 'hull' && !this.water && age < 25) {
          // Smouldering engine: thin grey smoke, no flames.
          if (r() < 0.3 * (1 - age / 25))
            this.emitSmoke({
              pos: pos.clone().add(new Vector3(0, rr * 0.4, 0)),
              vel: new Vector3(0, 1.5 + r(), 0),
              life: 6 + r() * 5,
              size0: rr * 0.5,
              size1: (5 + r() * 5) * Math.sqrt(this.k),
              color0: [0.25, 0.24, 0.23, 0.55],
              color1: [0.35, 0.34, 0.33, 0],
              drag: 0.8,
              lift: 0.8,
            });
          continue;
        }
        if (age > p.burnUntil || age < this.boomAt) continue;
        const fade = 1 - age / p.burnUntil;
        // Flames: overlapping tongues licking up from all over the piece (many faint ones
        // merge into one fire; few bright ones would read as separate blobs).
        const tongues = rr > 1.5 ? 3 : 2;
        for (let f = 0; f < tongues; f++)
          if (r() < 0.8 * fade + 0.2) {
            const hot = r();
            this.emitFire({
              pos: pos.clone().add(
                rand3(r)
                  .multiplyScalar(rr)
                  .setY((r() - 0.4) * rr * 0.4),
              ),
              vel: new Vector3(p.vel.x, p.vel.y + 1.5 + r() * 2.5, p.vel.z),
              life: 0.5 + r() * 0.6,
              size0: rr * (0.7 + r() * 0.6),
              size1: rr * 0.25,
              color0: [2 + 1.2 * hot, 0.75 + 0.7 * hot, 0.15 + 0.2 * hot, 0.5],
              color1: [1, 0.16, 0.02, 0],
              drag: 1,
              lift: 6,
              stretch: 2,
            });
          }
        // The glow of the fire in its own smoke, around its base.
        if (r() < 0.25 * fade)
          this.emitFire({
            pos: pos.clone().add(new Vector3(0, rr * 0.5, 0)),
            vel: new Vector3(0, 1, 0),
            life: 1 + r(),
            size0: rr * 2.5,
            size1: rr * 3.5,
            color0: [0.5, 0.17, 0.03, 0.4],
            color1: [0.3, 0.06, 0.01, 0],
            drag: 1,
            lift: 1,
          });
        if (r() < 0.35 * fade + 0.1) {
          this.emitSmoke({
            pos: pos.clone().add(new Vector3(0, rr * 0.6, 0)),
            vel: new Vector3(0, 3 + r() * 3, 0),
            life: 9 + r() * 9,
            size0: rr * 1.2,
            size1: (14 + r() * 12) * Math.sqrt(this.k),
            color0: [0.04, 0.038, 0.036, 0.6 * fade + 0.15],
            color1: [0.12, 0.115, 0.11, 0],
            drag: 0.6,
            lift: 1.2,
          });
        }
      }
    }
  }

  /** The render origin moved to (dx, dy, dz) of the old render space: everything shifts by -d. */
  rebase(dx: number, dy: number, dz: number) {
    tmpV.set(dx, dy, dz);
    this.centre.sub(tmpV);
    for (const p of this.pieces) p.obj.position.sub(tmpV);
    this.fx.light?.position.sub(tmpV);
    this.fx.fire.rebase(dx, dy, dz);
    this.fx.smoke.rebase(dx, dy, dz);
  }

  /** Clears the wreck away and gives the model back as it was (for the next flight). */
  dispose() {
    this.group.removeFromParent();
    this.fx.reset();
    for (const h of this.hidden) h.visible = true;
    this.hidden.length = 0;
    for (const { m, base, rough } of this.charred) {
      m.color!.copy(base);
      if (m.roughness !== undefined) m.roughness = rough;
    }
    this.charred.length = 0;
    for (const g of this.owned) {
      // The vertex buffers belong to the model: disposing them with the subset would free them
      // on the graphics card. Only the subset's own index goes.
      for (const name of Object.keys(g.attributes)) g.deleteAttribute(name);
      g.dispose();
    }
    this.owned.length = 0;
    this.pieces.length = 0;
  }
}

const tmpBox = new Box3();

function rand3(r: () => number) {
  return new Vector3(r() - 0.5, r() - 0.5, r() - 0.5);
}

/** A mesh's vertex positions in the model frame. */
function modelPositions(
  pos: BufferAttribute | InterleavedBufferAttribute,
  m: Matrix4,
): Float32Array {
  const e = m.elements;
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    out[i * 3] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
    out[i * 3 + 1] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
    out[i * 3 + 2] = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
  }
  return out;
}

/** Bounds of the vertices of `list` (or of all) in a model-frame position array. */
function boundsOf(P: Float32Array, list: number[] | null): Box3 {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  const n = list ? list.length : P.length / 3;
  for (let j = 0; j < n; j++) {
    const i = (list ? list[j]! : j) * 3;
    const x = P[i]!;
    const y = P[i + 1]!;
    const z = P[i + 2]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return new Box3(new Vector3(x0, y0, z0), new Vector3(x1, y1, z1));
}
