import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Color,
  Group,
  LOD,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
} from 'three/webgpu';
import {
  EXPLOSION_DELAY,
  ImpactWatch,
  LAYOUTS,
  type AircraftVisual,
  type Impact,
  Wreck,
  WreckFx,
  pieceKey,
  planBreak,
  regionOf,
  roleOf,
  severityOf,
  splitTriangles,
} from '../../src/aircraft';
import { EXPLOSION_DELAY as SOUND_DELAY } from '../../src/audio';
import type { Telemetry } from '../../src/sim';

const DEG = Math.PI / 180;

describe('crash severity', () => {
  const vs = 30;
  const at = (reason: string, speed: number, sink: number, bank = 0): Impact => ({
    reason,
    speed,
    sink,
    bank,
    vStall: vs,
  });
  // The old game's cases (v0.11.0 tests/wreck.test.ts), with the new simulation's reasons.
  it('a slow belly or hard landing leaves the airframe whole', () => {
    expect(severityOf(at('propeller', 40, 2))).toBe(1);
    expect(severityOf(at('gear', 35, 7))).toBe(1);
  });
  it('a wing tip or a fast touchdown tears off a wing', () => {
    expect(severityOf(at('wing', 45, 3, 0.6))).toBe(2);
    expect(severityOf(at('ground', 55, 4))).toBe(2);
    expect(severityOf(at('ground', 40, 3, 30 * DEG))).toBe(2);
  });
  it('nose first, very fast, falling hard or broken in the air destroys it', () => {
    expect(severityOf(at('ground', 45, 20))).toBe(3);
    expect(severityOf(at('terrain', 90, 5))).toBe(3);
    expect(severityOf(at('terrain', 40, 25))).toBe(3);
    expect(severityOf(at('overstress', 40, 0))).toBe(3);
  });
  it('takes the impact from the step before the crash, whose speeds are not yet zeroed', () => {
    const watch = new ImpactWatch();
    const info = { vs: 24 };
    const t = { crashed: undefined, groundSpeed: 50, verticalSpeed: -12, bank: 0.2 } as Telemetry;
    expect(watch.observe(t, info)).toBeUndefined();
    // The crash step: the simulation has stopped the aircraft.
    const crashed = { ...t, crashed: 'ground', groundSpeed: 0, verticalSpeed: 0 } as Telemetry;
    const impact = watch.observe(crashed, info)!;
    expect(impact.sink).toBe(12);
    expect(impact.speed).toBeCloseTo(Math.hypot(50, 12), 6);
    expect(impact.reason).toBe('ground');
    // Reported once.
    expect(watch.observe(crashed, info)).toBeUndefined();
  });
  it('explodes at the same moment in picture and sound', () => {
    expect(EXPLOSION_DELAY).toBe(SOUND_DELAY);
  });
});

