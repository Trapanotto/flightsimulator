/**
 * Lights of the night, baked per tile in the worker from the vector tiles: street lamps along
 * the roads inside settlements, a pool of light on the ground under each lamp, the soft glow
 * of built-up areas (windows, signs, private lights) and single lights on farms and huts
 * outside. Pure functions on tile pixel coordinates, tested in Node.
 *
 * Everything is luminance in cd/m² averaged over a texel, so a texture of it can be averaged
 * (mipmapped) without losing energy: from far away a lamp of 0.4 m and a texel of 25 m holding
 * that lamp shine with the same power, which keeps towns from popping as tiles refine.
 */
import { type Field, addField, blur, fieldAt, grid, splat } from './raster';

/** A road as drawn into the tile: x, y pairs in tile pixels (row 0 = north edge). */
export interface LightRoad {
  /** `transportation` class of swisstopo's base map (motorway, primary, minor, ...). */
  cls: string;
  /** Motorway slip roads, junction loops. */
  ramp: boolean;
  tunnel: boolean;
  points: ArrayLike<number>;
}

export interface LightInput {
  /** Output raster: size x size texels over the tile. */
  size: number;
  metresPerPixel: number;
  roads: LightRoad[];
  /** Single lights (farms, huts): tile pixels, may lie outside the tile. */
  points: Array<{ x: number; y: number; weight: number }>;
  /**
   * 0..1, settled land over the tile and a margin around it (lamps outside the tile shine
   * into it); undefined where there is none near.
   */
  settlement?: Field;
  /** 0..1, where no light can be (lakes, rivers): at a texel of the tile. */
  dark?: (x: number, y: number) => number;
  /**
   * 0..1: share of the minor roads missing from the vector data at this zoom (coarse tiles
   * carry only the main roads); their lamps are added back as a glow of the settlement.
   */
  missingMinor?: number;
  /**
   * Settled land blurred over a few hundred metres (DISTRICT_SIGMA), from a wide margin
   * around the tile: how built-up the neighbourhood is. Brightens town centres over the edges
   * of coarse tiles, and lights the water off a lit shore.
   */
  district?: Field;
}

export interface LightRaster {
  /** Luminance of lamp cores (the luminaires themselves seen from above), cd/m². */
  lamps: Float32Array;
  /** Luminance of lit ground and the glow of built-up areas, cd/m². */
  glow: Float32Array;
  /**
   * On water only: luminance of the shore's lights mirrored by the water at a grazing view,
   * cd/m² (the shader breaks it into glints with the waves). Stored in the glow channel, which
   * is empty on water.
   */
  reflection?: Float32Array;
  /** Lamps placed (inside the tile and its margin). */
  count: number;
}

/**
 * The lamp model. A street lamp seen from above shows a small bright core (the luminaire,
 * effective intensity towards the sky in cd) and a pool of lit road around its foot (about
 * 10 lux on asphalt and pavements, a Gaussian of 7 m). Built-up land glows faintly with
 * windows and private lights, more where lamps are dense (town centres).
 */
export const LAMP = {
  /** Effective intensity of a street lamp towards an observer above, cd. */
  core: 300,
  /** Peak luminance of the lit ground under a lamp, cd/m², and its spread, m. */
  poolPeak: 0.3,
  poolSigma: 4.5,
  /** Peak luminance of the wide glow each lamp adds to its quarter, cd/m², and its spread, m. */
  urbanPeak: 0.003,
  urbanSigma: 45,
  /** Even glow of settled land (windows), cd/m². */
  areaGlow: 0.0015,
  /** Average luminance the lamps of the minor roads add to a settlement, cd/m². */
  minorRoadsGlow: 0.18,
  /**
   * Of that, the share drawn as scattered points in the lamp channel rather than as glow:
   * from tens of kilometres a town is a field of single lights, not an even orange patch.
   */
  minorSparkle: 0.6,
  /**
   * Width (m) over which the edge of a settlement fades: the generalised polygons cut through
   * gardens and fields, real towns thin out over a street or two.
   */
  edgeSigma: 70,
  /**
   * Reflection on water: of the lamps' wide glow (urban) near the shore, and of a lit
   * district (cd/m² for a district value of 1) further out.
   */
  reflectNear: 20,
  reflectDistrict: 0.25,
};

