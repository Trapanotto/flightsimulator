import {
  BufferGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PointLight,
  Quaternion,
  Vector3,
} from 'three';
import type { Aircraft } from '../aircraft/Aircraft';
import { ParticleSystem } from '../render/Particles';
import { EXPLOSION_DELAY } from '../audio/FlightAudio';

/** What the wreck needs from the world. */
export interface WreckEnv {
  heightAboveGround(p: Vector3): number | undefined;
  upAt(p: Vector3, out: Vector3): Vector3;
}

/**
 * Fire, smoke and the light of a burning wreck, created once with the flight and kept in the
 * scene: a light added at the moment of a crash would make every material recompile (a stall
 * right at the impact), and the particle shaders are compiled ahead too.
 */
export class WreckFx {
  readonly group = new Group();
  readonly fire = new ParticleSystem(900, true);
  readonly smoke = new ParticleSystem(700, false);
  readonly light = new PointLight(0xffa040, 0, 0, 2);

  constructor() {
    this.group.name = 'WreckFx';
    this.group.add(this.fire.mesh, this.smoke.mesh, this.light);
  }

  reset() {
    this.fire.clear();
    this.smoke.clear();
    this.light.intensity = 0;
  }

  dispose() {
    this.group.removeFromParent();
    this.fire.dispose();
    this.smoke.dispose();
  }
}

/** Parts that do not fly off as debris (shatter, burn up or are too small to see). */
const SKIP =
  /^(Glass|PropDisc|Display_|Cockpit|Cabin|Yoke_|Stick_|Throttle_|Knob_|Column_|Wheel_|NavLight|Strobe|Beacon|Antenna|D_)/;

interface Piece {
  obj: Object3D;
  vel: Vector3;
  /** Angular velocity, rad/s (world axes). */
  spin: Vector3;
  radius: number;
  resting: boolean;
  /** Burns (emits fire and smoke) until this age. */
  burnUntil: number;
  mats: Array<{ m: MeshStandardMaterial; base: Color }>;
  /** The airframe that stays together, a torn-off section, or loose debris. */
  kind: 'hull' | 'section' | 'debris';
  /** Height of the piece's centre above the ground when it lies there, m. */
  restHeight: number;
}

/** How the aircraft hit the ground. */
export interface Impact {
  reason: 'terrain' | 'hard-landing' | 'gear-up' | 'wingtip' | 'nose';
  /** Speed (m/s), sink rate (m/s, positive down) and bank (rad, positive = right wing down). */
  speed: number;
  sink: number;
  bank: number;
  /** Stall speed of the aircraft (m/s): what counts as a landing-like touchdown. */
  vStall: number;
}

/**
 * 1 = survivable (hard or belly landing, slow): gear and propeller off, airframe whole;
 * 2 = a wing or the tail torn off; 3 = destroyed.
 */
export function severityOf(i: Impact): 1 | 2 | 3 {
  // Judged by the physics of the impact, not only by the part that touched first (a belly
  // landing with the nose a little low still reports "nose").
  const path = Math.asin(Math.min(1, i.sink / Math.max(i.speed, 1)));
  if (i.sink > 15 || i.speed > 2.2 * i.vStall || path > 25 * DEG) return 3;
  const wingDown = Math.abs(i.bank) > 25 * DEG || i.reason === 'wingtip';
  if (!wingDown && i.sink < 8 && i.speed < 1.7 * i.vStall) return 1;
  return 2;
}

/** Which parts break off together. */
function groupOf(name: string): string {
  if (/^Gear/.test(name)) return 'gear';
  if (/^(Propeller|Spinner)/.test(name)) return 'prop';
  if (/^(HStab|Elevator|Fin|Rudder|Dorsal)/.test(name)) return 'tail';
  const side = /_L$/.test(name) ? 'L' : /_R$/.test(name) ? 'R' : '';
  if (side && /^(Wing|Flap|Aileron|Winglet|Sharklet|Strake|Engine|Pylon|Fan)/.test(name))
    return `wing${side}`;
  return 'body';
}

const DEG = Math.PI / 180;

const CHAR = new Color(0.07, 0.065, 0.06);
const tmpQ = new Quaternion();
const tmpV = new Vector3();
const up = new Vector3();

