import { BufferAttribute, BufferGeometry, Mesh, Scene } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { LocalFrame } from '@geo';
import {
  decodeLift,
  indexAttribute,
  releaseAfterUpload,
  storeLift,
} from '../../src/world/buildings/BuildingLayer';
import { orientedBox } from '../../src/world/buildings/footprint';
import { GroundGrid } from '../../src/world/buildings/groundGrid';
import {
  type BuildingRecord,
  FLAG_GROUND,
  KIND,
  MeshBuilder,
  NO_CELL,
  Q16,
  indexArray,
  packLook,
  quantise,
  unpackEave,
  unpackLook,
  vertexPosition,
} from '../../src/world/buildings/mesh';
import { BUILDING_PRESETS } from '../../src/world/buildings/presets';
import {
  type RoofShape,
  addSolid,
  roofBends,
  roofFacets,
  roofHeight,
  roofPlanes,
} from '../../src/world/buildings/roof';

const record = (o: Partial<BuildingRecord> = {}): BuildingRecord => ({
  anchorX: 0,
  anchorZ: 0,
  cell: -1,
  seed: 0.5,
  roof: [0.3, 0.1, 0.05],
  wall: [0.6, 0.6, 0.5],
  kind: KIND.house,
  eave: 6,
  ...o,
});

describe('16-bit vertex positions', () => {
  it('round-trip within half a step of the tile extent', () => {
    // A footprint tile is about 1.7 km across: steps of 2.6 cm, errors under 1.3 cm.
    const lo = -840;
    const range = 1680;
    let worst = 0;
    for (let i = 0; i <= 10_000; i++) {
      const v = lo + (range * i) / 10_000 + Math.sin(i) * 0.01;
      const back = lo + (quantise(v, lo, range) / Q16) * range;
      worst = Math.max(worst, Math.abs(back - v));
    }
    expect(worst).toBeLessThanOrEqual(range / Q16 / 2 + 1e-9);
    expect(worst).toBeLessThan(0.013);
    expect(quantise(lo - 5, lo, range)).toBe(0);
    expect(quantise(lo + range + 5, lo, range)).toBe(Q16);
    expect(quantise(3, 3, 0)).toBe(0);
  });

  it('decode a built tile back to its metres', () => {
    const m = new MeshBuilder();
    m.begin(record());
    const pts = [
      [-831.27, -1, 412.5],
      [829.9, 71.3, -410.02],
      [0.5, 12.25, 3.75],
    ] as const;
    for (const [x, y, z] of pts) m.vertex(x, y, z);
    const d = m.finish();
    const p = { x: 0, y: 0, z: 0 };
    pts.forEach(([x, y, z], i) => {
      vertexPosition(d, i, p);
      expect(Math.abs(p.x - x)).toBeLessThan(0.013);
      expect(Math.abs(p.y - y)).toBeLessThan(0.001);
      expect(Math.abs(p.z - z)).toBeLessThan(0.007);
    });
  });

  it('carry the lift in w, quantised to its own range', () => {
    const lift = new Float32Array([412.37, 455.9, 380.04, 2210.5]);
    const position = new Uint16Array(16);
    const mesh = { liftMin: 0, liftRange: 0 };
    storeLift(mesh, { position, vertexCount: 4 }, lift);
    expect(mesh.liftMin).toBeCloseTo(380.04, 4);
    // Even across 1800 m of relief within one tile the error stays under 2 cm.
    for (let i = 0; i < 4; i++)
      expect(Math.abs(decodeLift(mesh, { position }, i) - lift[i]!)).toBeLessThan(0.02);
    // x, y and z are left alone.
    expect(position[0]).toBe(0);
  });
});

