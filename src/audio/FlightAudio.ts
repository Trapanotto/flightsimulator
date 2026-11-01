import type { EngineProfile } from '../aircraft/types';

/**
 * Procedural flight audio with WebAudio (no sound files): engine (piston, turboprop, jet or
 * fighter), wind, boost/afterburner, warnings, touchdown and crash. All levels follow the
 * aircraft state every frame.
 *
 * The engines come from a sample-by-sample synthesizer (public/audio/engine-worklet.js:
 * exhaust pulses, propeller blade pass, fan tone and buzz-saw, a deep restless jet roar).
 * Without AudioWorklet support the simpler node graph below plays instead.
 */

/** Engine synthesizer: cylinders of the piston engines (others ignore it). */
const CYLINDERS = 4;
/** Cockpit muffling per engine kind (low-pass, Hz): a Cessna is loud inside, an airliner quiet. */
const INSIDE_CUTOFF: Record<EngineProfile['kind'], number> = {
  piston: 1200,
  turboprop: 900,
  jet: 520,
  fighter: 650,
};

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

const SOUND = 343;

/**
 * Mix per engine kind. "prop" is the tonal part (propeller blade pass, or the fan whine of a
 * jet), "roar" the broadband part (exhaust, combustion), "am" how much the roar pulses.
 */
const MIX: Record<
  EngineProfile['kind'],
  {
    prop: number;
    propLp: [number, number];
    roar: number;
    roarLo: number;
    roarHi: number;
    am: number;
  }
> = {
  piston: { prop: 1.25, propLp: [120, 320], roar: 0.9, roarLo: 140, roarHi: 420, am: 0.55 },
  turboprop: { prop: 1, propLp: [140, 400], roar: 1, roarLo: 200, roarHi: 650, am: 0.35 },
  jet: { prop: 0.22, propLp: [1400, 3800], roar: 1.4, roarLo: 260, roarHi: 1300, am: 0.06 },
  fighter: { prop: 0.18, propLp: [1100, 3000], roar: 1.9, roarLo: 180, roarHi: 1000, am: 0.1 },
};

const smooth = (param: AudioParam, value: number, ctx: AudioContext, time = 0.08) =>
  param.setTargetAtTime(value, ctx.currentTime, time);

/**
 * A crash explosion, built from its parts: a sharp crack, a sub-bass boom falling in pitch,
 * the roar of the fireball turning dull, a long rumble rolling through the valley, debris
 * clattering down (metal pings and thuds) and fire crackling for a while. `size` ~1 for a
 * light aircraft, up to ~4 for a 747 (louder, deeper, longer). Everything goes through a
 * compressor so it can be loud without clipping.
 */
