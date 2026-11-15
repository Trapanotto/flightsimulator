import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COCKPIT_PIVOTS,
  DUAL_KNOBS,
  EXTERIOR_PIVOTS,
  SLIDING_PIVOTS,
  allExpectedNodes,
  controlNode,
} from '../../src/aircraft/pc12Parts';
import { PANEL_WINDOW_REGIONS } from '../../src/aircraft/pc12Displays';
import { PC12_CONTROLS } from '../../src/sim';

const FILE = 'public/assets/aircraft/pc12.glb';

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

describe('pc12.glb', () => {
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

  it('stays within the download budget of 3 MB', () => {
    expect(statSync(FILE).size).toBeLessThan(3 * 1024 * 1024);
    expect(gltf.extensionsUsed).toContain('EXT_meshopt_compression');
    expect((gltf.images ?? []).length).toBeLessThanOrEqual(3);
  });

  it('contains every part the loader looks up', () => {
    const missing = allExpectedNodes().filter((n) => !byName.has(n));
    expect(missing).toEqual([]);
  });

  it('gives every rotating pivot a unit axis and an identity rest rotation', () => {
    for (const name of [...EXTERIOR_PIVOTS, 'YokeRoll_L', 'YokeRoll_R']) {
      const node = byName.get(name)!;
      const axis = node.extras?.axis as number[];
      expect(axis, name).toHaveLength(3);
      expect(Math.hypot(...axis), name).toBeCloseTo(1, 5);
      expect(node.rotation, name).toBeUndefined();
    }
  });

  it('gives every sliding part a travel vector', () => {
    for (const name of [
      ...SLIDING_PIVOTS,
      ...COCKPIT_PIVOTS.filter((n) => !n.startsWith('YokeRoll')),
    ]) {
      const slide = byName.get(name)!.extras?.slide as number[];
      expect(slide, name).toHaveLength(3);
      expect(Math.hypot(...slide), name).toBeGreaterThan(0.04);
      expect(Math.hypot(...slide), name).toBeLessThan(0.35);
    }
  });

  it('has the PC-12 NG dimensions (model frame: x left, y up, z forward, origin CG)', () => {
    // Main gear track 4.48 m.
    expect(world('Wheel_L')[0]! - world('Wheel_R')[0]!).toBeCloseTo(4.48, 2);
    // The propeller 5.45 m ahead of the CG, the elevator hinge about 7.9 m behind it.
    expect(world('Prop')[2]).toBeCloseTo(5.45, 1);
    expect(world('Elevator')[2]).toBeLessThan(-7.6);
    expect(world('Elevator')[2]).toBeGreaterThan(-8.2);
    // T-tail: the stabiliser 4.06 m above the ground (the CG is 1.78 m up), the beacon on top
    // under the published height of 4.26 m.
    expect(world('Stabilizer')[1]! + 1.78).toBeCloseTo(4.06, 1);
    expect(world('Glow_Beacon')[1]! + 1.78).toBeLessThan(4.3);
    expect(world('Glow_Beacon')[1]! + 1.78).toBeGreaterThan(4.1);
    // Nav lights at the wing tips, inside the 16.28 m span over the winglets.
    expect(world('Glow_Nav_L')[0]).toBeGreaterThan(7.8);
    expect(world('Glow_Nav_L')[0]).toBeLessThan(16.28 / 2);
    expect(world('Glow_Nav_R')[0]).toBeLessThan(-7.8);
    // Five blades, each with its own pitch axis running out along the blade.
    for (let i = 0; i < 5; i++) {
      const b = byName.get(`Blade_${i}`)!;
      expect(b.extras?.buildDeg, `Blade_${i}`).toBe(20);
      const axis = b.extras!.axis as number[];
      expect(Math.abs(axis[2]!), `Blade_${i}`).toBeLessThan(1e-6);
    }
    // Main legs retract about fore-aft axes, the nose leg about a lateral one.
    const axis = (n: string) => byName.get(n)!.extras!.axis as number[];
    expect(Math.abs(axis('MainGear_L')[2]!)).toBeGreaterThan(0.99);
    expect(Math.abs(axis('NoseGear')[0]!)).toBeGreaterThan(0.99);
    expect(Math.abs(axis('Rudder')[1]!)).toBeGreaterThan(0.6);
  });

  it('has a node and a hit box for every cockpit control', () => {
    const hits = gltf.nodes.filter((n) => n.name?.startsWith('Hit_'));
    for (const c of PC12_CONTROLS) {
      expect(byName.has(controlNode(c.id)), c.id).toBe(true);
      const own = hits.filter((h) => h.extras?.control === c.id);
      expect(own.length, c.id).toBeGreaterThan(0);
      for (const h of own) {
        const half = h.extras!.half as number[];
        expect(half, c.id).toHaveLength(3);
        expect(Math.max(...half) * 2, c.id).toBeGreaterThan(0.01);
        expect(Math.max(...half), c.id).toBeLessThan(0.1);
      }
    }
    const ids = new Set(PC12_CONTROLS.map((c) => c.id));
    for (const h of hits) expect(ids.has(h.extras!.control as string), h.name).toBe(true);
  });

  it('gives every control what it moves by: an axis, a travel, or nothing for a fixed hit', () => {
    const still = ['com1Active', 'com2Active', 'nav1Active', 'nav2Active', 'xpdrCode', 'apVsDown'];
    for (const c of PC12_CONTROLS) {
      if (still.includes(c.id)) continue;
      const n = byName.get(controlNode(c.id))!;
      const axis = n.extras?.axis as number[] | undefined;
      const slide = n.extras?.slide as number[] | undefined;
      expect(!!axis || !!slide, c.id).toBe(true);
      if (axis) expect(Math.hypot(...axis), c.id).toBeCloseTo(1, 5);
      // Selectors that turn have one detent per position.
      const detents = n.extras?.detents as number[] | undefined;
      if (detents && c.kind === 'selector') expect(detents.length, c.id).toBe(c.positions!.length);
    }
    for (const id of Object.keys(DUAL_KNOBS))
      expect(byName.get(`${controlNode(id)}_outer`)?.extras?.axis, id).toHaveLength(3);
  });

  it('shapes every panel window like its region of the panel atlas', () => {
    for (const [id, r] of Object.entries(PANEL_WINDOW_REGIONS)) {
      const size = byName.get(`Disp_${id}`)!.extras!.size as number[];
      expect(size[0]! / size[1]! / (r.w / r.h), id).toBeGreaterThan(0.95);
      expect(size[0]! / size[1]! / (r.w / r.h), id).toBeLessThan(1.05);
    }
    // The four Apex displays are 4:3.
    for (const id of ['PFD1', 'MFD1', 'MFD2', 'PFD2']) {
      const size = byName.get(`Disp_${id}`)!.extras!.size as number[];
      expect(size[0]! / size[1]!, id).toBeCloseTo(4 / 3, 1);
    }
  });

  it('carries the placard texts', () => {
    const labels = byName.get('Labels')!.extras!;
    const texts = labels.labels as string[];
    expect(texts.length).toBeGreaterThan(80);
    expect(texts.length).toBeLessThanOrEqual((labels.cols as number) * (labels.rows as number));
    for (const t of ['BAT 1', 'GEN 1', 'POWER', 'CONDITION', 'FLAPS', 'LDG GEAR', 'PARK BRAKE'])
      expect(texts, t).toContain(t);
  });
});
