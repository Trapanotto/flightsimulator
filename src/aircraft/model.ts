/**
 * What every aircraft model shares, configured per type: loading the .glb, the levels of
 * detail, pivots that turn or slide (control surfaces, propeller, wheels, gear), the materials
 * the renderer has to make (glass, lamps, the propeller disc, luminous paint), exterior light
 * glows, the landing-light spot, shadows, and the plumbing of the AircraftVisual interface
 * (picking, highlight, exposure, cockpit view) through the type's cockpit.
 *
 * A type subclasses AircraftModel: it wires its own materials in `wireMaterials`' hook, builds
 * its cockpit, calls `finishSetup`, and moves its parts in `animate`.
 *
 * Model frame: x left, y up, z forward, metres; origin = the centre of gravity.
 */
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  LOD,
  type Material,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardNodeMaterial,
  type Object3D,
  type PerspectiveCamera,
  Quaternion,
  type Raycaster,
  SRGBColorSpace,
  SpotLight,
  Sprite,
  SpriteNodeMaterial,
  type Texture,
  Vector3,
} from 'three/webgpu';
import {
  abs,
  cameraPosition,
  dot,
  float,
  mix,
  normalView,
  normalize,
  positionViewDirection,
  pow,
  smoothstep,
  texture,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Cockpit, ControlInput, Telemetry } from '@sim';
import type { AircraftVisual, AircraftVisualOptions, ControlHit, Vec3Like } from './AircraftVisual';
import type { CockpitCore, FloatU } from './cockpitCore';
import { drawGlow, drawPropDisc } from './dials';
import { lag } from './instruments';
import {
  type AircraftLights,
  autoLights,
  beaconIntensity,
  glowVisibility,
  strobeIntensity,
} from './lights';
import { partName } from './meshUtil';
import type { HitBox } from './picking';

const DEG = Math.PI / 180;

/** A light's glow sprite: colour, the direction it shines (model frame) and its visible cone. */
export interface GlowDef {
  color: number;
  /** Shines along this direction (model frame); without it, all round. */
  dir?: [number, number, number];
  /** cos of the angles where it starts and is fully visible. */
  cone?: [number, number];
  /** Size as a share of the screen height. */
  screen: number;
  /** The lamp sits on a moving part (a gear leg): the glow follows its anchor every frame. */
  follow?: boolean;
}

/** Brightness of the exterior lights, by lamp material and by glow kind. */
export interface LightLevels {
  lamps: Record<string, number>;
  glows: Record<string, number>;
  /** Landing-light spot, candela-like units of three's SpotLight. */
  spot: number;
}

/** The light switches with their flash phases, as `lightLevels` sees them. */
export interface LightState extends AircraftLights {
  /** 0..1 flash of the beacon and the strobes at this time. */
  beaconFlash: number;
  strobeFlash: number;
}

export interface ModelConfig {
  /** Name of the root object. */
  name: string;
  /** Distances (m) at which LOD0, LOD1, LOD2 take over. */
  lodDistances: readonly [number, number, number];
  chaseDistance: number;
  chaseHeight: number;
  /** Wheel pivots in the order of `wheelContacts` (nose, left, right). */
  wheels: readonly string[];
  /** Lamp materials (emissive, driven by the lights) and their colours. */
  lamps: Readonly<Record<string, number>>;
  /** Glow sprites by kind, anchored at `Glow_<kind>` empties. */
  glows: Readonly<Record<string, GlowDef>>;
  /** Propeller blade nodes that vanish into the blurred disc at speed. */
  blades: readonly string[];
  /** Propeller disc: tip and hub radius as a share of the disc. */
  disc: { tip: number; hub: number };
  /** Where the landing light sits if the model has no Glow_Landing (model frame). */
  landingLight: [number, number, number];
  /**
   * On quality 'low' LOD1 is the nearest level outside, and the full cockpit moves into it
   * (with the glow anchors): the exterior budget of a phone.
   */
  lowNearest?: boolean;
  /** Largest skin textures on quality 'low': the base colour, and the other maps. */
  lowTextureMax?: { map: number; other: number };
  /** Materials whose meshes cast no shadow, and those that receive none. */
  noShadow: RegExp;
  noReceive: RegExp;
}