export function synthExplosion(
  ctx: BaseAudioContext,
  dest: AudioNode,
  size = 1,
  t0 = ctx.currentTime,
) {
  const k = Math.min(4, Math.max(0.7, size));
  const deep = 1 / Math.sqrt(k);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 8;
  comp.ratio.value = 8;
  comp.attack.value = 0.002;
  comp.release.value = 0.4;
  comp.connect(dest);
  const out = ctx.createGain();
  out.gain.value = 0.9;
  out.connect(comp);

  // Noise buffers: white (crack, debris) and pink (roar, rumble), 3 s, looped.
  const sr = ctx.sampleRate;
  const white = ctx.createBuffer(1, sr * 3, sr);
  const pink = ctx.createBuffer(1, sr * 3, sr);
  const w = white.getChannelData(0);
  const p = pink.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < w.length; i++) {
    const x = Math.random() * 2 - 1;
    w[i] = x;
    b0 = 0.99765 * b0 + x * 0.099046;
    b1 = 0.963 * b1 + x * 0.2965164;
    b2 = 0.57 * b2 + x * 1.0526913;
    p[i] = (b0 + b1 + b2 + x * 0.1848) * 0.22;
  }
  const noise = (buf: AudioBuffer, at: number, dur: number) => {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start(at, Math.random() * 2.5);
    s.stop(at + dur);
    return s;
  };
  const env = (g: GainNode, at: number, peak: number, attack: number, decay: number) => {
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  };
  const filter = (type: BiquadFilterType, f: number, q = 0.7) => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  };

  // 1. Crack: a short broadband snap.
  {
    const g = ctx.createGain();
    env(g, t0, 0.9, 0.002, 0.06);
    noise(white, t0, 0.1).connect(filter('highpass', 900)).connect(g).connect(out);
  }
  // 2. Boom: sine falling 70 -> 25 Hz plus low noise, the chest punch.
  {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(75 * deep, t0);
    o.frequency.exponentialRampToValueAtTime(24 * deep, t0 + 0.9);
    const g = ctx.createGain();
    env(g, t0, 1.0, 0.006, 1.4 * Math.sqrt(k));
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + 2.5 * Math.sqrt(k));
    const g2 = ctx.createGain();
    env(g2, t0, 0.8, 0.01, 1.2 * Math.sqrt(k));
    noise(pink, t0, 3)
      .connect(filter('lowpass', 160 * deep))
      .connect(g2)
      .connect(out);
  }
  // 3. Fireball roar: bright at first, dull after a few seconds.
  {
    const lp = filter('lowpass', 2400);
    lp.frequency.setValueAtTime(2400, t0);
    lp.frequency.exponentialRampToValueAtTime(220, t0 + 3 * Math.sqrt(k));
    const g = ctx.createGain();
    env(g, t0, 0.55, 0.03, 3.2 * Math.sqrt(k));
    noise(pink, t0, 4 * Math.sqrt(k) + 0.5)
      .connect(lp)
      .connect(g)
      .connect(out);
  }
  // 4. Rumble: rolling through the valley, swelling a little now and then.
  {
    const dur = 6 * Math.sqrt(k);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.25);
    let t = t0 + 0.25;
    let level = 0.5;
    while (t < t0 + dur) {
      t += 0.4 + Math.random() * 0.8;
      level *= 0.62 + Math.random() * 0.3;
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * (0.8 + Math.random() * 0.5)), t);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.5);
    noise(pink, t0, dur + 0.6)
      .connect(filter('lowpass', 95 * deep))
      .connect(g)
      .connect(out);
  }
  // 5. Debris: metal pings and dull thuds, falling over ~3 s.
  {
    const n = Math.round(16 + 10 * k);
    for (let i = 0; i < n; i++) {
      const at = t0 + 0.15 + Math.random() ** 1.6 * 3 * Math.sqrt(k);
      const metal = Math.random() < 0.55;
      const g = ctx.createGain();
      env(
        g,
        at,
        (metal ? 0.18 : 0.35) * (0.4 + Math.random() * 0.6),
        0.002,
        metal ? 0.05 + Math.random() * 0.12 : 0.08,
      );
      const bp = metal
        ? filter('bandpass', 900 + Math.random() * 2600, 10 + Math.random() * 12)
        : filter('bandpass', 110 + Math.random() * 200, 1.5);
      noise(white, at, 0.3).connect(bp).connect(g).connect(out);
    }
  }
  // 6. Fire crackle: sparse pops, thinning out over ~10 s.
  {
    const pops = Math.round(40 * Math.sqrt(k));
    for (let i = 0; i < pops; i++) {
      const at = t0 + 0.4 + Math.random() ** 1.8 * 10;
      const g = ctx.createGain();
      env(g, at, 0.05 + Math.random() * 0.07, 0.001, 0.008 + Math.random() * 0.02);
      noise(white, at, 0.05)
        .connect(filter('highpass', 1800 + Math.random() * 2500))
        .connect(g)
        .connect(out);
    }
  }
}

/** Delay between the impact (the aircraft breaking up) and the fuel exploding, s. */
export const EXPLOSION_DELAY = 0.45;

/**
 * A crash in two acts: the impact - a heavy thud, metal tearing and crumpling, parts
 * scraping over the ground - and, EXPLOSION_DELAY later, the fuel exploding.
 */
