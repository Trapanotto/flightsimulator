import { describe, expect, it } from 'vitest';
import {
  CHUNK_ZOOM,
  LEVELS,
  chunkBounds,
  chunkId,
  chunksWithin,
  evictionOrder,
  keepAt,
  levelFor,
  upperBoundRank,
} from '../../src/world/trees/chunks';
import { broadleafMesh, buildTreeMeshes, coniferMesh } from '../../src/world/trees/geometry';
import { photoToAlbedo, srgbToLinear } from '../../src/world/trees/photo';
import { TREE_PRESETS } from '../../src/world/trees/presets';
import { STRIDE } from '../../src/world/trees/protocol';
import { PALETTE_STRIDE, mixPalettes, seasonPalette } from '../../src/world/trees/season';
import {
  Cover,
  Form,
  Species,
  aboveTreeLine,
  formOf,
  pickSpecies,
  speciesWeights,
  treeLine,
  treeSize,
} from '../../src/world/trees/species';
import { mercatorX, mercatorY } from '../../src/geo';

const share = (w: number[], ...species: Species[]) => {
  const total = w.reduce((a, b) => a + b, 0);
  return species.reduce((a, s) => a + w[s]!, 0) / total;
};
const BROADLEAF = [Species.Beech, Species.Oak];
const CONIFERS = [Species.Spruce, Species.Fir, Species.Larch, Species.Pine];

describe('species by elevation', () => {
  const line = 2000;
  it('broadleaf trees dominate the Mittelland', () => {
    expect(share(speciesWeights(Cover.Forest, 450, line), ...BROADLEAF)).toBeGreaterThan(0.65);
  });
  it('beech, fir and spruce mix in the montane belt', () => {
    const w = speciesWeights(Cover.Forest, 900, line);
    expect(share(w, ...BROADLEAF)).toBeGreaterThan(0.25);
    expect(share(w, Species.Spruce, Species.Fir)).toBeGreaterThan(0.4);
  });
  it('spruce rules above about 1200 m', () => {
    const w = speciesWeights(Cover.Forest, 1500, line);
    expect(share(w, Species.Spruce)).toBeGreaterThan(0.6);
    expect(share(w, ...BROADLEAF)).toBeLessThan(0.08);
  });
  it('larch and stone pine take over at the tree line, and nothing grows above it', () => {
    const w = speciesWeights(Cover.Forest, 1950, line);
    expect(share(w, Species.Larch, Species.Pine)).toBeGreaterThan(0.6);
    expect(aboveTreeLine(line + 50, line)).toBe(false);
    expect(aboveTreeLine(line + 200, line)).toBe(true);
  });
  it('lies higher in the inner Alps than on the northern Prealps', () => {
    const valais = treeLine(7.55, 46.2);
    const engadin = treeLine(9.9, 46.55);
    const prealps = treeLine(7.9, 46.85);
    expect(valais).toBeGreaterThan(2150);
    expect(engadin).toBeGreaterThan(2150);
    expect(prealps).toBeLessThan(2000);
    expect(prealps).toBeGreaterThan(1850);
  });
  it('scrub is brush, and every species has a form', () => {
    expect(share(speciesWeights(Cover.Scrub, 1200, line), Species.Shrub)).toBe(1);
    expect(formOf(Species.Spruce)).toBe(Form.Conifer);
    expect(formOf(Species.Beech)).toBe(Form.Broadleaf);
  });
  it('the photo tilts the odds without overriding the belts', () => {
    const w = speciesWeights(Cover.Forest, 600, line);
    const conifers = (darkness: number) => {
      let n = 0;
      for (let i = 0; i < 2000; i++)
        if (CONIFERS.includes(pickSpecies(w, (i + 0.5) / 2000, darkness))) n++;
      return n / 2000;
    };
    expect(conifers(0.8)).toBeGreaterThan(conifers(0) * 1.8);
    expect(conifers(-0.8)).toBeLessThan(conifers(0) * 0.6);
    expect(conifers(-0.8)).toBeGreaterThan(0);
  });
  it('trees are tall in the lowlands and stunted at the tree line', () => {
    const low = treeSize(Species.Spruce, 800, line, 0.9, 0.5);
    const top = treeSize(Species.Spruce, 1980, line, 0.9, 0.5);
    expect(low.height).toBeGreaterThan(25);
    expect(top.height).toBeLessThan(low.height * 0.5);
    expect(treeSize(Species.Beech, 500, line, 0.5, 0.5).width).toBeGreaterThan(
      treeSize(Species.Spruce, 500, line, 0.5, 0.5).width,
    );
  });
});

