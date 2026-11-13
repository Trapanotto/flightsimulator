import {
  LocalFrame,
  QM_MAX,
  type QuantizedMesh,
  type TileKey,
  geoTileBounds,
  geoTileWidthMetres,
  geoidUndulation,
} from '@geo';

/**
 * GPU-ready arrays of one terrain tile. Pure function of the decoded tile: runs in the worker,
 * tested in Node.
 *
 * Vertices are stored in the tile's own tangent frame (x east, y up, z south at the tile centre),
 * not in render space: float32 keeps millimetres within a tile, and moving the render origin
 * only changes the tile's model matrix, never its vertices.
 */
export interface TileGeometry {
  /** Origin of the tile frame: lon/lat in degrees, height above the ellipsoid. */
  origin: { lon: number; lat: number; h: number };
  positions: Float32Array;
  normals: Float32Array;
  /** Texture coordinates, v = 0 at the north edge (textures are uploaded without flipping). */
  uvs: Float32Array;
  /** Height above sea level per vertex (snow line, rock, ...). */
  elevations: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Number of indices of the surface itself; skirt triangles follow. */
  surfaceIndexCount: number;
  /** Ellipsoid heights of the surface vertices (no skirts), for exact height queries. */
  heights: Float32Array;
  /** Height range above the ellipsoid, metres. */
  minHeight: number;
  maxHeight: number;
}

/** Skirt depth: deep enough to close cracks against a coarser neighbour on steep ground. */
export function skirtDepth(key: TileKey): number {
  return Math.max(8, geoTileWidthMetres(key) * 0.03);
}

export function buildTileGeometry(qm: QuantizedMesh, key: TileKey): TileGeometry {
  const b = geoTileBounds(key);
  const n = qm.vertexCount;
  const lonSpan = b.east - b.west;
  const latSpan = b.north - b.south;
  const hSpan = qm.maxHeight - qm.minHeight;
  const midLon = (b.west + b.east) / 2;
  const midLat = (b.south + b.north) / 2;
  const undulationMid = geoidUndulation(midLon, midLat);
  const origin = { lon: midLon, lat: midLat, h: (qm.minHeight + qm.maxHeight) / 2 + undulationMid };
  const frame = new LocalFrame(origin.lon, origin.lat, origin.h);

  const edges = [
    sortedEdge(qm.west, qm.v),
    sortedEdge(qm.south, qm.u),
    sortedEdge(qm.east, qm.v),
    sortedEdge(qm.north, qm.u),
  ];
  const skirtCount = edges.reduce((s, e) => s + e.length, 0);
  const total = n + skirtCount;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  const elevations = new Float32Array(total);
  const heights = new Float32Array(n);
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  const p = { x: 0, y: 0, z: 0 };
  const place = (dst: number, src: number, drop: number) => {
    frame.fromGeodetic(lon[src]!, lat[src]!, heights[src]! - drop, p);
    positions[dst * 3] = p.x;
    positions[dst * 3 + 1] = p.y;
    positions[dst * 3 + 2] = p.z;
    uvs[dst * 2] = qm.u[src]! / QM_MAX;
    uvs[dst * 2 + 1] = 1 - qm.v[src]! / QM_MAX;
    elevations[dst] = elevations[src]!;
  };
  for (let i = 0; i < n; i++) {
    lon[i] = b.west + (qm.u[i]! / QM_MAX) * lonSpan;
    lat[i] = b.south + (qm.v[i]! / QM_MAX) * latSpan;
    const seaLevel = qm.minHeight + (qm.h[i]! / QM_MAX) * hSpan;
    elevations[i] = seaLevel;
    // swisstopo heights are above sea level; the world is placed on the ellipsoid.
    const h = seaLevel + geoidUndulation(lon[i]!, lat[i]!);
    heights[i] = h;
    if (h < minHeight) minHeight = h;
    if (h > maxHeight) maxHeight = h;
    place(i, i, 0);
  }

  let tris = qm.indices;
  if (upwardShare(positions, tris) < 0.5) tris = flipWinding(tris);
  computeNormals(positions, tris, n, normals);

  // Skirts: a copy of every edge vertex hanging down, so a coarser neighbour's edge (which may
  // lie above or below this one) never shows a gap.
  const drop = skirtDepth(key);
  let next = n;
  const skirtOf: Uint32Array[] = [];
  for (const edge of edges) {
    const map = new Uint32Array(edge.length);
    for (let k = 0; k < edge.length; k++) {
      const src = edge[k]!;
      place(next, src, drop);
      normals[next * 3] = normals[src * 3]!;
      normals[next * 3 + 1] = normals[src * 3 + 1]!;
      normals[next * 3 + 2] = normals[src * 3 + 2]!;
      map[k] = next++;
    }
    skirtOf.push(map);
  }

  const skirtTris = edges.reduce((s, e) => s + Math.max(0, e.length - 1) * 2, 0);
  const indexCount = tris.length + skirtTris * 3;
  const indices = total > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  indices.set(tris);
  let w = tris.length;
  const P = (i: number, k: number) => positions[i * 3 + k]!;
  edges.forEach((edge, e) => {
    const map = skirtOf[e]!;
    for (let k = 0; k + 1 < edge.length; k++) {
      const a = edge[k]!;
      const c = edge[k + 1]!;
      const as = map[k]!;
      const cs = map[k + 1]!;
      // Face the skirt outwards (away from the tile centre, the frame origin) so that it is
      // drawn when seen through a crack from outside the tile.
      const ux = P(c, 0) - P(a, 0);
      const uy = P(c, 1) - P(a, 1);
      const uz = P(c, 2) - P(a, 2);
      const vx = P(as, 0) - P(a, 0);
      const vy = P(as, 1) - P(a, 1);
      const vz = P(as, 2) - P(a, 2);
      const nx = uy * vz - uz * vy;
      const nz = ux * vy - uy * vx;
      if (nx * P(a, 0) + nz * P(a, 2) > 0) {
        indices.set([a, c, as, c, cs, as], w);
      } else {
        indices.set([a, as, c, c, as, cs], w);
      }
      w += 6;
    }
  });

  return {
    origin,
    positions,
    normals,
    uvs,
    elevations,
    indices,
    surfaceIndexCount: tris.length,
    heights,
    minHeight: minHeight - drop,
    maxHeight,
  };
}