export function synthCrash(
  ctx: BaseAudioContext,
  dest: AudioNode,
  size = 1,
  t0 = ctx.currentTime,
  severity: 1 | 2 | 3 = 3,
) {
  const k = Math.min(4, Math.max(0.7, size));
  const sr = ctx.sampleRate;
  const white = ctx.createBuffer(1, sr * 2, sr);
  const w = white.getChannelData(0);
  for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value = 6;
  comp.attack.value = 0.002;
  comp.connect(dest);
  const out = ctx.createGain();
  // Without an explosion the grinding carries the crash: louder.
  out.gain.value = severity === 1 ? 2.6 : 0.8;
  out.connect(comp);
  const burst = (
    at: number,
    f: number,
    q: number,
    peak: number,
    decay: number,
    type: BiquadFilterType = 'bandpass',
  ) => {
    const s = ctx.createBufferSource();
    s.buffer = white;
    s.loop = true;
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.003 + decay);
    s.connect(b).connect(g).connect(out);
    s.start(at, Math.random() * 1.5);
    s.stop(at + decay + 0.05);
    return b;
  };
  // Impact: a deep thud (the airframe hitting the ground).
  burst(t0, 90 / Math.sqrt(k), 0.9, 1.0, 0.35, 'lowpass');
  burst(t0 + 0.01, 220, 1.2, 0.6, 0.2);
  // Metal tearing and crumpling: a cluster of hard, resonant crunches.
  for (let i = 0; i < 14; i++) {
    const at = t0 + 0.02 + Math.random() * 0.35;
    burst(
      at,
      400 + Math.random() * 1800,
      4 + Math.random() * 8,
      0.25 + Math.random() * 0.3,
      0.03 + Math.random() * 0.08,
    );
  }
  // A screech of tearing sheet metal (sweeping, rough).
  {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(900 + Math.random() * 400, t0 + 0.05);
    o.frequency.exponentialRampToValueAtTime(260, t0 + 0.55);
    const wob = ctx.createOscillator();
    wob.frequency.value = 37;
    const wobDepth = ctx.createGain();
    wobDepth.gain.value = 120;
    wob.connect(wobDepth).connect(o.frequency);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
    o.connect(bp).connect(g).connect(out);
    o.start(t0 + 0.05);
    wob.start(t0 + 0.05);
    o.stop(t0 + 0.65);
    wob.stop(t0 + 0.65);
  }
  // Parts scraping and sliding over the ground for a second or two.
  {
    const s = ctx.createBufferSource();
    s.buffer = white;
    s.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    // A whole airframe sliding on its belly grinds for seconds.
    const end = t0 + (severity === 1 ? 4.5 : 1.2 + 0.4 * k);
    g.gain.setValueAtTime(0.0001, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.15);
    for (let t = t0 + 0.2; t < end; t += 0.07 + Math.random() * 0.1)
      g.gain.exponentialRampToValueAtTime(0.03 + Math.random() * 0.1, t);
    g.gain.exponentialRampToValueAtTime(0.0001, end + 0.3);
    s.connect(bp).connect(g).connect(out);
    s.start(t0 + 0.05, Math.random());
    s.stop(end + 0.4);
  }
  // A mild crash does not explode; a medium one burns up smaller.
  if (severity > 1)
    synthExplosion(ctx, dest, severity === 2 ? size * 0.6 : size, t0 + EXPLOSION_DELAY);
}

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
    windGain: GainNode;
    windFilter: BiquadFilterNode;
    cockpit: BiquadFilterNode;
    warnOsc: OscillatorNode;
    warnGain: GainNode;
    servoOsc: OscillatorNode;
    servoGain: GainNode;
  };
  private volume = 0.7;
  private engine: EngineProfile = {
    kind: 'turboprop',
    display: 'rpm',
    idle: 0,
    max: 1,
    blades: 4,
    maxRps: 30,
  };
  private amDepth?: GainNode;
  /** Engine synthesizer (AudioWorklet), once loaded. */
  private synth?: { node: AudioWorkletNode; gain: GainNode };
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

    // 2 s of pink noise (falls off 3 dB per octave like real wind and roar; white noise
    // sounds like hiss or a vacuum cleaner), looped by every noise source.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    }
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

    // Propeller: blade-pass triangle + sub octave, low-passed: the "thrum". (A sawtooth has
    // strong overtones up to 1-2 kHz, which sound like singing/whistling.)
    const propOsc = ctx.createOscillator();
    propOsc.type = 'triangle';
    const propSub = ctx.createOscillator();
    propSub.type = 'sine';
    const propFilter = ctx.createBiquadFilter();
    propFilter.type = 'lowpass';
    propFilter.Q.value = 0.5;
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
    amDepth.gain.value = MIX[this.engine.kind].am;
    this.amDepth = amDepth;
    amOsc.connect(amDepth).connect(roarAm.gain);
    roarAm.gain.value = 0.65;
    const roarGain = ctx.createGain();
    roarGain.gain.value = 0;
    noiseSource().connect(roarFilter).connect(roarAm).connect(roarGain).connect(cockpit);

    // Wind: noise through a band-pass that rises with speed.
    const windFilter = ctx.createBiquadFilter();
    // Low-pass, not band-pass: a resonant band over noise sounds like whistling.
    windFilter.type = 'lowpass';
    windFilter.Q.value = 0.3;
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

    for (const o of [propOsc, propSub, amOsc, warnOsc, servoOsc]) o.start();
    void this.loadSynth(ctx, cockpit);
    this.nodes = {
      propOsc,
      propSub,
      propGain,
      propFilter,
      roarGain,
      roarFilter,
      roarAm,
      amOsc,
      windGain,
      windFilter,
      cockpit,
      warnOsc,
      warnGain,
      servoOsc,
      servoGain,
    };
  }

  /** The engine synthesizer; the simple graph stays as the fallback. */
  private async loadSynth(ctx: AudioContext, out: AudioNode) {
    if (!ctx.audioWorklet) return;
    try {
      await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}audio/engine-worklet.js`);
      if (this.ctx !== ctx) return;
      const node = new AudioWorkletNode(ctx, 'engine-sound', { outputChannelCount: [1] });
      const gain = ctx.createGain();
      gain.gain.value = 0;
      node.connect(gain).connect(out);
      this.synth = { node, gain };
      this.sendEngine();
    } catch (err) {
      console.warn('engine sound', err);
    }
  }

  private sendEngine() {
    const e = this.engine;
    this.synth?.node.port.postMessage({ kind: e.kind, blades: e.blades, cylinders: CYLINDERS });
  }

  /** Engine of the current aircraft type. */
  setEngine(e: EngineProfile) {
    this.engine = e;
    if (this.amDepth) this.amDepth.gain.value = MIX[e.kind].am;
    this.sendEngine();
  }

  update(dt: number, s: AudioState) {
    const ctx = this.ctx;
    const n = this.nodes;
    if (!ctx || !n) return;
    const mute = s.paused ? 0 : 1;

    // Doppler in outside views: the aircraft sounds higher when it comes closer.
    const doppler = Math.min(1.25, Math.max(0.8, SOUND / (SOUND - s.approach)));
    const mix = MIX[this.engine.kind];
    const rps = s.rpm * this.engine.maxRps;
    const blade = Math.max(rps * this.engine.blades, 1) * doppler;
    smooth(n.propOsc.frequency, blade, ctx);
    smooth(n.propSub.frequency, blade / 2, ctx);
    // Jets pulse slowly with the spool; pistons and props with the blade pass.
    smooth(n.amOsc.frequency, mix.am > 0.2 ? blade : 6 + 10 * s.throttle, ctx);
    smooth(
      n.propFilter.frequency,
      mix.propLp[0] + (mix.propLp[1] - mix.propLp[0]) * s.throttle,
      ctx,
    );
    const running = s.rpm > 0.05 ? 1 : 0;
    // With the synthesizer the old engine graph is silent.
    const legacy = this.synth ? 0 : 1;
    const syn = this.synth;
    if (syn) {
      const p = syn.node.parameters;
      smooth(p.get('rps')!, s.rpm * this.engine.maxRps, ctx, 0.1);
      smooth(p.get('load')!, s.throttle, ctx, 0.1);
      p.get('boost')!.setValueAtTime(s.boost ? 1 : 0, ctx.currentTime);
      smooth(p.get('pitch')!, doppler, ctx, 0.1);
      smooth(syn.gain.gain, mute * running * 0.42, ctx, 0.15);
    }
    smooth(
      n.propGain.gain,
      legacy * mute * running * mix.prop * (0.1 + 0.14 * s.throttle),
      ctx,
      0.15,
    );
    smooth(
      n.roarFilter.frequency,
      (mix.roarLo + (mix.roarHi - mix.roarLo) * s.throttle - (s.boost ? 120 : 0)) * doppler,
      ctx,
    );
    smooth(
      n.roarGain.gain,
      legacy * mute * running * mix.roar * (0.05 + 0.16 * s.throttle + (s.boost ? 0.12 : 0)),
      ctx,
      0.15,
    );

    const v = Math.min(1.6, s.speed / 100);
    smooth(n.windFilter.frequency, 160 + 440 * v, ctx);
    smooth(n.windGain.gain, mute * (s.onGround ? 0.3 : 1) * 0.22 * v * v, ctx, 0.2);
    smooth(n.cockpit.frequency, s.inside ? INSIDE_CUTOFF[this.engine.kind] : 6000, ctx, 0.1);

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

  /** Challenge sounds: a bright ding per ring, a rising arpeggio at the finish, a low buzz on a miss. */
  chime(kind: 'gate' | 'last' | 'finish' | 'miss') {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const notes: Record<typeof kind, number[]> = {
      gate: [1318.5, 1975.5],
      last: [1318.5, 1760, 2637],
      finish: [784, 988, 1175, 1568],
      miss: [220, 196],
    };
    notes[kind].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = kind === 'miss' ? 'square' : 'sine';
      const at = t + i * (kind === 'finish' ? 0.11 : 0.07);
      const len = kind === 'miss' ? 0.18 : 0.45;
      o.frequency.setValueAtTime(f, at);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(kind === 'miss' ? 0.05 : 0.12, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(g).connect(this.master!);
      o.start(at);
      o.stop(at + len + 0.05);
    });
  }

  /** The aircraft breaks up and explodes (size ~ length / 10 m). */
  crash(size = 1, severity: 1 | 2 | 3 = 3) {
    if (!this.ctx || !this.master) return;
    synthCrash(this.ctx, this.master, size, this.ctx.currentTime, severity);
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
    this.synth = undefined;
  }

  /** For tests/debugging: whether the audio graph runs. */
  get state(): string {
    return this.ctx?.state ?? 'not-started';
  }
}
