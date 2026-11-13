import { CHUNK_ZOOM, type ChunkKey } from './chunks';
import { rand2 } from './hash';
import { Grid, type Pt, distanceToEmpty } from './raster';
import {
  Cover,
  Species,
  aboveTreeLine,
  pickSpecies,
  speciesWeights,
  treeLine,
  treeSize,
} from './species';
import { mercatorLat, mercatorLon } from '@geo';

/** What the vector tile of a chunk says, in tile units (0..extent, y down). */
export interface ScatterInput {
  tile: ChunkKey;
  extent: number;
  /** Scatter cells per tile side (the global grid, see chunks.ts). */
  grid: number;
  /** Raster cells per tile side for cover, exclusions and the distance to the forest edge. */
  rasterSize: number;
  /** Ground metres per tile unit. */
  metresPerUnit: number;
  covers: Array<{ cover: Cover; rings: Pt[][] }>;
  /** Areas where no trunk stands: water, buildings, runways. */
  blocks: Pt[][][];
  /** Roads, railways, streams: no trunk within `radius` tile units of the line. */
  lines: Array<{ line: Pt[]; radius: number }>;
  /** Single trees (fields, orchards, gardens, avenues). */
  points: Pt[];
  /** Height above sea level at a point of the tile, metres (undefined: unknown). */
  elevation(u: number, v: number): number | undefined;
  /**
   * The orthophoto's albedo around a point (linear rgb into `out`), false where there is none.
   */
  photo?(u: number, v: number, out: number[]): boolean;
}

/** The trees of a chunk, struct of arrays. */
export interface Scattered {
  count: number;
  /** Tile units. */
  u: Float32Array;
  v: Float32Array;
  species: Uint8Array;
  height: Float32Array;
  width: Float32Array;
  rotation: Float32Array;
  /** Uniform [0, 1): which trees stay when the forest is thinned with distance. */
  rank: Float32Array;
  /** Uniform [0, 1): per-tree variation in the shader (tint, autumn colour, sway phase). */
  seed: Float32Array;
  /** Linear albedo of the photo under the tree, rgb; negative r = no photo. */
  photo: Float32Array;
  /** Metres from the trunk to the edge of its forest (capped). */
  edge: Float32Array;
  /** Photo luminance under the tree over the chunk's mean forest luminance (1 = no photo). */
  bright: Float32Array;
  /** Statistics for the report. */
  stats: { candidates: number; forestCells: number; singles: number; aboveLine: number };
}

/** Acceptance per cover: at the edge of a stand and in its heart (beyond HEART metres). */
const DENSITY: Record<Cover, [number, number]> = {
  [Cover.None]: [0, 0],
  [Cover.Forest]: [0.55, 0.86],
  [Cover.Loose]: [0.2, 0.3],
  [Cover.Woody]: [0.62, 0.8],
  [Cover.Scrub]: [0.4, 0.5],
};
/** Metres from the forest edge where a stand reaches its full density. */
const HEART = 22;
/** Trunks stand at least this far inside the forest outline (the outline follows the crowns). */
const EDGE_INSET = 1.5;

/**
 * Scatters the trees of one chunk. Candidates sit on a jittered global grid (one per cell), so
 * neighbouring chunks continue each other seamlessly; each candidate's fate (in or out, species,
 * size, rank) comes from hashes of its global cell, so it is the same on every run.
 */
