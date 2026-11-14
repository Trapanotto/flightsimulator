/**
 * On/off keying of the navigation tones: Morse idents and the marker beacons. Plain data and
 * maths, so the timing can be tested without audio; NavAudio turns the tones into gain ramps.
 */

/** One keyed tone, seconds. */
export interface Tone {
  start: number;
  end: number;
}

/** A pattern that repeats every `period` seconds; tones are relative to the period's start. */
export interface KeyPattern {
  period: number;
  tones: readonly Tone[];
}

/** International Morse code (ITU-R M.1677), letters and digits: all an ident can contain. */
export const MORSE: Readonly<Record<string, string>> = {
  A: '.-',
  B: '-...',
  C: '-.-.',
  D: '-..',
  E: '.',
  F: '..-.',
  G: '--.',
  H: '....',
  I: '..',
  J: '.---',
  K: '-.-',
  L: '.-..',
  M: '--',
  N: '-.',
  O: '---',
  P: '.--.',
  Q: '--.-',
  R: '.-.',
  S: '...',
  T: '-',
  U: '..-',
  V: '...-',
  W: '.--',
  X: '-..-',
  Y: '-.--',
  Z: '--..',
  '0': '-----',
  '1': '.----',
  '2': '..---',
  '3': '...--',
  '4': '....-',
  '5': '.....',
  '6': '-....',
  '7': '--...',
  '8': '---..',
  '9': '----.',
};

/** Ident tone of VOR, ILS and DME stations (ICAO Annex 10: 1020 Hz). */
export const IDENT_HZ = 1020;
/** Idents are keyed at about 7 words per minute. */
export const IDENT_WPM = 7;
/** A VOR sends its ident at least three times every 30 s: once every 10 s. */
export const IDENT_REPEAT = 10;

/** Length of one Morse unit (a dot) at a speed in words per minute ("PARIS" = 50 units). */
export function morseUnit(wpm: number): number {
  return 1.2 / wpm;
}

/**
 * Keying of a text: dot 1 unit, dash 3, gap inside a letter 1, between letters 3, between
 * words 7. Characters without a code are skipped. `length` is the end of the last tone.
 */
export function morseTones(text: string, wpm = IDENT_WPM): { tones: Tone[]; length: number } {
  const u = morseUnit(wpm);
  const tones: Tone[] = [];
  let t = 0;
  let pendingGap = 0;
  for (const ch of text.toUpperCase()) {
    if (ch === ' ') {
      if (tones.length) pendingGap = 7;
      continue;
    }
    const code = MORSE[ch];
    if (!code) continue;
    t += pendingGap * u;
    for (let i = 0; i < code.length; i++) {
      if (i > 0) t += u;
      const len = code[i] === '-' ? 3 : 1;
      tones.push({ start: t, end: t + len * u });
      t += len * u;
    }
    pendingGap = 3;
  }
  return { tones, length: t };
}

/** The ident of a station, repeated every IDENT_REPEAT seconds (longer idents get a pause). */
export function identPattern(ident: string, wpm = IDENT_WPM): KeyPattern {
  const { tones, length } = morseTones(ident, wpm);
  return { period: Math.max(IDENT_REPEAT, length + 2), tones };
}

export type MarkerId = 'outer' | 'middle' | 'inner';

/**
 * Marker beacons, ICAO Annex 10 Vol. I 3.1.7.4: outer 400 Hz keyed with two dashes per second,
 * middle 1300 Hz with alternating dots and dashes at 95 dot-dash pairs per minute, inner
 * 3000 Hz with six dots per second. A dash is three times a dot; the gaps are one dot long.
 */
export const MARKERS: Readonly<Record<MarkerId, { hz: number } & KeyPattern>> = (() => {
  const om = 0.5 / 4;
  const mm = 60 / 95 / 6;
  const im = 1 / 6 / 2;
  return {
    outer: { hz: 400, period: 0.5, tones: [{ start: 0, end: 3 * om }] },
    middle: {
      hz: 1300,
      period: 60 / 95,
      tones: [
        { start: 0, end: mm },
        { start: 2 * mm, end: 5 * mm },
      ],
    },
    inner: { hz: 3000, period: 1 / 6, tones: [{ start: 0, end: im }] },
  };
})();

/**
 * Hands out the tones of a repeating pattern a little ahead of time, so the audio thread can
 * key them sample-exactly while the main thread only wakes up once per frame.
 */
export class PatternKeyer {
  private pattern: KeyPattern | undefined;
  private origin = 0;
  /** Index of the next period and of the next tone in it. */
  private period = 0;
  private index = 0;
  /** End of the last tone handed out. */
  lastEnd = 0;

  get running(): boolean {
    return this.pattern !== undefined;
  }

  /** Starts the pattern with its first period at `at`. */
  start(pattern: KeyPattern, at: number) {
    this.pattern = pattern;
    this.origin = at;
    this.period = 0;
    this.index = 0;
  }

  /** No new tones; the ones already handed out still play to their end. */
  stop() {
    this.pattern = undefined;
  }

  /**
   * The tones that start before `until`. Tones whose start already lies before `now` are
   * dropped (the page was busy or hidden): keying them late would play them out of rhythm.
   */
  take(now: number, until: number): Tone[] {
    const out: Tone[] = [];
    const p = this.pattern;
    if (!p || p.tones.length === 0) return out;
    for (;;) {
      const tone = p.tones[this.index]!;
      const base = this.origin + this.period * p.period;
      const start = base + tone.start;
      if (start >= until) break;
      if (start >= now) {
        out.push({ start, end: base + tone.end });
        this.lastEnd = base + tone.end;
      }
      this.index++;
      if (this.index >= p.tones.length) {
        this.index = 0;
        this.period++;
      }
      // After a long stall, skip whole periods instead of walking through each tone.
      if (this.index === 0 && this.origin + (this.period + 1) * p.period < now)
        this.period = Math.floor((now - this.origin) / p.period);
    }
    return out;
  }
}

/** A breakpoint of a gain envelope: ramp linearly to `value` reaching it at `time`. */
export interface EnvelopePoint {
  time: number;
  value: number;
}

/**
 * Gain breakpoints for keyed tones with soft edges: each edge ramps over `rise` seconds,
 * centred on the tone's start and end, so the tone keeps its length at half amplitude and
 * there is no click. Tones closer than two ramps stay distinct.
 */
export function keyedEnvelope(
  tones: readonly Tone[],
  level: number,
  rise = 0.005,
): EnvelopePoint[] {
  const pts: EnvelopePoint[] = [];
  for (const t of tones) {
    const r = Math.min(rise, (t.end - t.start) / 2);
    pts.push({ time: t.start - r / 2, value: 0 });
    pts.push({ time: t.start + r / 2, value: level });
    pts.push({ time: t.end - r / 2, value: level });
    pts.push({ time: t.end + r / 2, value: 0 });
  }
  return pts;
}
