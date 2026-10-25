/**
 * Procedural flight audio with WebAudio (no sound files): turboprop engine, wind, boost,
 * warnings, touchdown and crash. All levels follow the aircraft state every frame.
 */

export interface AudioState {
  /** 0..1 */
  throttle: number;
  /** Propeller speed 0..1 (0 = engine off after a crash). */
  rpm: number;
  /** Airspeed m/s */
  speed: number;
  boost: boolean;
  /** Camera inside the canopy: muffled engine and wind. */
  inside: boolean;
  /** Speed of the camera towards the aircraft (m/s, positive = approaching), for Doppler. */
  approach: number;
  pullUp: boolean;
  stall: boolean;
  /** Gear or flaps are moving. */
  servo: boolean;
  onGround: boolean;
  paused: boolean;
}

const BLADES = 4;
const MAX_RPS = 30; // 1800 rpm
const SOUND = 343;

const smooth = (param: AudioParam, value: number, ctx: AudioContext, time = 0.08) =>
  param.setTargetAtTime(value, ctx.currentTime, time);

export class FlightAudio {
  private ctx?: AudioContext;
  private master?: GainNode;
  private noise?: AudioBuffer;
  private nodes?: {
    propOsc: OscillatorNode;
    propSub: OscillatorNode;
    propGain: GainNode;
    propFilter: BiquadFilterNode;
    roarGain: GainNode;
    roarFilter: BiquadFilterNode;
    roarAm: GainNode;
    amOsc: OscillatorNode;
    whineOsc: OscillatorNode;
    whineGain: GainNode;
    windGain: GainNode;
    windFilter: BiquadFilterNode;
    cockpit: BiquadFilterNode;
    warnOsc: OscillatorNode;
    warnGain: GainNode;
    servoOsc: OscillatorNode;
    servoGain: GainNode;
  };
  private volume = 0.7;
  private enabled = true;
  private warnPhase = 0;
  private spokenPullUp = false;
  private spokenStall = false;
  constructor() {
    // Browsers only allow audio after a user gesture; the click that opened flight mode counts.
    if (navigator.userActivation?.hasBeenActive) this.unlock();
    window.addEventListener('pointerdown', this.unlock, { passive: true });
    window.addEventListener('keydown', this.unlock, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  setVolume(enabled: boolean, volume: number) {
    this.enabled = enabled;
    this.volume = volume;
    if (this.ctx && this.master) smooth(this.master.gain, enabled ? volume : 0, this.ctx, 0.05);
  }

  private readonly unlock = () => {
    if (!this.ctx) this.build();
    if (this.ctx?.state === 'suspended' && !document.hidden) void this.ctx.resume();
  };

  private readonly onVisibility = () => {
    if (!this.ctx) return;
    if (document.hidden) void this.ctx.suspend();
    else void this.ctx.resume();
  };

  private build() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = this.enabled ? this.volume : 0;
    master.connect(ctx.destination);
    this.master = master;

    // 2 s of white noise, looped by every noise source.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;
    const noiseSource = () => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.loopStart = Math.random();
      s.start(0, Math.random() * 2);
      return s;
    };

    // Everything engine/wind goes through the cockpit filter (open outside, muffled inside).
    const cockpit = ctx.createBiquadFilter();
    cockpit.type = 'lowpass';
    cockpit.frequency.value = 18_000;
    cockpit.connect(master);

    // Propeller: blade-pass sawtooth + sub octave, low-passed: the "thrum".
    const propOsc = ctx.createOscillator();
    propOsc.type = 'sawtooth';
    const propSub = ctx.createOscillator();
    propSub.type = 'triangle';
    const propFilter = ctx.createBiquadFilter();
    propFilter.type = 'lowpass';
    propFilter.Q.value = 0.8;
    const propGain = ctx.createGain();
    propGain.gain.value = 0;
    propOsc.connect(propFilter);
    propSub.connect(propFilter);
    propFilter.connect(propGain).connect(cockpit);

    // Combustion roar: band-passed noise, amplitude-modulated at the blade-pass frequency.
    const roarFilter = ctx.createBiquadFilter();
    roarFilter.type = 'bandpass';
    roarFilter.Q.value = 0.7;
    const roarAm = ctx.createGain();
    const amOsc = ctx.createOscillator();
    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.35;
    amOsc.connect(amDepth).connect(roarAm.gain);
    roarAm.gain.value = 0.65;
    const roarGain = ctx.createGain();
    roarGain.gain.value = 0;
    noiseSource().connect(roarFilter).connect(roarAm).connect(roarGain).connect(cockpit);

    // Turbine whine (PT6-like), quiet; boost adds to it.
    const whineOsc = ctx.createOscillator();
    whineOsc.type = 'sine';
    const whineGain = ctx.createGain();
    whineGain.gain.value = 0;
    whineOsc.connect(whineGain).connect(cockpit);

    // Wind: noise through a band-pass that rises with speed.
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.Q.value = 0.5;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    noiseSource().connect(windFilter).connect(windGain).connect(cockpit);

    // Warnings bypass the cockpit filter (they come from the panel).
    const warnOsc = ctx.createOscillator();
    warnOsc.type = 'square';
    const warnFilter = ctx.createBiquadFilter();
    warnFilter.type = 'lowpass';
    warnFilter.frequency.value = 2500;
    const warnGain = ctx.createGain();
    warnGain.gain.value = 0;
    warnOsc.connect(warnFilter).connect(warnGain).connect(master);

    // Gear/flap servo hum.
    const servoOsc = ctx.createOscillator();
    servoOsc.type = 'sawtooth';
    servoOsc.frequency.value = 95;
    const servoFilter = ctx.createBiquadFilter();
    servoFilter.type = 'lowpass';
    servoFilter.frequency.value = 600;
    const servoGain = ctx.createGain();
    servoGain.gain.value = 0;
    servoOsc.connect(servoFilter).connect(servoGain).connect(cockpit);

    for (const o of [propOsc, propSub, amOsc, whineOsc, warnOsc, servoOsc]) o.start();
    this.nodes = {
      propOsc,
      propSub,
      propGain,
      propFilter,
      roarGain,
      roarFilter,
      roarAm,
      amOsc,
      whineOsc,
      whineGain,
      windGain,
      windFilter,
      cockpit,
      warnOsc,
      warnGain,
      servoOsc,
      servoGain,
    };
  }

