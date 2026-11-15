/** Setting up the PC-12 for the test pilots of harness.ts. */
import { TestEnvironment, createAircraft, type TestEnvironmentOptions } from '../../src/sim';
import type { FlightModel } from '../../src/sim/flightModel';
import { KT, type Flight } from './harness';

export interface Pc12Flight extends Flight {
  ac: FlightModel;
}

/** In the air, trimmed, at `altitude` m and `ktas`; clean with the gear up unless asked. */
export function pc12Airborne(
  altitude: number,
  ktas: number,
  options: TestEnvironmentOptions & {
    flaps?: number;
    gearDown?: boolean;
    heading?: number;
    enginesRunning?: boolean;
  } = {},
): Pc12Flight {
  const env = new TestEnvironment(options);
  const ac = createAircraft('pc12') as FlightModel;
  ac.controls.flaps = options.flaps ?? 0;
  ac.reset(
    {
      position: env.position(altitude - (options.elevation ?? 0)),
      headingDeg: options.heading ?? 0,
      speed: ktas * KT,
      onGround: false,
      gearDown: options.gearDown ?? false,
      enginesRunning: options.enginesRunning,
    },
    env,
  );
  return { ac, env };
}

export function pc12OnGround(
  options: TestEnvironmentOptions & { heading?: number; enginesRunning?: boolean } = {},
): Pc12Flight {
  const env = new TestEnvironment(options);
  const ac = createAircraft('pc12') as FlightModel;
  ac.reset(
    {
      position: env.position(0),
      headingDeg: options.heading ?? 0,
      speed: 0,
      onGround: true,
      enginesRunning: options.enginesRunning,
    },
    env,
  );
  return { ac, env };
}

/** The flight's engine telemetry. */
export const engine = (f: Flight) => f.ac.telemetry.engines[0]!;
