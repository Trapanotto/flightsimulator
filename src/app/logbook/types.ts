import type { game } from '@ui';

// The contract lives in src/ui/api.ts, but the ui index does not re-export these two types;
// derive them from the signal so the logbook stays in step with the interface.
export type LogEntry = (typeof game.logbook.value)[number];
export type LandingRecord = LogEntry['landings'][number];
export type LogOutcome = LogEntry['outcome'];

/** The part of the Web Storage API the logbook needs (tests pass a plain object). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
