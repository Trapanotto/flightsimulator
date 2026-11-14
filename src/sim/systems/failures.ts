import type { FailureId, Failures } from '../systemsTypes';

/** Every failure a C172S knows; the systems read them each step. */
export const ALL_FAILURES: readonly FailureId[] = [
  'engine',
  'alternator',
  'vacuum',
  'pitot',
  'fuelLeak',
  'com1',
  'magnetoLeft',
];

export class FailureSet implements Failures {
  private readonly failed = new Set<FailureId>();

  constructor(readonly ids: readonly FailureId[] = ALL_FAILURES) {}

  active(id: FailureId): boolean {
    return this.failed.has(id);
  }

  set(id: FailureId, failed: boolean) {
    if (!this.ids.includes(id)) return;
    if (failed) this.failed.add(id);
    else this.failed.delete(id);
  }

  clear() {
    this.failed.clear();
  }
}
