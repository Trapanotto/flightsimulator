/**
 * Works through a checklist: the current item is the first one not done; items with a
 * machine check tick themselves once the cockpit or the telemetry shows them done, in order
 * (so 'master ON' and later 'master OFF' in the same list each wait for their turn).
 */
import { C172_CONTROLS, type ControlSpec, type Telemetry } from '@sim';
import { C172_CHECKLISTS, type Check, type ChecklistDef, type TelemetryKey } from './checklists';

export type Lang = 'de' | 'en';

/** A checklist being worked through (the shape of `ChecklistView` in src/ui/api.ts). */
export interface ChecklistView {
  id: string;
  title: string;
  items: { label: string; expect: string; state: 'done' | 'current' | 'todo'; control?: string }[];
}

export interface ChecklistRunnerState {
  open: string | null;
  /** Items done, per checklist. */
  done: Record<string, boolean[]>;
  /** Checklists finished since the last landing (or the start). */
  completed: string[];
  airborne: boolean;
  /** Has landed at least once: on the ground it is after landing, not before take-off. */
  landed: boolean;
}

const KT = 1.943844;
const FT = 3.28084;

export function telemetryValue(t: Telemetry | null, key: TelemetryKey): number | undefined {
  if (!t) return undefined;
  const sys = t.systems;
  switch (key) {
    case 'rpm':
      return t.engines[0]?.rpm;
    case 'iasKt':
      return t.ias * KT;
    case 'aglFt':
      return t.agl === undefined ? undefined : t.agl * FT;
    case 'groundSpeedKt':
      return t.groundSpeed * KT;
    case 'verticalSpeedFpm':
      return t.verticalSpeed * FT * 60;
    case 'onGround':
      return t.onGround ? 1 : 0;
    case 'engineRunning':
      return t.engines[0]?.running ? 1 : 0;
    case 'busVolts':
      return sys?.busVolts;
    case 'batteryAmps':
      return sys?.batteryAmps;
    case 'oilPressure':
      return sys?.oilPressure;
    case 'vacuum':
      return sys?.vacuum;
    case 'lowVolts':
      return sys ? (sys.annunciators.lowVolts ? 1 : 0) : undefined;
    case 'lowVacuum':
      return sys ? (sys.annunciators.lowVacuum ? 1 : 0) : undefined;
  }
}

/** Whether a check holds. Missing values (no telemetry yet, unknown control) never pass. */
export function evaluate(
  check: Check,
  cockpit: Readonly<Record<string, number>> | null,
  t: Telemetry | null,
  specs: readonly ControlSpec[] = C172_CONTROLS,
): boolean {
  if ('all' in check) return check.all.every((c) => evaluate(c, cockpit, t, specs));
  const inRange = (v: number | undefined, min?: number, max?: number) =>
    v !== undefined &&
    Number.isFinite(v) &&
    (min === undefined || v >= min) &&
    (max === undefined || v <= max);
  if ('telemetry' in check)
    return inRange(telemetryValue(t, check.telemetry), check.min, check.max);
  const v = cockpit?.[check.control];
  if (v === undefined) return false;
  if ('is' in check) {
    const spec = specs.find((s) => s.id === check.control);
    const want = Array.isArray(check.is) ? check.is : [check.is];
    return want.some((w) =>
      typeof w === 'number'
        ? Math.round(v) === w
        : (spec?.positions?.indexOf(w) ?? -1) === Math.round(v),
    );
  }
  return inRange(v, check.min, check.max);
}

/** The control an item is about (the first one its check names). */
export function controlOf(check: Check | undefined): string | undefined {
  if (!check) return undefined;
  if ('all' in check) {
    for (const c of check.all) {
      const id = controlOf(c);
      if (id) return id;
    }
    return undefined;
  }
  return 'control' in check ? check.control : undefined;
}

const AIRBORNE_LISTS = [
  'takeoff',
  'climb',
  'cruise',
  'descent',
  'beforeLanding',
  'afterLanding',
  'securing',
];

export class ChecklistRunner {
  lang: Lang;
  private s: ChecklistRunnerState = {
    open: null,
    done: {},
    completed: [],
    airborne: false,
    landed: false,
  };
  private cockpit: Readonly<Record<string, number>> | null = null;
  private telemetry: Telemetry | null = null;

  constructor(
    readonly lists: readonly ChecklistDef[] = C172_CHECKLISTS,
    private readonly specs: readonly ControlSpec[] = C172_CONTROLS,
    lang: Lang = 'en',
    state?: ChecklistRunnerState,
  ) {
    this.lang = lang;
    if (state) this.s = JSON.parse(JSON.stringify(state)) as ChecklistRunnerState;
  }

  save(): ChecklistRunnerState {
    return JSON.parse(JSON.stringify(this.s)) as ChecklistRunnerState;
  }

