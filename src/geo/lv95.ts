/**
 * WGS84 <-> Swiss LV95 (EPSG:2056) using the official swisstopo approximation
 * formulas. Accuracy is about 1 m, which is enough for gameplay and API calls.
 */

export function wgs84ToLv95(lonDeg: number, latDeg: number): [number, number] {
  const phi = (latDeg * 3600 - 169028.66) / 10000;
  const lam = (lonDeg * 3600 - 26782.5) / 10000;
  const e =
    2600072.37 + 211455.93 * lam - 10938.51 * lam * phi - 0.36 * lam * phi * phi - 44.54 * lam ** 3;
  const n =
    1200147.07 +
    308807.95 * phi +
    3745.25 * lam * lam +
    76.63 * phi * phi -
    194.56 * lam * lam * phi +
    119.79 * phi ** 3;
  return [e, n];
}

export function lv95ToWgs84(e: number, n: number): [number, number] {
  const y = (e - 2600000) / 1e6;
  const x = (n - 1200000) / 1e6;
  const lam = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const phi =
    16.9023892 +
    3.238272 * x -
    0.270978 * y * y -
    0.002528 * x * x -
    0.0447 * y * y * x -
    0.014 * x ** 3;
  return [(lam * 100) / 36, (phi * 100) / 36];
}