export interface Pivot {
  node: Object3D;
  axis: Vector3;
  rest: Vector3;
  slide?: Vector3;
  props: Record<string, unknown>;
}

interface Glow {
  sprite: Sprite;
  kind: string;
  intensity: FloatU;
  pos: { value: Vector3 };
  dir: { value: Vector3 };
  localDir: Vector3;
  local: Vector3;
  /** Followed anchor (a lamp on a moving part). */
  anchor?: Object3D;
}

function asVec3(v: unknown): Vector3 | undefined {
  return Array.isArray(v) && v.length === 3 ? new Vector3(v[0], v[1], v[2]) : undefined;
}

/** Loads a type's .glb (meshopt-compressed) and returns its scene with world matrices set. */
export async function loadModelScene(file: string, url?: string): Promise<Object3D> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url ?? `${import.meta.env.BASE_URL}assets/aircraft/${file}`);
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  return scene;
}

export abstract class AircraftModel implements AircraftVisual {
  readonly object = new Group();
  readonly view: AircraftVisual['view'];
  readonly wheelContacts: Vec3Like[];

  protected readonly lod = new LOD();
  protected readonly lod0: Object3D;
  protected readonly pivots = new Map<string, Pivot>();
  protected readonly textures: Texture[] = [];
  protected readonly materials = new Set<Material>();
  private readonly glows: Glow[] = [];
  private readonly lamps = new Map<string, FloatU>();
  protected readonly glassOpacity = uniform(1);
  protected readonly discOpacity = uniform(0);
  protected readonly panelLight = uniform(0.04);
  protected readonly blades: Object3D[] = [];
  private spot?: SpotLight;
  /** The type's cockpit; set by the subclass before `finishSetup`. */
  protected abstract readonly cockpit: CockpitCore;
  private readonly glowScale: number;
  /** 0.2 by day .. 1 at night, see setExposure. */
  private glowVisibility = 1;
  /** The sky's exposure last given to setExposure. */
  protected exposure = 4.2;
  protected altOffset = 0;
  private lightsOverride: Partial<AircraftLights> | undefined;
  protected inside = false;
  protected first = true;
  private propAngle = 0;

  constructor(
    scene: Object3D,
    protected readonly quality: 'high' | 'low',
    protected readonly options: AircraftVisualOptions,
    protected readonly cfg: ModelConfig,
  ) {
    this.object.name = cfg.name;
    this.glowScale = options.glowScale ?? 1;
    const lod0 = scene.getObjectByName('LOD0')!;
    const lod1 = scene.getObjectByName('LOD1')!;
    const lod2 = scene.getObjectByName('LOD2')!;
    const low = quality === 'low' && !!cfg.lowNearest;
    if (low) {
      // The token cabin of LOD1 makes way for the full cockpit; everything else of LOD0 goes.
      lod1.getObjectByName('Cockpit_lod1')?.removeFromParent();
      lod1.add(lod0.getObjectByName('Cockpit')!);
    }
    this.lod0 = low ? lod1 : lod0;
    // Anchors and the eye are read in the model frame before the levels are re-parented.
    const eye = new Vector3();
    scene.getObjectByName('Eye')!.getWorldPosition(eye);
    this.view = {
      eye: { x: eye.x, y: eye.y, z: eye.z },
      chaseDistance: cfg.chaseDistance,
      chaseHeight: cfg.chaseHeight,
    };
    this.wheelContacts = cfg.wheels.map((n) => {
      const node = scene.getObjectByName(n)!;
      const p = node.getWorldPosition(new Vector3());
      const r = Number(node.userData.radius ?? 0.2);
      // Contact under the wheel with the strut at rest (the model is built standing on it).
      const below = Number(node.userData.contactBelow ?? r);
      return { x: p.x, y: p.y - below, z: p.z };
    });
    for (const level of [lod0, lod1, lod2]) level.removeFromParent();
    if (low) {
      this.lod.addLevel(lod1, cfg.lodDistances[0]);
      lod0.traverse((o) => (o as Mesh).geometry?.dispose());
    } else {
      this.lod.addLevel(lod0, cfg.lodDistances[0]);
      this.lod.addLevel(lod1, cfg.lodDistances[1]);
    }
    this.lod.addLevel(lod2, cfg.lodDistances[2]);
    this.object.add(this.lod);
    if (!low) this.collectPivots(lod0);
    this.collectPivots(lod1);
    this.collectPivots(lod2);
  }

