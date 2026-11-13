import { describe, expect, it } from 'vitest';
import {
  MERCATOR_TILE_PX,
  distanceToBounds,
  fillTemplate,
  geoTileAt,
  geoTileBounds,
  geoTileChildren,
  geoTileSpan,
  geoTileWidthMetres,
  geoidUndulation,
  imageryZoomFor,
  mercatorLat,
  mercatorLon,
  mercatorTileRange,
  mercatorX,
  mercatorY,
  parseTerrainLayer,
  planMercatorWarp,
  seaLevelToEllipsoid,
  vectorTilePointToLonLat,
} from '../../src/geo';

describe('geographic tiles (EPSG:4326, TMS)', () => {
  it('has two tiles of 180° at zoom 0, y counted from the south', () => {
    expect(geoTileSpan(0)).toBe(180);
    expect(geoTileBounds({ z: 0, x: 0, y: 0 })).toEqual({
      west: -180,
      south: -90,
      east: 0,
      north: 90,
    });
    expect(geoTileBounds({ z: 0, x: 1, y: 0 }).west).toBe(0);
  });

  it('finds the tile of Bern-Belp and contains the point', () => {
    const t = geoTileAt(7.4972, 46.9122, 14);
    expect(t).toEqual({ z: 14, x: 17066, y: 12462 });
    const b = geoTileBounds(t);
    expect(b.west).toBeLessThanOrEqual(7.4972);
    expect(b.east).toBeGreaterThan(7.4972);
    expect(b.south).toBeLessThanOrEqual(46.9122);
    expect(b.north).toBeGreaterThan(46.9122);
  });

  it('splits a tile into four children covering it exactly', () => {
    const parent = { z: 10, x: 1066, y: 778 };
    const b = geoTileBounds(parent);
    const kids = geoTileChildren(parent).map(geoTileBounds);
    expect(kids).toHaveLength(4);
    expect(Math.min(...kids.map((k) => k.west))).toBeCloseTo(b.west, 12);
    expect(Math.max(...kids.map((k) => k.east))).toBeCloseTo(b.east, 12);
    expect(Math.min(...kids.map((k) => k.south))).toBeCloseTo(b.south, 12);
    expect(Math.max(...kids.map((k) => k.north))).toBeCloseTo(b.north, 12);
    // south-west first, north-east last
    expect(kids[0]!.south).toBe(b.south);
    expect(kids[3]!.north).toBe(b.north);
  });

  it('measures tile widths and distances in metres', () => {
    // A zoom 14 tile spans 0.011° of longitude: about 840 m at 47° N.
    const w = geoTileWidthMetres({ z: 14, x: 17066, y: 12461 });
    expect(w).toBeGreaterThan(820);
    expect(w).toBeLessThan(850);
    const b = { west: 7, south: 46, east: 8, north: 47 };
    expect(distanceToBounds(7.5, 46.5, b)).toBe(0);
    // 0.1° north of the box: about 11.1 km.
    expect(distanceToBounds(7.5, 47.1, b)).toBeCloseTo(11_120, -2);
  });
});

describe('Web Mercator', () => {
  it('round-trips lon/lat through tile coordinates', () => {
    for (const [lon, lat] of [
      [7.4972, 46.9122],
      [-122.4, 37.8],
      [0, 0],
      [179.9, -60],
    ] as const) {
      for (const z of [0, 8, 17]) {
        expect(mercatorLon(mercatorX(lon, z), z)).toBeCloseTo(lon, 10);
        expect(mercatorLat(mercatorY(lat, z), z)).toBeCloseTo(lat, 10);
      }
    }
  });

  it('matches the WMTS tile of Bern-Belp at zoom 14', () => {
    // swisstopo's WMTS serves this point in tile 14/8533/5768 (checked against the service).
    expect(Math.floor(mercatorX(7.4972, 14))).toBe(8533);
    expect(Math.floor(mercatorY(46.9122, 14))).toBe(5768);
  });

  it('covers a geographic tile with the right range of Mercator tiles', () => {
    const b = geoTileBounds({ z: 14, x: 17066, y: 12461 });
    const r = mercatorTileRange(b, 16);
    // As wide as two zoom 16 tiles in longitude, aligned to their edges.
    expect(r.x1 - r.x0 + 1).toBe(2);
    expect(mercatorX(b.west, 16)).toBe(r.x0);
    // Latitude is stretched by 1/cos(47°) = 1.47: 2.9 tiles, so three or four rows.
    expect(r.y1 - r.y0 + 1).toBeGreaterThanOrEqual(3);
    expect(r.y1 - r.y0 + 1).toBeLessThanOrEqual(4);
  });

  it('picks the imagery zoom whose pixels match the texture', () => {
    // 256 px texture: Mercator one zoom deeper has the same longitude span per tile.
    expect(imageryZoomFor(14, 256, 20)).toBe(15);
    expect(imageryZoomFor(14, 512, 20)).toBe(16);
    expect(imageryZoomFor(19, 512, 20)).toBe(20);
  });

  it('turns vector tile points into lon/lat', () => {
    const out = { lon: 0, lat: 0 };
    const t = { z: 14, x: 8533, y: 5766 };
    vectorTilePointToLonLat(t, 4096, 0, 0, out);
    expect(out.lon).toBeCloseTo(mercatorLon(8533, 14), 12);
    expect(out.lat).toBeCloseTo(mercatorLat(5766, 14), 12);
    vectorTilePointToLonLat(t, 4096, 4096, 4096, out);
    expect(out.lat).toBeCloseTo(mercatorLat(5767, 14), 12);
  });
});

