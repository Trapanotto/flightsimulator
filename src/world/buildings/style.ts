import { type Box } from './footprint';
import { KIND, linearRgb } from './mesh';
import { type RoofKind } from './roof';

/**
 * What a footprint becomes: how tall, which roof, which look. Swiss building stock in broad
 * strokes: pitched tile roofs on houses and farms, flat roofs on large commercial and
 * industrial buildings and on many post-war blocks in towns, low-pitched wide roofs and dark
 * wood in the Alps, steep roofs and spires on churches.
 */
export interface BuildingPlan {
  kind: number;
  roof: RoofKind;
  /** Total height above the ground point (ridge or flat roof), metres. */
  height: number;
  eave: number;
  /** Lay the roof over the oriented box, with eaves overhanging the walls. */
  boxed: boolean;
  overhang: number;
}

export interface FootprintFacts {
  area: number;
  /** Footprint area / oriented box area: 1 for a rectangle. */
  fill: number;
  box: Box;
  holes: boolean;
  /** Height from the data (vector tiles' render_height), if any. */
  height?: number;
  /** The vector tiles' class: place_of_worship, roof (canopy), greenhouse, construction... */
  cls?: string;
  /** Ground height above sea level, metres (alpine look above about 1000 m). */
  elevation: number;
  /** Buildings per km² around: towns have more flat roofs than villages. */
  density: number;
  seed: number;
}

/** A second independent number from a seed (for several choices per building). */
export function reseed(seed: number, k: number): number {
  const x = Math.sin((seed + k * 0.618034) * 12_9898.233) * 43_758.5453;
  return x - Math.floor(x);
}

/** Typical heights when the data has none: from the footprint (sheds, houses, blocks). */
export function estimateHeight(area: number, density: number): number {
  if (area < 20) return 3;
  if (area < 60) return 5;
  if (area < 250) return density > 600 ? 12 : 8.5;
  if (area < 800) return density > 600 ? 15 : 10;
  return 12;
}

const deg = Math.PI / 180;

export function planBuilding(f: FootprintFacts): BuildingPlan {
  const r = (k: number) => reseed(f.seed, k);
  const alpine = f.elevation > 1000;
  const urban = f.density > 600;
  const W = f.box.halfWidth;
  const L = f.box.halfLength;
  let height = f.height !== undefined && f.height > 0.5 ? f.height : estimateHeight(f.area, f.density);
  const rect = f.fill > 0.86 && !f.holes;

  if (f.cls === 'roof')
    return { kind: KIND.canopy, roof: 'flat', height, eave: height, boxed: false, overhang: 0 };
  if (f.cls === 'greenhouse') {
    height = Math.min(height, 5);
    const roof: RoofKind = rect && f.area < 3000 ? 'gabled' : 'flat';
    const eave = roof === 'flat' ? height : Math.max(2, height - Math.tan(25 * deg) * W);
    return { kind: KIND.greenhouse, roof, height, eave, boxed: roof !== 'flat', overhang: 0 };
  }

  // Slender and tall: a church tower or another tower, with a steep pyramid or spire.
  const slender = f.area < 160 && height > 2.2 * Math.sqrt(f.area) && height > 18;
  if (slender || (f.cls === 'place_of_worship' && f.area < 160 && height > 15)) {
    const spire = Math.min(height * 0.45, Math.max(4 * W, 6));
    return {
      kind: KIND.tower,
      roof: 'hipped',
      height,
      eave: height - spire,
      boxed: true,
      overhang: 0.2,
    };
  }

  let kind: number = alpine ? KIND.chalet : KIND.house;
  let roof: RoofKind;
  let pitch: number;
  if (f.cls === 'place_of_worship') {
    kind = KIND.church;
    roof = 'gabled';
    pitch = 50;
  } else if (height < 3.2 || f.area < 15) {
    // Garages and sheds.
    roof = r(1) < 0.6 ? 'flat' : 'gabled';
    pitch = 20;
    kind = KIND.structure;
  } else if (f.area > 2500 || (f.area > 1200 && (urban || height > 14))) {
    roof = 'flat';
    pitch = 0;
    kind = KIND.flat;
  } else if (f.area > 350) {
    // Barns and farmhouses in the country (one big roof), halls and blocks in towns.
    const flatShare = urban ? (height > 13 ? 0.65 : 0.5) : height > 14 ? 0.5 : 0.15;
    if (!rect || r(2) < flatShare) {
      roof = 'flat';
      pitch = 0;
      kind = KIND.flat;
    } else {
      roof = r(3) < 0.75 ? 'gabled' : 'hipped';
      pitch = alpine ? 22 : 28 + r(4) * 10;
      if (!urban && height < 14) kind = alpine ? KIND.chalet : KIND.farm;
    }
  } else {
    // Houses.
    const flatShare = urban ? (height > 13 ? 0.45 : 0.2) : 0.06;
    if (r(2) < flatShare || f.fill < 0.55) {
      roof = 'flat';
      pitch = 0;
    } else {
      const squarish = L / Math.max(W, 0.1) < 1.35;
      roof = r(3) < (squarish ? 0.55 : 0.25) ? 'hipped' : 'gabled';
      pitch = alpine ? 20 + r(4) * 8 : 32 + r(4) * 13;
    }
  }

  if (roof === 'flat') return { kind, roof, height, eave: height, boxed: false, overhang: 0 };
  // The roof may not eat more than about half the building (low halls, wide houses).
  let rise = Math.tan(pitch * deg) * W;
  rise = Math.min(rise, height * (kind === KIND.church ? 0.6 : 0.5));
  const eave = Math.max(height - rise, Math.min(2.4, height * 0.6));
  const overhang = rect ? (kind === KIND.chalet ? 1.1 : kind === KIND.farm ? 0.9 : 0.5) : 0;
  return { kind, roof, height, eave, boxed: rect, overhang };
}

