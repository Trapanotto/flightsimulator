import { AIRCRAFT } from '@sim';
import type { LandingRecord, LogEntry, StorageLike } from './types';

export const LOGBOOK_KEY = 'tfs.logbook';
export const LOGBOOK_VERSION = 1;
/** Flights kept; the oldest go first. */
export const LOGBOOK_CAP = 200;
/** Shorter flights are a restart or a slip on the menu, not worth an entry. */
const MIN_DURATION = 20;
const MIN_DISTANCE = 50;

/** Whether a finished flight belongs in the logbook at all. */
export function worthKeeping(entry: LogEntry): boolean {
  return entry.duration >= MIN_DURATION && (entry.distance >= MIN_DISTANCE || entry.airTime > 0);
}

/**
 * The flights in memory, newest first, mirrored to one storage key. Storage can be missing,
 * full or hold anything (an old version, a hand edit): the logbook never throws because of it.
 */
export class Logbook {
  private list: LogEntry[] = [];
  private storage: StorageLike | undefined;

  constructor(
    private readonly cap = LOGBOOK_CAP,
    private readonly key = LOGBOOK_KEY,
  ) {}

  get entries(): readonly LogEntry[] {
    return this.list;
  }

  /** Reads the stored flights and remembers the storage for later writes. */
  load(storage: StorageLike | undefined): readonly LogEntry[] {
    this.storage = storage;
    let text: string | null = null;
    try {
      text = storage?.getItem(this.key) ?? null;
    } catch {
      // Storage can be blocked (privacy settings): an empty logbook then.
    }
    this.list = parseLogbook(text)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, this.cap);
    return this.list;
  }

  add(entry: LogEntry): readonly LogEntry[] {
    let id = entry.id;
    for (let n = 2; this.list.some((e) => e.id === id); n++) id = `${entry.id}-${n}`;
    this.list = [{ ...entry, id }, ...this.list].slice(0, this.cap);
    this.save();
    return this.list;
  }

  remove(id: string): readonly LogEntry[] {
    this.list = this.list.filter((e) => e.id !== id);
    this.save();
    return this.list;
  }

  clear(): readonly LogEntry[] {
    this.list = [];
    this.save();
    return this.list;
  }

  private save(): void {
    const storage = this.storage;
    if (!storage) return;
    // On a full storage the tracks of the oldest flights go first (they are most of the bytes),
    // then the oldest flights themselves. What could not be written stays in memory as stored.
    for (;;) {
      try {
        storage.setItem(this.key, JSON.stringify({ version: LOGBOOK_VERSION, entries: this.list }));
        return;
      } catch {
        const oldestWithTrack = this.list.findLastIndex((e) => e.track.length > 0);
        if (oldestWithTrack >= 0) {
          const next = this.list.slice();
          next[oldestWithTrack] = { ...next[oldestWithTrack]!, track: [] };
          this.list = next;
        } else if (this.list.length > 0) {
          this.list = this.list.slice(0, -1);
        } else {
          return;
        }
      }
    }
  }
}

/** Stored text to entries; whatever does not read as an entry is dropped. */
export function parseLogbook(text: string | null): LogEntry[] {
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  // Version 1 is the first; a newer version written by a later release is still read field by
  // field, since entries only ever gain optional fields.
  const raw = Array.isArray(data) ? data : isObject(data) ? data.entries : undefined;
  if (!Array.isArray(raw)) return [];
  const out: LogEntry[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const entry = parseEntry(item);
    if (entry && !ids.has(entry.id)) {
      ids.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

const AIRCRAFT_IDS = new Set<string>(AIRCRAFT.map((a) => a.id));
const OUTCOMES = new Set<string>(['landed', 'crashed', 'ended']);

function parseEntry(v: unknown): LogEntry | undefined {
  if (!isObject(v)) return undefined;
  const { id, date, aircraft, outcome } = v;
  if (typeof id !== 'string' || !id) return undefined;
  if (typeof date !== 'string' || Number.isNaN(Date.parse(date))) return undefined;
  if (typeof aircraft !== 'string' || !AIRCRAFT_IDS.has(aircraft)) return undefined;
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return undefined;
  const duration = num(v.duration);
  const airTime = num(v.airTime);
  const distance = num(v.distance);
  const maxAltitude = num(v.maxAltitude);
  if (duration === undefined || airTime === undefined || distance === undefined) return undefined;
  if (maxAltitude === undefined) return undefined;
  const entry: LogEntry = {
    id,
    date,
    aircraft: aircraft as LogEntry['aircraft'],
    duration,
    airTime,
    distance,
    maxAltitude,
    outcome: outcome as LogEntry['outcome'],
    landings: Array.isArray(v.landings)
      ? v.landings.map(parseLanding).filter((l) => l !== undefined)
      : [],
    // A damaged track loses its bad points, not the flight.
    track: Array.isArray(v.track)
      ? v.track.filter(
          (p): p is [number, number, number] =>
            Array.isArray(p) && p.length === 3 && p.every((x) => num(x) !== undefined),
        )
      : [],
  };
  if (typeof v.from === 'string') entry.from = v.from;
  if (typeof v.to === 'string') entry.to = v.to;
  if (typeof v.lesson === 'string') entry.lesson = v.lesson;
  if (typeof v.lessonPassed === 'boolean') entry.lessonPassed = v.lessonPassed;
  return entry;
}

function parseLanding(v: unknown): LandingRecord | undefined {
  if (!isObject(v)) return undefined;
  const time = num(v.time);
  const sinkRate = num(v.sinkRate);
  const speed = num(v.speed);
  if (time === undefined || sinkRate === undefined || speed === undefined) return undefined;
  const landing: LandingRecord = { time, sinkRate, speed };
  if (typeof v.airport === 'string') landing.airport = v.airport;
  if (typeof v.runway === 'string') landing.runway = v.runway;
  const centreline = num(v.centreline);
  const pastThreshold = num(v.pastThreshold);
  const load = num(v.load);
  if (centreline !== undefined) landing.centreline = centreline;
  if (pastThreshold !== undefined) landing.pastThreshold = pastThreshold;
  if (load !== undefined) landing.load = load;
  return landing;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