describe('Mercator to geographic warp', () => {
  /** Exact source row (mosaic pixels) of a texture row centre. */
  const exactRow = (b: ReturnType<typeof geoTileBounds>, zoom: number, size: number, y: number) => {
    const lat = b.north - ((b.north - b.south) * y) / size;
    return (
      mercatorY(lat, zoom) * MERCATOR_TILE_PX - mercatorTileRange(b, zoom).y0 * MERCATOR_TILE_PX
    );
  };

  for (const z of [8, 12, 17]) {
    it(`puts every row at its true latitude within 0.01 px (zoom ${z})`, () => {
      const key = geoTileAt(7.6, 46.75, z);
      const b = geoTileBounds(key);
      const size = 512;
      const zoom = imageryZoomFor(z, size, 20);
      const plan = planMercatorWarp(b, zoom, size);
      expect(plan.bands[0]!.dy0).toBe(0);
      expect(plan.bands.at(-1)!.dy1).toBe(size);
      // Linear interpolation inside each band, as drawImage does.
      let worst = 0;
      for (const band of plan.bands) {
        for (let y = band.dy0; y <= band.dy1; y += 0.5) {
          const t = (y - band.dy0) / (band.dy1 - band.dy0);
          const sy = band.sy0 + (band.sy1 - band.sy0) * t;
          worst = Math.max(worst, Math.abs(sy - exactRow(b, zoom, size, y)));
        }
      }
      expect(worst).toBeLessThan(0.01);
      // Longitude is linear: the tile spans whole source pixels from its west edge.
      const pxPerDeg = (MERCATOR_TILE_PX * 2 ** zoom) / 360;
      expect(plan.sx1 - plan.sx0).toBeCloseTo((b.east - b.west) * pxPerDeg, 6);
    });
  }

  it('maps the north edge to the top and the south edge to the bottom', () => {
    const b = geoTileBounds({ z: 13, x: 8541, y: 6220 });
    const plan = planMercatorWarp(b, 15, 512);
    expect(plan.bands[0]!.sy0).toBeLessThan(plan.bands.at(-1)!.sy1);
    expect(plan.bands[0]!.sy0).toBeGreaterThanOrEqual(0);
    expect(plan.bands.at(-1)!.sy1).toBeLessThanOrEqual(
      (plan.range.y1 - plan.range.y0 + 1) * MERCATOR_TILE_PX,
    );
  });
});

describe('geoid', () => {
  it('matches swisstopo REFRAME at Thun', () => {
    // REFRAME (LHN95 -> Bessel -> WGS84) at LV95 2615000 / 1175000 (46.7260° N, 7.6349° E):
    // 557.80 m above sea level is 607.66 m above the WGS84 ellipsoid.
    expect(geoidUndulation(7.6349, 46.726)).toBeCloseTo(49.86, 0);
    expect(seaLevelToEllipsoid(7.6349, 46.726, 557.8)).toBeCloseTo(607.66, 0);
  });

  it('stays within the Swiss range and continues past the grid edge', () => {
    for (let lon = 5; lon <= 11.5; lon += 0.37)
      for (let lat = 45; lat <= 48.5; lat += 0.29) {
        const n = geoidUndulation(lon, lat);
        expect(n).toBeGreaterThan(43);
        expect(n).toBeLessThan(56);
      }
  });
});

describe('sources', () => {
  it('reads the tile template and version from layer.json', () => {
    const layer = parseTerrainLayer({
      format: 'quantized-mesh-1.0',
      maxzoom: 18,
      tiles: ['20250101/{z}/{x}/{y}.terrain?v={version}'],
      version: '1.43646.0',
    });
    expect(layer.maxZoom).toBe(18);
    expect(fillTemplate(layer.template, 14, 17066, 12461)).toBe(
      'https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/20250101/14/17066/12461.terrain?v=1.43646.0',
    );
    expect(() => parseTerrainLayer({ format: 'heightmap-1.0', tiles: ['x'] })).toThrow();
  });
});
