import type { AircraftId, AircraftInfo, Surface, Telemetry } from '@sim';
import type { AudioEngine } from './AudioEngine';
import {
  airframeWind,
  buffetLevel,
  gearRoarLevel,
  listening,
  shockLevel,
  soundSpeedAt,
  type CameraRelative,
  type Listening,
} from './airframe';
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
import { C172_SOUND, MAX_ENGINES, soundProfileFor, type SoundProfile } from './profiles';
import {
  cabinWeighted,
  coreTarget,
  featherTarget,
  readTurbine,
  spoolCore,
  turbineMode,
  turbineVoice,
  type EngineVoice,
} from './turbine';
import { alertBuffers, type AlertBuffers } from './warnings';

/** What the sound needs beyond the telemetry; all optional, the defaults are harmless. */
export interface AircraftSoundInput {
  /** The starter of engine 1 is engaged (`controls.starter[0]`). */
  starter?: boolean;
  /** Phase 4: the starter of each engine (`controls.starter`); wins over `starter`. */
  starters?: readonly boolean[];
  /** Surface under the wheels (`env.ground(position).surface`); asphalt if not given. */
  surface?: Surface;
  /** Wheel brakes 0..1, the firmer of the two. */
  brake?: number;
  /** Phase 4: the overspeed warning stands (above VMO or MMO): the clacker sounds. */
  overspeed?: boolean;
  /** Phase 4: the altitude alert stands; each rising edge sounds the chime once. */
  altitudeAlert?: boolean;
  /**
   * Phase 4: the camera relative to the aircraft (outside views, the menu's fly-by): distance,
   * air absorption, Doppler, and which side each engine is on. Without it, outside sounds as
   * from the usual chase view.
   */
  camera?: CameraRelative;
}

/** Per engine, between frames. */
interface EngineMemory {
  core: number;
  sinceLightOff: number;
  wasRunning: boolean;
  feather: number;
  wasBurner: boolean;
}

const VOICE_PARAMS = [
  'rps',
  'core',
  'tone',
  'buzz',
  'whine',
  'roar',
  'roarHz',
  'rumble',
  'crackle',
  'beta',
  'ignite',
  'feather',
  'starter',
] as const;

type Slot = Record<(typeof VOICE_PARAMS)[number] | 'load' | 'firing', AudioParam>;
type Setter = (param: AudioParam, value: number, tau?: number) => void;

/**
 * Everything one aircraft makes heard: the engines (synthesised in engine-worklet.js: the
 * Cessna's firing pulses and propeller; the turboprop's propeller and gas generator; the
 * turbofans' fan, core and jet; the afterburner), the wind over the airframe, the gear and
 * flaps running, the speed brake buffet and shock noise, the tyres on the ground (rumble by
 * surface, chirp at touch-down, brakes) and the warnings (stall, overspeed, altitude).
 * Driven by the telemetry once per frame; the type is chosen with `setAircraft`.
 */
export class AircraftSound {
  private engineNode?: AudioWorkletNode;
  private slots: Slot[] = [];
  private engineGain?: GainNode;
  private direct?: GainNode;
  private panned: { delay: DelayNode; pan: StereoPannerNode; gain: GainNode }[] = [];
  private windGain?: GainNode;
  private windFilter?: BiquadFilterNode;
  private rollGain?: GainNode;
  private rollFilter?: BiquadFilterNode;
  private crunchGain?: GainNode;
  private crunchDepth?: GainNode;
  private crunchFilter?: BiquadFilterNode;
  private chirpGain?: GainNode;
  private chirpFilter?: BiquadFilterNode;
  private thumpGain?: GainNode;
  private squealGain?: GainNode;
  private hornGain?: GainNode;
  private ecsGain?: GainNode;
  private ecsFilter?: BiquadFilterNode;
  private shockGain?: GainNode;
  private buffetGain?: GainNode;
  private gearRoarGain?: GainNode;
  private gearHydraulic?: { osc: OscillatorNode; gain: GainNode };
  private flapDrive?: { osc: OscillatorNode; gain: GainNode };
  private alertGains: Partial<Record<'shaker' | 'cricket' | 'tone' | 'clacker', GainNode>> = {};
  private alerts?: AlertBuffers;
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
  private engines: EngineMemory[] = [];
  private lastGear: number | undefined;
  private lastFlaps: number | undefined;
  private wasAltitudeAlert = false;
  private pitch = 1;

