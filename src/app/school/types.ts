/**
 * The flight school as data: lessons, their steps, the conditions that complete a step, the
 * hints an instructor gives while the pilot is off, and what the debrief measures. The
 * runner (runner.ts) only interprets these, so a lesson is written without code.
 */
import type { AircraftId } from '@sim';
import type { TelemetryKey } from '../procedures';
import type { FlightPlan } from '@ui';

// The interface's phase 5 contract (src/ui/api.ts) declares these, but the package's index does
// not export them yet; the same shapes here keep the school assignable to `game.lessons` and
// `game.lesson` until it does.

/** A text in both languages (`Bilingual` of the interface). */
export interface Bilingual {
  de: string;
  en: string;
}

/** A lesson as the list shows it (`LessonInfo` of the interface). */
export interface LessonInfo {
  id: string;
  title: Bilingual;
  summary: Bilingual;
  aircraft: AircraftId;
  minutes: number;
  done: boolean;
}

/** The lesson being flown (`LessonView` of the interface). */
export interface LessonView {
  id: string;
  title: Bilingual;
  step: number;
  steps: number;
  instruction: Bilingual;
  hint?: Bilingual;
  progress?: number;
  state: 'running' | 'passed' | 'failed';
  debrief?: { label: Bilingual; value: string; ok: boolean }[];
}

/**
 * Values the school reads beyond those of the checklists (`TelemetryKey`). Runway values need
 * the aircraft's position (`Place` in `LessonRunner.update`) and are missing without it.
 */
export type SchoolKey =
  | 'headingDeg'
  | 'trackDeg'
  | 'loadFactor'
  /** Seconds since the current step began. */
  | 'stepTime'
  // ---- NAV 1 and DME ----
  /** Course needle, -1 full left .. 1 full right. */
  | 'nav1Deviation'
  /** Glide slope needle, -1 full down .. 1 full up. */
  | 'nav1GlideSlope'
  | 'nav1Valid'
  | 'nav1Localizer'
  /** 1 TO, -1 FROM, 0 off. */
  | 'nav1ToFrom'
  | 'dmeNm'
  // ---- autopilot ----
  | 'apEngaged'
  // ---- Airbus ----
  | 'fcuAppr'
  | 'fcuAp1'
  | 'fcuAp2'
  | 'groundSpoilers'
  | 'autobrakeArmed'
  // ---- the lesson's runway ----
  /** Metres right (+) or left (-) of the extended centre line. */
  | 'centrelineM'
  /** Metres past the landing threshold along the runway (negative before it). */
  | 'alongM'
  /** Feet above (+) or below (-) the approach path (the ILS angle, or 3 degrees). */
  | 'pathFt'
  /** Feet above the threshold. */
  | 'runwayHeightFt';

export type ValueKey = TelemetryKey | SchoolKey;

/** Text values compared by name (modes as the displays write them). */
export type ModeKey =
  | 'apLateral'
  | 'apLateralArmed'
  | 'apVertical'
  | 'apVerticalArmed'
  | 'fmaThrust'
  | 'fmaVertical'
  | 'fmaLateral'
  | 'callout'
  | 'nav1Ident';

/**
 * Where a relative value is measured from: the value when the lesson began, or when the
 * current step began. A lesson that says "hold 5000 ft" after an air start at 5000 ft holds
 * the altitude it started with, whatever the altimeter setting.
 */
export type Reference = 'lesson' | 'step';

export type Cond =
  /** A number within a band; `rel` subtracts a reference first, `abs` compares its size. */
  | { value: ValueKey; min?: number; max?: number; rel?: Reference; abs?: boolean }
  /** A cockpit control at a position (by index or name) or within a range, as in checklists. */
  | { control: string; is: number | string | readonly string[] }
  | { control: string; min?: number; max?: number }
  /** Heading (or track) within `within` degrees of `heading`, which is relative with `rel`. */
  | { heading: number; within: number; rel?: Reference; track?: boolean }
  | { mode: ModeKey; is: string | readonly string[] }
  | { all: readonly Cond[] }
  | { any: readonly Cond[] }
  | { not: Cond };

export interface HintDef {
  when: Cond;
  say: Bilingual;
  /** Seconds the condition must hold before the hint shows (default 1): no flicker. */
  after?: number;
}

export interface FailDef {
  when: Cond;
  say: Bilingual;
  /** Seconds the condition must hold before the lesson fails (default 0). */
  after?: number;
}

export interface StepDef {
  id: string;
  say: Bilingual;
  done: Cond;
  /** Seconds `done` must hold without a break (shown as progress). */
  hold?: number;
  hints?: readonly HintDef[];
  fail?: readonly FailDef[];
}

/** What the runner records at the first lift-off or touchdown. */
export type EventField = 'sinkFpm' | 'iasKt' | 'centrelineM' | 'pastThresholdM' | 'pitchDeg';

export interface Bounds {
  min?: number;
  max?: number;
}

export type MeasureDef =
  /** A value at the first touchdown or lift-off of the lesson. */
  | {
      kind: 'touchdown' | 'liftoff';
      label: Bilingual;
      field: EventField;
      unit: string;
      /** Report and judge the size only (centre line left or right). */
      abs?: boolean;
      ok: Bounds;
    }
  /**
   * A value over the listed steps (after `settle` seconds in each): the largest deviation
   * from `target` (relative to `rel`), or the highest or lowest value.
   */
  | {
      kind: 'range';
      label: Bilingual;
      value: ValueKey;
      steps: readonly string[];
      report: 'maxAbs' | 'max' | 'min';
      target?: number;
      rel?: Reference;
      settle?: number;
      /** Multiplies the value for display (needle deflection to dots). */
      scale?: number;
      unit: string;
      ok: Bounds;
    }
  /** Seconds from the first touchdown until `until` holds (thrust levers to idle). */
  | { kind: 'afterTouchdown'; label: Bilingual; until: Cond; unit: string; ok: Bounds };

export interface LessonDef {
  id: string;
  title: Bilingual;
  summary: Bilingual;
  aircraft: AircraftId;
  minutes: number;
  plan: FlightPlan;
  /**
   * The runway the runway values refer to: the plan's own (take-off or approach runway)
   * unless given.
   */
  runway?: { airport: string; ident: string };
  steps: readonly StepDef[];
  /** Hints and failures that count in every step. A crash always fails. */
  hints?: readonly HintDef[];
  fail?: readonly FailDef[];
  debrief: readonly MeasureDef[];
  /** What the instructor says once it is passed (a general word of praise without it). */
  closing?: Bilingual;
}

/** The aircraft's position, for the runway values. `msl`: metres above sea level. */
export interface Place {
  lon: number;
  lat: number;
  msl: number;
}

/** Cockpit values: the aircraft's `Cockpit` or a table of values by name. */
export type ControlValues = { get(id: string): number } | Readonly<Record<string, number>>;
