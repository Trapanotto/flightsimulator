import {
  BloomEffect,
  type Effect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import {
  ACESFilmicToneMapping,
  type Camera,
  HalfFloatType,
  NoToneMapping,
  type Scene,
  type WebGLRenderer,
} from 'three';
import type { Quality } from '../core/settings';

/**
 * Post-processing chain (one merged effect pass): bloom for the sun, lights and reflections,
 * SMAA anti-aliasing, ACES tone mapping and a soft vignette. On the lowest preset it is skipped
 * and the renderer tone-maps directly.
 */
export class PostFX {
  private composer?: EffectComposer;
  enabled = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {}

  configure(q: Quality) {
    this.composer?.dispose();
    this.composer = undefined;
    this.enabled = q.bloom || q.smaa;
    if (!this.enabled) {
      this.renderer.toneMapping = ACESFilmicToneMapping;
      return;
    }
    // The tone mapping effect takes over; the scene renders in HDR (half float).
    this.renderer.toneMapping = NoToneMapping;
    const composer = new EffectComposer(this.renderer, { frameBufferType: HalfFloatType });
    composer.addPass(new RenderPass(this.scene, this.camera));
    const effects: Effect[] = [];
    if (q.bloom) {
      effects.push(
        new BloomEffect({
          mipmapBlur: true,
          intensity: 0.35,
          luminanceThreshold: 1.7,
          luminanceSmoothing: 0.35,
          radius: 0.6,
        }),
      );
    }
    // ACES: more contrast and colour than AgX, matches the look of the earlier phases.
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    effects.push(new VignetteEffect({ offset: 0.35, darkness: 0.42 }));
    if (q.smaa) effects.push(new SMAAEffect());
    composer.addPass(new EffectPass(this.camera, ...effects));
    this.composer = composer;
  }

  setSize(width: number, height: number) {
    this.composer?.setSize(width, height, false);
  }

  render(dt: number) {
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
