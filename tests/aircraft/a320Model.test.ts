import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COCKPIT_PIVOTS,
  DUAL_KNOBS,
  EXTERIOR_PIVOTS,
  KEY_LEGENDS,
  SLIDING_PIVOTS,
  STILL_CONTROLS,
  allExpectedNodes,
  controlNode,
} from '../../src/aircraft/a320Parts';
import { KEY_REGIONS, PANEL_WINDOW_REGIONS } from '../../src/aircraft/a320Panel';
import { A320_CONTROLS } from '../../src/sim';

const FILE = 'public/assets/aircraft/a320.glb';

interface GltfNode {
  name?: string;
  translation?: number[];
  rotation?: number[];
  children?: number[];
  extras?: Record<string, unknown>;
}

function readGltfJson(path: string) {
  const buf = readFileSync(path);
  expect(buf.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
  const len = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + len).toString('utf8')) as {
    nodes: GltfNode[];
    extensionsUsed?: string[];
    images?: unknown[];
  };
}

describe('a320.glb', () => {
  const gltf = readGltfJson(FILE);
  const byName = new Map(gltf.nodes.map((n) => [n.name ?? '', n]));
  const parent = new Map<GltfNode, GltfNode>();
  for (const n of gltf.nodes) for (const c of n.children ?? []) parent.set(gltf.nodes[c]!, n);
  /** Position in the model frame (pivots have no rotation at rest, so offsets add up). */
  const world = (name: string): number[] => {
    let n: GltfNode | undefined = byName.get(name);
    const p = [0, 0, 0];
    while (n) {
      const t = n.translation ?? [0, 0, 0];
      for (let i = 0; i < 3; i++) p[i]! += t[i]!;
      n = parent.get(n);
    }
    return p;
  };
  const axis = (n: string) => byName.get(n)!.extras!.axis as number[];

  it('stays within the download budget of 4 MB', () => {
    expect(statSync(FILE).size).toBeLessThan(4 * 1024 * 1024);
    expect(gltf.extensionsUsed).toContain('EXT_meshopt_compression');
    expect((gltf.images ?? []).length).toBeLessThanOrEqual(3);
  });

  it('contains every part the loader looks up', () => {
    const missing = allExpectedNodes().filter((n) => !byName.has(n));
    expect(missing).toEqual([]);
  });

  it('gives every rotating pivot a unit axis and an identity rest rotation', () => {
    for (const name of [
      ...EXTERIOR_PIVOTS,
      ...COCKPIT_PIVOTS.filter((n) => !n.startsWith('Pedals')),
    ]) {
      const node = byName.get(name)!;
      const a = node.extras?.axis as number[];
      expect(a, name).toHaveLength(3);
      expect(Math.hypot(...a), name).toBeCloseTo(1, 5);
      expect(node.rotation, name).toBeUndefined();
    }
  });

  it('gives every sliding part a travel vector', () => {
    for (const name of [...SLIDING_PIVOTS, 'Pedals_L', 'Pedals_R']) {
      const slide = byName.get(name)!.extras?.slide as number[];
      expect(slide, name).toHaveLength(3);
      expect(Math.hypot(...slide), name).toBeGreaterThan(0.04);
      expect(Math.hypot(...slide), name).toBeLessThan(1.5);
    }
  });

  it('has the A320 dimensions (model frame: x left, y up, z forward, origin CG)', () => {
    // Main gear track 7.59 m, wheelbase 12.64 m (Airbus A320 Aircraft Characteristics).
    expect(world('Wheel_L')[0]! - world('Wheel_R')[0]!).toBeCloseTo(7.59, 2);
    expect(world('Wheel_N')[2]! - world('Wheel_L')[2]!).toBeCloseTo(12.64, 2);
    // The nav lights at the tips, inside the 34.10 m span over the fences.
    expect(world('Glow_Nav_L')[0]).toBeGreaterThan(16.8);
    expect(world('Glow_Nav_L')[0]).toBeLessThan(34.1 / 2);
    expect(world('Glow_Nav_R')[0]).toBeLessThan(-16.8);
    // The tail light near the end of the 37.57 m fuselage (the nose 16.17 m ahead of the CG).
    expect(world('Glow_Tail')[2]).toBeLessThan(-(36.5 - 16.17));
    expect(world('Glow_Tail')[2]).toBeGreaterThan(-(37.57 - 16.17));
    // The engines 5.75 m either side of the centre line, the fans 1.735 m across ahead of the wing.
    expect(world('Fan_L')[0]).toBeCloseTo(5.75, 2);
    expect(world('Fan_R')[0]).toBeCloseTo(-5.75, 2);
    expect(Math.abs(axis('Fan_L')[2]!)).toBeGreaterThan(0.99);
    // The captain sits left of the centre line, behind the nose, about 1.75 m above the CG.
    expect(world('Eye')[0]).toBeCloseTo(0.53, 2);
    expect(world('Eye')[1]).toBeGreaterThan(1.5);
    expect(world('Eye')[2]).toBeGreaterThan(12);
    // Main legs retract about fore-aft axes (inwards), the nose leg about a lateral one.
    expect(Math.abs(axis('MainGear_L')[2]!)).toBeGreaterThan(0.99);
    expect(Math.abs(axis('NoseGear')[0]!)).toBeGreaterThan(0.99);
    expect(Math.abs(axis('Rudder')[1]!)).toBeGreaterThan(0.6);
    // The stabiliser trims about a lateral axis.
    expect(Math.abs(axis('Stabilizer')[0]!)).toBeGreaterThan(0.99);
  });

  it('has a node and a hit box for every cockpit control', () => {
    const hits = gltf.nodes.filter((n) => n.name?.startsWith('Hit_'));
    for (const c of A320_CONTROLS) {
      expect(byName.has(controlNode(c.id)), c.id).toBe(true);
      const own = hits.filter((h) => h.extras?.control === c.id);
      expect(own.length, c.id).toBeGreaterThan(0);
      for (const h of own) {
        const half = h.extras!.half as number[];
        expect(half, c.id).toHaveLength(3);
        expect(Math.max(...half) * 2, c.id).toBeGreaterThan(0.01);
        expect(Math.max(...half), c.id).toBeLessThan(0.15);
      }
    }
    const ids = new Set(A320_CONTROLS.map((c) => c.id));
    for (const h of hits) expect(ids.has(h.extras!.control as string), h.name).toBe(true);
  });

  it('gives every control what it moves by: an axis, a travel, or nothing for a fixed hit', () => {
    for (const c of A320_CONTROLS) {
      if ((STILL_CONTROLS as readonly string[]).includes(c.id)) continue;
      const n = byName.get(controlNode(c.id))!;
      const a = n.extras?.axis as number[] | undefined;
      const slide = n.extras?.slide as number[] | undefined;
      expect(!!a || !!slide, c.id).toBe(true);
      if (a) expect(Math.hypot(...a), c.id).toBeCloseTo(1, 5);
      const detents = n.extras?.detents as number[] | undefined;
      if (detents && c.kind === 'selector') expect(detents.length, c.id).toBe(c.positions!.length);
    }
    for (const id of Object.keys(DUAL_KNOBS))
      expect(byName.get(`${controlNode(id)}_outer`)?.extras?.axis, id).toHaveLength(3);
    // The thrust levers turn on their arc between idle, TOGA and full reverse.
    for (const n of ['throttle1', 'throttle2']) {
      const e = byName.get(controlNode(n))!.extras!;
      expect(e.togaDeg as number).toBeGreaterThan(e.idleDeg as number);
      expect(e.revDeg as number).toBeLessThan(e.idleDeg as number);
    }
  });

  it('shapes every panel window and legend like its region of the panel atlas', () => {
    for (const [id, r] of Object.entries(PANEL_WINDOW_REGIONS)) {
      const size = byName.get(`Disp_${id}`)!.extras!.size as number[];
      expect(size[0]! / size[1]! / (r.w / r.h), id).toBeGreaterThan(0.97);
      expect(size[0]! / size[1]! / (r.w / r.h), id).toBeLessThan(1.03);
    }
    for (const k of KEY_LEGENDS) {
      const size = byName.get(`Disp_KY_${k}`)!.extras!.size as number[];
      const r = KEY_REGIONS[k];
      expect(size[0]! / size[1]! / (r.w / r.h), k).toBeCloseTo(1, 1);
    }
    // The six display units are square, 7.25 in units with 0.184 m screens.
    for (const id of ['PFD1', 'ND1', 'EWD', 'SD', 'ND2', 'PFD2']) {
      const size = byName.get(`Disp_${id}`)!.extras!.size as number[];
      expect(size[0], id).toBeCloseTo(0.184, 3);
      expect(size[1], id).toBeCloseTo(0.184, 3);
    }
  });

  it('carries the placard texts', () => {
    const labels = byName.get('Labels')!.extras!;
    const texts = labels.labels as string[];
    expect(texts.length).toBeGreaterThan(150);
    expect(texts.length).toBeLessThanOrEqual((labels.cols as number) * (labels.rows as number));
    for (const t of [
      'BAT 1',
      'GEN 1',
      'APU BLEED',
      'EXT LT',
      'FLAPS',
      'L/G',
      'SPEED BRAKE',
      'PARK BRK',
      'MASTER',
    ])
      expect(texts, t).toContain(t);
  });
});
