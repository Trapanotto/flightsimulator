/**
 * Single-scattering model of the atmosphere (Rayleigh + Mie, exponential density), shared by
 * the shaders (GLSL) and the CPU (sun colour, haze colours for other effects).
 *
 *  - Rayleigh: air molecules, scatter blue ~5x more than red -> blue sky, blue distant hills.
 *  - Mie: aerosols (haze), nearly grey, strongly forward -> bright glow around the sun; the
 *    amount follows the weather.
 *  - The sun's light is filtered by the air mass it crosses -> orange and red at low sun.
 *
 * Along a straight view path from height h0 to h1 (length d) the optical depth of an
 * exponential atmosphere has a closed form, so no ray march is needed.
 */

/** Rayleigh scattering at sea level, 1/m (680, 550, 440 nm). */
export const BETA_R: [number, number, number] = [5.8e-6, 13.5e-6, 33.1e-6];
export const H_RAYLEIGH = 8000;
export const H_MIE = 1200;
/** Mie extinction / scattering. */
export const MIE_EXT = 1.11;
export const MIE_G = 0.76;
/** Sun irradiance scale for the image (calibrated to the scene's lighting). */
export const SUN_SCALE = 10;

/** Optical depth (metres of sea-level air) of a path from h0 to h1, length d, scale height H. */
export function opticalDepth(h0: number, h1: number, d: number, H: number): number {
  const dh = h1 - h0;
  if (Math.abs(dh) < 1) return d * Math.exp(-Math.max(h0, -500) / H);
  return (d * H * (Math.exp(-Math.max(h0, -500) / H) - Math.exp(-Math.max(h1, -500) / H))) / dh;
}

/** Relative air mass towards the sun (Kasten & Young), sinElevation = sun direction . up. */
export function airMass(sinElevation: number): number {
  const el = Math.asin(Math.max(-1, Math.min(1, sinElevation))) * (180 / Math.PI);
  const zenith = 90 - Math.max(el, -2);
  return (
    1 /
    (Math.cos((Math.min(zenith, 91) * Math.PI) / 180) + 0.50572 * (96.07995 - zenith) ** -1.6364)
  );
}

/** Transmittance of sunlight reaching height h (per channel). */
export function sunTransmittance(
  h: number,
  sinElevation: number,
  mie: number,
): [number, number, number] {
  const m = airMass(sinElevation);
  const odR = H_RAYLEIGH * Math.exp(-h / H_RAYLEIGH) * m;
  const odM = H_MIE * Math.exp(-Math.max(h, 0) / H_MIE) * m;
  return BETA_R.map((b) => Math.exp(-(b * odR + MIE_EXT * mie * odM))) as [number, number, number];
}

export const SCATTERING_GLSL = /* glsl */ `
  #ifndef SCATTERING_DECLARED
  #define SCATTERING_DECLARED
  /** Mie scattering at sea level (1/m): the haze of the weather. */
  uniform float uMie;
  /** Multiple-scattered sky light (fills shadows of the haze). */
  uniform vec3 uSkyLight;
  const vec3 BETA_R = vec3(${BETA_R.map((b) => b.toExponential(2)).join(', ')});
  const float H_R = ${H_RAYLEIGH.toFixed(1)};
  const float H_M = ${H_MIE.toFixed(1)};
  const float MIE_EXT = ${MIE_EXT.toFixed(2)};
  const float MIE_G = ${MIE_G.toFixed(2)};
  const float SUN_SCALE = ${SUN_SCALE.toFixed(1)};

  float opticalDepth(float h0, float h1, float d, float H) {
    h0 = max(h0, -500.0);
    h1 = max(h1, -500.0);
    float dh = h1 - h0;
    if (abs(dh) < 1.0) return d * exp(-h0 / H);
    return d * H * (exp(-h0 / H) - exp(-h1 / H)) / dh;
  }

  float airMass(float sinEl) {
    float el = degrees(asin(clamp(sinEl, -1.0, 1.0)));
    float zenith = 90.0 - max(el, -2.0);
    return 1.0 / (cos(radians(min(zenith, 91.0))) + 0.50572 * pow(96.07995 - zenith, -1.6364));
  }

  vec3 sunTransmittance(float h, float sinEl) {
    float m = airMass(sinEl);
    float odR = H_R * exp(-h / H_R) * m;
    float odM = H_M * exp(-max(h, 0.0) / H_M) * m;
    return exp(-(BETA_R * odR + MIE_EXT * uMie * odM));
  }

  // Light between the eye (height h0) and a point (height h1) at distance d along dir, and how
  // much of the point still shows through (T).
  vec3 inscatter(vec3 dir, float d, float h0, float h1, vec3 sunDir, float sinSun, out vec3 T) {
    float tauR = opticalDepth(h0, h1, d, H_R);
    float tauM = opticalDepth(h0, h1, d, H_M);
    vec3 ext = BETA_R * tauR + vec3(MIE_EXT * uMie * tauM);
    T = exp(-ext);
    float c = dot(dir, sunDir);
    float phaseR = 3.0 / (16.0 * PI) * (1.0 + c * c);
    float g2 = MIE_G * MIE_G;
    float phaseM = (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * MIE_G * c, 1.5));
    vec3 scat = BETA_R * tauR * phaseR + vec3(uMie * tauM * phaseM);
    vec3 sun = SUN_SCALE * sunTransmittance(0.5 * (h0 + h1), sinSun) * smoothstep(-0.08, 0.04, sinSun);
    vec3 oneMinusT = 1.0 - T;
    return sun * scat / max(ext, vec3(1e-7)) * oneMinusT + uSkyLight * oneMinusT;
  }
  #endif
`;
