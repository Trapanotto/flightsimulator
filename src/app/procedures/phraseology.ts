/**
 * Radio phraseology building blocks. Every piece comes twice: as it is written on screen
 * ('runway 14', 'QNH 1018') and as a speech synthesiser should say it ('runway one four',
 * 'QNH one zero one eight'), following the ICAO rules for transmitting numbers (Annex 10,
 * Vol. II, 5.2.1.4) as the BAZL VFR guide uses them.
 */

/** A piece of a radio message: what the screen shows and what the voice says. */
export interface Line {
  text: string;
  spoken: string;
}

export const line = (text: string, spoken = text): Line => ({ text, spoken });

/** Joins pieces with commas, the way a transmission is written. Empty pieces drop out. */
export function join(...parts: (Line | null | undefined | false)[]): Line {
  const ps = parts.filter((p): p is Line => !!p && p.text.length > 0);
  return { text: ps.map((p) => p.text).join(', '), spoken: ps.map((p) => p.spoken).join(', ') };
}

/** Joins pieces with spaces (one phrase made of several pieces). */
export function phrase(...parts: (Line | null | undefined | false)[]): Line {
  const ps = parts.filter((p): p is Line => !!p && p.text.length > 0);
  return { text: ps.map((p) => p.text).join(' '), spoken: ps.map((p) => p.spoken).join(' ') };
}

/** Turns the pieces into sentences: every one ends with a full stop. */
export function sentences(...parts: (Line | null | undefined | false)[]): Line {
  const ps = parts.filter((p): p is Line => !!p && p.text.length > 0);
  const end = (s: string) => (/[.!?]$/.test(s) ? s : s + '.');
  return {
    text: ps.map((p) => end(capital(p.text))).join(' '),
    spoken: ps.map((p) => end(capital(p.spoken))).join(' '),
  };
}

export const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// 'niner' is the ICAO word and synthesisers say it well; 'tree' and 'fife' they mangle.
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];

/** Each digit on its own: '14' -> 'one four'. Letters of a runway designator are spelled. */
export function digits(s: string | number): string {
  return String(s)
    .split('')
    .map((c) => {
      if (c >= '0' && c <= '9') return DIGITS[Number(c)]!;
      if (c === 'L') return 'left';
      if (c === 'R') return 'right';
      if (c === 'C') return 'centre';
      if (c === '-') return 'minus';
      return c;
    })
    .join(' ');
}

const PHONETIC: Record<string, string> = {
  A: 'Alfa',
  B: 'Bravo',
  C: 'Charlie',
  D: 'Delta',
  E: 'Echo',
  F: 'Foxtrot',
  G: 'Golf',
  H: 'Hotel',
  I: 'India',
  J: 'Juliett',
  K: 'Kilo',
  L: 'Lima',
  M: 'Mike',
  N: 'November',
  O: 'Oscar',
  P: 'Papa',
  Q: 'Quebec',
  R: 'Romeo',
  S: 'Sierra',
  T: 'Tango',
  U: 'Uniform',
  V: 'Victor',
  W: 'Whiskey',
  X: 'X-ray',
  Y: 'Yankee',
  Z: 'Zulu',
};

/** The spelling word of a letter: 'A' -> 'Alfa'. */
export const phonetic = (letter: string) => PHONETIC[letter.toUpperCase()] ?? letter;

/** Letters and digits spelled out: 'HB-TFS' -> 'Hotel Bravo Tango Foxtrot Sierra'. */
export function spell(s: string): string {
  return s
    .toUpperCase()
    .split('')
    .filter((c) => c !== '-' && c !== ' ')
    .map((c) => (c >= '0' && c <= '9' ? DIGITS[Number(c)]! : phonetic(c)))
    .join(' ');
}

/**
 * The full and the abbreviated callsign of a registration. ICAO abbreviates a registration
 * to its first character and its last two ('HB-TFS' -> 'HFS'); the controller starts using
 * the short form, the pilot follows.
 */
export function callsign(reg: string, abbreviated: boolean): Line {
  if (!abbreviated) return line(reg, spell(reg));
  const letters = reg.replace(/[- ]/g, '');
  const short = letters.length > 3 ? letters[0]! + letters.slice(-2) : letters;
  return line(short, spell(short));
}

