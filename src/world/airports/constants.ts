/**
 * The sky's unit of light: its colours are in units of the solar illuminance at the top of the
 * atmosphere (src/sky/atmosphere.ts, SOLAR_ILLUMINANCE_LUX). Lamps are given in candela, so
 * they need this to be on the same scale before the exposure is applied. Kept equal to the
 * sky's value by hand: `world` may not import `sky`.
 */
export const SOLAR_ILLUMINANCE_LUX = 128_000;