/** Splits a mesh's triangles into `n` slabs along its local z (fuselage: nose, cabin, tail). */
function sliceMesh(mesh: Mesh, n: number): Mesh[] {
  const g = mesh.geometry;
  const pos = g.attributes.position!;
  const index = g.index;
  const tri = index ? index.count / 3 : pos.count / 3;
  const vert = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  g.computeBoundingBox();
  const z0 = g.boundingBox!.min.z;
  const z1 = g.boundingBox!.max.z;
  const lists: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < tri; t++) {
    const zc = (pos.getZ(vert(t, 0)) + pos.getZ(vert(t, 1)) + pos.getZ(vert(t, 2))) / 3;
    // Uneven, jagged cuts: the slab border wobbles with x and y.
    const wob = Math.sin(pos.getX(vert(t, 0)) * 9.1 + pos.getY(vert(t, 0)) * 7.3) * 0.04;
    const f = Math.min(n - 1, Math.max(0, Math.floor(((zc - z0) / (z1 - z0) + wob) * n)));
    lists[f]!.push(vert(t, 0), vert(t, 1), vert(t, 2));
  }
  return lists
    .filter((l) => l.length > 0)
    .map((l) => {
      const ng = new BufferGeometry();
      for (const [name, attr] of Object.entries(g.attributes)) ng.setAttribute(name, attr);
      ng.setIndex(l);
      ng.userData.sliced = true;
      const m = new Mesh(ng, mesh.material);
      mesh.updateMatrixWorld(true);
      m.userData.srcWorld = mesh.matrixWorld.clone();
      return m;
    });
}

/**
 * A crashed aircraft: the model breaks into its parts (fuselage cut in three), which fly off
 * with the impact, tumble, bounce on the terrain and char; a fireball, sparks and a flash,
 * then burning pieces under a rising column of smoke.
 */
export class Wreck {
  readonly group = new Group();
  private readonly pieces: Piece[] = [];
  private readonly fire: ParticleSystem;
  private readonly smoke: ParticleSystem;
  private readonly light: PointLight;
  private readonly centre = new Vector3();
  private age = 0;
  private emitAcc = 0;
  /** Size of the aircraft relative to a 10 m one (scales fire and debris speeds). */
  private k: number;
  private gearHeight = 1;

  constructor(
    aircraft: Aircraft,
    velocity: Vector3,
    private readonly env: WreckEnv,
    private readonly fx: WreckFx,
    impact: Impact,
  ) {
    this.group.name = 'Wreck';
    this.k = Math.min(4, Math.max(0.8, aircraft.type.length / 10));
    this.gearHeight = aircraft.type.physics.gearHeight;
    fx.reset();
    this.fire = fx.fire;
    this.smoke = fx.smoke;
    this.light = fx.light;
    aircraft.root.updateMatrixWorld(true);
    this.centre.copy(aircraft.root.position);
    env.upAt(this.centre, up);
    // The level of detail on screen right now: its geometry is already on the GPU (the
    // detailed level seen from the chase camera would first have to be uploaded: a stall).
    // The far level is one merged skin, so at most level 1.
    const level = Math.min(aircraft.lod.getCurrentLevel(), 1);
    const parts = aircraft.lod.levels[level]?.object;
    this.severity = severityOf(impact);
    if (parts) this.breakUp(parts, velocity, impact);
    this.light.position.copy(this.centre).addScaledVector(up, 3 * this.k);
    // The fire lights its surroundings, not the whole valley.
    this.light.distance = 160 * this.k;
    // First the aircraft breaks up (dust, sparks, parts flying), then the fuel goes up -
    // in step with the sound (audio/FlightAudio.synthCrash).
    this.impactDust(velocity);
    if (this.severity > 1) this.pendingExplosion = velocity.clone();
    if (this.severity === 2) this.k *= 0.65;
  }

  private pendingExplosion?: Vector3;
  /** Time of the explosion (age), for the flash. */
  private boomAt = Infinity;

