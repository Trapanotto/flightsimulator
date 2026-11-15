/**
 * The pilot outside the aircraft on screen: the skinned figure of the old game (built by
 * tools/aircraft/build_pilot.py, five animation clips) and two parachutes made here – the
 * sport rig's ram-air wing with its lines, and the round canopy of the ejection seat.
 *
 * Model frame as for the aircraft (x left, y up, z forward); the origin is the simulation's
 * reference point of the Parachutist, the hips. The app places `object` from the pilot's
 * state exactly as it places an aircraft; how the body lies, hangs or walks is done here.
 *
 * Everything is made once, with the flight, and only shown or hidden: `setCompileMode(true)`
 * shows every part so the app can build their shaders before the jump.
 */
import {
  AnimationAction,
  AnimationMixer,
  type AnimationClip,
  type Bone,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  LineBasicNodeMaterial,
  LineSegments,
  LoopRepeat,
  type Material,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  type Object3D,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { HIP_HEIGHT, type Parachutist } from '@sim';

type Clip = 'Idle' | 'Walk' | 'Run' | 'FreeFall' | 'Canopy';

/** Walking and running speeds the clips were made for, m/s (build_pilot.py). */
const CLIP_WALK = 1.6;
const CLIP_RUN = 5.5;
/** Shoulders above the hips, where the risers attach. */
const SHOULDER = 0.5;

export interface PilotVisualOptions {
  /** Overrides the model URL (default: BASE_URL + assets/aircraft/pilot.glb). */
  url?: string;
  /** 'low' for phones: fewer segments in the canopies. */
  quality?: 'high' | 'low';
}

/** Loads the figure and builds the canopies. Rejects if the model cannot be loaded. */
export async function loadPilotVisual(options: PilotVisualOptions = {}): Promise<PilotVisual> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(
    options.url ?? `${import.meta.env.BASE_URL}assets/aircraft/pilot.glb`,
  );
  return new PilotVisual(gltf.scene, gltf.animations, options.quality ?? 'high');
}

/** Same material, as a node material (the renderer's own kind; nothing converted later). */
function nodeMaterial(m: Material): MeshStandardNodeMaterial {
  const src = m as MeshStandardMaterial;
  const out = new MeshStandardNodeMaterial({
    color: src.color ?? new Color(0xffffff),
    roughness: src.roughness ?? 0.7,
    metalness: src.metalness ?? 0,
    side: src.side,
  });
  out.name = m.name;
  return out;
}

export class PilotVisual {
  readonly object = new Group();
  /** Rotates and offsets the figure for lying, hanging, standing. */
  private readonly body = new Group();
  private readonly mixer: AnimationMixer;
  private readonly clips = new Map<Clip, AnimationAction>();
  private clip?: Clip;
  private head?: Bone;
  private readonly arms: Bone[] = [];
  private readonly ramAir: Group;
  private readonly round: Group;
  /** The ram-air wing as it hangs over the jumper, for its pose. */
  private readonly rig = new Group();
  private firstPerson = false;
  private compileMode = false;
  private time = 0;
  /** Smoothed values for the pose. */
  private bank = 0;
  private pitch = 0;
  private upright = 0;
  private readonly materials: Material[] = [];
  private readonly geometries: BufferGeometry[] = [];

