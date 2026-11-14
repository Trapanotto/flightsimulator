/**
 * The vertex format shared by footprint and swissBUILDINGS3D tiles, built in the workers.
 *
 * Per vertex on the GPU (16 bytes): position (unorm16 x4: x, y, z quantised to the tile's
 * extent, w the lift onto the terrain, quantised to its own range on the main thread) and
 * look (16-bit words: roof colour and wall colour as RGB 5:6:5, the 3D cell relative to the
 * tile's lowest one with the kind, the eave height with the seed; see packLook). y is metres
 * above the building's own ground point. No normals: the shader takes the face normal from
 * screen-space derivatives (every building face is flat), which lets corners share vertices
 * and roughly thirds the vertex count of the 3D data.
 *
 * 16 bits over a footprint tile (about 1.7 km) are steps of 2.6 cm, over a 3D cell (168 m)
 * 2.6 mm: far below what can be seen from the air (and the walls' feet reach 40 cm into the
 * terrain anyway). A building has one flat colour, so 5 or 6 bits per channel (steps of 1 to
 * 2 % in sRGB) do not show.
 *
 * On the CPU a tile keeps what re-seating needs: the quantised positions, one ground bit per
 * vertex, and per building its first vertex and anchor.
 */

/** The vertex sits on the ground: it follows the terrain under itself, not the anchor's. */
export const FLAG_GROUND = 1;

/** Largest value of a 16-bit normalised attribute. */
export const Q16 = 65535;

/**
 * Cell offset of a vertex outside every swissBUILDINGS3D cell (3D tiles, or outside the
 * grid): 5 bits each way, 31 in both.
 */
export const NO_CELL = 0x3ff;

/** Cells per side of the swissBUILDINGS3D grid (see grid.ts). */
const GRID_SIZE = 2048;

/** What a building is, for its look (codes stored per vertex). */
export const KIND = {
  house: 0,
  /** Large flat-roofed: industry, commerce, blocks of flats. */
  flat: 1,
  church: 2,
  /** Church towers and other slender towers. */
  tower: 3,
  /** Farmhouses and barns: weathered wood above a plastered ground floor. */
  farm: 4,
  /** Alpine chalets: dark wood. */
  chalet: 5,
  /** Free-standing roofs (petrol stations, platforms): no walls, no windows. */
  canopy: 6,
  greenhouse: 7,
  /** Walls, ruins and other structures without windows. */
  structure: 8,
} as const;

export interface BuildingRecord {
  /** Tile-frame x/z of the point whose ground height the building stands on. */
  anchorX: number;
  anchorZ: number;
  /** swissBUILDINGS3D cell holding the building (footprint tiles; -1 for 3D tiles). */
  cell: number;
  /** 0..1, stable per building: colour choice, which windows are lit. */
  seed: number;
  /** Linear RGB. */
  roof: [number, number, number];
  wall: [number, number, number];
  kind: number;
  /** Height of the eaves above the ground point: windows stop below it. */
  eave: number;
}