  /** The lists on offer, for `game.checklists`. */
  list(): { id: string; title: string }[] {
    return this.lists.map((l) => ({ id: l.id, title: l.title[this.lang] }));
  }

  get openId() {
    return this.s.open;
  }

  /** Opens a checklist (where it was left) or closes the open one with null. */
  open(id: string | null) {
    this.s.open = id && this.lists.some((l) => l.id === id) ? id : null;
    this.evaluate();
  }

  /** Starts a checklist over. */
  reset(id: string) {
    delete this.s.done[id];
    this.s.completed = this.s.completed.filter((c) => c !== id);
    this.evaluate();
  }

  /** The cockpit values and the telemetry, each update. */
  update(cockpit: Readonly<Record<string, number>> | null, telemetry: Telemetry | null) {
    this.cockpit = cockpit;
    this.telemetry = telemetry;
    if (telemetry) {
      if (!telemetry.onGround && (telemetry.agl === undefined || telemetry.agl > 15))
        this.s.airborne = true;
      else if (telemetry.onGround && this.s.airborne && telemetry.groundSpeed < 15) {
        // Landed: the lists of the flight start over for the next one.
        this.s.airborne = false;
        this.s.landed = true;
        this.s.completed = this.s.completed.filter((c) => !AIRBORNE_LISTS.includes(c));
        for (const id of AIRBORNE_LISTS) delete this.s.done[id];
      }
    }
    this.evaluate();
  }

  /** Ticks the current item of the open checklist by hand. */
  tick() {
    const def = this.def();
    if (!def) return;
    const done = this.doneOf(def);
    const i = done.indexOf(false);
    if (i >= 0) done[i] = true;
    this.evaluate();
  }

  view(): ChecklistView | null {
    const def = this.def();
    if (!def) return null;
    const done = this.doneOf(def);
    const current = done.indexOf(false);
    return {
      id: def.id,
      title: def.title[this.lang],
      items: def.items.map((it, i) => {
        const control = controlOf(it.check);
        const v: ChecklistView['items'][number] = {
          label: it.label[this.lang],
          expect: it.expect[this.lang],
          state: done[i] ? 'done' : i === current ? 'current' : 'todo',
        };
        if (control) v.control = control;
        return v;
      }),
    };
  }

  isComplete(id: string) {
    return this.s.completed.includes(id);
  }

  /**
   * The checklist that fits the phase of flight now and is not done yet: an emergency first,
   * otherwise the next normal one. Null when everything fitting is done.
   */
  suggest(): string | null {
    const t = this.telemetry;
    const not = (id: string) => (this.s.completed.includes(id) ? null : id);
    if (!t) return not('preflight');
    const sys = t.systems;
    const running = t.engines[0]?.running ?? false;
    const aglFt = t.agl === undefined ? Infinity : t.agl * FT;
    if (!t.onGround) {
      if (!running)
        return aglFt > 1500 ? (not('engineRestart') ?? not('engineFailure')) : not('engineFailure');
      if (sys?.annunciators.lowVolts) {
        const e = not('lowVoltage');
        if (e) return e;
      }
      if (sys?.annunciators.lowVacuum) {
        const e = not('vacuumFailure');
        if (e) return e;
      }
      if (sys && (sys.airframeIce > 0.1 || sys.pitotBlocked || sys.carbIce > 0.2)) {
        const e = not('icing');
        if (e) return e;
      }
      const vs = t.verticalSpeed * FT * 60;
      if (vs < -300 && aglFt < 2500) return not('beforeLanding') ?? null;
      if (vs < -300) return not('descent') ?? not('beforeLanding');
      if (vs > 300) return not('climb');
      return not('cruise');
    }
    if (!this.s.landed) {
      if (!running) {
        for (const id of ['preflight', 'beforeStart', 'engineStart']) if (not(id)) return id;
        return null;
      }
      return not('beforeTakeoff') ?? not('takeoff');
    }
    return not('afterLanding') ?? not('securing');
  }

  // ----------------------------------------------------------------

  private def(): ChecklistDef | undefined {
    return this.lists.find((l) => l.id === this.s.open);
  }

  private doneOf(def: ChecklistDef): boolean[] {
    let d = this.s.done[def.id];
    if (!d || d.length !== def.items.length) {
      d = def.items.map(() => false);
      this.s.done[def.id] = d;
    }
    return d;
  }

  private evaluate() {
    const def = this.def();
    if (!def) return;
    const done = this.doneOf(def);
    for (let i = done.indexOf(false); i >= 0 && i < def.items.length; i = done.indexOf(false)) {
      const check = def.items[i]!.check;
      if (!check || !evaluate(check, this.cockpit, this.telemetry, this.specs)) break;
      done[i] = true;
    }
    if (done.every(Boolean) && !this.s.completed.includes(def.id)) this.s.completed.push(def.id);
  }
}
