/**
 * Rain and snow: a cheap particle layer around the camera. The drops live in a box that
 * wraps around the camera (so there are always drops near it, whatever its speed) and are
 * drawn as streaks along their motion relative to the camera during a short exposure: at
 * flying speed rain comes at the windscreen as long lines, standing it falls as short ones.
 *
 * Drawn into its own target after the scene pass, each streak tested against the scene's
 * depth, and laid over the finished picture in the post pass, so drops in front of a fogged
 * hillside stay visible (the hillside's fog must not swallow the drop in front of it) and
 * nothing behind the cockpit's walls shows.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  HalfFloatType,
  Mesh,
  MeshBasicNodeMaterial,
  NodeUpdateType,
  RenderTarget,
  RendererUtils,
  Scene,
  TempNode,
  Vector2,
  Vector3,
  type Camera,
  type NodeBuilder,
  type NodeFrame,
  type TextureNode,
} from 'three/webgpu';
import {
  Discard,
  Fn,
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  context,
  cross,
  exp,
  float,
  floor,
  length,
  max,
  mix,
  normalize,
  passTexture,
  screenSize,
  screenUV,
  select,
  sin,
  smoothstep,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { depthToViewZ } from './aerial';
import type { F, V3, V4 } from './nodes';
import type { SkyUniforms } from './uniforms';

/** Share of the precipitation that falls as snow at an air temperature (°C): half at 1 °C. */
export function snowShare(temperatureC: number): number {
  const t = Math.min(Math.max((2 - temperatureC) / 2, 0), 1);
  return t * t * (3 - 2 * t);
}

/** Terminal fall speed, m/s: drizzle to moderate rain about 7, snowflakes about 1.2. */
export function fallSpeed(snow: number): number {
  return 7 + (1.2 - 7) * snow;
}

/** Air temperature (°C) at a height from the sea-level temperature (standard lapse rate). */
export function temperatureAt(seaLevelC: number, altitude: number): number {
  return seaLevelC - 0.0065 * altitude;
}

export interface PrecipitationQuality {
  /** Most drops drawn at once (heavy precipitation); 0 = none. */
  drops: number;
  /** Resolution of the layer relative to the screen. */
  scale: number;
}

/** Edge of the box of drops around the camera, metres. */
const BOX = 36;
/** No drops this close to the eye: they would show inside the cockpit. */
const NEAR = 2.6;
/** Exposure of a streak, seconds: what the eye smears a falling drop to. */
const SHUTTER = 1 / 45;

export class PrecipitationNode extends TempNode {
  static get type() {
    return 'SkyPrecipitationNode';
  }

  /** 0..1: how much falls (drop count) and how much of it is snow. */
  readonly intensity = uniform(0);
  readonly snow = uniform(0);
  /** Camera position in the drops' frame, wrapped to the box (the drops fall through it). */
  readonly phase = uniform(new Vector3());
  /** Velocity of the drops relative to the camera, m/s, render space. */
  readonly relative = uniform(new Vector3());
  /** Pre-exposed radiance a drop shows (the light around it). */
  readonly light = uniform(new Vector3());
  /** Extinction of the air at the camera, 1/m (drops fade in fog like everything else). */
  readonly extinction = uniform(0);
  readonly time = uniform(0);

  private readonly target = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  private readonly output: TextureNode;
  private readonly scene = new Scene();
  private readonly mesh: Mesh;
  private readonly material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  private readonly size = new Vector2();
  private state?: RendererUtils.RendererState;
  private sharedContext: unknown = null;
  private built = false;
  private probed = false;
  /** The target holds drops that need clearing. */
  private dirty = true;
  /** Drops to draw this frame (set by the sky from the weather). */
  count = 0;

