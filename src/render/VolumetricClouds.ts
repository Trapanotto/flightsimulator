import { BlendFunction, Effect, Pass } from 'postprocessing';
import {
  Data3DTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  type PerspectiveCamera,
  RedFormat,
  RepeatWrapping,
  ShaderMaterial,
  type Texture,
  Uniform,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { AtmosphereUniforms } from './Atmosphere';
import { NOISE_DECLARATIONS } from './aerial';

/**
 * Volumetric cumulus: a ray march through the cloud layer for every pixel (at reduced
 * resolution), stopped by the scene depth, lit by the sun (Beer-Powder, forward-scattering
 * phase) and the sky. Coverage comes from the same 2D noise as the cloud shadows on the
 * terrain, the shapes from a tileable 3D noise. The result (in-scattered light + transmittance)
 * is blended over the image by CloudCompositeEffect.
 */

const N3 = 64;

/** IEEE half float -> number. */
function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** Tileable 3D noise: value-noise fbm, carved by inverted Worley cells (billowy). */
export function makeNoise3D(size = N3): Data3DTexture {
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const lattice = (n: number) => Float32Array.from({ length: n * n * n }, rnd);
  const octaves = [4, 8, 16, 32].map((n) => ({ n, g: lattice(n) }));
  const cells = 6;
  const points = Float32Array.from({ length: cells * cells * cells * 3 }, rnd);
  const data = new Uint8Array(size * size * size);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let v = 0;
        let amp = 0.5;
        let total = 0;
        for (const { n, g } of octaves) {
          const fx = (x / size) * n;
          const fy = (y / size) * n;
          const fz = (z / size) * n;
          const x0 = Math.floor(fx);
          const y0 = Math.floor(fy);
          const z0 = Math.floor(fz);
          const tx = smooth(fx - x0);
          const ty = smooth(fy - y0);
          const tz = smooth(fz - z0);
          const at = (i: number, j: number, k: number) =>
            g[(((k % n) + n) % n) * n * n + (((j % n) + n) % n) * n + (((i % n) + n) % n)]!;
          const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
          const c00 = lerp(at(x0, y0, z0), at(x0 + 1, y0, z0), tx);
          const c10 = lerp(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), tx);
          const c01 = lerp(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), tx);
          const c11 = lerp(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), tx);
          v += lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz) * amp;
          total += amp;
          amp *= 0.5;
        }
        v /= total;
        // Worley: distance to the nearest feature point in a tiling grid of cells.
        const px = (x / size) * cells;
        const py = (y / size) * cells;
        const pz = (z / size) * cells;
        let best = 9;
        const cx = Math.floor(px);
        const cy = Math.floor(py);
        const cz = Math.floor(pz);
        for (let k = -1; k <= 1; k++)
          for (let j = -1; j <= 1; j++)
            for (let i = -1; i <= 1; i++) {
              const ix = (((cx + i) % cells) + cells) % cells;
              const iy = (((cy + j) % cells) + cells) % cells;
              const iz = (((cz + k) % cells) + cells) % cells;
              const o = ((iz * cells + iy) * cells + ix) * 3;
              const dx = cx + i + points[o]! - px;
              const dy = cy + j + points[o + 1]! - py;
              const dz = cz + k + points[o + 2]! - pz;
              best = Math.min(best, dx * dx + dy * dy + dz * dz);
            }
        const worley = 1 - Math.min(1, Math.sqrt(best));
        const b = Math.min(1, Math.max(0, v * 0.55 + worley * 0.6 - 0.1));
        data[(z * size + y) * size + x] = Math.round(b * 255);
      }
  const tex = new Data3DTexture(data, size, size, size);
  tex.format = RedFormat;
  tex.type = UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const MARCH_FRAG = /* glsl */ `
  #include <common>
  #include <packing>
  precision highp sampler3D;
  uniform sampler2D depthBuffer;
  uniform sampler3D uNoise3D;
  uniform mat4 uProj;
  uniform mat4 uCamWorld;
  uniform vec3 uCamPos;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uHazeColor;
  uniform vec3 uHazeSunColor;
  uniform float uHazeDensity;
  uniform float uHazeHeight;
  uniform float uCameraElevation;
  uniform vec3 uUp;
  uniform float uTime;
  uniform float uCloudCoverage;
  uniform float uCloudBase;
  uniform float uCloudTop;
  uniform vec2 uResolution;
  uniform float uFrame;
  ${NOISE_DECLARATIONS}
  varying vec2 vUv;

  const float NOISE_PERIOD = 24000.0;
  const float SIGMA = 0.045;

  // Scene distance along the ray (metres), or a huge value for the sky.
  float sceneDistance(vec2 uv, vec3 dirView) {
    float depth = texture2D(depthBuffer, uv).r;
    float viewZ;
    #if defined(CLOUD_LOG_DEPTH)
      if (depth >= 0.999999) return 1e9;
      viewZ = -(pow(2.0, depth * log2(cameraFar + 1.0)) - 1.0);
    #elif defined(CLOUD_REVERSED_DEPTH)
      if (depth <= 0.000001) return 1e9;
      // three's helper already understands reversed depth when it knows about it.
      #ifdef USE_REVERSED_DEPTH_BUFFER
        viewZ = perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
      #else
        viewZ = perspectiveDepthToViewZ(1.0 - depth, cameraNear, cameraFar);
      #endif
    #else
      if (depth >= 0.999999) return 1e9;
      viewZ = perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
    #endif
    return viewZ / dirView.z;
  }

  float coverage(vec2 q) {
    vec2 wind = vec2(9.0, 3.5) * uTime;
    float n = texture2D(uNoise, (q + wind) / NOISE_PERIOD).r * 0.65
            + texture2D(uNoise, (q + wind * 1.6) / (NOISE_PERIOD * 0.31)).r * 0.35;
    float edge = 1.0 - uCloudCoverage;
    return smoothstep(edge - 0.08, edge + 0.22, n);
  }

  // Extinction (1/m) at a point: coverage x height profile, carved by 3D noise.
  float density(vec3 p, float h, bool cheap, float camDist) {
    float hn = (h - uCloudBase) / (uCloudTop - uCloudBase);
    if (hn < 0.0 || hn > 1.0) return 0.0;
    vec2 q = basePos(p);
    float cov = coverage(q);
    if (cov < 0.01) return 0.0;
    // Flat base, tops rounding off; denser cells grow taller.
    float profile = smoothstep(0.0, 0.08, hn) * (1.0 - smoothstep(0.25 + 0.7 * cov, 1.0, hn));
    float d = cov * profile;
    vec3 wind = vec3(9.0, 0.0, 3.5) * uTime;
    vec3 s = vec3(q.x, h * 1.6, q.y) + wind;
    float shape = texture(uNoise3D, s / 2600.0).r;
    d = clamp((d - (1.0 - shape) * 0.62) / 0.38, 0.0, 1.0);
    if (!cheap && d > 0.0) {
      float detail = texture(uNoise3D, s / 520.0).r;
      d = clamp(d - (1.0 - detail) * 0.22 * (1.0 - d), 0.0, 1.0);
      // Close up: crisp, cauliflower edges.
      float near = 1.0 - smoothstep(1500.0, 4500.0, camDist);
      if (near > 0.0 && d > 0.0) {
        float fine = texture(uNoise3D, s / 150.0 + 0.37).r;
        d = clamp(d - (1.0 - fine) * 0.3 * near * (1.0 - d), 0.0, 1.0);
      }
    }
    return d * SIGMA;
  }

  float hg(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * c, 1.5));
  }

  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    // View-space ray from the projection (works with reversed depth and view offsets).
    vec3 dirView = normalize(vec3((ndc.x + uProj[2][0]) / uProj[0][0], (ndc.y + uProj[2][1]) / uProj[1][1], -1.0));
    vec3 dir = normalize(mat3(uCamWorld) * dirView);
    float sceneDist = sceneDistance(vUv, dirView);
    #ifdef DEBUG_DEPTH
      gl_FragColor = vec4(vec3(log2(max(sceneDist, 1.0)) / 20.0), 0.0);
      return;
    #endif

    // Flat layer bounds along the ray (curvature is small within the march range).
    float mu = dot(dir, uUp);
    float hc = uCameraElevation;
    float t0, t1;
    float maxT = min(60000.0, sceneDist);
    if (abs(mu) < 1e-4) {
      if (hc < uCloudBase || hc > uCloudTop) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      t0 = 0.0;
      t1 = maxT;
    } else {
      float ta = (uCloudBase - hc) / mu;
      float tb = (uCloudTop - hc) / mu;
      t0 = max(min(ta, tb), 0.0);
      t1 = min(max(ta, tb), maxT);
    }
    if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

    // Interleaved gradient noise: offsets the start of each pixel (no banding).
    // Changes every frame (golden ratio); the accumulation averages it out.
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))
                         + uFrame * 0.61803399);
    // Steps grow along the ray: fine near the camera, coarse far away.
    float len = t1 - t0;
    const float K = 2.2;
    float norm = len / (exp(K) - 1.0);

    float cosSun = dot(dir, uSunDir);
    float phase = min(mix(hg(cosSun, 0.5), hg(cosSun, -0.25), 0.3) * 4.0 * PI, 2.2);
    float dayLight = smoothstep(-0.06, 0.12, uSunDir.y);
    vec3 sun = uSunColor * dayLight * 2.2;
    // Sky light inside clouds: nearly neutral (a blue tint makes shaded cores lilac).
    vec3 skyAmbient = mix(vec3(dot(uHazeColor, vec3(0.333))), vec3(0.78, 0.82, 0.9), 0.5)
                    * (0.35 + 0.65 * dayLight);

    vec3 scatter = vec3(0.0);
    float T = 1.0;
    float weightedT = 0.0;
    float weight = 0.0;
    for (int i = 0; i < STEPS; i++) {
      if (T < 0.02) break;
      float u0 = (float(i) + jitter) / float(STEPS);
      float t = t0 + norm * (exp(K * u0) - 1.0);
      float stepLen = norm * K * exp(K * u0) / float(STEPS);
      vec3 p = uCamPos + dir * t;
      float h = hc + mu * t;
      float sigma = density(p, h, false, t);
      if (sigma > 0.0) {
        // Light towards the sun: a few growing steps.
        float od = 0.0;
        float ls = 70.0;
        vec3 lp = p;
        float lh = h;
        for (int j = 0; j < LIGHT_STEPS; j++) {
          lp += uSunDir * ls;
          lh += dot(uSunDir, uUp) * ls;
          od += density(lp, lh, true, 1e9) * ls;
          ls *= 1.9;
        }
        float hn = clamp((h - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
        float beer = exp(-od);
        float powder = 1.0 - exp(-od * 2.0 - sigma * 60.0);
        vec3 light = sun * beer * mix(1.0, powder * 2.0, 0.5) * phase
                   + skyAmbient * (0.45 + 0.55 * hn);
        float ext = exp(-sigma * stepLen);
        scatter += T * light * (1.0 - ext);
        weightedT += T * (1.0 - ext) * t;
        weight += T * (1.0 - ext);
        T *= ext;
      }
    }
    // Aerial perspective on the clouds themselves.
    float dist = weight > 0.0 ? weightedT / weight : t0;
    float hazeAmt = 1.0 - exp(-dist * uHazeDensity * exp(-max(uCloudBase - 400.0, 0.0) / uHazeHeight));
    float sunAmt = pow(max(cosSun, 0.0), 14.0) * 0.8;
    vec3 haze = mix(uHazeColor, uHazeSunColor, sunAmt);
    scatter = mix(scatter, haze * (1.0 - T), hazeAmt);
    gl_FragColor = vec4(scatter, T);
  }
`;

