/**
 * Flies a lesson with the pilot: the current step's instruction, its hints while the pilot is
 * off, the step's completion (held for a while where the lesson asks), failures, and at the
 * end the debrief. Steps only ever move forward: a pilot who drifts off again after a step is
 * done gets hints, not the step back.
 *
 * `update` runs every frame and allocates nothing; `view` builds the interface's object and is
 * meant for a few times a second.
 */
import {
  A320_CONTROLS,
  C172_CONTROLS,
  FA18_CONTROLS,
  PC12_CONTROLS,
  type AircraftId,
  type ControlSpec,
  type Telemetry,
} from '@sim';
import { holds, relativeKeys, relativeValue, valueOf, type SchoolContext } from './conditions';
import { RunwayGeometry, type RunwayPosition } from './runway';
import type {
  Bilingual,
  ControlValues,
  EventField,
  FailDef,
  HintDef,
  LessonDef,
  LessonView,
  MeasureDef,
  Place,
  ValueKey,
} from './types';

export type LessonState = LessonView['state'];
export type DebriefLine = NonNullable<LessonView['debrief']>[number];

const FT = 3.28084;
const KT = 1.943844;
const RAD = 180 / Math.PI;
/** Continuous air time after which a ground contact counts as a landing, s. */
const AIRBORNE_AFTER = 2;

/** The control table of a type (the Cessna's for an unknown one). */
export function controlsOf(id: AircraftId): readonly ControlSpec[] {
  switch (id) {
    case 'pc12':
      return PC12_CONTROLS;
    case 'a320':
      return A320_CONTROLS;
    case 'fa18':
      return FA18_CONTROLS;
    default:
      return C172_CONTROLS;
  }
}

const CRASHED: Bilingual = {
  de: 'Das war zu viel für das Flugzeug. Wir versuchen es gleich noch einmal.',
  en: 'That was too much for the aircraft. Let us try it again.',
};
const PASSED: Bilingual = {
  de: 'Lektion bestanden. Gut geflogen!',
  en: 'Lesson passed. Well flown!',
};

/** A lift-off or touchdown as measured. NaN for what is unknown (no runway, no position). */
interface FlightEvent {
  seen: boolean;
  sinkFpm: number;
  iasKt: number;
  centrelineM: number;
  pastThresholdM: number;
  pitchDeg: number;
}

const newEvent = (): FlightEvent => ({
  seen: false,
  sinkFpm: NaN,
  iasKt: NaN,
  centrelineM: NaN,
  pastThresholdM: NaN,
  pitchDeg: NaN,
});

/** The running figure of one debrief line. */
interface Tally {
  value: number;
  samples: number;
  /** afterTouchdown: seconds so far, and whether it is settled. */
  done: boolean;
}

export class LessonRunner {
  readonly lesson: LessonDef;
  private stepIndex = 0;
  private current: LessonState = 'running';
  private stepTime = 0;
  private holdTime = 0;
  private started = false;
  private shownHint: Bilingual | undefined;
  private failure: Bilingual | undefined;
  private result: DebriefLine[] | undefined;

  private readonly ctx: SchoolContext;
  private readonly geometry: RunwayGeometry | undefined;
  private readonly position: RunwayPosition = {
    centrelineM: 0,
    alongM: 0,
    pathFt: 0,
    runwayHeightFt: 0,
  };
  /** Keys some condition compares relatively: their values are kept at each start. */
  private readonly keys: readonly string[];
  /** Seconds each hint and failure condition has held, lesson-wide ones first. */
  private readonly hintTimers: number[];
  private readonly failTimers: number[];
  private readonly tallies: Tally[];

  private airTime = 0;
  private wasOnGround: boolean | undefined;
  private lastVs = 0;
  private readonly liftoff = newEvent();
  private readonly touchdown = newEvent();

  constructor(lesson: LessonDef, specs: readonly ControlSpec[] = controlsOf(lesson.aircraft)) {
    this.lesson = lesson;
    const positions = new Map<string, readonly string[]>();
    for (const s of specs) if (s.positions) positions.set(s.id, s.positions);
    this.ctx = {
      telemetry: null,
      cockpit: null,
      positions,
      runway: null,
      stepTime: 0,
      lessonRef: new Map(),
      stepRef: new Map(),
    };
    const rw =
      lesson.runway ??
      (lesson.plan.start.kind === 'air'
        ? undefined
        : { airport: lesson.plan.start.airport, ident: lesson.plan.start.runway });
    this.geometry = rw && RunwayGeometry.of(rw.airport, rw.ident);

    // Only the keys compared relatively anywhere are remembered, at the start of the lesson
    // and of every step: a handful of numbers instead of every value.
    const keys = new Set<string>();
    const condsOf = (h: readonly (HintDef | FailDef)[] | undefined) => (h ?? []).map((x) => x.when);
    for (const c of [...condsOf(lesson.hints), ...condsOf(lesson.fail)]) relativeKeys(c, keys);
    for (const s of lesson.steps)
      for (const c of [s.done, ...condsOf(s.hints), ...condsOf(s.fail)]) relativeKeys(c, keys);
    for (const m of lesson.debrief) {
      if (m.kind === 'range' && m.rel) keys.add(m.value);
      if (m.kind === 'afterTouchdown') relativeKeys(m.until, keys);
    }
    this.keys = [...keys];

    const lessonHints = lesson.hints?.length ?? 0;
    const lessonFails = lesson.fail?.length ?? 0;
    const maxHints = Math.max(0, ...lesson.steps.map((s) => s.hints?.length ?? 0));
    const maxFails = Math.max(0, ...lesson.steps.map((s) => s.fail?.length ?? 0));
    this.hintTimers = new Array<number>(lessonHints + maxHints).fill(0);
    this.failTimers = new Array<number>(lessonFails + maxFails).fill(0);
    this.tallies = lesson.debrief.map(() => ({ value: NaN, samples: 0, done: false }));
  }

