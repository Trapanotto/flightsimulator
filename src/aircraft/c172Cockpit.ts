/**
 * The Cessna 172S cockpit at work: every control posed from the cockpit's values, the gauges
 * from the instruments (or the plain telemetry), the radio stack and annunciators painted
 * from the avionics and systems, picking against hit boxes, and the checklist highlight.
 *
 * Draw calls: controls that share a shape are drawn instanced, the fixed dial faces and the
 * display windows are merged into one mesh each, all placard texts are one mesh. Outside the
 * cockpit view the small parts draw nothing (they stay in the scene, so the app's shader
 * compilation still finds them).
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
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
import { float, min, mix, sin, step, texture, uniform, uv, vec3, vec4 } from 'three/tsl';
import {
  C172_CONTROLS,
  type Cockpit,
  type ControlInput,
  type ControlSpec,
  type Telemetry,
} from '@sim';
import type { ControlHit } from './AircraftVisual';
import { DISPLAYS, DUAL_KNOBS, TURNING_FACES, controlNode } from './c172Parts';
import {
  DME_SOURCE_DEG,
  DualKnobTurn,
  FUEL_SELECTOR_DEG,
  KnobTurn,
  MAGNETO_DEG,
  SETTLE,
  TRIM_WHEEL_RAD,
  XPDR_DIGIT_DEG,
  XPDR_MODE_DEG,
  dimmerDeg,
  rockerAngle,
  selectorDeg,
  slideShare,
  xpdrDigits,
} from './controlPoses';
import { drawLabelAtlas } from './dials';
import { ATLAS_H, ATLAS_W, DisplayAtlas, PASSIVE, REGIONS, avionicsFromCockpit } from './displays';
import {
  KG_PER_GAL_AVGAS,
  MS_TO_KT,
  M_TO_FT,
  MS_TO_FPM,
  RAD_TO_DEG,
  C172S_TANK_GAL,
  altimeterAngles,
  asiAngle,
  attitudeCardOffset,
  flapIndicatorAngle,
  fuelPerTankGal,
  headingDelta,
  lag,
  slipBallAngle,
  smallGaugeAngle,
  tachAngle,
  turnCoordinatorAngle,
  vsiAngle,
} from './instruments';
import { darkness, displayGlow, highlightGlow, panelGlow } from './lights';
import { CABIN, type HitBox, OCCLUDERS, type V3, inBox, pickBox, sideOf } from './picking';

const DEG = Math.PI / 180;
/** Metres of indicated altitude per hPa of altimeter setting near sea level. */
const M_PER_HPA = 8.43;
const SPEC = new Map(C172_CONTROLS.map((s) => [s.id, s]));

type FloatU = { value: number };

interface Rig {
  spec: ControlSpec;
  node: Object3D;
  axis: Vector3;
  slide?: Vector3;
  rest: Vector3;
  /** Animated amount: radians or a share of the slide. */
  now: number;
  first: boolean;
}

/** Things the cockpit borrows from the aircraft it sits in. */
export interface CockpitHost {
  root: Object3D;
  cockpit: Object3D;
  faceMaterial: Material;
  panelLight: FloatU;
  aiOffset: FloatU;
  quality: 'high' | 'low';
  canvasTexture(canvas: HTMLCanvasElement, anisotropy?: number): CanvasTexture;
  track(m: Material): Material;
}

export class C172Cockpit {
  private readonly rigs = new Map<string, Rig>();
  private readonly extra = new Map<string, Rig>();
  private readonly turns = new Map<string, KnobTurn>();
  private readonly duals = new Map<string, DualKnobTurn>();
  private readonly pivots = new Map<
    string,
    { node: Object3D; axis: Vector3; rest: Vector3; slide?: Vector3; now: number }
  >();
  private readonly boxes: HitBox[] = [];
  private readonly instanced: { mesh: InstancedMesh; proxies: Object3D[] }[] = [];
  /** Meshes that draw nothing outside the cockpit view, with their full draw counts. */
  private readonly detail: { mesh: Mesh; count: number }[] = [];
  private readonly atlas: DisplayAtlas;
  private readonly atlasTexture: CanvasTexture;
  private readonly displayGain = uniform(1);
  private readonly labelGain = uniform(0.04);
  private readonly haloGain = uniform(0);
  private readonly haloTime = uniform(0);
  private readonly halo: Sprite;
  private haloBox: HitBox | undefined;
  private exposure = 4.2;
  private inside = true;
  private navSourcePulse = 0;
  private lastNavSource = -1;
  /** Bytes of the canvases this cockpit made (for the budget report). */
  textureBytes = 0;
  private s = {
    asi: 0,
    alt: 0,
    vsi: 0,
    tach: 0,
    tc: 0,
    ball: 0,
    yawRate: 0,
    rollRate: 0,
    heading: 0,
    bank: 0,
    compass: 0,
    oilT: 60,
    oilP: 0,
    egt: 0,
    vac: 0,
    amp: 0,
    ff: 0,
    cdi1: 0,
    gs1: 0,
    cdi2: 0,
    adf: 90,
    first: true,
  };

