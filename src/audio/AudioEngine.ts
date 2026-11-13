/**
 * Owner of the audio context and the master volume. Sound sources (engines, wind, radio)
 * connect to `output`. Browsers only start audio after a user gesture: call `resume()` from
 * the first click or tap.
 */
export class AudioEngine {
  private context?: AudioContext;
  private master?: GainNode;
  private volume = 0.7;
  private muted = false;

  /** The context, created on first use. */
  get audio(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
      this.apply();
    }
    return this.context;
  }

  /** Where sound sources connect. */
  get output(): AudioNode {
    void this.audio;
    return this.master!;
  }

  async resume() {
    if (this.audio.state === 'suspended') await this.audio.resume();
  }

  /** 0..1 */
  setVolume(volume: number) {
    this.volume = Math.min(1, Math.max(0, volume));
    this.apply();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.apply();
  }

  private apply() {
    if (!this.master || !this.context) return;
    // A short ramp instead of a jump: no click.
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.context.currentTime, 0.03);
  }

  dispose() {
    void this.context?.close();
    this.context = undefined;
    this.master = undefined;
  }
}
