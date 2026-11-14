/**
 * Cessna 172S on screen: loads public/assets/aircraft/c172.glb (built by
 * tools/aircraft/build_c172.py), wires the materials that need the renderer (glass, dials,
 * propeller disc, lamps), and moves every part from the telemetry each frame.
 *
 * Model frame: x left, y up, z forward, metres; origin = the centre of gravity (FS 41 in,
 * 1.041 m aft of the firewall face, on the centre line, 1.22 m above the ground on the gear).
 */
import {
  AdditiveBlending,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  DoubleSide,
  Group,
  LOD,
  type Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardNodeMaterial,
  type Object3D,
  Matrix4,
  type PerspectiveCamera,
  Quaternion,
  type Raycaster,
  RepeatWrapping,
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
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Cockpit, ControlInput, Telemetry } from '@sim';
import type { AircraftVisual, AircraftVisualOptions, ControlHit, Vec3Like } from './AircraftVisual';
import { C172Cockpit } from './c172Cockpit';
import { FACES, type FaceId } from './c172Parts';
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  TILE_PAD,
  drawCompassBand,
  drawDialAtlas,
  drawGlow,
  drawPitchCard,
  drawPropDisc,
  tileOf,
} from './dials';
import { AI_CARD_RADIUS, AI_CARD_RANGE, AI_PITCH_SCALE, lag } from './instruments';
import {
  type AircraftLights,
  autoLights,
  beaconIntensity,
  glowVisibility,
  strobeIntensity,
} from './lights';

const DEG = Math.PI / 180;
/** Distances (m) at which the reduced models take over. */
export const LOD_DISTANCES = [0, 45, 170] as const;

interface Pivot {
  node: Object3D;
  axis: Vector3;
  rest: Vector3;
  slide?: Vector3;
  props: Record<string, unknown>;
}

/** What is kept of a uniform node after the material is built: its value. */
type FloatU = { value: number };
type Vec3U = { value: Vector3 };

interface Glow {
  sprite: Sprite;
  kind: string;
  intensity: FloatU;
  pos: Vec3U;
  dir: Vec3U;
  localDir: Vector3;
  local: Vector3;
}

function asVec3(v: unknown): Vector3 | undefined {
  return Array.isArray(v) && v.length === 3 ? new Vector3(v[0], v[1], v[2]) : undefined;
}

export async function loadC172(options: AircraftVisualOptions = {}): Promise<AircraftVisual> {
  const quality = options.quality ?? 'high';
  const url = options.url ?? `${import.meta.env.BASE_URL}assets/aircraft/c172.glb`;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  return new C172(scene, quality, options);
}

class C172 implements AircraftVisual {
  readonly object = new Group();
  readonly view: AircraftVisual['view'];
  readonly wheelContacts: Vec3Like[];

  private readonly lod = new LOD();
  private readonly pivots = new Map<string, Pivot>();
  private readonly textures: Texture[] = [];
  private readonly materials = new Set<Material>();
  private readonly glows: Glow[] = [];
  private readonly lamps = new Map<string, FloatU>();
  private readonly glassOpacity = uniform(1);
  private readonly discOpacity = uniform(0);
  private readonly aiOffset = uniform(0);
  private readonly panelLight = uniform(0.04);
  private readonly blades: Object3D[] = [];
  private readonly spot?: SpotLight;
  private readonly cockpit: C172Cockpit;
  private faceMaterial!: Material;
  private readonly glowScale: number;
  /** 0.2 by day .. 1 at night, see setExposure. */
  private glowVisibility = 1;
  private altOffset = 0;
  private lightsOverride: Partial<AircraftLights> | undefined;
  private inside = false;
  private first = true;
  // Animation state of the exterior.
  private s = {
    steer: 0,
    wheel: 0,
    wheelSpin: 0,
    prop: 0,
  };

