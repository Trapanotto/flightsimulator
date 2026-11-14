/**
 * Synthetic terrain for the air model's tests, defined in metres east and north of the
 * TestEnvironment's default anchor so the flight tests and the model see the same hills.
 */
import type { AirTerrain } from '../../src/sim/air/terrainField';

export const LON0 = 7.5;
export const LAT0 = 46.91;
const M = 6_371_008.8 * (Math.PI / 180);
const COS0 = Math.cos(LAT0 * (Math.PI / 180));

export const east = (lon: number) => (lon - LON0) * M * COS0;
export const north = (lat: number) => (lat - LAT0) * M;
export const lonAt = (eastM: number) => LON0 + eastM / (M * COS0);
export const latAt = (northM: number) => LAT0 + northM / M;

/** Terrain from a function of metres east and north. */
export const terrain = (f: (x: number, y: number) => number): AirTerrain & { calls: number } => {
  const t = {
    calls: 0,
    height(lon: number, lat: number) {
      t.calls++;
      return f(east(lon), north(lat));
    },
  };
  return t;
};

export const plane = (h = 400) => terrain(() => h);

/** A long ridge running north-south through x = 0, Gaussian cross-section. */
export const RIDGE_HEIGHT = 500;
export const RIDGE_SIGMA = 800;
export const ridgeHeight = (x: number) => RIDGE_HEIGHT * Math.exp(-((x / RIDGE_SIGMA) ** 2));
export const ridge = () => terrain((x) => ridgeHeight(x));

/** A valley running north-south between two ridges at x = ±3 km, floor rising to the north. */
export const valley = () =>
  terrain(
    (x, y) =>
      500 +
      0.02 * y +
      1200 * Math.exp(-(((x - 3000) / 1500) ** 2)) +
      1200 * Math.exp(-(((x + 3000) / 1500) ** 2)),
  );

/** An isolated cone 600 m high, 1.5 km in radius, on a plain at 400 m. */
export const cone = () => terrain((x, y) => 400 + 600 * Math.max(0, 1 - Math.hypot(x, y) / 1500));