  constructor(
    private readonly audio: AudioEngine,
    private profile: SoundProfile = C172_SOUND,
    /** Where engine-worklet.js is served from. */
    private readonly workletUrl = `${import.meta.env.BASE_URL}assets/audio/engine-worklet.js`,
  ) {}

  /**
   * Chooses the sound of a type, by its id (else its category). Call when a flight (or the
   * menu's showcase) starts with a type; before or after `start()`.
   */
  setAircraft(
    info: Pick<AircraftInfo, 'id' | 'category'> | { id: AircraftId | string; category?: string },
  ) {
    this.setProfile(soundProfileFor(info));
  }

  /** Chooses a profile directly. */
  setProfile(profile: SoundProfile) {
    if (profile === this.profile) return;
    this.profile = profile;
    this.applyProfile();
  }

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

    // One worklet for all engines, one channel each: a single engine goes straight on (as
    // the Cessna always has), twins through a delay and a panner each.
    this.engineNode = new AudioWorkletNode(ctx, 'engine-sound', {
      outputChannelCount: [MAX_ENGINES],
    });
    const p = this.engineNode.parameters;
    for (let e = 0; e < MAX_ENGINES; e++) {
      const slot = {} as Slot;
      for (const k of [...VOICE_PARAMS, 'load', 'firing'] as const)
        slot[k] = p.get(e === 0 ? k : `${k}${e}`)!;
      this.slots.push(slot);
    }
    this.engineGain = silentGain(ctx, this.cabin);
    const split = ctx.createChannelSplitter(MAX_ENGINES);
    this.engineNode.connect(split);
    this.direct = ctx.createGain();
    split.connect(this.direct, 0).connect(this.engineGain);
    for (let e = 0; e < MAX_ENGINES; e++) {
      const delay = ctx.createDelay(0.1);
      delay.delayTime.value = 0;
      const pan = ctx.createStereoPanner();
      const gain = silentGain(ctx, this.engineGain);
      split.connect(delay, e).connect(pan).connect(gain);
      this.panned.push({ delay, pan, gain });
    }

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
    this.chirpFilter = filter('bandpass', 2300, 3);
    fast.connect(this.chirpFilter).connect(this.chirpGain);
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

