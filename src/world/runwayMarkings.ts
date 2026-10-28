import {
  CanvasTexture,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  type Texture,
  Vector3,
  Vector4,
} from 'three';
import { RUNWAYS, type Runway, distanceM } from '../game/airports';

/**
 * Runways painted into the terrain shader: asphalt with fine grain and tyre marks, and the
 * ICAO Annex 14 markings (threshold stripes, designators, centre line, aiming point, touchdown
 * zone, edge lines). Computed per pixel from the runway's own coordinates, so they stay sharp
 * however close the camera is – the orthophoto alone is ~10–40 cm per pixel. Being part of the
 * terrain surface they never float above or sink into it.
 */

export const MAX_RUNWAYS = 8;

const vec3s = () => Array.from({ length: MAX_RUNWAYS }, () => new Vector3());
const vec4s = () => Array.from({ length: MAX_RUNWAYS }, () => new Vector4());

/** Shared by all terrain tiles (one shader program). */
export const runwayUniforms = {
  uRwyCount: { value: 0 },
  /** Threshold of the start end, render coordinates. */
  uRwyStart: { value: vec3s() },
  /** Unit vector along the runway (start -> far end) and to its right, render coordinates. */
  uRwyDir: { value: vec3s() },
  uRwySide: { value: vec3s() },
  /** length, width, aiming point distance, threshold stripes per side (m, m, m, count). */
  uRwySize: { value: vec4s() },
  /** Designator digits: start end tens, ones; far end tens, ones. */
  uRwyDigits: { value: vec4s() },
  uRwyDigitMap: { value: null as Texture | null },
};

/** Designator of the opposite end: 32 -> 14, 01 -> 19. */
export function oppositeIdent(ident: string): string {
  const n = parseInt(ident, 10);
  const o = ((n + 18 - 1) % 36) + 1;
  return String(o).padStart(2, '0');
}

/** ICAO: 4 stripes on an 18 m runway up to 16 on 60 m – stripes 1.8 m wide, 1.8 m apart. */
export function thresholdStripesPerSide(width: number): number {
  return Math.max(2, Math.round((width / 2 - 1.8) / 3.6));
}

/** Aiming point marking distance from the threshold (ICAO table 5-1). */
export function aimingPointDistance(length: number): number {
  return length >= 2400 ? 400 : length >= 1200 ? 300 : 250;
}

