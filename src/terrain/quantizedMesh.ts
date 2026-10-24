/**
 * Decoder for Cesium quantized-mesh-1.0 terrain tiles
 * (https://github.com/CesiumGS/quantized-mesh), as served by swisstopo.
 * Pure function, runs in a worker. All values little endian.
 */

export interface QuantizedMesh {
  center: [number, number, number]; // ECEF
  minHeight: number;
  maxHeight: number;
  boundingSphere: { center: [number, number, number]; radius: number }; // ECEF
  horizonOcclusionPoint: [number, number, number];
  vertexCount: number;
  /** 0..32767, west -> east */
  u: Uint16Array;
  /** 0..32767, south -> north */
  v: Uint16Array;
  /** 0..32767, minHeight -> maxHeight */
  h: Uint16Array;
  indices: Uint16Array | Uint32Array;
  west: Uint16Array | Uint32Array;
  south: Uint16Array | Uint32Array;
  east: Uint16Array | Uint32Array;
  north: Uint16Array | Uint32Array;
  /** Oct-encoded normals, 2 bytes per vertex (extension 1), if present. */
  octNormals?: Uint8Array;
}

export const QM_MAX = 32767;
const HEADER_BYTES = 88;
const EXT_OCT_NORMALS = 1;

const zigZag = (v: number) => (v >> 1) ^ -(v & 1);

export function decodeQuantizedMesh(buffer: ArrayBuffer): QuantizedMesh {
  const view = new DataView(buffer);
  let o = 0;
  const f64 = () => {
    const v = view.getFloat64(o, true);
    o += 8;
    return v;
  };
  const f32 = () => {
    const v = view.getFloat32(o, true);
    o += 4;
    return v;
  };
  const u32 = () => {
    const v = view.getUint32(o, true);
    o += 4;
    return v;
  };

  const center: [number, number, number] = [f64(), f64(), f64()];
  const minHeight = f32();
  const maxHeight = f32();
  const bsCenter: [number, number, number] = [f64(), f64(), f64()];
  const bsRadius = f64();
  const horizonOcclusionPoint: [number, number, number] = [f64(), f64(), f64()];
  if (o !== HEADER_BYTES) throw new Error('quantized-mesh: bad header');

  const vertexCount = u32();
  const u = new Uint16Array(vertexCount);
  const v = new Uint16Array(vertexCount);
  const h = new Uint16Array(vertexCount);
  let cu = 0;
  let cv = 0;
  let ch = 0;
  const uBase = o;
  const vBase = o + vertexCount * 2;
  const hBase = o + vertexCount * 4;
  for (let i = 0; i < vertexCount; i++) {
    cu += zigZag(view.getUint16(uBase + i * 2, true));
    cv += zigZag(view.getUint16(vBase + i * 2, true));
    ch += zigZag(view.getUint16(hBase + i * 2, true));
    u[i] = cu;
    v[i] = cv;
    h[i] = ch;
  }
  o += vertexCount * 6;

  const wide = vertexCount > 65536;
  const bytes = wide ? 4 : 2;
  if (o % bytes !== 0) o += bytes - (o % bytes);
  const readIndexArray = (count: number) => {
    const arr = wide ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      arr[i] = wide ? view.getUint32(o + i * 4, true) : view.getUint16(o + i * 2, true);
    }
    o += count * bytes;
    return arr;
  };

  // Triangle indices use high-water-mark encoding.
  const triangleCount = u32();
  const indices = readIndexArray(triangleCount * 3);
  let highest = 0;
  for (let i = 0; i < indices.length; i++) {
    const code = indices[i]!;
    indices[i] = highest - code;
    if (code === 0) highest++;
  }

  const west = readIndexArray(u32());
  const south = readIndexArray(u32());
  const east = readIndexArray(u32());
  const north = readIndexArray(u32());

  let octNormals: Uint8Array | undefined;
  while (o + 5 <= buffer.byteLength) {
    const id = view.getUint8(o);
    const len = view.getUint32(o + 1, true);
    o += 5;
    if (id === EXT_OCT_NORMALS && len === vertexCount * 2) {
      octNormals = new Uint8Array(buffer.slice(o, o + len));
    }
    o += len;
  }

  return {
    center,
    minHeight,
    maxHeight,
    boundingSphere: { center: bsCenter, radius: bsRadius },
    horizonOcclusionPoint,
    vertexCount,
    u,
    v,
    h,
    indices,
    west,
    south,
    east,
    north,
    octNormals,
  };
}

/** Decodes an oct-encoded unit vector (two bytes) into out[0..2]. */
export function octDecode(x: number, y: number, out: [number, number, number]) {
  let fx = (x / 255) * 2 - 1;
  let fy = (y / 255) * 2 - 1;
  const fz = 1 - Math.abs(fx) - Math.abs(fy);
  if (fz < 0) {
    const ox = fx;
    fx = (1 - Math.abs(fy)) * (ox >= 0 ? 1 : -1);
    fy = (1 - Math.abs(ox)) * (fy >= 0 ? 1 : -1);
  }
  const len = Math.hypot(fx, fy, fz);
  out[0] = fx / len;
  out[1] = fy / len;
  out[2] = fz / len;
  return out;
}