  get state(): LessonState {
    return this.current;
  }

  /** The current step, 0-based (the last one stays current once the lesson is over). */
  get step(): number {
    return this.stepIndex;
  }

  /** 0..1 while a step is being held; undefined for a step without `hold`. */
  get progress(): number | undefined {
    const hold = this.lesson.steps[this.stepIndex]?.hold;
    if (!hold || this.current !== 'running') return undefined;
    return Math.min(1, this.holdTime / hold);
  }

  get hint(): Bilingual | undefined {
    return this.shownHint;
  }

  /** Filled once the lesson is passed or failed. */
  get debrief(): readonly DebriefLine[] | undefined {
    return this.result;
  }

  /**
   * One frame. `place` (position and height above sea level) is needed for the runway values:
   * centre line, approach path, distance past the threshold.
   */
  update(
    dt: number,
    telemetry: Telemetry,
    cockpit: ControlValues | null,
    place?: Place | null,
  ): void {
    if (this.current !== 'running' || !(dt > 0)) return;
    dt = Math.min(dt, 0.5);
    const ctx = this.ctx;
    ctx.telemetry = telemetry;
    ctx.cockpit = cockpit;
    ctx.runway =
      this.geometry && place
        ? this.geometry.measure(place.lon, place.lat, place.msl, this.position)
        : null;
    if (!this.started) {
      this.started = true;
      this.remember(ctx.lessonRef);
      this.remember(ctx.stepRef);
    }
    this.stepTime += dt;
    ctx.stepTime = this.stepTime;
    this.events(dt, telemetry);
    this.measure(dt);

    if (telemetry.crashed) return this.fail(CRASHED);
    const step = this.lesson.steps[this.stepIndex];
    if (!step) return this.pass();

    // Failures first: a lesson that fails shows why, not the hint of the moment.
    const lessonFails = this.lesson.fail ?? [];
    for (let i = 0; i < lessonFails.length; i++)
      if (this.timed(this.failTimers, i, lessonFails[i]!.when, dt) >= (lessonFails[i]!.after ?? 0))
        return this.fail(lessonFails[i]!.say);
    const stepFails = step.fail ?? [];
    for (let i = 0; i < stepFails.length; i++) {
      const j = lessonFails.length + i;
      if (this.timed(this.failTimers, j, stepFails[i]!.when, dt) >= (stepFails[i]!.after ?? 0))
        return this.fail(stepFails[i]!.say);
    }

    // The step's own hints come before the lesson-wide ones: they are about what is being done.
    this.shownHint = undefined;
    const lessonHints = this.lesson.hints ?? [];
    const stepHints = step.hints ?? [];
    for (let i = 0; i < stepHints.length; i++) {
      const h = stepHints[i]!;
      const held = this.timed(this.hintTimers, lessonHints.length + i, h.when, dt);
      if (!this.shownHint && held >= (h.after ?? 1)) this.shownHint = h.say;
    }
    for (let i = 0; i < lessonHints.length; i++) {
      const h = lessonHints[i]!;
      const held = this.timed(this.hintTimers, i, h.when, dt);
      if (!this.shownHint && held >= (h.after ?? 1)) this.shownHint = h.say;
    }

    if (holds(ctx, step.done)) {
      this.holdTime += dt;
      if (this.holdTime >= (step.hold ?? 0)) this.next();
    } else this.holdTime = 0;
  }

  /** What the interface shows (`game.lesson`). */
  view(): LessonView {
    const step = this.lesson.steps[this.stepIndex];
    const instruction =
      this.current === 'failed'
        ? (this.failure ?? CRASHED)
        : this.current === 'passed'
          ? (this.lesson.closing ?? PASSED)
          : (step?.say ?? PASSED);
    const v: LessonView = {
      id: this.lesson.id,
      title: this.lesson.title,
      step: this.stepIndex,
      steps: this.lesson.steps.length,
      instruction,
      state: this.current,
    };
    if (this.shownHint && this.current === 'running') v.hint = this.shownHint;
    const progress = this.progress;
    if (progress !== undefined) v.progress = progress;
    if (this.result) v.debrief = this.result.map((d) => ({ ...d }));
    return v;
  }

  // ----------------------------------------------------------------

