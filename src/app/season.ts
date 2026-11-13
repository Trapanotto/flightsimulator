import type { Season } from '@world';

/** The season of a date in Switzerland (meteorological seasons). */
export function seasonOf(date: Date): Season {
  const m = date.getUTCMonth();
  return m <= 1 || m === 11 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
}

/**
 * Height above sea level (m) above which snow lies in a season: the Mittelland stays green
 * most winters, the high Alps keep their snow all summer.
 */
export const SNOW_LINE: Record<Season, number> = {
  winter: 900,
  spring: 1800,
  summer: 2900,
  autumn: 2300,
};

/** 0 by day .. 1 at night, from the sun's elevation in degrees: lights come on at dusk. */
export function nightFactor(sunElevation: number): number {
  const t = Math.min(1, Math.max(0, (2 - sunElevation) / 8));
  return t * t * (3 - 2 * t);
}
