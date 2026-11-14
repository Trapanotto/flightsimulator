import type { AvionicsTelemetry } from '@sim';
import type { AudioEngine } from './AudioEngine';
import { glide, silentGain, applyEnvelope } from './graph';
import {
  IDENT_HZ,
  MARKERS,
  PatternKeyer,
  identPattern,
  keyedEnvelope,
  type MarkerId,
} from './keying';

/** What the audio panel lets through. */
export interface NavAudioInput {
  /**
   * The ident to key in Morse, or ''/undefined for none: the app picks it from the receiver
   * whose ident audio is switched on (e.g. `avionics.nav1.ident` while NAV 1 is selected).
   */
  ident?: string;
  /** The marker beacon audio is switched on (default true). */
  markers?: boolean;
  /** A flight is running and not paused; otherwise the tones fade out. */
  active: boolean;
}

/** Keys this far ahead of the audio clock: longer than a slow frame, short enough to stop. */
const LOOKAHEAD = 0.3;
const IDENT_LEVEL = 0.06;
const MARKER_LEVEL = 0.08;
const MARKER_IDS: readonly MarkerId[] = ['outer', 'middle', 'inner'];

/**
 * Navigation audio as heard in the headset: the Morse ident of a tuned station (1020 Hz) and
 * the marker beacons of an ILS (400, 1300 and 3000 Hz with their keying). Each tone is one
 * oscillator that runs all the time behind a gain keyed ahead of time on the audio clock, so
 * nothing is created per frame and the rhythm does not depend on the frame rate.
 */
export class NavAudio {
  private bus?: GainNode;
  private identGain?: GainNode;
  private readonly markerGain: Partial<Record<MarkerId, GainNode>> = {};
  private readonly oscillators: OscillatorNode[] = [];
  private readonly identKeyer = new PatternKeyer();
  private readonly markerKeyer: Record<MarkerId, PatternKeyer> = {
    outer: new PatternKeyer(),
    middle: new PatternKeyer(),
    inner: new PatternKeyer(),
  };
  private ident = '';

  constructor(private readonly audio: AudioEngine) {}

  /** Builds the graph. Call after the first user gesture, with the other sounds. */
  start() {
    if (this.bus) return;
    const ctx = this.audio.audio;
    this.bus = silentGain(ctx, this.audio.output);
    const tone = (hz: number) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = hz;
      const g = silentGain(ctx, this.bus);
      osc.connect(g);
      osc.start();
      this.oscillators.push(osc);
      return g;
    };
    this.identGain = tone(IDENT_HZ);
    for (const id of MARKER_IDS) this.markerGain[id] = tone(MARKERS[id].hz);
  }

  /** Per frame. `avionics` undefined or unpowered = silence. */
  update(avionics: AvionicsTelemetry | undefined, input: NavAudioInput) {
    if (!this.bus || !this.identGain) return;
    const ctx = this.audio.audio;
    const now = ctx.currentTime;
    const on = input.active && avionics?.powered === true;
    glide(this.bus.gain, on ? 1 : 0, now, 0.05);

    // The ident: a new station starts keying after the current letters have ended.
    const ident = on ? (input.ident ?? '').trim() : '';
    if (ident !== this.ident) {
      this.ident = ident;
      this.identKeyer.stop();
      if (ident)
        this.identKeyer.start(
          identPattern(ident),
          Math.max(now + 0.05, this.identKeyer.lastEnd + 0.5),
        );
    }
    this.key(this.identKeyer, this.identGain.gain, now, IDENT_LEVEL);

    for (const id of MARKER_IDS) {
      const keyer = this.markerKeyer[id];
      const heard = on && input.markers !== false && avionics!.markers[id];
      if (heard && !keyer.running)
        keyer.start(MARKERS[id], Math.max(now + 0.02, keyer.lastEnd + 0.05));
      else if (!heard && keyer.running) keyer.stop();
      this.key(keyer, this.markerGain[id]!.gain, now, MARKER_LEVEL);
    }
  }

  private key(keyer: PatternKeyer, gain: AudioParam, now: number, level: number) {
    const tones = keyer.take(now, now + LOOKAHEAD);
    if (tones.length) applyEnvelope(gain, keyedEnvelope(tones, level));
  }

  dispose() {
    for (const o of this.oscillators) o.stop();
    this.oscillators.length = 0;
    this.bus?.disconnect();
    this.bus = undefined;
  }
}
