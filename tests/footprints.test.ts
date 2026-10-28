import { describe, expect, it } from 'vitest';
import { HOUSE_TYPES } from '../src/buildings/BuildingSet';
import {
  houseTypeOf,
  orientedBox,
  regionOf,
  seasonOf,
  tintOf,
  treeOf,
  treeTint,
  variantOf,
  wallHeight,
} from '../src/buildings/footprints';

const rotated = (w: number, h: number, deg: number, ox = 5, oy = -3): Array<[number, number]> => {
  const a = (deg * Math.PI) / 180;
  const corners: Array<[number, number]> = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  return corners.map(([x, y]) => [
    ox + x * Math.cos(a) - y * Math.sin(a),
    oy + x * Math.sin(a) + y * Math.cos(a),
  ]);
};

describe('oriented box', () => {
  it('recovers size, centre and angle of a rotated rectangle', () => {
    const b = orientedBox(rotated(20, 12, 30));
    expect(b.length).toBeCloseTo(20, 5);
    expect(b.width).toBeCloseTo(12, 5);
    expect(b.area).toBeCloseTo(240, 5);
    expect(b.cx).toBeCloseTo(5, 5);
    expect(b.cy).toBeCloseTo(-3, 5);
    const deg = ((((b.angle * 180) / Math.PI) % 180) + 180) % 180;
    expect(deg).toBeCloseTo(30, 3);
  });

  it('puts the long side first when the rectangle is taller than wide', () => {
    const b = orientedBox(rotated(8, 18, 10));
    expect(b.length).toBeCloseTo(18, 5);
    expect(b.width).toBeCloseTo(8, 5);
  });
});

describe('regions and house types', () => {
  const f = (area: number, height: number) => ({
    lon: 0,
    lat: 0,
    angle: 0,
    length: Math.sqrt(area * 1.4),
    width: Math.sqrt(area / 1.4),
    height,
    area,
  });

  it('picks the regional style', () => {
    expect(regionOf('Ticino', 8.95, 46.0, 300)).toBe('ticino');
    expect(regionOf('Graubünden/Grigioni/Grischun', 9.84, 46.49, 1800)).toBe('engadin');
    expect(regionOf('Valais/Wallis', 7.36, 46.23, 500)).toBe('valais');
    expect(regionOf('Bern', 7.91, 46.6, 800)).toBe('oberland');
    expect(regionOf('Bern', 7.44, 46.95, 540)).toBe('mittelland');
  });

  it('maps footprints to typical houses', () => {
    expect(houseTypeOf(f(300, 9), 'mittelland', 550, false)).toBe('farmhouse');
    expect(houseTypeOf(f(110, 8), 'oberland', 1100, false)).toBe('chalet');
    expect(houseTypeOf(f(60, 7), 'ticino', 600, false)).toBe('rustico');
    expect(houseTypeOf(f(150, 9), 'engadin', 1800, true)).toBe('engadin');
    expect(houseTypeOf(f(400, 20), 'mittelland', 450, true)).toBe('block');
    expect(houseTypeOf(f(2000, 9), 'mittelland', 450, true)).toBe('hall');
    expect(houseTypeOf(f(20, 3), 'valais', 1500, false)).toBe('shed');
  });

  it('keeps a sensible wall height under a steep roof', () => {
    expect(wallHeight('farmhouse', f(300, 9))).toBeGreaterThanOrEqual(3.2);
    expect(wallHeight('block', f(400, 20))).toBeCloseTo(20, 5);
  });

  it('varies walls and roofs per building, the same on every visit', () => {
    const seen = new Map<string, Set<string>>();
    for (const type of HOUSE_TYPES) {
      const variants = new Set<string>();
      for (let i = 0; i < 400; i++) {
        const fp = { lon: 7.4 + i * 0.00137, lat: 46.9 + i * 0.00071, area: 2000 };
        const [w, r] = variantOf(type, 'mittelland', fp);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(3);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(3);
        expect(variantOf(type, 'mittelland', fp)).toEqual([w, r]);
        variants.add(`${w}/${r}`);
      }
      seen.set(type, variants);
    }
    // Every type shows several looks.
    for (const [type, v] of seen) expect(v.size, type).toBeGreaterThanOrEqual(4);
  });

  it('gives halls coloured cladding', () => {
    const colours = new Set<string>();
    for (let i = 0; i < 200; i++)
      colours.add(tintOf('mittelland', 'hall', 8 + i * 0.001, 47).join());
    expect(colours.size).toBeGreaterThanOrEqual(5);
  });

  it('mixes species, shapes and crown widths in a forest', () => {
    const species = new Set<string>();
    const shapes = new Set<number>();
    for (let i = 0; i < 600; i++) {
      const t = treeOf('mittelland', 500, 7.4 + i * 0.000731, 46.9 + i * 0.000419)!;
      species.add(t.type);
      shapes.add(t.variant);
      expect(t.width).toBeGreaterThan(0.8);
      expect(t.width).toBeLessThan(1.2);
    }
    expect(species.size).toBeGreaterThanOrEqual(6);
    expect([...shapes].sort()).toEqual([0, 1, 2]);
    // Dry Valais lowlands: Scots pines; no trees above the tree line.
    const valais = new Set<string>();
    for (let i = 0; i < 200; i++) valais.add(treeOf('valais', 600, 7.3 + i * 0.0011, 46.2)!.type);
    expect(valais.has('pine')).toBe(true);
    expect(treeOf('valais', 2500, 7.3, 46.2)).toBeNull();
  });

  it('dresses the trees for the season', () => {
    expect(seasonOf(new Date('2026-10-28')).autumn).toBeCloseTo(1, 5);
    expect(seasonOf(new Date('2026-07-15'))).toEqual({ autumn: 0, winter: 0 });
    expect(seasonOf(new Date('2026-01-20')).winter).toBe(1);
    const summer = treeTint('beech', 8, 47, { autumn: 0, winter: 0 });
    const autumn = treeTint('beech', 8, 47, { autumn: 1, winter: 0 });
    expect(autumn[0] / autumn[1]).toBeGreaterThan(1.5 * (summer[0] / summer[1]));
    // Evergreens stay green.
    expect(treeTint('spruce', 8, 47, { autumn: 1, winter: 0 })).toEqual(
      treeTint('spruce', 8, 47, { autumn: 0, winter: 0 }),
    );
  });
});