/** Blur (m) of the district field (LightInput.district), and the margin it needs. */
export const DISTRICT_SIGMA = 320;
export const DISTRICT_MARGIN = 1100;

/** A stable pseudo-random number 0..1 for an integer position. */
function hash2(x: number, y: number): number {
  let h = Math.imul(x ^ 0x27d4eb2d, 0x85ebca6b) ^ Math.imul(y + 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/**
 * A copy of a field blurred by sigma metres. Below a cell the bilinear lookup is soft enough
 * already (and the smallest box blur would smear over three cells).
 */
function blurred(f: Field, mpp: number, sigma: number): Field {
  const cells = sigma / (f.cell * mpp);
  if (cells < 1) return f;
  // A wide blur needs no fine grid: averaging blocks of k x k cells first keeps it cheap.
  const k = Math.max(1, Math.min(4, Math.floor(cells / 3)));
  const w = Math.ceil(f.g.w / k);
  const h = Math.ceil(f.g.h / k);
  const g = grid(w, h);
  const src = f.g.data;
  const sw = f.g.w;
  for (let y = 0; y < h; y++) {
    const y0 = y * k;
    const y1 = Math.min(y0 + k, f.g.h);
    for (let x = 0; x < w; x++) {
      const x0 = x * k;
      const x1 = Math.min(x0 + k, sw);
      let s = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += src[yy * sw + xx]!;
      g.data[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  blur(g, cells / k);
  return { g, margin: f.margin, cell: f.cell * k };
}

/** Spacing (m) and strength of the lamps of a road, or null where roads are dark. */
export function lampSpec(
  cls: string,
  ramp: boolean,
  tunnel: boolean,
  inSettlement: boolean,
): { spacing: number; strength: number } | null {
  if (tunnel) return null;
  switch (cls) {
    case 'motorway':
      // Swiss motorways are dark between junctions; slip roads and junctions are lit.
      return ramp ? { spacing: 40, strength: 1.1 } : null;
    case 'trunk':
      if (ramp) return { spacing: 40, strength: 1.1 };
      return inSettlement ? { spacing: 32, strength: 1.3 } : null;
    case 'primary':
    case 'secondary':
      return inSettlement ? { spacing: 30, strength: 1.3 } : null;
    case 'tertiary':
      return inSettlement ? { spacing: 34, strength: 1.1 } : null;
    case 'minor':
      return inSettlement ? { spacing: 38, strength: 1 } : null;
    case 'service':
      return inSettlement ? { spacing: 50, strength: 0.6 } : null;
    default:
      return null;
  }
}

/** Calls `emit(x, y)` every `spacing` pixels along a polyline, the first half a spacing in. */
export function alongLine(
  points: ArrayLike<number>,
  spacing: number,
  emit: (x: number, y: number) => void,
) {
  let next = spacing / 2;
  let walked = 0;
  for (let i = 2; i < points.length; i += 2) {
    const ax = points[i - 2]!;
    const ay = points[i - 1]!;
    const dx = points[i]! - ax;
    const dy = points[i + 1]! - ay;
    const len = Math.hypot(dx, dy);
    while (next <= walked + len) {
      const t = len > 0 ? (next - walked) / len : 0;
      emit(ax + dx * t, ay + dy * t);
      next += spacing;
    }
    walked += len;
  }
}

/** A grid of luminance, blurred by a Gaussian of sigma metres, covering the tile plus margin. */
class GlowLayer {
  readonly field: Field;
  /** Grid cell size and margin in tile pixels. */
  private readonly cell: number;
  private readonly margin: number;
  private readonly cellArea: number;
  private readonly sigmaCells: number;

  constructor(size: number, mpp: number, sigma: number) {
    const cellM = Math.max(mpp, sigma / 2.5);
    this.cell = cellM / mpp;
    this.margin = (3 * sigma) / mpp;
    const n = Math.ceil((size + 2 * this.margin) / this.cell) + 1;
    this.field = { g: grid(n, n), margin: this.margin, cell: this.cell };
    this.cellArea = cellM * cellM;
    this.sigmaCells = sigma / cellM;
  }

  /** True if a light at (x, y) can reach the tile. */
  reaches(x: number, y: number, size: number) {
    const m = this.margin + this.cell;
    return x > -m && y > -m && x < size + m && y < size + m;
  }

  /** Adds energy (luminance x area, cd) at tile pixel (x, y). */
  add(x: number, y: number, energy: number) {
    splat(
      this.field.g,
      (x + this.margin) / this.cell,
      (y + this.margin) / this.cell,
      energy / this.cellArea,
    );
  }

  finish() {
    blur(this.field.g, this.sigmaCells);
  }
}

export function bakeLights(inp: LightInput): LightRaster {
  const { size, metresPerPixel: mpp } = inp;
  const soft = inp.settlement && blurred(inp.settlement, mpp, LAMP.edgeSigma);
  const settlement = (x: number, y: number) => (soft ? fieldAt(soft, x, y) : 0);
  // Street lamps thin out across the faded edge instead of stopping at the polygon's line;
  // the threshold is a hash of the lamp's place on a 10 m grid, so it does not flicker.
  const lampsHere = (x: number, y: number) =>
    settlement(x, y) > 0.2 + 0.55 * hash2(Math.round((x * mpp) / 10), Math.round((y * mpp) / 10));
  const texelArea = mpp * mpp;
  const cores = grid(size, size);
  const pool = new GlowLayer(size, mpp, LAMP.poolSigma);
  const urban = new GlowLayer(size, mpp, LAMP.urbanSigma);
  const poolEnergy = LAMP.poolPeak * 2 * Math.PI * LAMP.poolSigma ** 2;
  const urbanEnergy = LAMP.urbanPeak * 2 * Math.PI * LAMP.urbanSigma ** 2;
  let count = 0;

  const lamp = (x: number, y: number, strength: number) => {
    if (!urban.reaches(x, y, size)) return;
    count++;
    if (x > -1 && y > -1 && x < size + 1 && y < size + 1)
      splat(cores, x, y, (LAMP.core * strength) / texelArea);
    if (pool.reaches(x, y, size)) pool.add(x, y, poolEnergy * strength);
    urban.add(x, y, urbanEnergy * strength);
  };

  // Lines far outside the tile cost nothing but the bounding box test.
  const reach = (3 * LAMP.urbanSigma) / mpp + 2;
  for (const road of inp.roads) {
    const settled = lampSpec(road.cls, road.ramp, road.tunnel, true);
    if (!settled) continue;
    const p = road.points;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]!);
      x1 = Math.max(x1, p[i]!);
      y0 = Math.min(y0, p[i + 1]!);
      y1 = Math.max(y1, p[i + 1]!);
    }
    if (x1 < -reach || y1 < -reach || x0 > size + reach || y0 > size + reach) continue;
    const outside = lampSpec(road.cls, road.ramp, road.tunnel, false);
    alongLine(p, settled.spacing / mpp, (x, y) => {
      const spec = lampsHere(x, y) ? settled : outside;
      if (spec) lamp(x, y, spec.strength);
    });
  }
  for (const pt of inp.points) {
    if (!urban.reaches(pt.x, pt.y, size)) continue;
    count++;
    if (pt.x > -1 && pt.y > -1 && pt.x < size + 1 && pt.y < size + 1)
      splat(cores, pt.x, pt.y, (LAMP.core * pt.weight) / texelArea);
    pool.add(pt.x, pt.y, poolEnergy * pt.weight * 0.5);
  }
  const glow = new Float32Array(size * size);
  // Nothing lit near: the common case in the countryside and the mountains.
  if (count === 0 && !inp.settlement && !inp.district) return { lamps: cores.data, glow, count };
  pool.finish();
  urban.finish();

  addField(pool.field, glow, size);
  addField(urban.field, glow, size);
  if (soft) {
    addField(soft, glow, size, LAMP.areaGlow);
    const minor = (inp.missingMinor ?? 0) * LAMP.minorRoadsGlow;
    if (minor > 0) addMinorRoads(inp, soft, minor, glow, cores.data);
  }
  let reflection: Float32Array | undefined;
  let mirrored: Float32Array | undefined;
  if (inp.dark)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const d = inp.dark(x + 0.5, y + 0.5);
        if (d <= 0) continue;
        const i = y * size + x;
        glow[i]! *= 1 - d;
        // Built at the first water texel: most tiles have none.
        if (!mirrored) {
          mirrored = new Float32Array(size * size);
          reflection = new Float32Array(size * size);
          addField(urban.field, mirrored, size, LAMP.reflectNear);
          if (inp.district) addField(inp.district, mirrored, size, LAMP.reflectDistrict);
        }
        reflection![i] = d * mirrored[i]!;
      }
  return { lamps: cores.data, glow, reflection, count };
}

/**
 * The lamps of the minor roads a coarse tile does not know: part glow, part single points
 * scattered texel by texel (an energy-keeping random weight of mean 1), brighter in the centre
 * of a large town than in a village or at its edge.
 */
function addMinorRoads(
  inp: LightInput,
  soft: Field,
  minor: number,
  glow: Float32Array,
  lamps: Float32Array,
) {
  const { size } = inp;
  const s = new Float32Array(size * size);
  addField(soft, s, size);
  const d = new Float32Array(size * size);
  if (inp.district) addField(inp.district, d, size);
  else d.fill(0.7);
  const even = minor * (1 - LAMP.minorSparkle);
  const points = minor * LAMP.minorSparkle;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (s[i]! <= 0) continue;
      // A settled texel in a district of about 0.7 keeps the average.
      const dense = s[i]! * (0.45 + 0.8 * Math.min(1, d[i]!));
      const h = hash2(x * 7 + size, y * 13 + (size >> 1));
      glow[i] = glow[i]! + even * dense;
      lamps[i] = lamps[i]! + points * dense * 3 * h * h;
    }
}