  private remember(into: Map<string, number>) {
    for (const k of this.keys) {
      const v = valueOf(this.ctx, k as ValueKey);
      if (v === undefined) into.delete(k);
      else into.set(k, v);
    }
  }

  /** Advances the timer of a condition (reset when it fails) and returns it. */
  private timed(timers: number[], i: number, c: HintDef['when'], dt: number): number {
    const v = holds(this.ctx, c) ? timers[i]! + dt : 0;
    timers[i] = v;
    return v;
  }

  private next() {
    if (this.stepIndex >= this.lesson.steps.length - 1) return this.pass();
    this.stepIndex++;
    this.stepTime = 0;
    this.ctx.stepTime = 0;
    this.holdTime = 0;
    this.hintTimers.fill(0);
    this.failTimers.fill(0);
    this.shownHint = undefined;
    this.remember(this.ctx.stepRef);
  }

  private pass() {
    this.current = 'passed';
    this.shownHint = undefined;
    this.result = this.buildDebrief();
  }

  private fail(why: Bilingual) {
    this.current = 'failed';
    this.failure = why;
    this.shownHint = undefined;
    this.result = this.buildDebrief();
  }

  /** Lift-off and touchdown: the first of each, as a debrief measures them. */
  private events(dt: number, t: Telemetry) {
    const onGround = t.onGround;
    if (!onGround) this.airTime += dt;
    if (this.wasOnGround === true && !onGround && !this.liftoff.seen)
      this.record(this.liftoff, t, -t.verticalSpeed);
    if (
      this.wasOnGround === false &&
      onGround &&
      this.airTime >= AIRBORNE_AFTER &&
      !this.touchdown.seen
    )
      // The sink rate of the last frame in the air: on the wheels it is already absorbed.
      this.record(this.touchdown, t, -this.lastVs);
    if (onGround) this.airTime = 0;
    this.wasOnGround = onGround;
    this.lastVs = t.verticalSpeed;
  }

  private record(e: FlightEvent, t: Telemetry, sink: number) {
    e.seen = true;
    e.sinkFpm = sink * FT * 60;
    e.iasKt = t.ias * KT;
    e.pitchDeg = t.pitch * RAD;
    const r = this.ctx.runway;
    e.centrelineM = r ? r.centrelineM : NaN;
    e.pastThresholdM = r ? r.alongM : NaN;
  }

  private measure(dt: number) {
    const id = this.lesson.steps[this.stepIndex]?.id;
    const defs = this.lesson.debrief;
    for (let i = 0; i < defs.length; i++) {
      const m = defs[i]!;
      const tally = this.tallies[i]!;
      if (m.kind === 'range') {
        if (!id || !m.steps.includes(id) || this.stepTime < (m.settle ?? 0)) continue;
        const raw = relativeValue(this.ctx, m.value, m.rel);
        if (raw === undefined || !Number.isFinite(raw)) continue;
        const v = (raw - (m.target ?? 0)) * (m.scale ?? 1);
        const x = m.report === 'maxAbs' ? Math.abs(v) : v;
        const prev = tally.value;
        tally.value =
          tally.samples === 0 ? x : m.report === 'min' ? Math.min(prev, x) : Math.max(prev, x);
        tally.samples++;
      } else if (m.kind === 'afterTouchdown') {
        if (!this.touchdown.seen || tally.done) continue;
        tally.value = (tally.samples === 0 ? 0 : tally.value) + dt;
        tally.samples++;
        if (holds(this.ctx, m.until)) tally.done = true;
      }
    }
  }

  private buildDebrief(): DebriefLine[] {
    return this.lesson.debrief.map((m, i) => {
      const tally = this.tallies[i]!;
      let v = NaN;
      if (m.kind === 'touchdown' || m.kind === 'liftoff') {
        const e = m.kind === 'touchdown' ? this.touchdown : this.liftoff;
        if (e.seen) v = m.abs ? Math.abs(e[m.field]) : e[m.field];
      } else if (m.kind === 'range') {
        if (tally.samples > 0) v = tally.value;
      } else if (tally.done) v = tally.value;
      const ok =
        Number.isFinite(v) &&
        (m.ok.min === undefined || v >= m.ok.min) &&
        (m.ok.max === undefined || v <= m.ok.max);
      const plusMinus = m.kind === 'range' && m.report === 'maxAbs';
      return { label: m.label, value: format(v, m.unit, plusMinus), ok };
    });
  }
}

/** A measured value for the debrief, e.g. '±60 ft', '240 ft/min', '3.2 m'. */
export function format(v: number, unit: string, plusMinus = false): string {
  if (!Number.isFinite(v)) return '–';
  const digits = Math.abs(v) < 10 && unit !== 'ft/min' && unit !== 'ft' ? 1 : 0;
  const n = v.toFixed(digits);
  const shown = n === '-0' || n === '-0.0' ? n.slice(1) : n;
  return `${plusMinus ? '±' : ''}${shown}${unit ? (unit === '°' ? unit : ` ${unit}`) : ''}`;
}

export type { EventField, MeasureDef };
