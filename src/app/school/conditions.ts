/**
 * Reads the values a lesson talks about and evaluates its conditions. The checklists'
 * telemetry adapter (`telemetryValue`) supplies everything they share; the school adds
 * headings, needles, autopilot modes and the runway. Nothing here allocates per call, since
 * it runs every frame.
 */
import type { Telemetry } from '@sim';
import { telemetryValue, type TelemetryKey } from '../procedures';
import type { RunwayPosition } from './runway';
import type { Cond, ControlValues, ModeKey, Reference, SchoolKey, ValueKey } from './types';

/** What one evaluation looks at. The runner owns one and refills it every frame. */
export interface SchoolContext {
  telemetry: Telemetry | null;
  cockpit: ControlValues | null;
  /** Position names of the type's selectors, by control. */
  positions: ReadonlyMap<string, readonly string[]>;
  /** The runway values, or null without a position or a runway. */
  runway: RunwayPosition | null;
  stepTime: number;
  /** Reference values by key, taken at the start of the lesson and of the current step. */
  lessonRef: Map<string, number>;
  stepRef: Map<string, number>;
}

const SCHOOL_KEYS: ReadonlySet<string> = new Set<SchoolKey>([
  'headingDeg',
  'trackDeg',
  'loadFactor',
  'stepTime',
  'nav1Deviation',
  'nav1GlideSlope',
  'nav1Valid',
  'nav1Localizer',
  'nav1ToFrom',
  'dmeNm',
  'apEngaged',
  'fcuAppr',
  'fcuAp1',
  'fcuAp2',
  'groundSpoilers',
  'autobrakeArmed',
  'centrelineM',
  'alongM',
  'pathFt',
  'runwayHeightFt',
]);

const flag = (b: boolean | undefined) => (b === undefined ? undefined : b ? 1 : 0);

/** A value by key, or undefined when the aircraft or the moment does not have it. */
export function valueOf(ctx: SchoolContext, key: ValueKey): number | undefined {
  if (!SCHOOL_KEYS.has(key)) return telemetryValue(ctx.telemetry, key as TelemetryKey);
  if (key === 'stepTime') return ctx.stepTime;
  const r = ctx.runway;
  switch (key) {
    case 'centrelineM':
      return r?.centrelineM;
    case 'alongM':
      return r?.alongM;
    case 'pathFt':
      return r?.pathFt;
    case 'runwayHeightFt':
      return r?.runwayHeightFt;
  }
  const t = ctx.telemetry;
  if (!t) return undefined;
  const av = t.avionics;
  const airbus = av?.autopilot.airbus;
  switch (key as SchoolKey) {
    case 'headingDeg':
      return t.headingDeg;
    case 'trackDeg':
      return t.trackDeg;
    case 'loadFactor':
      return t.loadFactor;
    case 'nav1Deviation':
      return av?.nav1.valid ? av.nav1.deviation : undefined;
    case 'nav1GlideSlope':
      return av?.nav1.valid ? av.nav1.glideSlope : undefined;
    case 'nav1Valid':
      return flag(av?.nav1.valid);
    case 'nav1Localizer':
      return av ? (av.nav1.valid && av.nav1.localizer ? 1 : 0) : undefined;
    case 'nav1ToFrom': {
      const tf = av?.nav1.toFrom;
      return tf === undefined ? undefined : tf === 'to' ? 1 : tf === 'from' ? -1 : 0;
    }
    case 'dmeNm':
      return av?.dme.distanceNm;
    case 'apEngaged':
      return flag(av?.autopilot.engaged);
    case 'fcuAppr':
      return flag(airbus?.fcu.appr);
    case 'fcuAp1':
      return flag(airbus?.fcu.ap1);
    case 'fcuAp2':
      return flag(airbus?.fcu.ap2);
    case 'groundSpoilers':
      return flag(airbus?.controls.groundSpoilers);
    case 'autobrakeArmed':
      return flag(airbus?.controls.autobrakeArmed);
  }
  return undefined;
}