const ACCUM_FRAG = /* glsl */ `
  uniform sampler2D tCurrent;
  uniform sampler2D tHistory;
  uniform mat4 uProj;
  uniform mat4 uCamWorld;
  uniform vec3 uCamPos;
  uniform vec3 uUp;
  uniform float uCameraElevation;
  uniform float uCloudBase;
  uniform float uCloudTop;
  uniform mat4 uPrevViewProj;
  uniform vec2 uTexel;
  uniform float uBlend;
  varying vec2 vUv;

  void main() {
    vec4 cur = texture2D(tCurrent, vUv);
    // Where was this cloud last frame? Assume it a third into the layer along the ray.
    vec2 ndc = vUv * 2.0 - 1.0;
    vec3 dirView = normalize(vec3((ndc.x + uProj[2][0]) / uProj[0][0], (ndc.y + uProj[2][1]) / uProj[1][1], -1.0));
    vec3 dir = normalize(mat3(uCamWorld) * dirView);
    float mu = dot(dir, uUp);
    float hc = uCameraElevation;
    float dist = 2000.0;
    if (abs(mu) > 1e-4) {
      float ta = (uCloudBase - hc) / mu;
      float tb = (uCloudTop - hc) / mu;
      float t0 = max(min(ta, tb), 0.0);
      float t1 = min(max(ta, tb), 60000.0);
      if (t1 > t0) dist = t0 + 0.35 * (t1 - t0);
    }
    vec4 clip = uPrevViewProj * vec4(uCamPos + dir * dist, 1.0);
    vec2 prevUv = clip.xy / clip.w * 0.5 + 0.5;
    if (clip.w <= 0.0 || prevUv.x < 0.0 || prevUv.y < 0.0 || prevUv.x > 1.0 || prevUv.y > 1.0) {
      gl_FragColor = cur;
      return;
    }
    // Clamp the history to the current neighbourhood: no ghosts when things change.
    vec4 lo = cur;
    vec4 hi = cur;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec4 n = texture2D(tCurrent, vUv + vec2(x, y) * uTexel);
        lo = min(lo, n);
        hi = max(hi, n);
      }
    vec4 hist = clamp(texture2D(tHistory, prevUv), lo, hi);
    gl_FragColor = mix(cur, hist, uBlend);
  }
`;

