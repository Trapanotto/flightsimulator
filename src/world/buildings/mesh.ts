/**
 * The vertex format shared by footprint and swissBUILDINGS3D tiles, built in the workers.
 *
 * Per vertex (16 bytes): position (float x3, tile frame; y is metres above the building's own
 * ground point) and meta (uint16 x2: building index within the tile, flags). No normals: the
 * shader takes the face normal from screen-space derivatives (every building face is flat),
 * which lets corners share vertices and roughly thirds the vertex count of the 3D data.
 *
 * Per building (BUILDING_FLOATS floats, uploaded as a small float texture): where the
 * building stands, its look and its 3D cell (see BuildingRecord).
 */

/** The vertex sits on the ground: it follows the terrain under itself, not the anchor's. */
export const FLAG_GROUND = 1;

export const BUILDING_FLOATS = 12;

/** What a building is, for its look (codes stored in the building texture). */
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
  positions: Float32Array;
  /** Per vertex: building index and flags (kept on the CPU to seat the vertices). */
  meta: Uint16Array;
  /** Per vertex, for the shader: roof colour (sRGB) and kind. */
  roof: Uint8Array;
  /** Per vertex: wall colour (sRGB) and the building's seed. */
  wall: Uint8Array;
  /** Per vertex: 3D cell x and y (65535: none), eave height (decimetres), flags. */
  info: Uint16Array;
  indices: Uint32Array | Uint16Array;
  buildings: Float32Array;
  buildingCount: number;
  /** Extent of the vertices in the tile frame (y relative to the ground points). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
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
  result(): T {
    return this.data.slice(0, this.length) as T;
  }
}

export class MeshBuilder {
  private readonly pos = new Grow(new Float32Array(3 * 4096), (n) => new Float32Array(n));
  private readonly meta = new Grow(new Uint16Array(2 * 4096), (n) => new Uint16Array(n));
  private readonly idx = new Grow(new Uint32Array(3 * 4096), (n) => new Uint32Array(n));
  private readonly bld = new Grow(new Float32Array(BUILDING_FLOATS * 256), (n) => new Float32Array(n));
  private building = -1;
  /** Vertices of the current building by quantised position: corners are shared. */
  private shared = new Map<string, number>();
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
    if (this.building > 0xffff) throw new Error('too many buildings in one tile');
    this.shared.clear();
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
    this.meta.push(this.building);
    this.meta.push(flags);
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

  /** Raw triangle with the winding as given (data that is already oriented). */
  rawTriangle(a: number, b: number, c: number) {
    if (a === b || b === c || a === c) return;
    this.idx.push(a);
    this.idx.push(b);
    this.idx.push(c);
  }

  finish(): MeshData {
    const n = this.pos.length / 3;
    const indices = this.idx.result();
    const meta = this.meta.result();
    const b = this.bld.data;
    const roof = new Uint8Array(n * 4);
    const wall = new Uint8Array(n * 4);
    const info = new Uint16Array(n * 4);
    const size = 2048;
    for (let i = 0; i < n; i++) {
      const o = meta[2 * i]! * BUILDING_FLOATS;
      roof[4 * i] = linearToSrgb8(b[o + 4]!);
      roof[4 * i + 1] = linearToSrgb8(b[o + 5]!);
      roof[4 * i + 2] = linearToSrgb8(b[o + 6]!);
      roof[4 * i + 3] = b[o + 7]!;
      wall[4 * i] = linearToSrgb8(b[o + 8]!);
      wall[4 * i + 1] = linearToSrgb8(b[o + 9]!);
      wall[4 * i + 2] = linearToSrgb8(b[o + 10]!);
      wall[4 * i + 3] = Math.round(b[o + 3]! * 255);
      const cell = b[o + 2]!;
      info[4 * i] = cell >= 0 ? cell % size : 0xffff;
      info[4 * i + 1] = cell >= 0 ? Math.floor(cell / size) : 0xffff;
      info[4 * i + 2] = Math.min(0xffff, Math.max(0, Math.round(b[o + 11]! * 10)));
      info[4 * i + 3] = meta[2 * i + 1]!;
    }
    return {
      positions: this.pos.result(),
      meta,
      roof,
      wall,
      info,
      indices: n <= 0xffff ? Uint16Array.from(indices) : indices,
      buildings: this.bld.result(),
      buildingCount: this.building + 1,
      minX: this.minX,
      maxX: this.maxX,
      minZ: this.minZ,
      maxZ: this.maxZ,
      minY: this.minY,
      maxY: this.maxY,
    };
  }
}

/** Linear 0..1 to sRGB 0..255. */
export function linearToSrgb8(v: number): number {
  const c = Math.min(Math.max(v, 0), 1);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** sRGB 0..255 to linear (the building texture holds linear colours). */
export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearRgb(r: number, g: number, b: number): [number, number, number] {
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}