  /** The impact: a cloud of dust and soil, sparks scraping off the metal. */
  private impactDust(velocity: Vector3) {
    const k = this.k;
    const c = this.centre;
    const drift = velocity.clone().multiplyScalar(0.25);
    for (let i = 0; i < 40; i++) {
      const dir = new Vector3(
        Math.random() - 0.5,
        Math.random() * 0.6,
        Math.random() - 0.5,
      ).normalize();
      dir.addScaledVector(up, 0.4).normalize();
      this.smoke.emit({
        pos: c.clone().addScaledVector(dir, Math.random() * 3 * k),
        vel: dir.multiplyScalar((4 + Math.random() * 10) * k).add(drift),
        life: 3 + Math.random() * 4,
        size0: 2 * k,
        size1: (9 + Math.random() * 8) * k,
        color0: [0.36, 0.31, 0.25, 0.75],
        color1: [0.42, 0.38, 0.33, 0],
        drag: 1.6,
        lift: 0.6,
      });
    }
    for (let i = 0; i < 50; i++) {
      const dir = new Vector3(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5)
        .normalize()
        .addScaledVector(up, 0.3)
        .normalize();
      this.fire.emit({
        pos: c.clone(),
        vel: dir.multiplyScalar(8 + Math.random() * 20).add(drift),
        life: 0.4 + Math.random() * 0.8,
        size0: 0.35 * k,
        size1: 0.1 * k,
        color0: [7, 4.5, 2, 1],
        color1: [3, 1, 0.2, 0],
        drag: 0.6,
        lift: -9.81,
      });
    }
  }

  /** Where to look: the airframe if it stayed together (it may slide far), else the impact. */
  get focus(): Vector3 {
    const hull = this.pieces.find((p) => p.kind === 'hull');
    return hull ? hull.obj.position : this.centre;
  }

  /** Old enough to be cleared away. */
  get done() {
    return this.age > 90;
  }

  /**
   * Breaks the model up according to the impact (see Impact / severityOf):
   *  1  gear and propeller break off; the airframe stays whole and slides to a stop
   *  2  also the wing that hit the ground (and often the tail); the fuselage holds
   *  3  everything flies apart, the fuselage in two or three pieces
   */
  private breakUp(parts: Object3D, velocity: Vector3, impact: Impact) {
    const sev = this.severity;
    const horiz = velocity.clone().addScaledVector(up, -velocity.dot(up));
    // Collect the meshes of every part, grouped by what breaks off together.
    const groups = new Map<string, Array<{ name: string; meshes: Mesh[] }>>();
    for (const part of [...parts.children]) {
      const name = part.name.replace(/_LOD\d$/, '');
      if (SKIP.test(name)) continue;
      const meshes: Mesh[] = [];
      part.traverse((o) => o instanceof Mesh && meshes.push(o));
      if (!meshes.length) continue;
      const g = groupOf(name);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push({ name, meshes });
    }
    // Which wing hit: the low one (bank > 0 = right wing down), or one at random when level.
    const side =
      Math.abs(impact.bank) > 8 * DEG
        ? impact.bank > 0
          ? 'R'
          : 'L'
        : Math.random() < 0.5
          ? 'L'
          : 'R';
    const tailOff = sev === 3 || (sev === 2 && (impact.sink > 9 || Math.random() < 0.5));
    const detached = (g: string) =>
      g === 'gear' ||
      g === 'prop' ||
      (sev >= 2 && g === `wing${side}`) ||
      (sev >= 2 && g === 'tail' && tailOff) ||
      sev === 3;

    // The hull: everything that stays together (one rigid piece).
    const hull: Mesh[] = [];
    for (const [g, list] of groups) {
      for (const { name, meshes } of list) {
        if (!detached(g)) {
          hull.push(...meshes);
          continue;
        }
        if (name === 'Fuselage' && sev === 3 && meshes.length === 1) {
          // Fuselage breaks behind the wing (and at the nose when very fast).
          const n = impact.speed > 80 ? 3 : 2;
          for (const m of sliceMesh(meshes[0]!, n)) this.addPiece([m], horiz, 'debris');
        } else if (sev === 3 || g === 'gear' || g === 'prop') {
          this.addPiece(meshes, horiz, 'debris');
        } else {
          // A torn-off wing or tail stays one piece (flaps and ailerons with it).
          this.addPiece(meshes, horiz, 'section', g);
        }
      }
      // Sections: the meshes of the group were added one by one above; merge them.
      if (sev === 2 && detached(g) && g !== 'gear' && g !== 'prop') this.mergeSection(g);
    }
    if (hull.length) this.addPiece(hull, horiz, 'hull');
  }

  /** Severity of the crash, 1..3. */
  private severity: 1 | 2 | 3 = 3;

