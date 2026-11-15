import { describe, expect, it } from 'vitest';
import { PC12_CONTROLS } from '../src/sim/cockpitPc12';
import type { AircraftInfo } from '../src/sim/types';
import type { AirportOption } from '../src/ui/api';
import {
  AUTOPILOT_CONTROLS,
  STACK_CONTROLS,
  controlLabel,
  groupLabel,
  groupOf,
  positionLabel,
  readableId,
  switchGroups,
} from '../src/ui/cockpitMeta';
import {
  RUNWAY_NEED,
  TYPE_DEFAULTS,
  airportEligibility,
  categoryOf,
  homeAirport,
  overspeedLimit,
  typeFeatures,
} from '../src/ui/fleet';
import { FLEET_KEYS } from '../src/ui/fleet';
import { flyingKeyRows, typeKeyRows } from '../src/ui/fleetText';
import { formatMach, formatSpec } from '../src/ui/format';
import { ALL_MESSAGES, isMessageKey, setLang } from '../src/ui/i18n';
import { defaultDraft, draftToPlan, sanitizeDraft, validatePlan } from '../src/ui/plan';
import { travelValue } from '../src/ui/touchMath';
import { autopilotHelpers, selectedSpeedText } from '../src/ui/screens/AvionicsPanels';

const KT = 1852 / 3600;
const FT = 0.3048;

const C172: AircraftInfo = {
  id: 'c172',
  name: 'Cessna 172S Skyhawk SP',
  engines: 1,
  vs: 48 * KT,
  vs0: 40 * KT,
  vne: 163 * KT,
  maxTakeoffMass: 1157,
  retractableGear: false,
};
const PC12: AircraftInfo = {
  id: 'pc12',
  name: 'Pilatus PC-12 NG',
  engines: 1,
  vs: 87 * KT,
  vs0: 67 * KT,
  vne: 236 * KT,
  maxTakeoffMass: 4740,
  retractableGear: true,
  category: 'turboprop',
  reverse: true,
};
const A320: AircraftInfo = {
  id: 'a320',
  name: 'Airbus A320-214',
  engines: 2,
  vs: 130 * KT,
  vs0: 107 * KT,
  vne: 350 * KT,
  maxTakeoffMass: 78_000,
  retractableGear: true,
  category: 'airliner',
  speedbrake: true,
  reverse: true,
  vRotate: 145 * KT,
  vApproach: 135 * KT,
  specs: {
    maker: 'Airbus',
    powerplant: '2 × CFM56-5B4',
    span: 34.1,
    length: 37.57,
    height: 11.76,
    emptyMass: 42_600,
    cruiseSpeed: 447 * KT,
    maxSpeed: 350 * KT,
    maxMach: 0.82,
    ceiling: 39_800 * FT,
    range: 3100 * 1852,
    climbRate: 2500 * (FT / 60),
    takeoffRoll: 1700,
    landingRoll: 900,
    seats: 180,
    firstFlight: 1987,
  },
};
const FA18: AircraftInfo = {
  id: 'fa18',
  name: 'Boeing F/A-18C Hornet',
  engines: 2,
  vs: 135 * KT,
  vs0: 115 * KT,
  vne: 700 * KT,
  maxTakeoffMass: 23_540,
  retractableGear: true,
  category: 'fighter',
  speedbrake: true,
  reverse: false,
};
const FLEET = [C172, PC12, A320, FA18];

/** Airports as the app offers them; their runways come from the geo package by ICAO. */
const apt = (icao: string, runways: string[], elevation = 450): AirportOption => ({
  icao,
  name: icao,
  lon: 8,
  lat: 47,
  elevation,
  runways,
});
const LSZB = apt('LSZB', ['14', '32', '14L', '32R'], 510);
const LSZH = { ...apt('LSZH', ['16', '34', '14', '32', '10', '28'], 432), lon: 8.549, lat: 47.465 };
const LSZS = apt('LSZS', ['03', '21'], 1707);
const LSMM = apt('LSMM', ['10', '28'], 577);
const LSMP = apt('LSMP', ['05', '23'], 450);
const LSGR = apt('LSGR', ['03', '21']);
const LSZG = apt('LSZG', ['06', '24', '06R', '24L']);
const LSZA = apt('LSZA', ['01', '19']);
const EDTZ = apt('EDTZ', ['12', '30']);
const LSYQ = apt('LSYQ', ['21', '03']);
const LSZC = apt('LSZC', ['06', '24']);
const AIRPORTS = [LSZB, LSZH, LSZS, LSMM, LSMP, LSGR, LSZG, LSZA, EDTZ, LSYQ, LSZC];

