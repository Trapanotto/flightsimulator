import { describe, expect, it } from 'vitest';
import { C172_CONTROLS } from '../src/sim/cockpit';
import type { AircraftInfo } from '../src/sim/types';
import type { AirportOption } from '../src/ui/api';
import {
  avionicsAvailable,
  pressControl,
  stepKnob,
  switchGroups,
  AUTOPILOT_CONTROLS,
  STACK_CONTROLS,
} from '../src/ui/cockpitMeta';
import { ALL_MESSAGES, isMessageKey } from '../src/ui/i18n';
import { type KeyContext, type KeyInput, flightKeyAction, togglePanel } from '../src/ui/panels';
import { DEFAULT_SETTINGS, parseSettings } from '../src/ui/persist';
import {
  FAILURE_IDS,
  defaultDraft,
  distanceNm,
  draftToPlan,
  sanitizeDraft,
  validatePlan,
} from '../src/ui/plan';
import {
  formatFrequency,
  formatSquawk,
  hintFrequency,
  parseFrequency,
  parseSquawk,
  stepFrequency,
} from '../src/ui/radio';

const AIRPORTS: AirportOption[] = [
  {
    icao: 'LSZB',
    name: 'Bern-Belp',
    lon: 7.4971,
    lat: 46.9141,
    elevation: 510,
    runways: ['14', '32'],
  },
  {
    icao: 'LSZH',
    name: 'Zürich',
    lon: 8.5492,
    lat: 47.4647,
    elevation: 432,
    runways: ['28', '10', '14', '32'],
  },
  {
    icao: 'LSZS',
    name: 'Samedan',
    lon: 9.8841,
    lat: 46.5341,
    elevation: 1707,
    runways: ['03', '21'],
  },
];
const C172: AircraftInfo = {
  id: 'c172',
  name: 'Cessna 172',
  engines: 1,
  vs: 25.2,
  vs0: 24.2,
  vne: 84.9,
  maxTakeoffMass: 1111,
  retractableGear: false,
};

describe('flight plan, phase 3', () => {
  const base = defaultDraft(AIRPORTS, [C172]);

  it('builds an approach start with the fixed defaults: radio on, engine running, no failures', () => {
    const plan = draftToPlan(
      {
        ...base,
        airport: 'LSZH',
        runway: '14',
        start: 'approach',
        approachNm: 10,
        weather: 'lowStratus',
      },
      AIRPORTS,
      [C172],
    )!;
    expect(plan.start).toEqual({ kind: 'approach', airport: 'LSZH', runway: '14', distanceNm: 10 });
    expect(plan.destination).toBeUndefined();
    expect(plan).toMatchObject({
      weather: 'lowStratus',
      atc: true,
      coldStart: false,
      failures: [],
    });
    expect(validatePlan(plan, AIRPORTS, [C172])).toBeNull();
  });

  it('repairs a stored approach distance and forgets fields no longer offered', () => {
    const d = sanitizeDraft(
      { start: 'approach', approachNm: 50, destination: 'LSZS', coldStart: true },
      AIRPORTS,
      [C172],
    );
    expect(d).toMatchObject({ start: 'approach', approachNm: 8 });
    expect(d).not.toHaveProperty('destination');
    expect(draftToPlan(d, AIRPORTS, [C172])!.coldStart).toBe(false);
  });

  it('round-trips through storage as JSON', () => {
    const d = { ...base, start: 'approach' as const };
    expect(sanitizeDraft(JSON.parse(JSON.stringify(d)), AIRPORTS, [C172])).toEqual(d);
  });

  it('validates the phase 3 parts of plans from elsewhere', () => {
    const ok = draftToPlan(base, AIRPORTS, [C172])!;
    const v = (p: unknown) => validatePlan(p, AIRPORTS, [C172]);
    expect(v({ ...ok, weather: 'lowStratus' })).toBeNull();
    expect(
      v({ ...ok, start: { kind: 'approach', airport: 'LSZB', runway: '14', distanceNm: 3 } }),
    ).toMatch(/approach distance/);
    expect(
      v({ ...ok, start: { kind: 'approach', airport: 'LSZB', runway: '99', distanceNm: 8 } }),
    ).toMatch(/runway/);
    expect(v({ ...ok, destination: { airport: 'EDDF' } })).toMatch(/destination/);
    expect(v({ ...ok, destination: { airport: 'LSZS', runway: '14' } })).toMatch(
      /destination runway/,
    );
    expect(v({ ...ok, failures: [{ id: 'wings', after: 10 }] })).toMatch(/failure/);
    expect(v({ ...ok, failures: [{ id: 'engine', after: -1 }] })).toMatch(/failure time/);
    expect(v({ ...ok, route: [{ ident: 'X', lon: 500, lat: 0 }] })).toMatch(/waypoint/);
    expect(
      v({
        ...ok,
        coldStart: true,
        start: { kind: 'air', lon: 7, lat: 46, altitude: 1500, headingDeg: 0 },
      }),
    ).toMatch(/cold start/);
    expect(v({ ...ok, season: 'monsoon' })).toMatch(/season/);
  });

  it('measures great-circle distances in nautical miles', () => {
    // One minute of latitude is about one nautical mile (1852 m by definition, 1855 m mean).
    expect(distanceNm(8, 47, 8, 47 + 1 / 60)).toBeCloseTo(1.0006, 3);
    // Bern-Belp to Zurich airport: about 100 km, 54 NM.
    expect(distanceNm(7.4971, 46.9141, 8.5492, 47.4647)).toBeGreaterThan(53);
    expect(distanceNm(7.4971, 46.9141, 8.5492, 47.4647)).toBeLessThan(55);
  });
});

