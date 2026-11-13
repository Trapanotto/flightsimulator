/**
 * Units and number formatting for instruments and menus. Pure functions: tested in Node.
 * Internally everything is SI (m, m/s); only the display converts.
 */
export type Units = 'metric' | 'aviation';
export type NumberLang = 'de' | 'en';

/** Exact conversion factors (international knot and foot). */
export const MS_TO_KT = 3600 / 1852;
export const M_TO_FT = 1 / 0.3048;
export const MS_TO_FPM = 60 / 0.3048;
export const MS_TO_KMH = 3.6;

/** A typographic minus: the same width as a plus in tabular figures, unlike the hyphen. */
export const MINUS = '−';

export function convertSpeed(ms: number, units: Units): number {
  return ms * (units === 'aviation' ? MS_TO_KT : MS_TO_KMH);
}

export function convertAltitude(m: number, units: Units): number {
  return units === 'aviation' ? m * M_TO_FT : m;
}

export function convertVerticalSpeed(ms: number, units: Units): number {
  return units === 'aviation' ? ms * MS_TO_FPM : ms;
}

/** Thousands grouped the Swiss way in German (12’500) and with a comma in English (12,500). */
export function groupThousands(n: number, lang: NumberLang): string {
  const sign = n < 0 ? MINUS : '';
  const digits = String(Math.abs(Math.round(n)));
  const sep = lang === 'de' ? '’' : ',';
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Airspeed: whole units, never negative (a pitot tube reads no reverse flow). */
export function formatSpeed(ms: number, units: Units): string {
  if (!Number.isFinite(ms)) return '–';
  return String(Math.max(0, Math.round(convertSpeed(ms, units))));
}

/**
 * Altitude: feet in steps of 10, metres in steps of 1. Coarser steps keep the last digits
 * from flickering at 20 updates a second while still reading as a live value.
 */
export function formatAltitude(m: number, units: Units, lang: NumberLang): string {
  if (!Number.isFinite(m)) return '–';
  const v = convertAltitude(m, units);
  return groupThousands(units === 'aviation' ? Math.round(v / 10) * 10 : Math.round(v), lang);
}

/** Vertical speed with sign: ft/min in steps of 50, m/s with one decimal. */
export function formatVerticalSpeed(ms: number, units: Units, lang: NumberLang): string {
  if (!Number.isFinite(ms)) return '–';
  const v = convertVerticalSpeed(ms, units);
  if (units === 'aviation') {
    const r = Math.round(v / 50) * 50;
    if (r === 0) return '0';
    return (r > 0 ? '+' : MINUS) + groupThousands(Math.abs(r), lang);
  }
  const r = Math.round(v * 10) / 10;
  if (r === 0) return '0.0';
  return (r > 0 ? '+' : MINUS) + Math.abs(r).toFixed(1);
}

/** Heading as three digits; north reads 360 as on a heading indicator, not 000. */
export function formatHeading(deg: number): string {
  if (!Number.isFinite(deg)) return '–––';
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return String(d === 0 ? 360 : d).padStart(3, '0');
}

export function speedUnit(units: Units): string {
  return units === 'aviation' ? 'kt' : 'km/h';
}

export function altitudeUnit(units: Units): string {
  return units === 'aviation' ? 'ft' : 'm';
}

export function verticalSpeedUnit(units: Units): string {
  return units === 'aviation' ? 'ft/min' : 'm/s';
}

/** Local time of day in hours (0..24) as HH:MM. 24 is shown as 24:00, not 00:00. */
export function formatClock(hours: number): string {
  const total = Math.round(Math.min(24, Math.max(0, hours)) * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Magnetic heading of a runway end from its designator: '14' → 140, '04L' → 40, '36' → 360. */
export function runwayHeading(designator: string): number {
  const n = parseInt(designator, 10);
  if (!Number.isFinite(n) || n < 1 || n > 36) return 0;
  return n * 10;
}

/** A percentage 0..1 as whole percent. */
export function formatPercent(v: number): string {
  if (!Number.isFinite(v)) return '–';
  return `${Math.round(Math.min(1, Math.max(0, v)) * 100)}`;
}
