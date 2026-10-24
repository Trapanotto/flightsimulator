import type { GeoBounds } from '../geo/tiles';
import { EnuFrame } from '../geo/wgs84';
import type { DecodedTerrainMesh } from './quantizedMesh';

export interface BuiltTerrainMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  hasNormals: boolean;
  vertexCount: number;
  triangleCount: number;
  minHeight: number;
  maxHeight: number;
  bounds: GeoBounds;
}

const MAX_QUANT = 32767;

function decodeOctNormal(x: number, y: number) {
  let nx = (x / 255) * 2 - 1;
  let ny = (y / 255) * 2 - 1;
  const nz = 1 - Math.abs(nx) - Math.abs(ny);

  if (nz < 0) {
    const ox = nx;
    nx = (1 - Math.abs(ny)) * (ox >= 0 ? 1 : -1);
    ny = (1 - Math.abs(ox)) * (ny >= 0 ? 1 : -1);
  }

  const length = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / length, y: ny / length, z: nz / length };
}

function sortedEdge(
  edge: Uint16Array,
  axis: 'u' | 'v',
  u: Uint16Array,
  v: Uint16Array,
): Uint16Array {
  return Uint16Array.from(edge).sort((a, b) =>
    axis === 'u' ? u[a] - u[b] : v[a] - v[b],
  );
}

/**
 * Converts quantized-mesh vertices into a Three.js-ready ENU mesh, including
 * vertical skirts that hide cracks at LOD boundaries.
 */
export function buildTerrainMesh(
  decoded: DecodedTerrainMesh,
  bounds: GeoBounds,
  frame: EnuFrame,
  skirtDepth = 140,
): BuiltTerrainMesh {
  const { vertexCount, minHeight, maxHeight, u, v, height, normals } = decoded;
  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  const hasNormals = Boolean(normals);

  const edgeSets = [
    sortedEdge(decoded.edges.west, 'v', u, v),
    sortedEdge(decoded.edges.east, 'v', u, v),
    sortedEdge(decoded.edges.south, 'u', u, v),
    sortedEdge(decoded.edges.north, 'u', u, v),
  ];
  const edgeVertexCount = edgeSets.reduce((sum, edge) => sum + edge.length, 0);

  const positions = new Float32Array((vertexCount + edgeVertexCount) * 3);
  const normalArray = new Float32Array((vertexCount + edgeVertexCount) * 3);
  const uvs = new Float32Array((vertexCount + edgeVertexCount) * 2);
  const skirtTriangles = edgeSets.reduce(
    (sum, edge) => sum + Math.max(0, edge.length - 1) * 4,
    0,
  );
  const indices = new Uint32Array(decoded.indices.length + skirtTriangles * 3);

  for (let i = 0; i < vertexCount; i++) {
    const lon = bounds.west + (u[i] / MAX_QUANT) * lonSpan;
    const lat = bounds.south + (v[i] / MAX_QUANT) * latSpan;
    const h = minHeight + (height[i] / MAX_QUANT) * (maxHeight - minHeight);
    const enu = frame.toEnu(lon, lat, h);

    positions[i * 3] = enu.e;
    positions[i * 3 + 1] = enu.u;
    positions[i * 3 + 2] = -enu.n;

    uvs[i * 2] = u[i] / MAX_QUANT;
    uvs[i * 2 + 1] = v[i] / MAX_QUANT;

    if (normals) {
      const n = decodeOctNormal(normals[i * 2], normals[i * 2 + 1]);
      const rotated = frame.directionToEnu(n.x, n.y, n.z);
      normalArray[i * 3] = rotated.e;
      normalArray[i * 3 + 1] = rotated.u;
      normalArray[i * 3 + 2] = -rotated.n;
    }
  }

  indices.set(decoded.indices, 0);
  let writeIndex = decoded.indices.length;
  let nextVertex = vertexCount;

  for (const edge of edgeSets) {
    if (edge.length < 2) continue;

    const skirtStart = nextVertex;
    for (let i = 0; i < edge.length; i++) {
      const source = edge[i];
      const target = nextVertex++;
      positions[target * 3] = positions[source * 3];
      positions[target * 3 + 1] = positions[source * 3 + 1] - skirtDepth;
      positions[target * 3 + 2] = positions[source * 3 + 2];
      uvs[target * 2] = uvs[source * 2];
      uvs[target * 2 + 1] = uvs[source * 2 + 1];
      normalArray[target * 3] = normalArray[source * 3];
      normalArray[target * 3 + 1] = normalArray[source * 3 + 1];
      normalArray[target * 3 + 2] = normalArray[source * 3 + 2];
    }

    for (let i = 0; i < edge.length - 1; i++) {
      const a = edge[i];
      const b = edge[i + 1];
      const sa = skirtStart + i;
      const sb = skirtStart + i + 1;

      // Both windings: the skirt is visible from inside and outside.
      indices[writeIndex++] = a;
      indices[writeIndex++] = sa;
      indices[writeIndex++] = sb;
      indices[writeIndex++] = a;
      indices[writeIndex++] = sb;
      indices[writeIndex++] = b;

      indices[writeIndex++] = a;
      indices[writeIndex++] = sb;
      indices[writeIndex++] = sa;
      indices[writeIndex++] = a;
      indices[writeIndex++] = b;
      indices[writeIndex++] = sb;
    }
  }

  return {
    positions,
    normals: normalArray,
    uvs,
    indices,
    hasNormals,
    vertexCount: vertexCount + edgeVertexCount,
    triangleCount: indices.length / 3,
    minHeight,
    maxHeight,
    bounds,
  };
}