  constructor(
    private readonly u: SkyUniforms,
    private readonly depthNode: TextureNode,
    private readonly camera: Camera,
    readonly quality: PrecipitationQuality,
  ) {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.output = passTexture(this as never, this.target.texture);
    this.target.texture.name = 'sky.precipitation';
    const n = Math.max(quality.drops, 1);
    // Six corners per drop, all with the drop's seed: a quad along its streak.
    const seed = new Float32Array(n * 6 * 4);
    const corner = new Float32Array(n * 6 * 2);
    let s = 12345;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const corners = [
      [0, -1],
      [1, -1],
      [1, 1],
      [0, -1],
      [1, 1],
      [0, 1],
    ];
    for (let i = 0; i < n; i++) {
      const d = [rnd(), rnd(), rnd(), rnd()];
      for (let k = 0; k < 6; k++) {
        seed.set(d, (i * 6 + k) * 4);
        corner.set(corners[k]!, (i * 6 + k) * 2);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(n * 6 * 3), 3));
    geometry.setAttribute('seed', new BufferAttribute(seed, 4));
    geometry.setAttribute('corner', new BufferAttribute(corner, 2));
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  getTextureNode(): TextureNode {
    return this.output;
  }

  setup(builder: NodeBuilder) {
    this.sharedContext = (builder as unknown as { getSharedContext(): unknown }).getSharedContext();
    return this.output;
  }

  updateBefore(frame: NodeFrame): boolean | undefined {
    const renderer = frame.renderer!;
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.round(this.size.x * this.quality.scale));
    const h = Math.max(1, Math.round(this.size.y * this.quality.scale));
    if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
      this.dirty = true;
    }
    if (!this.built) {
      this.material.contextNode = context(this.sharedContext as never);
      this.buildMaterial();
      this.built = true;
    }
    // The first frame draws one (invisible) drop, so the shader exists before any rain: it
    // is built behind the loading screen with the rest of the post chain.
    const drops = this.probed ? Math.min(this.count, this.quality.drops) : 1;
    if (drops === 0 && !this.dirty) return undefined;
    this.state = RendererUtils.resetRendererState(renderer, this.state!);
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    this.mesh.geometry.setDrawRange(0, drops * 6);
    if (drops > 0) renderer.render(this.scene, this.camera);
    this.dirty = drops > 0;
    this.probed = true;
    RendererUtils.restoreRendererState(renderer, this.state);
    return undefined;
  }

  dispose() {
    super.dispose();
    this.target.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  private buildMaterial() {
    const u = this.u;
    const seed = attribute('seed', 'vec4') as unknown as V4;
    const corner = attribute('corner', 'vec2') as unknown as import('three/webgpu').Node<'vec2'>;
    // Where this drop is relative to the camera: its place in the box, moved by the drops'
    // fall and the camera's flight, wrapped so the box always surrounds the camera.
    const wrap = (v: V3) => v.sub(floor(v.div(BOX)).mul(BOX));
    const flutter = vec3(
      sin(this.time.mul(1.7).add(seed.w.mul(40))),
      0,
      sin(this.time.mul(1.3).add(seed.w.mul(23))),
    ).mul(this.snow.mul(0.35));
    const rel = wrap(seed.xyz.mul(BOX).sub(this.phase))
      .sub(BOX / 2)
      .add(flutter);
    const dist = length(rel);
    const fade = smoothstep(BOX / 2, BOX * 0.36, dist).mul(smoothstep(NEAR, NEAR + 1.5, dist));
    // Head and tail of the streak in view space.
    const toView = (p: V3) =>
      (cameraViewMatrix.mul(vec4(u.cameraPosition.add(p), 1)) as unknown as V4).xyz;
    const head = toView(rel);
    const tailRel = rel.sub(this.relative.mul(SHUTTER));
    const tail = toView(tailRel);
    const along = select(corner.x.greaterThan(0.5), tail, head);
    const axis = tail.sub(head);
    // Across the streak and the line of sight; any direction when it points at the eye.
    const across = cross(axis, along);
    const side = select(length(across).greaterThan(1e-6), normalize(across), vec3(1, 0, 0));
    // A drop is a millimetre or two (a flake a centimetre); never thinner than a pixel, with
    // its light spread over the wider streak.
    const radius = mix(float(0.0015), float(0.006), this.snow);
    const pixel = float(2).div(u.projection.y.mul(screenSize.y));
    const width = max(radius, along.z.negate().mul(pixel).mul(0.8));
    const pos = along.add(side.mul(corner.y).mul(width));
    this.material.vertexNode = cameraProjectionMatrix.mul(vec4(pos, 1));
    const viewZ = varying(along.z) as unknown as F;
    const across01 = varying(corner.y) as unknown as F;
    const weight = varying(
      fade
        .mul(radius.div(width))
        .mul(exp(dist.mul(this.extinction).negate()))
        .mul(select(this.intensity.greaterThan(0), float(1), float(0))),
    ) as unknown as F;
    this.material.fragmentNode = Fn(() => {
      const sceneZ = depthToViewZ(
        (this.depthNode.sample(screenUV) as unknown as V4).x,
        u.near,
        u.far,
      ) as unknown as F;
      // Behind whatever the scene drew there (the panel, a wall, the ground): not seen.
      Discard(viewZ.lessThan(sceneZ));
      const soft = float(1).sub(across01.mul(across01));
      // Raindrops show the light around them faintly (they are clear); flakes are white.
      const a = clamp(weight.mul(soft).mul(mix(float(1.2), float(0.9), this.snow)), 0, 1);
      return vec4(this.light.mul(a), a);
    })();
    this.material.needsUpdate = true;
  }
}
