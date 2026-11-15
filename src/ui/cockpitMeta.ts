import type { ControlSpec } from '@sim';
import { type MessageKey, isMessageKey, lang, t } from './i18n';
import { MINUS, groupThousands } from './format';

/**
 * How the interface presents the cockpit's controls (`game.controls`): which panel shows a
 * control, in which group, under which name. Keyed by the control's name, so another aircraft
 * with other controls still gets a working (if plainer) switches panel: a name nobody knows
 * shows in a readable form of its id, in the group 'other'.
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
  // Phase 4: the PC-12's flight guidance.
  'yawDamper',
  'flightDirector',
  'apVs',
  'apFlc',
  'apDisconnect',
  'goAround',
  'headingSync',
]);

/**
 * Flown with the stick, keys and the on-screen levers, not from a panel: the power lever, and
 * reverse (the same lever lifted over its gate), which only makes sense held on the runway.
 */
const FLIGHT_CONTROLS = new Set(['throttle', 'reverse']);

export type SwitchGroup =
  'electrical' | 'engine' | 'controls' | 'lights' | 'ice' | 'cabin' | 'instruments' | 'other';

export const SWITCH_GROUPS: readonly SwitchGroup[] = [
  'electrical',
  'engine',
  'controls',
  'lights',
  'ice',
  'cabin',
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
  // Phase 4: the PC-12.
  battery2: 'electrical',
  generator1: 'electrical',
  generator2: 'electrical',
  eps: 'electrical',
  starter: 'engine',
  ignition: 'engine',
  condition: 'engine',
  fuelPumpLeft: 'engine',
  fuelPumpRight: 'engine',
  inertialSeparator: 'engine',
  gear: 'controls',
  aileronTrim: 'controls',
  rudderTrim: 'controls',
  propDeice: 'ice',
  bootsDeice: 'ice',
  windshieldHeat: 'ice',
  ecs: 'cabin',
  pressurisation: 'cabin',
  cabinAltitude: 'cabin',
  oxygen: 'cabin',
  lightCabin: 'cabin',
  baroStd: 'instruments',
  mapRange: 'instruments',
  minimums: 'instruments',
};

/** Controls of a dedicated ice protection system: with them, pitot heat belongs there too. */
const ICE_SYSTEM = ['propDeice', 'bootsDeice', 'windshieldHeat'];

/**
 * The group of a control. `ids` are all the controls of the aircraft: the Cessna keeps pitot
 * heat with its lights ("Licht und Heizung"), a type with real ice protection puts it there.
 */
export function groupOf(id: string, ids?: ReadonlySet<string>): SwitchGroup {
  if (id === 'pitotHeat' && ids && ICE_SYSTEM.some((i) => ids.has(i))) return 'ice';
  return GROUP_OF[id] ?? (id.startsWith('light') ? 'lights' : 'other');
}

/** The controls of the switches panel, grouped, in the cockpit's own order within a group. */
export function switchGroups(
  specs: readonly ControlSpec[],
): { group: SwitchGroup; specs: ControlSpec[] }[] {
  const ids = new Set(specs.map((s) => s.id));
  const rest = specs.filter(
    (s) => !STACK_CONTROLS.has(s.id) && !AUTOPILOT_CONTROLS.has(s.id) && !FLIGHT_CONTROLS.has(s.id),
  );
  return SWITCH_GROUPS.map((group) => ({
    group,
    specs: rest.filter((s) => groupOf(s.id, ids) === group),
  })).filter((g) => g.specs.length > 0);
}

/** A group's heading: a turbine's engine group is the "Triebwerk", a piston's the "Motor". */
export function groupLabel(group: SwitchGroup, specs: readonly ControlSpec[]): string {
  if (group === 'engine' && specs.some((s) => s.id === 'condition'))
    return t('group.engine.turbine');
  // "Licht und Heizung" only while the pitot heat is among the lights.
  const ids = new Set(specs.map((s) => s.id));
  if (group === 'lights' && !(ids.has('pitotHeat') && groupOf('pitotHeat', ids) === 'lights'))
    return t('group.lightsOnly');
  return t(`group.${group}`);
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

/** Abbreviations that read as capitals in a control's name. */
const ACRONYMS = new Set([
  'ap',
  'apu',
  'adf',
  'atc',
  'com',
  'dme',
  'ecs',
  'eps',
  'fd',
  'flc',
  'gps',
  'hdg',
  'ils',
  'nav',
  'obs',
  'spd',
  'std',
  'vs',
  'xpdr',
  'yd',
]);

/**
 * A readable name for a control nobody has labelled yet: 'apuBleedAir' → 'APU bleed air',
 * 'engineMaster1' → 'Engine master 1'. Better than the bare id until a label is written.
 */
export function readableId(id: string): string {
  const words = id
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The control's name in the current language; an unknown control a readable form of its id. */
export function controlLabel(id: string): string {
  const key = `ctl.${id}`;
  return isMessageKey(key) ? t(key) : readableId(id);
}

/**
 * A selector position's name; numbers as they are, unknown names readable. Flap positions are
 * degrees when every position is a number (0°, 10°, 20°, 30°); beside a named one they are an
 * airliner's configurations (1, 2, 3, FULL) and stay bare. Pass all `positions` to tell.
 */
export function positionLabel(
  id: string,
  position: string,
  positions: readonly string[] = [position],
): string {
  if (/^\d+$/.test(position))
    return id === 'flaps' && positions.every((p) => /^\d+$/.test(p)) ? `${position}°` : position;
  const key = `pos.${position}`;
  return isMessageKey(key) ? t(key as MessageKey) : readableId(position);
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
    case 'aileronTrim':
    case 'rudderTrim':
      return signed(Math.round(v * 100), ' %');
    case 'cabinAltitude':
    case 'minimums':
      // Feet are what cabin controllers and radar altimeters are set in, whatever the units.
      return `${groupThousands(v, lang.value)} ft`;
    case 'mapRange':
      return `${Math.round(v)} NM`;
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
