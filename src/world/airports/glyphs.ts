/**
 * Runway designator characters (digits, L, R, C) as block shapes in the proportions of
 * ICAO Annex 14, figure 5-3: 9 m high, 3 m wide, strokes about 0.9 m. Baked once into a signed
 * distance atlas, so the shader draws them razor sharp however close the camera comes (a
 * distance field interpolates linearly; only corners round off, by a texel).
 * Pure function: no renderer.
 */
import { GLYPH_HEIGHT, GLYPH_WIDTH } from './layout';

/** A convex polygon in glyph metres (x right, y up from the baseline), counter-clockwise. */
type Poly = Array<[number, number]>;

const S = 0.9; // stroke
const W = GLYPH_WIDTH;
const H = GLYPH_HEIGHT;
const M = H / 2; // middle bar centre
const rect = (x0: number, y0: number, x1: number, y1: number): Poly => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const top = rect(0, H - S, W, H);
const bottom = rect(0, 0, W, S);
const mid = rect(0, M - S / 2, W, M + S / 2);
const leftFull = rect(0, 0, S, H);
const rightFull = rect(W - S, 0, W, H);
const leftUpper = rect(0, M - S / 2, S, H);
const leftLower = rect(0, 0, S, M + S / 2);
const rightUpper = rect(W - S, M - S / 2, W, H);
const rightLower = rect(W - S, 0, W, M + S / 2);

/** Glyph shapes in atlas order: 0..9, L, R, C. */
export const GLYPH_SHAPES: Poly[][] = [
  [leftFull, rightFull, top, bottom], // 0
  [rect(W / 2 - S / 2, 0, W / 2 + S / 2, H), rect(W / 2 - 1.3, H - S, W / 2, H)], // 1
  [top, rightUpper, mid, leftLower, bottom], // 2
  [top, rightFull, rect(0.6, M - S / 2, W, M + S / 2), bottom], // 3
  [leftUpper, mid, rightFull], // 4
  [top, leftUpper, mid, rightLower, bottom], // 5
  [top, leftFull, mid, rightLower, bottom], // 6
  [top, rightFull], // 7
  [leftFull, rightFull, top, mid, bottom], // 8
  [top, leftUpper, mid, rightFull, bottom], // 9
  [leftFull, bottom], // L
  [
    leftFull,
    top,
    rightUpper,
    mid,
    // The leg: from the middle bar down to the bottom right corner.
    [
      [W - S * 1.1 - 0.9, M - S / 2],
      [W - S * 1.1 + 0.25, M - S / 2],
      [W, 0],
      [W - S * 1.2, 0],
    ],
  ], // R
  [top, leftFull, bottom], // C
];

export const GLYPH_COUNT = GLYPH_SHAPES.length;
/** Atlas texels per metre. */
export const ATLAS_RES = 16;
/** Free border around each glyph (metres): room for the distance field to fall off. */
export const ATLAS_PAD = 1;
/** Distances are stored for -RANGE..RANGE metres. */
export const ATLAS_RANGE = 1;
export const CELL_W = (W + 2 * ATLAS_PAD) * ATLAS_RES;
export const CELL_H = (H + 2 * ATLAS_PAD) * ATLAS_RES;

/** Signed distance from p to a convex polygon (negative inside). */
function polyDistance(px: number, py: number, poly: Poly): number {
  let inside = true;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[(i + 1) % poly.length]!;
    const ex = bx - ax;
    const ey = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    // Counter-clockwise: the inside is to the left of every edge.
    if (ex * wy - ey * wx < 0) inside = false;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(wx - ex * t, wy - ey * t));
  }
  return inside ? -best : best;
}

/** Signed distance from glyph metres (x, y) to the glyph (union of its shapes). */
export function glyphDistance(glyph: number, x: number, y: number): number {
  let d = Infinity;
  for (const poly of GLYPH_SHAPES[glyph]!) d = Math.min(d, polyDistance(x, y, poly));
  return d;
}

/**
 * The atlas: GLYPH_COUNT cells side by side, one byte per texel: 255 = RANGE metres inside the
 * glyph, about 128 on its outline, 0 = RANGE metres outside. Row 0 is the bottom (y = -PAD),
 * so the texture's v grows upwards like the glyph's y.
 */
export function buildGlyphAtlas(): { data: Uint8Array; width: number; height: number } {
  const width = CELL_W * GLYPH_COUNT;
  const height = CELL_H;
  const data = new Uint8Array(width * height);
  for (let g = 0; g < GLYPH_COUNT; g++)
    for (let j = 0; j < CELL_H; j++)
      for (let i = 0; i < CELL_W; i++) {
        const x = (i + 0.5) / ATLAS_RES - ATLAS_PAD;
        const y = (j + 0.5) / ATLAS_RES - ATLAS_PAD;
        const d = glyphDistance(g, x, y);
        const v = 0.5 - d / (2 * ATLAS_RANGE);
        data[j * width + g * CELL_W + i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
      }
  return { data, width, height };
}