/** A text value by key ('' when there is none). */
export function modeOf(ctx: SchoolContext, key: ModeKey): string {
  const av = ctx.telemetry?.avionics;
  if (!av) return '';
  const ap = av.autopilot;
  switch (key) {
    case 'apLateral':
      return ap.engaged ? ap.lateral : '';
    case 'apLateralArmed':
      return ap.engaged ? (ap.lateralArmed ?? '') : '';
    case 'apVertical':
      return ap.engaged ? ap.vertical : '';
    case 'apVerticalArmed':
      return ap.engaged ? (ap.verticalArmed ?? '') : '';
    case 'fmaThrust':
      return ap.airbus?.fma.thrust ?? '';
    case 'fmaVertical':
      return ap.airbus?.fma.vertical ?? '';
    case 'fmaLateral':
      return ap.airbus?.fma.lateral ?? '';
    case 'callout':
      return ap.airbus?.guidance.callout ?? '';
    case 'nav1Ident':
      return av.nav1.valid ? av.nav1.ident : '';
  }
}

/** A cockpit control's value, or undefined for a name the aircraft does not have. */
export function controlOf(ctx: SchoolContext, id: string): number | undefined {
  const c = ctx.cockpit;
  if (!c) return undefined;
  if (typeof c.get === 'function') {
    const reader = c as { get(id: string): number; has?(id: string): boolean };
    if (reader.has && !reader.has(id)) return undefined;
    return reader.get(id);
  }
  return (c as Readonly<Record<string, number>>)[id];
}

const refOf = (ctx: SchoolContext, rel: Reference | undefined, key: string) =>
  rel === undefined ? 0 : (rel === 'lesson' ? ctx.lessonRef : ctx.stepRef).get(key);

/** Shortest signed difference of two directions, degrees (-180..180). */
export const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

const inBand = (v: number | undefined, min?: number, max?: number) =>
  v !== undefined &&
  Number.isFinite(v) &&
  (min === undefined || v >= min) &&
  (max === undefined || v <= max);

/** A value as a condition compares it: less the reference, and its size with `abs`. */
export function relativeValue(
  ctx: SchoolContext,
  key: ValueKey,
  rel?: Reference,
  abs?: boolean,
): number | undefined {
  const v = valueOf(ctx, key);
  const ref = refOf(ctx, rel, key);
  if (v === undefined || ref === undefined) return undefined;
  const d = key === 'headingDeg' || key === 'trackDeg' ? angleDiff(v, ref) : v - ref;
  return abs ? Math.abs(d) : d;
}

/** Whether a condition holds. Missing values never pass (so a missing hint never shows). */
export function holds(ctx: SchoolContext, c: Cond): boolean {
  if ('all' in c) {
    for (const x of c.all) if (!holds(ctx, x)) return false;
    return true;
  }
  if ('any' in c) {
    for (const x of c.any) if (holds(ctx, x)) return true;
    return false;
  }
  if ('not' in c) return !holds(ctx, c.not);
  if ('value' in c) return inBand(relativeValue(ctx, c.value, c.rel, c.abs), c.min, c.max);
  if ('heading' in c) {
    const key = c.track ? 'trackDeg' : 'headingDeg';
    const v = valueOf(ctx, key);
    const ref = refOf(ctx, c.rel, key);
    if (v === undefined || ref === undefined) return false;
    return Math.abs(angleDiff(v, ref + c.heading)) <= c.within;
  }
  if ('mode' in c) {
    const m = modeOf(ctx, c.mode);
    return typeof c.is === 'string' ? m === c.is : c.is.includes(m);
  }
  const v = controlOf(ctx, c.control);
  if (v === undefined) return false;
  if ('is' in c) {
    const want = c.is;
    if (typeof want === 'number') return Math.round(v) === want;
    const positions = ctx.positions.get(c.control);
    const at = positions?.[Math.round(v)];
    return at !== undefined && (typeof want === 'string' ? at === want : want.includes(at));
  }
  return inBand(v, c.min, c.max);
}

/** Every key a condition compares relative to a reference (to know what to remember). */
export function relativeKeys(c: Cond, out: Set<string>): Set<string> {
  if ('all' in c) for (const x of c.all) relativeKeys(x, out);
  else if ('any' in c) for (const x of c.any) relativeKeys(x, out);
  else if ('not' in c) relativeKeys(c.not, out);
  else if ('value' in c && c.rel) out.add(c.value);
  else if ('heading' in c && c.rel) out.add(c.track ? 'trackDeg' : 'headingDeg');
  return out;
}

/** Every cockpit control a condition names (for validating lessons against a type). */
export function controlsIn(c: Cond, out: Set<string>): Set<string> {
  if ('all' in c) for (const x of c.all) controlsIn(x, out);
  else if ('any' in c) for (const x of c.any) controlsIn(x, out);
  else if ('not' in c) controlsIn(c.not, out);
  else if ('control' in c) out.add(c.control);
  return out;
}
