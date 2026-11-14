import type { Surface, Telemetry } from '@sim';
import type { AudioEngine } from './AudioEngine';
import { applyEnvelope, glide, impactBuffer, noiseLoop, playOnce, silentGain } from './graph';
import type { EnvelopePoint } from './keying';
import {
  COCKPIT_LEVEL,
  brakeSquealLevel,
  engineLevel,
  engineMode,
  firingShare,
  groundRollLevel,
  surfaceSound,
  touchdownLevel,
  windLevel,
} from './levels';

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

/** What the sound needs beyond the telemetry; all optional, the defaults are harmless. */
export interface AircraftSoundInput {
  /** The starter of engine 1 is engaged (`controls.starter[0]`). */
  starter?: boolean;
  /** Surface under the wheels (`env.ground(position).surface`); asphalt if not given. */
  surface?: Surface;
  /** Wheel brakes 0..1, the firmer of the two. */
  brake?: number;
}

/**
 * Everything one aircraft makes heard: the engine (synthesised from its firing pulses and
 * the propeller, see engine-worklet.js) through starting, catching, running and windmilling,
 * the wind over the airframe, the tyres on the ground (rumble by surface, chirp at
 * touch-down, brakes) and the stall warning horn. Driven by the telemetry once per frame.
 */
export class AircraftSound {
  private engineNode?: AudioWorkletNode;
  private engineGain?: GainNode;
  private windGain?: GainNode;
  private windFilter?: BiquadFilterNode;
  private rollGain?: GainNode;
  private rollFilter?: BiquadFilterNode;
  private crunchGain?: GainNode;
  private crunchDepth?: GainNode;
  private crunchFilter?: BiquadFilterNode;
  private chirpGain?: GainNode;
  private thumpGain?: GainNode;
  private squealGain?: GainNode;
  private hornGain?: GainNode;
  private cabin?: BiquadFilterNode;
  private bus?: GainNode;
  private solenoid?: AudioBuffer;
  private sources: AudioScheduledSourceNode[] = [];
  private started = false;
  private failed = false;
  // Memory between frames, to hear edges: touch-down, the engine catching, the starter.
  private lastTime = -1;
  private wasOnGround = true;
  private sink = 0;
  private wasRunning = false;
  private sinceCatch = 99;
  private wasStarter = false;
  private impactFree = 0;

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
    this.bus = silentGain(ctx);
    // The ambience bus: the radio ducks it.
    this.cabin.connect(this.bus).connect(this.audio.ambience);

    this.engineNode = new AudioWorkletNode(ctx, 'engine-sound', { outputChannelCount: [1] });
    this.engineNode.port.postMessage({
      kind: this.profile.engine,
      blades: this.profile.blades,
      cylinders: this.profile.cylinders,
    });
    this.engineGain = silentGain(ctx);
    this.engineNode.connect(this.engineGain).connect(this.cabin);

    const loop = (rate: number, offset: number) => {
      const src = noiseLoop(ctx, rate, offset);
      this.sources.push(src);
      return src;
    };
    const filter = (type: BiquadFilterType, hz: number, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = hz;
      f.Q.value = q;
      return f;
    };
    const fast = loop(1, 0);
    const slow = loop(0.5, 0.9);

    // Wind: band-passed noise that rises in level and pitch with the airspeed.
    this.windFilter = filter('bandpass', 300, 0.6);
    this.windGain = silentGain(ctx, this.cabin);
    fast.connect(this.windFilter).connect(this.windGain);

    // Tyres: low rumble while rolling, its colour set by the surface.
    this.rollFilter = filter('lowpass', 140);
    this.rollGain = silentGain(ctx, this.cabin);
    slow.connect(this.rollFilter).connect(this.rollGain);
    // Loose surfaces: a higher band (grass swish, gravel crunch), pulsing as the tyre rolls
    // over clumps: a slow oscillator adds to its gain.
    this.crunchFilter = filter('bandpass', 1400, 1.2);
    this.crunchGain = silentGain(ctx, this.cabin);
    fast.connect(this.crunchFilter).connect(this.crunchGain);
    const lumps = ctx.createOscillator();
    lumps.frequency.value = 5.3;
    this.crunchDepth = silentGain(ctx);
    lumps.connect(this.crunchDepth).connect(this.crunchGain.gain);
    lumps.start();
    this.sources.push(lumps);

    // Touch-down: the chirp of the tyres spinning up, and the thump of the gear.
    this.chirpGain = silentGain(ctx, this.cabin);
    fast.connect(filter('bandpass', 2300, 3)).connect(this.chirpGain);
    this.thumpGain = silentGain(ctx, this.cabin);
    slow.connect(filter('lowpass', 90)).connect(this.thumpGain);

    // Brakes: a faint squeal, a reedy tone that wavers.
    const squeal = ctx.createOscillator();
    squeal.type = 'triangle';
    squeal.frequency.value = 1150;
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 5;
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 14;
    wobble.connect(wobbleDepth).connect(squeal.frequency);
    this.squealGain = silentGain(ctx, this.cabin);
    squeal.connect(filter('bandpass', 1150, 4)).connect(this.squealGain);
    squeal.start();
    wobble.start();
    this.sources.push(squeal, wobble);

    // Stall horn: the reed of the Cessna, a steady nasal tone around 2.7 kHz.
    const horn = ctx.createOscillator();
    horn.type = 'sawtooth';
    horn.frequency.value = 2700;
    this.hornGain = silentGain(ctx, this.audio.output);
    horn.connect(filter('bandpass', 2900, 6)).connect(this.hornGain);
    horn.start();
    this.sources.push(horn);

