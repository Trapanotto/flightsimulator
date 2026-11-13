/**
 * The maths of the seasonal ground: snow cover and the colour changes of the land below the
 * snow. Written once against a tiny arithmetic interface (Ops) so the very same code builds the
 * shader (with TSL nodes, see terrainMaterial.ts) and runs on the CPU (with numbers, for tests
 * and for anything that needs to know whether snow lies somewhere). No three.js here.
 */

/** Arithmetic on scalars of type T: plain numbers on the CPU, shader nodes on the GPU. */
export interface Ops<T> {
  k(v: number): T;
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  mul(a: T, b: T): T;
  div(a: T, b: T): T;
  min(a: T, b: T): T;
  max(a: T, b: T): T;
  clamp(x: T, lo: number, hi: number): T;
  /** Hermite step from e0 to e1 (e0 > e1 gives a falling step), like GLSL smoothstep. */
  smooth(e0: number, e1: number, x: T): T;
  mix(a: T, b: T, t: T): T;
}

export type RGB<T> = [T, T, T];

const smoothNumber = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const numberOps: Ops<number> = {
  k: (v) => v,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  min: Math.min,
  max: Math.max,
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  smooth: smoothNumber,
  mix: (a, b, t) => a + (b - a) * t,
};

// ---- Snow ----

/**
 * The snow line of the orthophotos: SWISSIMAGE is flown in summer, its own snow and glaciers
 * lie above about this height. A season whose snow line is at or above it adds nothing.
 */
export const PHOTO_SNOW_LINE = 2900;

/** How much of the computed snow cover is shown: 0 for the summer of the photos, 1 below. */
export function seasonSnowAmount(snowLine: number): number {
  return smoothNumber(PHOTO_SNOW_LINE, PHOTO_SNOW_LINE - 300, snowLine);
}

/** What the snow cover at a point depends on. */
export interface SnowSite<T> {
  /** Height above sea level, metres. */
  elevation: T;
  /** Snow line, metres above sea level. */
  snowLine: T;
  /** Cosine of the slope angle (normal · up): 1 flat, 0 vertical. */
  up: T;
  /** -1 facing south .. 1 facing north, scaled by how steep the slope is. */
  north: T;
  /** 0 open ground .. 1 deep hollow or gully (from the sky-view factor). */
  hollow: T;
  /** Large-scale noise, -1..1 (hundreds of metres): makes the line ragged. */
  noiseLine: T;
  /** Patch-scale noise, -1..1 (tens of metres): breaks the transition into patches. */
  noisePatch: T;
}

/** Metres over which the snow goes from first patches to closed cover. */
export const SNOW_BAND = 320;

/**
 * Snow cover 0..1 and how deep it lies (0 thin .. 1 deep, hides the ground's texture).
 *
 * The line is moved down on north faces and in hollows (less sun, drifted snow) and up on
 * south faces, then frayed by large-scale noise so that it never runs along a contour. Steep
 * ground sheds snow: nothing on cliffs steeper than about 55°, full cover below 35°. Inside
 * the band the cover breaks into patches by the patch noise.
 */
export function snowCover<T>(o: Ops<T>, s: SnowSite<T>): { cover: T; depth: T } {
  const line = o.add(
    o.sub(s.snowLine, o.add(o.mul(s.north, o.k(180)), o.mul(s.hollow, o.k(120)))),
    o.mul(s.noiseLine, o.k(200)),
  );
  const above = o.div(o.sub(s.elevation, line), o.k(SNOW_BAND));
  // Steeper ground holds less: from 33° (cos 0.84) the line climbs, and cliffs steeper than
  // 60° (cos 0.5) stay bare at any height; at 50° (cos 0.64) snow sticks again.
  const holds = o.smooth(0.53, 0.84, s.up);
  const sticks = o.smooth(0.5, 0.64, s.up);
  const potential = o.sub(
    o.add(above, o.mul(s.hollow, o.k(0.6))),
    o.mul(o.sub(o.k(1), holds), o.k(1.5)),
  );
  const cover = o.mul(
    o.smooth(-0.45, 0.45, o.add(potential, o.mul(s.noisePatch, o.k(0.6)))),
    sticks,
  );
  const depth = o.mul(o.smooth(0.2, 1.6, potential), sticks);
  return { cover, depth };
}