type Rgb = [number, number, number];
const pick = <T>(list: readonly T[], v: number): T =>
  list[Math.min(list.length - 1, Math.floor(v * list.length))]!;

// sRGB palettes (converted to linear below). Roof tiles weather to muted reds and browns;
// fibre-cement and slate are mid to dark grey; gravel on flat roofs is light grey.
const ROOF_TILE: Rgb[] = [
  [150, 74, 52],
  [138, 66, 48],
  [124, 62, 46],
  [158, 86, 60],
  [112, 60, 48],
  [132, 76, 58],
];
const ROOF_BROWN: Rgb[] = [
  [98, 68, 54],
  [86, 62, 52],
  [110, 80, 64],
];
const ROOF_GREY: Rgb[] = [
  [78, 78, 80],
  [92, 90, 88],
  [66, 66, 70],
  [104, 100, 96],
];
const ROOF_FLAT: Rgb[] = [
  [138, 134, 126],
  [118, 116, 112],
  [150, 146, 138],
  [100, 100, 98],
  [104, 112, 86],
];
const ROOF_ALPINE: Rgb[] = [
  [84, 82, 82],
  [96, 88, 80],
  [74, 70, 68],
  [112, 96, 84],
  [118, 78, 58],
];
const WALL_PLASTER: Rgb[] = [
  [232, 226, 212],
  [226, 216, 196],
  [238, 236, 228],
  [218, 204, 180],
  [210, 202, 188],
  [230, 216, 176],
  [226, 206, 192],
  [214, 214, 206],
];
const WALL_CONCRETE: Rgb[] = [
  [184, 182, 176],
  [204, 200, 192],
  [168, 168, 166],
  [214, 208, 196],
];
const WALL_WOOD: Rgb[] = [
  [112, 78, 52],
  [98, 70, 48],
  [124, 90, 60],
  [88, 64, 46],
];
const WALL_STONE: Rgb[] = [
  [196, 188, 170],
  [178, 172, 160],
];

/** Roof and wall colours (linear RGB) for a building of this kind. */
export function colours(kind: number, seed: number, alpine: boolean): { roof: Rgb; wall: Rgb } {
  const r = (k: number) => reseed(seed, k + 10);
  let roof: Rgb;
  let wall: Rgb;
  switch (kind) {
    case KIND.flat:
      roof = pick(ROOF_FLAT, r(1));
      wall = pick(r(2) < 0.6 ? WALL_CONCRETE : WALL_PLASTER, r(3));
      break;
    case KIND.church:
    case KIND.tower:
      // Slate, or the copper of a spire gone green.
      roof = kind === KIND.tower && r(1) < 0.3 ? [92, 132, 112] : pick(ROOF_GREY, r(2));
      wall = pick(WALL_STONE.concat(WALL_PLASTER.slice(0, 3)), r(3));
      break;
    case KIND.chalet:
      roof = pick(ROOF_ALPINE, r(1));
      wall = pick(WALL_WOOD, r(2));
      break;
    case KIND.farm:
      roof = r(1) < 0.7 ? pick(ROOF_TILE, r(2)) : pick(ROOF_GREY, r(2));
      wall = pick(WALL_WOOD, r(3));
      break;
    case KIND.greenhouse:
      roof = [190, 200, 200];
      wall = [190, 200, 200];
      break;
    case KIND.canopy:
    case KIND.structure:
      roof = pick(ROOF_FLAT.concat(ROOF_GREY), r(1));
      wall = pick(WALL_CONCRETE, r(2));
      break;
    default: {
      const v = r(1);
      roof = alpine
        ? pick(ROOF_ALPINE, r(2))
        : v < 0.6
          ? pick(ROOF_TILE, r(2))
          : v < 0.78
            ? pick(ROOF_BROWN, r(2))
            : pick(ROOF_GREY, r(2));
      wall = pick(WALL_PLASTER, r(3));
    }
  }
  // Small per-building variation so neighbours with the same palette entry still differ.
  const j = 0.92 + 0.16 * r(7);
  return {
    roof: linearRgb(roof[0] * j, roof[1] * j, roof[2] * j),
    wall: linearRgb(Math.min(255, wall[0] * j), Math.min(255, wall[1] * j), Math.min(255, wall[2] * j)),
  };
}

/** A stable 0..1 number for a place (metres in any fixed frame). */
export function seedAt(x: number, z: number): number {
  return reseed(Math.round(x * 10) * 0.000_123_7 + Math.round(z * 10) * 0.000_071_3, 0);
}
