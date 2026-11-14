import type { Cockpit, Telemetry } from '@sim';
import type { AudioEngine } from './AudioEngine';
import {
  applyEnvelope,
  glide,
  impactBuffer,
  noiseLoop,
  playOnce,
  seededRandom,
  silentGain,
} from './graph';
import { PatternKeyer, keyedEnvelope, type KeyPattern } from './keying';
import { COCKPIT_LEVEL, gyroSpin, rainLevel } from './levels';

/** What the cockpit sounds need beyond the telemetry. */
export interface CockpitSoundInput {
  /** The listener sits in the cockpit; outside, only the rain is heard. */
  inside: boolean;
  /** A flight is running and not paused. */
  active: boolean;
  /** Rain on the airframe, 0 dry .. 1 downpour (from the weather at the aircraft). */
  precipitation?: number;
  /** The aircraft's controls by name, for the switches the telemetry does not report. */
  cockpit?: Cockpit;
}

/**
 * The autopilot disconnect alert: a pulsed tone while the warning stands (the KAP 140 sounds
 * its tone for a few seconds; this is its character, not a measured copy).
 */
export const DISCONNECT_TONE: { hz: number } & KeyPattern = {
  hz: 1450,
  period: 0.36,
  tones: [{ start: 0, end: 0.22 }],
};

/** The bus has to carry at least this much to run a motor, V. */
const MIN_VOLTS = 18;

/**
 * Small sounds of the cockpit: switches, knobs, levers, the flap motor, the electric fuel
 * pump, the gyros, the autopilot disconnect tone and rain on the airframe. Events are methods
 * the cockpit calls when the pilot moves something; `update()` runs once per frame. Each
 * continuous sound is one source running at zero gain, so nothing is built per frame; the
 * one-shot clicks are prerendered buffers played by a source node per event.
 */
export class CockpitSound {
  private bus?: GainNode;
  private clicks: { switchOn?: AudioBuffer; switchOff?: AudioBuffer; knob?: AudioBuffer } = {};
  private leverGain?: GainNode;
  private flapGain?: GainNode;
  private pumpGain?: GainNode;
  private electricGyro?: { osc: OscillatorNode; gain: GainNode };
  private vacuumGyro?: { osc: OscillatorNode; gain: GainNode };
  private disconnectGain?: GainNode;
  private rainGain?: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly disconnect = new PatternKeyer();
  private inside = true;
  private active = false;
  private leverActivity = 0;
  private lastKnob = -1;
  private lastFlaps: number | undefined;
  private lastTime = -1;
  private electricSpin = 0;
  private vacuumSpin = 0;
  private readonly rnd = seededRandom(77);

  constructor(private readonly audio: AudioEngine) {}

  /** Builds the graph. Call after the first user gesture, with the other sounds. */
  start() {
    if (this.bus) return;
    const ctx = this.audio.audio;
    this.bus = silentGain(ctx, this.audio.output);
    const filter = (type: BiquadFilterType, hz: number, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = hz;
      f.Q.value = q;
      return f;
    };

    // Toggle switches: a hard snap, with a different ring for on and off.
    this.clicks.switchOn = impactBuffer(
      ctx,
      [
        { hz: 2900, decay: 0.004, gain: 1 },
        { hz: 5200, decay: 0.002, gain: 0.6 },
        { hz: 900, decay: 0.008, gain: 0.3 },
      ],
      0.04,
      0.6,
      0.0015,
      11,
    );
    this.clicks.switchOff = impactBuffer(
      ctx,
      [
        { hz: 2500, decay: 0.004, gain: 1 },
        { hz: 4600, decay: 0.002, gain: 0.5 },
        { hz: 780, decay: 0.009, gain: 0.35 },
      ],
      0.04,
      0.6,
      0.0015,
      12,
    );
    // A knob detent: a tiny, dry tick.
    this.clicks.knob = impactBuffer(
      ctx,
      [
        { hz: 3800, decay: 0.0015, gain: 1 },
        { hz: 1700, decay: 0.002, gain: 0.4 },
      ],
      0.015,
      0.8,
      0.0008,
      13,
    );

    const noise = noiseLoop(ctx, 1, 1.3);
    const noiseSlow = noiseLoop(ctx, 0.37, 0.2);
    this.sources.push(noise, noiseSlow);

    // Levers (throttle, mixture, carb heat): friction of a rod sliding in its bushing.
    this.leverGain = silentGain(ctx, this.bus);
    noise.connect(filter('bandpass', 1300, 1.5)).connect(this.leverGain);

    // Flap motor: an electric motor and worm gear behind the cabin, a whirring hum.
    const motor = ctx.createOscillator();
    motor.type = 'sawtooth';
    motor.frequency.value = 205;
    this.flapGain = silentGain(ctx, this.bus);
    const motorTone = filter('lowpass', 900);
    motor.connect(motorTone).connect(this.flapGain);
    noise.connect(filter('bandpass', 620, 4)).connect(this.flapGain);
    motor.start();

    // Electric fuel pump: a faint buzz under the floor.
    const pump = ctx.createOscillator();
    pump.type = 'square';
    pump.frequency.value = 118;
    this.pumpGain = silentGain(ctx, this.bus);
    pump.connect(filter('lowpass', 420)).connect(this.pumpGain);
    pump.start();

    // Gyros: the electric turn coordinator and the air-driven attitude and heading gyros. A
    // rotor whines at its spin frequency; the pitch follows its speed up and down.
    const gyro = (q: number) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 20;
      const gain = silentGain(ctx, this.bus);
      osc.connect(filter('bandpass', 400, q)).connect(gain);
      osc.start();
      this.sources.push(osc);
      return { osc, gain };
    };
    this.electricGyro = gyro(0.8);
    this.vacuumGyro = gyro(0.6);

