import { C172 } from './c172';
import { FlightModel } from './flightModel';
import type { AircraftId, AircraftInfo, ControlInput, SimAircraft } from './types';

/** Every flyable type, for menus. */
export const AIRCRAFT: AircraftInfo[] = [C172.info];

/** A new aircraft of the type, to be placed with reset(). */
export function createAircraft(id: AircraftId): SimAircraft {
  switch (id) {
    case 'c172':
      return new FlightModel(C172);
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
