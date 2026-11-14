import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PbfWriter } from 'pbf';
import { describe, expect, it } from 'vitest';
import { LocalFrame, mercatorX, mercatorY } from '@geo';
import { parseB3dm } from '../../src/world/buildings/b3dm';
import { parseReleaseFolder } from '../../src/world/buildings/BuildingLayer';
import { createDraco } from '../../src/world/buildings/draco';
import { buildFootprintTile } from '../../src/world/buildings/extrude';
import {
  SWISSBUILDINGS_GRID,
  cellBounds,
  cellIdAt,
  cellPath,
} from '../../src/world/buildings/grid';
import { KIND, unpackLook } from '../../src/world/buildings/mesh';
import { buildDetailTile, kindOf } from '../../src/world/buildings/tile3d';
import { unpack } from './buildings.helpers';

const require = createRequire(import.meta.url);
const fixture = (name: string) =>
  new Uint8Array(readFileSync(path.join(__dirname, 'fixtures', name)));
const dracoDir = path.dirname(
  require.resolve('three/examples/jsm/libs/draco/gltf/draco_decoder.wasm'),
);

describe('swissBUILDINGS3D tiles', () => {
  // A real cell from Bern's old town (2026-05-20 release): two houses, Draco geometry.
  const bytes = fixture('buildings-11-675-1163.b3dm');
  const cell = 1163 * 2048 + 675;

  it('parses the b3dm: feature table, batch table, Draco glTF', () => {
    const t = parseB3dm(bytes);
    expect(t.featureTable.BATCH_LENGTH).toBe(2);
    expect(t.featureTable.RTC_CENTER).toHaveLength(3);
    expect(t.batchTable.OBJEKTART).toEqual(['Gebaeude Einzelhaus', 'Gebaeude Einzelhaus']);
    expect(t.gltf.extensionsUsed).toContain('KHR_draco_mesh_compression');
    expect(t.bin.length).toBeGreaterThan(1000);
  });

  it('names its cell on the grid', () => {
    expect(cellPath(SWISSBUILDINGS_GRID, cell)).toBe('11/675/1163.b3dm');
    const b = cellBounds(SWISSBUILDINGS_GRID, cell);
    // The houses (batch table Longitude/Latitude) lie inside the cell.
    expect(cellIdAt(SWISSBUILDINGS_GRID, 7.455310855235018, 46.9443764637915)).toBe(cell);
    expect(b.east - b.west).toBeCloseTo(0.0022132782, 9);
    expect(b.north - b.south).toBeCloseTo(0.0009687133, 9);
  });

  it('builds the houses relative to their terrain point, at their real heights', async () => {
    const wrapper = readFileSync(path.join(dracoDir, 'draco_wasm_wrapper.js'), 'utf8');
    const wasm = readFileSync(path.join(dracoDir, 'draco_decoder.wasm'));
    const draco = await createDraco(wrapper, wasm, require);
    const t = parseB3dm(bytes);
    const m = buildDetailTile(t, draco, SWISSBUILDINGS_GRID, cell);
    expect(m.buildingCount).toBe(2);
    expect(m.indices.length % 3).toBe(0);
    // Highest vertex per building above its terrain point: DACH_MAX - GELAENDEPUNKT.
    const top = [-Infinity, -Infinity];
    let ground = 0;
    const u = unpack(m);
    for (let i = 0; i < m.vertexCount; i++) {
      const b = u.building[i]!;
      top[b] = Math.max(top[b]!, u.positions[3 * i + 1]!);
      if (u.ground[i]) ground++;
    }
    expect(top[0]).toBeCloseTo(550.27 - 543.79, 1);
    expect(top[1]).toBeCloseTo(552.05 - 545.13, 1);
    expect(ground).toBeGreaterThan(4);
    // The cell frame is centred on the cell: everything within half a cell (plus overhang).
    expect(Math.max(Math.abs(m.minX), Math.abs(m.maxX))).toBeLessThan(110);
    expect(Math.max(Math.abs(m.minZ), Math.abs(m.maxZ))).toBeLessThan(80);
    // Shared corners: far fewer vertices than three per triangle.
    expect(m.vertexCount).toBeLessThan(m.indices.length * 0.7);
  });

  it('tells churches, towers and walls apart', () => {
    expect(kindOf('Sakraler Turm', false, 50, false)).toBe(KIND.tower);
    expect(kindOf('Sakrales Gebaeude', false, 600, false)).toBe(KIND.church);
    expect(kindOf('Mauer gross', false, 30, false)).toBe(KIND.structure);
    expect(kindOf('Offenes Gebaeude', true, 200, false)).toBe(KIND.canopy);
    expect(kindOf('Gebaeude Einzelhaus', true, 900, false)).toBe(KIND.flat);
    expect(kindOf('Gebaeude Einzelhaus', false, 120, true)).toBe(KIND.chalet);
  });

  it('finds the dated release folder in the top tileset.json', () => {
    const json = { root: { children: [{ content: { uri: '20260520/tileset.json' } }] } };
    expect(parseReleaseFolder(json)).toBe('20260520/');
    expect(() => parseReleaseFolder({ root: {} })).toThrow();
  });
});

// ---- Footprint tiles: a minimal Mapbox Vector Tile written here ----

const zig = (n: number) => (n << 1) ^ (n >> 31);
const command = (id: number, count: number) => (count << 3) | (id & 7);