    // Autopilot disconnect: a keyed tone (envelopes only on its gain, no glides).
    const alert = ctx.createOscillator();
    alert.type = 'square';
    alert.frequency.value = DISCONNECT_TONE.hz;
    this.disconnectGain = silentGain(ctx, this.audio.output);
    alert.connect(filter('lowpass', 3500)).connect(this.disconnectGain);
    alert.start();

    // Rain: a hiss of fine drops plus single heavy drops ticking on the skin.
    this.rainGain = silentGain(ctx, this.audio.output);
    noise.connect(filter('highpass', 900)).connect(filter('lowpass', 7000)).connect(this.rainGain);
    const drops = ctx.createBufferSource();
    drops.buffer = dropsBuffer(ctx);
    drops.loop = true;
    drops.connect(filter('bandpass', 2200, 0.8)).connect(this.rainGain);
    drops.start();
    this.sources.push(motor, pump, alert, drops);
  }

  /** A toggle switch was flipped (master, lights, fuel pump, magnetos...). */
  switchClick(on = true) {
    const buf = on ? this.clicks.switchOn : this.clicks.switchOff;
    if (!buf || !this.audible()) return;
    playOnce(this.ctx(), buf, this.bus!, COCKPIT_LEVEL.switch);
  }

  /** A knob moved by one detent (frequency, course, heading bug). */
  knobTick() {
    const buf = this.clicks.knob;
    if (!buf || !this.audible()) return;
    const now = this.ctx().currentTime;
    // Spinning a knob fast sends many detents per frame: they blur into a rattle, not a buzz.
    if (now - this.lastKnob < 0.025) return;
    this.lastKnob = now;
    playOnce(this.ctx(), buf, this.bus!, COCKPIT_LEVEL.knob, now, 0.92 + 0.16 * this.rnd());
  }

  /** A lever moved by `delta` (its full travel is 1): throttle, mixture, carb heat. */
  lever(delta: number) {
    this.leverActivity = Math.min(1, this.leverActivity + Math.abs(delta) * 15);
  }

  /** Per frame. */
  update(telemetry: Telemetry | undefined, input: CockpitSoundInput) {
    if (!this.bus) return;
    const ctx = this.ctx();
    const now = ctx.currentTime;
    this.inside = input.inside;
    this.active = input.active && telemetry !== undefined;
    glide(this.bus.gain, this.active && this.inside ? 1 : 0, now, 0.1);
    if (!telemetry) {
      glide(this.rainGain!.gain, 0, now, 0.3);
      this.disconnect.stop();
      return;
    }
    const fresh = this.lastTime < 0 || telemetry.time < this.lastTime;
    const dt = fresh ? 0 : Math.min(0.5, telemetry.time - this.lastTime);
    this.lastTime = telemetry.time;

    const sys = telemetry.systems;
    // Without system telemetry, assume a powered aircraft whenever the engine runs.
    const engineRunning = telemetry.engines[0]?.running ?? false;
    const powered = sys ? sys.busVolts >= MIN_VOLTS : engineRunning;

    // Levers: the friction fades within a fraction of a second after the hand stops.
    glide(this.leverGain!.gain, this.leverActivity * COCKPIT_LEVEL.lever, now, 0.03);
    this.leverActivity *= Math.exp(-(dt || 0.016) / 0.08);

    // Flap motor: runs while the flaps move and the bus can drive it.
    const flapRate =
      this.lastFlaps === undefined || dt <= 0 ? 0 : Math.abs(telemetry.flaps - this.lastFlaps) / dt;
    this.lastFlaps = telemetry.flaps;
    glide(
      this.flapGain!.gain,
      powered && flapRate > 0.005 ? COCKPIT_LEVEL.flapMotor : 0,
      now,
      0.06,
    );

    const pumpOn = powered && (input.cockpit?.get('fuelPump') ?? 0) > 0.5;
    glide(this.pumpGain!.gain, pumpOn ? COCKPIT_LEVEL.fuelPump : 0, now, 0.15);

    // The turn coordinator spins with the master switch; the vacuum gyros with the engine.
    this.electricSpin = gyroSpin(this.electricSpin, powered, dt);
    const vacuum = sys ? sys.vacuum > 3 : engineRunning;
    this.vacuumSpin = gyroSpin(this.vacuumSpin, vacuum, dt, 10, 60);
    if (fresh) {
      this.electricSpin = powered ? 1 : 0;
      this.vacuumSpin = vacuum ? 1 : 0;
    }
    this.gyroVoice(this.electricGyro!, this.electricSpin, 380, now);
    this.gyroVoice(this.vacuumGyro!, this.vacuumSpin, 290, now);

    // The disconnect tone is an alert: it sounds outside the cabin bus, but only inside.
    const warn =
      this.active && this.inside && telemetry.avionics?.autopilot.disconnectWarning === true;
    if (warn && !this.disconnect.running)
      this.disconnect.start(DISCONNECT_TONE, Math.max(now + 0.02, this.disconnect.lastEnd + 0.05));
    else if (!warn && this.disconnect.running) this.disconnect.stop();
    const tones = this.disconnect.take(now, now + 0.3);
    if (tones.length)
      applyEnvelope(this.disconnectGain!.gain, keyedEnvelope(tones, COCKPIT_LEVEL.disconnect));

    const rain = this.active ? rainLevel(input.precipitation ?? 0, telemetry.tas, this.inside) : 0;
    glide(this.rainGain!.gain, rain, now, 0.5);
  }

  private gyroVoice(
    g: { osc: OscillatorNode; gain: GainNode },
    spin: number,
    hz: number,
    now: number,
  ) {
    glide(g.osc.frequency, 20 + hz * spin, now, 0.2);
    // Audible mostly while fast, and quieter than anything else in the cockpit.
    glide(g.gain.gain, spin * spin * COCKPIT_LEVEL.gyro, now, 0.2);
  }

  private ctx() {
    return this.audio.audio;
  }

  private audible() {
    return this.active && this.inside;
  }

  dispose() {
    for (const s of this.sources) s.stop();
    this.sources.length = 0;
    this.bus?.disconnect();
    this.disconnectGain?.disconnect();
    this.rainGain?.disconnect();
    this.bus = undefined;
  }
}

/** Three seconds of heavy drops at random, each a short decaying tick. */
function dropsBuffer(ctx: BaseAudioContext): AudioBuffer {
  const fs = ctx.sampleRate;
  const n = fs * 3;
  const buffer = ctx.createBuffer(1, n, fs);
  const d = buffer.getChannelData(0);
  const rnd = seededRandom(4242);
  const decay = Math.exp(-1 / (0.0025 * fs));
  for (let k = 0; k < 140; k++) {
    let i = Math.floor(rnd() * (n - fs * 0.02));
    let a = 0.4 + 0.6 * rnd();
    for (let j = 0; j < fs * 0.02; j++, i++) {
      d[i]! += a * (rnd() * 2 - 1);
      a *= decay;
    }
  }
  return buffer;
}
