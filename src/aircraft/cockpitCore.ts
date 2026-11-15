/**
 * What every operable cockpit has in common, configured per type: the controls posed from
 * their values by kind (rockers and toggles tilt, knobs turn by the steps they were turned,
 * selectors go to their detents, levers and buttons slide), hit boxes and picking, the
 * checklist highlight, placard labels, canvas display windows, and the cockpit lighting.
 *
 * The model supplies the geometry and the numbers (glTF extras on the `Ctl_<id>` and
 * `Hit_<id>` nodes, see tools/aircraft/lib/cockpit_kit.py); a type adds what only it has (the
 * Cessna's ignition key and transponder digits, the PC-12's displays) in its subclass.
 *
 * Draw calls: controls that share a shape are drawn instanced, labels are one mesh, and
 * outside the cockpit view the small parts draw nothing (they stay in the scene, so the app's
 * shader compilation still finds them).
 */
import {
  type CanvasTexture,
  Color,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Object3D,
  type PerspectiveCamera,
  Sprite,
  SpriteNodeMaterial,
  type Texture,
  Vector3,
} from 'three/webgpu';
import { min, sin, texture, uniform, uv, vec3, vec4 } from 'three/tsl';
import type { ControlSpec } from '@sim';
import type { ControlHit } from './AircraftVisual';
import {
  DualKnobTurn,
  KnobTurn,
  SETTLE,
  rockerAngle,
  selectorDeg,
  slideShare as defaultSlideShare,
} from './controlPoses';
import { drawLabelAtlas } from './dials';
import { lag } from './instruments';
import { darkness, displayGlow, highlightGlow, panelGlow } from './lights';
import { findMesh, mergeMeshes } from './meshUtil';
import { type HitBox, type V3, inBox, pickBox, sideOf } from './picking';

const DEG = Math.PI / 180;

export type FloatU = { value: number };

/** One posed control: its node, how it moves, and where it is now. */
export interface Rig {
  spec: ControlSpec;
  node: Object3D;
  axis: Vector3;
  slide?: Vector3;
  rest: Vector3;
  /** Detent angles of a rotary selector or a toggle's throw (extras.detents, degrees). */
  detents?: number[];
  /** Animated amount: radians or a share of the slide. */
  now: number;
  first: boolean;
}

/** Things the cockpit borrows from the aircraft it sits in. */
export interface CockpitHost {
  root: Object3D;
  cockpit: Object3D;
  panelLight: FloatU;
  quality: 'high' | 'low';
  canvasTexture(canvas: HTMLCanvasElement, anisotropy?: number): CanvasTexture;
  track(m: Material): Material;
}

export interface CockpitConfig {
  /** Every control of the type (C172_CONTROLS, PC12_CONTROLS). */
  controls: readonly ControlSpec[];
  /** Where a camera counts as sitting in the cabin, model frame. */
  cabin: { center: V3; half: V3 };
  /** Seats, glareshield and the like: nothing is reached through them. */
  occluders: readonly { center: V3; half: V3 }[];
  /** Knobs: degrees one step turns them (default 4). */
  knobDeg?: Readonly<Record<string, number>>;
  /** Dual concentric knobs: the outer ring's coarse step, and whether it wraps like a radio. */
  dualKnobs?: Readonly<Record<string, { coarse: number; radio: boolean }>>;
  /** Names (prefixes, as a pattern) of the small parts that draw nothing outside. */
  detail: RegExp;
  /** How far a sliding control is out of its rest position for a value (default controlPoses). */
  slideShare?(id: string, value: number, spec: ControlSpec): number;
}

export const controlNode = (id: string) => `Ctl_${id}`;

function pivotOf(o: Object3D) {
  const a = o.userData.axis as number[] | undefined;
  const s = o.userData.slide as number[] | undefined;
  return {
    axis: a ? new Vector3(a[0], a[1], a[2]) : new Vector3(1, 0, 0),
    slide: s ? new Vector3(s[0], s[1], s[2]) : undefined,
    rest: o.position.clone(),
  };
}

