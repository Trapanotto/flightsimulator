import { SCATTERING_GLSL } from './scattering';

/**
 * Shared GLSL for everything seen through the air: terrain, buildings, the fog dome.
 *
 *   aerial(colour, worldPos, elevation)  haze, the stratus layer (Hochnebel / ground fog) and
 *                                         the dull light underneath it
 *   elevationOf(worldPos)                 altitude of a render-space point (near the camera)
 *
 * The fog layer is a slab between uFogBase and uFogTop (metres above sea level). The length
 * of the view ray inside it gives the fog amount, so the same formula makes the white sea of
 * fog seen from above, the grey ceiling seen from below and 150 m visibility inside it.
 * Declarations are guarded, so shaders that already declare some of these can include it.
 */

export const NOISE_DECLARATIONS = /* glsl */ `
  #ifndef NOISE_DECLARED
  #define NOISE_DECLARED
  uniform sampler2D uNoise;
  uniform vec2 uOriginMod;
  // Base-frame xz (stable across floating-origin moves) for a render-space position.
  vec2 basePos(vec3 p) { return p.xz + uOriginMod; }
  #endif
`;

export const AERIAL_GLSL = /* glsl */ `
  ${NOISE_DECLARATIONS}
  ${SCATTERING_GLSL}
  #ifndef AERIAL_DECLARED
  #define AERIAL_DECLARED
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uHazeColor;
  uniform vec3 uHazeSunColor;
  uniform float uHazeDensity;
  uniform float uHazeHeight;
  uniform float uCameraElevation;
  /** Local vertical at the camera (render space). */
  uniform vec3 uUp;
  uniform float uFogTop;
  uniform float uFogBase;
  /** Extinction per metre inside the fog layer; 0 = no fog. */
  uniform float uFogDensity;
  /** Sunlit top of the fog; the underside and inside are derived from it. */
  uniform vec3 uFogColor;

  float elevationOf(vec3 p) {
    vec3 d = p - cameraPosition;
    float up = dot(d, uUp);
    vec3 horizontal = d - uUp * up;
    // Earth curvature: points far away sit lower.
    return uCameraElevation + up - dot(horizontal, horizontal) / 12742000.0;
  }

  // Length (m) of the straight path from height hc to height hf, total length dist, that lies
  // between uFogBase and uFogTop. Also returns the parameter where the ray enters the top.
  float fogPath(float hc, float hf, float dist, out float tTop) {
    float dh = hf - hc;
    tTop = -1.0;
    if (abs(dh) < 0.01) return (hc > uFogBase && hc < uFogTop) ? dist : 0.0;
    float ta = (uFogBase - hc) / dh;
    float tb = (uFogTop - hc) / dh;
    float t0 = clamp(min(ta, tb), 0.0, 1.0);
    float t1 = clamp(max(ta, tb), 0.0, 1.0);
    if (hc > uFogTop && hf < uFogTop) tTop = tb;
    return (t1 - t0) * dist;
  }

  // Look of the fog where the ray enters it from above: sunlit billows from the noise.
  vec3 fogTopColor(vec3 p) {
    vec2 q = basePos(p);
    // Broad, soft billows: large scales only, the fine one fades out with distance.
    float far = smoothstep(4000.0, 20000.0, length(p - cameraPosition));
    float big = texture2D(uNoise, q / 9000.0).r;
    float mid = texture2D(uNoise, q / 3200.0).r;
    float e = 120.0;
    float hx = texture2D(uNoise, (q + vec2(e, 0.0)) / 3200.0).r - mid;
    float hz = texture2D(uNoise, (q + vec2(0.0, e)) / 3200.0).r - mid;
    vec3 N = normalize(vec3(-hx * 6.0 * (1.0 - far), 1.0, -hz * 6.0 * (1.0 - far)));
    float lit = 0.8 + 0.3 * max(dot(N, uSunDir), 0.0);
    return uFogColor * lit * (0.92 + 0.12 * big + 0.06 * mid * (1.0 - far));
  }

  vec3 aerial(vec3 col, vec3 worldPos, float hf) {
    vec3 toFrag = worldPos - cameraPosition;
    float dist = length(toFrag);
    float hc = uCameraElevation;
    if (uFogDensity > 0.0) {
      // Under the fog the light is dull and grey.
      float under = smoothstep(uFogTop + 10.0, uFogTop - 60.0, hf);
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(lum) * vec3(0.92, 0.95, 1.0) * 0.75, under * 0.45);
      float tTop;
      float len = fogPath(hc, hf, dist, tTop);
      // Soft top: the last metres above the fog are veiled too.
      float skin = smoothstep(uFogTop + 25.0, uFogTop - 5.0, hf) * step(uFogTop, hc);
      float fogAmt = max(1.0 - exp(-len * uFogDensity), skin * 0.35);
      vec3 inside = uFogColor * vec3(0.66, 0.68, 0.72);
      vec3 fogCol = tTop >= 0.0 ? fogTopColor(cameraPosition + toFrag * tTop) : inside;
      col = mix(col, fogCol, fogAmt);
    }
    // Aerial perspective: Rayleigh (blue distance) and Mie (haze, sun glow), physically.
    vec3 T;
    vec3 light = inscatter(toFrag / max(dist, 1.0), dist, hc, hf, uSunDir, dot(uSunDir, uUp), T);
    return col * T + light;
  }
  #endif
`;
