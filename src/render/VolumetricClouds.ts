import { BlendFunction, Effect, Pass } from 'postprocessing';
import {
  Data3DTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  type PerspectiveCamera,
  RGBAFormat,
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
import { detailNoiseData, shapeNoiseData } from './cloudNoise';

/**
 * Volumetric clouds: a ray march through the cloud layer for every pixel (at reduced
 * resolution), stopped by the scene depth. Built like the Horizon Zero Dawn / Nubis clouds:
 *
 *  - Weather: coverage from the same 2D noise as the cloud shadows on the terrain, plus a
 *    cloud type (flat stratocumulus .. towering cumulus) that sets the height profile.
 *  - Shape: Perlin-Worley base noise remapped by coverage and profile, the edges eroded by a
 *    detail Worley noise, wispy at the base and billowy at the top; tops lean with the wind.
 *  - Light: sun light marched towards the sun, multiple scattering approximated by octaves
 *    (Wrenninge), a two-lobe phase function (silver lining towards the sun), Beer-Powder
 *    depending on the view, sky light from above and ground bounce from below.
 *
 * The result (in-scattered light + transmittance) is blended over the image by
 * CloudCompositeEffect.
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

function texture3D(data: Uint8Array, size: number): Data3DTexture {
  const tex = new Data3DTexture(data, size, size, size);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** Shape noise texture (computed here; the game builds it in a worker, see CloudMarchPass). */
export function makeShapeNoise(size = N3): Data3DTexture {
  return texture3D(shapeNoiseData(size), size);
}

/** Detail noise texture. */
export function makeDetailNoise(size = 32): Data3DTexture {
  return texture3D(detailNoiseData(size), size);
}

/** Stand-in until the worker is done: no clouds (base noise 0, erosion floor 1). */
function emptyNoise(): Data3DTexture {
  return texture3D(
    new Uint8Array([0, 255, 255, 255].concat(...Array(7).fill([0, 255, 255, 255]))),
    2,
  );
}

let noiseData: Promise<{ shape: Uint8Array; detail: Uint8Array }> | undefined;

/** Builds both noises once, in a web worker (~0.3 s of work off the main thread). */
function loadNoise() {
  noiseData ??= new Promise((resolve, reject) => {
    const w = new Worker(new URL('../workers/cloudNoise.worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = (e: MessageEvent<{ shape: Uint8Array; detail: Uint8Array }>) => {
      resolve(e.data);
      w.terminate();
    };
    w.onerror = (e) => {
      reject(e);
      w.terminate();
    };
    w.postMessage(null);
  });
  return noiseData;
}

const MARCH_FRAG = /* glsl */ `
  #include <common>
  #include <packing>
  precision highp sampler3D;
  uniform sampler2D depthBuffer;
  uniform sampler3D uShape;
  uniform sampler3D uDetail;
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

  float remap(float x, float a, float b, float c, float d) {
    return c + (x - a) / max(b - a, 1e-4) * (d - c);
  }

  // Cloud type at a place: 0 = flat stratocumulus, 1 = towering cumulus. Denser cells and
  // more cloudy weather build higher.
  float cloudType(vec2 q, float cov) {
    vec2 wind = vec2(9.0, 3.5) * uTime;
    float n = texture2D(uNoise, (q + wind) / (NOISE_PERIOD * 1.9) + vec2(0.37, 0.71)).r;
    return clamp(smoothstep(0.25, 0.8, n) * 0.75 + cov * 0.35 + uCloudCoverage * 0.2 - 0.15, 0.0, 1.0);
  }

  // Detail noise at the last full density sample (mottles the light on cloud bases).
  float gDetail = 0.5;

  // Height profile 0..1 inside the layer for a cloud type: flat base, rounded tops.
  float heightProfile(float hn, float type, float cov, float lift) {
    float top = mix(0.32, 1.0, type) * (0.65 + 0.35 * cov);
    float bottom = smoothstep(lift, lift + mix(0.05, 0.12, type), hn);
    return bottom * (1.0 - smoothstep(top * mix(0.35, 0.6, type), top, hn));
  }

  // Extinction (1/m) at a point. cheap = without the detail erosion (light march).
  float density(vec3 p, float h, bool cheap, float camDist) {
    float hn = (h - uCloudBase) / (uCloudTop - uCloudBase);
    if (hn < 0.0 || hn > 1.0) return 0.0;
    vec2 q = basePos(p);
    float cov = coverage(q);
    if (cov < 0.01) return 0.0;
    float type = cloudType(q, cov);
    // Wind; the tops lean downwind (shear).
    vec3 windDir = vec3(9.0, 0.0, 3.5);
    vec3 s = vec3(q.x, h * 1.3, q.y) + windDir * uTime + windDir * hn * 45.0;
    vec4 n = texture(uShape, s / 3400.0);
    // Uneven bases: the cloud bottom rises and falls a little with the noise.
    float profile = heightProfile(hn, type, cov, 0.07 * (1.0 - n.g));
    if (profile <= 0.0) return 0.0;
    float wfbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
    float base = remap(n.r, wfbm - 1.0, 1.0, 0.0, 1.0);
    // Coverage: sparse cells keep only their cores; the profile rounds base and top.
    // Even under full cover the noise keeps carving: no smooth sheets with round edges.
    float d = clamp(remap(base * profile, 1.0 - cov * 0.68, 1.0, 0.0, 1.0), 0.0, 1.0);
    if (!cheap && d > 0.0) {
      vec3 dn = texture(uDetail, s / 480.0).rgb;
      float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
      gDetail = dfbm;
      // Wispy at the base, billowy (cauliflower) towards the top.
      float m = mix(dfbm, 1.0 - dfbm, clamp(hn * 5.0, 0.0, 1.0));
      // Very far away the fine erosion only adds noise.
      float k = 0.46 * (1.0 - 0.5 * smoothstep(12000.0, 30000.0, camDist));
      d = clamp(remap(d, m * k, 1.0, 0.0, 1.0), 0.0, 1.0);
      // Close up: a finer layer of curls on the edges.
      float near = 1.0 - smoothstep(1500.0, 5000.0, camDist);
      if (near > 0.0 && d > 0.0) {
        float fine = texture(uDetail, s / 130.0 + 0.37).g;
        float fm = mix(fine, 1.0 - fine, clamp(hn * 5.0, 0.0, 1.0));
        d = clamp(remap(d, fm * 0.3 * near, 1.0, 0.0, 1.0), 0.0, 1.0);
      }
    }
    return d * SIGMA;
  }

  float hg(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * c, 1.5));
  }

  // Two lobes: a strong forward peak (silver lining) and some back scattering. 1 = isotropic.
  float phase2(float c, float k) {
    return mix(hg(c, 0.8 * k), hg(c, -0.2 * k), 0.4) * 4.0 * PI;
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
    float dayLight = smoothstep(-0.06, 0.12, uSunDir.y);
    vec3 sun = uSunColor * dayLight * 1.9;
    // Sky light from above: nearly neutral (a blue tint makes shaded cores lilac).
    vec3 skyAmbient = mix(vec3(dot(uHazeColor, vec3(0.333))), vec3(0.78, 0.82, 0.9), 0.5)
                    * (0.35 + 0.65 * dayLight);
    // Light bounced off the landscape below: warm and dim.
    vec3 ground = vec3(0.42, 0.40, 0.34) * uSunColor * dayLight * max(uSunDir.y, 0.0) * 0.35;
    // Phase per scattering octave (constant along the ray).
    float ph0 = min(phase2(cosSun, 1.0), 9.0);
    float ph1 = min(phase2(cosSun, 0.5), 4.0);
    float ph2 = min(phase2(cosSun, 0.25), 2.0);
    // Powder (dark edges, bright folds) only when looking away from the sun.
    float powderMix = clamp(0.5 - 0.5 * cosSun, 0.0, 1.0);

    vec3 scatter = vec3(0.0);
    float T = 1.0;
    float weightedT = 0.0;
    float weight = 0.0;
    for (int i = 0; i < STEPS; i++) {
      if (T < 0.015) break;
      float u0 = (float(i) + jitter) / float(STEPS);
      float t = t0 + norm * (exp(K * u0) - 1.0);
      float stepLen = norm * K * exp(K * u0) / float(STEPS);
      vec3 p = uCamPos + dir * t;
      float h = hc + mu * t;
      float sigma = density(p, h, false, t);
      if (sigma > 0.0) {
        // Optical depth towards the sun: growing steps, ~1.5 km.
        float od = 0.0;
        float ls = 45.0;
        vec3 lp = p;
        float lh = h;
        float sunUp = dot(uSunDir, uUp);
        for (int j = 0; j < LIGHT_STEPS; j++) {
          lp += uSunDir * ls;
          lh += sunUp * ls;
          od += density(lp, lh, true, 1e9) * ls;
          ls *= 1.7;
        }
        // Multiple scattering (Wrenninge): octaves see less extinction, a softer phase.
        float ms = exp(-od) * ph0 + 0.4 * exp(-od * 0.5) * ph1 + 0.16 * exp(-od * 0.25) * ph2;
        float powder = 1.0 - exp(-od * 2.0 - sigma * 80.0);
        ms *= mix(1.0, powder * 1.6, powderMix);
        float hn = clamp((h - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
        // Sky light: darker low in the cloud, mottled by the detail noise (cloud bases).
        vec3 light = sun * ms
                   + skyAmbient * (0.3 + 0.7 * sqrt(hn)) * (0.7 + 0.6 * gDetail)
                   + ground * (1.0 - hn);
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
        LIGHT_STEPS: '6',
        // How the scene depth is stored (three does not tell full-screen passes).
        ...(depthMode === 'reversed' ? { CLOUD_REVERSED_DEPTH: '1' } : {}),
        ...(depthMode === 'log' ? { CLOUD_LOG_DEPTH: '1' } : {}),
        // ?clouddebug=depth shows the scene distance (log scale) instead of clouds.
        ...(location.search.includes('clouddebug=depth') ? { DEBUG_DEPTH: '1' } : {}),
      },
      uniforms: {
        ...atmosphere,
        depthBuffer: new Uniform(null),
        uShape: new Uniform(emptyNoise()),
        uDetail: new Uniform(emptyNoise()),
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
    loadNoise().then(
      ({ shape, detail }) => {
        if (this.disposed) return;
        const u = this.material.uniforms;
        (u.uShape!.value as Texture).dispose();
        (u.uDetail!.value as Texture).dispose();
        u.uShape!.value = texture3D(shape, N3);
        u.uDetail!.value = texture3D(detail, 32);
        this.hasHistory = false;
      },
      // Without workers: build them here.
      () => {
        if (this.disposed) return;
        this.material.uniforms.uShape!.value = makeShapeNoise();
        this.material.uniforms.uDetail!.value = makeDetailNoise();
      },
    );
  }

  private disposed = false;

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
    // Asynchronous read-back: a synchronous one waits for the GPU to finish the frame (a
    // stall of up to a few hundred ms when the GPU is busy, e.g. right at a crash). The
    // answer comes a few frames later; until then the last one is used.
    if (!this.reading) {
      this.reading = true;
      renderer
        .readRenderTargetPixelsAsync(t, x, y, 1, 1, this.pixelHalf)
        .then(
          () => {
            this.lastTransmittance = Math.min(1, Math.max(0, fromHalf(this.pixelHalf[3]!)));
          },
          () => {},
        )
        .finally(() => {
          this.reading = false;
        });
    }
    return this.lastTransmittance;
  }

  private reading = false;
  private lastTransmittance = 1;

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
    this.disposed = true;
    super.dispose();
    this.target.dispose();
    for (const t of this.history) t.dispose();
    this.accum.dispose();
    (this.material.uniforms.uShape!.value as Texture).dispose();
    (this.material.uniforms.uDetail!.value as Texture).dispose();
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
