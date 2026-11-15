/**
 * Camera-facing particles (fire, sparks, smoke, dust) as one instanced quad mesh per kind. The
 * motion runs on the CPU (a few hundred particles: cheaper than a compute pass, and the same
 * on WebGPU and WebGL 2); the GPU only places and shades the quads, with node materials.
 *
 * Fire is emissive and additive. Smoke is alpha blended and lit like any surface (sun, sky
 * environment, the wreck's own fire light), with a sphere's normal across each quad so a puff
 * looks round and is darker on the side away from the light.
 */
import {
  AdditiveBlending,
  DataTexture,
  DepthTexture,
  FloatType,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  type Node,
  type NodeBuilder,
  ViewportDepthTextureNode,
  PlaneGeometry,
  RGBAFormat,
  UnsignedByteType,
  UnsignedIntType,
} from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraFar,
  cameraNear,
  cameraWorldMatrix,
  clamp,
  cos,
  dot,
  float,
  floor,
  max,
  mod,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  screenUV,
  pow,
  sin,
  sqrt,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Vec3Like } from './breakup';

export interface ParticleSpec {
  pos: Vec3Like;
  vel: Vec3Like;
  life: number;
  size0: number;
  size1: number;
  /**
   * Colour and opacity at birth and death. Fire: linear emission (may exceed 1), times the
   * fire gain; smoke: albedo.
   */
  color0: readonly [number, number, number, number];
  color1: readonly [number, number, number, number];
  /** Air drag (1/s): how fast the particle takes the wind's speed. */
  drag?: number;
  /** Upward acceleration (m/s²): hot gas rises; -9.81 falls like a spark. */
  lift?: number;
  /** Height over width of the quad (a flame licks upwards); upright, it does not spin. */
  stretch?: number;
}

const STRIDE = 24;
const TILE = 64;

