import { describe, expect, it } from 'vitest';
import type { AircraftInfo } from '../src/sim/types';
import type { AirportOption } from '../src/ui/api';
import { settings } from '../src/ui/api';
import { ALL_MESSAGES, isMessageKey, lang, t } from '../src/ui/i18n';
import {
  MINUS,
  convertAltitude,
  convertSpeed,
  formatAltitude,
  formatClock,
  formatHeading,
  formatSpeed,
  formatVerticalSpeed,
  groupThousands,
  runwayHeading,
} from '../src/ui/format';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  parseSettings,
  persistSettings,
  saveSettings,
  type StorageLike,
} from '../src/ui/persist';
import {
  AIR_START_HEIGHTS,
  defaultDraft,
  draftToPlan,
  planProblem,
  sanitizeDraft,
  validatePlan,
} from '../src/ui/plan';
import { sunElevation, sunTimes, swissOffsetHours } from '../src/ui/sun';
import {
  clampToCircle,
  leverValue,
  sliderAxis,
  stickAxes,
  stickToControls,
  tiltAngles,
  tiltAxes,
} from '../src/ui/touchMath';

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

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
    runways: ['16', '34', '28'],
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

describe('unit conversion', () => {
  it('uses the exact knot and foot', () => {
    // 1 kt = 1852 m/h; 1 ft = 0.3048 m (international definitions).
    expect(convertSpeed(1852 / 3600, 'aviation')).toBeCloseTo(1, 12);
    expect(convertSpeed(10, 'metric')).toBeCloseTo(36, 12);
    expect(convertAltitude(0.3048, 'aviation')).toBeCloseTo(1, 12);
    expect(convertAltitude(1000, 'metric')).toBe(1000);
  });

  it('formats airspeed in whole units and never negative', () => {
    expect(formatSpeed(51.444, 'aviation')).toBe('100');
    expect(formatSpeed(27.78, 'metric')).toBe('100');
    expect(formatSpeed(-3, 'aviation')).toBe('0');
    expect(formatSpeed(NaN, 'aviation')).toBe('–');
  });

  it('groups thousands the Swiss way in German', () => {
    expect(groupThousands(12500, 'de')).toBe('12’500');
    expect(groupThousands(12500, 'en')).toBe('12,500');
    expect(groupThousands(999, 'en')).toBe('999');
    expect(groupThousands(-1500, 'en')).toBe(`${MINUS}1,500`);
  });

  it('rounds altitude to 10 ft or 1 m', () => {
    expect(formatAltitude(1000, 'aviation', 'en')).toBe('3,280');
    expect(formatAltitude(1000.4, 'metric', 'de')).toBe('1’000');
  });

  it('signs vertical speed and rounds to 50 ft/min', () => {
    expect(formatVerticalSpeed(2.54, 'aviation', 'en')).toBe('+500');
    expect(formatVerticalSpeed(-5.08, 'aviation', 'en')).toBe(`${MINUS}1,000`);
    expect(formatVerticalSpeed(0.1, 'aviation', 'en')).toBe('0');
    expect(formatVerticalSpeed(-1.26, 'metric', 'en')).toBe(`${MINUS}1.3`);
    expect(formatVerticalSpeed(0.01, 'metric', 'en')).toBe('0.0');
  });

  it('shows headings as three digits with north as 360', () => {
    expect(formatHeading(0)).toBe('360');
    expect(formatHeading(359.7)).toBe('360');
    expect(formatHeading(5.2)).toBe('005');
    expect(formatHeading(-90)).toBe('270');
    expect(formatHeading(725)).toBe('005');
  });

  it('formats clock times and runway headings', () => {
    expect(formatClock(13.5)).toBe('13:30');
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(24)).toBe('24:00');
    expect(formatClock(7.999)).toBe('08:00');
    expect(runwayHeading('14')).toBe(140);
    expect(runwayHeading('04L')).toBe(40);
    expect(runwayHeading('36')).toBe(360);
    expect(runwayHeading('xx')).toBe(0);
  });
});

describe('settings storage', () => {
  it('falls back to defaults for missing or corrupt data', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{not json')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('[1,2]')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('"text"')).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the good fields of a partly bad record', () => {
    const s = parseSettings(
      JSON.stringify({
        quality: 'ultra',
        volume: 3,
        muted: true,
        units: 'metric',
        invertPitch: 'yes',
      }),
    );
    expect(s.quality).toBe('auto');
    expect(s.volume).toBe(1);
    expect(s.muted).toBe(true);
    expect(s.units).toBe('metric');
    expect(s.invertPitch).toBe(false);
  });

  it('saves and restores through the signals', () => {
    const storage = new FakeStorage();
    settings.units.value = 'metric';
    settings.volume.value = 0.25;
    saveSettings(storage);
    settings.units.value = 'aviation';
    settings.volume.value = 0.9;
    loadSettings(storage);
    expect(settings.units.value).toBe('metric');
    expect(settings.volume.value).toBe(0.25);
  });

  it('keeps saving changes once persisted, and survives a throwing storage', () => {
    const storage = new FakeStorage();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ invertPitch: true }));
    const stop = persistSettings(storage);
    expect(settings.invertPitch.value).toBe(true);
    settings.quality.value = 'high';
    expect(JSON.parse(storage.getItem(SETTINGS_KEY)!).quality).toBe('high');
    stop();

    const broken: StorageLike = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(() => persistSettings(broken)()).not.toThrow();
    expect(() => saveSettings(broken)).not.toThrow();
    expect(settings.quality.value).toBe('auto');
  });
});

