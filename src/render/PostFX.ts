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
  HalfFloatType,
  NoToneMapping,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import type { Quality } from '../core/settings';
import type { AtmosphereUniforms } from './Atmosphere';
import { CloudCompositeEffect, CloudMarchPass } from './VolumetricClouds';

/**
 * Post-processing chain (one merged effect pass): bloom for the sun, lights and reflections,
 * SMAA anti-aliasing, ACES tone mapping and a soft vignette. On the lowest preset it is skipped
 * and the renderer tone-maps directly.
 */
export class PostFX {
  private composer?: EffectComposer;
  enabled = false;
  /** Volumetric clouds are running (the flat cloud layers can go). */
  volumetric = false;
  private march?: CloudMarchPass;

  /** Cloud transmittance at a screen position (1 = no cloud), from the volumetric clouds. */
  cloudTransmittanceAt(u: number, v: number): number {
    return this.march ? this.march.transmittanceAt(this.renderer, u, v) : 1;
  }

  /** The view jumped (teleport, origin shift): no cloud history to blend with. */
  resetHistory() {
    this.march?.resetHistory();
  }

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: PerspectiveCamera,
    private readonly atmosphere: AtmosphereUniforms,
  ) {}

  configure(q: Quality) {
    this.composer?.dispose();
    this.composer = undefined;
    this.march = undefined;
    // The volumetric clouds need the chain (scene depth, HDR), also on the lowest level.
    this.volumetric = q.volumetricClouds > 0;
    this.enabled = q.bloom || q.smaa || this.volumetric;
    if (!this.enabled) {
      this.renderer.toneMapping = ACESFilmicToneMapping;
      return;
    }
    // The tone mapping effect takes over; the scene renders in HDR (half float).
    this.renderer.toneMapping = NoToneMapping;
    const composer = new EffectComposer(this.renderer, { frameBufferType: HalfFloatType });
    composer.addPass(new RenderPass(this.scene, this.camera));
    const effects: Effect[] = [];
    if (this.volumetric) {
      const a = this.atmosphere;
      const march = new CloudMarchPass(
        this.camera,
        a,
        { base: a.uCloudBase, top: a.uCloudTop },
        0.5,
        q.volumetricClouds,
        this.renderer.capabilities.reversedDepthBuffer
          ? 'reversed'
          : this.renderer.capabilities.logarithmicDepthBuffer
            ? 'log'
            : 'standard',
      );
      composer.addPass(march);
      const composite = new CloudCompositeEffect(march.target.texture);
      march.onResize = (w, h) => composite.setTexel(w, h);
      march.onOutput = (t) => composite.setClouds(t);
      this.march = march;
      effects.push(composite);
    }
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