  /** Builds a piece from meshes (world transforms baked) and gives it its motion. */
  private addPiece(ms: Mesh[], horiz: Vector3, kind: 'hull' | 'section' | 'debris', tag?: string) {
    const obj = new Group();
    obj.userData.tag = tag;
    const mats: Piece['mats'] = [];
    for (const src of ms) {
      // Bake the mesh's world transform, then re-centre the piece on its own middle.
      const m = src.parent ? src.clone() : src;
      const mw = src.parent ? src.matrixWorld : (src.userData.srcWorld as Matrix4);
      mw.decompose(m.position, m.quaternion, m.scale);
      m.updateMatrix();
      const list = Array.isArray(m.material) ? m.material : [m.material];
      const cloned = list.map((mm) => {
        const c = (mm as MeshStandardMaterial).clone();
        mats.push({ m: c, base: c.color.clone() });
        return c;
      });
      m.material = Array.isArray(m.material) ? cloned : cloned[0]!;
      m.castShadow = true;
      obj.add(m);
    }
    this.place(obj);
    const radius = obj.userData.radius as number;
    const centre = obj.position;
    this.group.add(obj);
    const sev = this.severity;
    const light = 1 / Math.sqrt(Math.max(0.5, radius / this.k));
    const out = tmpV
      .copy(centre)
      .sub(this.centre)
      .addScaledVector(up, -tmpV.copy(centre).sub(this.centre).dot(up))
      .normalize();
    const rnd = () => new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    let vel: Vector3;
    let spin: Vector3;
    if (kind === 'hull') {
      // Slides on along the ground, slowing with friction; a torn wing makes it swing round.
      vel = horiz
        .clone()
        .multiplyScalar(sev === 1 ? 0.9 : 0.65)
        .addScaledVector(up, sev === 1 ? 0.3 : 1.5);
      spin = up.clone().multiplyScalar((sev === 1 ? 0.15 : 0.8) * (Math.random() < 0.5 ? -1 : 1));
    } else {
      const force = sev === 1 ? 0.35 : sev === 2 ? 0.7 : 1;
      vel = horiz
        .clone()
        .multiplyScalar(0.25 + Math.random() * 0.45)
        .addScaledVector(up, (4 + Math.random() * 9) * light * Math.sqrt(this.k) * force)
        .addScaledVector(out, (3 + Math.random() * 9) * light * force)
        .add(rnd().multiplyScalar(6 * light * force));
      spin = rnd().multiplyScalar((kind === 'section' ? 4 : 9) * light * force);
    }
    // Fire: after a bad crash many pieces burn; a mild one only smoulders.
    const burnUntil =
      sev === 1
        ? kind === 'hull'
          ? 25
          : 0
        : kind === 'hull' || Math.random() < (sev === 3 ? 0.45 : 0.25)
          ? 15 + Math.random() * 40
          : 2 + Math.random() * 4;
    // Lying on the ground: the airframe on its belly (gear gone), a wing flat, debris low.
    const restHeight =
      kind === 'hull'
        ? Math.max(0.35, this.gearHeight * 0.5)
        : kind === 'section'
          ? Math.min(0.5, radius * 0.2)
          : Math.min(1, radius * 0.35);
    this.pieces.push({ obj, vel, spin, radius, resting: false, burnUntil, mats, kind, restHeight });
  }

  /** Pivot at the centre of the piece's bounding spheres; stores the radius. */
  private place(obj: Group) {
    const box = new Vector3();
    let n = 0;
    let radius = 0.5;
    for (const m of obj.children as Mesh[]) {
      m.geometry.computeBoundingSphere();
      const s = m.geometry.boundingSphere!;
      const c = s.center.clone().applyMatrix4(m.matrix);
      box.add(c);
      n++;
    }
    box.divideScalar(Math.max(1, n));
    for (const m of obj.children as Mesh[]) {
      const s = m.geometry.boundingSphere!;
      const c = s.center.clone().applyMatrix4(m.matrix);
      radius = Math.max(radius, c.distanceTo(box) + s.radius * m.scale.x);
    }
    for (const m of obj.children) m.position.sub(box);
    obj.position.copy(box);
    obj.userData.radius = radius;
  }

