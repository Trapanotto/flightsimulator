import {
  type EnuFrame,
  type Vec3,
  ecefDirToLocal,
  ecefToLocal,
  geodeticToEcef,
} from '../geo/ellipsoid';
import type { GeoBounds } from '../geo/tiles';
import { buildHeightGrid } from './heightGrid';
import { QM_MAX, type QuantizedMesh, octDecode } from './quantizedMesh';

/** GPU-ready arrays for one terrain tile, positioned relative to `offset`. */
export interface TileMeshData {
  /** Tile centre in local game coordinates (metres from the world origin). */
  offset: Vec3;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Bounding sphere relative to offset. */
  sphereCenter: Vec3;
  sphereRadius: number;
  minHeight: number;
  maxHeight: number;
  /** GRID x GRID heights in metres, row 0 = south. See heightGrid.ts. */
  heights: Float32Array;
}

/**
 * Turns a decoded tile into local-space geometry.
 * Vertices are stored relative to the tile centre so float32 keeps cm precision.
 * Skirts (short walls hanging down from every edge) hide cracks between LODs.
 */
export function buildTileMesh(qm: QuantizedMesh, bounds: GeoBounds, frame: EnuFrame): TileMeshData {
  const n = qm.vertexCount;
  const edges = [
    sortEdge(qm.west, qm.v),
    sortEdge(qm.south, qm.u),
    sortEdge(qm.east, qm.v),
    sortEdge(qm.north, qm.u),
  ];
  const skirtCount = edges.reduce((s, e) => s + e.length, 0);
  const total = n + skirtCount;

  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);

  const offset = ecefToLocal(frame, ...qm.center);
  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  const hSpan = qm.maxHeight - qm.minHeight;
  // Skirt depth grows with tile size; ~1.5 % of the tile width.
  const widthMeters =
    lonSpan * 111320 * Math.cos(((bounds.south + bounds.north) / 2) * (Math.PI / 180));
  const skirt = Math.max(10, widthMeters * 0.015);

  const ecef: Vec3 = [0, 0, 0];
  const local: Vec3 = [0, 0, 0];
  const nrm: Vec3 = [0, 0, 0];
  const lonLat = new Float64Array(n * 3);

  const writeVertex = (dst: number, src: number, heightDrop: number) => {
    const lon = lonLat[src * 3]!;
    const lat = lonLat[src * 3 + 1]!;
    const h = lonLat[src * 3 + 2]! - heightDrop;
    geodeticToEcef(lon, lat, h, ecef);
    ecefToLocal(frame, ecef[0], ecef[1], ecef[2], local);
    positions[dst * 3] = local[0] - offset[0];
    positions[dst * 3 + 1] = local[1] - offset[1];
    positions[dst * 3 + 2] = local[2] - offset[2];
    uvs[dst * 2] = qm.u[src]! / QM_MAX;
    // Texture rows run north -> south and are uploaded without flipY.
    uvs[dst * 2 + 1] = 1 - qm.v[src]! / QM_MAX;
  };

  for (let i = 0; i < n; i++) {
    lonLat[i * 3] = bounds.west + (qm.u[i]! / QM_MAX) * lonSpan;
    lonLat[i * 3 + 1] = bounds.south + (qm.v[i]! / QM_MAX) * latSpan;
    lonLat[i * 3 + 2] = qm.minHeight + (qm.h[i]! / QM_MAX) * hSpan;
    writeVertex(i, i, 0);
    if (qm.octNormals) {
      octDecode(qm.octNormals[i * 2]!, qm.octNormals[i * 2 + 1]!, nrm);
      ecefDirToLocal(frame, nrm[0], nrm[1], nrm[2], local);
      normals.set(local, i * 3);
    }
  }
  if (!qm.octNormals) computeNormals(positions, qm.indices, n, normals);

  // Skirt vertices copy their edge vertex, lowered by `skirt`.
  let next = n;
  const skirtIndexOf: Uint32Array[] = [];
  for (const edge of edges) {
    const map = new Uint32Array(edge.length);
    for (let k = 0; k < edge.length; k++) {
      const src = edge[k]!;
      writeVertex(next, src, skirt);
      normals[next * 3] = normals[src * 3]!;
      normals[next * 3 + 1] = normals[src * 3 + 1]!;
      normals[next * 3 + 2] = normals[src * 3 + 2]!;
      map[k] = next++;
    }
    skirtIndexOf.push(map);
  }

  // Each skirt quad is emitted with both windings so it is visible from either side.
  const skirtTris = edges.reduce((s, e) => s + Math.max(0, e.length - 1) * 4, 0);
  const indexCount = qm.indices.length + skirtTris * 3;
  const indices = total > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  indices.set(qm.indices);
  let w = qm.indices.length;
  edges.forEach((edge, ei) => {
    const map = skirtIndexOf[ei]!;
    for (let k = 0; k + 1 < edge.length; k++) {
      const a = edge[k]!;
      const b = edge[k + 1]!;
      const as = map[k]!;
      const bs = map[k + 1]!;
      indices[w++] = a;
      indices[w++] = b;
      indices[w++] = as;
      indices[w++] = b;
      indices[w++] = bs;
      indices[w++] = as;
      indices[w++] = a;
      indices[w++] = as;
      indices[w++] = b;
      indices[w++] = b;
      indices[w++] = as;
      indices[w++] = bs;
    }
  });

  const sphereCenter = ecefToLocal(frame, ...qm.boundingSphere.center);
  sphereCenter[0] -= offset[0];
  sphereCenter[1] -= offset[1];
  sphereCenter[2] -= offset[2];

  return {
    offset,
    positions,
    normals,
    uvs,
    indices,
    sphereCenter,
    sphereRadius: qm.boundingSphere.radius + skirt,
    minHeight: qm.minHeight,
    maxHeight: qm.maxHeight,
    heights: buildHeightGrid(qm),
  };
}

function sortEdge(edge: Uint16Array | Uint32Array, key: Uint16Array): Uint32Array {
  const out = Uint32Array.from(edge);
  out.sort((a, b) => key[a]! - key[b]!);
  return out;
}

function computeNormals(
  pos: Float32Array,
  idx: Uint16Array | Uint32Array,
  n: number,
  out: Float32Array,
) {
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]! * 3;
    const b = idx[i + 1]! * 3;
    const c = idx[i + 2]! * 3;
    const e1x = pos[b]! - pos[a]!;
    const e1y = pos[b + 1]! - pos[a + 1]!;
    const e1z = pos[b + 2]! - pos[a + 2]!;
    const e2x = pos[c]! - pos[a]!;
    const e2y = pos[c + 1]! - pos[a + 1]!;
    const e2z = pos[c + 2]! - pos[a + 2]!;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      out[v] = out[v]! + nx;
      out[v + 1] = out[v + 1]! + ny;
      out[v + 2] = out[v + 2]! + nz;
    }
  }
  for (let i = 0; i < n; i++) {
    const x = out[i * 3]!;
    const y = out[i * 3 + 1]!;
    const z = out[i * 3 + 2]!;
    // Terrain normals must point up; flip if the triangle winding was the other way.
    const len = Math.hypot(x, y, z) * (y < 0 ? -1 : 1) || 1;
    out[i * 3] = x / len;
    out[i * 3 + 1] = y / len;
    out[i * 3 + 2] = z / len;
  }
}