/** A finished tile mesh, ready to transfer to the main thread. */
export interface MeshData {
  /**
   * Per vertex, 4 x uint16: x, y, z quantised to [min, max] of the extent below; w is left
   * for the lift (see GroundGrid.lift).
   */
  position: Uint16Array;
  /** Per vertex, 4 x uint16: the building's look (see packLook). */
  look: Uint16Array;
  indices: Uint32Array | Uint16Array;
  /** Per building: its first vertex (a building's vertices are contiguous), then the count. */
  starts: Uint32Array;
  /** Per building: tile-frame x and z of the point whose ground height it stands on. */
  anchors: Float32Array;
  /** One bit per vertex: FLAG_GROUND. */
  ground: Uint8Array;
  vertexCount: number;
  buildingCount: number;
  /** The lowest swissBUILDINGS3D cell column and row among the tile's buildings. */
  cellX: number;
  cellY: number;
  /** Extent of the vertices in the tile frame (y relative to the ground points). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

/** What packLook stores per building; also what unpackLook (and the shader) get back. */
export interface Look {
  /** sRGB bytes. */
  roof: [number, number, number];
  wall: [number, number, number];
  kind: number;
  /** 0..255. */
  seed: number;
  /** Metres; 1000 stands for "no eaves known". */
  eave: number;
  /** Cell column and row offset from the tile's lowest (0..30), or -1 for none. */
  cellDx: number;
  cellDy: number;
}

/** Eave heights: half metres up to 100 m, 4 m steps up to 316 m; 255 for none. */
function packEave(e: number): number {
  if (!(e < 316)) return 255;
  if (e < 100) return Math.min(199, Math.max(0, Math.round(e * 2)));
  return Math.min(254, 200 + Math.round((e - 100) / 4));
}

export function unpackEave(v: number): number {
  return v > 254 ? 1000 : v < 200 ? v / 2 : 100 + (v - 200) * 4;
}

const rgb565 = (c: [number, number, number]) =>
  (Math.round((c[0] * 31) / 255) << 11) |
  (Math.round((c[1] * 63) / 255) << 5) |
  Math.round((c[2] * 31) / 255);

const unrgb565 = (v: number): [number, number, number] => [
  Math.round(((v >> 11) * 255) / 31),
  Math.round((((v >> 5) & 63) * 255) / 63),
  Math.round(((v & 31) * 255) / 31),
];

/**
 * The look of a building in four 16-bit words, read by the shader as unorm16 x4 (three's
 * WebGPU backend would widen plain uint16 to 32 bits):
 *   0: roof RGB 5:6:5   1: wall RGB 5:6:5
 *   2: cell column offset (bits 0-4), row offset (5-9), kind (10-13)
 *   3: eave (bits 0-7, see packEave), seed (8-15)
 */
export function packLook(l: Look, out: Uint16Array, at = 0) {
  const cell =
    l.cellDx >= 0 && l.cellDx < 31 && l.cellDy >= 0 && l.cellDy < 31
      ? l.cellDx | (l.cellDy << 5)
      : NO_CELL;
  out[at] = rgb565(l.roof);
  out[at + 1] = rgb565(l.wall);
  out[at + 2] = cell | ((l.kind & 15) << 10);
  out[at + 3] = packEave(l.eave) | ((l.seed & 255) << 8);
}

export function unpackLook(w: ArrayLike<number>, at = 0): Look {
  const cell = w[at + 2]! & 0x3ff;
  return {
    roof: unrgb565(w[at]!),
    wall: unrgb565(w[at + 1]!),
    kind: (w[at + 2]! >> 10) & 15,
    seed: w[at + 3]! >> 8,
    eave: unpackEave(w[at + 3]! & 255),
    cellDx: cell === NO_CELL ? -1 : cell & 31,
    cellDy: cell === NO_CELL ? -1 : cell >> 5,
  };
}

/** Quantises v in [lo, lo + range] to 0..Q16. */
export function quantise(v: number, lo: number, range: number): number {
  if (!(range > 0)) return 0;
  return Math.min(Q16, Math.max(0, Math.round(((v - lo) / range) * Q16)));
}

/** Tile-frame position of vertex i, as the shader decodes it. */
export function vertexPosition(
  m: MeshData,
  i: number,
  out = { x: 0, y: 0, z: 0 },
): { x: number; y: number; z: number } {
  const q = m.position;
  out.x = m.minX + (q[4 * i]! / Q16) * (m.maxX - m.minX);
  out.y = m.minY + (q[4 * i + 1]! / Q16) * (m.maxY - m.minY);
  out.z = m.minZ + (q[4 * i + 2]! / Q16) * (m.maxZ - m.minZ);
  return out;
}

export const isGround = (m: Pick<MeshData, 'ground'>, i: number) =>
  (m.ground[i >> 3]! & (1 << (i & 7))) !== 0;

/** The building vertex i belongs to. */
export function buildingOf(m: Pick<MeshData, 'starts'>, i: number): number {
  let lo = 0;
  let hi = m.starts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (m.starts[mid]! <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The index array for this many vertices: 16 bits whenever they fit. */
export function indexArray(
  indices: ArrayLike<number>,
  vertexCount: number,
): Uint16Array | Uint32Array {
  return vertexCount <= 0xffff ? Uint16Array.from(indices) : Uint32Array.from(indices);
}

class Grow<T extends Float32Array | Uint16Array | Uint32Array> {
  length = 0;
  constructor(
    public data: T,
    private readonly make: (n: number) => T,
  ) {}
  push(v: number) {
    if (this.length === this.data.length) {
      const next = this.make(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
}

/** What the builder keeps per building until finish(). */
const BUILDING_FLOATS = 12;

/** Triangle keys stay exact numbers while every corner index fits this many bits. */
const KEY_BITS = 2 ** 17;

export class MeshBuilder {
  private readonly pos = new Grow(new Float32Array(3 * 4096), (n) => new Float32Array(n));
  private readonly flags = new Grow(new Uint16Array(4096), (n) => new Uint16Array(n));
  private readonly idx = new Grow(new Uint32Array(3 * 4096), (n) => new Uint32Array(n));
  private readonly bld = new Grow(
    new Float32Array(BUILDING_FLOATS * 256),
    (n) => new Float32Array(n),
  );
  private readonly start = new Grow(new Uint32Array(256), (n) => new Uint32Array(n));
  private building = -1;
  /** Vertices of the current building by quantised position: corners are shared. */
  private shared = new Map<string, number>();
  /** Triangles of the current building by their sorted corners (see rawTriangle). */
  private faces = new Set<number | string>();
  private minX = Infinity;
  private maxX = -Infinity;
  private minZ = Infinity;
  private maxZ = -Infinity;
  private minY = Infinity;
  private maxY = -Infinity;

  get vertexCount() {
    return this.pos.length / 3;
  }

  get buildingCount() {
    return this.building + 1;
  }

  get triangleCount() {
    return this.idx.length / 3;
  }

  /** Starts a building; the next vertices belong to it. Returns its index. */
  begin(b: BuildingRecord): number {
    this.building++;
    this.shared.clear();
    this.faces.clear();
    this.start.push(this.vertexCount);
    const f = this.bld;
    f.push(b.anchorX);
    f.push(b.anchorZ);
    f.push(b.cell);
    f.push(b.seed);
    f.push(b.roof[0]);
    f.push(b.roof[1]);
    f.push(b.roof[2]);
    f.push(b.kind);
    f.push(b.wall[0]);
    f.push(b.wall[1]);
    f.push(b.wall[2]);
    f.push(b.eave);
    return this.building;
  }

  vertex(x: number, y: number, z: number, flags = 0): number {
    const key = `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)},${flags}`;
    const known = this.shared.get(key);
    if (known !== undefined) return known;
    const i = this.pos.length / 3;
    this.pos.push(x);
    this.pos.push(y);
    this.pos.push(z);
    this.flags.push(flags);
    this.shared.set(key, i);
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
    return i;
  }

  /**
   * A triangle facing along (nx, ny, nz): the winding is fixed here so that the front face
   * (counter-clockwise seen from outside, three's convention) looks that way. Degenerate
   * triangles are dropped.
   */
  triangle(a: number, b: number, c: number, nx: number, ny: number, nz: number) {
    if (a === b || b === c || a === c) return;
    const p = this.pos.data;
    const ax = p[3 * a]!;
    const ay = p[3 * a + 1]!;
    const az = p[3 * a + 2]!;
    const ux = p[3 * b]! - ax;
    const uy = p[3 * b + 1]! - ay;
    const uz = p[3 * b + 2]! - az;
    const vx = p[3 * c]! - ax;
    const vy = p[3 * c + 1]! - ay;
    const vz = p[3 * c + 2]! - az;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const d = cx * nx + cy * ny + cz * nz;
    if (Math.abs(d) < 1e-9 && Math.hypot(cx, cy, cz) < 1e-6) return;
    this.idx.push(a);
    if (d >= 0) {
      this.idx.push(b);
      this.idx.push(c);
    } else {
      this.idx.push(c);
      this.idx.push(b);
    }
  }

  /**
   * Raw triangle with the winding as given (data that is already oriented). swissBUILDINGS3D
   * holds about half of its faces twice (once per winding); drawn double-sided, one copy is
   * enough. Faces without area are dropped too: they never cover a pixel.
   */
  rawTriangle(a: number, b: number, c: number) {
    if (a === b || b === c || a === c) return;
    const lo = Math.min(a, b, c);
    const hi = Math.max(a, b, c);
    const mid = a + b + c - lo - hi;
    const key = hi < KEY_BITS ? (lo * KEY_BITS + mid) * KEY_BITS + hi : `${lo},${mid},${hi}`;
    if (this.faces.has(key)) return;
    this.faces.add(key);
    const p = this.pos.data;
    const ux = p[3 * b]! - p[3 * a]!;
    const uy = p[3 * b + 1]! - p[3 * a + 1]!;
    const uz = p[3 * b + 2]! - p[3 * a + 2]!;
    const vx = p[3 * c]! - p[3 * a]!;
    const vy = p[3 * c + 1]! - p[3 * a + 1]!;
    const vz = p[3 * c + 2]! - p[3 * a + 2]!;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-12) return;
    this.idx.push(a);
    this.idx.push(b);
    this.idx.push(c);
  }

  finish(): MeshData {
    const n = this.vertexCount;
    const nb = this.building + 1;
    const b = this.bld.data;
    const p = this.pos.data;
    const fl = this.flags.data;
    const any = n > 0;
    const minX = any ? this.minX : 0;
    const minY = any ? this.minY : 0;
    const minZ = any ? this.minZ : 0;
    const maxX = any ? this.maxX : 0;
    const maxY = any ? this.maxY : 0;
    const maxZ = any ? this.maxZ : 0;

    // The tile's 3D cells relative to its lowest: 5 bits each way (a tile spans about 16).
    let cellX = Infinity;
    let cellY = Infinity;
    for (let k = 0; k < nb; k++) {
      const cell = b[k * BUILDING_FLOATS + 2]!;
      if (cell < 0) continue;
      cellX = Math.min(cellX, cell % GRID_SIZE);
      cellY = Math.min(cellY, Math.floor(cell / GRID_SIZE));
    }
    if (cellX === Infinity) cellX = cellY = 0;

    const position = new Uint16Array(n * 4);
    const look = new Uint16Array(n * 4);
    const ground = new Uint8Array((n + 7) >> 3);
    const anchors = new Float32Array(nb * 2);
    const starts = new Uint32Array(nb + 1);
    starts.set(this.start.data.subarray(0, nb));
    starts[nb] = n;
    const rx = maxX - minX;
    const ry = maxY - minY;
    const rz = maxZ - minZ;
    const words = new Uint16Array(4);
    for (let k = 0; k < nb; k++) {
      const o = k * BUILDING_FLOATS;
      anchors[2 * k] = b[o]!;
      anchors[2 * k + 1] = b[o + 1]!;
      const cell = b[o + 2]!;
      packLook(
        {
          roof: [linearToSrgb8(b[o + 4]!), linearToSrgb8(b[o + 5]!), linearToSrgb8(b[o + 6]!)],
          wall: [linearToSrgb8(b[o + 8]!), linearToSrgb8(b[o + 9]!), linearToSrgb8(b[o + 10]!)],
          kind: b[o + 7]!,
          seed: Math.round(b[o + 3]! * 255),
          eave: b[o + 11]!,
          cellDx: cell >= 0 ? (cell % GRID_SIZE) - cellX : -1,
          cellDy: cell >= 0 ? Math.floor(cell / GRID_SIZE) - cellY : -1,
        },
        words,
      );
      for (let i = starts[k]!; i < starts[k + 1]!; i++) {
        position[4 * i] = quantise(p[3 * i]!, minX, rx);
        position[4 * i + 1] = quantise(p[3 * i + 1]!, minY, ry);
        position[4 * i + 2] = quantise(p[3 * i + 2]!, minZ, rz);
        look.set(words, 4 * i);
        if (fl[i]! & FLAG_GROUND) ground[i >> 3]! |= 1 << (i & 7);
      }
    }
    return {
      position,
      look,
      indices: indexArray(this.idx.data.subarray(0, this.idx.length), n),
      starts,
      anchors,
      ground,
      vertexCount: n,
      buildingCount: nb,
      cellX,
      cellY,
      minX,
      maxX,
      minZ,
      maxZ,
      minY,
      maxY,
    };
  }
}

/** Linear 0..1 to sRGB 0..255. */
export function linearToSrgb8(v: number): number {
  const c = Math.min(Math.max(v, 0), 1);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** sRGB 0..255 to linear (the shader turns the bytes back into linear light). */
export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearRgb(r: number, g: number, b: number): [number, number, number] {
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}
