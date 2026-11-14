import type { DeviceClass } from '../layers';

/** Budget of the airport layer per device class. */
export interface AirportPreset {
  /** Airports whose reference point is nearer than this (metres) are built. */
  range: number;
  /** ... and dropped again beyond this (hysteresis). */
  dropRange: number;
  /** Metres between mesh rows along runways and taxiways (finer follows the terrain closer). */
  step: number;
  /** Metres between mesh columns across a runway. */
  across: number;
  /** Terrain height queries per frame for seating the meshes. */
  seatPerFrame: number;
  /** Centre line light spacing on CAT II/III runways. */
  centreSpacing: number;
  touchdownZone: boolean;
  /** Metres between taxiway edge lights, 0 = none. */
  taxiSpacing: number;
  /** Taxiways and aprons (the ground detail files). */
  ground: boolean;
  /** Smallest and largest light sprite radius, pixels (at 1080 pixels screen height). */
  minPx: number;
  maxPx: number;
}

export const AIRPORT_PRESETS: Record<DeviceClass, AirportPreset> = {
  desktop: {
    range: 26_000,
    dropRange: 32_000,
    step: 8,
    across: 7.5,
    seatPerFrame: 3000,
    centreSpacing: 15,
    touchdownZone: true,
    taxiSpacing: 30,
    ground: true,
    minPx: 0.85,
    maxPx: 7,
  },
  mobile: {
    range: 18_000,
    dropRange: 22_000,
    step: 12,
    across: 10,
    seatPerFrame: 1500,
    centreSpacing: 30,
    touchdownZone: false,
    taxiSpacing: 60,
    ground: true,
    minPx: 0.85,
    maxPx: 6,
  },
};
