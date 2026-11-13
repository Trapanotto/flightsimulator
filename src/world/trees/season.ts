import type { Season } from '../layers';
import { SPECIES_COUNT, Species } from './species';

/**
 * Colours of the crowns through the year: linear albedo, before lighting. Summer values are the
 * reference the orthophoto is compared with (photo.ts): a tree whose photo pixel is darker than
 * its species' summer colour stays that much darker in every season, so the photo's own
 * variation (a dark fir among spruce, a sunlit slope) carries through autumn and winter.
 *
 * Calibrated against the terrain's photo-to-albedo mapping: a sunlit Mittelland forest comes
 * out of SWISSIMAGE at about 0.07 to 0.1 luminance there.
 */
type RGB = readonly [number, number, number];

const SUMMER: Record<Species, RGB> = {
  [Species.Spruce]: [0.04, 0.07, 0.04],
  [Species.Fir]: [0.042, 0.078, 0.045],
  [Species.Larch]: [0.075, 0.115, 0.045],
  [Species.Pine]: [0.05, 0.075, 0.042],
  [Species.Beech]: [0.07, 0.115, 0.04],
  [Species.Oak]: [0.065, 0.1, 0.04],
  [Species.Shrub]: [0.07, 0.1, 0.045],
  [Species.Solitary]: [0.075, 0.11, 0.045],
};

/** Leaves shed in winter: broadleaf trees, larch, most shrubs. */
export function deciduous(s: Species): boolean {
  return s !== Species.Spruce && s !== Species.Fir && s !== Species.Pine;
}

/** Fresh May green of new leaves and larch needles. */
const SPRING_LEAF: RGB = [0.11, 0.17, 0.045];

/**
 * Autumn: two ends of a range per species; each tree takes its own point between them, so a
 * beech wood shows rust, orange and late yellow side by side.
 */
const AUTUMN: Partial<Record<Species, readonly [RGB, RGB]>> = {
  [Species.Beech]: [
    [0.26, 0.085, 0.02],
    [0.3, 0.17, 0.03],
  ],
  [Species.Oak]: [
    [0.14, 0.09, 0.03],
    [0.28, 0.22, 0.04],
  ],
  [Species.Larch]: [
    [0.32, 0.21, 0.04],
    [0.27, 0.15, 0.03],
  ],
  [Species.Shrub]: [
    [0.22, 0.1, 0.03],
    [0.11, 0.12, 0.04],
  ],
  [Species.Solitary]: [
    [0.26, 0.14, 0.03],
    [0.1, 0.12, 0.045],
  ],
};

/** Bare twigs and branches seen as a mass: grey-brown. */
const TWIGS: RGB = [0.075, 0.062, 0.05];

/** Floats per species in a palette: colour A (rgb), bareness, colour B (rgb), spare. */
export const PALETTE_STRIDE = 8;

/** The summer colour of a species: what the photo is measured against. */
export function summerColor(s: Species): RGB {
  return SUMMER[s];
}

/**
 * The crown palette of a season: per species two colours (each tree mixes them by its own
 * seed) and how bare the crown is (0 in leaf .. 1 leafless).
 */
export function seasonPalette(season: Season): Float32Array {
  const out = new Float32Array(SPECIES_COUNT * PALETTE_STRIDE);
  for (let s = 0; s < SPECIES_COUNT; s++) {
    const summer = SUMMER[s as Species];
    let a: RGB = summer;
    let b: RGB = summer;
    let bare = 0;
    const leafy = deciduous(s);
    if (season === 'spring') {
      if (leafy) {
        // Not every tree is equally far: some still carry the summer-dark green of last year.
        a = SPRING_LEAF;
        b = mixRGB(SPRING_LEAF, summer, 0.45);
      } else {
        // New shoots lighten the conifers a little.
        a = b = scaleRGB(summer, [1.03, 1.08, 1.0]);
      }
    } else if (season === 'autumn') {
      const range = AUTUMN[s as Species];
      if (range) [a, b] = range;
    } else if (season === 'winter') {
      if (leafy) {
        a = b = TWIGS;
        bare = 1;
      } else {
        // Winter needles are darker and duller.
        a = b = scaleRGB(summer, [0.92, 0.85, 0.9]);
      }
    }
    const o = s * PALETTE_STRIDE;
    out.set(a, o);
    out[o + 3] = bare;
    out.set(b, o + 4);
  }
  return out;
}

/** Linear blend of two palettes (a smooth change when the season is switched). */
export function mixPalettes(
  a: Float32Array,
  b: Float32Array,
  t: number,
  out = new Float32Array(a.length),
) {
  for (let i = 0; i < a.length; i++) out[i] = a[i]! + (b[i]! - a[i]!) * t;
  return out;
}

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scaleRGB(a: RGB, s: RGB): RGB {
  return [a[0] * s[0], a[1] * s[1], a[2] * s[2]];
}