/** Digits 0–9 side by side, white on black (red channel), for the designators. */
function makeDigitMap(): Texture {
  const cw = 128;
  const ch = 256;
  const canvas = document.createElement('canvas');
  canvas.width = cw * 10;
  canvas.height = ch;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  // Tall, narrow digits like the runway font (9 m high, 3 m wide), filling their cell.
  g.font = 'bold 300px Arial, Helvetica, sans-serif';
  for (let d = 0; d < 10; d++) {
    const m = g.measureText(String(d));
    const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    const sy = (ch * 0.94) / h;
    const sx = Math.min((cw * 0.9) / w, sy * 0.75);
    g.save();
    g.translate(d * cw + cw / 2, ch / 2);
    g.scale(sx, sy);
    g.fillText(
      String(d),
      (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2,
      h / 2 - m.actualBoundingBoxDescent,
    );
    g.restore();
  }
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  return tex;
}

interface GeoWorld {
  fromGeo(lon: number, lat: number, h: number): Vector3;
  upAt(p: Vector3, out: Vector3): Vector3;
}

const up = new Vector3();

/**
 * Places the runways in render coordinates (call every frame: the floating origin moves).
 * Cheap: two coordinate conversions per runway.
 */
export function updateRunways(world: GeoWorld, runways: Runway[] = RUNWAYS) {
  const u = runwayUniforms;
  u.uRwyDigitMap.value ??= makeDigitMap();
  const n = Math.min(runways.length, MAX_RUNWAYS);
  u.uRwyCount.value = n;
  for (let i = 0; i < n; i++) {
    const r = runways[i]!;
    // Height does not matter: the shader measures along the tangent plane.
    const a = world.fromGeo(r.from.lon, r.from.lat, 500);
    const b = world.fromGeo(r.to.lon, r.to.lat, 500);
    world.upAt(a, up);
    const dir = b.sub(a);
    dir.addScaledVector(up, -dir.dot(up)).normalize();
    u.uRwyStart.value[i]!.copy(a);
    u.uRwyDir.value[i]!.copy(dir);
    u.uRwySide.value[i]!.crossVectors(dir, up).normalize();
    const length = distanceM(r.from, r.to);
    u.uRwySize.value[i]!.set(
      length,
      r.widthM,
      aimingPointDistance(length),
      thresholdStripesPerSide(r.widthM),
    );
    const far = oppositeIdent(r.ident);
    u.uRwyDigits.value[i]!.set(+r.ident[0]!, +r.ident[1]!, +far[0]!, +far[1]!);
  }
}

/** GLSL: declarations for the terrain fragment shader. */
export const RUNWAY_DECLARATIONS = /* glsl */ `
  uniform int uRwyCount;
  uniform vec3 uRwyStart[${MAX_RUNWAYS}];
  uniform vec3 uRwyDir[${MAX_RUNWAYS}];
  uniform vec3 uRwySide[${MAX_RUNWAYS}];
  uniform vec4 uRwySize[${MAX_RUNWAYS}];
  uniform vec4 uRwyDigits[${MAX_RUNWAYS}];
  uniform sampler2D uRwyDigitMap;

  // Coverage of [lo, hi] at x, antialiased over the pixel footprint w.
  float rwyBox(float x, float lo, float hi, float w) {
    return clamp((min(x - lo, hi - x)) / w + 0.5, 0.0, 1.0) * step(lo - w, x) * step(x, hi + w);
  }

  // Markings seen from one end: a = metres from that threshold, s = metres right of the centre
  // line (looking down the runway). Returns paint coverage 0..1.
  float rwyEndMarkings(float a, float s, float L, float W, float aim, float stripes,
                       float tens, float ones, vec2 fw) {
    float paint = 0.0;
    float as = abs(s);
    // Threshold stripes: 30 m long, 6 m from the threshold, 1.8 m wide with 1.8 m gaps.
    if (a < 40.0) {
      float k = floor((as - 1.8) / 3.6);
      float x = as - 1.8 - k * 3.6;
      float stripe = (k >= 0.0 && k < stripes) ? rwyBox(x, 0.0, 1.8, fw.y) : 0.0;
      paint = max(paint, stripe * rwyBox(a, 6.0, 36.0, fw.x));
    }
    // Designator: two digits, 9 m tall, 3 m wide, 12 m past the stripes.
    if (a > 46.0 && a < 59.0 && as < 4.5) {
      float v = (a - 48.0) / 9.0;
      float d = s < 0.0 ? tens : ones;
      float x0 = s < 0.0 ? -3.9 : 0.9;
      float u = (s - x0) / 3.0;
      if (u > 0.0 && u < 1.0 && v > 0.0 && v < 1.0)
        paint = max(paint, smoothstep(0.35, 0.65, texture2D(uRwyDigitMap, vec2((d + u) / 10.0, v)).r));
    }
    // Aiming point: two broad bars, 45 m long.
    float inner = W >= 45.0 ? 10.0 : 4.5;
    float bar = W >= 45.0 ? 9.0 : 4.0;
    paint = max(paint, rwyBox(a, aim, aim + 45.0, fw.x) * rwyBox(as, inner, inner + bar, fw.y));
    // Touchdown zone: pairs of 3, 3, 2, 2, 1, 1 stripes every 150 m (long runways only).
    if (L >= 1500.0 && a > 140.0 && a < 930.0) {
      float k = floor(a / 150.0);
      float start = k * 150.0;
      float n = k <= 2.0 ? 3.0 : (k <= 4.0 ? 2.0 : 1.0);
      if (abs(start - aim) > 60.0 && start + 22.5 < L * 0.5) {
        float j = floor((as - inner) / 3.3);
        float x = as - inner - j * 3.3;
        float stripe = (j >= 0.0 && j < n) ? rwyBox(x, 0.0, 1.8, fw.y) : 0.0;
        paint = max(paint, stripe * rwyBox(a, start, start + 22.5, fw.x));
      }
    }
    return paint;
  }
`;

/**
 * GLSL for the map_fragment block (after `c` holds the terrain colour): asphalt and paint
 * on runways. Needs vWorldPos, uNoise and basePos().
 */
export const RUNWAY_FRAGMENT = /* glsl */ `
  for (int i = 0; i < ${MAX_RUNWAYS}; i++) {
    if (i >= uRwyCount) break;
    vec3 d = vWorldPos - uRwyStart[i];
    float a = dot(d, uRwyDir[i]);
    float s = dot(d, uRwySide[i]);
    vec4 sz = uRwySize[i];
    float L = sz.x;
    float W = sz.y;
    if (a < -2.0 || a > L + 2.0 || abs(s) > W * 0.5 + 1.0) continue;
    vec2 fw = max(vec2(fwidth(a), fwidth(s)), vec2(0.02));
    float pave = rwyBox(a, 0.0, L, fw.x) * rwyBox(s, -W * 0.5, W * 0.5, fw.y);
    // Asphalt: grain at centimetre scale, patches, streaks along the runway.
    vec2 q = vec2(a, s);
    float grain = texture2D(uNoise, q / 0.45).r * 0.5 + texture2D(uNoise, q / 2.3).r * 0.5;
    float patches = texture2D(uNoise, q / vec2(140.0, 22.0)).r;
    vec3 asphalt = vec3(0.155, 0.158, 0.165) * (0.82 + 0.3 * grain) * (0.85 + 0.3 * patches);
    // Rubber from touchdowns: dark tracks either side of the centre line near both ends.
    float tz = max(1.0 - smoothstep(200.0, 900.0, a), 1.0 - smoothstep(200.0, 900.0, L - a));
    float tracks = smoothstep(9.0, 2.0, abs(s)) * tz * (0.4 + 0.6 * texture2D(uNoise, q / vec2(30.0, 1.6)).r);
    asphalt *= 1.0 - 0.55 * tracks;
    // Paint from both ends, centre line, edge lines.
    float paint = max(
      rwyEndMarkings(a, s, L, W, sz.z, sz.w, uRwyDigits[i].x, uRwyDigits[i].y, fw),
      rwyEndMarkings(L - a, -s, L, W, sz.z, sz.w, uRwyDigits[i].z, uRwyDigits[i].w, fw));
    float cl = mod(a - 69.0, 50.0);
    paint = max(paint, rwyBox(s, -0.45, 0.45, fw.y) * rwyBox(cl, 0.0, 30.0, fw.x)
      * step(69.0, a) * step(a, L - 69.0));
    if (W >= 30.0) paint = max(paint, rwyBox(abs(s), W * 0.5 - 0.9, W * 0.5, fw.y) * rwyBox(a, 0.0, L, fw.x));
    // Worn paint: grain and rubber show through.
    paint *= (0.75 + 0.25 * grain) * (1.0 - 0.6 * tracks);
    vec3 surface = mix(asphalt, vec3(0.78, 0.79, 0.8), paint);
    c = mix(c, surface, pave);
  }
`;