/** Seeded generator (Park-Miller): the puffs look the same every run. */
export function seeded(seed: number): () => number {
  let s = Math.max(1, Math.floor(seed) % 2147483647);
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/**
 * Four soft puffs in a 2x2 atlas, as plain bytes (no canvas: builds in Node too). Each is a
 * cluster of blurred blobs under a round falloff, so flames and smoke look billowy instead of
 * round, and no edge of the quad ever shows.
 */
export function puffAtlas(): DataTexture {
  const size = TILE * 2;
  const data = new Uint8Array(size * size * 4);
  const rnd = seeded(7);
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * TILE;
    const oy = Math.floor(v / 2) * TILE;
    const blobs = Array.from({ length: 18 }, () => {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * 0.42;
      return {
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        s: 0.16 + rnd() * 0.2,
        w: 0.5 + rnd() * 0.5,
      };
    });
    const field = new Float32Array(TILE * TILE);
    let peak = 0;
    for (let j = 0; j < TILE; j++)
      for (let i = 0; i < TILE; i++) {
        const x = ((i + 0.5) / TILE) * 2 - 1;
        const y = ((j + 0.5) / TILE) * 2 - 1;
        let f = 0;
        for (const b of blobs) {
          const d2 = ((x - b.x) ** 2 + (y - b.y) ** 2) / (b.s * b.s);
          f += b.w * Math.exp(-d2);
        }
        // Zero well inside the tile's edge: neither the quad's border nor a neighbour's
        // texels (mipmaps) can show.
        const r = Math.hypot(x, y);
        const edge = Math.min(1, Math.max(0, (0.98 - r) / 0.6));
        f *= edge * edge * (3 - 2 * edge);
        field[j * TILE + i] = f;
        peak = Math.max(peak, f);
      }
    for (let j = 0; j < TILE; j++)
      for (let i = 0; i < TILE; i++) {
        const o = ((oy + j) * size + ox + i) * 4;
        data[o] = data[o + 1] = data[o + 2] = 255;
        data[o + 3] = Math.round((255 * Math.min(1, field[j * TILE + i]! / peak) ** 1.1) | 0);
      }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

export class ParticleSystem {
  readonly mesh: Mesh;
  private readonly data: Float32Array;
  private readonly a: InstancedBufferAttribute;
  private readonly b: InstancedBufferAttribute;
  private readonly c: InstancedBufferAttribute;
  private readonly geo: InstancedBufferGeometry;
  private readonly material: Material;
  private count = 0;
  private readonly order: number[] = [];
  private readonly dist: Float32Array;
  private readonly rnd = seeded(12345);

  /**
   * `gain`: a uniform node the fire's emission is multiplied by (exposure, see fireGain);
   * smoke ignores it.
   */
  constructor(
    readonly max: number,
    readonly kind: 'fire' | 'smoke',
    atlas: DataTexture,
    gain: Node<'float'>,
  ) {
    const quad = new PlaneGeometry(1, 1);
    this.geo = new InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('uv', quad.getAttribute('uv'));
    this.a = new InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.b = new InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.c = new InstancedBufferAttribute(new Float32Array(max * 3), 3);
    for (const x of [this.a, this.b, this.c]) x.setUsage(DynamicDrawUsage);
    this.geo.setAttribute('iA', this.a);
    this.geo.setAttribute('iB', this.b);
    this.geo.setAttribute('iC', this.c);
    this.geo.instanceCount = 0;
    this.data = new Float32Array(max * STRIDE);
    this.dist = new Float32Array(max);
    this.material = kind === 'fire' ? fireMaterial(atlas, gain) : smokeMaterial(atlas);
    this.mesh = new Mesh(this.geo, this.material);
    this.mesh.name = kind === 'fire' ? 'WreckFire' : 'WreckSmoke';
    // The quads are placed in the shader around positions the CPU keeps in render space.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Smoke first, then the glow over it.
    this.mesh.renderOrder = kind === 'fire' ? 12 : 11;
  }

  get alive() {
    return this.count;
  }

  /** Adds a particle; false when the system is full (the budget of the device). */
  emit(s: ParticleSpec): boolean {
    if (this.count >= this.max) return false;
    const d = this.data;
    const o = this.count++ * STRIDE;
    d[o] = s.pos.x;
    d[o + 1] = s.pos.y;
    d[o + 2] = s.pos.z;
    d[o + 3] = s.vel.x;
    d[o + 4] = s.vel.y;
    d[o + 5] = s.vel.z;
    d[o + 6] = 0;
    d[o + 7] = Math.max(1e-3, s.life);
    d[o + 8] = s.size0;
    d[o + 9] = s.size1;
    const upright = (s.stretch ?? 1) !== 1;
    d[o + 10] = upright ? (this.rnd() - 0.5) * 0.4 : this.rnd() * Math.PI * 2;
    d[o + 11] = upright ? 0 : (this.rnd() - 0.5) * 1.2;
    d.set(s.color0, o + 12);
    d.set(s.color1, o + 16);
    d[o + 20] = s.drag ?? 0.5;
    d[o + 21] = s.lift ?? 0;
    d[o + 22] = Math.floor(this.rnd() * 4);
    d[o + 23] = s.stretch ?? 1;
    return true;
  }

  /**
   * Moves the particles: drag pulls each towards the wind (render space, m/s), lift along +y.
   * With the camera position given, smoke is drawn back to front.
   */
  update(dt: number, wind?: Vec3Like, camera?: Vec3Like) {
    const d = this.data;
    const wx = wind?.x ?? 0;
    const wy = wind?.y ?? 0;
    const wz = wind?.z ?? 0;
    let i = 0;
    while (i < this.count) {
      const o = i * STRIDE;
      d[o + 6]! += dt;
      if (d[o + 6]! >= d[o + 7]!) {
        // Dead: the last particle takes its slot.
        const last = --this.count;
        if (last !== i) d.copyWithin(o, last * STRIDE, last * STRIDE + STRIDE);
        continue;
      }
      const k = Math.exp(-d[o + 20]! * dt);
      d[o + 3] = wx + (d[o + 3]! - wx) * k;
      d[o + 4] = wy + (d[o + 4]! - wy) * k + d[o + 21]! * dt;
      d[o + 5] = wz + (d[o + 5]! - wz) * k;
      d[o] = d[o]! + d[o + 3]! * dt;
      d[o + 1] = d[o + 1]! + d[o + 4]! * dt;
      d[o + 2] = d[o + 2]! + d[o + 5]! * dt;
      d[o + 10] = d[o + 10]! + d[o + 11]! * dt;
      i++;
    }
    const order = this.order;
    order.length = this.count;
    for (let j = 0; j < this.count; j++) order[j] = j;
    if (camera && this.kind === 'smoke' && this.count > 1) {
      for (let j = 0; j < this.count; j++) {
        const o = j * STRIDE;
        this.dist[j] =
          (d[o]! - camera.x) ** 2 + (d[o + 1]! - camera.y) ** 2 + (d[o + 2]! - camera.z) ** 2;
      }
      order.sort((p, q) => this.dist[q]! - this.dist[p]!);
    }
    const A = this.a.array as Float32Array;
    const B = this.b.array as Float32Array;
    const C = this.c.array as Float32Array;
    for (let j = 0; j < this.count; j++) {
      const o = order[j]! * STRIDE;
      const t = d[o + 6]! / d[o + 7]!;
      A[j * 4] = d[o]!;
      A[j * 4 + 1] = d[o + 1]!;
      A[j * 4 + 2] = d[o + 2]!;
      // Grows fast first, then slowly (a billowing puff).
      A[j * 4 + 3] = d[o + 8]! + (d[o + 9]! - d[o + 8]!) * Math.sqrt(t);
      for (let n = 0; n < 4; n++)
        B[j * 4 + n] = d[o + 12 + n]! + (d[o + 16 + n]! - d[o + 12 + n]!) * t;
      // Fades in over the first 8 % so puffs do not pop up.
      B[j * 4 + 3]! *= Math.min(1, t / 0.08);
      C[j * 3] = d[o + 10]!;
      C[j * 3 + 1] = d[o + 22]!;
      C[j * 3 + 2] = d[o + 23]!;
    }
    this.geo.instanceCount = this.count;
    // Only the live part goes to the graphics card.
    for (const [x, n] of [
      [this.a, 4],
      [this.b, 4],
      [this.c, 3],
    ] as const) {
      x.clearUpdateRanges();
      if (this.count > 0) {
        x.addUpdateRange(0, this.count * n);
        x.needsUpdate = true;
      }
    }
  }

  /** The render origin moved to (dx, dy, dz) of the old render space. */
  rebase(dx: number, dy: number, dz: number) {
    for (let j = 0; j < this.count; j++) {
      const o = j * STRIDE;
      this.data[o]! -= dx;
      this.data[o + 1]! -= dy;
      this.data[o + 2]! -= dz;
    }
  }

  clear() {
    this.count = 0;
    this.geo.instanceCount = 0;
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
  }
}

/** The quad's corner turned by the particle's spin, in units of its size (-0.5 .. 0.5). */
function corner(): Node<'vec2'> {
  const iC = attribute('iC', 'vec3');
  const spin = iC.x;
  const p = vec2(positionGeometry.x, positionGeometry.y.mul(iC.z));
  const cs = cos(spin);
  const sn = sin(spin);
  return vec2(p.x.mul(cs).sub(p.y.mul(sn)), p.x.mul(sn).add(p.y.mul(cs)));
}

/** World position of the quad's corner: around the particle's centre, facing the camera. */
function billboard(rc: Node<'vec2'>): Node<'vec3'> {
  const iA = attribute('iA', 'vec4');
  const right = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
  const up = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  return iA.xyz.add(right.mul(rc.x.mul(iA.w)).add(up.mul(rc.y.mul(iA.w))));
}

/** The puff's density: one of the four atlas tiles. */
function puff(atlas: DataTexture): Node<'float'> {
  const v = attribute('iC', 'vec3').y;
  const tile = vec2(mod(v, 2), floor(v.mul(0.5)));
  return texture(atlas, uv().add(tile).mul(0.5)).a;
}

/**
 * Soft particles: a quad fades out where it nears the surface behind it (the ground, a house)
 * instead of cutting through it along a hard line, and where it comes close to the camera
 * (inside the smoke the view darkens, it is not hidden by one big puff). Reads the depth of
 * what is drawn so far (a copy made once per frame, WebGPU and WebGL 2 alike).
 */
const sceneDepth = new DepthTexture(1, 1);
const softness = Fn((_: [], builder: NodeBuilder) => {
  // The copy must have the format of the depth buffer: float with a reversed one.
  sceneDepth.type = builder.renderer.reversedDepthBuffer ? FloatType : UnsignedIntType;
  const size = attribute('iA', 'vec4').w;
  const depth = new ViewportDepthTextureNode(screenUV, null, sceneDepth).x;
  const behind = perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
  const gap = positionView.z.sub(behind);
  const ground = clamp(gap.div(size.mul(0.35)), 0, 1);
  const eye = clamp(positionView.z.negate().sub(cameraNear).div(size.mul(0.6)), 0, 1);
  return ground.mul(eye);
});

function fireMaterial(atlas: DataTexture, gain: Node<'float'>): Material {
  const m = new MeshBasicNodeMaterial();
  m.transparent = true;
  m.depthWrite = false;
  m.blending = AdditiveBlending;
  m.fog = false;
  m.positionNode = billboard(corner());
  const col = attribute('iB', 'vec4');
  // A hotter core: the density curve steepened.
  const shape = pow(puff(atlas), 1.4);
  m.colorNode = vec4(col.rgb.mul(gain), col.a.mul(shape).mul(softness()));
  return m;
}

function smokeMaterial(atlas: DataTexture): Material {
  // Diffuse only: a specular rim would glow around every puff against a low sun.
  const m = new MeshPhysicalNodeMaterial({ roughness: 1, metalness: 0, specularIntensity: 0 });
  m.transparent = true;
  m.depthWrite = false;
  m.fog = false;
  const rc = corner();
  m.positionNode = billboard(rc);
  const col = attribute('iB', 'vec4');
  m.colorNode = col.rgb;
  m.opacityNode = col.a.mul(puff(atlas)).mul(softness());
  // A sphere's normal over the quad (view space: the quad faces the camera along +z).
  const q = rc.mul(1.7);
  const nz = sqrt(max(float(0.08), float(1).sub(dot(q, q))));
  m.normalNode = normalize(vec3(q.x, q.y, nz));
  return m;
}