describe('the look of a building in 16-bit words', () => {
  it('keeps colours to a 5:6:5 step, kind, seed, cell and eave', () => {
    const words = new Uint16Array(4);
    const look = {
      roof: [181, 74, 52] as [number, number, number],
      wall: [232, 226, 212] as [number, number, number],
      kind: KIND.structure,
      seed: 201,
      eave: 6.5,
      cellDx: 12,
      cellDy: 17,
    };
    packLook(look, words);
    const back = unpackLook(words);
    for (let c = 0; c < 3; c++) {
      // 5 bits: steps of 8.2 in 255; 6 bits for green: 4.0.
      expect(Math.abs(back.roof[c]! - look.roof[c]!)).toBeLessThanOrEqual(c === 1 ? 2.1 : 4.2);
      expect(Math.abs(back.wall[c]! - look.wall[c]!)).toBeLessThanOrEqual(c === 1 ? 2.1 : 4.2);
    }
    expect(back.kind).toBe(KIND.structure);
    expect(back.seed).toBe(201);
    expect(back.eave).toBe(6.5);
    expect([back.cellDx, back.cellDy]).toEqual([12, 17]);
  });

  it('marks buildings outside every 3D cell, and eaves too high to matter', () => {
    const words = new Uint16Array(4);
    packLook(
      {
        roof: [0, 0, 0],
        wall: [255, 255, 255],
        kind: 0,
        seed: 0,
        eave: 1e3,
        cellDx: -1,
        cellDy: -1,
      },
      words,
    );
    expect(words[2]! & 0x3ff).toBe(NO_CELL);
    expect(unpackLook(words).eave).toBe(1000);
    expect(unpackLook(words).cellDx).toBe(-1);
  });

  it('stores eave heights to half a metre up to 100 m, coarser above', () => {
    const words = new Uint16Array(4);
    for (const e of [0, 2.9, 7.25, 31, 99.4, 120, 180, 300]) {
      packLook(
        { roof: [0, 0, 0], wall: [0, 0, 0], kind: 0, seed: 0, eave: e, cellDx: 0, cellDy: 0 },
        words,
      );
      const back = unpackLook(words).eave;
      expect(Math.abs(back - e)).toBeLessThanOrEqual(e < 100 ? 0.25 : 2);
    }
    expect(unpackEave(255)).toBe(1000);
  });

  it('places footprint buildings in their cells relative to the tile', () => {
    const m = new MeshBuilder();
    const cell = (cx: number, cy: number) => cy * 2048 + cx;
    m.begin(record({ cell: cell(675, 1163) }));
    m.vertex(0, 0, 0);
    m.begin(record({ cell: cell(681, 1170) }));
    m.vertex(1, 0, 0);
    m.begin(record({ cell: -1 }));
    m.vertex(2, 0, 0);
    const d = m.finish();
    expect([d.cellX, d.cellY]).toEqual([675, 1163]);
    expect(unpackLook(d.look, 0)).toMatchObject({ cellDx: 0, cellDy: 0 });
    expect(unpackLook(d.look, 4)).toMatchObject({ cellDx: 6, cellDy: 7 });
    expect(unpackLook(d.look, 8)).toMatchObject({ cellDx: -1, cellDy: -1 });
  });
});

describe('index buffers', () => {
  it('take 16 bits while the vertices fit, 32 above', () => {
    expect(indexArray([0, 1, 2], 3)).toBeInstanceOf(Uint16Array);
    expect(indexArray([0, 1, 65534], 65535)).toBeInstanceOf(Uint16Array);
    expect(indexArray([0, 1, 65535], 65536)).toBeInstanceOf(Uint32Array);
  });

  it('keep 16 bits on the GPU: three widens only the ones not marked normalised', () => {
    expect(indexAttribute(new Uint16Array(3)).normalized).toBe(true);
    expect(indexAttribute(new Uint32Array(3)).normalized).toBe(false);
  });
});