describe('radio frequencies', () => {
  it('formats COM with three decimals, NAV with two, ADF in kHz', () => {
    expect(formatFrequency(121_500, 'com')).toBe('121.500');
    expect(formatFrequency(118_025, 'com')).toBe('118.025');
    expect(formatFrequency(110_500, 'nav')).toBe('110.50');
    expect(formatFrequency(108_300, 'nav')).toBe('108.30');
    expect(formatFrequency(300, 'adf')).toBe('300');
  });

  it('parses what a pilot types', () => {
    expect(parseFrequency('121.5', 'com')).toBe(121_500);
    expect(parseFrequency('121,500', 'com')).toBe(121_500);
    expect(parseFrequency('121', 'com')).toBe(121_000);
    expect(parseFrequency('12150', 'com')).toBe(121_500);
    expect(parseFrequency(' 118.100 ', 'com')).toBe(118_100);
    // Two decimals name the 25 kHz channel: 118.02 is 118.025.
    expect(parseFrequency('118.02', 'com')).toBe(118_025);
    expect(parseFrequency('118.07', 'com')).toBe(118_075);
    expect(parseFrequency('110.5', 'nav')).toBe(110_500);
    expect(parseFrequency('300', 'adf')).toBe(300);
  });

  it('rejects what is no channel', () => {
    expect(parseFrequency('117.9', 'com')).toBeNull(); // below the COM band
    expect(parseFrequency('137', 'com')).toBeNull();
    expect(parseFrequency('121.510', 'com')).toBeNull(); // off the 25 kHz grid
    expect(parseFrequency('110.525', 'nav')).toBeNull(); // off the 50 kHz grid
    expect(parseFrequency('118.0', 'nav')).toBeNull(); // above the NAV band
    expect(parseFrequency('1234.5678', 'com')).toBeNull();
    expect(parseFrequency('abc', 'com')).toBeNull();
    expect(parseFrequency('', 'com')).toBeNull();
    expect(parseFrequency('150', 'adf')).toBeNull();
    expect(parseFrequency('300.5', 'adf')).toBeNull();
  });

  it('steps like the two knobs of the real radio', () => {
    // COM: 25 kHz inner knob that wraps within the MHz; outer knob in whole MHz.
    expect(stepFrequency(121_500, 'com', false, 1)).toBe(121_525);
    expect(stepFrequency(121_975, 'com', false, 1)).toBe(121_000);
    expect(stepFrequency(121_000, 'com', false, -1)).toBe(121_975);
    expect(stepFrequency(121_500, 'com', true, 1)).toBe(122_500);
    expect(stepFrequency(136_500, 'com', true, 1)).toBe(118_500);
    expect(stepFrequency(118_500, 'com', true, -1)).toBe(136_500);
    // NAV: 50 kHz, 108 to 117 MHz.
    expect(stepFrequency(110_950, 'nav', false, 1)).toBe(110_000);
    expect(stepFrequency(117_300, 'nav', true, 1)).toBe(108_300);
    // ADF: tens and ones, stopping at the ends.
    expect(stepFrequency(300, 'adf', true, 1)).toBe(310);
    expect(stepFrequency(300, 'adf', false, -1)).toBe(299);
    expect(stepFrequency(1745, 'adf', true, 1)).toBe(1750);
    expect(stepFrequency(195, 'adf', true, -1)).toBe(190);
  });

  it('every step stays a valid channel', () => {
    let f = 118_000;
    for (let i = 0; i < 200; i++) {
      f = stepFrequency(f, 'com', i % 3 === 0, i % 2 ? 1 : -1);
      expect(parseFrequency(formatFrequency(f, 'com'), 'com')).toBe(f);
    }
  });

  it('reads the frequency of a controller hint and transponder codes', () => {
    expect(hintFrequency('Zürich Tower 118.100')).toBe(118_100);
    expect(hintFrequency('Bern Tower 121,025')).toBe(121_025);
    expect(hintFrequency('Contact Bern Tower')).toBeNull();
    expect(hintFrequency(null)).toBeNull();
    expect(parseSquawk('7000')).toBe(7000);
    expect(parseSquawk('0021')).toBe(21);
    expect(parseSquawk('7800')).toBeNull(); // 8 is no octal digit
    expect(parseSquawk('700')).toBeNull();
    expect(formatSquawk(21)).toBe('0021');
  });
});

