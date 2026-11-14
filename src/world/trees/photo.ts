/**
 * The orthophoto as the trees see it. Every tree takes the colour of the SWISSIMAGE pixels it
 * stands on, mapped to albedo exactly as the terrain maps the photo (terrain/terrainMaterial.ts,
 * "Photo -> albedo"), so that where the trees fade out they have the colour of the ground that
 * replaces them. Keep the two in step if the terrain's curve changes.
 */

/** sRGB byte to linear. */
export function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const GAIN = 2.6;
const SHADOW_LIFT = 0.7;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Linear photo colour -> albedo: a soft compressive curve on luminance (dark and mid tones gain
 * about 2.5x), the darkest baked shadows lifted a little, hue kept. Writes into `out`.
 */
export function photoToAlbedo(r: number, g: number, b: number, out: number[] | Float32Array) {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const mapped = (lum * GAIN) / ((lum * (GAIN - 1)) / 0.9 + 1);
  const deep = (1 - smooth(0.004, 0.03, lum)) * SHADOW_LIFT;
  const lifted = mapped + (Math.max(mapped, 0.06) - mapped) * deep;
  const k = lifted / Math.max(lum, 1e-4);
  out[0] = Math.min(r * k, 0.92);
  out[1] = Math.min(g * k, 0.92);
  out[2] = Math.min(b * k, 0.92);
  return out;
}

export const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
