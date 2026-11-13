/**
 * Batched 3D Model tiles (3D Tiles 1.0, `.b3dm`): a feature table (RTC_CENTER), a batch table
 * (one attribute row per building) and an embedded binary glTF. swisstopo's tiles carry one
 * node with one mesh whose primitives are Draco-compressed (KHR_draco_mesh_compression), with
 * POSITION, NORMAL and _BATCHID; no textures, just a wall and a roof colour.
 */

export interface GltfJson {
  nodes?: Array<{
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }>;
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
  meshes: Array<{ primitives: GltfPrimitive[] }>;
  accessors: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
  }>;
  bufferViews: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
  extensionsUsed?: string[];
}

export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
  material?: number;
  extensions?: {
    KHR_draco_mesh_compression?: { bufferView: number; attributes: Record<string, number> };
  };
}

export interface B3dm {
  featureTable: { BATCH_LENGTH?: number; RTC_CENTER?: number[] };
  /** Column per property, one value per building (batch id). */
  batchTable: Record<string, unknown[]>;
  gltf: GltfJson;
  /** The glTF binary chunk. */
  bin: Uint8Array;
}

const text = new TextDecoder();

function json<T>(bytes: Uint8Array): T {
  // Tables are padded with spaces (or, by some writers, zeros) to 8-byte boundaries.
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0 || bytes[end - 1] === 0x20)) end--;
  return JSON.parse(text.decode(bytes.subarray(0, end))) as T;
}

export function parseB3dm(buf: Uint8Array): B3dm {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 28 || text.decode(buf.subarray(0, 4)) !== 'b3dm') throw new Error('not a b3dm');
  const ftJson = dv.getUint32(12, true);
  const ftBin = dv.getUint32(16, true);
  const btJson = dv.getUint32(20, true);
  const btBin = dv.getUint32(24, true);
  let o = 28;
  const featureTable = ftJson ? json<B3dm['featureTable']>(buf.subarray(o, o + ftJson)) : {};
  o += ftJson + ftBin;
  const batchTable = btJson ? json<B3dm['batchTable']>(buf.subarray(o, o + btJson)) : {};
  o += btJson + btBin;
  const glb = buf.subarray(o);
  const g = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (text.decode(glb.subarray(0, 4)) !== 'glTF') throw new Error('b3dm: no binary glTF');
  let p = 12;
  let gltf: GltfJson | undefined;
  let bin: Uint8Array = new Uint8Array(0);
  while (p + 8 <= glb.length) {
    const len = g.getUint32(p, true);
    const type = g.getUint32(p + 4, true);
    const chunk = glb.subarray(p + 8, p + 8 + len);
    if (type === 0x4e4f534a) gltf = json<GltfJson>(chunk);
    else if (type === 0x004e4942) bin = chunk;
    p += 8 + len;
  }
  if (!gltf) throw new Error('b3dm: glTF without JSON');
  return { featureTable, batchTable, gltf, bin };
}

/** Column-major 4x4 of a node (matrix, or translation * rotation * scale). */
export function nodeMatrix(n: NonNullable<GltfJson['nodes']>[number]): number[] {
  if (n.matrix) return n.matrix.slice();
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const x2 = x! + x!;
  const y2 = y! + y!;
  const z2 = z! + z!;
  const xx = x! * x2;
  const xy = x! * y2;
  const xz = x! * z2;
  const yy = y! * y2;
  const yz = y! * z2;
  const zz = z! * z2;
  const wx = w! * x2;
  const wy = w! * y2;
  const wz = w! * z2;
  return [
    (1 - (yy + zz)) * sx!,
    (xy + wz) * sx!,
    (xz - wy) * sx!,
    0,
    (xy - wz) * sy!,
    (1 - (xx + zz)) * sy!,
    (yz + wx) * sy!,
    0,
    (xz + wy) * sz!,
    (yz - wx) * sz!,
    (1 - (xx + yy)) * sz!,
    0,
    tx!,
    ty!,
    tz!,
    1,
  ];
}

export function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  return out;
}

/** Every mesh of the default scene with its world matrix (glTF space, y up). */
export function meshInstances(g: GltfJson): Array<{ mesh: number; matrix: number[] }> {
  const out: Array<{ mesh: number; matrix: number[] }> = [];
  const nodes = g.nodes ?? [];
  const visit = (i: number, parent: number[]) => {
    const n = nodes[i];
    if (!n) return;
    const m = multiply(parent, nodeMatrix(n));
    if (n.mesh !== undefined) out.push({ mesh: n.mesh, matrix: m });
    for (const c of n.children ?? []) visit(c, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);
  for (const r of roots) visit(r, identity);
  if (!out.length && g.meshes.length) out.push({ mesh: 0, matrix: identity });
  return out;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Reads a plain (not Draco) accessor as floats. */
export function readAccessor(g: GltfJson, bin: Uint8Array, index: number): Float32Array {
  const a = g.accessors[index]!;
  const n = COMPONENTS[a.type] ?? 1;
  const out = new Float32Array(a.count * n);
  if (a.bufferView === undefined) return out;
  const bv = g.bufferViews[a.bufferView]!;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType] ?? 4;
  const stride = bv.byteStride ?? size * n;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  for (let i = 0; i < a.count; i++)
    for (let k = 0; k < n; k++) {
      const o = base + i * stride + k * size;
      let v: number;
      switch (a.componentType) {
        case 5120:
          v = dv.getInt8(o);
          break;
        case 5121:
          v = dv.getUint8(o);
          break;
        case 5122:
          v = dv.getInt16(o, true);
          break;
        case 5123:
          v = dv.getUint16(o, true);
          break;
        case 5125:
          v = dv.getUint32(o, true);
          break;
        default:
          v = dv.getFloat32(o, true);
      }
      out[i * n + k] = v;
    }
  return out;
}
