import { createAvionics } from './avionics/avionics';
import { C172 } from './c172';
import { PC12 } from './pc12';
import { FlightModel } from './flightModel';
import type { AvionicsUnit } from './avionicsTypes';
import type { AircraftId, AircraftInfo, ControlInput, SimAircraft } from './types';

/** Every flyable type, for menus. */
export const AIRCRAFT: AircraftInfo[] = [C172.info, PC12.info];

/**
 * A new aircraft of the type, to be placed with reset(). `avionics` is the unit its radios,
 * navigation and autopilot run in; by default the type's own.
 */
export function createAircraft(
  id: AircraftId,
  options: { avionics?: AvionicsUnit } = {},
): SimAircraft {
  switch (id) {
    case 'c172':
      return new FlightModel(C172, options.avionics ?? createAvionics(C172.avionics));
    case 'pc12':
      return new FlightModel(PC12, options.avionics ?? createAvionics(PC12.avionics));
  }
  throw new Error(`createAircraft('${String(id)}'): unknown type`);
}

/** Neutral controls for an aircraft with `engines` engines. */
export function neutralControls(engines: number): ControlInput {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: Array.from({ length: engines }, () => 0),
    flaps: 0,
    gearDown: true,
    brakeLeft: 0,
    brakeRight: 0,
    parkingBrake: false,
    pitchTrim: 0,
    mixture: Array.from({ length: engines }, () => 1),
    starter: Array.from({ length: engines }, () => false),
  };
}
