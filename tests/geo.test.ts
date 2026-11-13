import { describe, expect, it } from 'vitest';
import {
  LocalFrame,
  WGS84_A,
  WGS84_B,
  ecefToGeodetic,
  geodeticToEcef,
  lv95ToWgs84,
  upAt,
  wgs84ToLv95,
} from '../src/geo';

const v = () => ({ x: 0, y: 0, z: 0 });

describe('WGS84', () => {
  it('places the equator and the pole on the ellipsoid', () => {
    expect(geodeticToEcef(0, 0, 0, v())).toEqual({ x: WGS84_A, y: 0, z: 0 });
    const pole = geodeticToEcef(0, 90, 0, v());
    expect(pole.z).toBeCloseTo(WGS84_B, 6);
    expect(Math.hypot(pole.x, pole.y)).toBeLessThan(1e-6);
  });

  it('round-trips points over Switzerland to well below a millimetre', () => {
    for (const [lon, lat, h] of [
      [7.4972, 46.9122, 510],
      [8.5492, 47.4582, 432],
      [7.6586, 45.9763, 4478],
      [10.4, 46.6, 12_000],
      [5.96, 45.82, -50],
    ] as const) {
      const g = ecefToGeodetic(geodeticToEcef(lon, lat, h, v()));
      expect(g.lon).toBeCloseTo(lon, 10);
      expect(g.lat).toBeCloseTo(lat, 10);
      expect(g.h).toBeCloseTo(h, 5);
    }
  });
});

describe('LocalFrame', () => {
  const frame = new LocalFrame(7.4972, 46.9122, 510);

  it('has its origin at zero and y pointing up', () => {
    const o = frame.fromGeodetic(7.4972, 46.9122, 510, v());
    expect(Math.hypot(o.x, o.y, o.z)).toBeLessThan(1e-6);
    const above = frame.fromGeodetic(7.4972, 46.9122, 610, v());
    expect(above.y).toBeCloseTo(100, 6);
    expect(Math.hypot(above.x, above.z)).toBeLessThan(1e-6);
  });

  it('has x east and z south', () => {
    const east = frame.fromGeodetic(7.5072, 46.9122, 510, v());
    expect(east.x).toBeGreaterThan(700);
    expect(Math.abs(east.z)).toBeLessThan(1);
    const north = frame.fromGeodetic(7.4972, 46.9222, 510, v());
    expect(north.z).toBeLessThan(-1100);
    expect(Math.abs(north.x)).toBeLessThan(1);
  });

  it('round-trips through ECEF and geodetic coordinates', () => {
    const p = { x: 12_345.6, y: 789.1, z: -23_456.7 };
    const back = frame.toLocal(frame.toEcef(p, v()), v());
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
    expect(back.z).toBeCloseTo(p.z, 6);
    const g = frame.toGeodetic(p);
    const again = frame.fromGeodetic(g.lon, g.lat, g.h, v());
    expect(again.x).toBeCloseTo(p.x, 4);
    expect(again.z).toBeCloseTo(p.z, 4);
  });

  it('turns the local vertical at the origin into +y', () => {
    const up = frame.dirToLocal(upAt(7.4972, 46.9122, v()), v());
    expect(up.y).toBeCloseTo(1, 12);
  });

  it('shows the curvature of the Earth: 100 km away the ground is ~780 m lower', () => {
    const far = frame.fromGeodetic(8.81, 46.9122, 510, v());
    expect(far.x).toBeGreaterThan(99_000);
    expect(far.y).toBeLessThan(-700);
    expect(far.y).toBeGreaterThan(-860);
  });
});

describe('LV95', () => {
  it('puts the old observatory of Bern at 2 600 000 / 1 200 000', () => {
    // 46°57'03.9" N, 7°26'19.1" E (WGS84)
    const { e, n } = wgs84ToLv95(7 + 26 / 60 + 19.1 / 3600, 46 + 57 / 60 + 3.9 / 3600);
    expect(Math.abs(e - 2_600_000)).toBeLessThan(2);
    expect(Math.abs(n - 1_200_000)).toBeLessThan(2);
  });

  it('round-trips within the accuracy of the approximate formulas', () => {
    for (const [lon, lat] of [
      [8.5492, 47.4582],
      [6.1089, 46.2381],
      [9.8, 46.5],
    ] as const) {
      const { e, n } = wgs84ToLv95(lon, lat);
      const back = lv95ToWgs84(e, n);
      // A few metres: both directions are approximations.
      expect(Math.abs(back.lon - lon)).toBeLessThan(5e-5);
      expect(Math.abs(back.lat - lat)).toBeLessThan(5e-5);
    }
  });
});
