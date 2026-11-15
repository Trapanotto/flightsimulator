/**
 * Which lessons were passed, kept in the browser under one key. Whatever is stored there may
 * be from an older version, edited by hand or cut off: anything that is not a list of lesson
 * ids reads as no progress rather than an error.
 */

/** The part of `Storage` the progress needs (so tests and private windows can do without it). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PROGRESS_KEY = 'tfs.school.v1';

export class SchoolProgress {
  private readonly passed = new Set<string>();

  constructor(
    private readonly storage: StorageLike | null = null,
    private readonly key = PROGRESS_KEY,
  ) {
    let raw: string | null = null;
    try {
      raw = storage?.getItem(key) ?? null;
    } catch {
      // Storage can throw (blocked site data): start without progress.
    }
    if (!raw) return;
    try {
      const data: unknown = JSON.parse(raw);
      const ids = (data as { passed?: unknown } | null)?.passed;
      if (Array.isArray(ids))
        for (const id of ids) if (typeof id === 'string' && id.length < 100) this.passed.add(id);
    } catch {
      // Corrupt: as if nothing was passed yet.
    }
  }

  isPassed(id: string): boolean {
    return this.passed.has(id);
  }

  /** The ids passed, in the order they were first passed. */
  ids(): string[] {
    return [...this.passed];
  }

  /** Records a pass and saves it; false when nothing changed. */
  markPassed(id: string): boolean {
    if (this.passed.has(id)) return false;
    this.passed.add(id);
    this.save();
    return true;
  }

  reset() {
    this.passed.clear();
    this.save();
  }

  private save() {
    try {
      this.storage?.setItem(this.key, JSON.stringify({ passed: [...this.passed] }));
    } catch {
      // Full or blocked storage: the progress lives on for this session.
    }
  }
}
