import { signal } from '@preact/signals';

/**
 * What the app tells the interface. The app writes these signals, components read them;
 * the interface never reaches into the renderer or the simulation.
 */
export const status = {
  /** 'WebGPU' or 'WebGL 2' (fallback), empty until the renderer is up. */
  renderer: signal(''),
  device: signal<'desktop' | 'mobile'>('desktop'),
  fps: signal(0),
  /** Drawing buffer size in pixels. */
  resolution: signal<[number, number]>([0, 0]),
  /** Simulation rate in Hz. */
  simHz: signal(0),
  version: signal(''),
};