export function scatter(input: ScatterInput): Scattered {
  const { tile, extent, grid: G, rasterSize, metresPerUnit } = input;
  const cover = new Grid(rasterSize, extent);
  for (const c of input.covers) cover.fillRings(c.rings, c.cover);
  const blocked = new Grid(rasterSize, extent);
  for (const rings of input.blocks) blocked.fillRings(rings, 1);
  for (const l of input.lines) blocked.strokeLine(l.line, l.radius, 1);
  const cellMetres = (extent / rasterSize) * metresPerUnit;
  const cap = Math.ceil(HEART / cellMetres) + 1;
  const edge = distanceToEmpty(cover, cap);

  // Mean photo luminance over the forest of the chunk: the reference for "darker than usual".
  const px = [0, 0, 0];
  let lumSum = 0;
  let lumN = 0;
  if (input.photo)
    for (let j = 8; j < rasterSize; j += 16)
      for (let i = 8; i < rasterSize; i += 16) {
        if (!cover.data[j * rasterSize + i]) continue;
        if (input.photo((i + 0.5) * cover.cell, (j + 0.5) * cover.cell, px)) {
          lumSum += 0.2126 * px[0]! + 0.7152 * px[1]! + 0.0722 * px[2]!;
          lumN++;
        }
      }
  const forestLum = lumN > 0 ? lumSum / lumN : 0;

  const out = new Builder();
  let candidates = 0;
  let aboveLine = 0;
  const step = extent / G;
  // Tree lines and elevations vary slowly: one tree line per chunk is plenty.
  const midLon = mercatorLon(tile.x + 0.5, CHUNK_ZOOM);
  const midLat = mercatorLat(tile.y + 0.5, CHUNK_ZOOM);
  const line = treeLine(midLon, midLat);
  for (let j = 0; j < G; j++) {
    const gj = tile.y * G + j;
    for (let i = 0; i < G; i++) {
      const gi = tile.x * G + i;
      const u = (i + 0.5 + (rand2(gi, gj, 1) - 0.5) * 0.8) * step;
      const v = (j + 0.5 + (rand2(gi, gj, 2) - 0.5) * 0.8) * step;
      const ci = Math.floor(u / cover.cell);
      const cj = Math.floor(v / cover.cell);
      const k = cj * rasterSize + ci;
      const c = cover.data[k]! as Cover;
      if (c === Cover.None || blocked.data[k]) continue;
      candidates++;
      const dist = edge[k]! * cellMetres;
      if (dist < EDGE_INSET) continue;
      const [atEdge, heart] = DENSITY[c];
      const t = Math.min(1, dist / HEART);
      let density = atEdge + (heart - atEdge) * t * t * (3 - 2 * t);
      const elev = input.elevation(u, v) ?? 600;
      if (aboveTreeLine(elev, line)) {
        aboveLine++;
        continue;
      }
      // Stands open up over the last 250 m below the tree line.
      density *= Math.min(1, Math.max(0.25, (line + 120 - elev) / 370));
      if (rand2(gi, gj, 4) >= density) continue;

      let darkness = 0;
      let bright = 1;
      const hasPhoto = input.photo?.(u, v, px) ?? false;
      if (hasPhoto && forestLum > 0) {
        const lum = 0.2126 * px[0]! + 0.7152 * px[1]! + 0.0722 * px[2]!;
        darkness = (forestLum - lum) / forestLum;
        bright = lum / forestLum;
      }
      const s = pickSpecies(speciesWeights(c, elev, line), rand2(gi, gj, 5), darkness);
      const size = treeSize(s, elev, line, rand2(gi, gj, 6), rand2(gi, gj, 7));
      // Crowns at the edge reach out over it only a little: the outline follows the crowns.
      const width = Math.min(size.width, 2 * (dist + 2));
      out.push(
        u,
        v,
        s,
        size.height,
        width,
        rand2(gi, gj, 8) * Math.PI * 2,
        rand2(gi, gj, 3),
        rand2(gi, gj, 9),
        hasPhoto ? px : null,
        dist,
        bright,
      );
    }
  }

  // Single trees: exactly where the survey has them.
  let singles = 0;
  for (const p of input.points) {
    if (p.x < 0 || p.y < 0 || p.x >= extent || p.y >= extent) continue;
    if (cover.at(p.x, p.y) !== Cover.None || blocked.at(p.x, p.y)) continue;
    const gx = tile.x * extent + Math.round(p.x);
    const gy = tile.y * extent + Math.round(p.y);
    const elev = input.elevation(p.x, p.y) ?? 600;
    if (aboveTreeLine(elev, line)) continue;
    const h = rand2(gx, gy, 5);
    // Fields and orchards of the lowlands: fruit trees, oaks, limes; higher up, the forest mix.
    const s =
      elev < 900
        ? h < 0.6
          ? Species.Solitary
          : h < 0.85
            ? Species.Oak
            : Species.Beech
        : pickSpecies(speciesWeights(Cover.Woody, elev, line), h);
    const size = treeSize(s, elev, line, rand2(gx, gy, 6), rand2(gx, gy, 7));
    const hasPhoto = input.photo?.(p.x, p.y, px) ?? false;
    out.push(
      p.x,
      p.y,
      s,
      size.height,
      // Alone in a field a tree grows wide.
      size.width * 1.15,
      rand2(gx, gy, 8) * Math.PI * 2,
      rand2(gx, gy, 3),
      rand2(gx, gy, 9),
      hasPhoto ? px : null,
      0,
      1,
    );
    singles++;
  }
  let forestCells = 0;
  for (let k = 0; k < cover.data.length; k++) if (cover.data[k]) forestCells++;
  return out.finish({ candidates, forestCells, singles, aboveLine });
}

class Builder {
  private n = 0;
  private cap = 1024;
  private f = this.alloc(this.cap);

  private alloc(cap: number) {
    return {
      u: new Float32Array(cap),
      v: new Float32Array(cap),
      species: new Uint8Array(cap),
      height: new Float32Array(cap),
      width: new Float32Array(cap),
      rotation: new Float32Array(cap),
      rank: new Float32Array(cap),
      seed: new Float32Array(cap),
      photo: new Float32Array(cap * 3),
      edge: new Float32Array(cap),
      bright: new Float32Array(cap),
    };
  }

  push(
    u: number,
    v: number,
    s: Species,
    height: number,
    width: number,
    rotation: number,
    rank: number,
    seed: number,
    photo: number[] | null,
    edge: number,
    bright: number,
  ) {
    if (this.n === this.cap) {
      const next = this.alloc(this.cap * 2);
      for (const key of Object.keys(next) as Array<keyof typeof next>)
        (next[key] as Float32Array).set(this.f[key] as Float32Array);
      this.f = next;
      this.cap *= 2;
    }
    const i = this.n++;
    const f = this.f;
    f.u[i] = u;
    f.v[i] = v;
    f.species[i] = s;
    f.height[i] = height;
    f.width[i] = width;
    f.rotation[i] = rotation;
    f.rank[i] = rank;
    f.seed[i] = seed;
    f.photo[i * 3] = photo ? photo[0]! : -1;
    f.photo[i * 3 + 1] = photo ? photo[1]! : 0;
    f.photo[i * 3 + 2] = photo ? photo[2]! : 0;
    f.edge[i] = edge;
    f.bright[i] = bright;
  }

  finish(stats: Scattered['stats']): Scattered {
    const n = this.n;
    const f = this.f;
    return {
      count: n,
      u: f.u.slice(0, n),
      v: f.v.slice(0, n),
      species: f.species.slice(0, n),
      height: f.height.slice(0, n),
      width: f.width.slice(0, n),
      rotation: f.rotation.slice(0, n),
      rank: f.rank.slice(0, n),
      seed: f.seed.slice(0, n),
      photo: f.photo.slice(0, n * 3),
      edge: f.edge.slice(0, n),
      bright: f.bright.slice(0, n),
      stats,
    };
  }
}