    // Phase 4 airframes. Air conditioning: a hiss in the cabin itself, after its walls.
    this.ecsFilter = filter('bandpass', 2000, 0.45);
    this.ecsGain = silentGain(ctx, this.bus);
    fast.connect(this.ecsFilter).connect(this.ecsGain);
    // Shock noise towards Mach 1: a rough mid band.
    this.shockGain = silentGain(ctx, this.cabin);
    fast.connect(filter('bandpass', 650, 0.7)).connect(this.shockGain);
    // Speed brake buffet: the airframe shaken by the separated flow, a low irregular rumble.
    this.buffetGain = silentGain(ctx, this.cabin);
    slow.connect(filter('lowpass', 120, 1.2)).connect(this.buffetGain);
    // The extended gear in the airstream: a broad roar of the struts and wells.
    this.gearRoarGain = silentGain(ctx, this.cabin);
    fast.connect(filter('bandpass', 380, 0.8)).connect(this.gearRoarGain);
    // Hydraulic pump and actuators (gear), and the flap drive: whining motors.
    const motor = (q: number) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 400;
      const gain = silentGain(ctx, this.cabin);
      osc.connect(filter('lowpass', 1400, q)).connect(gain);
      osc.start();
      this.sources.push(osc);
      return { osc, gain };
    };
    this.gearHydraulic = motor(0.9);
    this.flapDrive = motor(1.4);

    // Warnings: looped prerendered patterns, only their gains move.
    this.alerts = alertBuffers(ctx);
    for (const k of ['shaker', 'cricket', 'tone', 'clacker'] as const) {
      const src = ctx.createBufferSource();
      src.buffer = this.alerts[k];
      src.loop = true;
      const g = silentGain(ctx, this.audio.output);
      src.connect(g);
      src.start();
      this.sources.push(src);
      this.alertGains[k] = g;
    }
    this.applyProfile();
  }

  /** Tells the worklet and the graph the current type. Not per frame: only on a change. */
  private applyProfile() {
    // A new type is a new flight: forget the edges.
    this.lastTime = -1;
    this.engines = [];
    if (!this.engineNode) return;
    const pr = this.profile;
    this.engineNode.port.postMessage({
      kind: pr.engine,
      blades: pr.blades,
      cylinders: pr.cylinders || 4,
      orders: pr.turbine?.compressorOrders,
    });
    const now = this.audio.audio.currentTime;
    const count = Math.min(MAX_ENGINES, pr.engines?.length ?? 1);
    glide(this.direct!.gain, count > 1 ? 0 : 1, now, 0.02);
    this.panned.forEach((r, e) => glide(r.gain.gain, count > 1 && e < count ? 1 : 0, now, 0.02));
    const a = pr.airframe;
    this.chirpFilter!.frequency.setValueAtTime(a?.chirpHz ?? 2300, now);
    this.gearHydraulic!.osc.frequency.setValueAtTime(a?.gearHz ?? 400, now);
    this.flapDrive!.osc.frequency.setValueAtTime(a?.flapsHz ?? 400, now);
    this.ecsFilter!.frequency.setValueAtTime(pr.cabin?.ecsHz ?? 2000, now);
    // A pressurised cabin damps the engines far more than the boundary layer roaring on its
    // own skin: the wind of those types bypasses the cabin filter (the Cessna's stays in it).
    this.windGain!.disconnect();
    this.windGain!.connect(pr.cabin ? this.bus! : this.cabin!);
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
    const set: Setter = (param, value, tau = 0.08) => glide(param, value, now, tau);
    const pr = this.profile;
    const hear = listening(pr, inside, input.camera);
    set(this.bus.gain, (active && telemetry ? 1 : 0) * hear.gain, 0.15);
    if (!telemetry) return;

    // A reset (time ran backwards) starts a new flight: forget the edges of the last one.
    const fresh = this.lastTime < 0 || telemetry.time < this.lastTime;
    const dt = fresh ? 0 : telemetry.time - this.lastTime;
    this.lastTime = telemetry.time;

    if (pr.engine === 'piston') {
      this.piston(telemetry, inside, active, input, fresh, dt, set);
      const wind = windLevel(telemetry.tas, pr.windFullSpeed, inside);
      set(this.windGain!.gain, wind);
      set(this.windFilter!.frequency, 300 + 14 * telemetry.tas);
    } else {
      this.turbines(telemetry, inside, active, input, fresh, dt, set, hear);
      set(this.windGain!.gain, airframeWind(pr, telemetry.ias, inside));
      // Faster types: the boundary layer's roar stays broad and low, not a rising whistle.
      set(this.windFilter!.frequency, 200 + 3 * Math.min(400, telemetry.ias));
    }

    // Doppler, only while the app reports a camera (and once more to return to 1).
    if (input.camera || this.pitch !== 1) {
      this.pitch = inside ? 1 : hear.pitch;
      set(this.engineNode.parameters.get('pitch')!, this.pitch, 0.05);
    }

    const a = pr.airframe;
    const surface = surfaceSound(input.surface);
    // Heavier aircraft roll faster before the rumble is full.
    const rollSpeed = a ? telemetry.groundSpeed * (30 / a.rollFullSpeed) : telemetry.groundSpeed;
    const roll = groundRollLevel(telemetry.onGround, rollSpeed, inside);
    set(this.rollGain!.gain, roll * surface.rumble * (a?.rumble ?? 1));
    set(this.rollFilter!.frequency, surface.rumbleHz * (a?.rumbleHz ?? 1), 0.2);
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

    if (a) this.airframe(telemetry, inside, active, fresh, dt, set, now);
    this.warnings(telemetry, inside, active, input, set, now);

    // In the cabin the highs are damped; outside everything is open, unless far away.
    set(this.cabin!.frequency, inside ? (pr.cabin?.lowpassHz ?? 2600) : hear.lowpassHz, 0.2);
  }

  /** The Cessna's engine: unchanged since phase 1. */
  private piston(
    telemetry: Telemetry,
    inside: boolean,
    active: boolean,
    input: AircraftSoundInput,
    fresh: boolean,
    dt: number,
    set: Setter,
  ) {
    const ctx = this.audio.audio;
    const engine = telemetry.engines[0];
    const running = engine?.running ?? false;
    const rpm = Math.max(0, engine?.rpm ?? 0);
    const starter = input.starters?.[0] ?? input.starter ?? false;
    if (running && !this.wasRunning) this.sinceCatch = 0;
    else this.sinceCatch += dt;
    if (fresh && running) this.sinceCatch = 99;
    this.wasRunning = running;
    const mode = engineMode(running, rpm, starter, this.sinceCatch);

    const s = this.slots[0]!;
    set(s.rps, rpm / 60, 0.05);
    set(s.load, Math.min(1, Math.max(0.2, engine?.power ?? 0)), 0.1);
    set(s.firing, firingShare(mode, this.sinceCatch), 0.03);
    set(s.starter, starter ? 1 : 0, 0.03);
    set(this.engineGain!.gain, engineLevel(rpm, inside), 0.1);
    if (starter && !this.wasStarter && !fresh && active)
      playOnce(ctx, this.solenoid!, this.cabin!, COCKPIT_LEVEL.starterClick * (inside ? 1 : 0.4));
    this.wasStarter = starter;
  }

  private turbines(
    telemetry: Telemetry,
    inside: boolean,
    active: boolean,
    input: AircraftSoundInput,
    fresh: boolean,
    dt: number,
    set: Setter,
    hear: Listening,
  ) {
    const pr = this.profile;
    const spec = pr.turbine!;
    const count = Math.min(MAX_ENGINES, pr.engines?.length ?? 1);
    let anyRunning = false;
    // Twins light their afterburners together: one thump, not one per engine.
    let thump = false;
    for (let i = 0; i < MAX_ENGINES; i++) {
      const s = this.slots[i]!;
      if (i >= count) {
        for (const k of VOICE_PARAMS) if (k !== 'roarHz') set(s[k], 0, 0.1);
        continue;
      }
      const e = telemetry.engines[i];
      const starter = input.starters?.[i] ?? (i === 0 ? input.starter : undefined) ?? false;
      const target = coreTarget(pr.engine, spec, e, starter);
      const m = (this.engines[i] ??= {
        core: 0,
        sinceLightOff: 99,
        wasRunning: false,
        feather: 1,
        wasBurner: false,
      });
      if (fresh) {
        m.core = e?.running ? target : 0;
        m.sinceLightOff = 99;
        m.wasRunning = e?.running ?? false;
      } else m.core = spoolCore(m.core, target, dt, spec);
      const r = readTurbine(pr.engine, spec, e, starter, m.core);
      if (r.running && !m.wasRunning) m.sinceLightOff = 0;
      else m.sinceLightOff += dt;
      m.wasRunning = r.running;
      anyRunning ||= r.running;
      const mode = turbineMode(r, spec);
      const ft = featherTarget(mode);
      m.feather = fresh ? ft : ft + (m.feather - ft) * Math.exp(-dt / 1.5);
      let v: EngineVoice = turbineVoice(pr, r, mode, {
        sinceLightOff: m.sinceLightOff,
        feather: m.feather,
        onGround: telemetry.onGround,
      });
      v = cabinWeighted(v, pr, inside);
      if (input.camera && !inside) {
        // Fan tones radiate from the inlet, the jet's roar aft of the nozzle.
        v = {
          ...v,
          tone: v.tone * hear.forward,
          buzz: v.buzz * hear.forward,
          roar: v.roar * hear.aft,
          crackle: v.crackle * hear.aft,
        };
      }
      for (const k of VOICE_PARAMS) set(s[k], v[k], k === 'rps' || k === 'core' ? 0.05 : 0.08);
      const burner = r.afterburner > 0.05;
      thump ||= burner && !m.wasBurner && !fresh && active;
      m.wasBurner = burner;
      const route = this.panned[i]!;
      set(route.pan.pan, hear.pans[i] ?? 0, 0.1);
      set(route.delay.delayTime, hear.delays[i] ?? 0, 0.1);
    }
    // The afterburner lights with a thump.
    if (thump && this.alerts)
      playOnce(this.audio.audio, this.alerts.burnerThump, this.cabin!, inside ? 0.15 : 0.35);
    set(this.engineGain!.gain, inside ? (pr.cabin?.engine ?? 0.5) : (pr.outside ?? 0.85), 0.1);
    // The packs run on engine bleed air (or the APU's, which the telemetry does not tell).
    set(this.ecsGain!.gain, inside && anyRunning ? (pr.cabin?.ecs ?? 0) : 0, 0.8);
  }

  private airframe(
    telemetry: Telemetry,
    inside: boolean,
    active: boolean,
    fresh: boolean,
    dt: number,
    set: Setter,
    now: number,
  ) {
    const pr = this.profile;
    const a = pr.airframe!;
    const ias = telemetry.ias;
    const mach = telemetry.mach ?? telemetry.tas / soundSpeedAt(telemetry.altitude);
    set(this.shockGain!.gain, shockLevel(pr, mach, ias) * (inside ? 1 : 0.3), 0.2);
    set(
      this.buffetGain!.gain,
      buffetLevel(pr, telemetry.speedbrake ?? 0, ias) * (inside ? 1.2 : 0.6),
      0.15,
    );
    set(this.gearRoarGain!.gain, gearRoarLevel(pr, telemetry.gear, ias) * (inside ? 0.6 : 1), 0.15);

    // Gear and flaps running: the rate of their actual positions.
    const gear = telemetry.gear;
    const last = fresh ? undefined : this.lastGear;
    const gearRate = last === undefined || dt <= 0 ? 0 : Math.abs(gear - last) / dt;
    const moving = gearRate > 0.01 && gear > 0.001 && gear < 0.999;
    set(this.gearHydraulic!.gain.gain, moving ? a.gearHydraulic * (inside ? 0.8 : 0.5) : 0, 0.12);
    if (active && last !== undefined && this.alerts) {
      // The locks: a heavy clunk as the gear reaches the up- or the downlock, a lighter one
      // as a lock releases.
      const k = a.gearThump * (inside ? 1 : 0.6);
      const locked = (gear >= 0.999 && last < 0.999) || (gear <= 0.001 && last > 0.001);
      const released = (last >= 0.999 && gear < 0.999) || (last <= 0.001 && gear > 0.001);
      const ctx = this.audio.audio;
      if (locked) playOnce(ctx, this.alerts.gearLock, this.cabin!, k, now + 0.005);
      else if (released)
        playOnce(ctx, this.alerts.gearLock, this.cabin!, 0.4 * k, now + 0.005, 1.3);
    }
    this.lastGear = gear;

    const lastFlaps = fresh ? undefined : this.lastFlaps;
    const flapRate =
      lastFlaps === undefined || dt <= 0 ? 0 : Math.abs(telemetry.flaps - lastFlaps) / dt;
    this.lastFlaps = telemetry.flaps;
    const flaps =
      a.flapsDrive !== 'none' && flapRate > 0.005 ? a.flapsLevel * (inside ? 1 : 0.5) : 0;
    set(this.flapDrive!.gain.gain, flaps, 0.1);
  }

  private warnings(
    telemetry: Telemetry,
    inside: boolean,
    active: boolean,
    input: AircraftSoundInput,
    set: Setter,
    now: number,
  ) {
    const w = this.profile.warnings;
    const stall = telemetry.stallWarning && !telemetry.crashed;
    const style = w?.stall ?? 'horn';
    set(this.hornGain!.gain, stall && style === 'horn' ? (inside ? 0.09 : 0.03) : 0, 0.02);
    // The others are cockpit warnings: heard only there.
    const cockpit = inside && active;
    const level = { shaker: 0.2, cricket: 0.2, tone: 0.08 } as const;
    for (const k of ['shaker', 'cricket', 'tone'] as const)
      set(this.alertGains[k]!.gain, stall && cockpit && style === k ? level[k] : 0, 0.015);
    set(
      this.alertGains.clacker!.gain,
      cockpit && w?.overspeed && input.overspeed && !telemetry.crashed ? 0.18 : 0,
      0.015,
    );
    const alt = input.altitudeAlert ?? false;
    if (alt && !this.wasAltitudeAlert && cockpit && w?.altitudeChime && this.alerts)
      playOnce(this.audio.audio, this.alerts.chime, this.audio.output, 0.08, now + 0.01);
    this.wasAltitudeAlert = alt;
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
    const k = thump * (inside ? 1.2 : 0.8) * (this.profile.airframe?.thump ?? 1);
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
    for (const g of Object.values(this.alertGains)) g?.disconnect();
    this.engineNode = undefined;
    this.slots = [];
    this.panned = [];
    this.started = false;
  }
}