  constructor(scene: Object3D, quality: 'high' | 'low', options: AircraftVisualOptions) {
    this.object.name = 'C172';
    this.glowScale = options.glowScale ?? 1;
    const lod0 = scene.getObjectByName('LOD0')!;
    const lod1 = scene.getObjectByName('LOD1')!;
    const lod2 = scene.getObjectByName('LOD2')!;
    // Anchors and the eye are read in the model frame before the levels are re-parented.
    const eye = new Vector3();
    scene.getObjectByName('Eye')!.getWorldPosition(eye);
    this.view = { eye: { x: eye.x, y: eye.y, z: eye.z }, chaseDistance: 17, chaseHeight: 3.5 };
    this.wheelContacts = ['Wheel_N', 'Wheel_L', 'Wheel_R'].map((n) => {
      const node = scene.getObjectByName(n)!;
      const p = node.getWorldPosition(new Vector3());
      const r = Number(node.userData.radius ?? 0.2);
      return { x: p.x, y: p.y - r, z: p.z };
    });
    for (const level of [lod0, lod1, lod2]) level.removeFromParent();
    this.lod.addLevel(lod0, LOD_DISTANCES[0]);
    this.lod.addLevel(lod1, LOD_DISTANCES[1]);
    this.lod.addLevel(lod2, LOD_DISTANCES[2]);
    this.object.add(this.lod);

    this.collectPivots(lod0);
    this.collectPivots(lod1);
    this.collectPivots(lod2);
    this.setupMaterials(quality);
    this.object.updateMatrixWorld(true);
    this.cockpit = new C172Cockpit({
      root: this.object,
      cockpit: lod0.getObjectByName('Cockpit')!,
      faceMaterial: this.faceMaterial,
      panelLight: this.panelLight,
      aiOffset: this.aiOffset,
      quality,
      canvasTexture: (c, a) => this.canvasTexture(c, a),
      track: (m) => this.track(m),
    });
    this.cockpit.setInside(false);
    this.setupGlows(lod0);
    if (options.landingLightSpot) {
      // Created once with the aircraft; switching it off only zeroes the intensity, so the
      // scene's light count (and every shader) stays the same.
      const spot = new SpotLight(0xfff2dc, 0, 450, 0.2, 0.55, 1.6);
      const lamp = this.glows.find((g) => g.kind === 'Landing');
      spot.position.copy(lamp ? lamp.local : new Vector3(2.9, 0.75, 0.3));
      spot.target.position.copy(spot.position).add(new Vector3(0, -2.2, 20));
      spot.castShadow = false;
      this.object.add(spot, spot.target);
      this.spot = spot;
    }
    this.object.traverse((o) => {
      if (o instanceof Mesh) {
        const name = (o.material as Material).name;
        const noShadow = /Glass|PropDisc|Lens|Lamp|GaugeGlass/.test(name);
        o.castShadow = !noShadow;
        o.receiveShadow = !/PropDisc|Lamp/.test(name);
      }
    });
    for (const n of ['PropBlades', 'PropBlades_lod1']) {
      const b = this.object.getObjectByName(n);
      if (b) this.blades.push(b);
    }
  }

  // ---------------------------------------------------------------------------------------

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

  private rotate(name: string, angle: number) {
    for (const n of [name, `${name}_lod1`]) {
      const p = this.pivots.get(n);
      if (p) p.node.quaternion.setFromAxisAngle(p.axis, angle);
    }
  }

  private slideBy(name: string, amount: number) {
    const p = this.pivots.get(name);
    if (p?.slide) p.node.position.copy(p.rest).addScaledVector(p.slide, amount);
  }

  private track(m: Material): Material {
    this.materials.add(m);
    return m;
  }

  private canvasTexture(canvas: HTMLCanvasElement, anisotropy = 8): CanvasTexture {
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    t.flipY = false;
    t.anisotropy = anisotropy;
    this.textures.push(t);
    return t;
  }

