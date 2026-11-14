import type { ControlSpec } from '@sim';
import { type MessageKey, isMessageKey, t } from './i18n';
import { MINUS } from './format';

/**
 * How the interface presents the cockpit's controls (`game.controls`): which panel shows a
 * control, in which group, under which name. Keyed by the control's name, so another aircraft
 * with other controls still gets a working (if plainer) switches panel.
 */

/** Shown by the radio stack panel. */
export const STACK_CONTROLS = new Set([
  'com1Active',
  'com1Standby',
  'com1Swap',
  'com2Active',
  'com2Standby',
  'com2Swap',
  'nav1Active',
  'nav1Standby',
  'nav1Swap',
  'nav2Active',
  'nav2Standby',
  'nav2Swap',
  'dmeSource',
  'adfFrequency',
  'xpdrCode',
  'xpdrMode',
  'xpdrIdent',
]);

/** Shown by the autopilot panel (with the knobs it follows). */
export const AUTOPILOT_CONTROLS = new Set([
  'apEngage',
  'apHdg',
  'apNav',
  'apApr',
  'apAlt',
  'apVsUp',
  'apVsDown',
  'apAltitude',
  'headingBug',
  'obs1',
  'obs2',
  'navSource',
]);

/** Flown with the stick, keys and the on-screen lever, not from a panel. */
const FLIGHT_CONTROLS = new Set(['throttle']);

export type SwitchGroup = 'electrical' | 'engine' | 'controls' | 'lights' | 'instruments' | 'other';

export const SWITCH_GROUPS: readonly SwitchGroup[] = [
  'electrical',
  'engine',
  'controls',
  'lights',
  'instruments',
  'other',
];

const GROUP_OF: Record<string, SwitchGroup> = {
  battery: 'electrical',
  alternator: 'electrical',
  avionics: 'electrical',
  magnetos: 'engine',
  fuelSelector: 'engine',
  fuelShutoff: 'engine',
  fuelPump: 'engine',
  mixture: 'engine',
  carbHeat: 'engine',
  flaps: 'controls',
  trim: 'controls',
  parkingBrake: 'controls',
  pitotHeat: 'lights',
  altimeterSetting: 'instruments',
  gyroAdjust: 'instruments',
};

export function groupOf(id: string): SwitchGroup {
  return GROUP_OF[id] ?? (id.startsWith('light') ? 'lights' : 'other');
}

/** The controls of the switches panel, grouped, in the cockpit's own order within a group. */
export function switchGroups(
  specs: readonly ControlSpec[],
): { group: SwitchGroup; specs: ControlSpec[] }[] {
  const rest = specs.filter(
    (s) => !STACK_CONTROLS.has(s.id) && !AUTOPILOT_CONTROLS.has(s.id) && !FLIGHT_CONTROLS.has(s.id),
  );
  return SWITCH_GROUPS.map((group) => ({
    group,
    specs: rest.filter((s) => groupOf(s.id) === group),
  })).filter((g) => g.specs.length > 0);
}

/** The panels this aircraft's controls can fill. */
export function avionicsAvailable(specs: readonly ControlSpec[]) {
  const ids = new Set(specs.map((s) => s.id));
  return {
    stack: ids.has('com1Active') || ids.has('nav1Active'),
    autopilot: ids.has('apEngage'),
    switches: switchGroups(specs).length > 0,
  };
}

/** The control's name in the current language; an unknown control shows its id. */
export function controlLabel(id: string): string {
  const key = `ctl.${id}`;
  return isMessageKey(key) ? t(key) : id;
}

/** A selector position's name; numbers (flap degrees) as they are. */
export function positionLabel(id: string, position: string): string {
  if (/^\d+$/.test(position)) return id === 'flaps' ? `${position}°` : position;
  const key = `pos.${position}`;
  return isMessageKey(key) ? t(key as MessageKey) : position;
}

/** A lever or knob value for display, in the unit of that control. */
export function formatControlValue(spec: ControlSpec, v: number): string {
  const signed = (n: number, unit: string) =>
    `${n > 0 ? '+' : n < 0 ? MINUS : ''}${Math.abs(n)}${unit}`;
  switch (spec.id) {
    case 'altimeterSetting':
      return `${Math.round(v)} hPa`;
    case 'gyroAdjust':
      return signed(Math.round(v), '°');
    case 'trim':
      return signed(Math.round(v * 100), ' %');
  }
  if (spec.kind === 'lever' || (spec.min === 0 && spec.max === 1))
    return `${Math.round(Math.min(1, Math.max(0, v)) * 100)} %`;
  const decimals = spec.step && spec.step < 1 ? Math.min(2, Math.ceil(-Math.log10(spec.step))) : 0;
  return v.toFixed(decimals);
}

/** One click of a knob: its step, or ten steps with the coarse button; clamped or wrapped. */
export function stepKnob(spec: ControlSpec, v: number, coarse: boolean, dir: 1 | -1): number {
  const step = (spec.step ?? 0.05) * (coarse ? 10 : 1);
  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  let next = v + dir * step;
  if (spec.wraps) {
    const span = max - min + (spec.step ?? 0);
    next = min + ((((next - min) % span) + span) % span);
  }
  // Rounded to the step so repeated float steps never drift off the grid.
  const snapped = min + Math.round((next - min) / (spec.step ?? 0.05)) * (spec.step ?? 0.05);
  return Math.min(max, Math.max(min, Number(snapped.toFixed(6))));
}

/** How long a button counts as held: long enough for a few simulation steps to see it. */
export const PRESS_MS = 150;

/**
 * A momentary press of a cockpit button: 1, then 0 again. The systems act on the press, and
 * at 120 Hz they need it to last a step or more, so it is not released in the same moment.
 */
export function pressControl(
  set: ((id: string, value: number) => void) | undefined,
  id: string,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
) {
  if (!set) return;
  set(id, 1);
  schedule(() => set(id, 0), PRESS_MS);
}