describe('cockpit controls in the interface', () => {
  it('names every C172 control and position in both languages', () => {
    for (const lang of ['de', 'en'] as const) {
      for (const s of C172_CONTROLS) {
        expect(ALL_MESSAGES[lang][`ctl.${s.id}` as never], `${lang} ctl.${s.id}`).toBeTruthy();
        for (const p of s.positions ?? []) {
          if (/^\d+$/.test(p)) continue;
          expect(isMessageKey(`pos.${p}`), `pos.${p}`).toBe(true);
          expect(ALL_MESSAGES[lang][`pos.${p}` as never]).toBeTruthy();
        }
      }
      for (const id of FAILURE_IDS)
        expect(ALL_MESSAGES[lang][`failure.${id}` as never]).toBeTruthy();
    }
  });

  it('puts every control on exactly one panel, the throttle on none', () => {
    const switches = switchGroups(C172_CONTROLS).flatMap((g) => g.specs.map((s) => s.id));
    for (const s of C172_CONTROLS) {
      const homes = [
        STACK_CONTROLS.has(s.id),
        AUTOPILOT_CONTROLS.has(s.id),
        switches.includes(s.id),
      ];
      expect(homes.filter(Boolean).length, s.id).toBe(s.id === 'throttle' ? 0 : 1);
    }
    expect(switchGroups(C172_CONTROLS).map((g) => g.group)).toEqual([
      'electrical',
      'engine',
      'controls',
      'lights',
      'instruments',
    ]);
    expect(avionicsAvailable(C172_CONTROLS)).toEqual({
      stack: true,
      autopilot: true,
      switches: true,
    });
    expect(avionicsAvailable([])).toEqual({ stack: false, autopilot: false, switches: false });
  });

  it('steps knobs by their step, ten steps coarse, wrapping or clamped', () => {
    const spec = (id: string) => C172_CONTROLS.find((s) => s.id === id)!;
    expect(stepKnob(spec('headingBug'), 355, false, 1)).toBe(356);
    expect(stepKnob(spec('headingBug'), 355, true, 1)).toBe(5);
    expect(stepKnob(spec('headingBug'), 0, false, -1)).toBe(359);
    expect(stepKnob(spec('apAltitude'), 3000, true, 1)).toBe(4000);
    expect(stepKnob(spec('apAltitude'), 100, true, -1)).toBe(0);
    expect(stepKnob(spec('altimeterSetting'), 1050, false, 1)).toBe(1050);
    expect(stepKnob(spec('trim'), 0, false, 1)).toBeCloseTo(0.02, 9);
  });

  it('presses a button long enough for the simulation to see it', () => {
    const calls: [string, number][] = [];
    const later: (() => void)[] = [];
    pressControl(
      (id, v) => calls.push([id, v]),
      'com1Swap',
      (fn) => later.push(fn),
    );
    expect(calls).toEqual([['com1Swap', 1]]);
    later.forEach((fn) => fn());
    expect(calls).toEqual([
      ['com1Swap', 1],
      ['com1Swap', 0],
    ]);
    expect(() => pressControl(undefined, 'x')).not.toThrow();
  });
});

