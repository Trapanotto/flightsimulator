/** International Standard Atmosphere up to 20 km, with a temperature offset for the day. */

const T0 = 288.15;
const P0 = 101_325;
const LAPSE = 0.0065;
const R = 287.053;
const G = 9.80665;
const TROPOPAUSE = 11_000;

export interface IsaSample {
  /** K */
  temperature: number;
  /** Pa */
  pressure: number;
  /** kg/m^3 */
  density: number;
  /** m/s */
  speedOfSound: number;
}

/**
 * Air at `altitude` metres above sea level. `isaDeviation` (K) shifts the temperature of the
 * whole column: a hot day has thinner air at the same pressure altitude.
 */
export function isa(altitude: number, isaDeviation = 0): IsaSample {
  const h = Math.min(Math.max(altitude, -500), 20_000);
  let tStd: number;
  let pressure: number;
  if (h <= TROPOPAUSE) {
    tStd = T0 - LAPSE * h;
    pressure = P0 * (tStd / T0) ** (G / (LAPSE * R));
  } else {
    tStd = T0 - LAPSE * TROPOPAUSE;
    const p11 = P0 * (tStd / T0) ** (G / (LAPSE * R));
    pressure = p11 * Math.exp((-G * (h - TROPOPAUSE)) / (R * tStd));
  }
  const temperature = tStd + isaDeviation;
  return {
    temperature,
    pressure,
    density: pressure / (R * temperature),
    speedOfSound: Math.sqrt(1.4 * R * temperature),
  };
}