describe('season colours', () => {
  const at = (p: Float32Array, s: Species) => {
    const o = s * PALETTE_STRIDE;
    return {
      a: [p[o]!, p[o + 1]!, p[o + 2]!],
      bare: p[o + 3]!,
      b: [p[o + 4]!, p[o + 5]!, p[o + 6]!],
    };
  };
  it('summer is green, spring a fresher and lighter green', () => {
    const summer = at(seasonPalette('summer'), Species.Beech);
    const spring = at(seasonPalette('spring'), Species.Beech);
    expect(summer.a[1]!).toBeGreaterThan(summer.a[0]!);
    expect(spring.a[1]!).toBeGreaterThan(summer.a[1]!);
    expect(summer.bare).toBe(0);
  });
  it('autumn turns beech orange, larch golden, and leaves spruce green', () => {
    const p = seasonPalette('autumn');
    const beech = at(p, Species.Beech);
    expect(beech.a[0]!).toBeGreaterThan(beech.a[1]! * 2);
    const larch = at(p, Species.Larch);
    expect(larch.a[0]!).toBeGreaterThan(larch.a[1]!);
    expect(larch.a[1]!).toBeGreaterThan(larch.a[2]! * 3);
    const spruce = at(p, Species.Spruce);
    expect(spruce.a[1]!).toBeGreaterThan(spruce.a[0]!);
  });
  it('winter strips broadleaf trees and larch, not spruce, fir or pine', () => {
    const p = seasonPalette('winter');
    for (const s of [Species.Beech, Species.Oak, Species.Larch, Species.Solitary])
      expect(at(p, s).bare).toBe(1);
    for (const s of [Species.Spruce, Species.Fir, Species.Pine]) expect(at(p, s).bare).toBe(0);
  });
  it('blends between seasons', () => {
    const a = seasonPalette('summer');
    const b = seasonPalette('autumn');
    expect(Array.from(mixPalettes(a, b, 0))).toEqual(Array.from(a));
    expect(Array.from(mixPalettes(a, b, 1))).toEqual(Array.from(b));
    const half = mixPalettes(a, b, 0.5);
    expect(half[4 * PALETTE_STRIDE]).toBeCloseTo(
      (a[4 * PALETTE_STRIDE]! + b[4 * PALETTE_STRIDE]!) / 2,
      6,
    );
  });
});

describe('photo to albedo', () => {
  it('decodes sRGB', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(255)).toBeCloseTo(1, 6);
    expect(srgbToLinear(188)).toBeCloseTo(0.5, 2);
  });
  it('maps like the terrain: dark tones gain about 2.5x, hue kept, bright capped', () => {
    const out = [0, 0, 0];
    photoToAlbedo(0.03, 0.05, 0.02, out);
    const lumIn = 0.2126 * 0.03 + 0.7152 * 0.05 + 0.0722 * 0.02;
    const lumOut = 0.2126 * out[0]! + 0.7152 * out[1]! + 0.0722 * out[2]!;
    expect(lumOut / lumIn).toBeGreaterThan(2.2);
    expect(lumOut / lumIn).toBeLessThan(2.7);
    expect(out[1]! / out[0]!).toBeCloseTo(0.05 / 0.03, 5);
    photoToAlbedo(1, 1, 1, out);
    expect(out[0]).toBeLessThanOrEqual(0.92);
  });
});

