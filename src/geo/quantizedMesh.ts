/**
 * Decoder for Cesium quantized-mesh-1.0 terrain tiles
 * (https://github.com/CesiumGS/quantized-mesh) as served by swisstopo. Pure function: runs in a
 * worker and in tests. All values little endian.
 */

export interface QuantizedMesh {
  /** Tile centre, ECEF metres (as computed by the server; heights there are above sea level). */
  center: [number, number, number];
  minHeight: number;
  maxHeight: number;
  boundingSphere: { center: [number, number, number]; radius: number };
  horizonOcclusionPoint: [number, number, number];
  vertexCount: number;
  /** 0..32767, west -> east. */
  u: Uint16Array;
  /** 0..32767, south -> north. */
  v: Uint16Array;
  /** 0..32767, minHeight -> maxHeight. */
  h: Uint16Array;
  /** Counter-clockwise triangles seen from above. */
  indices: Uint16Array | Uint32Array;
  west: Uint16Array | Uint32Array;
  south: Uint16Array | Uint32Array;
  east: Uint16Array | Uint32Array;
  north: Uint16Array | Uint32Array;
  /** Oct-encoded normals, 2 bytes per vertex (extension 1), if the server sent them. */
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
  if (buffer.byteLength < HEADER_BYTES + 4) throw new Error('quantized-mesh: too short');

  const center: [number, number, number] = [f64(), f64(), f64()];
  const minHeight = f32();
  const maxHeight = f32();
  const bsCenter: [number, number, number] = [f64(), f64(), f64()];
  const bsRadius = f64();
  const horizonOcclusionPoint: [number, number, number] = [f64(), f64(), f64()];

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
    for (let i = 0; i < count; i++)
      arr[i] = wide ? view.getUint32(o + i * 4, true) : view.getUint16(o + i * 2, true);
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
    if (id === EXT_OCT_NORMALS && len === vertexCount * 2)
      octNormals = new Uint8Array(buffer.slice(o, o + len));
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
