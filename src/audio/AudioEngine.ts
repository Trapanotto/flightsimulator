/**
 * Owner of the audio context and the master volume. Sound sources (radio, nav tones, cockpit)
 * connect to `output`; the aircraft's own noise connects to `ambience`, which the radio ducks
 * while someone talks. Browsers only start audio after a user gesture: call `resume()` from
 * the first click or tap.
 */
export class AudioEngine {
  private master?: GainNode;
  private ambienceGain?: GainNode;
  private meter?: AnalyserNode;
  private samples?: Float32Array<ArrayBuffer>;
  private volume = 0.7;
  private muted = false;
  private ducks = 0;
  private readonly listeners: ((volume: number, muted: boolean) => void)[] = [];

  /**
   * `context`: a context to render into instead of the speakers (an OfflineAudioContext in
   * the browser tests). Without it, an AudioContext is created on first use.
   */
  constructor(private context?: BaseAudioContext) {
    if (context) this.build(context);
  }

  /** The context, created on first use. */
  get audio(): BaseAudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.build(this.context);
    }
    return this.context;
  }

  private build(ctx: BaseAudioContext) {
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.ambienceGain = ctx.createGain();
    this.ambienceGain.connect(this.master);
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 1024;
    this.samples = new Float32Array(this.meter.fftSize);
    this.master.connect(this.meter).connect(ctx.destination);
    this.apply();
  }

  /** Where sound sources connect. */
  get output(): AudioNode {
    void this.audio;
    return this.master!;
  }

  /** Engine, wind and tyres connect here: lowered while a radio transmission is heard. */
  get ambience(): AudioNode {
    void this.audio;
    return this.ambienceGain!;
  }

  async resume() {
    const ctx = this.audio;
    if (typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
      if (ctx.state === 'suspended') await ctx.resume();
    }
  }

  /** Loudness of what is being played right now (RMS, 0 = silence). For meters and tests. */
  level(): number {
    if (!this.meter || !this.samples) return 0;
    this.meter.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const v of this.samples) sum += v * v;
    return Math.sqrt(sum / this.samples.length);
  }

  /** 0..1 */
  setVolume(volume: number) {
    const v = Math.min(1, Math.max(0, volume));
    if (v === this.volume) return;
    this.volume = v;
    this.apply();
  }

  setMuted(muted: boolean) {
    if (muted === this.muted) return;
    this.muted = muted;
    this.apply();
  }

  /**
   * Told now and on every change of volume or mute: for what cannot pass the master gain
   * (speech synthesis has a volume of its own).
   */
  onVolumeChange(listener: (volume: number, muted: boolean) => void) {
    this.listeners.push(listener);
    listener(this.volume, this.muted);
  }

  /** Lowers the ambience while `on`; calls nest (each on needs its off). */
  duck(on: boolean) {
    this.ducks = Math.max(0, this.ducks + (on ? 1 : -1));
    if (!this.ambienceGain || !this.context) return;
    // Only slightly: the engine stays there, as in a real headset.
    this.ambienceGain.gain.setTargetAtTime(
      this.ducks > 0 ? 0.6 : 1,
      this.context.currentTime,
      on ? 0.06 : 0.25,
    );
  }

  private apply() {
    for (const l of this.listeners) l(this.volume, this.muted);
    if (!this.master || !this.context) return;
    // A short ramp instead of a jump: no click.
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.context.currentTime, 0.03);
  }

  dispose() {
    if (typeof AudioContext !== 'undefined' && this.context instanceof AudioContext)
      void this.context.close();
    this.context = undefined;
    this.master = undefined;
    this.ambienceGain = undefined;
  }
}