describe('panels and keys', () => {
  const key = (code: string, more: Partial<KeyInput> = {}): KeyInput => ({
    code,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    typing: false,
    ...more,
  });
  const ctx: KeyContext = {
    flying: true,
    available: ['radio', 'checklist', 'stack', 'autopilot', 'switches'],
    replies: 2,
    canCheck: true,
    canTune: true,
  };

  it('maps its keys and leaves the app its own', () => {
    expect(flightKeyAction(key('KeyR'), ctx)).toEqual({ type: 'toggle', panel: 'radio' });
    expect(flightKeyAction(key('KeyL'), ctx)).toEqual({ type: 'toggle', panel: 'checklist' });
    expect(flightKeyAction(key('KeyN'), ctx)).toEqual({ type: 'toggle', panel: 'stack' });
    expect(flightKeyAction(key('KeyU'), ctx)).toEqual({ type: 'toggle', panel: 'autopilot' });
    expect(flightKeyAction(key('KeyK'), ctx)).toEqual({ type: 'toggle', panel: 'switches' });
    expect(flightKeyAction(key('Digit2'), ctx)).toEqual({ type: 'reply', index: 1 });
    expect(flightKeyAction(key('Numpad1'), ctx)).toEqual({ type: 'reply', index: 0 });
    expect(flightKeyAction(key('KeyX'), ctx)).toEqual({ type: 'check' });
    expect(flightKeyAction(key('KeyT'), ctx)).toEqual({ type: 'tune' });
    // The app's keys (see src/app/input.ts) are never taken.
    for (const code of [
      'KeyW',
      'KeyA',
      'KeyS',
      'KeyD',
      'KeyQ',
      'KeyE',
      'KeyB',
      'KeyF',
      'KeyV',
      'KeyG',
      'KeyC',
      'KeyP',
      'Space',
      'Escape',
    ])
      expect(flightKeyAction(key(code), ctx), code).toBeNull();
  });

  it('does nothing that is not possible now', () => {
    expect(flightKeyAction(key('Digit3'), ctx)).toBeNull();
    expect(flightKeyAction(key('Digit1'), { ...ctx, replies: 0 })).toBeNull();
    expect(flightKeyAction(key('KeyX'), { ...ctx, canCheck: false })).toBeNull();
    expect(flightKeyAction(key('KeyT'), { ...ctx, canTune: false })).toBeNull();
    expect(flightKeyAction(key('KeyR'), { ...ctx, available: [] })).toBeNull();
    expect(flightKeyAction(key('KeyR'), { ...ctx, flying: false })).toBeNull();
  });

  it('ignores typing, held keys and browser shortcuts', () => {
    expect(flightKeyAction(key('KeyR', { typing: true }), ctx)).toBeNull();
    expect(flightKeyAction(key('Digit1', { typing: true }), ctx)).toBeNull();
    expect(flightKeyAction(key('KeyR', { repeat: true }), ctx)).toBeNull();
    expect(flightKeyAction(key('KeyR', { ctrlKey: true }), ctx)).toBeNull();
    expect(flightKeyAction(key('KeyL', { metaKey: true }), ctx)).toBeNull();
    expect(flightKeyAction(key('KeyN', { altKey: true }), ctx)).toBeNull();
  });

  it('opens one panel on a phone, one avionics panel next to radio and checklist elsewhere', () => {
    expect(togglePanel([], 'radio', false)).toEqual(['radio']);
    expect(togglePanel(['radio'], 'checklist', false)).toEqual(['radio', 'checklist']);
    expect(togglePanel(['radio', 'stack'], 'autopilot', false)).toEqual(['radio', 'autopilot']);
    expect(togglePanel(['radio', 'stack'], 'stack', false)).toEqual(['radio']);
    expect(togglePanel(['radio'], 'stack', true)).toEqual(['stack']);
    expect(togglePanel(['stack'], 'stack', true)).toEqual([]);
  });
});

describe('settings, phase 3', () => {
  it('stores the HUD switches with defaults on', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      navStrip: true,
      radioText: true,
      checklistHints: true,
    });
    expect(parseSettings(JSON.stringify({ navStrip: false, radioText: 'no' }))).toMatchObject({
      navStrip: false,
      radioText: true,
      checklistHints: true,
    });
  });
});