  private setupMaterials(quality: 'high' | 'low') {
    const tile = quality === 'low' ? 256 : 512;
    const atlas = this.canvasTexture(drawDialAtlas(tile));
    atlas.wrapS = atlas.wrapT = ClampToEdgeWrapping;
    const faceMat = new MeshStandardNodeMaterial({ map: atlas, roughness: 0.6, metalness: 0 });
    faceMat.name = 'GaugeFace';
    // A little self-light keeps the dials readable in the cabin's shadow; more at night with
    // the panel lights (switched with the position lights).
    faceMat.emissiveNode = texture(atlas, uv()).rgb.mul(this.panelLight);
    this.track(faceMat);
    this.faceMaterial = faceMat;

    const pitch = this.canvasTexture(drawPitchCard(quality === 'low' ? 256 : 512));
    const scaleV = (2 * AI_CARD_RADIUS) / AI_PITCH_SCALE / (2 * AI_CARD_RANGE);
    const aiMat = new MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
    aiMat.colorNode = texture(
      pitch,
      vec2(
        uv().x,
        uv()
          .y.mul(scaleV)
          .add(0.5 - scaleV / 2)
          .add(this.aiOffset),
      ),
    );
    aiMat.emissiveNode = texture(
      pitch,
      vec2(
        uv().x,
        uv()
          .y.mul(scaleV)
          .add(0.5 - scaleV / 2)
          .add(this.aiOffset),
      ),
    ).rgb.mul(this.panelLight);
    this.track(aiMat);

    const band = this.canvasTexture(drawCompassBand(quality === 'low' ? 512 : 1024));
    band.wrapS = RepeatWrapping;
    const compassMat = new MeshStandardNodeMaterial({ map: band, roughness: 0.5, metalness: 0 });
    this.track(compassMat);

    const glassMat = new MeshStandardNodeMaterial({
      color: 0x0c1116,
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    });
    glassMat.name = 'Glass';
    // Plexiglass: see-through head-on, a mirror at grazing angles (Fresnel).
    const fresnel = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 4);
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

    const discTex = this.canvasTexture(drawPropDisc(quality === 'low' ? 256 : 512, 0.93, 0.2), 4);
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

    const lampColors: Record<string, number> = {
      Lamp_NavRed: 0xff1a0d,
      Lamp_NavGreen: 0x19ff6a,
      Lamp_NavWhite: 0xffffff,
      Lamp_Beacon: 0xff2208,
      Lamp_Strobe: 0xeef4ff,
      Lamp_Landing: 0xfff3dd,
    };
    const lampMats = new Map<string, Material>();
    for (const [name, hex] of Object.entries(lampColors)) {
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
    const faceTiles = new Set<FaceId>(FACES);
    // Dial faces get their own geometry before their UVs move into the atlas: the optimiser
    // may share one disc between dials of the same shape.
    this.object.traverse((o) => {
      if (o instanceof Mesh && this.partName(o).startsWith('Face_'))
        o.geometry = o.geometry.clone();
    });
    this.object.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const mat = o.material as Material;
      const owner = this.partName(o);
      if (owner === 'AI_Pitch') o.material = aiMat;
      else if (owner === 'Face_COMPASS') o.material = compassMat;
      else if (mat.name === 'GaugeFace' && owner.startsWith('Face_')) {
        const id = owner.slice(5) as FaceId;
        if (faceTiles.has(id)) this.remapToTile(o, id);
        o.material = faceMat;
      } else if (mat.name === 'Glass') o.material = glassMat;
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
    if (quality === 'low') this.shrinkTextures(1024);
  }

  /** The named node a mesh belongs to (the optimiser moves meshes into `<name>_geo` children). */
  private partName(o: Object3D): string {
    if (o.name.endsWith('_geo') && o.parent) return o.parent.name;
    return o.name;
  }

  private remapToTile(mesh: Mesh, id: FaceId) {
    const { col, row } = tileOf(id);
    const uvAttr = mesh.geometry.getAttribute('uv');
    if (!uvAttr) return;
    const s = 1 - 2 * TILE_PAD;
    for (let i = 0; i < uvAttr.count; i++) {
      const u = uvAttr.getX(i);
      const v = uvAttr.getY(i);
      uvAttr.setXY(i, (col + TILE_PAD + u * s) / ATLAS_COLS, (row + TILE_PAD + v * s) / ATLAS_ROWS);
    }
    uvAttr.needsUpdate = true;
  }