  constructor(scene: Object3D, animations: AnimationClip[], quality: 'high' | 'low') {
    this.object.name = 'Pilot';
    const swap = new Map<Material, MeshStandardNodeMaterial>();
    scene.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        const m = mesh.material as Material;
        let n = swap.get(m);
        if (!n) {
          n = nodeMaterial(m);
          swap.set(m, n);
          this.materials.push(n);
          m.dispose();
        }
        mesh.material = n;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // Skinned: the rest pose's bounds do not cover the animations; it is small anyway.
        mesh.frustumCulled = false;
        this.geometries.push(mesh.geometry);
      }
      const bone = o as Bone;
      if (bone.isBone) {
        // The loader strips the dots from the Blender names (Head, UpperArmL, ...).
        if (/^Head$/.test(bone.name)) this.head = bone;
        if (/^UpperArm/.test(bone.name)) this.arms.push(bone);
      }
    });
    // The model stands with its soles at the origin; the reference point is the hips.
    scene.position.y = -HIP_HEIGHT;
    this.body.add(scene);
    this.mixer = new AnimationMixer(scene);
    for (const c of animations) {
      const a = this.mixer.clipAction(c);
      a.setLoop(LoopRepeat, Infinity);
      this.clips.set(c.name as Clip, a);
    }
    const segments = quality === 'low' ? 1 : 2;
    this.ramAir = this.buildRamAir(segments);
    this.round = this.buildRound(quality === 'low' ? 16 : 24);
    this.rig.add(this.ramAir, this.round);
    this.object.add(this.body, this.rig);
    this.ramAir.visible = this.round.visible = false;
    this.object.visible = false;
    this.play('Idle');
  }

  /** In first person the head is folded away (the camera sits in it); the rest stays. */
  setFirstPerson(on: boolean) {
    this.firstPerson = on;
  }

  /** Back in the aircraft: nothing shown until the next `update`. */
  hide() {
    this.object.visible = false;
    this.ramAir.visible = this.round.visible = false;
  }

  /**
   * Shows every part (both canopies, the figure), shrunk to a speck, so that the app can
   * build their shaders before the jump: by `renderer.compileAsync(object, …)`, and – for
   * the shadow pass, which that does not cover – by drawing it a few frames anywhere in the
   * shadow map's reach (near the aircraft). Off again hides it until the pilot is out.
   */
  setCompileMode(on: boolean) {
    this.compileMode = on;
    this.object.visible = on;
    this.ramAir.visible = this.round.visible = on;
    this.object.scale.setScalar(on ? 1e-3 : 1);
    if (on) {
      this.ramAir.scale.setScalar(1);
      this.round.scale.setScalar(1);
    }
  }

  /** Per frame, after `object` has been placed from the pilot's state. */
  update(dt: number, p: Parachutist) {
    if (this.compileMode) return;
    this.object.visible = true;
    this.time += dt;
    const k = 1 - Math.exp(-dt * 4);
    const v = p.state.velocity;
    const up = p.up;
    const vu = v.x * up.x + v.y * up.y + v.z * up.z;
    const ground = Math.sqrt(Math.max(0, v.x * v.x + v.y * v.y + v.z * v.z - vu * vu));
    const b = this.body;
    b.position.set(0, 0, 0);
    b.rotation.set(0, 0, 0);
    if (p.mode === 'freefall') {
      // Belly to earth, arched: the figure laid flat, head forward, a little wobble.
      this.play('FreeFall');
      this.upright = 0;
      const wob = Math.sin(this.time * 5.3) * 0.04;
      b.rotation.set(Math.PI / 2 - 0.12, 0, wob);
      // Lying, the hips are the centre: the model's own hips are 0.95 m up its length.
      b.position.set(0, 0, 0);
    } else if (p.mode === 'canopy') {
      this.play('Canopy');
      // Line stretch swings the jumper from flat to hanging upright.
      this.upright += (1 - this.upright) * Math.min(1, dt * (p.deploy > 0 ? 3 : 1));
      if (p.sincePull >= 0 && p.deploy === 0) this.upright = Math.min(this.upright, 0.3);
      // Drawn at three quarters: the full bank swings the wing far out of the chase view.
      this.bank += (p.bank * 0.75 - this.bank) * k;
      this.pitch += (p.flare * 0.45 + p.brakes * 0.15 - this.pitch) * k;
      const lie = (1 - this.upright) * (Math.PI / 2 - 0.12);
      b.rotation.set(lie + this.pitch * 0.4, 0, 0);
    } else {
      this.upright = 1;
      if (!p.alive) {
        // Lying where the fall ended.
        this.play('Idle', 0);
        b.rotation.set(Math.PI / 2, 0, 0.3);
        b.position.set(0, -HIP_HEIGHT + 0.14, 0);
      } else if (p.swimming) {
        // Head out, the body tilted forward, paddling.
        this.play('Walk', 0.5);
        b.rotation.set(1.0, 0, 0);
        b.position.set(0, 0.25, 0);
      } else if (ground < 0.3) this.play('Idle');
      else if (ground < 3.2) this.play('Walk', ground / CLIP_WALK);
      else this.play('Run', ground / CLIP_RUN);
    }
    this.mixer.update(dt);
    this.poseArms(p);
    this.poseCanopy(p, dt);
    if (this.head) this.head.scale.setScalar(this.firstPerson ? 0.001 : 1);
  }

  /** Under the canopy the hands on the toggles come down with brakes and flare. */
  private poseArms(p: Parachutist) {
    if (p.mode !== 'canopy') return;
    const pull = Math.min(1, Math.max(p.brakes, p.flare));
    if (pull <= 0.01) return;
    for (const arm of this.arms) {
      const left = /L$/.test(arm.name);
      // Rotating each upper arm down about the body's sideways axis, and the inner toggle
      // on a turn further than the outer.
      const turn = left ? Math.max(0, -this.bank) : Math.max(0, this.bank);
      arm.rotateX(-(pull + turn) * 1.1);
    }
  }

  private poseCanopy(p: Parachutist, dt: number) {
    const rig = this.rig;
    const wing = p.canopy === 'ramAir' ? this.ramAir : this.round;
    const other = p.canopy === 'ramAir' ? this.round : this.ramAir;
    other.visible = false;
    if (p.mode === 'canopy') {
      wing.visible = true;
      // Inflation: the bag is out at line stretch, then the canopy spreads out and fills.
      const stretch = Math.min(1, p.sincePull / 0.9);
      const c = p.deploy;
      wing.scale.set(0.08 + 0.92 * c, 0.25 + 0.75 * Math.max(stretch * 0.6, c), 0.15 + 0.85 * c);
      wing.position.set(0, 0, 0);
      // The whole system banks into turns, and the wing pitches back in the flare.
      rig.position.set(0, SHOULDER * this.upright, 0);
      rig.rotation.set(-this.pitch * 0.6 + (1 - this.upright) * 0.9, 0, this.bank);
      this.body.rotation.z = this.bank * 0.9;
      wing.rotation.set(0, 0, 0);
    } else if (wing.visible && p.sinceLanding >= 0 && p.sinceLanding < 2.5) {
      // Collapsing after the landing: falls forward, away from the jumper, deflating.
      const t = p.sinceLanding / 2.5;
      const s = Math.max(0.05, 1 - t);
      rig.position.set(0, SHOULDER, 0);
      rig.rotation.set(t * 1.45, 0, 0);
      wing.scale.set(0.5 + 0.5 * s, s, 0.6 + 0.4 * s);
    } else {
      wing.visible = false;
    }
    void dt;
  }

  /** Cross-fades to an animation; `speed` scales its playback (walking pace). */
  private play(name: Clip, speed = 1) {
    const next = this.clips.get(name);
    if (!next) return;
    next.timeScale = speed;
    if (this.clip === name) return;
    const prev = this.clip ? this.clips.get(this.clip) : undefined;
    next.reset().play();
    if (prev) next.crossFadeFrom(prev, 0.35, false);
    this.clip = name;
  }

  /**
   * The ram-air wing: nine cells along an arc, airfoil-section, the upper skin bulging
   * between the ribs, red and white; four line groups per rib to the risers at the
   * shoulders, and the brake lines to the hands. Origin at the shoulders.
   */
  private buildRamAir(sub: number): Group {
    const g = new Group();
    g.name = 'RamAir';
    const cells = 9;
    const span = 7.4;
    const chord = 2.6;
    const thick = 0.17;
    const arc = 0.5; // radians from the centre to the tip
    const radius = span / 2 / Math.sin(arc);
    const height = 4.5;
    const red = new Color(0xc8102e);
    const white = new Color(0xf2f0ea);
    const navy = new Color(0x1d2a4a);
    // Airfoil around: from the tail over the top to the nose and back underneath.
    const ring: [number, number][] = [];
    const n = 10;
    for (let i = 0; i <= n; i++) {
      const x = 1 - i / n;
      ring.push([x, 1]);
    }
    for (let i = 1; i < n; i++) ring.push([i / n, -1]);
    const yOf = (x: number, side: number, bulge: number) => {
      // NACA-like thickness with camber; the cell nose is cut open, as on a real wing.
      const t =
        5 *
        thick *
        (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
      const camber = 0.06 * 4 * x * (1 - x);
      return (camber + side * t * (side > 0 ? bulge : 1)) * chord;
    };
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const ribs: { x: number; y: number; ang: number }[] = [];
    for (let c = 0; c < cells; c++) {
      const base = pos.length / 3;
      const colour = c === Math.floor(cells / 2) ? navy : c % 2 ? white : red;
      for (let sI = 0; sI <= sub; sI++) {
        const f = sI / sub;
        const a = -arc + (2 * arc * (c + f)) / cells;
        // Each cell is fullest between its ribs.
        const bulge = 0.88 + 0.12 * Math.sin(Math.PI * f);
        const cx = Math.sin(a) * radius;
        const cy = height - (radius - Math.cos(a) * radius);
        if (sI === 0) ribs.push({ x: cx, y: cy, ang: a });
        if (c === cells - 1 && sI === sub) ribs.push({ x: cx, y: cy, ang: a });
        for (const [x, side] of ring) {
          const y = yOf(x, side, bulge);
          // Radial outwards from the arc centre: (sin a, cos a) in x, y.
          pos.push(cx + Math.sin(a) * y, cy + Math.cos(a) * y, chord * (0.35 - x));
          col.push(colour.r, colour.g, colour.b);
        }
      }
      const m = ring.length;
      for (let sI = 0; sI < sub; sI++) {
        for (let r = 0; r < m; r++) {
          const a0 = base + sI * m + r;
          const a1 = base + sI * m + ((r + 1) % m);
          const b0 = a0 + m;
          const b1 = a1 + m;
          idx.push(a0, b0, a1, a1, b0, b1);
        }
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.8,
      metalness: 0,
      side: DoubleSide,
    });
    const wing = new Mesh(geo, mat);
    wing.castShadow = true;
    wing.frustumCulled = false;
    g.add(wing);
    this.geometries.push(geo);
    this.materials.push(mat);

    // Lines: A..D rows under every rib to the front and rear risers; brake lines from the
    // tail to the hands.
    const pts: number[] = [];
    const riserTop = 0.55;
    for (const r of ribs) {
      const side = r.x >= 0 ? 1 : -1;
      for (const [x, rear] of [
        [0.08, 0],
        [0.3, 0],
        [0.55, 1],
        [0.8, 1],
      ] as const) {
        const y = yOf(x, -1, 1);
        const px = r.x + Math.sin(r.ang) * y;
        const py = r.y + Math.cos(r.ang) * y;
        pts.push(px, py, chord * (0.35 - x), side * 0.2, riserTop, rear ? -0.05 : 0.05);
      }
      const tail = yOf(1, -1, 1);
      if (Math.abs(r.x) > span * 0.15)
        pts.push(r.x, r.y + tail, chord * -0.65, side * 0.28, -0.05, 0.18);
    }
    // The risers themselves, from the harness at the shoulders.
    for (const side of [-1, 1])
      for (const z of [-0.05, 0.05]) pts.push(side * 0.2, riserTop, z, side * 0.19, 0, z * 0.6);
    g.add(this.lines(pts, 0x2a2a2a));
    return g;
  }

  /** The round canopy: a dome of orange and white gores with its rigging lines. */
  private buildRound(gores: number): Group {
    const g = new Group();
    g.name = 'Round';
    const radius = 3.4;
    const apex = 6.6;
    const profile: Vector2[] = [];
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      // From the vent at the top to the skirt: a flattened dome.
      const r = 0.35 + (radius - 0.35) * Math.sin((t * Math.PI) / 2);
      const y = apex - 2.4 * (1 - Math.cos((t * Math.PI) / 2)) - 0.3 * t * t;
      profile.push(new Vector2(r, y));
    }
    const lathe = new LatheGeometry(profile, gores);
    const geo = lathe.toNonIndexed();
    lathe.dispose();
    const p = geo.getAttribute('position');
    const col = new Float32Array(p.count * 3);
    const orange = new Color(0xe8641e);
    const white = new Color(0xf2f0ea);
    for (let t = 0; t < p.count; t += 3) {
      const cx = (p.getX(t) + p.getX(t + 1) + p.getX(t + 2)) / 3;
      const cz = (p.getZ(t) + p.getZ(t + 1) + p.getZ(t + 2)) / 3;
      const gore = Math.floor(((Math.atan2(cz, cx) + Math.PI) / (2 * Math.PI)) * gores);
      const c = gore % 2 ? white : orange;
      for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (t + k) * 3);
    }
    geo.setAttribute('color', new Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mat = new MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0,
      side: DoubleSide,
    });
    const dome = new Mesh(geo, mat);
    dome.castShadow = true;
    dome.frustumCulled = false;
    g.add(dome);
    this.geometries.push(geo);
    this.materials.push(mat);
    const skirt = profile[n]!;
    const pts: number[] = [];
    const riser = new Vector3();
    for (let i = 0; i < gores; i++) {
      const a = (i / gores) * Math.PI * 2;
      const x = Math.sin(a) * skirt.x;
      const z = Math.cos(a) * skirt.x;
      riser.set(x >= 0 ? 0.2 : -0.2, 0.6, 0);
      pts.push(x, skirt.y, z, riser.x, riser.y, riser.z);
    }
    for (const side of [-1, 1]) pts.push(side * 0.2, 0.6, 0, side * 0.19, 0, 0);
    g.add(this.lines(pts, 0x3a3a3a));
    return g;
  }

  private lines(pts: number[], color: number): LineSegments {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pts, 3));
    const mat = new LineBasicNodeMaterial({ color });
    const lines = new LineSegments(geo, mat);
    lines.frustumCulled = false;
    this.geometries.push(geo);
    this.materials.push(mat);
    return lines;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.object.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
