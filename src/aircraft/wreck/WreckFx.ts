/**
 * Fire, smoke and the light of a burning wreck. Created once (with the app) and kept in the
 * scene from the start: a light added at the moment of a crash would change the lighting of
 * every material (all shaders rebuilt: a stall right at the impact), and the particle shaders
 * are built ahead with the rest of the scene (renderer.compileAsync). Idle, it draws nothing.
 */
import { type DataTexture, Group, PointLight } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { fireGain } from './breakup';
import { ParticleSystem, puffAtlas } from './particles';

export interface WreckFxOptions {
  /** 'low' for phones: fewer particles and no fire light (it would cost every lit pixel). */
  quality?: 'high' | 'low';
}

export class WreckFx {
  readonly object = new Group();
  readonly fire: ParticleSystem;
  readonly smoke: ParticleSystem;
  /** The fire's light on the ground and the smoke; null on quality 'low'. */
  readonly light: PointLight | null;
  /** Share of the full particle emission this device affords (1 desktop). */
  readonly budget: number;
  /** Multiplies the fire's emission and light: see fireGain. */
  readonly gain = uniform(1);
  /** The sky's exposure last given to setExposure. */
  exposure = 4.2;
  private readonly atlas: DataTexture;

  constructor(options: WreckFxOptions = {}) {
    const low = options.quality === 'low';
    this.object.name = 'WreckFx';
    this.budget = low ? 0.4 : 1;
    this.atlas = puffAtlas();
    this.fire = new ParticleSystem(low ? 360 : 1000, 'fire', this.atlas, this.gain);
    this.smoke = new ParticleSystem(low ? 260 : 800, 'smoke', this.atlas, this.gain);
    this.object.add(this.smoke.mesh, this.fire.mesh, this.smoke.hazeMesh, this.fire.hazeMesh);
    if (low) this.light = null;
    else {
      this.light = new PointLight(0xff9a3c, 0, 0, 2);
      this.light.castShadow = false;
      this.object.add(this.light);
    }
  }

  /** The sky's exposure (call every frame, like AircraftVisual.setExposure). */
  setExposure(exposure: number) {
    this.exposure = exposure;
    this.gain.value = fireGain(exposure);
  }

  /** Clears every particle and puts the light out. */
  reset() {
    this.fire.clear();
    this.smoke.clear();
    if (this.light) this.light.intensity = 0;
  }

  dispose() {
    this.object.removeFromParent();
    this.fire.dispose();
    this.smoke.dispose();
    this.atlas.dispose();
    this.light?.dispose();
  }
}
