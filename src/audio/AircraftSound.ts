import type { Telemetry } from '@sim';
import type { AudioEngine } from './AudioEngine';
import { engineLevel, groundRollLevel, windLevel } from './levels';

/** How an aircraft type sounds. */
export interface SoundProfile {
  engine: 'piston' | 'turboprop' | 'jet';
  cylinders: number;
  blades: number;
  /** Speed at which the wind noise is at full level, m/s. */
  windFullSpeed: number;
}

export const C172_SOUND: SoundProfile = {
  engine: 'piston',
  cylinders: 4,
  blades: 2,
  windFullSpeed: 80,
};

/** White noise, a couple of seconds, looped: the raw material for wind and tyre rumble. */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // A fixed seed: the sound is the same on every run.
  let seed = 1234567;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 16807) % 2147483647;
    data[i] = (seed / 2147483647) * 2 - 1;
  }
  return buffer;
}

/**
 * Everything one aircraft makes heard: the engine (synthesised from its firing pulses and
 * the propeller, see engine-worklet.js), the wind over the airframe, the tyres on the ground
 * and the stall warning horn. Driven by the telemetry once per frame.
 */
export class AircraftSound {
  private engineNode?: AudioWorkletNode;
  private engineGain?: GainNode;
  private windGain?: GainNode;
  private windFilter?: BiquadFilterNode;
  private rollGain?: GainNode;
  private hornGain?: GainNode;
  private cabin?: BiquadFilterNode;
  private bus?: GainNode;
  private sources: AudioScheduledSourceNode[] = [];
  private started = false;
  private failed = false;

  constructor(
    private readonly audio: AudioEngine,
    private readonly profile: SoundProfile = C172_SOUND,
    /** Where engine-worklet.js is served from. */
    private readonly workletUrl = `${import.meta.env.BASE_URL}assets/audio/engine-worklet.js`,
  ) {}

  /**
   * Builds the sound graph. Call after the first user gesture (browsers keep audio suspended
   * until then). Safe to call again.
   */
  async start(): Promise<void> {
    if (this.started || this.failed) return;
    this.started = true;
    const ctx = this.audio.audio;
    try {
      await ctx.audioWorklet.addModule(this.workletUrl);
    } catch (err) {
      // No worklet (very old browser, or the file is missing): fly on without sound.
      console.warn('engine sound unavailable', err);
      this.failed = true;
      return;
    }
    // Everything passes one filter: inside the cabin the highs are muffled.
    this.cabin = ctx.createBiquadFilter();
    this.cabin.type = 'lowpass';
    this.cabin.frequency.value = 18_000;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.cabin.connect(this.bus).connect(this.audio.output);

    this.engineNode = new AudioWorkletNode(ctx, 'engine-sound', { outputChannelCount: [1] });
    this.engineNode.port.postMessage({
      kind: this.profile.engine,
      blades: this.profile.blades,
      cylinders: this.profile.cylinders,
    });
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineNode.connect(this.engineGain).connect(this.cabin);

    const noise = noiseBuffer(ctx);
    const loop = (rate: number) => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.playbackRate.value = rate;
      src.start();
      this.sources.push(src);
      return src;
    };
    // Wind: band-passed noise that rises in level and pitch with the airspeed.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    loop(1).connect(this.windFilter).connect(this.windGain).connect(this.cabin);

    // Tyres: low rumble while rolling.
    const rollFilter = ctx.createBiquadFilter();
    rollFilter.type = 'lowpass';
    rollFilter.frequency.value = 140;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    loop(0.5).connect(rollFilter).connect(this.rollGain).connect(this.cabin);

    // Stall horn: the reed of the Cessna, a steady nasal tone around 2.7 kHz.
    const horn = ctx.createOscillator();
    horn.type = 'sawtooth';
    horn.frequency.value = 2700;
    const hornFilter = ctx.createBiquadFilter();
    hornFilter.type = 'bandpass';
    hornFilter.frequency.value = 2900;
    hornFilter.Q.value = 6;
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    horn.connect(hornFilter).connect(this.hornGain).connect(this.audio.output);
    horn.start();
    this.sources.push(horn);
  }

  /**
   * Per frame. `inside` = the listener sits in the cockpit; `active` = a flight is running
   * and not paused (otherwise everything fades out).
   */
  update(telemetry: Telemetry | undefined, inside: boolean, active: boolean) {
    if (!this.engineNode || !this.bus) return;
    const ctx = this.audio.audio;
    const now = ctx.currentTime;
    const set = (param: AudioParam, value: number, tau = 0.08) =>
      param.setTargetAtTime(value, now, tau);
    set(this.bus.gain, active && telemetry ? 1 : 0, 0.15);
    if (!telemetry) return;

    const engine = telemetry.engines[0];
    const rpm = engine?.running || (engine?.rpm ?? 0) > 60 ? (engine?.rpm ?? 0) : 0;
    const p = this.engineNode.parameters;
    set(p.get('rps')!, rpm / 60, 0.05);
    set(p.get('load')!, Math.min(1, Math.max(0.2, engine?.power ?? 0)), 0.1);
    set(this.engineGain!.gain, engineLevel(rpm, inside), 0.1);

    const wind = windLevel(telemetry.tas, this.profile.windFullSpeed, inside);
    set(this.windGain!.gain, wind);
    set(this.windFilter!.frequency, 300 + 14 * telemetry.tas);

    set(this.rollGain!.gain, groundRollLevel(telemetry.onGround, telemetry.groundSpeed, inside));
    set(
      this.hornGain!.gain,
      telemetry.stallWarning && !telemetry.crashed ? (inside ? 0.09 : 0.03) : 0,
      0.02,
    );
    // In the cabin the highs are damped; outside everything is open.
    set(this.cabin!.frequency, inside ? 2600 : 18_000, 0.2);
  }

  dispose() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources = [];
    this.engineNode?.disconnect();
    this.bus?.disconnect();
    this.hornGain?.disconnect();
    this.engineNode = undefined;
    this.started = false;
  }
}
