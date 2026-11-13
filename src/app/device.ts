import type { WorldQuality } from '@world';

export type DeviceClass = 'desktop' | 'mobile';

/**
 * Budget of a device class. Every graphics feature reads its limits from here, so each has
 * a light variant from the start (docs/KONZEPT.md, 3.3).
 */
export interface DeviceProfile {
  device: DeviceClass;
  /** The canvas renders at the device resolution up to this pixel ratio. */
  maxPixelRatio: number;
  /** Multisampling on the canvas (until temporal antialiasing arrives in phase 1). */
  antialias: boolean;
  /** Shadow map size in texels, 0 = no shadows. */
  shadowMapSize: number;
  world: WorldQuality;
}

export const PROFILES: Record<DeviceClass, DeviceProfile> = {
  desktop: {
    device: 'desktop',
    maxPixelRatio: 2,
    antialias: true,
    shadowMapSize: 2048,
    world: { viewDistance: 150_000 },
  },
  mobile: {
    device: 'mobile',
    maxPixelRatio: 1.5,
    antialias: true,
    shadowMapSize: 1024,
    world: { viewDistance: 80_000 },
  },
};

/** Phones and tablets: touch as the main pointer, or a mobile user agent. */
export function detectDevice(): DeviceClass {
  const forced = new URLSearchParams(location.search).get('device');
  if (forced === 'mobile' || forced === 'desktop') return forced;
  const coarse = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
  const ua = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  // iPadOS reports a desktop user agent; it has touch points and no fine pointer.
  return coarse || ua ? 'mobile' : 'desktop';
}
