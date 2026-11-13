import { LocalFrame } from '@geo';
import { type B3dm, meshInstances, readAccessor } from './b3dm';
import { type DracoModule, decodeDraco } from './draco';
import { cellBounds, type CellGrid } from './grid';
import { FLAG_GROUND, KIND, type MeshData, MeshBuilder } from './mesh';
import { colours, seedAt } from './style';

/** What a swissBUILDINGS3D object type (OBJEKTART) looks like here. */
export function kindOf(objektart: unknown, flatRoof: boolean, area: number, alpine: boolean) {
  const t = typeof objektart === 'string' ? objektart : '';
  if (/Turm|Schornstein|Kamin/i.test(t)) return KIND.tower;
  if (/Sakral|Kirch|Kapelle|Kloster/i.test(t)) return KIND.church;
  if (/Offen|Flugdach|gedeckt/i.test(t)) return KIND.canopy;
  if (/Treibhaus/i.test(t)) return KIND.greenhouse;
  if (/Mauer|Tank|Silo|Schacht|Bruecke|Brücke|Kuehl|Kühl|Ruine/i.test(t))
    return KIND.structure;
  if (/Hochhaus/i.test(t) || (flatRoof && area > 250)) return KIND.flat;
  if (alpine) return KIND.chalet;
  return KIND.house;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * A swissBUILDINGS3D cell as one mesh in the cell's tangent frame (origin at the cell centre
 * on the ellipsoid). Vertex heights are made relative to each building's terrain point
 * (GELAENDEPUNKT), so the layer can stand the building on the drawn terrain whatever height
 * system the data uses; the data's own heights are sea-level heights written as if they
 * were ellipsoidal (the tile tops match DACH_MAX exactly), about 50 m below the true
 * ellipsoidal heights in Switzerland.
 */
export function buildDetailTile(
  tile: B3dm,
  draco: DracoModule | undefined,
  grid: CellGrid,
  cell: number,
): MeshData {
  const b = cellBounds(grid, cell);
  const frame = new LocalFrame((b.west + b.east) / 2, (b.south + b.north) / 2, 0);
  const rtc = tile.featureTable.RTC_CENTER ?? [0, 0, 0];
  const g = tile.gltf;

  // Every triangle in the cell frame, with the building it belongs to.
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const batch: number[] = [];
  const tris: number[] = [];
  const p = { x: 0, y: 0, z: 0 };
  for (const inst of meshInstances(g)) {
    const m = inst.matrix;
    for (const prim of g.meshes[inst.mesh]?.primitives ?? []) {
      if (prim.mode !== undefined && prim.mode !== 4) continue;
      let pos: Float32Array;
      let ids: Float32Array | undefined;
      let idx: Uint32Array;
      const ext = prim.extensions?.KHR_draco_mesh_compression;
      if (ext) {
        if (!draco) throw new Error('b3dm: Draco geometry but no decoder');
        const bv = g.bufferViews[ext.bufferView]!;
        const data = tile.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
        const wanted: Record<string, number> = { POSITION: ext.attributes.POSITION! };
        if (ext.attributes._BATCHID !== undefined) wanted._BATCHID = ext.attributes._BATCHID;
        const d = decodeDraco(draco, data, wanted);
        pos = d.attributes.POSITION!.array;
        ids = d.attributes._BATCHID?.array;
        idx = d.indices;
      } else {
        pos = readAccessor(g, tile.bin, prim.attributes.POSITION!);
        const bi = prim.attributes._BATCHID;
        ids = bi !== undefined ? readAccessor(g, tile.bin, bi) : undefined;
        idx =
          prim.indices !== undefined
            ? Uint32Array.from(readAccessor(g, tile.bin, prim.indices))
            : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      }
      const base = xs.length;
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i]!;
        const y = pos[i + 1]!;
        const z = pos[i + 2]!;
        const gx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
        const gy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
        const gz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
        // glTF is y-up; 3D Tiles are z-up: (x, y, z) -> (x, -z, y), then the RTC centre.
        p.x = gx + rtc[0]!;
        p.y = -gz + rtc[1]!;
        p.z = gy + rtc[2]!;
        frame.toLocal(p, p);
        xs.push(p.x);
        ys.push(p.y);
        zs.push(p.z);
        batch.push(ids ? Math.round(ids[i / 3]!) : 0);
      }
      for (let i = 0; i < idx.length; i++) tris.push(base + idx[i]!);
    }
  }

  // Per building: extent, lowest point, triangles.
  const bt = tile.batchTable;
  let count = tile.featureTable.BATCH_LENGTH ?? 0;
  for (const id of batch) if (id + 1 > count) count = id + 1;
  const info = Array.from({ length: count }, () => ({
    x0: Infinity,
    x1: -Infinity,
    z0: Infinity,
    z1: -Infinity,
    y0: Infinity,
    tris: [] as number[],
  }));
  for (let i = 0; i < xs.length; i++) {
    const s = info[batch[i]!]!;
    s.x0 = Math.min(s.x0, xs[i]!);
    s.x1 = Math.max(s.x1, xs[i]!);
    s.z0 = Math.min(s.z0, zs[i]!);
    s.z1 = Math.max(s.z1, zs[i]!);
    s.y0 = Math.min(s.y0, ys[i]!);
  }
  for (let t = 0; t < tris.length; t += 3) info[batch[tris[t]!]!]!.tris.push(t);

  const out = new MeshBuilder();
  const geo = { lon: 0, lat: 0, h: 0 };
  const q = { x: 0, y: 0, z: 0 };
  for (let k = 0; k < count; k++) {
    const s = info[k]!;
    if (!s.tris.length) continue;
    const ax = (s.x0 + s.x1) / 2;
    const az = (s.z0 + s.z1) / 2;
    frame.toGeodetic({ x: ax, y: 0, z: az }, geo);
    // The terrain point is a sea-level height; written in the data's convention (as if it
    // were ellipsoidal) it lands in the same frame as the vertices.
    const terrain = num(bt.GELAENDEPUNKT?.[k]);
    const groundY = terrain !== undefined ? frame.fromGeodetic(geo.lon, geo.lat, terrain, q).y : s.y0;
    const roofMax = num(bt.DACH_MAX?.[k]);
    const roofMin = num(bt.DACH_MIN?.[k]);
    const flat = roofMax !== undefined && roofMin !== undefined && roofMax - roofMin < 1;
    const area = (s.x1 - s.x0) * (s.z1 - s.z0);
    const alpine = (terrain ?? 0) > 1000;
    const kind = kindOf(bt.OBJEKTART?.[k], flat, area, alpine);
    const seed = seedAt(geo.lon * 1e5, geo.lat * 1e5);
    const { roof, wall } = colours(kind, seed, alpine);
    const eave = roofMin !== undefined && terrain !== undefined ? roofMin - terrain : 1e3;
    out.begin({ anchorX: ax, anchorZ: az, cell: -1, seed, roof, wall, kind, eave });
    // Bottom vertices (at or below the terrain point) follow the drawn terrain under them.
    const v = (i: number) => {
      const y = ys[i]! - groundY;
      return out.vertex(xs[i]!, y, zs[i]!, y < 0.3 ? FLAG_GROUND : 0);
    };
    for (const t of s.tris) out.rawTriangle(v(tris[t]!), v(tris[t + 1]!), v(tris[t + 2]!));
  }
  return out.finish();
}
