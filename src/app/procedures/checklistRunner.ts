/**
 * Works through a checklist: the current item is the first one not done; items with a
 * machine check tick themselves once the cockpit or the telemetry shows them done, in order
 * (so 'master ON' and later 'master OFF' in the same list each wait for their turn).
 */
import { C172_CONTROLS, type ControlSpec, type Telemetry } from '@sim';
import {
  C172_CHECKLISTS,
  type Check,
  type ChecklistDef,
  type Phase,
  type TelemetryKey,
} from './checklists';

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
const DEG = 180 / Math.PI;
const flag = (b: boolean | undefined) => (b === undefined ? undefined : b ? 1 : 0);

export function telemetryValue(
  t: Telemetry | null,
  key: TelemetryKey,
  engine = 0,
): number | undefined {
  if (!t) return undefined;
  const sys = t.systems;
  const e = t.engines[engine];
  switch (key) {
    case 'rpm':
      return e?.rpm;
    case 'enginesRunning':
      return t.engines.filter((x) => x.running).length;
    case 'engineStarting':
      return e ? (e.starting ? 1 : 0) : undefined;
    case 'n2':
      return e?.n2;
    case 'n1':
      return e?.n1;
    case 'itt':
      return e?.turbineTemperature;
    case 'torque':
      return e?.torque;
    case 'propRpm':
      return e?.propRpm;
    case 'afterburner':
      return e ? (e.afterburner ?? 0) : undefined;
    case 'reversing':
      return e ? (e.reversing ? 1 : 0) : undefined;
    case 'gear':
      return t.gear;
    case 'flaps':
      return t.flaps;
    case 'speedbrake':
      return t.speedbrake;
    case 'mach':
      return t.mach;
    case 'alphaDeg':
      return t.alpha * DEG;
    case 'pitchDeg':
      return t.pitch * DEG;
    case 'bankDeg':
      return t.bank * DEG;
    case 'altitudeFt':
      return (t.instruments?.altitude ?? t.altitude) * FT;
    case 'cabinAltitudeFt':
      return sys?.cabinAltitude === undefined ? undefined : sys.cabinAltitude * FT;
    case 'cabinAltitudeWarning':
      return sys ? (sys.annunciators.cabinAltitude ? 1 : 0) : undefined;
    case 'gearUnsafe':
      return sys ? (sys.annunciators.gearUnsafe ? 1 : 0) : undefined;
    case 'hydraulicsLow':
      return sys ? (sys.annunciators.hydraulics ? 1 : 0) : undefined;
    case 'generatorsOff':
      return sys ? (sys.annunciators.generators ?? []).filter(Boolean).length : undefined;
    case 'baroStd':
      return t.instruments ? (t.instruments.baroStd ? 1 : 0) : undefined;
    case 'stallWarning':
      return flag(t.stallWarning);
    case 'airframeIce':
      return sys?.airframeIce;
    case 'carbIce':
      return sys?.carbIce;
    case 'pitotBlocked':
      return sys ? (sys.pitotBlocked ? 1 : 0) : undefined;
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
      return e?.running ? 1 : 0;
    case 'busVolts':
      return sys?.busVolts;
    case 'batteryAmps':
      return sys?.batteryAmps;
    case 'oilPressure':
      // The systems report the first engine's; a twin reports each engine's too.
      return e?.oilPressure ?? (engine === 0 ? sys?.oilPressure : undefined);
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
  if ('any' in check) return check.any.some((c) => evaluate(c, cockpit, t, specs));
  const inRange = (v: number | undefined, min?: number, max?: number) =>
    v !== undefined &&
    Number.isFinite(v) &&
    (min === undefined || v >= min) &&
    (max === undefined || v <= max);
  if ('telemetry' in check)
    return inRange(telemetryValue(t, check.telemetry, check.engine), check.min, check.max);
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
  if ('all' in check || 'any' in check) {
    for (const c of 'all' in check ? check.all : check.any) {
      const id = controlOf(c);
      if (id) return id;
    }
    return undefined;
  }
  return 'control' in check ? check.control : undefined;
}

const PHASES: readonly Phase[] = [
  'preflight',
  'cockpitPreparation',
  'beforeStart',
  'engineStart',
  'afterStart',
  'beforeTaxi',
  'taxi',
  'beforeTakeoff',
  'takeoff',
  'climb',
  'cruise',
  'descent',
  'approach',
  'beforeLanding',
  'landing',
  'afterLanding',
  'parking',
  'shutdown',
  'securing',
];

/** The phase a normal list is due in: its own, or the one its id names. */
export function phaseOf(def: ChecklistDef): Phase | undefined {
  if (def.kind !== 'normal') return undefined;
  return (
    def.phase ?? ((PHASES as readonly string[]).find((p) => p === def.id) as Phase | undefined)
  );
}

/** Engines not all running: the start lists are still due. */
const COLD: readonly Phase[] = ['preflight', 'cockpitPreparation', 'beforeStart', 'engineStart'];
const READY: readonly Phase[] = ['afterStart', 'beforeTaxi', 'taxi', 'beforeTakeoff', 'takeoff'];
const DESCENT: readonly Phase[] = ['descent', 'approach', 'beforeLanding', 'landing'];
const ARRIVED: readonly Phase[] = ['afterLanding', 'parking', 'shutdown', 'securing'];
/** Lists of one flight: they start over after a landing. */
const OF_THE_FLIGHT: readonly Phase[] = ['takeoff', 'climb', 'cruise', ...DESCENT, ...ARRIVED];
/** Below this height above ground a descent list without `belowFt` is the approach's. */
const LOW_FT = 2500;

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
        const again = this.lists
          .filter((l) => {
            const p = phaseOf(l);
            return p !== undefined && OF_THE_FLIGHT.includes(p);
          })
          .map((l) => l.id);
        this.s.completed = this.s.completed.filter((c) => !again.includes(c));
        for (const id of again) delete this.s.done[id];
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
    const open = (phases: readonly Phase[], pick?: (l: ChecklistDef) => boolean) =>
      this.lists.find((l) => {
        const p = phaseOf(l);
        return (
          p !== undefined &&
          phases.includes(p) &&
          !this.s.completed.includes(l.id) &&
          (!pick || pick(l))
        );
      })?.id ?? null;
    if (!t) return open(['preflight', 'cockpitPreparation']);
    const emergency = this.dueEmergency(t);
    if (emergency) return emergency;
    // Jets have no propeller to watch: an engine counts as started when it says it runs.
    const running = t.engines.filter((e) => e.running).length;
    const allRunning = t.engines.length > 0 && running === t.engines.length;
    const aglFt = t.agl === undefined ? Infinity : t.agl * FT;
    if (!t.onGround) {
      const vs = t.verticalSpeed * FT * 60;
      if (vs < -300) {
        const below = (l: ChecklistDef) =>
          l.belowFt ?? (phaseOf(l) === 'descent' ? Infinity : LOW_FT);
        const low = this.lists.some((l) => {
          const p = phaseOf(l);
          return (
            p !== undefined && DESCENT.includes(p) && Number.isFinite(below(l)) && aglFt < below(l)
          );
        });
        return low
          ? open(DESCENT, (l) => Number.isFinite(below(l)) && aglFt < below(l))
          : open(DESCENT);
      }
      if (vs > 300) return open(['climb']);
      return open(['cruise']);
    }
    if (!this.s.landed) return allRunning ? open(READY) : open(COLD);
    return open(ARRIVED);
  }

  /** The first emergency list whose trigger holds now and that is not done yet. */
  private dueEmergency(t: Telemetry): string | null {
    const departure = t.onGround && !this.s.airborne && !this.s.landed;
    const due = this.lists
      .filter((l) => {
        if (l.kind !== 'emergency' || !l.trigger || this.s.completed.includes(l.id)) return false;
        if ((l.when ?? 'air') === 'air' ? t.onGround : !departure) return false;
        if (l.requires && !this.s.completed.includes(l.requires)) return false;
        return evaluate(l.trigger, this.cockpit, t, this.specs);
      })
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return due[0]?.id ?? null;
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
