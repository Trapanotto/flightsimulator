import { Species } from './species';

/**
 * Per species, how the near level varies one mesh into many trees:
 *   leaf: share of clusters left out, spread of their size (and of conifer whorls), how far
 *     they shift (crown radii), size of a spray of leaves or needles (metres);
 *   look: height of a cluster against its width, light through the edges, gaps at the edges.
 * Beech: a closed, even dome. Oak: wide, lumpy, gappy. Pine: flat tufts on bare branches.
 */
export const LEAF: Record<Species, [number, number, number, number]> = {
  [Species.Spruce]: [0, 0.14, 0, 0.2],
  [Species.Fir]: [0, 0.1, 0, 0.22],
  [Species.Larch]: [0, 0.16, 0, 0.18],
  [Species.Pine]: [0.25, 0.4, 0.12, 0.24],
  [Species.Beech]: [0.05, 0.28, 0.07, 0.26],
  [Species.Oak]: [0.2, 0.5, 0.16, 0.34],
  [Species.Shrub]: [0.1, 0.4, 0.14, 0.18],
  [Species.Solitary]: [0.08, 0.4, 0.12, 0.3],
};
export const LOOK: Record<Species, [number, number, number]> = {
  [Species.Spruce]: [1, 0.25, 0.8],
  [Species.Fir]: [1, 0.2, 0.7],
  [Species.Larch]: [1, 0.45, 0.9],
  [Species.Pine]: [0.65, 0.35, 0.9],
  [Species.Beech]: [1, 0.6, 0.75],
  [Species.Oak]: [0.85, 0.5, 1],
  [Species.Shrub]: [1, 0.5, 0.8],
  [Species.Solitary]: [0.95, 0.6, 0.85],
};

/**
 * How much colour the eye has lost, 0 .. 1, from the layer's night factor. Under moonlight we
 * see with the rods, which cannot tell colours apart; the terrain's photo colours are muted
 * already, but an autumn crown keeps its saturated albedo and would glow red against a grey
 * night. Not quite all: the tone mapping still shows the last of the dusk's colour.
 */
export function scotopicLoss(night: number): number {
  return 0.85 * Math.min(1, Math.max(0, night));
}