/**
 * Packs the two luminance channels into bytes with a square-root encoding scaled to each
 * channel's maximum (fine steps where light is faint), at `offset` within texels of `stride`
 * bytes. Returns the scales, the luminance a byte of 255 stands for.
 */
export function encodeLights(
  r: LightRaster,
  out: Uint8Array,
  stride: number,
  offset = 0,
): [number, number] {
  let maxL = 0;
  let maxG = 0;
  // The reflection lies on water, where the glow is empty: they share the channel.
  let glow = r.glow;
  if (r.reflection) {
    glow = new Float32Array(glow);
    for (let i = 0; i < glow.length; i++) glow[i] = glow[i]! + r.reflection[i]!;
  }
  for (let i = 0; i < r.lamps.length; i++) {
    maxL = Math.max(maxL, r.lamps[i]!);
    maxG = Math.max(maxG, glow[i]!);
  }
  const sL = Math.max(maxL, 1e-6);
  const sG = Math.max(maxG, 1e-6);
  for (let i = 0; i < r.lamps.length; i++) {
    out[i * stride + offset] = Math.round(Math.sqrt(Math.max(r.lamps[i]!, 0) / sL) * 255);
    out[i * stride + offset + 1] = Math.round(Math.sqrt(Math.max(glow[i]!, 0) / sG) * 255);
  }
  return [maxL > 0 ? sL : 0, maxG > 0 ? sG : 0];
}