export abstract class CockpitCore {
  protected readonly specs: Map<string, ControlSpec>;
  protected readonly rigs = new Map<string, Rig>();
  /** Parts that move with a control but are not the control itself (outer rings, digits). */
  protected readonly extra = new Map<string, Rig>();
  protected readonly turns = new Map<string, KnobTurn>();
  protected readonly duals = new Map<string, DualKnobTurn>();
  private readonly boxes: HitBox[] = [];
  private readonly instanced: { mesh: InstancedMesh; proxies: Object3D[] }[] = [];
  /** Meshes that draw nothing outside the cockpit view, with their full draw counts. */
  private readonly detail: { mesh: Mesh; count: number }[] = [];
  protected readonly displayGain = uniform(1);
  protected readonly labelGain = uniform(0.04);
  private readonly haloGain = uniform(0);
  private readonly haloTime = uniform(0);
  private halo!: Sprite;
  private haloBox: HitBox | undefined;
  protected exposure = 4.2;
  protected inside = true;
  /** Bytes of the canvases this cockpit made (for the budget report). */
  textureBytes = 0;
  protected readonly ownTextures: Texture[] = [];

  constructor(
    protected readonly host: CockpitHost,
    protected readonly cfg: CockpitConfig,
  ) {
    this.specs = new Map(cfg.controls.map((s) => [s.id, s]));
    const cab = host.cockpit;
    cab.updateMatrixWorld(true);
    this.collectRigs(cab);
    this.collectHitBoxes(cab);
  }

  // ---------------------------------------------------------------------------------------
  // Setup

  private collectRigs(cab: Object3D) {
    for (const spec of this.cfg.controls) {
      const node = cab.getObjectByName(controlNode(spec.id));
      if (!node) continue;
      const detents = node.userData.detents as number[] | undefined;
      this.rigs.set(spec.id, { spec, node, ...pivotOf(node), detents, now: 0, first: true });
      const outer = cab.getObjectByName(`${controlNode(spec.id)}_outer`);
      if (outer)
        this.extra.set(`${spec.id}_outer`, {
          spec,
          node: outer,
          ...pivotOf(outer),
          now: 0,
          first: true,
        });
    }
    for (const spec of this.cfg.controls) {
      if (spec.kind !== 'knob') continue;
      const dual = this.cfg.dualKnobs?.[spec.id];
      if (dual) this.duals.set(spec.id, new DualKnobTurn(dual.coarse, dual.radio));
      else this.turns.set(spec.id, new KnobTurn(this.cfg.knobDeg?.[spec.id] ?? 4));
    }
  }

  /** A part that moves with a control (an outer ring, a transponder digit). */
  protected addExtra(key: string, id: string, node: Object3D) {
    this.extra.set(key, { spec: this.specs.get(id)!, node, ...pivotOf(node), now: 0, first: true });
  }

  /** A pivot that is not a control (a needle, a flag): its node, axis, travel. */
  protected pivot(node: Object3D) {
    return { node, ...pivotOf(node), now: 0 };
  }

  private collectHitBoxes(cab: Object3D) {
    const inv = new Matrix4().copy(this.host.root.matrixWorld).invert();
    const p = new Vector3();
    cab.traverse((o) => {
      if (!o.name.startsWith('Hit_')) return;
      const u = o.userData as {
        control?: string;
        half?: number[];
        side?: number[];
        step?: number;
        lever?: number;
      };
      if (!u.control || !u.half) return;
      o.getWorldPosition(p).applyMatrix4(inv);
      this.boxes.push({
        control: u.control,
        center: [p.x, p.y, p.z],
        half: u.half as unknown as V3,
        side: (u.side ?? [0, 0, 0]) as unknown as V3,
        step: u.step,
        lever: !!u.lever,
      });
    });
  }

  /** Every hit box, model frame (for tests and the demo's click test). */
  get hitBoxes(): readonly HitBox[] {
    return this.boxes;
  }

