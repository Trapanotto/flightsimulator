/**
 * What the ground bakes and draws per device class (lights, roads, horizon), and what it costs
 * in memory. Kept with the terrain rather than in WorldQuality: the streamer picks a preset by
 * the quality's `device`.
 */
import type { DeviceClass } from '../layers';

export interface GroundSettings {
  /**
   * Channels of the per-tile ground texture: 4 = lights (lamps, glow) and roads (distance,
   * width), 2 = lights only.
   */
  groundChannels: 2 | 4;
  /** Tiles from this zoom on carry the road field (crisp ribbons close up). */
  roadsMinZoom: number;
  /** Points per side of the horizon grid of a tile (8 directions each). */
  horizonSize: number;
  /** Read the surroundings (coarse zoom-10 terrain) for long mountain shadows. */
  horizonContext: boolean;
  /** Anisotropic filtering of the detail noise (sharp grass and rows at grazing angles). */
  noiseAnisotropy: number;
}

export const GROUND_SETTINGS: Record<DeviceClass, GroundSettings> = {
  desktop: {
    groundChannels: 4,
    roadsMinZoom: 15,
    horizonSize: 25,
    horizonContext: true,
    noiseAnisotropy: 8,
  },
  mobile: {
    groundChannels: 2,
    roadsMinZoom: 99,
    horizonSize: 13,
    horizonContext: true,
    noiseAnisotropy: 2,
  },
};

/** Zoom of the coarse terrain the horizon reads around every finer tile. */
export const HORIZON_CONTEXT_ZOOM = 10;

/** Bytes of a square 8-bit texture with a full mip chain. */
export function mippedBytes(size: number, channels: number): number {
  let bytes = 0;
  for (let s = size; s >= 1; s >>= 1) bytes += s * s * channels;
  return bytes;
}

/** GPU bytes the ground adds to one tile: the ground texture (mipmapped) and the horizon. */
export function groundBytes(groundSize: number, s: GroundSettings): number {
  return mippedBytes(groundSize, s.groundChannels) + s.horizonSize * 2 * s.horizonSize * 4;
}