describe('break-up', () => {
  it('knows the parts by name: interior and glass do not become debris', () => {
    expect(roleOf('Cockpit')).toBe('skip');
    expect(roleOf('Glass_lod1')).toBe('skip');
    expect(roleOf('PropDisc')).toBe('skip');
    expect(roleOf('Airframe', 'Glass')).toBe('skip');
    expect(roleOf('MainGear_L_lod1')).toBe('gear');
    expect(roleOf('NoseSteer')).toBe('gear');
    expect(roleOf('Prop')).toBe('prop');
    expect(roleOf('Airframe')).toBe('free');
    expect(roleOf('Aileron_L')).toBe('free');
  });

  it('finds fuselage, wings and tail in a merged airframe', () => {
    const a320 = LAYOUTS.A320!;
    expect(regionOf({ x: 0, y: 1, z: 5 }, a320)).toBe('body');
    expect(regionOf({ x: 10, y: 0, z: -2 }, a320)).toBe('wingL');
    expect(regionOf({ x: -6, y: -1.5, z: 2 }, a320)).toBe('wingR'); // an engine
    expect(regionOf({ x: 0, y: 6, z: -18 }, a320)).toBe('tail'); // the fin
    expect(regionOf({ x: 5, y: 1.8, z: -18 }, a320)).toBe('tail'); // the stabiliser
    expect(regionOf({ x: 0, y: 0, z: -18 }, a320)).toBe('body'); // the tail cone
  });

  it('breaks more the harder the impact', () => {
    const l = LAYOUTS.PC12!;
    const rnd = () => 0.3;
    const keys = (impact: Impact) => {
      const plan = planBreak(impact, l, rnd);
      return {
        wingR: pieceKey('Airframe', 'free', false, { x: -6, y: 0, z: 0 }, plan, l),
        wingL: pieceKey('Airframe', 'free', false, { x: 6, y: 0, z: 0 }, plan, l),
        nose: pieceKey('Airframe', 'free', false, { x: 0, y: 0, z: 4 }, plan, l),
        tailCone: pieceKey('Airframe', 'free', false, { x: 0, y: 0, z: -6 }, plan, l),
        gear: pieceKey('MainGear_L', 'gear', true, { x: 2, y: -1, z: 0 }, plan, l),
        aileron: pieceKey('Aileron_R', 'free', true, { x: -6, y: 0, z: -1 }, plan, l),
      };
    };
    const mild = keys({ reason: 'gear', speed: 35, sink: 3, bank: 0, vStall: 34 });
    expect(mild).toMatchObject({
      wingR: 'hull',
      wingL: 'hull',
      nose: 'hull',
      gear: 'gear:MainGear_L',
    });
    // Right wing down: the right wing comes off, with its aileron.
    const wing = keys({ reason: 'wing', speed: 45, sink: 3, bank: 30 * DEG, vStall: 34 });
    expect(wing.wingR).toBe('section:wingR');
    expect(wing.aileron).toBe('section:wingR');
    expect(wing.wingL).toBe('hull');
    const destroyed = keys({ reason: 'ground', speed: 90, sink: 30, bank: 0, vStall: 34 });
    expect(destroyed.nose).not.toBe(destroyed.tailCone);
    expect(destroyed.nose).toMatch(/^body:/);
    expect(destroyed.aileron).toBe('part:Aileron_R');
  });

  it('puts every triangle of a sliced airframe into exactly one piece', () => {
    const l = LAYOUTS.A320!;
    const plan = planBreak(
      { reason: 'ground', speed: 120, sink: 30, bank: 0, vStall: 60 },
      l,
      () => 0.5,
    );
    // A triangle soup over the whole airframe, indexed with shared vertices.
    const n = 3000;
    const pos = new Float32Array(n * 3);
    let s = 1;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (r() - 0.5) * 34;
      pos[i * 3 + 1] = (r() - 0.3) * 10;
      pos[i * 3 + 2] = -21 + r() * 37;
    }
    const tris = 5000;
    const index = Array.from({ length: tris * 3 }, () => Math.floor(r() * n));
    const lists = splitTriangles(
      index,
      n,
      (a, b, c, out) => {
        out.x = (pos[a * 3]! + pos[b * 3]! + pos[c * 3]!) / 3;
        out.y = (pos[a * 3 + 1]! + pos[b * 3 + 1]! + pos[c * 3 + 1]!) / 3;
        out.z = (pos[a * 3 + 2]! + pos[b * 3 + 2]! + pos[c * 3 + 2]!) / 3;
      },
      (c) => pieceKey('Airframe', 'free', false, c, plan, l),
    );
    // Fuselage slabs, both wings in two, the tail.
    expect(lists.size).toBeGreaterThanOrEqual(7);
    const seen = new Map<string, number>();
    for (const list of lists.values())
      for (let t = 0; t < list.length; t += 3) {
        const key = `${list[t]},${list[t + 1]},${list[t + 2]}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    const expected = new Map<string, number>();
    for (let t = 0; t < index.length; t += 3) {
      const key = `${index[t]},${index[t + 1]},${index[t + 2]}`;
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    expect(seen).toEqual(expected);
  });
});

/** A box aircraft with the C172's part names, in a level of detail as the loader builds it. */
function boxAircraft(): { visual: AircraftVisual; paint: MeshStandardMaterial; root: Group } {
  const root = new Group();
  root.name = 'C172';
  const paint = new MeshStandardMaterial({ color: 0xf0f0f0 });
  const glass = new MeshStandardMaterial({ color: 0x101010 });
  glass.name = 'Glass';
  const level = new Group();
  const part = (name: string, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const node = new Group();
    node.name = name;
    // Several boxes in one mesh, like the merged airframe.
    const m = new Mesh(new BoxGeometry(w, h, d, 4, 2, 8), name === 'Glass' ? glass : paint);
    m.name = `${name}_geo`;
    m.position.set(x, y, z);
    node.add(m);
    level.add(node);
  };
  part('Fuselage', 1.1, 1.2, 8, 0, 0, -2);
  part('Wing', 11, 0.25, 1.5, 0, 0.85, -0.4);
  part('HStab', 3.2, 0.1, 1, 0, 0, -5.4);
  part('Fin', 0.1, 1.3, 1.2, 0, 0.9, -5.4);
  part('GearFixed', 2.4, 0.6, 0.4, 0, -0.9, 0);
  part('Prop', 1.9, 0.15, 0.1, 0, 0, 2);
  part('Glass', 1, 0.5, 1.5, 0, 0.6, 0.2);
  const lod = new LOD();
  lod.addLevel(level, 0);
  lod.addLevel(new Group(), 200);
  root.add(lod);
  root.position.set(100, 50.5, -20);
  root.rotation.y = 0.7;
  const visual = { object: root as Object3D } as AircraftVisual;
  return { visual, paint, root };
}

describe('wreck', () => {
  const ground = (x: number, z: number) => 50 + 0.05 * x - 0.03 * z;

  it('scatters the pieces, lets them come to rest on the ground, and gives the model back', () => {
    const { visual, paint, root } = boxAircraft();
    const fx = new WreckFx();
    const impact: Impact = { reason: 'ground', speed: 70, sink: 20, bank: 0, vStall: 24 };
    const wreck = new Wreck(visual, { x: 40, y: -20, z: -50 }, { groundY: ground }, fx, impact);
    expect(wreck.severity).toBe(3);
    // Glass gone, fuselage in slabs, wings, tail, gear legs, propeller.
    expect(wreck.pieceCount).toBeGreaterThanOrEqual(8);
    expect(root.children[0]!.visible).toBe(false);
    for (let i = 0; i < 60 * 40; i++) wreck.update(1 / 60, { x: 0, y: 100, z: 0 });
    expect(fx.smoke.alive).toBeGreaterThan(0);
    for (const p of wreck.debugPieces) {
      expect(p.resting).toBe(true);
      const bottom = p.position.y + p.low;
      expect(Math.abs(bottom - ground(p.position.x, p.position.z))).toBeLessThan(0.05);
    }
    // Charred, then restored for the next flight.
    expect(paint.color.r).toBeLessThan(0.3);
    wreck.dispose();
    expect(root.children[0]!.visible).toBe(true);
    expect(paint.color.equals(new Color(0xf0f0f0))).toBe(true);
    expect(fx.fire.alive + fx.smoke.alive).toBe(0);
  });

  it('keeps a mild crash in one piece that slides to a stop', () => {
    const { visual } = boxAircraft();
    const fx = new WreckFx({ quality: 'low' });
    const impact: Impact = { reason: 'gear', speed: 30, sink: 3, bank: 0, vStall: 24 };
    const wreck = new Wreck(visual, { x: 0, y: -3, z: -30 }, { groundY: ground }, fx, impact);
    expect(wreck.severity).toBe(1);
    const start = wreck.focus.clone();
    for (let i = 0; i < 60 * 30; i++) wreck.update(1 / 60);
    const hull = wreck.debugPieces.filter((p) => p.kind === 'hull');
    expect(hull).toHaveLength(1);
    expect(hull[0]!.resting).toBe(true);
    // It slid on along its track before it stopped (about v²/2µg).
    expect(start.distanceTo(wreck.focus)).toBeGreaterThan(30);
    expect(fx.fire.alive).toBe(0);
    wreck.dispose();
  });

  it('keeps a column of smoke over a bad crash to the end, thinning out', () => {
    const { visual } = boxAircraft();
    const fx = new WreckFx();
    const impact: Impact = { reason: 'ground', speed: 70, sink: 20, bank: 0, vStall: 24 };
    const wreck = new Wreck(visual, { x: 40, y: -20, z: -50 }, { groundY: ground }, fx, impact);
    const smokeAt = (t: number) => {
      while (wreck.age < t) wreck.update(1 / 30, { x: 0, y: 100, z: 0 });
      return fx.smoke.alive;
    };
    const early = smokeAt(20);
    const late = smokeAt(80);
    expect(late).toBeGreaterThan(20);
    expect(late).toBeLessThan(early);
    wreck.dispose();
  });

  it('lets pieces sink in water, with a splash and no fire', () => {
    const { visual } = boxAircraft();
    const fx = new WreckFx();
    const impact: Impact = { reason: 'propeller', speed: 50, sink: 20, bank: 0, vStall: 24 };
    const lake = (x: number, z: number) => Math.hypot(x - 100, z + 20) < 2000;
    const wreck = new Wreck(
      visual,
      { x: 30, y: -20, z: -30 },
      { groundY: () => 50, waterAt: lake },
      fx,
      impact,
    );
    wreck.update(1 / 60);
    // The splash: white spray, no sparks.
    expect(fx.smoke.alive).toBeGreaterThan(10);
    for (let i = 0; i < 60 * 60; i++) wreck.update(1 / 60);
    expect(fx.fire.alive).toBe(0);
    // Everything went under (and out of sight).
    for (const p of wreck.debugPieces) expect(p.position.y).toBeLessThan(50);
    wreck.dispose();
  });
});
