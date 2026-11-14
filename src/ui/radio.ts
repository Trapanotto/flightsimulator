/**
 * Radio frequencies and codes as a pilot types and reads them. Pure functions, tested in Node.
 * Frequencies are whole kHz everywhere (the cockpit's unit); only display and input convert.
 */

/** COM and NAV radios tune in MHz with a kHz knob; the ADF in plain kHz. */
export type Band = 'com' | 'nav' | 'adf';

interface BandSpec {
  min: number;
  max: number;
  /** The fine knob's step, kHz. */
  step: number;
  /** The coarse knob's step, kHz. */
  coarse: number;
}

/** Ranges and channel spacing of the C172's radios (see C172_CONTROLS). */
export const BANDS: Record<Band, BandSpec> = {
  // 25 kHz channels: the sim has no 8.33 kHz spacing.
  com: { min: 118_000, max: 136_975, step: 25, coarse: 1000 },
  nav: { min: 108_000, max: 117_950, step: 50, coarse: 1000 },
  adf: { min: 190, max: 1750, step: 1, coarse: 10 },
};

/** The band of a cockpit control that holds a frequency, or null. */
export function bandOf(controlId: string): Band | null {
  if (/^com\d/.test(controlId)) return 'com';
  if (/^nav\d/.test(controlId)) return 'nav';
  if (controlId.startsWith('adf')) return 'adf';
  return null;
}

/** 121500 → '121.500' (COM), 110500 → '110.50' (NAV), 300 → '300' (ADF). */
export function formatFrequency(khz: number, band: Band): string {
  if (!Number.isFinite(khz)) return '–';
  const k = Math.round(khz);
  if (band === 'adf') return String(k);
  const mhz = Math.floor(k / 1000);
  const frac = String(k - mhz * 1000).padStart(3, '0');
  return `${mhz}.${band === 'nav' ? frac.slice(0, 2) : frac}`;
}

/**
 * What the pilot typed, as kHz, or null if it is no channel of the band. Accepts a point or a
 * comma ('121.5', '121,500'), whole MHz ('121') and digits without a separator ('12150').
 * A COM frequency written with two decimals means its 25 kHz channel, as pilots say it:
 * '118.02' is 118.025.
 */
export function parseFrequency(text: string, band: Band): number | null {
  const s = text.trim().replace(',', '.');
  if (!/^\d+(\.\d*)?$/.test(s)) return null;
  const spec = BANDS[band];
  let khz: number;
  if (band === 'adf') {
    const v = Number(s);
    if (!Number.isInteger(v)) return null;
    khz = v;
  } else {
    const withPoint = s.includes('.') || s.length <= 3 ? s : `${s.slice(0, 3)}.${s.slice(3)}`;
    const [whole = '', decimals = ''] = withPoint.split('.');
    if (decimals.length > 3) return null;
    khz = Number(whole) * 1000 + Number(decimals.padEnd(3, '0'));
    if (band === 'com' && decimals.length === 2 && khz % 50 === 20) khz += 5;
  }
  if (khz < spec.min || khz > spec.max) return null;
  if ((khz - spec.min) % spec.step !== 0) return null;
  return khz;
}

/**
 * One click of a tuning knob. COM and NAV have two concentric knobs as on the real radio: the
 * outer one changes the MHz, the inner one the kHz, and each wraps around on its own (the kHz
 * knob never carries into the MHz). The ADF knob counts in tens and ones and stops at the ends.
 */
export function stepFrequency(khz: number, band: Band, coarse: boolean, dir: 1 | -1): number {
  const spec = BANDS[band];
  if (band === 'adf') {
    const v = khz + dir * (coarse ? spec.coarse : spec.step);
    return Math.min(spec.max, Math.max(spec.min, v));
  }
  const minMhz = spec.min / 1000;
  const maxMhz = Math.floor(spec.max / 1000);
  let mhz = Math.floor(khz / 1000);
  let frac = khz - mhz * 1000;
  if (coarse) {
    const span = maxMhz - minMhz + 1;
    mhz = minMhz + ((((mhz + dir - minMhz) % span) + span) % span);
  } else {
    // The highest kHz value within a MHz: 975 for COM, 950 for NAV.
    const top = spec.max - maxMhz * 1000;
    const span = top + spec.step;
    frac = (((frac + dir * spec.step) % span) + span) % span;
  }
  return mhz * 1000 + frac;
}

/**
 * The frequency at the end of a controller's hint ('Bern Tower 121.025' → 121025), or null.
 * The app sends hints as display text; the number is what the pilot would dial.
 */
export function hintFrequency(hint: string | null | undefined): number | null {
  const m = /(\d{3}[.,]\d{1,3})\s*$/.exec(hint ?? '');
  return m ? parseFrequency(m[1]!, 'com') : null;
}

/** Transponder code: four octal digits, read as a decimal number (7000). */
export function parseSquawk(text: string): number | null {
  const s = text.trim();
  return /^[0-7]{4}$/.test(s) ? Number(s) : null;
}

export function formatSquawk(code: number): string {
  return String(Math.max(0, Math.round(code))).padStart(4, '0');
}

/** VFR code in Switzerland (and most of Europe). */
export const VFR_SQUAWK = 7000;
