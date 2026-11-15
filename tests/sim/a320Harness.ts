/** Setting up the A320 for the test pilots of harness.ts. */
import { TestEnvironment, type TestEnvironmentOptions } from '../../src/sim';
import { A320, A320_FUEL, A320_OEW, A320_TANKS } from '../../src/sim/a320';
import { createAvionics } from '../../src/sim/avionics/avionics';
import type { AircraftDefinition } from '../../src/sim/definition';
import { FlightModel } from '../../src/sim/flightModel';
import { SIM_DT } from '../../src/sim';
import { KT, type Flight } from './harness';

export interface A320Flight extends Flight {
  ac: FlightModel;
}

export interface A320Options extends TestEnvironmentOptions {
  /** Gross mass, kg (payload and fuel are split to make it; default 60 t). */
  mass?: number;
  /** Fuel on board on the ground, kg (default: what the mass leaves after a 13 t payload). */
  fuel?: number;
  /** Flap lever position 0..4 (0, 1, 2, 3, FULL). */
  flapLever?: number;
  gearDown?: boolean;
  heading?: number;
  enginesRunning?: boolean;
  /** Another definition (a variant for a calibration). */
  def?: AircraftDefinition;
  /** No avionics unit. */
  noAvionics?: boolean;
}

/** Fuel split as the A320 loads it: wings first, then the centre tank. */
export function tankLoad(fuel: number): number[] {
  const wing = Math.min(fuel / 2, A320_TANKS.wing);
  const centre = Math.max(0, fuel - 2 * wing);
  return [wing, wing, centre];
}

/**
 * A reset fills every tank, so in the air the definition takes up the rest of the mass:
 * trimmed at the asked gross mass with the tanks full. On the ground the fuel is loaded after.
 */
function create(o: A320Options, inAir: boolean): A320Flight & { fuelLoad: number } {
  const env = new TestEnvironment(o);
  const mass = o.mass ?? 60_000;
  const fuel = o.fuel ?? Math.min(A320_FUEL, Math.max(2000, mass - A320_OEW - 13_000));
  const base = o.def ?? A320;
  const def = { ...base, mass: mass - (inAir ? A320_FUEL : fuel) };
  const ac = new FlightModel(def, o.noAvionics ? undefined : createAvionics(def.avionics));
  ac.controls.flaps = (o.flapLever ?? 0) / 4;
  return { ac, env, fuelLoad: fuel };
}

/** In the air, trimmed, at `altitude` m above the field and `ktas`. */
export function a320Airborne(altitude: number, ktas: number, o: A320Options = {}): A320Flight {
  const f = create(o, true);
  f.ac.reset(
    {
      position: f.env.position(altitude - (o.elevation ?? 0)),
      headingDeg: o.heading ?? 0,
      speed: ktas * KT,
      onGround: false,
      gearDown: o.gearDown ?? false,
      enginesRunning: o.enginesRunning,
    },
    f.env,
  );
  return f;
}

export function a320OnGround(o: A320Options = {}): A320Flight {
  const f = create(o, false);
  f.ac.reset(
    {
      position: f.env.position(0),
      headingDeg: o.heading ?? 0,
      speed: 0,
      onGround: true,
      enginesRunning: o.enginesRunning,
    },
    f.env,
  );
  f.ac.setFuelTanks(tankLoad(f.fuelLoad));
  return f;
}

/** Presses a cockpit button for one step, as a finger does. */
export function press(f: Flight, id: string) {
  f.ac.cockpit.set(id, 1);
  f.ac.step(SIM_DT, f.env);
  f.ac.cockpit.set(id, 0);
  f.ac.step(SIM_DT, f.env);
}

export const airbus = (f: Flight) => f.ac.telemetry.avionics!.autopilot.airbus!;
