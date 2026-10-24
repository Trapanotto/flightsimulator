import { describe, expect, it } from 'vitest';
import {
  imageryPixel,
  imageryTileBounds,
  imageryTileForLonLat,
  terrainTileBounds,
  terrainTileForLonLat,
  terrainTilesForBounds,
} from '../../src/geo/tiles';
import { EnuFrame, ecefToGeodetic, geodeticToEcef } from '../../src/geo/wgs84';
import { lv95ToWgs84, wgs84ToLv95 } from '../../src/geo/lv95';

describe('terrain tile scheme', () => {
  it('resolves Zurich at zoom 14', () => {
    const tile = terrainTileForLonLat(8.54, 47.37, 14);
    expect(tile).toEqual({ z: 14, x: 17161, y: 12503 });
  });

  it('creates Cesium geographic root tiles', () => {
    const west = terrainTileBounds(0, 0, 0);
    const east = terrainTileBounds(1, 0, 0);

    expect(west).toEqual({ west: -180, east: 0, south: -90, north: 90 });
    expect(east).toEqual({ west: 0, east: 180, south: -90, north: 90 });
  });

  it('covers the requested bounds with root tiles', () => {
    const tiles = terrainTilesForBounds(
      { west: 5.5, east: 11, south: 45.5, north: 48.1 },
      8,
    );
    expect(tiles.length).toBeGreaterThan(10);
    expect(tiles[0].z).toBe(8);
  });

  it('keeps Zurich inside its tile bounds', () => {
    const bounds = terrainTileBounds(17161, 12503, 14);
    expect(bounds.west).toBeLessThan(8.54);
    expect(bounds.east).toBeGreaterThan(8.54);
    expect(bounds.south).toBeLessThan(47.37);
    expect(bounds.north).toBeGreaterThan(47.37);
  });
});

describe('imagery tile scheme', () => {
  it('uses Web Mercator tiles and round-trips bounds', () => {
    const tile = imageryTileForLonLat(8.54, 47.37, 12);
    const bounds = imageryTileBounds(tile.x, tile.y, tile.z);
    expect(bounds.west).toBeLessThanOrEqual(8.54);
    expect(bounds.east).toBeGreaterThan(8.54);
    expect(bounds.south).toBeLessThanOrEqual(47.37);
    expect(bounds.north).toBeGreaterThan(47.37);
  });

  it('maps north-west and south-east corners consistently', () => {
    const nw = imageryPixel(8.0, 48.0, 12);
    const se = imageryPixel(9.0, 47.0, 12);
    expect(se.x).toBeGreaterThan(nw.x);
    expect(se.y).toBeGreaterThan(nw.y);
  });
});

describe('WGS84 / ECEF / ENU', () => {
  it('places the equator at the WGS84 semi-major axis', () => {
    const ecef = geodeticToEcef(0, 0, 0);
    expect(ecef.x).toBeCloseTo(6_378_137, 3);
    expect(ecef.y).toBeCloseTo(0, 6);
    expect(ecef.z).toBeCloseTo(0, 6);
  });

  it('returns the original geodetic point', () => {
    const point = geodeticToEcef(8.2, 46.8, 1_234);
    const result = ecefToGeodetic(point);
    expect(result.lon).toBeCloseTo(8.2, 8);
    expect(result.lat).toBeCloseTo(46.8, 8);
    expect(result.height).toBeCloseTo(1_234, 3);
  });

  it('computes east as 111.3 km per degree at the equator', () => {
    const frame = new EnuFrame({ lon: 0, lat: 0, height: 0 });
    const enu = frame.toEnu(0.001, 0, 0);
    expect(enu.e).toBeCloseTo(111.319, 1);
    expect(enu.n).toBeCloseTo(0, 3);
    expect(enu.u).toBeCloseTo(0, 2);
  });

  it('round-trips ENU coordinates', () => {
    const frame = new EnuFrame({ lon: 8.2, lat: 46.8, height: 500 });
    const enu = frame.toEnu(8.54, 47.37, 408);
    const result = frame.fromEnuGeodetic(enu.e, enu.n, enu.u);
    expect(result.lon).toBeCloseTo(8.54, 8);
    expect(result.lat).toBeCloseTo(47.37, 8);
    expect(result.height).toBeCloseTo(408, 3);
  });
});

describe('LV95 projection', () => {
  it('places Zurich in the expected LV95 range', () => {
    const point = wgs84ToLv95(8.54, 47.37);
    expect(point.easting).toBeGreaterThan(2_683_000);
    expect(point.easting).toBeLessThan(2_684_000);
    expect(point.northing).toBeGreaterThan(1_247_000);
    expect(point.northing).toBeLessThan(1_248_000);
  });

  it('round-trips a Swiss coordinate', () => {
    const lonLat = lv95ToWgs84(2_683_000, 1_213_000);
    const back = wgs84ToLv95(lonLat.lon, lonLat.lat);
    expect(back.easting).toBeCloseTo(2_683_000, 0);
    expect(back.northing).toBeCloseTo(1_213_000, 0);
  });
});
