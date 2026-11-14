import { describe, expect, it } from 'vitest';
import { LIGHT_COLOURS } from '../../src/world/airports/layout';
import { LIGHT_CAP_WHITE, lightPixelCap } from '../../src/world/airports/lightMaterial';

/** three.js's ACESFilmicToneMapping (exposure 1), linear in, linear out clamped to [0, 1]. */
function aces([r, g, b]: readonly number[]): number[] {
  const v = [
    0.59719 * r! + 0.35458 * g! + 0.04823 * b!,
    0.076 * r! + 0.90834 * g! + 0.01566 * b!,
    0.0284 * r! + 0.13383 * g! + 0.83777 * b!,
  ].map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081));
  return [
    1.60475 * v[0]! - 0.53108 * v[1]! - 0.07367 * v[2]!,
    -0.10208 * v[0]! + 1.10813 * v[1]! - 0.00605 * v[2]!,
    -0.00327 * v[0]! - 0.07276 * v[1]! + 1.07602 * v[2]!,
  ].map((x) => Math.min(1, Math.max(0, x)));
}

const atCap = (rgb: readonly number[], cap: number) => {
  const hi = Math.max(...rgb);
  return aces(rgb.map((x) => (x / hi) * cap));
};

describe('light colours after tone mapping', () => {
  it('a red PAPI or stop bar stays red, a green threshold green', () => {
    const red = atCap(LIGHT_COLOURS.red, lightPixelCap(LIGHT_COLOURS.red));
    expect(red[1]! / red[0]!).toBeLessThan(0.05);
    const green = atCap(LIGHT_COLOURS.green, lightPixelCap(LIGHT_COLOURS.green));
    expect(green[0]! / green[1]!).toBeLessThan(0.3);
    expect(green[2]! / green[1]!).toBeLessThan(0.45);
    // The old common limit of 3 turned red into orange and green into pale mint.
    const redBefore = atCap(LIGHT_COLOURS.red, LIGHT_CAP_WHITE);
    expect(redBefore[1]! / redBefore[0]!).toBeGreaterThan(0.12);
    const greenBefore = atCap(LIGHT_COLOURS.green, LIGHT_CAP_WHITE);
    expect(greenBefore[0]! / greenBefore[1]!).toBeGreaterThan(0.5);
  });

  it('white lights still glare', () => {
    const white = atCap(LIGHT_COLOURS.white, lightPixelCap(LIGHT_COLOURS.white));
    expect(Math.min(...white)).toBeGreaterThan(0.8);
  });
});
