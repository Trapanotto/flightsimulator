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

/** What the wreck needs from the world. */
export interface WreckEnv {
  heightAboveGround(p: Vector3): number | undefined;
  upAt(p: Vector3, out: Vector3): Vector3;
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
}

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
  private readonly fire = new ParticleSystem(900, true);
  private readonly smoke = new ParticleSystem(700, false);
  private readonly light = new PointLight(0xffa040, 0, 0, 2);
  private readonly centre = new Vector3();
  private age = 0;
  private emitAcc = 0;
  /** Size of the aircraft relative to a 10 m one (scales fire and debris speeds). */
  private readonly k: number;

  constructor(
    aircraft: Aircraft,
    velocity: Vector3,
    private readonly env: WreckEnv,
  ) {
    this.group.name = 'Wreck';
    this.k = Math.min(4, Math.max(0.8, aircraft.type.length / 10));
    this.group.add(this.fire.mesh, this.smoke.mesh, this.light);
    aircraft.root.updateMatrixWorld(true);
    this.centre.copy(aircraft.root.position);
    env.upAt(this.centre, up);
    const lod0 = aircraft.lod.levels[0]?.object;
    if (lod0) this.breakUp(lod0, velocity);
    this.light.position.copy(this.centre).addScaledVector(up, 3 * this.k);
    // The fire lights its surroundings, not the whole valley.
    this.light.distance = 160 * this.k;
    this.explode(velocity);
  }

  /** Old enough to be cleared away. */
  get done() {
    return this.age > 90;
  }

  private breakUp(lod0: Object3D, velocity: Vector3) {
    const horiz = velocity.clone().addScaledVector(up, -velocity.dot(up));
    for (const part of [...lod0.children]) {
      const name = part.name.replace(/_LOD\d$/, '');
      if (SKIP.test(name)) continue;
      const meshes: Mesh[] = [];
      part.traverse((o) => o instanceof Mesh && meshes.push(o));
      if (!meshes.length) continue;
      // The fuselage breaks into nose, cabin and tail.
      const groups =
        name === 'Fuselage' && meshes.length === 1
          ? sliceMesh(meshes[0]!, 3).map((m) => [m])
          : [meshes];
      for (const ms of groups) {
        const obj = new Group();
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
        // Pivot at the centre of the piece's bounding sphere.
        const box = new Vector3();
        let n = 0;
        let radius = 0.5;
        for (const m of obj.children as Mesh[]) {
          m.geometry.computeBoundingSphere();
          const s = m.geometry.boundingSphere!;
          box.add(s.center.clone().applyMatrix4(m.matrix));
          radius = Math.max(radius, s.radius * m.scale.x);
          n++;
        }
        box.divideScalar(Math.max(1, n));
        for (const m of obj.children) m.position.sub(box);
        obj.position.copy(box);
        this.group.add(obj);
        // Thrown along the flight path, up and outwards; small parts fly further.
        const light = 1 / Math.sqrt(Math.max(0.5, radius / this.k));
        const out = tmpV
          .copy(box)
          .sub(this.centre)
          .addScaledVector(up, -tmpV.copy(box).sub(this.centre).dot(up))
          .normalize();
        const vel = horiz
          .clone()
          .multiplyScalar(0.25 + Math.random() * 0.45)
          .addScaledVector(up, (4 + Math.random() * 9) * light * Math.sqrt(this.k))
          .addScaledVector(out, (3 + Math.random() * 9) * light)
          .add(
            new Vector3(
              Math.random() - 0.5,
              Math.random() - 0.5,
              Math.random() - 0.5,
            ).multiplyScalar(6 * light),
          );
        const spin = new Vector3(
          Math.random() - 0.5,
          Math.random() - 0.5,
          Math.random() - 0.5,
        ).multiplyScalar(9 * light);
        this.pieces.push({
          obj,
          vel,
          spin,
          radius,
          resting: false,
          burnUntil: Math.random() < 0.45 ? 15 + Math.random() * 40 : 2 + Math.random() * 4,
          mats,
        });
      }
    }
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
    // Flash: bright for a moment, then the glow of the fire.
    const flash = Math.exp(-this.age * 6) * 1.5e5;
    const glow =
      this.age < 45 ? 2.5e3 * (1 + 0.25 * Math.sin(this.age * 23) * Math.sin(this.age * 7)) : 0;
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
        const rest = p.radius * 0.35;
        if (h !== undefined && h < rest) {
          p.obj.position.addScaledVector(up, rest - h);
          const vn = p.vel.dot(up);
          if (vn < 0) p.vel.addScaledVector(up, -vn * 1.3);
          // Scrape along the ground.
          p.vel.multiplyScalar(0.55);
          p.spin.multiplyScalar(0.5);
          if (p.vel.lengthSq() < 0.6) {
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
        if (this.age > p.burnUntil) continue;
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
    this.fire.dispose();
    this.smoke.dispose();
    for (const p of this.pieces) {
      for (const { m } of p.mats) m.dispose();
      p.obj.traverse((o) => {
        // Sliced fuselage pieces own their index; shared geometries belong to the aircraft.
        if (o instanceof Mesh && o.geometry.userData.sliced) o.geometry.dispose();
      });
    }
  }
}