  // ---------------------------------------------------------------------------------------
  // Setup helpers for the subclass

  private collectPivots(root: Object3D) {
    root.traverse((o) => {
      const axis = asVec3(o.userData.axis);
      if (!axis && !o.userData.slide) return;
      this.pivots.set(o.name, {
        node: o,
        axis: axis ?? new Vector3(1, 0, 0),
        rest: o.position.clone(),
        slide: asVec3(o.userData.slide),
        props: o.userData,
      });
    });
  }

  /** Turns a pivot (and its LOD1 twin) about its axis. */
  protected rotate(name: string, angle: number) {
    for (const n of [name, `${name}_lod1`]) {
      const p = this.pivots.get(n);
      if (p) p.node.quaternion.setFromAxisAngle(p.axis, angle);
    }
  }

  /** Moves a pivot (and its LOD1 twin) along its travel. */
  protected slideBy(name: string, amount: number) {
    for (const n of [name, `${name}_lod1`]) {
      const p = this.pivots.get(n);
      if (p?.slide) p.node.position.copy(p.rest).addScaledVector(p.slide, amount);
    }
  }

  protected track(m: Material): Material {
    this.materials.add(m);
    return m;
  }

  protected canvasTexture(canvas: HTMLCanvasElement, anisotropy = 8): CanvasTexture {
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    t.flipY = false;
    t.anisotropy = anisotropy;
    this.textures.push(t);
    return t;
  }

