import type { Camera, Object3D, Vector3 } from 'three/webgpu';
import type { LocalFrame } from '@geo';

/** Which budget a layer works with; every layer keeps its own presets per device class. */
export type DeviceClass = 'desktop' | 'mobile';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/**
 * The light and the time of year, as the things on the ground need them. The app sets these
 * from the sky and the flight plan (World.setConditions); the world never asks the sky itself.
 */
export interface WorldConditions {
  /** 0 by day .. 1 at night: how much artificial light is on. */
  night: number;
  /**
   * The sky's exposure. Everything the sky lights is already multiplied by it; anything that
   * shines by itself (lamps, lit windows) has to multiply its emission by this too, or it is
   * blinding at night and invisible by day.
   */
  exposure: number;
  season: Season;
  /** Snow lies above this height, metres above sea level. */
  snowLine: number;
  /** Unit vector towards the sun (or the moon at night) in render space. */
  lightDirection: Vector3;
  /** Seconds since the app started, for anything that moves by itself (flashing lights). */
  time: number;
  /**
   * The wind near the ground: the true direction it blows from in degrees (270 = from the
   * west) and its speed in m/s.
   */
  wind: { fromDeg: number; speed: number };
}

/** What a layer gets every frame. */
export interface LayerContext {
  camera: Camera;
  /** The current render frame (x east, y up, z south; its origin follows the camera). */
  frame: LocalFrame;
  /** Where the camera is: degrees, and metres above the ellipsoid. */
  view: { lon: number; lat: number; h: number };
  conditions: WorldConditions;
  /** Seconds since the last frame. */
  dt: number;
  /** Drawing buffer height in pixels (for sizes measured on screen). */
  screenHeight: number;
  /**
   * Height of the terrain above the ellipsoid at lon/lat, or undefined while that place is
   * not loaded. Coarse terrain far from the camera can be metres off: things placed on it
   * should be re-seated when `groundRevision` changes.
   */
  groundHeight(lon: number, lat: number): number | undefined;
  /** Counts up whenever terrain tiles arrive or leave (heights may have changed). */
  groundRevision: number;
  /**
   * A loading screen covers the view: smooth frames do not matter, being done soon does.
   * Per-frame budgets (uploads, ground work) can be many times larger.
   */
  hurry: boolean;
}

/**
 * Something that stands on the terrain and streams by itself: trees, buildings, airports.
 * The world owns the layers, adds their `object` next to the terrain and drives them.
 */
export interface WorldLayer {
  readonly object: Object3D;
  /** Per frame, after the terrain has been updated. */
  update(ctx: LayerContext): void;
  /** The render frame moved (floating origin): re-place everything without a visible jump. */
  setFrame(frame: LocalFrame): void;
  /** True while something for the current view is still loading (keeps the loading screen up). */
  readonly loading: boolean;
  /** Credits of the data shown. */
  readonly attribution: string[];
  dispose(): void;
}

/** A layer that shows nothing; the starting point of every layer before it is built. */
export function emptyLayer(object: Object3D): WorldLayer {
  return {
    object,
    update() {},
    setFrame() {},
    loading: false,
    attribution: [],
    dispose() {},
  };
}