/** Encodes polygons (rings in tile units) into a `building` layer. */
function vectorTile(
  features: Array<{
    rings: Array<Array<[number, number]>>;
    props: Record<string, string | number>;
  }>,
): Uint8Array {
  const keys: string[] = [];
  const values: Array<string | number> = [];
  const pbf = new PbfWriter();
  pbf.writeMessage(
    3,
    (_: unknown, p: PbfWriter) => {
      p.writeVarintField(15, 2);
      p.writeStringField(1, 'building');
      for (const f of features) {
        p.writeMessage(
          2,
          (_: unknown, q: PbfWriter) => {
            const tags: number[] = [];
            for (const [k, v] of Object.entries(f.props)) {
              let ki = keys.indexOf(k);
              if (ki < 0) ki = keys.push(k) - 1;
              let vi = values.indexOf(v);
              if (vi < 0) vi = values.push(v) - 1;
              tags.push(ki, vi);
            }
            q.writePackedVarint(2, tags);
            q.writeVarintField(3, 3);
            const geom: number[] = [];
            let cx = 0;
            let cy = 0;
            for (const ring of f.rings) {
              const [x0, y0] = ring[0]!;
              geom.push(command(1, 1), zig(x0 - cx), zig(y0 - cy));
              cx = x0;
              cy = y0;
              geom.push(command(2, ring.length - 1));
              for (const [x, y] of ring.slice(1)) {
                geom.push(zig(x - cx), zig(y - cy));
                cx = x;
                cy = y;
              }
              geom.push(command(7, 1));
            }
            q.writePackedVarint(4, geom);
          },
          undefined,
        );
      }
      for (const k of keys) p.writeStringField(3, k);
      for (const v of values)
        p.writeMessage(
          4,
          (_: unknown, q: PbfWriter) => {
            if (typeof v === 'string') q.writeStringField(1, v);
            else q.writeSVarintField(6, v);
          },
          undefined,
        );
      p.writeVarintField(5, 4096);
    },
    undefined,
  );
  return pbf.finish();
}

describe('footprint tiles', () => {
  // The zoom-14 tile over Bern's old town.
  const key = {
    z: 14,
    x: Math.floor(mercatorX(7.451, 14)),
    y: Math.floor(mercatorY(46.948, 14)),
  };
  // Clockwise squares in tile units (y down): a house, and one with a courtyard.
  const square = (x: number, y: number, s: number): Array<[number, number]> => [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
    [x, y],
  ];
  const bytes = vectorTile([
    { rings: [square(1000, 1000, 30)], props: { render_height: 12, class: 'roof' } },
    { rings: [square(2000, 2000, 25)], props: { render_height: 9 } },
    {
      rings: [square(3000, 1000, 120), square(3040, 1040, 40).reverse()],
      props: { render_height: 20 },
    },
    // Cut by the server's buffer: clipped to the tile, kept.
    { rings: [square(4080, 500, 40)], props: { render_height: 8 } },
    // Within the buffer, centre outside: belongs to the neighbour.
    { rings: [square(4094, 900, 8)], props: { render_height: 8 } },
  ]);

  it('extrudes every building that belongs to the tile, to its height', () => {
    const t = buildFootprintTile(bytes, { key, lod: 0, elevation: [], grid: SWISSBUILDINGS_GRID });
    expect(t.mesh.buildingCount).toBe(4);
    expect(t.mesh.maxY).toBeCloseTo(20, 6);
    // Walls start below the ground point.
    expect(t.mesh.minY).toBeLessThan(0);
    expect(t.cells.length).toBeGreaterThan(0);
    for (const c of t.cells) expect(c).toBeLessThan(2048 * 2048);
    // The canopy (class "roof") floats: none of its vertices are on the ground.
    const u = unpack(t.mesh);
    const canopy = Array.from({ length: t.mesh.vertexCount }, (_, i) => i).filter(
      (i) => u.building[i] === 0,
    );
    expect(canopy.length).toBeGreaterThan(0);
    expect(canopy.every((i) => !u.ground[i])).toBe(true);
  });

  it('builds far tiles leaner', () => {
    const near = buildFootprintTile(bytes, {
      key,
      lod: 0,
      elevation: [],
      grid: SWISSBUILDINGS_GRID,
    });
    const far = buildFootprintTile(bytes, {
      key,
      lod: 3,
      elevation: [],
      grid: SWISSBUILDINGS_GRID,
    });
    expect(far.mesh.indices.length).toBeLessThan(near.mesh.indices.length);
    expect(far.mesh.maxY).toBeLessThan(near.mesh.maxY + 1e-6);
  });

  it('keeps the look of a building whatever the build', () => {
    const builds = ([0, 1, 2] as const).map(
      (lod) =>
        buildFootprintTile(bytes, { key, lod, elevation: [], grid: SWISSBUILDINGS_GRID }).mesh,
    );
    const looks = builds.map((m) =>
      Array.from(m.starts.subarray(0, m.buildingCount), (v) => unpackLook(m.look, 4 * v)),
    );
    expect(looks[0]!.length).toBe(4);
    for (const l of looks.slice(1)) expect(l).toEqual(looks[0]);
  });

  it('places buildings in the tile frame where the tile says', () => {
    const t = buildFootprintTile(bytes, { key, lod: 0, elevation: [], grid: SWISSBUILDINGS_GRID });
    // Tile frame at the tile centre: x within half a tile width (about 830 m here).
    expect(t.mesh.maxX).toBeLessThan(900);
    expect(t.mesh.minX).toBeGreaterThan(-900);
    const f = new LocalFrame(0, 0, 0);
    expect(f).toBeDefined();
  });
});