  /** Mobile: halve the skin textures in place (less memory and upload, same model). */
  private shrinkTextures(max: number) {
    for (const t of this.textures) {
      const img = t.image as { width?: number; height?: number } | undefined;
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

  private setupGlows(lod0: Object3D) {
    const tex = this.canvasTexture(drawGlow(64), 1);
    tex.flipY = true;
    const defs: Record<
      string,
      { color: number; dir?: [number, number, number]; cone?: [number, number] }
    > = {
      Nav_L: {
        color: 0xff2010,
        dir: [Math.sin(55 * DEG), 0, Math.cos(55 * DEG)],
        cone: [Math.cos(70 * DEG), Math.cos(52 * DEG)],
      },
      Nav_R: {
        color: 0x20ff70,
        dir: [-Math.sin(55 * DEG), 0, Math.cos(55 * DEG)],
        cone: [Math.cos(70 * DEG), Math.cos(52 * DEG)],
      },
      Tail: { color: 0xffffff, dir: [0, 0, -1], cone: [Math.cos(80 * DEG), Math.cos(66 * DEG)] },
      Beacon: { color: 0xff2a10 },
      Strobe_L: { color: 0xe8f0ff },
      Strobe_R: { color: 0xe8f0ff },
      Landing: {
        color: 0xfff1d8,
        dir: [0, -0.05, 1],
        cone: [Math.cos(35 * DEG), Math.cos(12 * DEG)],
      },
      Taxi: { color: 0xfff1d8, dir: [0, -0.1, 1], cone: [Math.cos(45 * DEG), Math.cos(20 * DEG)] },
    };
    for (const [kind, d] of Object.entries(defs)) {
      const anchor = lod0.getObjectByName(`Glow_${kind}`);
      if (!anchor) continue;
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
      const fraction = GLOW_SCREEN[kind] ?? 0.05;
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
      this.glows.push({ sprite, kind, intensity, pos, dir, localDir: dirLocal, local });
    }
  }

  // ---------------------------------------------------------------------------------------

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
  get hitBoxes() {
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

  setExposure(exposure: number): void {
    this.glowVisibility = glowVisibility(exposure);
    this.cockpit.setExposure(exposure);
  }

  setCockpitView(inside: boolean): void {
    this.inside = inside;
    this.cockpit.setInside(inside);
    // From the seat the windshield must not veil the view; keep a hint of reflection.
    this.glassOpacity.value = inside ? 0.3 : 1;
  }

  update(dt: number, t: Telemetry, c: ControlInput, cockpit?: Cockpit): void {
    const s = this.s;
    const first = this.first;
    this.first = false;
    const k = (tau: number) => (first ? 0 : tau);
    // --- flight controls ---------------------------------------------------------------
    const a = t.aileron;
    const ail = this.pivots.get('Aileron_L')?.props ?? {};
    const up = Number(ail.upDeg ?? 20) * DEG;
    const down = Number(ail.downDeg ?? 15) * DEG;
    this.rotate('Aileron_L', a > 0 ? a * down : a * up);
    this.rotate('Aileron_R', a > 0 ? -a * up : -a * down);
    const e = t.elevator;
    this.rotate('Elevator', e > 0 ? e * 28 * DEG : e * 23 * DEG);
    const trim = c.pitchTrim;
    this.rotate('TrimTab', trim > 0 ? -trim * 19 * DEG : -trim * 22 * DEG);
    const r = t.rudder;
    this.rotate('Rudder', r > 0 ? r * 16.2 * DEG : r * 17.7 * DEG);
    // Flaps run out on tracks: mostly aft first, then they turn down (Fowler-like).
    const f = Math.min(Math.max(t.flaps, 0), 1);
    for (const n of ['Flap_L', 'Flap_R', 'Flap_L_lod1', 'Flap_R_lod1']) {
      const p = this.pivots.get(n);
      if (!p) continue;
      p.node.quaternion.setFromAxisAngle(p.axis, f * 30 * DEG);
      if (p.slide) p.node.position.copy(p.rest).addScaledVector(p.slide, Math.min(1, f * 1.6));
    }
    // --- gear ----------------------------------------------------------------------------
    const steerTarget = t.onGround ? Math.max(-1, Math.min(1, c.yaw)) * 10 * DEG : 0;
    s.steer = lag(s.steer, steerTarget, dt, k(0.15));
    this.rotate('NoseSteer', s.steer);
    if (t.onGround) s.wheelSpin = t.groundSpeed;
    else s.wheelSpin = lag(s.wheelSpin, 0, dt, 4);
    s.wheel += (s.wheelSpin * dt) / 0.2;
    s.wheel %= Math.PI * 2;
    this.rotate('Wheel_L', s.wheel * (0.2 / 0.215));
    this.rotate('Wheel_R', s.wheel * (0.2 / 0.215));
    this.rotate('Wheel_N', s.wheel * (0.2 / 0.18));
    // --- propeller -------------------------------------------------------------------------
    const rpm = t.engines[0]?.rpm ?? 0;
    s.prop = (s.prop + (rpm / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
    this.rotate('Prop', s.prop);
    const pl2 = this.pivots.get('Prop_lod2');
    if (pl2) pl2.node.quaternion.setFromAxisAngle(pl2.axis, s.prop);
    const disc = Math.min(1, Math.max(0, (rpm - 250) / 650));
    this.discOpacity.value = disc * (this.inside ? 0.55 : 1);
    for (const b of this.blades) b.visible = rpm < 500;
    // --- cockpit controls -----------------------------------------------------------------
    for (const side of ['L', 'R']) {
      this.slideBy(`Yoke_${side}`, c.pitch);
      const p = this.pivots.get(`YokeRoll_${side}`);
      if (p) p.node.quaternion.setFromAxisAngle(p.axis, c.roll * 40 * DEG);
    }
    this.slideBy('Pedals_R', c.yaw);
    this.slideBy('Pedals_L', -c.yaw);
    // --- lights -----------------------------------------------------------------------------
    // The systems know which lights are switched on and powered; without them a pilot's habits.
    const L = { ...(t.systems?.lights ?? autoLights(t)), ...this.lightsOverride };
    const beacon = L.beacon ? beaconIntensity(t.time) : 0;
    const strobe = L.strobe ? strobeIntensity(t.time) : 0;
    const nav = L.nav ? 1 : 0;
    this.lamps.get('Lamp_NavRed')!.value = 6 * nav;
    this.lamps.get('Lamp_NavGreen')!.value = 6 * nav;
    this.lamps.get('Lamp_NavWhite')!.value = 6 * nav;
    this.lamps.get('Lamp_Beacon')!.value = 12 * beacon;
    this.lamps.get('Lamp_Strobe')!.value = 40 * strobe;
    this.lamps.get('Lamp_Landing')!.value = L.landing || L.taxi ? 25 : 0;
    this.cockpit.update(
      dt,
      t,
      c,
      cockpit,
      this.altOffset,
      t.systems?.panelLight ?? (L.nav ? 1 : 0),
    );
    const level: Record<string, number> = {
      Nav_L: 1.6 * nav,
      Nav_R: 1.6 * nav,
      Tail: 1.2 * nav,
      Beacon: 3 * beacon,
      Strobe_L: 8 * strobe,
      Strobe_R: 8 * strobe,
      Landing: L.landing ? 4 : 0,
      Taxi: L.taxi ? 3 : 0,
    };
    this.object.updateWorldMatrix(true, false);
    const q = this.object.getWorldQuaternion(tmpQ);
    for (const g of this.glows) {
      const lv = (level[g.kind] ?? 0) * this.glowScale * this.glowVisibility;
      g.intensity.value = lv;
      g.sprite.visible = lv > 0;
      g.pos.value.copy(g.local).applyMatrix4(this.object.matrixWorld);
      g.dir.value.copy(g.localDir).applyQuaternion(q);
    }
    if (this.spot) this.spot.intensity = L.landing ? 60000 : L.taxi ? 25000 : 0;
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
/** Glow size as a share of the screen height. */
const GLOW_SCREEN: Record<string, number> = {
  Nav_L: 0.045,
  Nav_R: 0.045,
  Tail: 0.04,
  Beacon: 0.07,
  Strobe_L: 0.12,
  Strobe_R: 0.12,
  Landing: 0.12,
  Taxi: 0.1,
};
