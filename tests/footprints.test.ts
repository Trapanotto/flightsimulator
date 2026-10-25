import { describe, expect, it } from 'vitest';
import { houseTypeOf, orientedBox, regionOf, wallHeight } from '../src/buildings/footprints';

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
});