const MARCH_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;

/** Ray-marches the clouds into a reduced-resolution target (needs the scene depth). */
export class CloudMarchPass extends Pass {
  readonly target: WebGLRenderTarget;
  private readonly material: ShaderMaterial;
  private readonly accum: ShaderMaterial;
  private readonly history = [0, 1].map(() => {
    const t = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
    t.texture.minFilter = LinearFilter;
    t.texture.magFilter = LinearFilter;
    return t;
  });
  private historyIndex = 0;
  private frame = 0;
  private readonly prevViewProj = new Matrix4();
  private hasHistory = false;
  /** Called every frame with the texture to composite (the accumulated clouds). */
  onOutput?: (texture: Texture) => void;
  /** Called with the target size after a resize. */
  onResize?: (width: number, height: number) => void;

  constructor(
    private readonly mainCam: PerspectiveCamera,
    atmosphere: AtmosphereUniforms,
    cloudLayer: { base: { value: number }; top: { value: number } },
    private readonly scale = 0.5,
    steps = 48,
    depthMode: 'reversed' | 'log' | 'standard' = 'standard',
  ) {
    super('CloudMarchPass');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
    this.target.texture.minFilter = LinearFilter;
    this.target.texture.magFilter = LinearFilter;
    this.material = new ShaderMaterial({
      defines: {
        STEPS: String(steps),
        LIGHT_STEPS: '4',
        // How the scene depth is stored (three does not tell full-screen passes).
        ...(depthMode === 'reversed' ? { CLOUD_REVERSED_DEPTH: '1' } : {}),
        ...(depthMode === 'log' ? { CLOUD_LOG_DEPTH: '1' } : {}),
        // ?clouddebug=depth shows the scene distance (log scale) instead of clouds.
        ...(location.search.includes('clouddebug=depth') ? { DEBUG_DEPTH: '1' } : {}),
      },
      uniforms: {
        ...atmosphere,
        depthBuffer: new Uniform(null),
        uNoise3D: new Uniform(makeNoise3D()),
        uProj: new Uniform(mainCam.projectionMatrix),
        uCamWorld: new Uniform(mainCam.matrixWorld),
        uCamPos: new Uniform(mainCam.position),
        cameraNear: new Uniform(mainCam.near),
        cameraFar: new Uniform(mainCam.far),
        uCloudBase: cloudLayer.base,
        uCloudTop: cloudLayer.top,
        uResolution: new Uniform(new Vector2(1, 1)),
        uFrame: new Uniform(0),
      },
      vertexShader: MARCH_VERT,
      fragmentShader: MARCH_FRAG,
      depthWrite: false,
      depthTest: false,
    });
    this.accum = new ShaderMaterial({
      uniforms: {
        tCurrent: new Uniform(this.target.texture),
        tHistory: new Uniform(null),
        uProj: new Uniform(mainCam.projectionMatrix),
        uCamWorld: new Uniform(mainCam.matrixWorld),
        uCamPos: new Uniform(mainCam.position),
        uUp: atmosphere.uUp,
        uCameraElevation: atmosphere.uCameraElevation,
        uCloudBase: cloudLayer.base,
        uCloudTop: cloudLayer.top,
        uPrevViewProj: new Uniform(this.prevViewProj),
        uTexel: new Uniform(new Vector2(1, 1)),
        uBlend: new Uniform(0),
      },
      vertexShader: MARCH_VERT,
      fragmentShader: ACCUM_FRAG,
      depthWrite: false,
      depthTest: false,
    });
    this.fullscreenMaterial = this.material;
  }