  update(dt: number, s: AudioState) {
    const ctx = this.ctx;
    const n = this.nodes;
    if (!ctx || !n) return;
    const mute = s.paused ? 0 : 1;

    // Doppler in outside views: the aircraft sounds higher when it comes closer.
    const doppler = Math.min(1.25, Math.max(0.8, SOUND / (SOUND - s.approach)));
    const rps = s.rpm * MAX_RPS;
    const blade = Math.max(rps * BLADES, 1) * doppler;
    smooth(n.propOsc.frequency, blade, ctx);
    smooth(n.propSub.frequency, blade / 2, ctx);
    smooth(n.amOsc.frequency, blade, ctx);
    smooth(n.propFilter.frequency, 200 + 600 * s.throttle, ctx);
    const running = s.rpm > 0.05 ? 1 : 0;
    smooth(n.propGain.gain, mute * running * (0.08 + 0.14 * s.throttle), ctx, 0.15);
    smooth(n.roarFilter.frequency, (200 + 450 * s.throttle) * doppler, ctx);
    smooth(n.roarGain.gain, mute * running * (0.05 + 0.16 * s.throttle), ctx, 0.15);
    smooth(n.whineOsc.frequency, (900 + 500 * s.rpm + (s.boost ? 250 : 0)) * doppler, ctx, 0.4);
    smooth(
      n.whineGain.gain,
      mute * running * (0.0012 + 0.0025 * s.throttle + (s.boost ? 0.007 : 0)),
      ctx,
      0.3,
    );

    const v = Math.min(1.6, s.speed / 100);
    smooth(n.windFilter.frequency, 180 + 520 * v, ctx);
    smooth(n.windGain.gain, mute * (s.onGround ? 0.3 : 1) * 0.22 * v * v, ctx, 0.2);
    smooth(n.cockpit.frequency, s.inside ? 900 : 6500, ctx, 0.1);

    smooth(n.servoGain.gain, mute * (s.servo ? 0.03 : 0), ctx, 0.1);

    // Warnings: PULL UP = fast high beeps, STALL = low warble.
    this.warnPhase += dt;
    let warn = 0;
    if (s.pullUp && !s.paused) {
      n.warnOsc.frequency.setValueAtTime(1000, ctx.currentTime);
      warn = this.warnPhase % 0.3 < 0.15 ? 0.06 : 0;
    } else if (s.stall && !s.paused) {
      n.warnOsc.frequency.setValueAtTime(
        420 + 120 * Math.sin(this.warnPhase * 30),
        ctx.currentTime,
      );
      warn = 0.04;
    }
    n.warnGain.gain.setTargetAtTime(warn, ctx.currentTime, 0.01);
    this.speak(s.pullUp && !s.paused, 'pullUp');
    this.speak(s.stall && !s.paused && !s.pullUp, 'stall');
  }

  /** Spoken warning once per episode (speechSynthesis, if the browser has it). */
  private speak(active: boolean, kind: 'pullUp' | 'stall') {
    const flag = kind === 'pullUp' ? 'spokenPullUp' : 'spokenStall';
    if (!active) {
      this[flag] = false;
      return;
    }
    if (this[flag] || !this.enabled || !('speechSynthesis' in window)) return;
    this[flag] = true;
    const u = new SpeechSynthesisUtterance(kind === 'pullUp' ? 'Pull up' : 'Stall');
    u.lang = 'en-US';
    u.rate = 1.1;
    u.volume = this.volume;
    speechSynthesis.speak(u);
  }

  /** Short noise burst: tyre chirp + thump on touchdown, long rumble on a crash. */
  impact(kind: 'touchdown' | 'crash', strength = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.master) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const dur = kind === 'crash' ? 2.2 : 0.35;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(kind === 'crash' ? 2500 : 1800, t);
    filter.frequency.exponentialRampToValueAtTime(kind === 'crash' ? 120 : 300, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(
      (kind === 'crash' ? 0.9 : 0.25) * Math.min(1.5, strength),
      t + 0.02,
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
    if (kind === 'touchdown') {
      // Tyre chirp.
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(1700, t);
      o.frequency.exponentialRampToValueAtTime(900, t + 0.12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05 * Math.min(1.5, strength), t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.2);
    }
  }

  dispose() {
    window.removeEventListener('pointerdown', this.unlock);
    window.removeEventListener('keydown', this.unlock);
    document.removeEventListener('visibilitychange', this.onVisibility);
    speechSynthesis?.cancel?.();
    void this.ctx?.close();
    this.ctx = undefined;
    this.nodes = undefined;
  }

  /** For tests/debugging: whether the audio graph runs. */
  get state(): string {
    return this.ctx?.state ?? 'not-started';
  }
}
