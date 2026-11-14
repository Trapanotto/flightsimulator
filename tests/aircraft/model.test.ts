import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COCKPIT_PIVOTS,
  DISPLAYS,
  DUAL_KNOBS,
  EXTERIOR_PIVOTS,
  FLAGS,
  GAUGE_PIVOTS,
  allExpectedNodes,
  controlNode,
} from '../../src/aircraft/c172Parts';
import { REGIONS } from '../../src/aircraft/displays';
import { C172_CONTROLS } from '../../src/sim';

const FILE = 'public/assets/aircraft/c172.glb';

interface GltfNode {
  name?: string;
  translation?: number[];
  children?: number[];
  extras?: Record<string, unknown>;
}

/** The JSON chunk of a binary glTF (header 12 bytes, then length + type + data). */
function readGltfJson(path: string) {
  const buf = readFileSync(path);
  expect(buf.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
  expect(buf.readUInt32LE(4)).toBe(2);
  const len = buf.readUInt32LE(12);
  expect(buf.readUInt32LE(16)).toBe(0x4e4f534a); // 'JSON'
  return JSON.parse(buf.subarray(20, 20 + len).toString('utf8')) as {
    nodes: GltfNode[];
    extensionsUsed?: string[];
    images?: unknown[];
  };
}

describe('c172.glb', () => {
  const gltf = readGltfJson(FILE);
  const byName = new Map(gltf.nodes.map((n) => [n.name ?? '', n]));

  it('stays within the download budget', () => {
    expect(statSync(FILE).size).toBeLessThan(4 * 1024 * 1024);
    // Mesh compression needs the meshopt decoder the loader wires in.
    expect(gltf.extensionsUsed).toContain('EXT_meshopt_compression');
  });

  it('contains every part the loader looks up', () => {
    const missing = allExpectedNodes().filter((n) => !byName.has(n));
    expect(missing).toEqual([]);
  });

  it('gives every rotating pivot a unit axis and an identity rest rotation', () => {
    const rotating = [...EXTERIOR_PIVOTS, ...GAUGE_PIVOTS, 'YokeRoll_L', 'YokeRoll_R', 'Ctl_trim'];
    for (const name of rotating) {
      const node = byName.get(name)!;
      const axis = node.extras?.axis as number[];
      expect(axis, name).toHaveLength(3);
      expect(Math.hypot(...axis), name).toBeCloseTo(1, 5);
      expect((node as { rotation?: number[] }).rotation, name).toBeUndefined();
    }
  });

  it('gives every sliding control a travel vector', () => {
    const sliding = [
      ...COCKPIT_PIVOTS.filter((n) => !n.startsWith('YokeRoll')),
      ...['throttle', 'mixture', 'flaps'].map(controlNode),
    ];
    for (const name of sliding) {
      const slide = byName.get(name)!.extras?.slide as number[];
      expect(slide, name).toHaveLength(3);
      expect(Math.hypot(...slide), name).toBeGreaterThan(0.03);
      expect(Math.hypot(...slide), name).toBeLessThan(0.1);
    }
  });

  it('has its hinges where a 172S has them (model frame: x left, y up, z forward, origin CG)', () => {
    const pos = (name: string) => {
      // Pivot translations are relative to their parent; the exterior pivots hang off LOD0.
      return byName.get(name)!.translation ?? [0, 0, 0];
    };
    // Propeller ahead of the CG by about 1.9 m, on the thrust line.
    expect(pos('Prop')[2]).toBeGreaterThan(1.7);
    expect(pos('Prop')[2]).toBeLessThan(2.1);
    // Ailerons outboard on the left (+x) and right (-x) wing, behind the CG, at wing height.
    expect(pos('Aileron_L')[0]).toBeGreaterThan(3.5);
    expect(pos('Aileron_R')[0]).toBeLessThan(-3.5);
    expect(pos('Aileron_L')[1]).toBeGreaterThan(0.6);
    // Elevator hinge about 5.6 m behind the CG.
    expect(pos('Elevator')[2]).toBeLessThan(-5.3);
    expect(pos('Elevator')[2]).toBeGreaterThan(-6.0);
    // Main wheels: track 2.54 m (8 ft 4 in).
    expect(pos('Wheel_L')[0]! - pos('Wheel_R')[0]!).toBeCloseTo(2.54, 2);
    // Aileron and flap axes run along the span; the rudder hinge is near vertical.
    const axis = (n: string) => byName.get(n)!.extras!.axis as number[];
    expect(Math.abs(axis('Aileron_L')[0]!)).toBeGreaterThan(0.95);
    expect(Math.abs(axis('Flap_R')[0]!)).toBeGreaterThan(0.95);
    expect(Math.abs(axis('Rudder')[1]!)).toBeGreaterThan(0.95);
  });

  it('keeps the skin textures small', () => {
    expect((gltf.images ?? []).length).toBeLessThanOrEqual(4);
  });

  it('has a node and a hit box for every cockpit control', () => {
    const hits = gltf.nodes.filter((n) => n.name?.startsWith('Hit_'));
    for (const c of C172_CONTROLS) {
      expect(byName.has(controlNode(c.id)), c.id).toBe(true);
      const own = hits.filter((h) => h.extras?.control === c.id);
      expect(own.length, c.id).toBeGreaterThan(0);
      for (const h of own) {
        const half = h.extras!.half as number[];
        expect(half, c.id).toHaveLength(3);
        // Big enough for a finger at arm's length (at least 1 cm across), small enough not
        // to swallow the neighbours.
        expect(Math.max(...half) * 2, c.id).toBeGreaterThan(0.01);
        expect(Math.max(...half), c.id).toBeLessThan(0.1);
      }
    }
    // Nothing but the controls' names.
    const ids = new Set(C172_CONTROLS.map((c) => c.id));
    for (const h of hits) expect(ids.has(h.extras!.control as string), h.name).toBe(true);
  });

  it('gives every control what it moves by: an axis, a travel, or nothing for a display hit', () => {
    const still = ['com1Active', 'com2Active', 'nav1Active', 'nav2Active', 'xpdrCode'];
    for (const c of C172_CONTROLS) {
      const n = byName.get(controlNode(c.id))!;
      if (still.includes(c.id)) continue;
      const axis = n.extras?.axis as number[] | undefined;
      const slide = n.extras?.slide as number[] | undefined;
      expect(!!axis || !!slide, c.id).toBe(true);
      if (axis) expect(Math.hypot(...axis), c.id).toBeCloseTo(1, 5);
    }
    for (const id of DUAL_KNOBS)
      expect(byName.get(`${controlNode(id)}_outer`)?.extras?.axis).toHaveLength(3);
    for (const f of FLAGS) expect(byName.get(f)!.extras?.slide, f).toHaveLength(3);
  });

  it('shapes every display window like its region of the display atlas', () => {
    for (const d of DISPLAYS) {
      const size = byName.get(`Disp_${d}`)!.extras!.size as number[];
      const r = REGIONS[d];
      expect(size[0]! / size[1]! / (r.w / r.h), d).toBeGreaterThan(0.94);
      expect(size[0]! / size[1]! / (r.w / r.h), d).toBeLessThan(1.06);
    }
  });

  it('carries the placard texts for the label atlas', () => {
    const labels = byName.get('Labels')!.extras!;
    const texts = labels.labels as string[];
    expect(texts.length).toBeGreaterThan(50);
    expect(texts.length).toBeLessThanOrEqual((labels.cols as number) * (labels.rows as number));
    expect(texts).toContain('MASTER');
    expect(texts).toContain('FUEL SELECTOR');
  });
});