describe('flight plan', () => {
  it('starts at Bern-Belp on the first runway by default', () => {
    const d = defaultDraft(AIRPORTS, [C172]);
    expect(d).toMatchObject({ airport: 'LSZB', runway: '14', start: 'runway', aircraft: 'c172' });
    expect(draftToPlan(d, AIRPORTS, [C172])).toEqual({
      aircraft: 'c172',
      start: { kind: 'runway', airport: 'LSZB', runway: '14' },
      time: 'now',
      weather: 'live',
      season: 'now',
      airport: 'LSZB',
      coldStart: false,
      atc: true,
      failures: [],
    });
  });

  it('repairs a stored draft that no longer fits', () => {
    const d = sanitizeDraft(
      { airport: 'LSZH', runway: '99', time: 30, weather: 'storm', airHeight: 7, aircraft: 'f35' },
      AIRPORTS,
      [C172],
    );
    expect(d).toMatchObject({
      airport: 'LSZH',
      runway: '16',
      time: 'now',
      weather: 'live',
      airHeight: 1,
    });
    expect(d.aircraft).toBe('c172');
    expect(sanitizeDraft('garbage', AIRPORTS, [C172]).airport).toBe('LSZB');
    expect(sanitizeDraft({ airport: 'XXXX' }, AIRPORTS, [C172]).airport).toBe('LSZB');
    expect(sanitizeDraft({ time: 6.5 }, AIRPORTS, [C172]).time).toBe(6.5);
  });

  it('puts an air start above the airport, lined up with the runway', () => {
    const d = {
      ...defaultDraft(AIRPORTS, [C172]),
      start: 'air' as const,
      runway: '32',
      airHeight: 0,
    };
    const plan = draftToPlan(d, AIRPORTS, [C172])!;
    expect(plan.start).toEqual({
      kind: 'air',
      lon: 7.4971,
      lat: 46.9141,
      altitude: 510 + AIR_START_HEIGHTS[0],
      headingDeg: 320,
      // Phase 4: the speed of the type (100 kt for the Cessna).
      speed: (100 * 1852) / 3600,
    });
    expect(validatePlan(plan, AIRPORTS, [C172])).toBeNull();
  });

  it('cannot fly without airports or aircraft', () => {
    const empty = defaultDraft([], []);
    expect(planProblem(empty, [], [])).toBe('noAirport');
    expect(planProblem(defaultDraft(AIRPORTS, []), AIRPORTS, [])).toBe('noAircraft');
    expect(draftToPlan(empty, [], [])).toBeNull();
  });

  it('validates plans from elsewhere', () => {
    const ok = draftToPlan(defaultDraft(AIRPORTS, [C172]), AIRPORTS, [C172])!;
    expect(validatePlan(ok, AIRPORTS, [C172])).toBeNull();
    expect(validatePlan({ ...ok, weather: 'storm' }, AIRPORTS, [C172])).toMatch(/weather/);
    expect(validatePlan({ ...ok, time: 25 }, AIRPORTS, [C172])).toMatch(/time/);
    expect(
      validatePlan({ ...ok, start: { kind: 'runway', airport: 'LSZB', runway: '28' } }, AIRPORTS, [
        C172,
      ]),
    ).toMatch(/runway/);
    expect(validatePlan(null, AIRPORTS, [C172])).not.toBeNull();
  });
});

