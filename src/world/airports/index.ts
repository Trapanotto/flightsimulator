import type { LocalFrame } from '@geo';
import type { DeviceClass, WorldLayer } from '../layers';
import { AirportLayer } from './AirportLayer';

/**
 * The airports of the world: runways with their markings, taxiways, aprons, lights and
 * windsocks of every airfield near the camera (see AirportLayer).
 */
export function createAirportLayer(frame: LocalFrame, device: DeviceClass): WorldLayer {
  return new AirportLayer(frame, device);
}

export { AirportLayer, lightsOnFor } from './AirportLayer';