  /** Joins the pieces of a torn-off section (wing with its flaps and ailerons) into one. */
  private mergeSection(tag: string) {
    const parts = this.pieces.filter((p) => p.obj.userData.tag === tag);
    if (parts.length < 2) return;
    const [first, ...rest] = parts;
    const obj = new Group();
    obj.userData.tag = tag;
    for (const p of parts) {
      p.obj.updateMatrix();
      for (const m of [...p.obj.children]) {
        m.applyMatrix4(p.obj.matrix);
        obj.add(m);
      }
      p.obj.removeFromParent();
    }
    this.place(obj);
    this.group.add(obj);
    first!.obj = obj;
    first!.radius = obj.userData.radius as number;
    first!.kind = 'section';
    first!.restHeight = Math.min(0.5, first!.radius * 0.2);
    first!.mats = parts.flatMap((p) => p.mats);
    for (const r of rest) this.pieces.splice(this.pieces.indexOf(r), 1);
  }

  private explode(velocity: Vector3) {
    const k = this.k;
    const c = this.centre;
    const drift = velocity.clone().multiplyScalar(0.15);
    const rnd = () =>
      new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    // Fireball: hot core, expanding and rising.
    for (let i = 0; i < 70; i++) {
      const dir = rnd();
      if (dir.dot(up) < 0) dir.addScaledVector(up, -1.4 * dir.dot(up));
      this.fire.emit({
        pos: c.clone().addScaledVector(dir, Math.random() * 2 * k),
        vel: dir.multiplyScalar((6 + Math.random() * 22) * k).add(drift),
        life: 0.7 + Math.random() * 1.3,
        size0: (3 + Math.random() * 3) * k,
        size1: (10 + Math.random() * 10) * k,
        color0: [9, 5.5, 2.2, 1],
        color1: [1.6, 0.35, 0.05, 0],
        drag: 2.2,
        lift: 7,
      });
    }
    // Sparks and burning bits on ballistic arcs.
    for (let i = 0; i < 90; i++) {
      const dir = rnd().addScaledVector(up, 0.8).normalize();
      this.fire.emit({
        pos: c.clone(),
        vel: dir.multiplyScalar((12 + Math.random() * 35) * Math.sqrt(k)).add(drift),
        life: 1 + Math.random() * 2,
        size0: 0.5 * k,
        size1: 0.2 * k,
        color0: [8, 4, 1.2, 1],
        color1: [3, 0.6, 0.1, 0],
        drag: 0.35,
        lift: -9.81,
      });
    }
    // Black smoke bursting out of the fireball.
    for (let i = 0; i < 45; i++) {
      const dir = rnd();
      if (dir.dot(up) < 0) dir.addScaledVector(up, -1.2 * dir.dot(up));
      this.smoke.emit({
        pos: c.clone().addScaledVector(dir, 2 * k),
        vel: dir.multiplyScalar((3 + Math.random() * 10) * k).add(drift),
        life: 7 + Math.random() * 8,
        size0: 5 * k,
        size1: (22 + Math.random() * 18) * k,
        color0: [0.05, 0.045, 0.04, 0.85],
        color1: [0.16, 0.15, 0.14, 0],
        drag: 1.2,
        lift: 2.5,
      });
    }
  }