describe('touch controls', () => {
  it('has a dead zone and starts from zero beyond it', () => {
    expect(stickAxes(3, 0, 60)).toEqual({ x: 0, y: 0 });
    const justOut = stickAxes(60 * 0.081, 0, 60);
    expect(justOut.x).toBeGreaterThan(0);
    expect(justOut.x).toBeLessThan(0.01);
  });

  it('clamps to the unit circle', () => {
    const a = stickAxes(300, 400, 60);
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(1, 9);
    expect(a.x / a.y).toBeCloseTo(0.75, 9);
    expect(stickAxes(60, 0, 60).x).toBeCloseTo(1, 9);
    expect(stickAxes(10, 10, 0)).toEqual({ x: 0, y: 0 });
    expect(clampToCircle(30, 40, 10)).toEqual({ x: 6, y: 8 });
    expect(clampToCircle(3, 4, 10)).toEqual({ x: 3, y: 4 });
  });

  it('pulls the nose up when the thumb goes down, unless inverted', () => {
    expect(stickToControls({ x: 0, y: 1 }, false).pitch).toBeCloseTo(1, 9);
    expect(stickToControls({ x: 0, y: 1 }, true).pitch).toBeCloseTo(-1, 9);
    expect(stickToControls({ x: -1, y: 0 }, false).roll).toBeCloseTo(-1, 9);
    // The expo curve keeps small inputs smaller than linear.
    expect(stickToControls({ x: 0.3, y: 0 }, false).roll).toBeLessThan(0.3);
  });

  it('maps the throttle lever and the rudder slider', () => {
    expect(leverValue(100, 100, 200)).toBe(1);
    expect(leverValue(300, 100, 200)).toBe(0);
    expect(leverValue(200, 100, 200)).toBeCloseTo(0.5);
    expect(leverValue(-50, 100, 200)).toBe(1);
    expect(leverValue(900, 100, 200)).toBe(0);
    expect(sliderAxis(150, 100, 100)).toBe(0);
    expect(sliderAxis(200, 100, 100)).toBe(1);
    expect(sliderAxis(0, 100, 100)).toBe(-1);
  });

  it('reads tilt the same in portrait and landscape', () => {
    // Portrait, held upright: level.
    const upright = tiltAngles(90, 0, 0);
    expect(upright.roll).toBeCloseTo(0, 6);
    expect(upright.pitch).toBeCloseTo(0, 6);
    // Portrait, tilted back to 45° (screen facing up more): positive pitch.
    expect(tiltAngles(45, 0, 0).pitch).toBeCloseTo(45, 6);
    // Landscape (angle 90, top of the device on the left), held upright: gamma -90.
    const land = tiltAngles(0, -90, 90);
    expect(land.roll).toBeCloseTo(0, 6);
    expect(land.pitch).toBeCloseTo(0, 6);
    // Turning the device clockwise like a wheel banks right in both orientations.
    // (Upright portrait turned 10° clockwise: world up = (-0.17, 0.98, 0) in device axes.)
    const turned = tiltAngles(Math.asin(0.985) / (Math.PI / 180), 60, 0);
    expect(turned.roll).toBeGreaterThan(8);
    expect(turned.roll).toBeLessThan(12);
    // Landscape upright, then the screen faced 20° upwards: pitch +20.
    expect(tiltAngles(0, -70, 90).pitch).toBeCloseTo(20, 6);
    const axes = tiltAxes({ pitch: 70, roll: -50 }, 45, false);
    expect(axes.pitch).toBe(1);
    expect(axes.roll).toBe(-1);
    expect(tiltAxes({ pitch: 45, roll: 0 }, 45, true).pitch).toBeCloseTo(0, 9);
  });
});

describe('sun for the time slider', () => {
  it('knows Swiss summer and winter time', () => {
    expect(swissOffsetHours(new Date('2026-07-01T12:00:00Z'))).toBe(2);
    expect(swissOffsetHours(new Date('2026-01-15T12:00:00Z'))).toBe(1);
  });

  it('puts the midsummer noon sun high over Bern', () => {
    const e = sunElevation(new Date('2026-06-21T11:32:00Z'), 46.95, 7.44);
    expect(e).toBeGreaterThan(66);
    expect(e).toBeLessThan(67);
  });

  it('finds sunrise and sunset in Bern within a few minutes', () => {
    // Published times for Bern: 21 June about 05:35 and 21:29, 21 December about 08:13 and 16:44.
    const summer = sunTimes(new Date('2026-06-21T12:00:00Z'), 46.95, 7.44)!;
    expect(Math.abs(summer.sunrise - (5 + 35 / 60))).toBeLessThan(0.1);
    expect(Math.abs(summer.sunset - (21 + 29 / 60))).toBeLessThan(0.1);
    const winter = sunTimes(new Date('2026-12-21T12:00:00Z'), 46.95, 7.44)!;
    expect(Math.abs(winter.sunrise - (8 + 13 / 60))).toBeLessThan(0.1);
    expect(Math.abs(winter.sunset - (16 + 44 / 60))).toBeLessThan(0.1);
  });
});

describe('texts', () => {
  it('writes German the Swiss way, without the sharp s', () => {
    for (const [key, text] of Object.entries(ALL_MESSAGES.de)) expect(text, key).not.toMatch(/ß/);
  });

  it('fills placeholders and knows its keys', () => {
    lang.value = 'en';
    expect(t('menu.version', { v: '1.2' })).toBe('Version 1.2');
    expect(t('briefing.runway', { rwy: '14' })).toBe('Runway 14');
    lang.value = 'de';
    expect(t('briefing.runway', { rwy: '14' })).toBe('Piste 14');
    expect(isMessageKey('msg.gearDown')).toBe(true);
    expect(isMessageKey('toString')).toBe(false);
    expect(isMessageKey('Gear down')).toBe(false);
  });
});