  private readonly pixelHalf = new Uint16Array(4);
  private output?: WebGLRenderTarget;

  /**
   * Cloud transmittance (1 = clear) at a screen position (0..1), read back from the GPU. One
   * pixel; call rarely (it waits for the GPU).
   */
  transmittanceAt(renderer: WebGLRenderer, u: number, v: number): number {
    const t = this.output;
    // Just off screen (the glare still shows): use the nearest edge pixel.
    if (!t || u < -0.3 || v < -0.3 || u > 1.3 || v > 1.3) return 1;
    u = Math.min(1, Math.max(0, u));
    v = Math.min(1, Math.max(0, v));
    const x = Math.min(t.width - 1, Math.floor(u * t.width));
    const y = Math.min(t.height - 1, Math.floor(v * t.height));
    try {
      renderer.readRenderTargetPixels(t, x, y, 1, 1, this.pixelHalf);
      return Math.min(1, Math.max(0, fromHalf(this.pixelHalf[3]!)));
    } catch {
      return 1;
    }
  }

  /** Forget the history (after a teleport or a floating-origin jump). */
  resetHistory() {
    this.hasHistory = false;
  }

  override setDepthTexture(depthTexture: Texture) {
    this.material.uniforms.depthBuffer!.value = depthTexture;
  }

