/**
 * Magnetic declination over Switzerland and its surroundings (about 4.5..12 E, 45..48.7 N),
 * 2025 to 2030. A plane fitted to World Magnetic Model 2025 values for 15 cities (listed in
 * DECLINATION_REFERENCE; recalled from the WMM2025 calculator, not computed from the model's
 * coefficients), plus the model's secular change, about 9' per year east. The fit is within
 * 0.2 degrees of every reference point; the model itself is good to about 0.3 degrees here.
 * Outside the region the plane is extrapolated and soon wrong.
 */

/** Degrees east at 8 E, 46.8 N on 2025.0, and its change per degree of lon, lat and per year. */
const D0 = 3.205;
const D_LON = 0.3273;
const D_LAT = -0.0466;
const D_YEAR = 0.15;

/** Reference values (degrees east, 2025.0) the model is fitted to: [name, lon, lat, declination]. */
export const DECLINATION_REFERENCE: ReadonlyArray<readonly [string, number, number, number]> = [
  ['Geneva', 6.14, 46.2, 2.72],
  ['Basel', 7.59, 47.56, 2.98],
  ['Bern', 7.45, 46.95, 2.98],
  ['Zurich', 8.54, 47.38, 3.33],
  ['Lugano', 8.95, 46.0, 3.5],
  ['Sion', 7.36, 46.23, 3.03],
  ['St. Gallen', 9.38, 47.42, 3.58],
  ['Chur', 9.53, 46.85, 3.65],
  ['Samedan', 9.88, 46.53, 3.78],
  ['Lyon', 4.84, 45.76, 2.37],
  ['Strasbourg', 7.75, 48.58, 2.95],
  ['Munich', 11.58, 48.14, 4.48],
  ['Milan', 9.19, 45.46, 3.65],
  ['Innsbruck', 11.39, 47.27, 4.38],
  ['Turin', 7.69, 45.07, 3.1],
];
/** Secular change used, degrees per year (WMM2025 over central Europe). */
export const DECLINATION_RATE = D_YEAR;

/**
 * Magnetic declination in degrees, positive east (magnetic = true - declination), at a decimal
 * year (default 2026.0).
 */
export function magneticDeclination(lon: number, lat: number, year = 2026): number {
  return D0 + D_LON * (lon - 8) + D_LAT * (lat - 46.8) + D_YEAR * (year - 2025);
}
