import type { AircraftInfo } from '@sim';
import { settings } from './api';
import { type Eligibility, FLEET_KEYS, categoryOf, shortName, typeFeatures } from './fleet';
import { formatSpec } from './format';
import { type MessageKey, lang, t } from './i18n';
import { CHECK_KEY, PANEL_KEYS, TUNE_KEY, keyLabel } from './panels';

/** A length (a runway, a span) in the player's units, e.g. '1’777 m' or '5’830 ft'. */
export function lengthText(m: number): string {
  const f = formatSpec('length', m, settings.units.value, lang.value);
  return `${f.value} ${f.unit}`;
}

/**
 * Why a type may not use an airport. 'long' names the type and both lengths (a tooltip, the
 * reason under a blocked scenario); 'short' fits an airport list row.
 */
export function eligibilityText(
  e: Eligibility,
  info: AircraftInfo | undefined,
  form: 'long' | 'short',
): string {
  if (e.ok) return '';
  if (form === 'short')
    return e.reason === 'unpaved'
      ? t('setup.apt.unpaved')
      : t('setup.apt.short', { len: lengthText(e.longest) });
  const type = info ? shortName(info) : '';
  if (e.reason === 'unpaved') return t('setup.runway.unpaved', { type });
  return t(e.need.military ? 'setup.runway.shortMil' : 'setup.runway.short', {
    type,
    len: lengthText(e.longest),
    need: lengthText(e.need.minLength),
  });
}

export interface KeyRow {
  label: MessageKey;
  keys: (string | MessageKey)[][];
}

/** The keys that fly every type. */
const FLY_ROWS: KeyRow[] = [
  {
    label: 'keys.pitch',
    keys: [
      ['W', 'S'],
      ['key.up', 'key.down'],
    ],
  },
  {
    label: 'keys.roll',
    keys: [
      ['A', 'D'],
      ['key.left', 'key.right'],
    ],
  },
  { label: 'keys.yaw', keys: [['Q', 'E']] },
  {
    label: 'keys.throttle',
    keys: [
      ['key.shift', 'key.ctrl'],
      ['key.pgup', 'key.pgdn'],
    ],
  },
  { label: 'keys.flapsDown', keys: [['F']] },
  { label: 'keys.flapsUp', keys: [['V']] },
];

export const GEAR_ROW: KeyRow = { label: 'keys.gear', keys: [[keyLabel(FLEET_KEYS.gear)]] };
export const BRAKE_ROW: KeyRow = { label: 'keys.brake', keys: [['B']] };

/** Speed brake and reverse, for the types that have them. */
export const SPEEDBRAKE_ROWS: KeyRow[] = [
  { label: 'keys.speedbrakeExtend', keys: [[keyLabel(FLEET_KEYS.speedbrakeExtend)]] },
  { label: 'keys.speedbrakeRetract', keys: [[keyLabel(FLEET_KEYS.speedbrakeRetract)]] },
];
export const REVERSE_ROW: KeyRow = {
  label: 'keys.reverse',
  keys: [[keyLabel(FLEET_KEYS.reverse)]],
};

/** Camera, pause and the panels of phase 3. */
const OTHER_ROWS: KeyRow[] = [
  { label: 'keys.view', keys: [['C']] },
  { label: 'keys.pause', keys: [['P'], ['key.esc']] },
  { label: 'keys.radio', keys: [[keyLabel(PANEL_KEYS.radio)]] },
  { label: 'keys.reply', keys: [['1', '2', '3', '4']] },
  { label: 'keys.tune', keys: [[keyLabel(TUNE_KEY)]] },
  { label: 'keys.checklist', keys: [[keyLabel(PANEL_KEYS.checklist)]] },
  { label: 'keys.check', keys: [[keyLabel(CHECK_KEY)]] },
  { label: 'keys.stack', keys: [[keyLabel(PANEL_KEYS.stack)]] },
  { label: 'keys.autopilot', keys: [[keyLabel(PANEL_KEYS.autopilot)]] },
  { label: 'keys.switches', keys: [[keyLabel(PANEL_KEYS.switches)]] },
];

/** Every key, as the settings list them: the gear among the flying keys, the rest after. */
export const KEY_ROWS: KeyRow[] = [...FLY_ROWS, GEAR_ROW, BRAKE_ROW, ...OTHER_ROWS];

/**
 * The keys that get one type off the ground and back, for the briefing: the gear only where
 * it retracts, speed brake and reverse only where the type has them.
 */
export function flyingKeyRows(info: AircraftInfo | undefined): KeyRow[] {
  const f = typeFeatures(info);
  return [
    ...FLY_ROWS,
    ...(f.gear ? [GEAR_ROW] : []),
    ...(f.speedbrake ? SPEEDBRAKE_ROWS : []),
    ...(f.reverse ? [REVERSE_ROW] : []),
    BRAKE_ROW,
  ];
}

/** The keys that differ between types, each with the types on offer that use it. */
export function typeKeyRows(aircraft: readonly AircraftInfo[]): { row: KeyRow; types: string[] }[] {
  const names = (has: (i: AircraftInfo) => boolean) => aircraft.filter(has).map(shortName);
  const out: { row: KeyRow; types: string[] }[] = [];
  const speedbrake = names((i) => !!i.speedbrake);
  const reverse = names((i) => !!i.reverse);
  for (const row of SPEEDBRAKE_ROWS) if (speedbrake.length) out.push({ row, types: speedbrake });
  if (reverse.length) out.push({ row: REVERSE_ROW, types: reverse });
  return out;
}

/** The throttle's name on the HUD: a piston's throttle, a turboprop's power, a jet's thrust. */
export function throttleLabel(info: AircraftInfo | undefined): string {
  const c = categoryOf(info);
  return t(
    c === 'turboprop'
      ? 'hud.throttle.power'
      : c === 'piston'
        ? 'hud.throttle'
        : 'hud.throttle.thrust',
  );
}
