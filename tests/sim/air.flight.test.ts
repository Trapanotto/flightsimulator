/**
 * The real C172 flight model in the air model's air: flown along the windward side of a
 * ridge it gains height against the same flight over flat ground.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT, TestEnvironment, createAircraft, ecefToGeodetic } from '../../src/sim';
import { AirModel, type AirWeather } from '../../src/sim/air/airModel';
import type { AirTerrain } from '../../src/sim/air/terrainField';
import type { AirSample, Vec3 } from '../../src/sim/types';
import { AttitudePilot, KT, Pid, clamp, headingError } from './harness';
import { east, plane, ridge } from './airTerrains';

const DEG = Math.PI / 180;

/** A TestEnvironment whose air comes from the air model over the given terrain. */
class ModelledAir extends TestEnvironment {
  time = 0;
  private readonly local: Vec3 = { x: 0, y: 0, z: 0 };
  constructor(
    readonly model: AirModel,
    readonly terrain: AirTerrain,
  ) {
    super();
  }
  override air(position: Vec3, out: AirSample): AirSample {
    super.air(position, out);
    const g = ecefToGeodetic(position);
    const w = this.model.sample(g.lon, g.lat, g.height, this.time, this.terrain, this.local);
    // East, north, up at the place, in ECEF.
    const sl = Math.sin(g.lon * DEG);
    const cl = Math.cos(g.lon * DEG);
    const sp = Math.sin(g.lat * DEG);
    const cp = Math.cos(g.lat * DEG);
    out.wind.x = -sl * w.x - sp * cl * w.y + cp * cl * w.z;
    out.wind.y = cl * w.x - sp * sl * w.y + cp * sl * w.z;
    out.wind.z = cp * w.y + sp * w.z;
    return out;
  }
}

const WEATHER: AirWeather = {
  windFromDeg: 270,
  windSpeed: 8,
  sunElevationDeg: -10,
  cloudCover: 1,
  temperature: 10,
  stability: 0,
};

/**
 * 90 s at 80 KIAS northwards along the ridge, 600 m west of its crest (x = -600 m: the windward
 * flank), holding speed with pitch and the track with bank. Returns the height gained.
 */
function flyAlong(terrain: AirTerrain): number {
  const model = new AirModel({ seed: 11 });
  model.setWeather(WEATHER);
  const env = new ModelledAir(model, terrain);
  const ac = createAircraft('c172');
  const x0 = -600;
  const start = 600;
  ac.reset(
    { position: env.position(start, 0, x0), headingDeg: 0, speed: 80 * KT, onGround: false },
    env,
  );
  const pilot = new AttitudePilot(ac);
  const speed = new Pid(0.012, 0.002, 0, 0.5);
  const base = ac.telemetry.pitch;
  // Heading into wind that the track loop learns (the crab angle).
  let heading = 0;
  ac.controls.throttle[0] = 0.75;
  const t = ac.telemetry;
  for (let i = 0; i < Math.round(90 / SIM_DT); i++) {
    const x = east(ecefToGeodetic(ac.state.position).lon);
    const track = clamp(-0.05 * (x - x0), -25, 25);
    heading += SIM_DT * 0.3 * headingError(track, t.trackDeg);
    pilot.pitchTo(base + speed.update(t.ias / KT - 80, SIM_DT), SIM_DT);
    pilot.bankTo(clamp(0.03 * headingError(heading, t.headingDeg), -0.35, 0.35), SIM_DT);
    pilot.ball();
    ac.step(SIM_DT, env);
    env.time += SIM_DT;
  }
  expect(t.crashed).toBeUndefined();
  // It stayed on the windward flank.
  expect(Math.abs(east(ecefToGeodetic(ac.state.position).lon) - x0)).toBeLessThan(250);
  return t.altitude - start;
}

describe('a C172 in ridge lift', () => {
  it('gains height along the windward side of a ridge against a flight over flat ground', () => {
    const control = flyAlong(plane(0));
    const along = flyAlong(ridge());
    // About 1.5 m/s more climb on average over 90 s (the lift fades as it climbs).
    expect(along - control).toBeGreaterThan(80);
    expect(along - control).toBeLessThan(450);
  });
});