  constructor(private readonly host: CockpitHost) {
    const cab = host.cockpit;
    cab.updateMatrixWorld(true);
    this.collectRigs(cab);
    this.collectHitBoxes(cab);
    // Displays and placards.
    const scale = host.quality === 'low' ? 0.5 : 1;
    this.atlas = new DisplayAtlas(scale);
    this.atlasTexture = host.canvasTexture(this.atlas.canvas, 4);
    this.textureBytes += this.atlas.canvas.width * this.atlas.canvas.height * 4 * 1.33;
    this.setupDisplays(cab);
    this.setupLabels(cab, host.quality === 'low' ? 64 : 128);
    this.mergeFaces(cab);
    this.setupInstancing(cab);
    this.collectDetail(cab);
    this.halo = this.makeHalo();
    host.root.add(this.halo);
  }

  // ---------------------------------------------------------------------------------------
  // Setup

  private collectRigs(cab: Object3D) {
    const pivot = (o: Object3D) => {
      const a = o.userData.axis as number[] | undefined;
      const s = o.userData.slide as number[] | undefined;
      return {
        axis: a ? new Vector3(a[0], a[1], a[2]) : new Vector3(1, 0, 0),
        slide: s ? new Vector3(s[0], s[1], s[2]) : undefined,
        rest: o.position.clone(),
      };
    };
    for (const spec of C172_CONTROLS) {
      const node = cab.getObjectByName(controlNode(spec.id));
      if (!node) continue;
      this.rigs.set(spec.id, { spec, node, ...pivot(node), now: 0, first: true });
      const outer = cab.getObjectByName(`${controlNode(spec.id)}_outer`);
      if (outer)
        this.extra.set(`${spec.id}_outer`, {
          spec,
          node: outer,
          ...pivot(outer),
          now: 0,
          first: true,
        });
    }
    for (let i = 0; i < 4; i++) {
      const n = cab.getObjectByName(`XpdrDigit_${i}`);
      if (n)
        this.extra.set(`xpdrDigit${i}`, {
          spec: SPEC.get('xpdrCode')!,
          node: n,
          ...pivot(n),
          now: 0,
          first: true,
        });
    }
    const names = [
      'Needle_ASI',
      'Needle_ALT100',
      'Needle_ALT1000',
      'Needle_ALT10000',
      'Needle_VSI',
      'Needle_TACH',
      'Needle_FUELL',
      'Needle_FUELR',
      'Needle_OILT',
      'Needle_OILP',
      'Needle_EGT',
      'Needle_VAC',
      'Needle_AMP',
      'Needle_FF',
      'Needle_FLAPS',
      'Needle_ADF',
      'AI_Roll',
      'HI_Card',
      'HI_Bug',
      'TC_Plane',
      'TC_Ball',
      'Compass_Card',
      'CDI1_Card',
      'CDI1_Needle',
      'CDI1_GS',
      'CDI1_ToFrom',
      'CDI2_Card',
      'CDI2_Needle',
      'CDI2_ToFrom',
      'AI_Flag',
      'HI_Flag',
      'TC_Flag',
      'CDI1_NavFlag',
      'CDI1_GsFlag',
      'CDI2_NavFlag',
      'TrimInd',
    ];
    for (const n of names) {
      const o = cab.getObjectByName(n);
      if (o) this.pivots.set(n, { node: o, ...pivot(o), now: 0 });
    }
    for (const id of ['altimeterSetting', 'headingBug', 'gyroAdjust', 'obs1', 'obs2'])
      this.turns.set(id, new KnobTurn(id === 'altimeterSetting' ? 10 : 4));
    for (const id of DUAL_KNOBS) {
      const radio = id.startsWith('com') || id.startsWith('nav');
      this.duals.set(id, new DualKnobTurn(id === 'adfFrequency' ? 100 : 1000, radio));
    }
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

  private setupDisplays(cab: Object3D) {
    const tex = this.atlasTexture;
    const m = new MeshStandardNodeMaterial({ roughness: 0.25, metalness: 0 });
    m.name = 'Display';
    // Passive windows (the altimeter's drum) look painted and take the panel light; the rest
    // are dark glass that glows with its own backlight.
    const k = PASSIVE.map((id) => {
      const r = REGIONS[id];
      const u0 = r.x / ATLAS_W;
      const u1 = (r.x + r.w) / ATLAS_W;
      const v0 = r.y / ATLAS_H;
      const v1 = (r.y + r.h) / ATLAS_H;
      return step(u0, uv().x).mul(step(uv().x, u1)).mul(step(v0, uv().y)).mul(step(uv().y, v1));
    }).reduce((a, b) => a.add(b));
    const t = texture(tex, uv()).rgb;
    m.colorNode = vec4(t.mul(mix(float(0.12), float(1), k)), 1);
    m.emissiveNode = t.mul(mix(this.displayGain, this.labelGain, k));
    this.host.track(m);
    const meshes: Mesh[] = [];
    for (const id of DISPLAYS) {
      const node = cab.getObjectByName(`Disp_${id}`);
      const mesh = node && findMesh(node);
      if (!mesh) continue;
      const r = this.atlas.uvRect(id);
      const g = toFloat(mesh.geometry);
      const a = g.getAttribute('uv') as BufferAttribute;
      for (let i = 0; i < a.count; i++)
        a.setXY(i, r.u0 + a.getX(i) * (r.u1 - r.u0), r.v0 + a.getY(i) * (r.v1 - r.v0));
      mesh.geometry = g;
      meshes.push(mesh);
    }
    this.merge(meshes, m, 'Displays', cab);
  }

  private setupLabels(cab: Object3D, cellW: number) {
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

  /** The dials that never turn: one mesh. */
  private mergeFaces(cab: Object3D) {
    const meshes: Mesh[] = [];
    cab.traverse((o) => {
      if (!(o instanceof Mesh) || o.material !== this.host.faceMaterial) return;
      const name = o.name.endsWith('_geo') ? (o.parent?.name ?? '') : o.name;
      if (!name.startsWith('Face_') || TURNING_FACES.includes(name.slice(5) as never)) return;
      meshes.push(o);
    });
    this.merge(meshes, this.host.faceMaterial, 'Faces', cab);
  }

  private merge(meshes: Mesh[], material: Material, name: string, parent: Object3D) {
    if (!meshes.length) return;
    parent.updateMatrixWorld(true);
    const inv = new Matrix4().copy(parent.matrixWorld).invert();
    const parts = meshes.map((m) => {
      const g = toFloat(m.geometry.index ? m.geometry.toNonIndexed() : m.geometry);
      g.applyMatrix4(new Matrix4().multiplyMatrices(inv, m.matrixWorld));
      return g;
    });
    const merged = concat(parts);
    const mesh = new Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    parent.add(mesh);
    for (const m of meshes) m.removeFromParent();
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

  private updateInstances() {
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
    const small =
      /^(Ctl_|Needle_|CDI|HI_|AI_Flag|TC_|Xpdr|TrimInd|Inst_|Labels|Displays|Cabin_needle|Cabin_gauge_glass|Cabin_steel|Cabin_chrome)/;
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
    if (!inBox(o, CABIN.center, CABIN.half)) return null;
    const hit = pickBox(o, [dir.x, dir.y, dir.z], this.boxes, OCCLUDERS);
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

  update(
    dt: number,
    t: Telemetry,
    c: ControlInput,
    cockpit: Cockpit | undefined,
    altOffset: number,
    panelLight: number,
  ) {
    const first = this.s.first;
    this.s.first = false;
    const value = (id: string): number => {
      if (cockpit?.has(id)) return cockpit.get(id);
      const spec = SPEC.get(id)!;
      switch (id) {
        case 'throttle':
          return c.throttle[0] ?? 0;
        case 'mixture':
          return c.mixture[0] ?? 1;
        case 'flaps':
          return c.flaps * 3;
        case 'trim':
          return c.pitchTrim;
        case 'parkingBrake':
          return c.parkingBrake ? 1 : 0;
      }
      const running = t.engines.some((e) => e.running);
      return running ? (spec.running ?? spec.initial) : spec.initial;
    };
    this.poseControls(dt, value, first);
    this.instruments(dt, t, c, cockpit, value, altOffset, first);
    if (this.inside) this.updateInstances();
    // Lighting.
    this.host.panelLight.value = panelGlow(this.exposure, panelLight);
    // White paint reads brighter than a dial face in the cabin's shade.
    this.labelGain.value = this.host.panelLight.value + 0.06 * (1 - darkness(this.exposure));
    this.displayGain.value = displayGlow(this.exposure);
    this.haloGain.value = this.haloBox && this.inside ? highlightGlow(this.exposure) : 0;
    this.haloTime.value = t.time;
    // Displays.
    const avionics = t.avionics ?? avionicsFromCockpit(cockpit);
    if (
      this.atlas.update(dt, {
        avionics,
        systems: t.systems,
        altimeterSetting: value('altimeterSetting'),
        gpsCdi: value('navSource') >= 0.5,
        time: t.time,
      })
    )
      this.atlasTexture.needsUpdate = true;
  }

  private poseControls(dt: number, value: (id: string) => number, first: boolean) {
    const settle = (r: Rig, target: number, tau: number) => {
      r.now = r.first || first ? target : lag(r.now, target, dt, tau);
      r.first = false;
      return r.now;
    };
    const turn = (r: Rig, rad: number) => r.node.quaternion.setFromAxisAngle(r.axis, rad);
    const slide = (r: Rig, share: number) => {
      if (r.slide) r.node.position.copy(r.rest).addScaledVector(r.slide, share);
    };
    for (const [id, r] of this.rigs) {
      const spec = r.spec;
      const v = value(id);
      switch (id) {
        case 'magnetos':
          turn(r, -settle(r, selectorDeg(MAGNETO_DEG, v) * DEG, SETTLE.selector));
          break;
        case 'fuelSelector':
          turn(r, settle(r, selectorDeg(FUEL_SELECTOR_DEG, v) * DEG, SETTLE.selector * 2));
          break;
        case 'xpdrMode':
          turn(r, -settle(r, selectorDeg(XPDR_MODE_DEG, v) * DEG, SETTLE.selector));
          break;
        case 'dmeSource':
          turn(r, settle(r, selectorDeg(DME_SOURCE_DEG, v) * DEG, SETTLE.toggle));
          break;
        case 'trim': {
          turn(r, settle(r, v * TRIM_WHEEL_RAD, SETTLE.lever));
          const ind = this.pivots.get('TrimInd');
          if (ind?.slide)
            ind.node.position.copy(ind.rest).addScaledVector(ind.slide, r.now / TRIM_WHEEL_RAD);
          break;
        }
        case 'lightPanel':
          turn(r, -settle(r, dimmerDeg(v) * DEG, SETTLE.knob));
          break;
        case 'xpdrCode': {
          const d = xpdrDigits(v);
          for (let i = 0; i < 4; i++) {
            const e = this.extra.get(`xpdrDigit${i}`);
            if (e) turn(e, -settle(e, d[i]! * XPDR_DIGIT_DEG * DEG, SETTLE.knob));
          }
          break;
        }
        case 'navSource': {
          // A key: it dips briefly when the source changes.
          if (this.lastNavSource >= 0 && v !== this.lastNavSource) this.navSourcePulse = 0.15;
          this.lastNavSource = v;
          this.navSourcePulse = Math.max(0, this.navSourcePulse - dt);
          slide(r, settle(r, this.navSourcePulse > 0 ? 1 : 0, SETTLE.button));
          break;
        }
        default: {
          const knob = this.turns.get(id);
          const dual = this.duals.get(id);
          if (knob) turn(r, -settle(r, knob.update(spec, v) * DEG, SETTLE.knob));
          else if (dual) {
            const a = dual.update(spec, v);
            turn(r, -settle(r, a.inner * DEG, SETTLE.knob));
            const o = this.extra.get(`${id}_outer`);
            if (o) turn(o, -settle(o, a.outer * DEG, SETTLE.knob));
          } else if (spec.kind === 'toggle' && !r.slide)
            turn(r, settle(r, rockerAngle(v), SETTLE.toggle));
          else if (r.slide) {
            const tau =
              spec.kind === 'button'
                ? SETTLE.button
                : spec.kind === 'lever'
                  ? SETTLE.lever
                  : SETTLE.selector;
            slide(r, settle(r, slideShare(id, v, spec), tau));
          }
        }
      }
    }
  }

  private needle(name: string, deg: number) {
    const p = this.pivots.get(name);
    if (p) p.node.quaternion.setFromAxisAngle(p.axis, -deg * DEG);
  }

  private spin(name: string, rad: number) {
    const p = this.pivots.get(name);
    if (p) p.node.quaternion.setFromAxisAngle(p.axis, rad);
  }

  /** Flags and the TO/FROM triangle: 1 = in view, 0 = slid away behind the bezel. */
  private flag(name: string, shown: boolean, dt: number, first: boolean) {
    const p = this.pivots.get(name);
    if (!p?.slide) return;
    p.now = first ? (shown ? 1 : 0) : lag(p.now, shown ? 1 : 0, dt, 0.12);
    p.node.position.copy(p.rest).addScaledVector(p.slide, 1 - p.now);
  }

  private instruments(
    dt: number,
    t: Telemetry,
    c: ControlInput,
    cockpit: Cockpit | undefined,
    value: (id: string) => number,
    altOffset: number,
    first: boolean,
  ) {
    const s = this.s;
    const k = (tau: number) => (first ? 0 : tau);
    const ins = t.instruments;
    const sys = t.systems;
    // --- flight instruments ---
    s.asi = lag(s.asi, (ins ? ins.airspeed : t.ias) * MS_TO_KT, dt, k(0.15));
    this.needle('Needle_ASI', asiAngle(s.asi));
    const setting = value('altimeterSetting');
    const altM = ins ? ins.altitude : t.altitude + altOffset + (setting - 1013.25) * M_PER_HPA;
    s.alt = lag(s.alt, altM * M_TO_FT, dt, k(0.15));
    const alt = altimeterAngles(s.alt);
    this.needle('Needle_ALT100', alt.p100);
    this.needle('Needle_ALT1000', alt.p1000);
    this.needle('Needle_ALT10000', alt.p10000);
    // The instruments' own VSI already lags; the plain telemetry gets the lag here.
    s.vsi = lag(
      s.vsi,
      (ins ? ins.verticalSpeed : t.verticalSpeed) * MS_TO_FPM,
      dt,
      k(ins ? 0.2 : 1.2),
    );
    this.needle('Needle_VSI', vsiAngle(s.vsi));
    const pitch = ins ? ins.pitch : t.pitch;
    const bank = ins ? ins.bank : t.bank;
    this.spin('AI_Roll', bank);
    this.host.aiOffset.value = attitudeCardOffset(pitch * RAD_TO_DEG);
    const heading = ins ? ins.heading : t.headingDeg + value('gyroAdjust');
    this.spin('HI_Card', heading * DEG);
    this.needle('HI_Bug', headingDelta(heading, value('headingBug')));
    if (ins) s.compass = ins.compass;
    else
      s.compass =
        s.compass + headingDelta(s.compass, t.headingDeg) * (first ? 1 : 1 - Math.exp(-dt / 0.6));
    this.spin('Compass_Card', s.compass * DEG);
    if (!first && dt > 0) {
      s.yawRate = lag(s.yawRate, headingDelta(s.heading, t.headingDeg) / dt, dt, 0.3);
      s.rollRate = lag(s.rollRate, ((bank - s.bank) * RAD_TO_DEG) / dt, dt, 0.15);
    }
    s.heading = t.headingDeg;
    s.bank = bank;
    const turnRate = ins ? ins.turnRate : s.yawRate;
    const rollPart = ins?.turnFlag ? 0 : s.rollRate;
    s.tc = lag(s.tc, turnCoordinatorAngle(turnRate, rollPart), dt, k(0.25));
    this.needle('TC_Plane', s.tc);
    s.ball = lag(
      s.ball,
      ins ? Math.max(-1, Math.min(1, ins.slip)) * 10 : slipBallAngle(t.beta),
      dt,
      k(0.3),
    );
    // The ball pivot turns counter-clockwise to roll the ball to the pilot's right.
    this.spin('TC_Ball', s.ball * DEG);
    this.flag('AI_Flag', !!ins?.gyroFlag, dt, first);
    this.flag('HI_Flag', !!ins?.gyroFlag, dt, first);
    this.flag('TC_Flag', !!ins?.turnFlag, dt, first);
    // --- engine and systems ---
    const rpm = t.engines[0]?.rpm ?? 0;
    s.tach = lag(s.tach, rpm, dt, k(0.15));
    this.needle('Needle_TACH', tachAngle(s.tach));
    this.needle('Needle_FLAPS', flapIndicatorAngle(t.flaps));
    const gal = fuelPerTankGal(t.fuel);
    const fl = ins ? ins.fuelLeft * C172S_TANK_GAL : gal;
    const fr = ins ? ins.fuelRight * C172S_TANK_GAL : gal;
    this.needle('Needle_FUELL', smallGaugeAngle(fl, 0, C172S_TANK_GAL));
    this.needle('Needle_FUELR', smallGaugeAngle(fr, 0, C172S_TANK_GAL));
    const eng = t.engines[0];
    const running = !!eng?.running;
    const power = eng?.power ?? 0;
    if (sys) {
      s.oilT = lag(s.oilT, (sys.oilTemperature * 9) / 5 + 32, dt, k(0.5));
      s.oilP = lag(s.oilP, sys.oilPressure, dt, k(0.3));
      s.egt = lag(s.egt, sys.egt, dt, k(0.5));
      s.vac = lag(s.vac, sys.vacuum, dt, k(0.3));
      s.amp = lag(s.amp, sys.batteryAmps, dt, k(0.3));
    } else {
      s.oilT = lag(s.oilT, running ? 165 + 45 * power : 60, dt, first && running ? 0 : 60);
      s.oilP = lag(s.oilP, running ? 55 + 25 * Math.min(rpm / 2700, 1) : 0, dt, k(1));
      s.egt = lag(
        s.egt,
        running ? 0.35 + 0.5 * power * Math.min(1, c.mixture[0] ?? 1) : 0,
        dt,
        k(6),
      );
      s.vac = lag(s.vac, running ? 5 * Math.min(rpm / 900, 1) : 0, dt, k(0.6));
      s.amp = lag(s.amp, running ? 2 : 0, dt, k(0.5));
    }
    s.ff = lag(s.ff, ((eng?.fuelFlow ?? 0) * 3600) / KG_PER_GAL_AVGAS, dt, k(0.5));
    this.needle('Needle_OILT', smallGaugeAngle(s.oilT, 75, 250));
    this.needle('Needle_OILP', smallGaugeAngle(s.oilP, 0, 120));
    this.needle('Needle_EGT', smallGaugeAngle(s.egt, 0, 1));
    this.needle('Needle_VAC', smallGaugeAngle(s.vac, 3, 7));
    this.needle('Needle_AMP', smallGaugeAngle(s.amp, -60, 60));
    this.needle('Needle_FF', smallGaugeAngle(s.ff, 0, 20));
    // --- navigation ---
    const av = t.avionics ?? avionicsFromCockpit(cockpit);
    const on = !!av?.powered;
    const gps = value('navSource') >= 0.5;
    const nav1 = av?.nav1;
    const g = av?.gps;
    let dev1 = 0;
    let gs1: number | undefined;
    let tf1: 'to' | 'from' | 'off' = 'off';
    let valid1 = false;
    if (on && gps && g && g.active >= 0) {
      dev1 = -(g.crossTrackNm ?? 0) / 5;
      tf1 = 'to';
      valid1 = true;
    } else if (on && nav1?.valid) {
      dev1 = nav1.deviation;
      gs1 = nav1.glideSlope;
      tf1 = nav1.toFrom;
      valid1 = true;
    }
    this.courseIndicator(
      'CDI1',
      dt,
      first,
      nav1?.course ?? value('obs1'),
      dev1,
      tf1,
      valid1,
      gs1,
      true,
    );
    const nav2 = av?.nav2;
    const valid2 = on && !!nav2?.valid;
    this.courseIndicator(
      'CDI2',
      dt,
      first,
      nav2?.course ?? value('obs2'),
      valid2 ? nav2!.deviation : 0,
      valid2 ? nav2!.toFrom : 'off',
      valid2,
      undefined,
      false,
    );
    const adf = av?.adf;
    const rb = on && adf?.valid && adf.relativeBearing !== undefined ? adf.relativeBearing : 90;
    s.adf += headingDelta(s.adf, rb) * (first ? 1 : 1 - Math.exp(-dt / 0.4));
    this.needle('Needle_ADF', s.adf);
  }

  private courseIndicator(
    id: 'CDI1' | 'CDI2',
    dt: number,
    first: boolean,
    course: number,
    deviation: number,
    toFrom: 'to' | 'from' | 'off',
    valid: boolean,
    glide: number | undefined,
    hasGs: boolean,
  ) {
    const s = this.s;
    const card = this.pivots.get(`${id}_Card`);
    if (card) {
      card.now = first
        ? course
        : card.now + headingDelta(card.now, course) * (1 - Math.exp(-dt / 0.05));
      card.node.quaternion.setFromAxisAngle(card.axis, card.now * DEG);
    }
    const key = id === 'CDI1' ? 'cdi1' : 'cdi2';
    s[key] = lag(s[key], Math.max(-1, Math.min(1, deviation)), dt, first ? 0 : 0.25);
    // The needle hangs from a hinge 0.75 dial radii above the centre; full scale is half a radius.
    this.spin(`${id}_Needle`, Math.asin(s[key] * (0.5 / 0.75)));
    if (hasGs) {
      const target = glide === undefined ? -1.15 : Math.max(-1, Math.min(1, glide));
      s.gs1 = lag(s.gs1, target, dt, first ? 0 : 0.25);
      this.spin(`${id}_GS`, Math.asin(Math.max(-1, Math.min(1, s.gs1 * (0.5 / 0.75)))));
      this.flag(`${id}_GsFlag`, glide === undefined, dt, first);
    }
    this.flag(`${id}_NavFlag`, !valid, dt, first);
    const tf = this.pivots.get(`${id}_ToFrom`);
    if (tf) tf.node.quaternion.setFromAxisAngle(tf.axis, toFrom === 'from' ? Math.PI : 0);
    this.flag(`${id}_ToFrom`, toFrom !== 'off', dt, first);
  }

  dispose(textures: Texture[]) {
    textures.push(this.atlasTexture);
    for (const { mesh } of this.instanced) mesh.dispose();
  }
}

const tmpM = new Matrix4();
const tmpV = new Vector3();
const tmpV2 = new Vector3();

function findMesh(node: Object3D): Mesh | undefined {
  if (node instanceof Mesh) return node;
  let found: Mesh | undefined;
  node.traverse((o) => {
    if (!found && o instanceof Mesh) found = o;
  });
  return found;
}

/** A copy with plain float attributes (the optimiser quantises them), so it can be moved and merged. */
function toFloat(g: BufferGeometry): BufferGeometry {
  const out = new BufferGeometry();
  for (const name of ['position', 'normal', 'uv'] as const) {
    const a = g.getAttribute(name);
    if (!a) continue;
    const n = a.itemSize;
    const arr = new Float32Array(a.count * n);
    for (let i = 0; i < a.count; i++) {
      arr[i * n] = a.getX(i);
      if (n > 1) arr[i * n + 1] = a.getY(i);
      if (n > 2) arr[i * n + 2] = a.getZ(i);
    }
    out.setAttribute(name, new BufferAttribute(arr, n));
  }
  if (g.index) out.setIndex(g.index.clone());
  return out;
}

function concat(parts: BufferGeometry[]): BufferGeometry {
  const out = new BufferGeometry();
  for (const name of ['position', 'normal', 'uv'] as const) {
    if (!parts.every((p) => p.getAttribute(name))) continue;
    const n = parts[0]!.getAttribute(name).itemSize;
    const total = parts.reduce((s, p) => s + p.getAttribute(name).count, 0);
    const arr = new Float32Array(total * n);
    let off = 0;
    for (const p of parts) {
      const a = p.getAttribute(name).array as Float32Array;
      arr.set(a, off);
      off += a.length;
    }
    out.setAttribute(name, new BufferAttribute(arr, n));
  }
  out.computeBoundingSphere();
  return out;
}