function sortedEdge(edge: Uint16Array | Uint32Array, key: Uint16Array): Uint32Array {
  const out = Uint32Array.from(edge);
  out.sort((a, b) => key[a]! - key[b]!);
  return out;
}

/** Share of triangle area whose normal points up (y): tells the winding of the source data. */
function upwardShare(pos: Float32Array, idx: Uint16Array | Uint32Array): number {
  let up = 0;
  let all = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]! * 3;
    const b = idx[i + 1]! * 3;
    const c = idx[i + 2]! * 3;
    const ny =
      (pos[b + 2]! - pos[a + 2]!) * (pos[c]! - pos[a]!) -
      (pos[b]! - pos[a]!) * (pos[c + 2]! - pos[a + 2]!);
    all += Math.abs(ny);
    if (ny > 0) up += ny;
  }
  return all > 0 ? up / all : 1;
}

function flipWinding(idx: Uint16Array | Uint32Array): Uint16Array | Uint32Array {
  const out = idx.slice();
  for (let i = 0; i < out.length; i += 3) {
    out[i + 1] = idx[i + 2]!;
    out[i + 2] = idx[i + 1]!;
  }
  return out;
}

/** Area-weighted vertex normals; the sum of unnormalised face normals weights by area. */
function computeNormals(
  pos: Float32Array,
  idx: Uint16Array | Uint32Array,
  n: number,
  out: Float32Array,
) {
  const acc = new Float64Array(n * 3);
  for (let i = 0; i < idx.length; i += 3) {
    const ia = idx[i]!;
    const ib = idx[i + 1]!;
    const ic = idx[i + 2]!;
    const a = ia * 3;
    const b = ib * 3;
    const c = ic * 3;
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
      acc[v] = acc[v]! + nx;
      acc[v + 1] = acc[v + 1]! + ny;
      acc[v + 2] = acc[v + 2]! + nz;
    }
  }
  for (let i = 0; i < n; i++) {
    const x = acc[i * 3]!;
    const y = acc[i * 3 + 1]!;
    const z = acc[i * 3 + 2]!;
    const len = Math.hypot(x, y, z);
    if (len === 0) {
      out[i * 3 + 1] = 1;
      continue;
    }
    out[i * 3] = x / len;
    out[i * 3 + 1] = y / len;
    out[i * 3 + 2] = z / len;
  }
}
