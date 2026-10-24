/**
 * Decoder for the Cesium quantized-mesh-1.0 terrain format.
 *
 * Reference:
 * https://github.com/CesiumGS/quantized-mesh
 */

export interface DecodedTerrainMesh {
  vertexCount: number;
  triangleCount: number;
  minHeight: number;
  maxHeight: number;
  u: Uint16Array;
  v: Uint16Array;
  height: Uint16Array;
  indices: Uint32Array;
  edges: {
    west: Uint16Array;
    south: Uint16Array;
    east: Uint16Array;
    north: Uint16Array;
  };
  /** Two oct-encoded bytes per vertex, if the tile contains normals. */
  normals?: Uint8Array;
  metadata?: unknown;
}

const HEADER_BYTES = 88;

function zigZagDecode(value: number): number {
  return (value >> 1) ^ -(value & 1);
}

function decodeDeltas(
  view: DataView,
  start: number,
  count: number,
): { values: Uint16Array; offset: number } {
  const values = new Uint16Array(count);
  let offset = start;
  let current = 0;

  for (let i = 0; i < count; i++) {
    const encoded = view.getUint16(offset, true);
    offset += 2;
    current += zigZagDecode(encoded);
    if (current < 0 || current > 32767) {
      throw new Error(
        `Invalid quantized-mesh delta at vertex ${i}: ${current}`,
      );
    }
    values[i] = current;
  }

  return { values, offset };
}

function decodeIndices(
  view: DataView,
  start: number,
  count: number,
  indexBytes: 2 | 4,
): { values: Uint32Array; offset: number } {
  const values = new Uint32Array(count);
  let offset = start;
  let highest = 0;

  for (let i = 0; i < count; i++) {
    const code =
      indexBytes === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true);
    offset += indexBytes;

    const index = highest - code;
    if (index < 0) {
      throw new Error(`Invalid high-water-mark index at ${i}`);
    }
    values[i] = index;
    if (code === 0) {
      highest++;
    }
  }

  return { values, offset };
}

function decodeEdge(
  view: DataView,
  start: number,
  indexBytes: 2 | 4,
): { values: Uint16Array; offset: number } {
  const count = view.getUint32(start, true);
  let offset = start + 4;
  const values = new Uint16Array(count);

  for (let i = 0; i < count; i++) {
    values[i] =
      indexBytes === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true);
    offset += indexBytes;
  }

  return { values, offset };
}

export function decodeQuantizedMesh(buffer: ArrayBuffer): DecodedTerrainMesh {
  if (buffer.byteLength < HEADER_BYTES + 4) {
    throw new Error('Quantized-mesh tile is too small');
  }

  const view = new DataView(buffer);
  const minHeight = view.getFloat32(24, true);
  const maxHeight = view.getFloat32(28, true);

  let offset = HEADER_BYTES;
  const vertexCount = view.getUint32(offset, true);
  offset += 4;

  if (vertexCount <= 0 || vertexCount > 4_000_000) {
    throw new Error(`Unreasonable vertex count: ${vertexCount}`);
  }

  const uResult = decodeDeltas(view, offset, vertexCount);
  const vResult = decodeDeltas(view, uResult.offset, vertexCount);
  const hResult = decodeDeltas(view, vResult.offset, vertexCount);
  offset = hResult.offset;

  const indexBytes: 2 | 4 = vertexCount > 65_536 ? 4 : 2;
  offset = (offset + (indexBytes - 1)) & ~(indexBytes - 1);

  if (offset + 4 > buffer.byteLength) {
    throw new Error('Truncated quantized-mesh index data');
  }

  const triangleCount = view.getUint32(offset, true);
  offset += 4;

  if (triangleCount > 4_000_000) {
    throw new Error(`Unreasonable triangle count: ${triangleCount}`);
  }

  const indexResult = decodeIndices(
    view,
    offset,
    triangleCount * 3,
    indexBytes,
  );
  offset = indexResult.offset;

  const west = decodeEdge(view, offset, indexBytes);
  offset = west.offset;
  const south = decodeEdge(view, offset, indexBytes);
  offset = south.offset;
  const east = decodeEdge(view, offset, indexBytes);
  offset = east.offset;
  const north = decodeEdge(view, offset, indexBytes);
  offset = north.offset;

  const edges = {
    west: west.values,
    south: south.values,
    east: east.values,
    north: north.values,
  };

  let normals: Uint8Array | undefined;
  let metadata: unknown;

  // Extensions may be padded to a 4-byte boundary.
  let extOffset = offset;
  let triedAlignment = false;

  while (extOffset + 5 <= buffer.byteLength) {
    const id = view.getUint8(extOffset);
    const length = view.getUint32(extOffset + 1, true);
    const payloadStart = extOffset + 5;

    if (length > buffer.byteLength - payloadStart) {
      if (!triedAlignment) {
        const aligned = (extOffset + 3) & ~3;
        if (aligned !== extOffset && aligned + 5 <= buffer.byteLength) {
          extOffset = aligned;
          triedAlignment = true;
          continue;
        }
      }
      break;
    }

    if (id === 1 && length === vertexCount * 2) {
      normals = new Uint8Array(buffer, payloadStart, length);
    } else if (id === 4 && length >= 4) {
      const jsonLength = view.getUint32(payloadStart, true);
      const text = new TextDecoder()
        .decode(
          new Uint8Array(
            buffer,
            payloadStart + 4,
            Math.min(jsonLength, length - 4),
          ),
        )
        .replace(/\0+$/, '');
      try {
        metadata = JSON.parse(text);
      } catch {
        metadata = text;
      }
    }

    extOffset = payloadStart + length;
  }

  return {
    vertexCount,
    triangleCount,
    minHeight,
    maxHeight,
    u: uResult.values,
    v: vResult.values,
    height: hResult.values,
    indices: indexResult.values,
    edges,
    normals,
    metadata,
  };
}
