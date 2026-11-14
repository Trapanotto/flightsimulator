/**
 * Which trees grow where, and how big: a coarse model of Swiss forests after the national forest
 * inventory (LFI). Broadleaf trees (beech, with oak, ash and maple) dominate the Mittelland
 * below about 600 m; beech, fir and spruce mix up to about 1200 m; spruce rules the montane
 * and subalpine belts; larch and stone pine take over towards the tree line, which lies near
 * 1900 m on the northern Prealps and up to 2300 m in the dry inner Alps (Valais, Engadin).
 */

export enum Species {
  Spruce = 0,
  Fir = 1,
  Larch = 2,
  Pine = 3,
  Beech = 4,
  Oak = 5,
  Shrub = 6,
  Solitary = 7,
}
export const SPECIES_COUNT = 8;

/** Geometry family: tiered conifer, or a crown of leafy lumps (broadleaf, pine, shrubs). */
export enum Form {
  Conifer = 0,
  Broadleaf = 1,
}
export const FORM_COUNT = 2;

export function formOf(s: Species): Form {
  return s === Species.Spruce || s === Species.Fir || s === Species.Larch
    ? Form.Conifer
    : Form.Broadleaf;
}

/** What the vector tiles say grows at a place. */
export enum Cover {
  None = 0,
  Forest = 1,
  /** Open forest, pasture woods (subclass loose_forest). */
  Loose = 2,
  /** Groves, hedges and woods along rivers (woody_plant). */
  Woody = 3,
  /** Brush: green alder, mountain pine, hazel (scrub). */
  Scrub = 4,
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The tree line in metres above sea level. The continental inner Alps are drier and sunnier, so
 * forest climbs higher there; a smooth bump over Valais and over Engadin and the southern
 * Grisons valleys stands in for the real, much more detailed pattern.
 */
export function treeLine(lon: number, lat: number): number {
  const bump = (lon0: number, lat0: number, rx: number, ry: number) => {
    const dx = (lon - lon0) / rx;
    const dy = (lat - lat0) / ry;
    return Math.exp(-(dx * dx + dy * dy));
  };
  const valais = bump(7.55, 46.2, 0.7, 0.18);
  const engadin = bump(9.9, 46.55, 0.6, 0.3);
  return 1950 + 300 * Math.max(valais, engadin);
}

/**
 * Relative weights of the species at an elevation (m above sea level) for a land cover, before
 * the photo is consulted. Returned as a fresh array indexed by Species.
 */
export function speciesWeights(cover: Cover, elevation: number, line: number): number[] {
  const w = new Array<number>(SPECIES_COUNT).fill(0);
  if (cover === Cover.Scrub) {
    w[Species.Shrub] = 1;
    return w;
  }
  // Belts relative to the tree line where that matters, absolute in the lowlands.
  const low = 1 - smooth(450, 900, elevation); // colline: broadleaf country
  const montane = smooth(450, 900, elevation) * (1 - smooth(1150, 1450, elevation));
  const subalpine = smooth(1150, 1450, elevation) * (1 - smooth(line - 350, line - 150, elevation));
  const top = smooth(line - 350, line - 150, elevation);
  w[Species.Beech] = 0.5 * low + 0.35 * montane + 0.02 * subalpine;
  w[Species.Oak] = 0.25 * low + 0.06 * montane + 0.03 * subalpine;
  w[Species.Spruce] = 0.15 * low + 0.33 * montane + 0.72 * subalpine + 0.25 * top;
  w[Species.Fir] = 0.06 * low + 0.24 * montane + 0.08 * subalpine;
  w[Species.Larch] = 0.01 * low + 0.02 * montane + 0.12 * subalpine + 0.4 * top;
  w[Species.Pine] = 0.03 * low + 0.03 * subalpine + 0.35 * top;
  if (cover === Cover.Woody) {
    // Groves and hedges are broadleaf trees and bushes below the subalpine belt.
    const lowland = 1 - smooth(1100, 1500, elevation);
    w[Species.Beech] = w[Species.Beech]! * (1 - lowland) + 0.25 * lowland;
    w[Species.Oak] = w[Species.Oak]! * (1 - lowland) + 0.45 * lowland;
    w[Species.Spruce] = w[Species.Spruce]! * (1 - 0.7 * lowland);
    w[Species.Fir] = w[Species.Fir]! * (1 - 0.9 * lowland);
    w[Species.Shrub] = 0.25 * lowland + 0.1;
  }
  if (cover === Cover.Loose) {
    // Pasture woods: larch meadows high up, scattered spruce lower down.
    w[Species.Larch] = w[Species.Larch]! * 2 + 0.1 * subalpine;
  }
  return w;
}

/**
 * Picks a species. `u` is uniform in [0, 1). `darkness` (-1 light .. 1 dark) is how much darker
 * the orthophoto is under the tree than the forest around it: in the summer photos spruce and
 * fir stands are clearly darker than beech, so the photo tilts the odds towards what is
 * actually there without overriding the belts.
 */
export function pickSpecies(weights: readonly number[], u: number, darkness = 0): Species {
  const tilt = Math.exp(1.8 * Math.max(-1, Math.min(1, darkness)));
  let total = 0;
  const adj = weights.map((w, s) => {
    const conifer = formOf(s) === Form.Conifer || s === Species.Pine;
    const v = w * (s === Species.Shrub ? 1 : conifer ? tilt : 1 / tilt);
    total += v;
    return v;
  });
  if (total <= 0) return Species.Spruce;
  let acc = 0;
  const target = u * total;
  for (let s = 0; s < adj.length; s++) {
    acc += adj[s]!;
    if (target < acc) return s;
  }
  return adj.length - 1;
}

/** Mature height (m) of each species in good lowland conditions, and crown width / height. */
const SIZE: Record<Species, { height: number; width: number }> = {
  [Species.Spruce]: { height: 28, width: 0.36 },
  [Species.Fir]: { height: 28, width: 0.4 },
  [Species.Larch]: { height: 26, width: 0.4 },
  [Species.Pine]: { height: 17, width: 0.42 },
  [Species.Beech]: { height: 27, width: 0.55 },
  [Species.Oak]: { height: 24, width: 0.62 },
  [Species.Shrub]: { height: 3.5, width: 1.0 },
  [Species.Solitary]: { height: 13, width: 0.8 },
};

export interface TreeSize {
  /** Metres from the ground to the top. */
  height: number;
  /** Crown diameter, metres. */
  width: number;
}

/**
 * Size of one tree. `u1`, `u2` uniform in [0, 1): the spread of a stand (young and old trees,
 * suppressed and dominant ones). Trees shrink towards the tree line, where they stand
 * stunted and wide apart; nothing grows above it.
 */
export function treeSize(
  s: Species,
  elevation: number,
  line: number,
  u1: number,
  u2: number,
): TreeSize {
  const base = SIZE[s];
  // Montane stands are still tall; the last 500 m below the line bring them down to a third.
  const vigour = 1 - 0.65 * smooth(line - 600, line + 50, elevation);
  // Most trees of a stand are close to the canopy height, a few are much smaller.
  const spread = 0.55 + 0.6 * Math.pow(u1, 0.6);
  const height = Math.max(1.2, base.height * vigour * spread);
  const width = height * base.width * (0.8 + 0.4 * u2);
  return { height, width };
}

/** Highest elevation (m) at which a tree is placed: the line plus a little ragged fringe. */
export const aboveTreeLine = (elevation: number, line: number) => elevation > line + 120;
