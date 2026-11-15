import { describe, expect, it } from 'vitest';
import { AIRPORTS, isPaved } from '../src/geo/airports';
import { mapAirports } from '../src/ui/airportPick';
import type { AirportOption, PilotView } from '../src/ui/api';
import { ALL_MESSAGES } from '../src/ui/i18n';
import { leaveKey, pilotAction, pilotHint } from '../src/ui/pilot';

const OPTIONS: AirportOption[] = AIRPORTS.map((a) => ({
  icao: a.icao,
  name: a.name,
  lon: a.lon,
  lat: a.lat,
  elevation: a.elevation,
  runways: a.runways.flatMap((r) => r.ends.map((e) => e.ident)),
  strips: a.runways.map((r) => ({
    ends: r.ends.map((e) => e.ident),
    length: r.length,
    paved: isPaved(r.surface),
  })),
  military: a.military,
}));

describe('map of the flight planning', () => {
  it('draws only the airports the chosen kind of aircraft can use', () => {
    const icao = (c: Parameters<typeof mapAirports>[1]) =>
      mapAirports(OPTIONS, c).map((a) => a.icao);
    expect(icao('piston')).toHaveLength(OPTIONS.length);
    const a320 = icao('airliner');
    expect(a320).toEqual(expect.arrayContaining(['LSZH', 'LSGG', 'LFSB']));
    expect(a320).not.toContain('LSZB');
    expect(a320).not.toContain('LSZA');
    expect(a320.length).toBeLessThan(OPTIONS.length / 4);
  });
});

describe('pilot outside the aircraft', () => {
  const p = (over: Partial<PilotView>): PilotView => ({
    state: 'walk',
    agl: 0,
    speed: 0,
    verticalSpeed: 0,
    headingDeg: 0,
    canEnter: false,
    aircraftLost: false,
    ...over,
  });

  it('says what to do in each state, for keys and for touch', () => {
    expect(pilotHint(p({ state: 'freefall', agl: 2000 }), false)).toBe('pilot.hint.freefall');
    expect(pilotHint(p({ state: 'canopy' }), true)).toBe('pilot.hint.canopy.touch');
    expect(pilotHint(p({}), false)).toBe('pilot.hint.walk');
    expect(pilotHint(p({ canEnter: true }), false)).toBe('pilot.hint.enter');
    expect(pilotHint(p({ aircraftLost: true, canEnter: true }), true)).toBe('pilot.hint.lost');
    // Nothing opens the chute by itself: no promise of it, and urgent when low.
    expect(pilotHint(p({ state: 'freefall', agl: 450 }), false)).toBe('pilot.hint.freefall.low');
    expect(pilotHint(p({ state: 'freefall', agl: 450 }), true)).toBe(
      'pilot.hint.freefall.low.touch',
    );
    for (const lang of [ALL_MESSAGES.de, ALL_MESSAGES.en])
      for (const [k, v] of Object.entries(lang))
        if (k.startsWith('pilot.hint.freefall')) expect(v, k).not.toMatch(/300|automati|by itself/);
    expect(ALL_MESSAGES.en['pilot.hint.enter']).toContain('X');
  });

  it('offers the one touch action of the state and names the way out', () => {
    expect(pilotAction(p({ state: 'freefall' }))).toBe('pull');
    expect(pilotAction(p({ state: 'canopy' }))).toBe('flare');
    expect(pilotAction(p({ canEnter: true }))).toBe('enter');
    expect(pilotAction(p({}))).toBeNull();
    expect(leaveKey(true, true)).toBe('pilot.leave.ground');
    expect(leaveKey(false, true)).toBe('pilot.leave.eject');
    expect(leaveKey(false, false)).toBe('pilot.leave.jump');
  });
});