  update(dt: number, cameraPos: Vector3) {
    this.age += dt;
    this.env.upAt(this.centre, up);
    if (this.pendingExplosion && this.age >= EXPLOSION_DELAY) {
      // The fuel explodes where the wreckage is now (the middle of the heavy parts).
      const mid = new Vector3();
      let w = 0;
      for (const p of this.pieces) {
        mid.addScaledVector(p.obj.position, p.radius);
        w += p.radius;
      }
      if (w > 0) this.centre.copy(mid.divideScalar(w));
      this.light.position.copy(this.centre).addScaledVector(up, 3 * this.k);
      this.explode(this.pendingExplosion);
      this.pendingExplosion = undefined;
      this.boomAt = this.age;
    }
    const boomAge = this.age - this.boomAt;
    // Flash: bright for a moment, then the glow of the fire.
    const flash = boomAge >= 0 ? Math.exp(-boomAge * 6) * 1.5e5 : 0;
    const glow =
      boomAge >= 0 && this.age < 45
        ? 2.5e3 * (1 + 0.25 * Math.sin(this.age * 23) * Math.sin(this.age * 7))
        : 0;
    this.light.intensity = (flash + glow) * this.k * this.k;

    for (const p of this.pieces) {
      if (!p.resting) {
        p.vel.addScaledVector(up, -9.81 * dt);
        p.vel.multiplyScalar(Math.exp(-0.08 * dt));
        p.obj.position.addScaledVector(p.vel, dt);
        const w = p.spin.length();
        if (w > 1e-4)
          p.obj.quaternion.premultiply(
            tmpQ.setFromAxisAngle(tmpV.copy(p.spin).divideScalar(w), w * dt),
          );
        const h = this.env.heightAboveGround(p.obj.position);
        const rest = p.restHeight;
        if (h !== undefined && h < rest) {
          p.obj.position.addScaledVector(up, rest - h);
          const vn = p.vel.dot(up);
          // A small bounce for loose parts, none for the sliding airframe.
          if (vn < 0) p.vel.addScaledVector(up, -vn * (p.kind === 'hull' ? 1 : 1.3));
          // Sliding friction (~0.5 g), tumbling dies down.
          const vt = tmpV.copy(p.vel).addScaledVector(up, -p.vel.dot(up));
          const speed = vt.length();
          const dv = Math.min(speed, 0.5 * 9.81 * dt * (p.kind === 'hull' ? 1 : 2));
          if (speed > 0) p.vel.addScaledVector(vt, -dv / speed);
          p.spin.multiplyScalar(Math.exp(-dt * (p.kind === 'hull' ? 1.2 : 4)));
          if (p.kind !== 'hull') {
            // Loose parts settle flat instead of balancing on a corner.
            p.spin.multiplyScalar(0.97);
          }
          if (p.vel.lengthSq() < 0.3 && p.spin.lengthSq() < 0.05) {
            p.resting = true;
            p.vel.set(0, 0, 0);
          }
        }
      }
      // Charring.
      const burn = Math.min(1, Math.max(0, (this.age - 0.3) / 3));
      for (const { m, base } of p.mats) {
        m.color.copy(base).lerp(CHAR, burn * 0.92);
        m.roughness = 0.6 + 0.4 * burn;
        m.metalness *= 1 - burn * dt;
      }
    }

    // Burning pieces: flames and smoke, less and less.
    this.emitAcc += dt;
    const far = cameraPos.distanceTo(this.centre) > 6000;
    while (this.emitAcc > 0.05) {
      this.emitAcc -= 0.05;
      if (far) continue;
      for (const p of this.pieces) {
        if (this.age > p.burnUntil || this.age < this.boomAt) continue;
        const fade = 1 - this.age / p.burnUntil;
        const r = Math.min(p.radius, 4 * this.k);
        if (Math.random() < 0.8 * fade + 0.2) {
          this.fire.emit({
            pos: p.obj.position
              .clone()
              .add(
                new Vector3(
                  Math.random() - 0.5,
                  Math.random() - 0.5,
                  Math.random() - 0.5,
                ).multiplyScalar(r),
              ),
            vel: up
              .clone()
              .multiplyScalar(1 + Math.random() * 2)
              .add(p.vel),
            life: 0.5 + Math.random() * 0.8,
            size0: r * (0.5 + Math.random() * 0.5),
            size1: r * 0.25,
            color0: [6, 2.8, 0.8, 0.9],
            color1: [2, 0.4, 0.05, 0],
            drag: 1,
            lift: 5,
          });
        }
        if (Math.random() < 0.35 * fade + 0.1) {
          this.smoke.emit({
            pos: p.obj.position.clone().addScaledVector(up, r * 0.6),
            vel: up.clone().multiplyScalar(3 + Math.random() * 3),
            life: 9 + Math.random() * 9,
            size0: r * 1.2,
            size1: (14 + Math.random() * 12) * Math.sqrt(this.k),
            color0: [0.06, 0.055, 0.05, 0.7 * fade + 0.15],
            color1: [0.22, 0.21, 0.2, 0],
            drag: 0.6,
            lift: 1.2,
          });
        }
      }
    }
    this.fire.update(dt, up);
    this.smoke.update(dt, up);
  }

  rebase(delta: Vector3) {
    this.centre.sub(delta);
    this.light.position.sub(delta);
    for (const p of this.pieces) p.obj.position.sub(delta);
    this.fire.rebase(delta);
    this.smoke.rebase(delta);
  }

  dispose() {
    this.group.removeFromParent();
    this.fx.reset();
    for (const p of this.pieces) {
      for (const { m } of p.mats) m.dispose();
      p.obj.traverse((o) => {
        // Sliced fuselage pieces own their index; shared geometries belong to the aircraft.
        if (o instanceof Mesh && o.geometry.userData.sliced) o.geometry.dispose();
      });
    }
  }
}