  /** The placard texts: one mesh, one canvas of texts. */
  protected setupLabels(cab: Object3D, cellW: number) {
    const node = cab.getObjectByName('Labels');
    const mesh = node && findMesh(node);
    if (!node || !mesh) return;
    const u = node.userData as {
      labels?: string[];
      labelColors?: string[];
      cols?: number;
      rows?: number;
    };
    const canvas = drawLabelAtlas(
      u.labels ?? [],
      u.labelColors ?? [],
      u.cols ?? 8,
      u.rows ?? 20,
      cellW,
    );
    this.textureBytes += canvas.width * canvas.height * 4 * 1.33;
    const tex = this.host.canvasTexture(canvas, 8);
    const m = new MeshStandardNodeMaterial({
      roughness: 0.6,
      metalness: 0,
      transparent: true,
      depthWrite: false,
    });
    m.name = 'Labels';
    m.colorNode = texture(tex, uv()).rgb;
    m.opacityNode = texture(tex, uv()).a;
    m.emissiveNode = texture(tex, uv()).rgb.mul(this.labelGain);
    mesh.material = this.host.track(m);
    mesh.renderOrder = 2;
  }

  protected merge(meshes: Mesh[], material: Material, name: string, parent: Object3D) {
    return mergeMeshes(meshes, material, name, parent);
  }

  /**
   * Ends the setup: controls of one shape become instanced meshes, the small parts are
   * marked to vanish outside, and the highlight ring is made. Call once at the end of the
   * subclass's constructor.
   */
  protected finishSetup() {
    const cab = this.host.cockpit;
    this.setupInstancing(cab);
    this.collectDetail(cab);
    this.halo = this.makeHalo();
    this.host.root.add(this.halo);
  }

