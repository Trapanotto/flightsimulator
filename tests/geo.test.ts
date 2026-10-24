import { describe, expect, it } from 'vitest';
import {
  ecefToGeodetic,
  ecefToLocal,
  enuFrame,
  geodeticToEcef,
  localToEcef,
} from '../src/geo/ellipsoid';
import { lv95ToWgs84, wgs84ToLv95 } from '../src/geo/lv95';
import {
  geoTileAt,
  geoTileBounds,
  mercatorPx,
  mercatorPy,
  mercatorTileRange,
} from '../src/geo/tiles';

const dms = (d: number, m: number, s: number) => d + m / 60 + s / 3600;

describe('LV95', () => {
  // Reference example from the swisstopo formula document.
  const lon = dms(8, 43, 49.79);
  const lat = dms(46, 2, 38.87);

  it('converts WGS84 to LV95 like the swisstopo example', () => {
    const [e, n] = wgs84ToLv95(lon, lat);
    expect(e).toBeCloseTo(2699999.76, 0);
    expect(n).toBeCloseTo(1099999.97, 0);
  });

  it('converts LV95 back to WGS84 within ~1 m', () => {
    const [lo, la] = lv95ToWgs84(2700000, 1100000);
    expect(Math.abs(lo - lon) * 77000).toBeLessThan(1.5);
    expect(Math.abs(la - lat) * 111000).toBeLessThan(1.5);
  });
});

describe('ECEF', () => {
  it('round-trips geodetic coordinates', () => {
    const p = geodeticToEcef(7.9625, 46.5367, 4158);
    const [lo, la, h] = ecefToGeodetic(...p);
    expect(lo).toBeCloseTo(7.9625, 9);
    expect(la).toBeCloseTo(46.5367, 9);
    expect(h).toBeCloseTo(4158, 3);
  });

  it('places local axes east / up / south', () => {
    const f = enuFrame(7.9, 46.5, 0);
    const up = ecefToLocal(f, ...geodeticToEcef(7.9, 46.5, 1000));
    expect(up[0]).toBeCloseTo(0, 3);
    expect(up[1]).toBeCloseTo(1000, 3);
    expect(up[2]).toBeCloseTo(0, 3);

    const north = ecefToLocal(f, ...geodeticToEcef(7.9, 46.51, 0));
    expect(north[2]).toBeLessThan(-1100); // north is -z
    const east = ecefToLocal(f, ...geodeticToEcef(7.91, 46.5, 0));
    expect(east[0]).toBeGreaterThan(700);
  });

  it('round-trips local coordinates', () => {
    const f = enuFrame(7.9, 46.5, 500);
    const p = localToEcef(f, 1234.5, -50, -9876.25);
    const l = ecefToLocal(f, ...p);
    expect(l[0]).toBeCloseTo(1234.5, 6);
    expect(l[1]).toBeCloseTo(-50, 6);
    expect(l[2]).toBeCloseTo(-9876.25, 6);
  });
});

describe('tiles', () => {
  it('finds the geographic TMS tile for Bern', () => {
    // Verified against the swisstopo terrain service.
    expect(geoTileAt(7.43863, 46.95108, 17)).toEqual({ z: 17, x: 136488, y: 99724 });
  });

  it('computes tile bounds that contain the point', () => {
    const b = geoTileBounds(geoTileAt(7.9625, 46.5367, 12));
    expect(b.west).toBeLessThanOrEqual(7.9625);
    expect(b.east).toBeGreaterThan(7.9625);
    expect(b.south).toBeLessThanOrEqual(46.5367);
    expect(b.north).toBeGreaterThan(46.5367);
  });

  it('computes Web Mercator pixels', () => {
    expect(mercatorPx(0, 0)).toBe(128);
    expect(mercatorPy(0, 0)).toBeCloseTo(128, 9);
    expect(mercatorPy(85.0511287798, 0)).toBeCloseTo(0, 3);
  });

  it('covers a terrain tile with mercator tiles', () => {
    const r = mercatorTileRange(geoTileBounds({ z: 12, x: 4276, y: 3108 }), 14);
    expect(r.x1 - r.x0 + 1).toBe(2);
    expect(r.y1 - r.y0 + 1).toBeGreaterThanOrEqual(3);
  });
});
