import { describe, expect, it } from 'vitest';
import { weatherFromOpenMeteo, windAtHeight } from '../src/world/liveWeather';
import { SimTraffic, fleetModelFor, parseReadsb } from '../src/game/trafficSources';

const current = (c: Partial<Record<string, number>>) => ({
  elevation: 450,
  current: {
    temperature_2m: 12,
    dew_point_2m: 4,
    cloud_cover: 40,
    cloud_cover_low: 40,
    cloud_cover_mid: 0,
    cloud_cover_high: 0,
    visibility: 30_000,
    wind_speed_10m: 5,
    wind_direction_10m: 250,
    wind_gusts_10m: 9,
    weather_code: 2,
    ...c,
  },
});

describe('live weather', () => {
  it('puts the cloud base at the condensation level (125 m per degree of spread)', () => {
    const w = weatherFromOpenMeteo(current({}));
    expect(w.base).toBeCloseTo(450 + 125 * 8, -1);
    expect(w.coverage).toBeGreaterThan(0.2);
    expect(w.top).toBeGreaterThan(w.base + 500);
    expect(w.fog).toBeNull();
  });

  it('turns clear skies, fog and the low stratus deck into the right look', () => {
    expect(weatherFromOpenMeteo(current({ cloud_cover: 0, cloud_cover_low: 0 })).coverage).toBe(0);
    const fog = weatherFromOpenMeteo(current({ visibility: 300, weather_code: 45 }));
    expect(fog.fog).not.toBeNull();
    expect(fog.fog!.density).toBeGreaterThan(0.005);
    const hochnebel = weatherFromOpenMeteo(
      current({ cloud_cover: 100, cloud_cover_low: 100, temperature_2m: 3, dew_point_2m: 1 }),
    );
    expect(hochnebel.fog!.base).toBeGreaterThan(450);
    expect(hochnebel.fog!.top).toBeGreaterThan(hochnebel.fog!.base);
    // Poorer visibility, more haze.
    expect(weatherFromOpenMeteo(current({ visibility: 5000 })).mie).toBeGreaterThan(
      weatherFromOpenMeteo(current({ visibility: 50_000 })).mie,
    );
  });

  it('lets the wind grow with height', () => {
    expect(windAtHeight(5, 10)).toBeCloseTo(5, 5);
    expect(windAtHeight(5, 1000)).toBeGreaterThan(7);
    expect(windAtHeight(5, 5000)).toBeLessThanOrEqual(10);
  });
});

describe('traffic', () => {
  it('maps ICAO types and categories to the fleet models', () => {
    expect(fleetModelFor('A320', 'A3')).toBe('a320');
    expect(fleetModelFor('B77W', 'A5')).toBe('b747');
    expect(fleetModelFor('C172', 'A1')).toBe('c172');
    expect(fleetModelFor('PC12', 'A1')).toBe('pc12');
    expect(fleetModelFor('E55P', 'A2')).toBe('phenom100');
    expect(fleetModelFor('F35', 'A6')).toBe('f35');
    expect(fleetModelFor(undefined, 'A7')).toBeNull();
  });

  it('reads ADS-B positions (feet, knots, ft/min) into SI units', () => {
    const [t] = parseReadsb({
      ac: [
        {
          hex: '4b1814',
          flight: 'SWR123 ',
          t: 'A320',
          lat: 47.4,
          lon: 8.5,
          alt_baro: 10000,
          gs: 250,
          track: 280,
          baro_rate: -1000,
        },
      ],
    });
    expect(t!.callsign).toBe('SWR123');
    expect(t!.alt).toBeCloseTo(3048, 0);
    expect(t!.gs).toBeCloseTo(128.6, 0);
    expect(t!.vs).toBeCloseTo(-5.08, 1);
    expect(
      parseReadsb({ ac: [{ hex: 'x', t: 'A320', lat: 47, lon: 8, alt_baro: 'ground', gs: 3 }] })[0]!
        .onGround,
    ).toBe(true);
  });

  it('simulates arrivals and departures at Zürich, landing into the wind', () => {
    const sim = new SimTraffic(() => 420);
    let targets = sim.update(0.1, 8.55, 47.45, 270);
    for (let i = 0; i < 1200; i++) targets = sim.update(0.5, 8.55, 47.45, 270);
    const zrh = targets.filter((t) => t.id.startsWith('LSZH'));
    expect(zrh.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(Number.isFinite(t.lon) && Number.isFinite(t.lat)).toBe(true);
      if (!t.onGround) expect(t.alt).toBeGreaterThan(400);
    }
  });
});