describe('chunks', () => {
  const p = TREE_PRESETS.desktop;
  it('are the zoom-14 vector tiles', () => {
    const lon = 7.53;
    const lat = 46.87;
    const list = chunksWithin(lon, lat, 0);
    expect(list).toEqual([
      { x: Math.floor(mercatorX(lon, CHUNK_ZOOM)), y: Math.floor(mercatorY(lat, CHUNK_ZOOM)) },
    ]);
    expect(chunkId(list[0]!)).toBe(`${list[0]!.x}/${list[0]!.y}`);
    const b = chunkBounds(list[0]!);
    expect(lon).toBeGreaterThan(b.west);
    expect(lat).toBeLessThan(b.north);
  });
  it('cover a disc of the view distance', () => {
    const n = chunksWithin(7.53, 46.87, p.fadeEnd).length;
    // 1.67 km tiles: pi * 6^2 km² is about 41 tiles, plus the ones cut by the circle.
    expect(n).toBeGreaterThan(35);
    expect(n).toBeLessThan(80);
  });
  it('thin out with distance and fade to nothing', () => {
    expect(keepAt(0, p)).toBe(1);
    expect(keepAt(p.thinStart, p)).toBe(1);
    let last = 1;
    for (let d = p.thinStart; d <= p.fadeEnd; d += 100) {
      const k = keepAt(d, p);
      expect(k).toBeLessThanOrEqual(last);
      last = k;
    }
    expect(keepAt(p.fadeEnd, p)).toBe(0);
    expect(keepAt(p.fadeStart, p)).toBeGreaterThan(0.15);
  });
  it('are stored at the level the nearest tree needs', () => {
    expect(levelFor(500, p)).toBe(1);
    expect(levelFor(p.thinStart * 1.5, p)).toBe(1);
    expect(levelFor(p.thinStart * 2.2, p)).toBe(0.5);
    expect(levelFor(p.fadeEnd * 0.99, p)).toBe(LEVELS[LEVELS.length - 1]);
    for (let d = 0; d < p.fadeEnd; d += 50)
      expect(levelFor(d, p)).toBeGreaterThanOrEqual(keepAt(d, p));
  });
  it('are evicted unwanted first, farthest first', () => {
    const order = evictionOrder(
      [
        { id: 'near', distance: 100, wanted: true },
        { id: 'far', distance: 5000, wanted: true },
        { id: 'old-near', distance: 7000, wanted: false },
        { id: 'old-far', distance: 9000, wanted: false },
      ],
      1,
    );
    expect(order).toEqual(['old-far', 'old-near', 'far']);
    expect(evictionOrder([{ id: 'a', distance: 1, wanted: false }], 4)).toEqual([]);
  });
  it('count the trees below a rank', () => {
    const data = new Float32Array(5 * STRIDE);
    [0.1, 0.2, 0.4, 0.4, 0.9].forEach((r, i) => (data[i * STRIDE + 3] = r));
    expect(upperBoundRank(data, 5, 0.05)).toBe(0);
    expect(upperBoundRank(data, 5, 0.4)).toBe(2);
    expect(upperBoundRank(data, 5, 0.5)).toBe(4);
    expect(upperBoundRank(data, 5, 1)).toBe(5);
  });
});

describe('tree meshes', () => {
  it('are closed index lists with unit normals and known parts', () => {
    const all = buildTreeMeshes(false);
    for (const m of [...all.conifer, ...all.broadleaf]) {
      const n = m.positions.length / 3;
      expect(m.indices.length % 3).toBe(0);
      for (const i of m.indices) expect(i).toBeLessThan(n);
      for (let k = 0; k < n; k++) {
        const l = Math.hypot(m.normals[k * 3]!, m.normals[k * 3 + 1]!, m.normals[k * 3 + 2]!);
        expect(l).toBeCloseTo(1, 4);
        expect([0, 1, 2]).toContain(m.parts[k]);
      }
    }
  });
  it('get cheaper with each level of detail', () => {
    const tris = (m: { indices: Uint16Array }) => m.indices.length / 3;
    for (const lite of [false, true]) {
      const all = buildTreeMeshes(lite);
      for (const form of [all.conifer, all.broadleaf]) {
        expect(tris(form[1])).toBeLessThan(tris(form[0]));
        expect(tris(form[2])).toBeLessThan(tris(form[1]));
        expect(tris(form[2])).toBeLessThanOrEqual(24);
      }
    }
    expect(tris(buildTreeMeshes(true).broadleaf[0])).toBeLessThan(
      tris(buildTreeMeshes(false).broadleaf[0]),
    );
  });
  it('stand on the ground and reach the top', () => {
    for (const m of [
      coniferMesh({ tiers: 8, spokes: 8, underside: true, trunkSides: 6 }),
      broadleafMesh({ lumps: 12, detail: 1, trunkSides: 6, limbs: 4 }),
    ]) {
      let minY = Infinity;
      let maxY = -Infinity;
      for (let k = 1; k < m.positions.length; k += 3) {
        minY = Math.min(minY, m.positions[k]!);
        maxY = Math.max(maxY, m.positions[k]!);
      }
      // The trunk reaches a little into the ground, so slopes show no gap.
      expect(minY).toBeLessThan(0);
      expect(maxY).toBeGreaterThan(0.95);
      expect(maxY).toBeLessThan(1.1);
    }
  });
});