// ---- Season colours of the land below the snow ----

/** Share of each season in the look (summer is what is left: the photos as they are). */
export interface SeasonWeights<T> {
  spring: T;
  autumn: T;
  winter: T;
}

/** What a pixel shows, 0..1 each. */
export interface GroundClass<T> {
  /** Green vegetation (meadow, crops, gardens, canopy). */
  veg: T;
  /** Forest canopy. */
  forest: T;
  /** Of the forest: broadleaf (turns colour, loses its leaves) rather than conifer. */
  broadleaf: T;
  /** Of the forest: larch near the tree line (turns gold, then bare). */
  larch: T;
  /** Bare or ripe fields (brown, yellow soil and stubble). */
  soil: T;
}

/** Noise -1..1 at the scale of a tree crown and of a patch of land. */
export interface SeasonNoise<T> {
  crown: T;
  patch: T;
}

const luma = <T>(o: Ops<T>, c: RGB<T>) =>
  o.add(o.add(o.mul(c[0], o.k(0.2126)), o.mul(c[1], o.k(0.7152))), o.mul(c[2], o.k(0.0722)));

/** A colour with the hue of `tint` (linear RGB) and luminance `lum`. */
function tinted<T>(o: Ops<T>, tint: [number, number, number], lum: T): RGB<T> {
  const l = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2];
  return [o.mul(lum, o.k(tint[0] / l)), o.mul(lum, o.k(tint[1] / l)), o.mul(lum, o.k(tint[2] / l))];
}

const mixRGB = <T>(o: Ops<T>, a: RGB<T>, b: RGB<T>, t: T): RGB<T> => [
  o.mix(a[0], b[0], t),
  o.mix(a[1], b[1], t),
  o.mix(a[2], b[2], t),
];

// Linear-RGB hues of the seasonal ground, from photographs of the Swiss lowlands and Alps.
const AUTUMN_GRASS: [number, number, number] = [0.42, 0.33, 0.12];
const WINTER_GRASS: [number, number, number] = [0.25, 0.27, 0.16];
const SPRING_GRASS: [number, number, number] = [0.2, 0.38, 0.05];
const LEAF_YELLOW: [number, number, number] = [0.55, 0.42, 0.08];
const LEAF_ORANGE: [number, number, number] = [0.55, 0.27, 0.05];
const LEAF_RUST: [number, number, number] = [0.4, 0.17, 0.07];
const LARCH_GOLD: [number, number, number] = [0.6, 0.4, 0.06];
const BARE_WOOD: [number, number, number] = [0.3, 0.26, 0.23];
const SPRING_LEAF: [number, number, number] = [0.22, 0.42, 0.06];
const WINTER_SOIL: [number, number, number] = [0.3, 0.26, 0.21];

/**
 * The ground of a season from the summer orthophoto. Every change is weighted by what the
 * pixel shows (roofs, roads, rock and water keep their colour) and by noise, so the land turns
 * patch by patch and tree by tree instead of like a filter. With all weights 0 (summer) the
 * colour comes back unchanged, exactly.
 */