  /** Plexiglass: see-through head-on, a mirror at grazing angles (Fresnel). */
  protected fresnel() {
    return pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 4);
  }

  /**
   * Replaces the materials the renderer must make (glass, lamps, the propeller disc, the
   * luminous needles and pointers); `special` may claim a mesh first for the type's own.
   */
  protected wireMaterials(special?: (mesh: Mesh, mat: Material, owner: string) => boolean) {
    const quality = this.quality;
    const glassMat = new MeshStandardNodeMaterial({
      color: 0x0c1116,
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    });
    glassMat.name = 'Glass';
    const fresnel = this.fresnel();
    glassMat.opacityNode = mix(float(0.1), float(0.92), fresnel).mul(this.glassOpacity);
    this.track(glassMat);
    const gaugeGlass = new MeshStandardNodeMaterial({
      color: 0x050505,
      roughness: 0.03,
      transparent: true,
      depthWrite: false,
    });
    gaugeGlass.opacityNode = mix(float(0.04), float(0.6), fresnel);
    this.track(gaugeGlass);
    const lensMat = new MeshStandardNodeMaterial({
      color: 0xdfe6ea,
      roughness: 0.05,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    this.track(lensMat);

    const d = this.cfg.disc;
    const discTex = this.canvasTexture(
      drawPropDisc(quality === 'low' ? 256 : 512, d.tip, d.hub),
      4,
    );
    const discMat = new MeshStandardNodeMaterial({
      roughness: 0.7,
      metalness: 0,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    });
    discMat.colorNode = texture(discTex, uv()).rgb;
    discMat.opacityNode = texture(discTex, uv()).a.mul(this.discOpacity);
    this.track(discMat);

    const lampMats = new Map<string, Material>();
    for (const [name, hex] of Object.entries(this.cfg.lamps)) {
      const k = uniform(0);
      this.lamps.set(name, k);
      const m = new MeshStandardNodeMaterial({ color: hex, roughness: 0.3, metalness: 0 });
      const col = new Color(hex);
      m.emissiveNode = vec3(col.r, col.g, col.b).mul(k);
      lampMats.set(name, this.track(m));
    }

    // Needles and pointers are painted luminous: the gauges' lighting shows them at night.
    const lit = new Map<string, Material>();
    for (const [name, hex] of [
      ['Needle', 0xf0f0ec],
      ['NeedleOrange', 0xff7a12],
    ] as const) {
      const m = new MeshStandardNodeMaterial({ color: hex, roughness: 0.5, metalness: 0 });
      m.name = name;
      const col = new Color(hex);
      m.emissiveNode = vec3(col.r, col.g, col.b).mul(this.panelLight);
      lit.set(name, this.track(m));
    }
    this.object.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const mat = o.material as Material;
      if (special?.(o, mat, partName(o))) return;
      if (mat.name === 'Glass') o.material = glassMat;
      else if (mat.name === 'GaugeGlass') o.material = gaugeGlass;
      else if (mat.name === 'LightLens') o.material = lensMat;
      else if (mat.name === 'PropDisc') o.material = discMat;
      else if (lampMats.has(mat.name)) o.material = lampMats.get(mat.name)!;
      else if (lit.has(mat.name)) o.material = lit.get(mat.name)!;
      else {
        if (quality === 'low' && mat instanceof MeshPhysicalMaterial) mat.clearcoat = 0;
        this.materials.add(mat);
        for (const v of Object.values(mat))
          if (v && (v as Texture).isTexture) this.textures.push(v as Texture);
      }
    });
    if (quality === 'low')
      this.shrinkTextures(this.cfg.lowTextureMax ?? { map: 1024, other: 1024 });
  }

  /** Mobile: halve the skin textures in place (less memory and upload, same model). */
  private shrinkTextures(limit: { map: number; other: number }) {
    const colour = new Set<Texture>();
    for (const m of this.materials) {
      const map = (m as { map?: Texture | null }).map;
      if (map) colour.add(map);
    }
    for (const t of this.textures) {
      const img = t.image as { width?: number; height?: number } | undefined;
      const max = colour.has(t) ? limit.map : limit.other;
      if (!img?.width || !img.height || img.width <= max || t instanceof CanvasTexture) continue;
      const k = max / Math.max(img.width, img.height);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d')!.drawImage(t.image as CanvasImageSource, 0, 0, c.width, c.height);
      t.image = c;
      t.needsUpdate = true;
    }
  }

  /**
   * Ends the setup once the cockpit exists: glow sprites, the landing-light spot, shadows,
   * the propeller blades.
   */
  protected finishSetup() {
    this.cockpit.setInside(false);
    this.setupGlows(this.lod0);
    if (this.options.landingLightSpot) {
      // Created once with the aircraft; switching it off only zeroes the intensity, so the
      // scene's light count (and every shader) stays the same.
      const spot = new SpotLight(0xfff2dc, 0, 450, 0.2, 0.55, 1.6);
      const lamp = this.glows.find((g) => g.kind.startsWith('Landing'));
      spot.position.copy(lamp ? lamp.local : new Vector3(...this.cfg.landingLight));
      spot.target.position.copy(spot.position).add(new Vector3(0, -2.2, 20));
      spot.castShadow = false;
      this.object.add(spot, spot.target);
      this.spot = spot;
    }
    const { noShadow, noReceive } = this.cfg;
    this.object.traverse((o) => {
      if (o instanceof Mesh) {
        const name = (o.material as Material).name;
        o.castShadow = !noShadow.test(name);
        o.receiveShadow = !noReceive.test(name);
      }
    });
    for (const n of this.cfg.blades) {
      const b = this.object.getObjectByName(n);
      if (b) this.blades.push(b);
    }
  }

  private setupGlows(lod0: Object3D) {
    const tex = this.canvasTexture(drawGlow(64), 1);
    tex.flipY = true;
    for (const [kind, d] of Object.entries(this.cfg.glows)) {
      const anchors: Object3D[] = [];
      lod0.traverse((o) => {
        if (o.name === `Glow_${kind}` || o.name === `Glow_${kind}_lod1`) anchors.push(o);
      });
      for (const anchor of anchors) {
        const local = anchor.getWorldPosition(new Vector3());
        const color = uniform(new Color(d.color));
        const intensity = uniform(0);
        const pos = uniform(new Vector3());
        const dirLocal = d.dir ? new Vector3(...d.dir).normalize() : new Vector3(0, 0, 1);
        const dir = uniform(dirLocal.clone());
        const m = new SpriteNodeMaterial({
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
        });
        const vis = d.cone
          ? smoothstep(d.cone[0], d.cone[1], dot(normalize(cameraPosition.sub(pos)), dir))
          : float(1);
        // Additive: a bright core and a soft falloff, so strong flashes do not turn into discs.
        const g = pow(texture(tex, uv()).a, 2.2);
        m.colorNode = vec4(color.mul(intensity).mul(vis).mul(g), 1);
        const sprite = new Sprite(m);
        // A fixed share of the screen height, so a light reads the same at 50 m and at 2 km
        // and does not swamp a zoomed-in view; never smaller than the lamp's own halo.
        const fraction = d.screen;
        sprite.onBeforeRender = (_r, _s, camera) => {
          sprite.getWorldPosition(tmpV);
          const dist = tmpV.distanceTo(camera.getWorldPosition(tmpV2));
          const pc = camera as PerspectiveCamera;
          const span = pc.isPerspectiveCamera ? (2 * Math.tan((pc.fov * DEG) / 2)) / pc.zoom : 1;
          const world = Math.min(Math.max(fraction * dist * span, 0.18), 3.5);
          sprite.scale.set(world, world, 1);
          sprite.updateMatrixWorld();
        };
        sprite.position.copy(local);
        sprite.renderOrder = 10;
        sprite.frustumCulled = false;
        this.object.add(sprite);
        this.track(m);
        this.glows.push({
          sprite,
          kind,
          intensity,
          pos,
          dir,
          localDir: dirLocal,
          local,
          anchor: d.follow ? anchor : undefined,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // AircraftVisual

  setAltimeterOffset(metres: number): void {
    this.altOffset = metres;
  }

  setLights(lights: Partial<AircraftLights> | 'auto'): void {
    this.lightsOverride = lights === 'auto' ? undefined : { ...this.lightsOverride, ...lights };
  }

  pickControl(raycaster: Raycaster): ControlHit | null {
    if (!this.inside) return null;
    // The ray in the model's own frame: a handful of boxes, no raycast against the model.
    this.object.updateWorldMatrix(true, false);
    const inv = tmpM.copy(this.object.matrixWorld).invert();
    const o = tmpV.copy(raycaster.ray.origin).applyMatrix4(inv);
    const d = tmpV2.copy(raycaster.ray.direction).transformDirection(inv);
    return this.cockpit.pick(o, d);
  }

  highlightControl(id: string | null): void {
    this.cockpit.highlight(id);
  }

  /** Model-frame hit boxes of the cockpit controls (tests and the demo's click test). */
  get hitBoxes(): readonly HitBox[] {
    return this.cockpit.hitBoxes;
  }

  /** Bytes of the canvases painted at runtime (dials, displays, placards). */
  get canvasBytes(): number {
    let n = 0;
    for (const t of this.textures) {
      const img = t.image as { width?: number; height?: number } | undefined;
      if (t instanceof CanvasTexture && img?.width && img.height)
        n += img.width * img.height * 4 * 1.33;
    }
    return n;
  }

  /** Bytes of every texture of the aircraft on the graphics card (with mipmaps). */
  get textureBytes(): number {
    let n = 0;
    for (const t of new Set(this.textures)) {
      const img = t.image as { width?: number; height?: number } | undefined;
      if (img?.width && img.height) n += img.width * img.height * 4 * 1.33;
    }
    return n;
  }

  setExposure(exposure: number): void {
    this.glowVisibility = glowVisibility(exposure);
    this.exposure = exposure;
    this.cockpit.setExposure(exposure);
  }

  setCockpitView(inside: boolean): void {
    this.inside = inside;
    this.cockpit.setInside(inside);
    // From the seat the windshield must not veil the view; keep a hint of reflection.
    this.glassOpacity.value = inside ? 0.3 : 1;
  }

  /** The lights that are on: the systems' switches when present, else a pilot's habits. */
  protected lightSwitches(t: Telemetry, _cockpit?: Cockpit): AircraftLights {
    return { ...(t.systems?.lights ?? autoLights(t)), ...this.lightsOverride };
  }

  /** The type's lamp and glow brightness for the switches. */
  protected abstract lightLevels(L: LightState, t: Telemetry): LightLevels;

  /** Moves the type's parts and its cockpit. */
  protected abstract animate(
    dt: number,
    t: Telemetry,
    c: ControlInput,
    cockpit: Cockpit | undefined,
    lights: AircraftLights,
  ): void;

  update(dt: number, t: Telemetry, c: ControlInput, cockpit?: Cockpit): void {
    const L = this.lightSwitches(t, cockpit);
    this.animate(dt, t, c, cockpit, L);
    this.first = false;
    const levels = this.lightLevels(
      {
        ...L,
        beaconFlash: L.beacon ? beaconIntensity(t.time) : 0,
        strobeFlash: L.strobe ? strobeIntensity(t.time) : 0,
      },
      t,
    );
    for (const [name, k] of this.lamps) k.value = levels.lamps[name] ?? 0;
    this.object.updateWorldMatrix(true, false);
    const q = this.object.getWorldQuaternion(tmpQ);
    let inv: Matrix4 | undefined;
    for (const g of this.glows) {
      if (g.anchor) {
        inv ??= tmpM.copy(this.object.matrixWorld).invert();
        g.local.copy(g.anchor.getWorldPosition(tmpV)).applyMatrix4(inv);
        g.sprite.position.copy(g.local);
      }
      const lv = (levels.glows[g.kind] ?? 0) * this.glowScale * this.glowVisibility;
      g.intensity.value = lv;
      g.sprite.visible = lv > 0;
      g.pos.value.copy(g.local).applyMatrix4(this.object.matrixWorld);
      g.dir.value.copy(g.localDir).applyQuaternion(q);
    }
    if (this.spot) this.spot.intensity = levels.spot;
  }

  /**
   * Turns the propeller at its rpm and fades the blurred disc in: blades are seen when slow,
   * the disc when fast. `pivots` are the propeller nodes of each level.
   */
  protected spinPropeller(
    dt: number,
    rpm: number,
    pivots: readonly string[],
    blur: { from: number; span: number; bladesBelow: number },
  ) {
    this.propAngle = (this.propAngle + (rpm / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
    for (const n of pivots) {
      const p = this.pivots.get(n);
      if (p) p.node.quaternion.setFromAxisAngle(p.axis, this.propAngle);
    }
    const disc = Math.min(1, Math.max(0, (rpm - blur.from) / blur.span));
    this.discOpacity.value = disc * (this.inside ? 0.55 : 1);
    for (const b of this.blades) b.visible = rpm < blur.bladesBelow;
  }

  /** First-order lag that snaps on the first frame. */
  protected follow(current: number, target: number, dt: number, tau: number) {
    return this.first ? target : lag(current, target, dt, tau);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        const m = o.material as Material;
        this.materials.add(m);
      }
    });
    for (const m of this.materials) m.dispose();
    this.cockpit.dispose(this.textures);
    for (const t of this.textures) t.dispose();
    this.spot?.dispose();
  }
}

const tmpQ = new Quaternion();
const tmpM = new Matrix4();
const tmpV = new Vector3();
const tmpV2 = new Vector3();
