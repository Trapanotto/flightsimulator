import {
  AdditiveBlending,
  CanvasTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  Vector3,
} from 'three';

/**
 * Camera-facing particles (fire, smoke, sparks) as one instanced mesh per blend mode. All the
 * motion runs on the CPU (a few hundred particles); the GPU only draws soft round sprites.
 */

/** Soft puff: radial falloff broken up by a few blobs (smoke and flames look less round). */
function puffTexture(): Texture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2;
    const r = rnd() * size * 0.22;
    const x = size / 2 + Math.cos(a) * r;
    const y = size / 2 + Math.sin(a) * r;
    const rad = size * (0.12 + rnd() * 0.16);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(255,255,255,0.32)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  // Fade out at the edge of the sprite.
  const img = g.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
      const k = Math.max(0, 1 - d) ** 0.8;
      const o = (y * size + x) * 4 + 3;
      img.data[o] = Math.min(255, img.data[o]! * 1.6 * k);
    }
  g.putImageData(img, 0, 0);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

let sharedTexture: Texture | undefined;

const VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute float iSize;
  attribute float iRot;
  attribute vec4 iColor;
  varying vec2 vUv;
  varying vec4 vColor;
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vUv = position.xy + 0.5;
    vColor = iColor;
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    float c = cos(iRot);
    float s = sin(iRot);
    mv.xy += mat2(c, s, -s, c) * position.xy * iSize;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec4 vColor;
  #include <common>
  #include <logdepthbuf_pars_fragment>
  void main() {
    #include <logdepthbuf_fragment>
    vec4 t = texture2D(map, vUv);
    gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  }
`;

export interface ParticleSpec {
  pos: Vector3;
  vel: Vector3;
  life: number;
  size0: number;
  size1: number;
  /** Colour (linear, may exceed 1 for glowing fire) and opacity at birth and death. */
  color0: [number, number, number, number];
  color1: [number, number, number, number];
  /** Air drag (1/s) and upward acceleration (m/s², hot gas rises; negative = falls). */
  drag?: number;
  lift?: number;
}

const STRIDE = 20;

export class ParticleSystem {
  readonly mesh: Mesh;
  private readonly data: Float32Array;
  private readonly pos: InstancedBufferAttribute;
  private readonly size: InstancedBufferAttribute;
  private readonly rot: InstancedBufferAttribute;
  private readonly color: InstancedBufferAttribute;
  private readonly geo: InstancedBufferGeometry;
  private count = 0;

  constructor(
    private readonly max: number,
    additive: boolean,
  ) {
    sharedTexture ??= puffTexture();
    const quad = new PlaneGeometry(1, 1);
    this.geo = new InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.pos = new InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.size = new InstancedBufferAttribute(new Float32Array(max), 1);
    this.rot = new InstancedBufferAttribute(new Float32Array(max), 1);
    this.color = new InstancedBufferAttribute(new Float32Array(max * 4), 4);
    for (const a of [this.pos, this.size, this.rot, this.color]) a.setUsage(DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.pos);
    this.geo.setAttribute('iSize', this.size);
    this.geo.setAttribute('iRot', this.rot);
    this.geo.setAttribute('iColor', this.color);
    this.geo.instanceCount = 0;
    this.data = new Float32Array(max * STRIDE);
    const mat = new ShaderMaterial({
      uniforms: { map: { value: sharedTexture } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
    });
    this.mesh = new Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 4 : 3;
  }

  get alive() {
    return this.count;
  }

  emit(s: ParticleSpec) {
    if (this.count >= this.max) return;
    const d = this.data;
    const o = this.count++ * STRIDE;
    d[o] = s.pos.x;
    d[o + 1] = s.pos.y;
    d[o + 2] = s.pos.z;
    d[o + 3] = s.vel.x;
    d[o + 4] = s.vel.y;
    d[o + 5] = s.vel.z;
    d[o + 6] = 0; // age
    d[o + 7] = s.life;
    d[o + 8] = s.size0;
    d[o + 9] = s.size1;
    d[o + 10] = Math.random() * Math.PI * 2;
    d[o + 11] = (Math.random() - 0.5) * 1.2; // spin
    d.set(s.color0, o + 12);
    d.set(s.color1, o + 16);
    this.extra[this.count - 1] = [s.drag ?? 0.5, s.lift ?? 0];
  }

  private readonly extra: Array<[number, number]> = [];

  /** Moves the particles; `up` is the local vertical (gravity for falling sparks). */
  update(dt: number, up: Vector3) {
    const d = this.data;
    let i = 0;
    while (i < this.count) {
      const o = i * STRIDE;
      d[o + 6]! += dt;
      if (d[o + 6]! >= d[o + 7]!) {
        // Dead: move the last particle into this slot.
        const last = --this.count;
        if (last !== i) {
          d.copyWithin(o, last * STRIDE, last * STRIDE + STRIDE);
          this.extra[i] = this.extra[last]!;
        }
        continue;
      }
      const [drag, lift] = this.extra[i]!;
      const k = Math.exp(-drag * dt);
      d[o + 3] = d[o + 3]! * k + up.x * lift * dt;
      d[o + 4] = d[o + 4]! * k + up.y * lift * dt;
      d[o + 5] = d[o + 5]! * k + up.z * lift * dt;
      d[o] = d[o]! + d[o + 3]! * dt;
      d[o + 1] = d[o + 1]! + d[o + 4]! * dt;
      d[o + 2] = d[o + 2]! + d[o + 5]! * dt;
      d[o + 10] = d[o + 10]! + d[o + 11]! * dt;
      i++;
    }
    const p = this.pos.array as Float32Array;
    const sz = this.size.array as Float32Array;
    const rt = this.rot.array as Float32Array;
    const col = this.color.array as Float32Array;
    for (let j = 0; j < this.count; j++) {
      const o = j * STRIDE;
      const t = d[o + 6]! / d[o + 7]!;
      p[j * 3] = d[o]!;
      p[j * 3 + 1] = d[o + 1]!;
      p[j * 3 + 2] = d[o + 2]!;
      // Grow fast first, then slowly (like a billowing puff).
      sz[j] = d[o + 8]! + (d[o + 9]! - d[o + 8]!) * Math.sqrt(t);
      rt[j] = d[o + 10]!;
      for (let c = 0; c < 4; c++)
        col[j * 4 + c] = d[o + 12 + c]! + (d[o + 16 + c]! - d[o + 12 + c]!) * t;
      // Fade in over the first 8 % so puffs do not pop.
      col[j * 4 + 3]! *= Math.min(1, t / 0.08);
    }
    this.geo.instanceCount = this.count;
    for (const a of [this.pos, this.size, this.rot, this.color]) a.needsUpdate = true;
  }

  rebase(delta: Vector3) {
    for (let j = 0; j < this.count; j++) {
      const o = j * STRIDE;
      this.data[o]! -= delta.x;
      this.data[o + 1]! -= delta.y;
      this.data[o + 2]! -= delta.z;
    }
  }

  clear() {
    this.count = 0;
    this.geo.instanceCount = 0;
  }

  dispose() {
    this.geo.dispose();
    (this.mesh.material as ShaderMaterial).dispose();
  }
}