export function seasonColor<T>(
  o: Ops<T>,
  rgb: RGB<T>,
  c: GroundClass<T>,
  w: SeasonWeights<T>,
  n: SeasonNoise<T>,
): RGB<T> {
  const one = o.k(1);
  const lum = luma(o, rgb);
  const patch01 = o.add(o.mul(n.patch, o.k(0.5)), o.k(0.5));
  const crown01 = o.clamp(o.add(o.mul(n.crown, o.k(0.6)), o.k(0.5)), 0, 1);

  // Open land: meadows and green crops.
  const open = o.mul(c.veg, o.sub(one, c.forest));
  const autumnGrass = tinted(o, AUTUMN_GRASS, o.mul(lum, o.k(1.05)));
  const winterGrass = tinted(o, WINTER_GRASS, lum);
  const springGrass = tinted(o, SPRING_GRASS, o.mul(lum, o.k(1.12)));
  let land = rgb;
  land = mixRGB(o, land, springGrass, o.mul(w.spring, o.add(o.k(0.45), o.mul(patch01, o.k(0.4)))));
  land = mixRGB(o, land, autumnGrass, o.mul(w.autumn, o.add(o.k(0.2), o.mul(patch01, o.k(0.45)))));
  land = mixRGB(o, land, winterGrass, o.mul(w.winter, o.add(o.k(0.45), o.mul(patch01, o.k(0.3)))));
  // Bare and ripe fields: ploughed and darker in autumn, grey-brown in winter, a green haze of
  // sprouting crops on some of them in spring.
  const soilAutumn = [
    o.mul(rgb[0], o.k(0.8)),
    o.mul(rgb[1], o.k(0.74)),
    o.mul(rgb[2], o.k(0.7)),
  ] as RGB<T>;
  const soilWinter = tinted(o, WINTER_SOIL, o.mul(lum, o.k(0.95)));
  const soilSpring = tinted(o, SPRING_GRASS, lum);
  let soil = rgb;
  soil = mixRGB(
    o,
    soil,
    soilSpring,
    o.mul(w.spring, o.mul(o.smooth(0.55, 0.85, patch01), o.k(0.6))),
  );
  soil = mixRGB(o, soil, soilAutumn, o.mul(w.autumn, patch01));
  soil = mixRGB(o, soil, soilWinter, o.mul(w.winter, o.k(0.7)));

  // Broadleaf canopy: autumn colours tree by tree (some still green), bare in winter, fresh
  // light green in spring.
  const yo = mixRGB(
    o,
    tinted(o, LEAF_YELLOW, one),
    tinted(o, LEAF_ORANGE, one),
    o.smooth(0.25, 0.65, crown01),
  );
  const leaf = mixRGB(o, yo, tinted(o, LEAF_RUST, one), o.smooth(0.65, 0.95, crown01));
  const leafLum = o.mul(lum, o.k(1.3));
  const autumnLeaf: RGB<T> = [
    o.mul(leaf[0], leafLum),
    o.mul(leaf[1], leafLum),
    o.mul(leaf[2], leafLum),
  ];
  const stillGreen = o.smooth(0.25, -0.35, n.patch);
  const bare = tinted(o, BARE_WOOD, o.max(o.mul(lum, o.k(1.2)), o.k(0.035)));
  const springLeaf = tinted(o, SPRING_LEAF, o.mul(lum, o.k(1.25)));
  let broad = rgb;
  broad = mixRGB(o, broad, springLeaf, o.mul(w.spring, o.k(0.75)));
  // Stands and single trees turn at their own pace: some patches and crowns are still green.
  const turned = o.mul(
    o.sub(one, o.mul(stillGreen, o.k(0.75))),
    o.add(o.k(0.45), o.mul(o.smooth(0.1, 0.45, crown01), o.k(0.4))),
  );
  broad = mixRGB(o, broad, autumnLeaf, o.mul(w.autumn, turned));
  broad = mixRGB(o, broad, bare, o.mul(w.winter, o.k(0.85)));
  // Larch: gold in autumn, bare in winter, pale green in spring.
  const gold = tinted(o, LARCH_GOLD, o.mul(lum, o.k(1.5)));
  let larch = rgb;
  larch = mixRGB(o, larch, springLeaf, o.mul(w.spring, o.k(0.5)));
  larch = mixRGB(o, larch, gold, o.mul(w.autumn, o.k(0.85)));
  larch = mixRGB(o, larch, bare, o.mul(w.winter, o.k(0.8)));
  // Conifers stay; a little darker in winter.
  const conifer = mixRGB(
    o,
    rgb,
    [o.mul(rgb[0], o.k(0.9)), o.mul(rgb[1], o.k(0.9)), o.mul(rgb[2], o.k(0.95))] as RGB<T>,
    w.winter,
  );
  let wood = mixRGB(o, conifer, broad, c.broadleaf);
  wood = mixRGB(o, wood, larch, c.larch);

  let out = rgb;
  out = mixRGB(o, out, soil, c.soil);
  out = mixRGB(o, out, land, open);
  out = mixRGB(o, out, wood, c.forest);
  return out;
}