  /** Controls of one shape (shared geometry) become one instanced mesh. */
  private setupInstancing(cab: Object3D) {
    const groups = new Map<string, Mesh[]>();
    cab.traverse((o) => {
      if (!(o instanceof Mesh) || o instanceof InstancedMesh) return;
      const key = `${o.geometry.uuid}/${(o.material as Material).uuid}`;
      const list = groups.get(key) ?? [];
      list.push(o);
      groups.set(key, list);
    });
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const first = list[0]!;
      const inst = new InstancedMesh(first.geometry, first.material, list.length);
      inst.name = `Inst_${first.parent?.name ?? first.name}`;
      inst.frustumCulled = false;
      inst.castShadow = first.castShadow;
      inst.receiveShadow = true;
      const proxies = list.map((m) => {
        const p = new Object3D();
        p.name = m.name;
        p.position.copy(m.position);
        p.quaternion.copy(m.quaternion);
        p.scale.copy(m.scale);
        m.parent!.add(p);
        m.removeFromParent();
        return p;
      });
      cab.add(inst);
      this.instanced.push({ mesh: inst, proxies });
    }
    this.updateInstances();
  }

  protected updateInstances() {
    const m = new Matrix4();
    for (const { mesh, proxies } of this.instanced) {
      mesh.parent!.updateWorldMatrix(true, false);
      const inv = m.copy(mesh.parent!.matrixWorld).invert();
      proxies.forEach((p, i) => {
        p.updateWorldMatrix(true, false);
        tmpM.multiplyMatrices(inv, p.matrixWorld);
        mesh.setMatrixAt(i, tmpM);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private collectDetail(cab: Object3D) {
    const small = this.cfg.detail;
    const owner = (o: Object3D): boolean => {
      for (let p: Object3D | null = o; p && p !== cab; p = p.parent)
        if (small.test(p.name)) return true;
      return false;
    };
    const found: Mesh[] = [];
    cab.traverse((o) => {
      if (o instanceof Mesh && owner(o)) found.push(o);
    });
    for (let mesh of found) {
      // A single instance: an instance count of 0 skips the draw altogether, where an empty
      // draw range would still issue one (and WebGPU warns about it).
      if (!(mesh instanceof InstancedMesh)) {
        const one = new InstancedMesh(mesh.geometry, mesh.material, 1);
        one.name = mesh.name;
        one.position.copy(mesh.position);
        one.quaternion.copy(mesh.quaternion);
        one.scale.copy(mesh.scale);
        one.castShadow = mesh.castShadow;
        one.receiveShadow = mesh.receiveShadow;
        one.renderOrder = mesh.renderOrder;
        one.frustumCulled = false;
        one.setMatrixAt(0, new Matrix4());
        const parent = mesh.parent!;
        parent.add(one);
        for (const ch of [...mesh.children]) one.add(ch);
        mesh.removeFromParent();
        mesh = one;
      }
      this.detail.push({ mesh, count: (mesh as InstancedMesh).count });
    }
  }

  private makeHalo(): Sprite {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const c = canvas.getContext('2d')!;
    // A ring: a crisp bright line with a soft glow either side, transparent in the middle.
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.55, 'rgba(255,255,255,0)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.78, 'rgba(255,255,255,1)');
    g.addColorStop(0.84, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    const tex = this.host.canvasTexture(canvas, 1);
    tex.flipY = true;
    this.textureBytes += size * size * 4 * 1.33;
    const m = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const col = new Color(1.0, 0.55, 0.08);
    const pulse = sin(this.haloTime.mul(4.2)).mul(0.25).add(0.75);
    const a = texture(tex, uv()).a;
    m.colorNode = vec4(
      vec3(col.r, col.g, col.b).mul(this.haloGain).mul(pulse),
      a.mul(min(this.haloGain, 1)),
    );
    this.host.track(m);
    const sprite = new Sprite(m);
    sprite.name = 'Highlight';
    sprite.renderOrder = 20;
    sprite.frustumCulled = false;
    sprite.scale.setScalar(1e-4);
    sprite.onBeforeRender = (_r, _s, camera) => {
      const b = this.haloBox;
      if (!b) return;
      // In front of the control, towards the eye, so the panel does not cut the ring.
      const inv = tmpM.copy(this.host.root.matrixWorld).invert();
      const eye = (camera as PerspectiveCamera).getWorldPosition(tmpV).applyMatrix4(inv);
      const c0 = tmpV2.set(b.center[0], b.center[1], b.center[2]);
      const r = Math.max(b.half[0], b.half[1], b.half[2]);
      const toEye = eye.sub(c0).normalize();
      sprite.position.copy(c0).addScaledVector(toEye, r * 0.8);
      const k = Math.min(Math.max(r * 2.6, 0.022), 0.16);
      sprite.scale.set(k, k, 1);
      sprite.updateMatrixWorld();
    };
    return sprite;
  }

  // ---------------------------------------------------------------------------------------
  // Interface

  setInside(inside: boolean) {
    if (inside === this.inside) return;
    this.inside = inside;
    for (const { mesh, count } of this.detail) (mesh as InstancedMesh).count = inside ? count : 0;
  }

  setExposure(exposure: number) {
    this.exposure = exposure;
  }

  highlight(id: string | null) {
    this.haloBox = id
      ? (this.boxes.find((b) => b.control === id && b.step === undefined) ??
        this.boxes.find((b) => b.control === id))
      : undefined;
  }

  /** The control a ray (model frame, unit direction) hits. */
  pick(origin: Vector3, dir: Vector3): ControlHit | null {
    if (!this.inside) return null;
    const o: V3 = [origin.x, origin.y, origin.z];
    if (!inBox(o, this.cfg.cabin.center, this.cfg.cabin.half)) return null;
    const hit = pickBox(o, [dir.x, dir.y, dir.z], this.boxes, this.cfg.occluders);
    if (!hit) return null;
    const b = hit.box;
    let side = sideOf(hit.point, b.center, b.side);
    if (b.lever) {
      // A lever with detents: a click below the handle moves it down the slot.
      const rig = this.rigs.get(b.control);
      if (rig?.slide) {
        const p = rig.node
          .getWorldPosition(tmpV)
          .applyMatrix4(tmpM.copy(this.host.root.matrixWorld).invert());
        const d = tmpV2.copy(rig.slide).normalize();
        const s =
          (hit.point[0] - p.x) * d.x + (hit.point[1] - p.y) * d.y + (hit.point[2] - p.z) * d.z;
        side = s > 0 ? 1 : -1;
      }
    }
    const out: ControlHit = { control: b.control, distance: hit.distance, side };
    if (b.step !== undefined) out.step = b.step;
    return out;
  }

  // ---------------------------------------------------------------------------------------
  // Per frame

  /** Moves a rig towards a target with the control's settling time (or at once on the first frame). */
  protected settle(r: Rig, target: number, tau: number, dt: number, first: boolean) {
    r.now = r.first || first ? target : lag(r.now, target, dt, tau);
    r.first = false;
    return r.now;
  }

  protected turn(r: Rig, rad: number) {
    r.node.quaternion.setFromAxisAngle(r.axis, rad);
  }

  protected slide(r: Rig, share: number) {
    if (r.slide) r.node.position.copy(r.rest).addScaledVector(r.slide, share);
  }

  /** A type's own way of posing a control; true when it took care of it. */
  protected poseSpecial(_id: string, _r: Rig, _v: number, _dt: number, _first: boolean): boolean {
    return false;
  }

  /** Every control posed from its value, by kind, unless the type poses it itself. */
  protected poseControls(dt: number, value: (id: string) => number, first: boolean) {
    const share = this.cfg.slideShare ?? defaultSlideShare;
    for (const [id, r] of this.rigs) {
      const spec = r.spec;
      const v = value(id);
      if (this.poseSpecial(id, r, v, dt, first)) continue;
      const knob = this.turns.get(id);
      const dual = this.duals.get(id);
      if (knob) this.turn(r, -this.settle(r, knob.update(spec, v) * DEG, SETTLE.knob, dt, first));
      else if (dual) {
        const a = dual.update(spec, v);
        this.turn(r, -this.settle(r, a.inner * DEG, SETTLE.knob, dt, first));
        const o = this.extra.get(`${id}_outer`);
        if (o) this.turn(o, -this.settle(o, a.outer * DEG, SETTLE.knob, dt, first));
      } else if (r.detents && !r.slide) {
        // A rotary selector, or a toggle thrown to one of its two positions.
        const tau = spec.kind === 'toggle' ? SETTLE.toggle : SETTLE.selector;
        const index = spec.kind === 'toggle' ? (v >= 0.5 ? 1 : 0) : v;
        this.turn(r, this.settle(r, selectorDeg(r.detents, index) * DEG, tau, dt, first));
      } else if (spec.kind === 'toggle' && !r.slide)
        this.turn(r, this.settle(r, rockerAngle(v), SETTLE.toggle, dt, first));
      else if (r.slide) {
        const tau =
          spec.kind === 'button'
            ? SETTLE.button
            : spec.kind === 'lever'
              ? SETTLE.lever
              : SETTLE.selector;
        this.slide(r, this.settle(r, share(id, v, spec), tau, dt, first));
      }
    }
  }

  /** Panel, label, display and highlight brightness for the exposure and the panel lights. */
  protected lighting(time: number, panelLight: number) {
    this.host.panelLight.value = panelGlow(this.exposure, panelLight);
    // White paint reads brighter than a dial face in the cabin's shade.
    this.labelGain.value = this.host.panelLight.value + 0.06 * (1 - darkness(this.exposure));
    this.displayGain.value = displayGlow(this.exposure);
    this.haloGain.value = this.haloBox && this.inside ? highlightGlow(this.exposure) : 0;
    this.haloTime.value = time;
  }

  dispose(textures: Texture[]) {
    textures.push(...this.ownTextures);
    for (const { mesh } of this.instanced) mesh.dispose();
  }
}

const tmpM = new Matrix4();
const tmpV = new Vector3();
const tmpV2 = new Vector3();