describe('fewer vertices and triangles', () => {
  const house = (kind: RoofShape['kind']): RoofShape => ({
    kind,
    box: orientedBox([0, 0, 20, 0, 20, 10, 0, 10]),
    eave: 6,
    ridge: 10,
  });
  const build = (kind: RoofShape['kind']) => {
    const m = new MeshBuilder();
    m.begin(record());
    addSolid(m, {
      outer: [0, 0, 20, 0, 20, 10, 0, 10],
      holes: [],
      roof: house(kind),
      base: -1,
      grounded: true,
    });
    return m;
  };

  it('builds a gabled house from 10 corners and 14 triangles', () => {
    // Feet, eave corners and the two ridge ends; four walls (the gables as one polygon each)
    // and two roof planes.
    const m = build('gabled');
    expect(m.vertexCount).toBe(10);
    expect(m.triangleCount).toBe(2 * 2 + 2 * 3 + 2 * 2);
    expect(build('hipped').triangleCount).toBe(4 * 2 + 2 * 2 + 2 * 1);
    expect(build('flat').triangleCount).toBe(4 * 2 + 2);
  });

  it('splits a roof only where it bends, and the walls at the same points', () => {
    const r = house('gabled');
    const planes = roofPlanes(r);
    const facets = roofFacets([0, 0, 20, 0, 20, 10, 0, 10], planes);
    expect(facets).toHaveLength(2);
    for (const f of facets)
      for (let k = 0; k < f.length; k += 2) {
        const h = roofHeight(r, f[k]!, f[k + 1]!);
        // Each facet lies on one plane: the roof height at its corners is that plane's.
        expect(planes.some((p) => Math.abs(p.c + p.ax * f[k]! + p.az * f[k + 1]! - h) < 1e-9)).toBe(
          true,
        );
      }
    // The gable wall (x = 20) is crossed by the ridge in its middle; the eave wall is not.
    expect(roofBends(20, 0, 20, 10, planes)).toEqual([expect.closeTo(0.5, 9)]);
    expect(roofBends(0, 0, 20, 0, planes)).toEqual([]);
    // Hipped: the long wall meets the hips only at its corners.
    expect(roofBends(0, 0, 20, 0, roofPlanes(house('hipped')))).toEqual([]);
  });

  it('keeps one copy of faces the 3D data holds twice, and drops faces without area', () => {
    const m = new MeshBuilder();
    m.begin(record());
    const a = m.vertex(0, 0, 0);
    const b = m.vertex(1, 0, 0);
    const c = m.vertex(0, 1, 0);
    const d = m.vertex(2, 0, 0);
    m.rawTriangle(a, b, c);
    m.rawTriangle(a, c, b);
    m.rawTriangle(b, c, a);
    m.rawTriangle(a, b, d);
    expect(m.triangleCount).toBe(1);
    // A new building may use the same corner numbers for other faces.
    m.begin(record());
    const e = m.vertex(5, 0, 0);
    const f = m.vertex(6, 0, 0);
    const g = m.vertex(5, 1, 0);
    m.rawTriangle(e, f, g);
    expect(m.triangleCount).toBe(2);
  });

  it('keeps ground-following feet: a flag per vertex, a start and an anchor per building', () => {
    const m = new MeshBuilder();
    m.begin(record({ anchorX: 3, anchorZ: 4 }));
    m.vertex(0, -1, 0, FLAG_GROUND);
    m.vertex(0, 5, 0);
    m.begin(record({ anchorX: 7, anchorZ: 8 }));
    m.vertex(1, -1, 0, FLAG_GROUND);
    const d = m.finish();
    expect(Array.from(d.starts)).toEqual([0, 2, 3]);
    expect(Array.from(d.anchors)).toEqual([3, 4, 7, 8]);
    expect(d.ground[0]).toBe(0b101);
  });
});

describe('what stays on the CPU', () => {
  it('samples the ground at points interpolated from the corners, within centimetres', () => {
    const frame = new LocalFrame(8.54, 47.37, 0);
    const g = new GroundGrid(frame, -840, 840, -830, 830, 30);
    const geo = { lon: 0, lat: 0, h: 0 };
    let worst = 0;
    const q = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < g.size; k += 37) {
      const ll = g.samplePoint(k);
      const x = g.x0 + (k % g.nx) * g.dx;
      const z = g.z0 + Math.floor(k / g.nx) * g.dz;
      frame.toGeodetic({ x, y: 0, z }, geo);
      frame.fromGeodetic(ll.lon, ll.lat, 0, q);
      worst = Math.max(worst, Math.hypot(q.x - x, q.z - z));
    }
    expect(worst).toBeLessThan(0.1);
    // Values only; the next fill's buffer exists only while filling.
    expect(g.bytes).toBe(g.size * 4 + 64);
  });

  it('drops the static attributes once the main pass has drawn them', () => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Uint16Array(8), 4, true));
    g.setAttribute('bLook', new BufferAttribute(new Uint16Array(8), 4, true));
    g.setIndex(indexAttribute(new Uint16Array([0, 1, 1])));
    const mesh = new Mesh(g);
    releaseAfterUpload(mesh, ['bLook']);
    const after = (scene: Scene) =>
      mesh.onAfterRender(
        undefined as never,
        scene,
        undefined as never,
        g,
        undefined as never,
        null as never,
      );
    // A shadow pass (its own material) may not have uploaded everything: keep.
    const shadow = new Scene();
    shadow.overrideMaterial = new Mesh().material as never;
    after(shadow);
    expect(g.getAttribute('bLook').array.length).toBe(8);
    after(new Scene());
    const look = g.getAttribute('bLook') as BufferAttribute;
    expect(look.array.length).toBe(0);
    // The element type and the counts the renderer reads later survive.
    expect(look.array).toBeInstanceOf(Uint16Array);
    expect(look.count).toBe(2);
    expect(g.index!.count).toBe(3);
    expect(g.index!.array).toBeInstanceOf(Uint16Array);
    // Positions stay: re-seating rewrites their w.
    expect(g.getAttribute('position').array.length).toBe(8);
  });
});

describe('shadows', () => {
  it('cast only from tiles near the camera (the shadow map covers the aircraft)', () => {
    for (const p of Object.values(BUILDING_PRESETS)) expect(p.shadowRange).toBeLessThanOrEqual(200);
  });
});
