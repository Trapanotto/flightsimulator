import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../src/ui/api';
import { MS_TO_FPM } from '../src/ui/format';
import { ALL_MESSAGES } from '../src/ui/i18n';
import { formatReplayTime, logbookTotals, touchdownRating } from '../src/ui/logbook';

const fpm = (v: number) => v / MS_TO_FPM;

describe('touchdownRating', () => {
  it('rates by sink rate at 120, 300 and 600 ft/min', () => {
    expect(touchdownRating(fpm(0))).toBe('soft');
    expect(touchdownRating(fpm(119))).toBe('soft');
    expect(touchdownRating(fpm(120))).toBe('normal');
    expect(touchdownRating(fpm(299))).toBe('normal');
    expect(touchdownRating(fpm(300))).toBe('firm');
    expect(touchdownRating(fpm(599))).toBe('firm');
    expect(touchdownRating(fpm(600))).toBe('hard');
    expect(touchdownRating(fpm(1500))).toBe('hard');
  });
});

describe('logbookTotals', () => {
  const entry = (airTime: number, landings: number): LogEntry => ({
    id: String(Math.random()),
    date: '2026-11-14T10:00:00Z',
    aircraft: 'c172',
    duration: airTime + 120,
    airTime,
    distance: 0,
    maxAltitude: 0,
    landings: Array.from({ length: landings }, () => ({ time: 0, sinkRate: 1, speed: 30 })),
    outcome: 'landed',
    track: [],
  });

  it('sums flights, time in the air and landings', () => {
    expect(logbookTotals([entry(600, 1), entry(3000, 3), entry(0, 0)])).toEqual({
      flights: 3,
      airTime: 3600,
      landings: 4,
    });
    expect(logbookTotals([])).toEqual({ flights: 0, airTime: 0, landings: 0 });
  });
});

describe('formatReplayTime', () => {
  it('shows mm:ss, minutes going on past an hour', () => {
    expect(formatReplayTime(0)).toBe('00:00');
    expect(formatReplayTime(65.9)).toBe('01:05');
    expect(formatReplayTime(3725)).toBe('62:05');
    expect(formatReplayTime(-3)).toBe('00:00');
  });
});

describe('phase 5 texts', () => {
  const PREFIXES = ['school.', 'lesson.', 'logbook.', 'rating.', 'replay.', 'photo.'];
  const keys = Object.keys(ALL_MESSAGES.de).filter(
    (k) => PREFIXES.some((p) => k.startsWith(p)) || k === 'pause.replay' || k === 'pause.photo',
  );

  it('has every new text in German and English, German without the sharp s', () => {
    expect(keys.length).toBeGreaterThan(80);
    for (const k of keys) {
      const de = ALL_MESSAGES.de[k as keyof typeof ALL_MESSAGES.de];
      const en = ALL_MESSAGES.en[k as keyof typeof ALL_MESSAGES.en];
      expect(de.trim(), k).not.toBe('');
      expect(en.trim(), k).not.toBe('');
      expect(de, k).not.toContain('ß');
    }
  });
});
