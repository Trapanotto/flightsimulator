import type { AircraftId, AircraftInfo, SimAircraft } from './types';

/** Every flyable type, for menus. */
export const AIRCRAFT: AircraftInfo[] = [];

/** A new aircraft of the type, to be placed with reset(). */
export function createAircraft(id: AircraftId): SimAircraft {
  throw new Error(`createAircraft('${id}'): the flight model arrives in phase 1`);
}

/** Neutral controls for an aircraft with `engines` engines. */
export function neutralControls(engines: number) {
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
  };
}
