import {
  Color,
  DataTexture,
  type DirectionalLight,
  type HemisphereLight,
  LinearFilter,
  LinearMipmapLinearFilter,
  RedFormat,
  RepeatWrapping,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three';
import type { Sky } from 'three/examples/jsm/objects/Sky.js';
import { solarPosition } from './sun';
import {
  BETA_R,
  H_MIE,
  H_RAYLEIGH,
  MIE_EXT,
  MIE_G,
  SUN_SCALE,
  opticalDepth,
  sunTransmittance,
} from './scattering';

const DEG = Math.PI / 180;
/** Period of the shared noise texture in metres (cloud and detail patterns repeat after this). */
export const NOISE_PERIOD = 24_000;

/** Uniforms shared by terrain, cloud and other world shaders (same objects, updated in place). */
export interface AtmosphereUniforms {
  uSunDir: { value: Vector3 };
  uSunColor: { value: Color };
  uHazeColor: { value: Color };
  uHazeSunColor: { value: Color };
  /** Haze extinction per metre at sea level. */
  uHazeDensity: { value: number };
  /** Scale height of the haze in metres. */
  uHazeHeight: { value: number };
  uCameraElevation: { value: number };
  /** Base-frame offset of the render origin modulo NOISE_PERIOD (x, z), keeps patterns stable. */
  uOriginMod: { value: Vector2 };
  uTime: { value: number };
  uNoise: { value: DataTexture };
  uCloudCoverage: { value: number };
  uCloudAltitude: { value: number };
  /** Volumetric cumulus layer, metres above sea level. */
  uCloudBase: { value: number };
  uCloudTop: { value: number };
  uCloudShadow: { value: number };
  /** Local vertical at the camera (render space). */
  uUp: { value: Vector3 };
  /** Stratus layer (Hochnebel / ground fog), metres above sea level; density 0 = none. */
  uFogTop: { value: number };
  uFogBase: { value: number };
  uFogDensity: { value: number };
  uFogColor: { value: Color };
  /** Mie scattering at sea level (1/m): haze of the weather. */
  uMie: { value: number };
  /** Multiple-scattered sky light added to the haze. */
  uSkyLight: { value: Color };
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Colour ramps over sun elevation (degrees), linear RGB.
const SUN_COLOR: Array<[number, Color]> = [
  [-2, new Color(0.9, 0.35, 0.18)],
  [3, new Color(1.0, 0.55, 0.3)],
  [12, new Color(1.0, 0.82, 0.62)],
  [35, new Color(1.0, 0.95, 0.88)],
];

/** Tileable value-noise texture (fbm, 4 octaves) used for clouds, cloud shadows and detail. */
function makeNoiseTexture(size = 256): DataTexture {
  const data = new Uint8Array(size * size);
  const grid = (n: number) => {
    const g = new Float32Array(n * n);
    let s = n * 9973;
    for (let i = 0; i < g.length; i++) {
      s = (s * 16807) % 2147483647;
      g[i] = s / 2147483647;
    }
    return g;
  };
  const octaves = [8, 16, 32, 64].map((n) => ({ n, g: grid(n) }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      let amp = 0.5;
      let total = 0;
      for (const { n, g } of octaves) {
        const fx = (x / size) * n;
        const fy = (y / size) * n;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const at = (i: number, j: number) => g[((j + n) % n) * n + ((i + n) % n)]!;
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
        const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
        v += (a + (b - a) * sy) * amp;
        total += amp;
        amp *= 0.5;
      }
      data[y * size + x] = Math.round((v / total) * 255);
    }
  }
  const tex = new DataTexture(data, size, size, RedFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Time of day and the look that follows from it: sun position and colour, sky parameters,
 * ambient light and haze colours. One instance per world; shaders share `uniforms`.
 */
export class Atmosphere {
  readonly uniforms: AtmosphereUniforms;
  date: Date;
  sunElevation = 30;
  sunAzimuth = 180;
  /** Exposure suggested for the current light (applied by the renderer / tone mapping). */
  exposure = 0.85;

  constructor(
    date: Date,
    private readonly lat: number,
    private readonly lon: number,
  ) {
    this.date = date;
    this.uniforms = {
      uSunDir: { value: new Vector3(0, 1, 0) },
      uSunColor: { value: new Color(1, 1, 1) },
      uHazeColor: { value: new Color() },
      uHazeSunColor: { value: new Color() },
      uHazeDensity: { value: 1 / 60_000 },
      uHazeHeight: { value: 2600 },
      uCameraElevation: { value: 0 },
      uOriginMod: { value: new Vector2() },
      uTime: { value: 0 },
      uNoise: { value: makeNoiseTexture() },
      uCloudCoverage: { value: 0.45 },
      uCloudAltitude: { value: 3600 },
      uCloudBase: { value: 2300 },
      uCloudTop: { value: 3700 },
      uCloudShadow: { value: 0.45 },
      uUp: { value: new Vector3(0, 1, 0) },
      uFogTop: { value: 1100 },
      uFogBase: { value: 750 },
      uFogDensity: { value: 0 },
      uFogColor: { value: new Color(0.95, 0.96, 0.98) },
      uMie: { value: 1.8e-5 },
      uSkyLight: { value: new Color(0.1, 0.14, 0.22) },
    };
    this.update();
  }

  setDate(date: Date) {
    this.date = date;
    this.update();
  }

  /** Recomputes everything that depends on the sun. */
  update() {
    const { azimuth, elevation } = solarPosition(this.date, this.lat, this.lon);
    this.sunAzimuth = azimuth;
    this.sunElevation = elevation;
    const az = azimuth * DEG;
    const el = Math.max(elevation, -3) * DEG;
    // Base frame axes: x = east, y = up, z = -north.
    this.uniforms.uSunDir.value.set(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      -Math.cos(el) * Math.cos(az),
    );
    this.updateScattering(elevation);
    // Sunlit stratus: white by day, warm at low sun, dim at dusk.
    this.uniforms.uFogColor.value
      .setRGB(0.95, 0.96, 0.98)
      .lerp(this.uniforms.uSunColor.value, 0.15)
      .multiplyScalar(0.25 + 0.75 * smoothstep(-3, 12, elevation));
    // Low sun: more haze, golden light a little brighter in the image.
    this.uniforms.uHazeDensity.value =
      (1 / 60_000) * (1 + 0.8 * (1 - smoothstep(5, 30, elevation)));
    this.exposure = 0.85 + 0.25 * (1 - smoothstep(4, 25, elevation));
  }

  /**
   * Sun colour from the air mass it crosses (scattering.ts), sky light, and the haze colours
   * other effects use (horizontal view at 500 m, 60 km, away from and towards the sun).
   */
  updateScattering(elevation: number) {
    const u = this.uniforms;
    const mie = u.uMie.value;
    const sinEl = Math.sin(elevation * DEG);
    const t = sunTransmittance(600, sinEl, mie);
    const peak = Math.max(...t, 1e-4);
    u.uSunColor.value.setRGB(t[0] / peak, t[1] / peak, t[2] / peak);
    if (elevation < -1) u.uSunColor.value.lerp(SUN_COLOR[0]![1], smoothstep(-1, -3, elevation));
    const day = smoothstep(-6, 10, elevation);
    u.uSkyLight.value.setRGB(0.1, 0.14, 0.22).multiplyScalar(0.15 + 0.85 * day);
    // CPU twin of inscatter() for a horizontal ray.
    const haze = (cosToSun: number, out: Color) => {
      const d = 60_000;
      const tauR = opticalDepth(500, 500, d, H_RAYLEIGH);
      const tauM = opticalDepth(500, 500, d, H_MIE);
      const phaseR = (3 / (16 * Math.PI)) * (1 + cosToSun * cosToSun);
      const g2 = MIE_G * MIE_G;
      const phaseM = (1 - g2) / (4 * Math.PI * (1 + g2 - 2 * MIE_G * cosToSun) ** 1.5);
      const sun = sunTransmittance(500, sinEl, mie);
      const lit = SUN_SCALE * smoothstep(-0.08, 0.04, sinEl);
      const c = [0, 1, 2].map((i) => {
        const ext = BETA_R[i]! * tauR + MIE_EXT * mie * tauM;
        const scat = BETA_R[i]! * tauR * phaseR + mie * tauM * phaseM;
        const oneMinusT = 1 - Math.exp(-ext);
        const sky = [u.uSkyLight.value.r, u.uSkyLight.value.g, u.uSkyLight.value.b][i]!;
        return ((lit * sun[i]! * scat) / ext) * oneMinusT + sky * oneMinusT;
      });
      out.setRGB(c[0]!, c[1]!, c[2]!);
    };
    const cosEl = Math.cos(Math.max(elevation, 0) * DEG);
    haze(0, u.uHazeColor.value);
    haze(cosEl, u.uHazeSunColor.value);
  }

  /** Light intensities for the time of day (before the fog dims them). */
  sunIntensity = 1.1;
  hemiIntensity = 1.3;

  /** Applies the current state to the scene lights and the sky dome. */
  apply(sun: DirectionalLight, hemi: HemisphereLight, sky: Sky) {
    const e = this.sunElevation;
    const u = this.uniforms;
    sun.color.copy(u.uSunColor.value);
    this.sunIntensity = 1.1 * smoothstep(-1.5, 8, e) * (0.75 + 0.25 * smoothstep(10, 40, e));
    this.hemiIntensity = 1.3 * (0.3 + 0.7 * smoothstep(-4, 25, e));
    sun.intensity = this.sunIntensity;
    hemi.intensity = this.hemiIntensity;
    hemi.color.setRGB(0.78, 0.86, 1.0).lerp(new Color(1.0, 0.78, 0.62), 1 - smoothstep(2, 20, e));
    const s = sky.material.uniforms;
    s.sunPosition!.value.copy(u.uSunDir.value);
    s.turbidity!.value = 2.5 + 4 * (1 - smoothstep(3, 30, e));
    s.rayleigh!.value = 1.1 + 1.6 * (1 - smoothstep(3, 30, e));
    s.mieCoefficient!.value = 0.004 + 0.004 * (1 - smoothstep(3, 30, e));
    s.mieDirectionalG!.value = 0.85;
  }

  /** CPU version of cloudDensity() in the shaders (same noise, wind and coverage). */
  cloudDensityAt(baseX: number, baseZ: number): number {
    const u = this.uniforms;
    const tex = u.uNoise.value;
    const size = tex.image.width;
    const data = tex.image.data as Uint8Array;
    const sample = (x: number, z: number) => {
      const fx = (((x % 1) + 1) % 1) * size - 0.5;
      const fz = (((z % 1) + 1) % 1) * size - 0.5;
      const x0 = Math.floor(fx);
      const z0 = Math.floor(fz);
      const tx = fx - x0;
      const tz = fz - z0;
      const at = (i: number, j: number) =>
        data[((j + size) % size) * size + ((i + size) % size)]! / 255;
      const a = at(x0, z0) + (at(x0 + 1, z0) - at(x0, z0)) * tx;
      const b = at(x0, z0 + 1) + (at(x0 + 1, z0 + 1) - at(x0, z0 + 1)) * tx;
      return a + (b - a) * tz;
    };
    const t = u.uTime.value;
    const n =
      sample((baseX + 9 * t) / NOISE_PERIOD, (baseZ + 3.5 * t) / NOISE_PERIOD) * 0.65 +
      sample(
        (baseX + 14.4 * t) / (NOISE_PERIOD * 0.31),
        (baseZ + 5.6 * t) / (NOISE_PERIOD * 0.31),
      ) *
        0.35;
    const edge = 1 - u.uCloudCoverage.value;
    return smoothstep(edge - 0.06, edge + 0.14, n);
  }

  /** 0 above the fog layer, 1 inside or below it (the sun is hidden). */
  underFog(elevation: number): number {
    const u = this.uniforms;
    if (u.uFogDensity.value <= 0) return 0;
    return smoothstep(u.uFogTop.value + 15, u.uFogTop.value - 90, elevation);
  }

  /** Per frame: wind time, render-origin offset, camera height and vertical. */
  tick(dt: number, originShift: Vector3, cameraElevation: number, up: Vector3) {
    const u = this.uniforms;
    u.uTime.value += dt;
    const mod = (v: number) => ((v % NOISE_PERIOD) + NOISE_PERIOD) % NOISE_PERIOD;
    u.uOriginMod.value.set(mod(originShift.x), mod(originShift.z));
    u.uCameraElevation.value = cameraElevation;
    u.uUp.value.copy(up);
  }

  /** Dims the lights under the fog (call every frame after tick). */
  dimLights(sun: DirectionalLight, hemi: HemisphereLight, cameraElevation: number) {
    const k = this.underFog(cameraElevation);
    sun.intensity = this.sunIntensity * (1 - 0.8 * k);
    hemi.intensity = this.hemiIntensity * (1 - 0.3 * k);
  }
}