describe('airport eligibility by category', () => {
  it('lets the Cessna go anywhere', () => {
    for (const a of AIRPORTS) expect(airportEligibility(a, 'piston').ok).toBe(true);
    expect(airportEligibility(LSZB, 'piston')).toEqual({ ok: true, ends: LSZB.runways });
  });

  it('keeps the A320 to 1800 m of hard runway', () => {
    expect(RUNWAY_NEED.airliner).toEqual({ minLength: 1800, paved: true, military: false });
    // Bern-Belp: 1777 m of asphalt, a little short.
    expect(airportEligibility(LSZB, 'airliner')).toMatchObject({
      ok: false,
      reason: 'short',
      longest: 1777,
    });
    expect(airportEligibility(LSZH, 'airliner')).toEqual({ ok: true, ends: LSZH.runways });
    // Samedan's 1841 m are enough; Konstanz has grass only.
    expect(airportEligibility(LSZS, 'airliner').ok).toBe(true);
    expect(airportEligibility(EDTZ, 'airliner')).toMatchObject({ ok: false, reason: 'unpaved' });
  });

  it('gives the fighter 1200 m paved or any hard runway of a military field', () => {
    expect(airportEligibility(LSZA, 'fighter').ok).toBe(true); // 1350 m
    expect(airportEligibility(LSGR, 'fighter').ok).toBe(true); // 897 m, military
    expect(airportEligibility(LSZG, 'fighter')).toMatchObject({ ok: false, longest: 1000 });
    expect(airportEligibility(LSMM, 'fighter').ok).toBe(true);
  });

  it('offers only the runway ends a type may use', () => {
    // The grass strips of Bern are no runway for the PC-12's 700 m; the main runway is.
    expect(airportEligibility(LSZB, 'turboprop')).toEqual({ ok: true, ends: ['14', '32'] });
    expect(airportEligibility(LSYQ, 'turboprop').ok).toBe(false);
  });

  it('prefers the runways the app hands over and never refuses an unknown airport', () => {
    const own = { ...LSZB, strips: [{ ends: ['14', '32'], length: 2000, paved: true }] };
    expect(airportEligibility(own, 'airliner').ok).toBe(true);
    expect(airportEligibility(apt('XXXX', ['09', '27']), 'airliner').ok).toBe(true);
  });

  it('knows the category of a type without one', () => {
    expect(categoryOf(C172)).toBe('piston');
    expect(categoryOf({ ...A320, category: undefined })).toBe('airliner');
    expect(categoryOf(undefined)).toBe('piston');
  });
});

describe('plan defaults per type', () => {
  it('starts every type at its home', () => {
    expect(defaultDraft(AIRPORTS, [C172]).airport).toBe('LSZB');
    expect(defaultDraft(AIRPORTS, [PC12]).airport).toBe('LSZC');
    expect(defaultDraft(AIRPORTS, [A320]).airport).toBe('LSZH');
    expect(defaultDraft(AIRPORTS, [FA18]).airport).toBe('LSMP');
    expect(homeAirport([LSZB], 'airliner')).toBeUndefined();
  });

  it('moves the setup to an airport the new type may use', () => {
    const d = sanitizeDraft(
      { ...defaultDraft(AIRPORTS, FLEET), aircraft: 'a320' },
      AIRPORTS,
      FLEET,
    );
    expect(d.airport).toBe('LSZH');
    // The runway it had is one Zurich has too.
    expect(d.runway).toBe('14');
    // An ineligible airport cannot be chosen.
    expect(sanitizeDraft({ ...d, airport: 'LSZB' }, AIRPORTS, FLEET).airport).toBe('LSZH');
  });

  it('keeps the approach distance as near as the type offers', () => {
    expect(TYPE_DEFAULTS.airliner.approachDistances).toEqual([6, 8, 10, 12, 15]);
    const d = sanitizeDraft({ aircraft: 'a320', approachNm: 4 }, AIRPORTS, FLEET);
    expect(d.approachNm).toBe(6);
    expect(sanitizeDraft({ aircraft: 'c172', approachNm: 15 }, AIRPORTS, FLEET).approachNm).toBe(
      12,
    );
    expect(defaultDraft(AIRPORTS, [A320]).approachNm).toBe(10);
  });

  it('starts in the air at the height and speed of the type', () => {
    const draft = { ...defaultDraft(AIRPORTS, [A320]), start: 'air' as const, airHeight: 2 };
    const plan = draftToPlan(draft, AIRPORTS, [A320]);
    expect(plan?.start.kind).toBe('air');
    if (plan?.start.kind !== 'air') return;
    expect(plan.start.altitude).toBeCloseTo(432 + 10_000 * FT, 3);
    expect(plan.start.speed).toBeCloseTo(250 * KT, 6);
    expect(validatePlan(plan, AIRPORTS, [A320])).toBeNull();

    const cessna = draftToPlan(
      { ...defaultDraft(AIRPORTS, [C172]), start: 'air', airHeight: 0 },
      AIRPORTS,
      [C172],
    );
    expect(cessna?.start.kind === 'air' && cessna.start.altitude).toBeCloseTo(510 + 304.8, 3);
    expect(cessna?.start.kind === 'air' && cessna.start.speed).toBeCloseTo(100 * KT, 6);
  });

  it('refuses plans a type cannot fly', () => {
    const plan = {
      aircraft: 'a320',
      start: { kind: 'runway', airport: 'LSZB', runway: '14' },
      time: 'now',
      weather: 'clear',
    };
    expect(validatePlan(plan, AIRPORTS, FLEET)).toBe('runway unsuitable for the aircraft');
    expect(validatePlan({ ...plan, aircraft: 'c172' }, AIRPORTS, FLEET)).toBeNull();
    expect(
      validatePlan(
        { ...plan, start: { kind: 'approach', airport: 'LSZH', runway: '14', distanceNm: 15 } },
        AIRPORTS,
        FLEET,
      ),
    ).toBeNull();
  });
});

