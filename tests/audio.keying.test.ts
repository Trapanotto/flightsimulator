import { describe, expect, it } from 'vitest';
import {
  IDENT_HZ,
  MARKERS,
  MORSE,
  PatternKeyer,
  identPattern,
  keyedEnvelope,
  morseTones,
  morseUnit,
} from '../src/audio/keying';
import { DISCONNECT_TONE } from '../src/audio/CockpitSound';

const u7 = 1.2 / 7;

describe('Morse ident', () => {
  it('uses the 1020 Hz ident tone and the PARIS timing', () => {
    expect(IDENT_HZ).toBe(1020);
    // "PARIS " is 50 units: one word per minute at 1.2 s per unit.
    expect(morseUnit(1)).toBeCloseTo(1.2, 9);
    const paris = morseTones('PARIS PARIS', 7);
    const second = paris.tones[paris.tones.length / 2]!;
    expect(second.start).toBeCloseTo(50 * u7, 9);
  });

  it('keys KLO with dots of one unit, dashes of three and the right gaps', () => {
    const { tones, length } = morseTones('KLO');
    // K -.-  L .-..  O ---
    const units = tones.map((t) => Math.round((t.end - t.start) / u7));
    expect(units).toEqual([3, 1, 3, 1, 3, 1, 1, 3, 3, 3]);
    const gaps = tones.slice(1).map((t, i) => Math.round((t.start - tones[i]!.end) / u7));
    expect(gaps).toEqual([1, 1, 3, 1, 1, 1, 3, 1, 1]);
    // 9 + 3 + 9 + 3 + 11 = 35 units.
    expect(length).toBeCloseTo(35 * u7, 9);
    expect(identPattern('KLO').period).toBe(10);
  });

  it('knows every letter and digit and skips what it cannot key', () => {
    expect(Object.keys(MORSE)).toHaveLength(36);
    expect(morseTones('k-l').tones).toEqual(morseTones('KL').tones);
    expect(morseTones('').tones).toEqual([]);
  });
});

describe('marker beacons (ICAO Annex 10)', () => {
  it('have their pitches', () => {
    expect(MARKERS.outer.hz).toBe(400);
    expect(MARKERS.middle.hz).toBe(1300);
    expect(MARKERS.inner.hz).toBe(3000);
  });

  it('key two dashes a second, 95 dot-dash pairs a minute and six dots a second', () => {
    expect(1 / MARKERS.outer.period).toBeCloseTo(2, 9);
    expect(60 / MARKERS.middle.period).toBeCloseTo(95, 9);
    expect(1 / MARKERS.inner.period).toBeCloseTo(6, 9);
    const [dot, dash] = MARKERS.middle.tones;
    expect((dash!.end - dash!.start) / (dot!.end - dot!.start)).toBeCloseTo(3, 9);
    expect(MARKERS.outer.tones).toHaveLength(1);
    expect(MARKERS.inner.tones).toHaveLength(1);
  });
});

describe('pattern keyer', () => {
  it('hands out each tone once, a window at a time', () => {
    const k = new PatternKeyer();
    k.start(MARKERS.inner, 1);
    const got = [...k.take(1, 1.25), ...k.take(1.1, 1.5), ...k.take(1.4, 2)];
    expect(got).toHaveLength(6);
    got.forEach((t, i) => expect(t.start).toBeCloseTo(1 + i / 6, 9));
  });

  it('drops tones it is late for instead of playing them out of rhythm', () => {
    const k = new PatternKeyer();
    k.start(MARKERS.outer, 0);
    k.take(0, 0.3);
    const late = k.take(100.2, 100.6);
    expect(late.map((t) => t.start)).toEqual([100.5]);
  });

  it('stops handing out tones but remembers when the last one ends', () => {
    const k = new PatternKeyer();
    k.start(DISCONNECT_TONE, 0);
    k.take(0, 0.3);
    k.stop();
    expect(k.running).toBe(false);
    expect(k.take(0.3, 5)).toEqual([]);
    expect(k.lastEnd).toBeCloseTo(0.22, 9);
  });
});

describe('keyed envelope', () => {
  it('ramps every edge, keeps the length at half amplitude, and rises monotonically in time', () => {
    const pts = keyedEnvelope(morseTones('KLO').tones, 0.1, 0.005);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.time).toBeGreaterThan(pts[i - 1]!.time);
    expect(pts[0]!.value).toBe(0);
    expect(pts[pts.length - 1]!.value).toBe(0);
    // The first dash: half amplitude at 0 and at 3 units.
    expect((pts[0]!.time + pts[1]!.time) / 2).toBeCloseTo(0, 9);
    expect((pts[2]!.time + pts[3]!.time) / 2).toBeCloseTo(3 * u7, 9);
    expect(pts[1]!.time - pts[0]!.time).toBeCloseTo(0.005, 9);
  });
});
