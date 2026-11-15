/** Setting up the F/A-18 for the test pilots of harness.ts. */
import { TestEnvironment, createAvionics, type TestEnvironmentOptions } from '../../src/sim';
import { FA18 } from '../../src/sim/fa18';
import type { Fa18Fcs } from '../../src/sim/fa18/fcs';
import type { Fa18Systems } from '../../src/sim/fa18/systems';
import { FlightModel } from '../../src/sim/flightModel';
import { KT, type Flight } from './harness';

export interface Fa18Flight extends Flight {
  ac: FlightModel;
}

export const newFa18 = () => new FlightModel(FA18, createAvionics(FA18.avionics));
export const fcs = (f: Fa18Flight) => f.ac.controlLaw as Fa18Fcs;
export const fa18Systems = (f: Fa18Flight) => f.ac.typeSystems as Fa18Systems;
export const hud = (f: Fa18Flight) => f.ac.telemetry.avionics!.fa18!;

/** Flap selector positions as ControlInput's 0..1. */
export const FLAPS = { auto: 0, half: 0.5, full: 1 } as const;

/** In the air, trimmed, at `altitude` m and `ktas`; clean, gear up, unless asked. */
export function fa18Airborne(
  altitude: number,
  ktas: number,
  options: TestEnvironmentOptions & {
    flaps?: number;
    gearDown?: boolean;
    heading?: number;
    enginesRunning?: boolean;
  } = {},
): Fa18Flight {
  const env = new TestEnvironment(options);
  const ac = newFa18();
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

export function fa18OnGround(
  options: TestEnvironmentOptions & { heading?: number; enginesRunning?: boolean } = {},
): Fa18Flight {
  const env = new TestEnvironment(options);
  const ac = newFa18();
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

/**
 * Total internal fuel, kg, shared out over the tanks in proportion (a reset fills them all:
 * set it after the reset and let the FCS take up the new trim).
 */
export function setFuel(f: Fa18Flight, kg: number) {
  const tanks = f.ac.systems.fuel.tanks;
  const total = tanks.reduce((a, t) => a + t.usable, 0);
  f.ac.setFuelTanks(tanks.map((t) => (t.usable * kg) / total));
}