/** Runway designator: 'runway 14' / 'runway one four'. */
export const runway = (ident: string) => line(`runway ${ident}`, `runway ${digits(ident)}`);

/** kHz as MHz with three decimals: 121025 -> '121.025'. */
export function frequencyText(khz: number): string {
  const k = Math.round(khz);
  return `${Math.floor(k / 1000)}.${String(k % 1000).padStart(3, '0')}`;
}

/**
 * A frequency spoken: all six digits, but when the last two are zeros only the first four
 * (ICAO Annex 10, Vol. II, 5.2.1.4.1.4): 121.025 -> 'one two one decimal zero two five',
 * 118.100 -> 'one one eight decimal one'.
 */
export function frequency(khz: number): Line {
  const t = frequencyText(khz);
  const [mhz, dec] = t.split('.') as [string, string];
  const spokenDec = dec.endsWith('00') ? dec.slice(0, 1) : dec;
  return line(t, `${digits(mhz)} decimal ${digits(spokenDec)}`);
}

export const qnh = (hPa: number) =>
  line(`QNH ${Math.round(hPa)}`, `QNH ${digits(Math.round(hPa))}`);

/**
 * Thousands and hundreds are spoken as such: 4500 -> 'four thousand five hundred',
 * 12000 -> 'one two thousand'. Other numbers digit by digit.
 */
export function feetWords(ft: number): string {
  const n = Math.round(ft);
  if (n % 100 !== 0 || n <= 0) return digits(n);
  const th = Math.floor(n / 1000);
  const hu = Math.floor((n % 1000) / 100);
  const parts: string[] = [];
  if (th > 0) parts.push(`${digits(th)} thousand`);
  if (hu > 0) parts.push(`${DIGITS[hu]} hundred`);
  return parts.join(' ');
}

/** '4500 ft' / 'four thousand five hundred feet'. */
export const feet = (ft: number) => line(`${Math.round(ft)} ft`, `${feetWords(ft)} feet`);

/** 'altitude 4500 ft' (above sea level, on QNH). */
export const altitude = (ft: number) =>
  line(`altitude ${Math.round(ft)} ft`, `altitude ${feetWords(ft)} feet`);

/** Three digits: 80 -> '080' / 'zero eight zero'. 0 is 360. */
export function headingText(deg: number): string {
  const d = ((Math.round(deg) % 360) + 360) % 360 || 360;
  return String(d).padStart(3, '0');
}

export const heading = (deg: number) =>
  line(`heading ${headingText(deg)}`, `heading ${digits(headingText(deg))}`);

export const squawk = (code: number) =>
  line(
    `squawk ${String(code).padStart(4, '0')}`,
    `squawk ${digits(String(code).padStart(4, '0'))}`,
  );

/** Whole nautical miles: '12 NM' / 'one two miles'. */
export const miles = (nm: number) => {
  const n = Math.max(1, Math.round(nm));
  return line(`${n} NM`, `${digits(n)} mile${n === 1 ? '' : 's'}`);
};

/**
 * Surface wind as the tower gives it, degrees magnetic rounded to ten, knots:
 * 'wind 250 degrees 5 knots' / 'wind two five zero degrees five knots'. Below one knot: calm.
 */
export function wind(fromMagDeg: number, knots: number, gustKt?: number): Line {
  const kt = Math.round(knots);
  if (kt < 1) return line('wind calm');
  const dir = headingText(Math.round(fromMagDeg / 10) * 10);
  const g =
    gustKt !== undefined && Math.round(gustKt) >= kt + 10
      ? line(` maximum ${Math.round(gustKt)} knots`, ` maximum ${digits(Math.round(gustKt))} knots`)
      : line('');
  return line(
    `wind ${dir} degrees ${kt} knot${kt === 1 ? '' : 's'}${g.text}`,
    `wind ${digits(dir)} degrees ${digits(kt)} knot${kt === 1 ? '' : 's'}${g.spoken}`,
  );
}

const POINTS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
];

/** One of eight compass points for a true bearing. */
export const compassPoint = (bearingDeg: number) =>
  POINTS[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8]!;

/** A temperature in whole degrees: '-3' / 'minus three'. */
export const celsius = (c: number) => {
  const n = Math.round(c);
  return line(String(n), n < 0 ? `minus ${digits(-n)}` : digits(n));
};