  override setSize(width: number, height: number) {
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    this.target.setSize(w, h);
    for (const t of this.history) t.setSize(w, h);
    this.hasHistory = false;
    (this.material.uniforms.uResolution!.value as Vector2).set(w, h);
    (this.accum.uniforms.uTexel!.value as Vector2).set(1 / w, 1 / h);
    this.onResize?.(w, h);
  }

  override render(renderer: WebGLRenderer) {
    const u = this.material.uniforms;
    u.cameraNear!.value = this.mainCam.near;
    u.cameraFar!.value = this.mainCam.far;
    u.uFrame!.value = this.frame++ % 1000;
    this.fullscreenMaterial = this.material;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    // Accumulate: blend with last frame's clouds, reprojected to the new view.
    const a = this.accum.uniforms;
    const src = this.history[this.historyIndex]!;
    const dst = this.history[1 - this.historyIndex]!;
    a.tHistory!.value = src.texture;
    a.uBlend!.value = this.hasHistory ? 0.85 : 0;
    this.fullscreenMaterial = this.accum;
    renderer.setRenderTarget(dst);
    renderer.render(this.scene, this.camera);
    this.fullscreenMaterial = this.material;
    this.historyIndex = 1 - this.historyIndex;
    this.hasHistory = true;
    this.prevViewProj.multiplyMatrices(
      this.mainCam.projectionMatrix,
      this.mainCam.matrixWorldInverse,
    );
    this.output = dst;
    this.onOutput?.(dst.texture);
  }

  override dispose() {
    super.dispose();
    this.target.dispose();
    for (const t of this.history) t.dispose();
    this.accum.dispose();
    (this.material.uniforms.uNoise3D!.value as Texture).dispose();
  }
}

/** Blends the marched clouds over the HDR image (before tone mapping). */
export class CloudCompositeEffect extends Effect {
  constructor(clouds: Texture) {
    super(
      'CloudCompositeEffect',
      /* glsl */ `
        uniform sampler2D tClouds;
        uniform vec2 uCloudTexel;
        void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
          // Soft 5-tap filter: hides the per-pixel jitter of the march.
          vec2 o = uCloudTexel * 0.75;
          vec4 c = texture2D(tClouds, uv) * 0.4
                 + (texture2D(tClouds, uv + vec2(o.x, o.y)) + texture2D(tClouds, uv + vec2(-o.x, o.y))
                  + texture2D(tClouds, uv + vec2(o.x, -o.y)) + texture2D(tClouds, uv - o)) * 0.15;
          outputColor = vec4(inputColor.rgb * c.a + c.rgb, inputColor.a);
        }
      `,
      {
        blendFunction: BlendFunction.NORMAL,
        uniforms: new Map<string, Uniform>([
          ['tClouds', new Uniform(clouds)],
          ['uCloudTexel', new Uniform(new Vector2(1 / 960, 1 / 540))],
        ]),
      },
    );
  }

  /** The clouds to blend in (changes every frame with the accumulation). */
  setClouds(texture: Texture) {
    this.uniforms.get('tClouds')!.value = texture;
  }

  /** Size of one texel of the cloud target (call when it is resized). */
  setTexel(width: number, height: number) {
    (this.uniforms.get('uCloudTexel')!.value as Vector2).set(1 / width, 1 / height);
  }
}
