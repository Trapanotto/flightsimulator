/**
 * Phase 5: the logic behind the logbook, the flight school and the replay bar. Pure
 * functions, tested in Node; the screens only lay out what these return.
 */
import type { LessonInfo, LogEntry } from './api';
import { M_TO_FT, M_TO_NM, MS_TO_FPM, type NumberLang, type Units, groupThousands } from './format';

/** How a touchdown felt, from its sink rate. */
export type TouchdownRating = 'soft' | 'normal' | 'firm' | 'hard';

/**
 * The touchdown in plain words. Thresholds in ft/min as instructors use them: under 120 a
 * greaser, under 300 an ordinary landing, under 600 firm, beyond that hard (most light
 * aircraft handbooks call for an inspection somewhere past that).
 */
export function touchdownRating(sinkRate: number): TouchdownRating {
  // To a tenth of a ft/min, so a rate given in ft/min lands on its own side of a threshold.
  const fpm =
    Math.round(Math.max(0, Number.isFinite(sinkRate) ? sinkRate : 0) * MS_TO_FPM * 10) / 10;
  if (fpm < 120) return 'soft';
  if (fpm < 300) return 'normal';
  if (fpm < 600) return 'firm';
  return 'hard';
}

export interface LogbookTotals {
  flights: number;
  /** Seconds in the air over all flights: what a pilot's logbook sums up as flight time. */
  airTime: number;
  landings: number;
}

export function logbookTotals(entries: readonly LogEntry[]): LogbookTotals {
  let airTime = 0;
  let landings = 0;
  for (const e of entries) {
    airTime += Math.max(0, e.airTime || 0);
    landings += e.landings.length;
  }
  return { flights: entries.length, airTime, landings };
}

/** Newest first, whatever order the app delivers (ISO dates sort as text). */
export function newestFirst(entries: readonly LogEntry[]): LogEntry[] {
  return [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** A time of the replay as mm:ss; minutes go on past 59 rather than adding an hour field. */
export function formatReplayTime(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** A flight's length: '42 min' below an hour, '1 h 05' above. */
export function formatFlightTime(seconds: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) / 60));
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')}`;
}

/** Total flight hours as a logbook sums them: hours and minutes, '12:05'. */
export function formatHours(seconds: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) / 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Distance over the ground: nautical miles under 'aviation', kilometres otherwise. */
export function formatDistance(
  m: number,
  units: Units,
  lang: NumberLang,
): { value: string; unit: string } {
  const v = units === 'aviation' ? m * M_TO_NM : m / 1000;
  const unit = units === 'aviation' ? 'NM' : 'km';
  if (!Number.isFinite(v)) return { value: '–', unit };
  return { value: v < 100 ? v.toFixed(1) : groupThousands(v, lang), unit };
}

/** A short length on the runway (centre line, past the threshold): feet or metres, whole. */
export function formatRunwayLength(
  m: number,
  units: Units,
  lang: NumberLang,
): { value: string; unit: string } {
  const unit = units === 'aviation' ? 'ft' : 'm';
  if (!Number.isFinite(m)) return { value: '–', unit };
  return { value: groupThousands(Math.abs(units === 'aviation' ? m * M_TO_FT : m), lang), unit };
}

/** A touchdown's sink rate, unsigned: ft/min in steps of 10, or m/s with one decimal. */
export function formatSinkRate(
  ms: number,
  units: Units,
  lang: NumberLang,
): { value: string; unit: string } {
  const v = Math.max(0, Number.isFinite(ms) ? ms : 0);
  return units === 'aviation'
    ? { value: groupThousands(Math.round((v * MS_TO_FPM) / 10) * 10, lang), unit: 'ft/min' }
    : { value: v.toFixed(1), unit: 'm/s' };
}

/** The lesson after `id` in teaching order, if there is one. */
export function nextLesson(lessons: readonly LessonInfo[], id: string): LessonInfo | undefined {
  const i = lessons.findIndex((l) => l.id === id);
  return i >= 0 ? lessons[i + 1] : undefined;
}

/** The lesson to suggest: the first one not yet passed. */
export function suggestedLesson(lessons: readonly LessonInfo[]): LessonInfo | undefined {
  return lessons.find((l) => !l.done);
}

/** The playback speeds the replay offers (the contract's `replaySpeed`). */
export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

export function formatSpeedFactor(speed: number): string {
  return `${speed}×`;
}