    // The starter solenoid: a dull clack when the key reaches START.
    this.solenoid = impactBuffer(
      ctx,
      [
        { hz: 180, decay: 0.03, gain: 1 },
        { hz: 610, decay: 0.012, gain: 0.5 },
      ],
      0.08,
      0.5,
      0.003,
    );
  }

  /**
   * Per frame. `inside` = the listener sits in the cockpit; `active` = a flight is running
   * and not paused (otherwise everything fades out).
   */
  update(
    telemetry: Telemetry | undefined,
    inside: boolean,
    active: boolean,
    input: AircraftSoundInput = {},
  ) {
    if (!this.engineNode || !this.bus) return;
    const ctx = this.audio.audio;
    const now = ctx.currentTime;
    const set = (param: AudioParam, value: number, tau = 0.08) => glide(param, value, now, tau);
    set(this.bus.gain, active && telemetry ? 1 : 0, 0.15);
    if (!telemetry) return;

    // A reset (time ran backwards) starts a new flight: forget the edges of the last one.
    const fresh = this.lastTime < 0 || telemetry.time < this.lastTime;
    const dt = fresh ? 0 : telemetry.time - this.lastTime;
    this.lastTime = telemetry.time;

    const engine = telemetry.engines[0];
    const running = engine?.running ?? false;
    const rpm = Math.max(0, engine?.rpm ?? 0);
    const starter = input.starter ?? false;
    if (running && !this.wasRunning) this.sinceCatch = 0;
    else this.sinceCatch += dt;
    if (fresh && running) this.sinceCatch = 99;
    this.wasRunning = running;
    const mode = engineMode(running, rpm, starter, this.sinceCatch);

    const p = this.engineNode.parameters;
    set(p.get('rps')!, rpm / 60, 0.05);
    set(p.get('load')!, Math.min(1, Math.max(0.2, engine?.power ?? 0)), 0.1);
    set(p.get('firing')!, firingShare(mode, this.sinceCatch), 0.03);
    set(p.get('starter')!, starter ? 1 : 0, 0.03);
    set(this.engineGain!.gain, engineLevel(rpm, inside), 0.1);
    if (starter && !this.wasStarter && !fresh && active)
      playOnce(ctx, this.solenoid!, this.cabin!, COCKPIT_LEVEL.starterClick * (inside ? 1 : 0.4));
    this.wasStarter = starter;

    const wind = windLevel(telemetry.tas, this.profile.windFullSpeed, inside);
    set(this.windGain!.gain, wind);
    set(this.windFilter!.frequency, 300 + 14 * telemetry.tas);

    const surface = surfaceSound(input.surface);
    const roll = groundRollLevel(telemetry.onGround, telemetry.groundSpeed, inside);
    set(this.rollGain!.gain, roll * surface.rumble);
    set(this.rollFilter!.frequency, surface.rumbleHz, 0.2);
    set(this.crunchFilter!.frequency, surface.crunchHz, 0.2);
    set(this.crunchGain!.gain, roll * surface.crunch);
    set(this.crunchDepth!.gain, roll * surface.crunch * 0.6);
    set(
      this.squealGain!.gain,
      brakeSquealLevel(input.brake ?? 0, telemetry.groundSpeed, input.surface, inside),
      0.12,
    );

    if (!telemetry.onGround) this.sink = -telemetry.verticalSpeed;
    if (telemetry.onGround && !this.wasOnGround && !fresh && active && !telemetry.crashed)
      this.touchdown(this.sink, telemetry.groundSpeed, input.surface, inside, now);
    this.wasOnGround = telemetry.onGround;

    set(
      this.hornGain!.gain,
      telemetry.stallWarning && !telemetry.crashed ? (inside ? 0.09 : 0.03) : 0,
      0.02,
    );
    // In the cabin the highs are damped; outside everything is open.
    set(this.cabin!.frequency, inside ? 2600 : 18_000, 0.2);
  }

  private touchdown(
    sink: number,
    groundSpeed: number,
    surface: Surface | undefined,
    inside: boolean,
    now: number,
  ) {
    const { chirp, thump } = touchdownLevel(sink, groundSpeed, surface);
    const t0 = Math.max(now + 0.005, this.impactFree);
    const at = (points: EnvelopePoint[]) => points.map((q) => ({ ...q, time: q.time + t0 }));
    // Two chirps: the main wheels never touch at quite the same instant.
    const c = chirp * (inside ? 0.6 : 0.9);
    applyEnvelope(
      this.chirpGain!.gain,
      at([
        { time: 0, value: 0 },
        { time: 0.004, value: c },
        { time: 0.09, value: c * 0.15 },
        { time: 0.11, value: 0 },
        { time: 0.14, value: 0 },
        { time: 0.144, value: c * 0.6 },
        { time: 0.21, value: c * 0.1 },
        { time: 0.23, value: 0 },
      ]),
    );
    const k = thump * (inside ? 1.2 : 0.8);
    applyEnvelope(
      this.thumpGain!.gain,
      at([
        { time: 0, value: 0 },
        { time: 0.006, value: k },
        { time: 0.12, value: k * 0.2 },
        { time: 0.2, value: 0 },
      ]),
    );
    this.impactFree = t0 + 0.24;
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
