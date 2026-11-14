import type { AudioEngine } from './AudioEngine';
import { applyEnvelope, glide, noiseLoop, silentGain } from './graph';
import type { EnvelopePoint } from './keying';
import type { RadioKeying, Speaker } from './RadioVoice';

/**
 * Noise bursts of a VHF receiver, relative to the key event, as gain breakpoints. When a
 * station keys up the squelch opens with a short pop; when its carrier drops the receiver
 * hisses for a moment before the squelch closes again (the tail). Your own transmission has
 * neither: only the click of the push-to-talk switch.
 */
export function squelchBurst(speaker: Speaker, edge: 'on' | 'off'): EnvelopePoint[] {
  if (speaker === 'pilot')
    return [
      { time: 0, value: 0 },
      { time: 0.001, value: 0.15 },
      { time: 0.008, value: 0 },
    ];
  if (edge === 'on')
    return [
      { time: 0, value: 0 },
      { time: 0.001, value: 0.5 },
      { time: 0.03, value: 0 },
    ];
  return [
    { time: 0, value: 0 },
    { time: 0.003, value: 0.45 },
    { time: 0.17, value: 0.45 },
    { time: 0.19, value: 0 },
  ];
}

/** The static under a transmission: a carrier quiets the receiver, it does not silence it. */
export function staticLevel(speaker: Speaker): number {
  return speaker === 'atc' ? 0.05 : 0.012;
}

/**
 * The receiver around the synthesised speech, in Web Audio: key pop, static, squelch tail,
 * and the engine ducked a little while someone talks. Pass it to RadioVoice as its keying.
 */
export class RadioSquelch implements RadioKeying {
  private staticGain?: GainNode;
  private burstGain?: GainNode;
  private source?: AudioBufferSourceNode;
  /** End of the last burst written: a new one never starts inside it. */
  private burstFree = 0;
  private ducked = false;

  constructor(private readonly audio: AudioEngine) {}

  /** Builds the graph. Call after the first user gesture, with the other sounds. */
  start() {
    if (this.source) return;
    const ctx = this.audio.audio;
    // An airband receiver passes roughly 300 Hz to 3 kHz.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 350;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2800;
    this.source = noiseLoop(ctx, 1, 0.7);
    this.source.connect(hp).connect(lp);
    this.staticGain = silentGain(ctx, this.audio.output);
    this.burstGain = silentGain(ctx, this.audio.output);
    lp.connect(this.staticGain);
    lp.connect(this.burstGain);
  }

  keyOn(speaker: Speaker) {
    this.burst(speaker, 'on');
    if (this.staticGain) glide(this.staticGain.gain, staticLevel(speaker), this.now(), 0.02);
    if (!this.ducked) {
      this.ducked = true;
      this.audio.duck(true);
    }
  }

  keyOff(speaker: Speaker) {
    this.burst(speaker, 'off');
    if (this.staticGain) glide(this.staticGain.gain, 0, this.now(), 0.01);
    if (this.ducked) {
      this.ducked = false;
      this.audio.duck(false);
    }
  }

  private now() {
    return this.audio.audio.currentTime;
  }

  private burst(speaker: Speaker, edge: 'on' | 'off') {
    if (!this.burstGain) return;
    const t0 = Math.max(this.now() + 0.005, this.burstFree);
    const points = squelchBurst(speaker, edge).map((p) => ({ time: t0 + p.time, value: p.value }));
    applyEnvelope(this.burstGain.gain, points);
    this.burstFree = points[points.length - 1]!.time + 0.001;
  }

  dispose() {
    this.source?.stop();
    this.source = undefined;
    this.staticGain?.disconnect();
    this.burstGain?.disconnect();
  }
}
