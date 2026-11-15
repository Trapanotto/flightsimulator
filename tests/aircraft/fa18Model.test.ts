import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COCKPIT_PIVOTS,
  EXTERIOR_PIVOTS,
  HUD_GEOMETRY,
  NOZZLE,
  REF,
  SLIDING_PIVOTS,
  allExpectedNodes,
  controlNode,
} from '../../src/aircraft/fa18Parts';
import { PANEL_WINDOW_REGIONS } from '../../src/aircraft/fa18Displays';
import { FA18_CONTROLS } from '../../src/sim';

const FILE = 'public/assets/aircraft/fa18.glb';
/** Controls of the sim's newer list the model already carries (the bingo knob on the IFEI). */
const AHEAD = new Set(['bingo']);

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

describe('fa18.glb', () => {
  const gltf = readGltfJson(FILE);
  const byName = new Map(gltf.nodes.map((n) => [n.name ?? '', n]));
  const parent = new Map<GltfNode, GltfNode>();
  for (const n of gltf.nodes) for (const c of n.children ?? []) parent.set(gltf.nodes[c]!, n);
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

  it('stays within the download budget of 3.5 MB', () => {
    expect(statSync(FILE).size).toBeLessThan(3.5 * 1024 * 1024);
    expect(gltf.extensionsUsed).toContain('EXT_meshopt_compression');
    expect((gltf.images ?? []).length).toBeLessThanOrEqual(3);
  });

  it('contains every part the loader looks up', () => {
    expect(allExpectedNodes().filter((n) => !byName.has(n))).toEqual([]);
  });

  it('gives every rotating pivot a unit axis and an identity rest rotation', () => {
    for (const name of [...EXTERIOR_PIVOTS, 'Stick', 'StickRoll']) {
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
      ...COCKPIT_PIVOTS.filter((n) => n.startsWith('Pedals')),
    ]) {
      const slide = byName.get(name)!.extras?.slide as number[];
      expect(slide, name).toHaveLength(3);
      expect(Math.hypot(...slide), name).toBeGreaterThan(0.04);
      expect(Math.hypot(...slide), name).toBeLessThan(0.2);
    }
  });

  it('has the F/A-18C dimensions (model frame: x left, y up, z forward, origin CG)', () => {
    // Main gear track 3.11 m, wheelbase 5.42 m.
    expect(world('Wheel_L')[0]! - world('Wheel_R')[0]!).toBeCloseTo(3.11, 2);
    expect(world('Wheel_N')[2]! - world('Wheel_L')[2]!).toBeCloseTo(5.42, 2);
    // Span over the launch rails 11.43 m: the position lights sit on the wing tips inside it.
    expect(world('Glow_Nav_L')[0]).toBeGreaterThan(5.3);
    expect(world('Glow_Nav_L')[0]).toBeLessThan(11.43 / 2);
    // Height 4.66 m over the fins: the anti-collision lights near the fin tips.
    const finTop = world('Glow_Strobe_L')[1]! + REF.wl;
    expect(finTop).toBeGreaterThan(4.3);
    expect(finTop).toBeLessThan(4.66);
    // Fins canted outward: the tip lights further out than the fin roots.
    expect(world('Glow_Strobe_L')[0]).toBeGreaterThan(1.6);
    // Nozzle hinges about 7.4 m behind the CG, the engines 0.56 m either side.
    expect(world('Glow_AB_L')[0]).toBeCloseTo(NOZZLE.centreX, 2);
    expect(world('Flame_L')[2]).toBeCloseTo(NOZZLE.hingeZ - NOZZLE.length, 2);
    // Main legs retract about lateral axes, the canopy about a lateral hinge, the rudders
    // about a hinge leaning out with the fins.
    const axis = (n: string) => byName.get(n)!.extras!.axis as number[];
    expect(Math.abs(axis('MainGear_L')[0]!)).toBeGreaterThan(0.99);
    expect(Math.abs(axis('NoseGear')[0]!)).toBeGreaterThan(0.99);
    expect(Math.abs(axis('Canopy')[0]!)).toBeGreaterThan(0.99);
    expect(Math.abs(axis('Rudder_L')[1]!)).toBeGreaterThan(0.6);
    expect(Math.abs(axis('Rudder_L')[0]!)).toBeGreaterThan(0.15);
  });

  it('puts the head-up display where fa18Parts expects it, in front of the eye', () => {
    const eye = world('Eye');
    const hud = world('Disp_HUD');
    expect(hud[2]! - eye[2]!).toBeCloseTo(HUD_GEOMETRY.distance, 3);
    expect(hud[1]! - eye[1]!).toBeCloseTo(HUD_GEOMETRY.offsetY, 3);
    expect(hud[0]! - eye[0]!).toBeCloseTo(-HUD_GEOMETRY.offsetX, 3);
    const size = byName.get('Disp_HUD')!.extras!.size as number[];
    expect(size[0]).toBeCloseTo(HUD_GEOMETRY.width, 3);
    expect(size[1]).toBeCloseTo(HUD_GEOMETRY.height, 3);
  });

  it('has a node and a hit box for every cockpit control', () => {
    const hits = gltf.nodes.filter((n) => n.name?.startsWith('Hit_'));
    for (const c of FA18_CONTROLS) {
      expect(byName.has(controlNode(c.id)), c.id).toBe(true);
      const own = hits.filter((h) => h.extras?.control === c.id);
      expect(own.length, c.id).toBeGreaterThan(0);
      for (const h of own) {
        const half = h.extras!.half as number[];
        expect(half, c.id).toHaveLength(3);
        expect(Math.max(...half) * 2, c.id).toBeGreaterThan(0.01);
        expect(Math.max(...half), c.id).toBeLessThan(0.16);
      }
    }
    const ids = new Set(FA18_CONTROLS.map((c) => c.id));
    for (const h of hits) {
      const id = h.extras!.control as string;
      expect(ids.has(id) || AHEAD.has(id), h.name).toBe(true);
    }
  });

  it('gives every control what it moves by: an axis, a travel, or nothing for a fixed hit', () => {
    const still = ['com1Active', 'com2Active', 'nav1Active', 'xpdrCode'];
    for (const c of FA18_CONTROLS) {
      if (still.includes(c.id)) continue;
      const n = byName.get(controlNode(c.id))!;
      const axis = n.extras?.axis as number[] | undefined;
      const slide = n.extras?.slide as number[] | undefined;
      expect(!!axis || !!slide, c.id).toBe(true);
      const detents = n.extras?.detents as number[] | undefined;
      if (detents && c.kind === 'selector') expect(detents.length, c.id).toBe(c.positions!.length);
    }
  });

  it('shapes every panel window like its region of the panel atlas', () => {
    for (const [id, r] of Object.entries(PANEL_WINDOW_REGIONS)) {
      const size = byName.get(`Disp_${id}`)!.extras!.size as number[];
      expect(size[0]! / size[1]! / (r.w / r.h), id).toBeGreaterThan(0.95);
      expect(size[0]! / size[1]! / (r.w / r.h), id).toBeLessThan(1.05);
    }
    for (const id of ['DDI_L', 'DDI_R', 'MPCD']) {
      const size = byName.get(`Disp_${id}`)!.extras!.size as number[];
      expect(size[0]! / size[1]!, id).toBeCloseTo(1, 3);
    }
  });

  it('carries the placard texts', () => {
    const labels = byName.get('Labels')!.extras!;
    const texts = labels.labels as string[];
    expect(texts.length).toBeLessThanOrEqual((labels.cols as number) * (labels.rows as number));
    for (const t of ['MASTER ARM', 'LDG GEAR', 'HOOK', 'FLAP', 'ENG CRANK', 'CANOPY', 'UFC'])
      expect(texts, t).toContain(t);
  });
});