describe('published figures in the player units', () => {
  it('formats lengths, masses and speeds', () => {
    expect(formatSpec('length', 11, 'metric', 'de')).toEqual({ value: '11.0', unit: 'm' });
    expect(formatSpec('length', 11, 'aviation', 'de')).toEqual({ value: '36', unit: 'ft' });
    expect(formatSpec('length', 1700, 'metric', 'de')).toEqual({ value: '1’700', unit: 'm' });
    // 1700 m = 5577 ft, to 10 ft.
    expect(formatSpec('length', 1700, 'aviation', 'en')).toEqual({ value: '5,580', unit: 'ft' });
    expect(formatSpec('mass', 78_000, 'aviation', 'de')).toEqual({ value: '78’000', unit: 'kg' });
    expect(formatSpec('speed', 447 * KT, 'aviation', 'de')).toEqual({ value: '447', unit: 'kt' });
    expect(formatSpec('speed', 447 * KT, 'metric', 'de')).toEqual({ value: '828', unit: 'km/h' });
  });

  it('formats ceiling, range and climb', () => {
    expect(formatSpec('altitude', 39_800 * FT, 'aviation', 'de').value).toBe('39’800');
    expect(formatSpec('altitude', 39_800 * FT, 'metric', 'de')).toEqual({
      value: '12’130',
      unit: 'm',
    });
    expect(formatSpec('range', 3100 * 1852, 'aviation', 'de')).toEqual({
      value: '3’100',
      unit: 'NM',
    });
    expect(formatSpec('range', 3100 * 1852, 'metric', 'en')).toEqual({
      value: '5,740',
      unit: 'km',
    });
    expect(formatSpec('climb', 2500 * (FT / 60), 'aviation', 'de')).toEqual({
      value: '2’500',
      unit: 'ft/min',
    });
    expect(formatSpec('climb', 12.7, 'metric', 'de')).toEqual({ value: '12.7', unit: 'm/s' });
    expect(formatMach(0.776)).toBe('M 0.78');
  });

  it('lowers the speed limit to the maximum Mach number at height', () => {
    expect(overspeedLimit(A320, 140, undefined)).toBe(A320.vne);
    // At Mach 0.78 and 280 kt indicated, M 0.82 comes at about 294 kt.
    expect(overspeedLimit(A320, 280 * KT, 0.78) / KT).toBeCloseTo((280 * 0.82) / 0.78, 6);
    expect(overspeedLimit(C172, 50, 0.15)).toBe(C172.vne);
  });
});

describe('cockpit controls of any type', () => {
  it('names and groups every control of the PC-12 in both languages', () => {
    for (const s of PC12_CONTROLS) {
      const key = `ctl.${s.id}`;
      expect(isMessageKey(key), key).toBe(true);
      expect(ALL_MESSAGES.en[key as keyof typeof ALL_MESSAGES.en], key).toBeTruthy();
      const panel = STACK_CONTROLS.has(s.id) || AUTOPILOT_CONTROLS.has(s.id);
      const flown = s.id === 'throttle' || s.id === 'reverse';
      if (!panel && !flown) expect(groupOf(s.id), s.id).not.toBe('other');
      for (const p of s.positions ?? [])
        expect(/^\d+$/.test(p) || isMessageKey(`pos.${p}`), `${s.id}: ${p}`).toBe(true);
    }
  });

  it('puts pitot heat with the ice protection of a type that has it', () => {
    const groups = switchGroups(PC12_CONTROLS);
    const ice = groups.find((g) => g.group === 'ice')!.specs.map((s) => s.id);
    expect(ice).toEqual(['pitotHeat', 'propDeice', 'bootsDeice', 'windshieldHeat']);
    expect(groups.some((g) => g.specs.some((s) => s.id === 'reverse'))).toBe(false);
    setLang('de');
    expect(groupLabel('engine', PC12_CONTROLS)).toBe('Triebwerk');
    expect(groupLabel('lights', PC12_CONTROLS)).toBe('Licht');
  });

  it('shows a control nobody has labelled readably, under other', () => {
    expect(readableId('apuBleedAir')).toBe('APU bleed air');
    expect(readableId('engineMaster1')).toBe('Engine master 1');
    expect(controlLabel('spoilerArm')).toBe('Spoiler arm');
    expect(groupOf('apuMaster')).toBe('other');
    expect(positionLabel('autobrake', 'med')).toBe('Med');
  });

  it('writes flap degrees only where every notch is a number', () => {
    expect(positionLabel('flaps', '15', ['0', '15', '30', '40'])).toBe('15°');
    expect(positionLabel('flaps', '2', ['0', '1', '2', '3', 'full'])).toBe('2');
  });

  it('shows what runs beside the autopilot', () => {
    const ap = {
      engaged: false,
      lateral: 'hdg' as const,
      lateralArmed: undefined,
      vertical: 'flc' as const,
      verticalArmed: undefined,
      selectedAltitude: 9000,
      selectedVerticalSpeed: 0,
      disconnectWarning: false,
      yawDamper: true,
      flightDirector: { pitch: 0, bank: 0 },
      selectedSpeed: 160,
    };
    expect(autopilotHelpers(ap)).toEqual(['YD', 'FD']);
    expect(selectedSpeedText(ap)).toBe('160 kt');
    expect(autopilotHelpers({ ...ap, yawDamper: undefined, flightDirector: undefined })).toEqual(
      [],
    );
    expect(
      selectedSpeedText({
        ...ap,
        vertical: 'alt',
        autothrottle: { engaged: true, mode: 'speed' },
        selectedMach: 0.78,
      }),
    ).toBe('M 0.78');
  });
});

describe('keys by type', () => {
  it('shows gear, speed brake and reverse only where the type has them', () => {
    const labels = (info: AircraftInfo) => flyingKeyRows(info).map((r) => r.label);
    expect(labels(C172)).not.toContain('keys.gear');
    expect(labels(C172)).not.toContain('keys.speedbrake');
    expect(labels(PC12)).toEqual(expect.arrayContaining(['keys.gear', 'keys.reverse']));
    expect(labels(PC12)).not.toContain('keys.speedbrake');
    expect(labels(A320)).toEqual(expect.arrayContaining(['keys.speedbrake', 'keys.reverse']));
    expect(labels(FA18)).not.toContain('keys.reverse');
    expect(typeFeatures(FA18)).toEqual({ gear: true, speedbrake: true, reverse: false });
  });

  it('lists the keys that differ with the types that use them', () => {
    expect(typeKeyRows([C172])).toEqual([]);
    const rows = typeKeyRows(FLEET);
    expect(rows.find((r) => r.row.label === 'keys.reverse')?.types).toEqual(['PC-12', 'A320']);
    expect(rows.find((r) => r.row.label === 'keys.speedbrake')?.types).toEqual(['A320', 'F/A-18']);
  });

  it('keeps clear of the keys the app and the panels use, and of Y and Z', () => {
    const taken = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyB', 'KeyF', 'KeyV'];
    taken.push('KeyC', 'KeyP', 'KeyR', 'KeyL', 'KeyN', 'KeyU', 'KeyK', 'KeyX', 'KeyT');
    for (const k of [
      FLEET_KEYS.speedbrakeExtend,
      FLEET_KEYS.speedbrakeRetract,
      FLEET_KEYS.reverse,
    ]) {
      expect(taken).not.toContain(k);
      expect(['KeyY', 'KeyZ']).not.toContain(k);
    }
  });
});

describe('speed brake lever', () => {
  it('extends as it is pulled along its track', () => {
    expect(travelValue(100, 100, 200)).toBe(0);
    expect(travelValue(200, 100, 200)).toBe(0.5);
    expect(travelValue(400, 100, 200)).toBe(1);
    expect(travelValue(50, 100, 200)).toBe(0);
    expect(travelValue(50, 100, 0)).toBe(0);
  });
});
