/**
 * The sound of a crash, synthesised from its parts (no sound files), in two acts in step with
 * the picture (aircraft: Wreck): the impact – a heavy thud, metal tearing and crumpling, parts
 * scraping over the ground – and, EXPLOSION_DELAY later, the fuel exploding: a crack, a
 * sub-bass boom falling in pitch, the roar of the fireball turning dull, a rumble rolling
 * through the valley, debris clattering down and fire crackling for a while.
 *
 * `size` is about 1 for a light aircraft and up to 4 for a large one (louder, deeper, longer).
 * Everything runs through a compressor into the master output, so it can be loud without
 * clipping and follows the volume setting.
 */
import type { AudioEngine } from './AudioEngine';
import { noiseBuffer, seededRandom } from './graph';

/**
 * Delay between the impact and the fuel exploding, s. The same value as the wreck's in the
 * aircraft package (a test keeps them equal): the boom comes with the fireball.
 */
export const EXPLOSION_DELAY = 0.45;

const pinkCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** Pink noise, three seconds, made once per context: the raw material of roar and rumble. */
function pinkBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buffer = pinkCache.get(ctx);
  if (buffer) return buffer;
  buffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const p = buffer.getChannelData(0);
  const rnd = seededRandom(424242);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < p.length; i++) {
    const x = rnd() * 2 - 1;
    b0 = 0.99765 * b0 + x * 0.099046;
    b1 = 0.963 * b1 + x * 0.2965164;
    b2 = 0.57 * b2 + x * 1.0526913;
    p[i] = (b0 + b1 + b2 + x * 0.1848) * 0.22;
  }
  pinkCache.set(ctx, buffer);
  return buffer;
}

interface Kit {
  ctx: BaseAudioContext;
  rnd: () => number;
  noise(buf: AudioBuffer, at: number, dur: number): AudioBufferSourceNode;
  env(g: GainNode, at: number, peak: number, attack: number, decay: number): void;
  filter(type: BiquadFilterType, f: number, q?: number): BiquadFilterNode;
}

function kit(ctx: BaseAudioContext, rnd: () => number): Kit {
  return {
    ctx,
    rnd,
    noise(buf, at, dur) {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start(at, rnd() * (buf.duration - 0.5));
      s.stop(at + dur);
      return s;
    },
    env(g, at, peak, attack, decay) {
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    },
    filter(type, f, q = 0.7) {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    },
  };
}

function compressor(ctx: BaseAudioContext, dest: AudioNode, threshold: number, ratio: number) {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = threshold;
  comp.knee.value = 8;
  comp.ratio.value = ratio;
  comp.attack.value = 0.002;
  comp.release.value = 0.4;
  comp.connect(dest);
  return comp;
}

/** The fuel exploding at t0. */
export function synthExplosion(
  ctx: BaseAudioContext,
  dest: AudioNode,
  size = 1,
  t0 = ctx.currentTime,
  rnd: () => number = seededRandom(97),
) {
  const k = Math.min(4, Math.max(0.7, size));
  const deep = 1 / Math.sqrt(k);
  const long = Math.sqrt(k);
  const out = ctx.createGain();
  out.gain.value = 0.9;
  out.connect(compressor(ctx, dest, -14, 8));
  const white = noiseBuffer(ctx);
  const pink = pinkBuffer(ctx);
  const { noise, env, filter } = kit(ctx, rnd);

  // 1. Crack: a short broadband snap.
  {
    const g = ctx.createGain();
    env(g, t0, 0.9, 0.002, 0.06);
    noise(white, t0, 0.1).connect(filter('highpass', 900)).connect(g).connect(out);
  }
  // 2. Boom: a sine falling from 75 to 24 Hz and low noise, the punch in the chest.
  {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(75 * deep, t0);
    o.frequency.exponentialRampToValueAtTime(24 * deep, t0 + 0.9);
    const g = ctx.createGain();
    env(g, t0, 1.0, 0.006, 1.4 * long);
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + 2.5 * long);
    const g2 = ctx.createGain();
    env(g2, t0, 0.8, 0.01, 1.2 * long);
    noise(pink, t0, 3)
      .connect(filter('lowpass', 160 * deep))
      .connect(g2)
      .connect(out);
  }
  // 3. Fireball roar: bright at first, dull after a few seconds.
  {
    const lp = filter('lowpass', 2400);
    lp.frequency.setValueAtTime(2400, t0);
    lp.frequency.exponentialRampToValueAtTime(220, t0 + 3 * long);
    const g = ctx.createGain();
    env(g, t0, 0.55, 0.03, 3.2 * long);
    noise(pink, t0, 4 * long + 0.5)
      .connect(lp)
      .connect(g)
      .connect(out);
  }
  // 4. Rumble: rolling through the valley, swelling a little now and then.
  {
    const dur = 6 * long;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.25);
    let t = t0 + 0.25;
    let level = 0.5;
    while (t < t0 + dur) {
      t += 0.4 + rnd() * 0.8;
      level *= 0.62 + rnd() * 0.3;
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * (0.8 + rnd() * 0.5)), t);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    noise(pink, t0, t - t0 + 0.6)
      .connect(filter('lowpass', 95 * deep))
      .connect(g)
      .connect(out);
  }
  // 5. Debris: metal pings and dull thuds, falling over about three seconds.
  {
    const n = Math.round(16 + 10 * k);
    for (let i = 0; i < n; i++) {
      const at = t0 + 0.15 + rnd() ** 1.6 * 3 * long;
      const metal = rnd() < 0.55;
      const g = ctx.createGain();
      env(
        g,
        at,
        (metal ? 0.18 : 0.35) * (0.4 + rnd() * 0.6),
        0.002,
        metal ? 0.05 + rnd() * 0.12 : 0.08,
      );
      const bp = metal
        ? filter('bandpass', 900 + rnd() * 2600, 10 + rnd() * 12)
        : filter('bandpass', 110 + rnd() * 200, 1.5);
      noise(white, at, 0.3).connect(bp).connect(g).connect(out);
    }
  }
  // 6. Fire crackle: sparse pops, thinning out over about ten seconds.
  {
    const pops = Math.round(40 * long);
    for (let i = 0; i < pops; i++) {
      const at = t0 + 0.4 + rnd() ** 1.8 * 10;
      const g = ctx.createGain();
      env(g, at, 0.05 + rnd() * 0.07, 0.001, 0.008 + rnd() * 0.02);
      noise(white, at, 0.05)
        .connect(filter('highpass', 1800 + rnd() * 2500))
        .connect(g)
        .connect(out);
    }
  }
}

/**
 * A crash at t0: the impact, and for severity 2 and 3 the explosion EXPLOSION_DELAY later
 * (smaller for 2, when only a wing's fuel burns). Severity 1 does not explode: the grinding
 * of the sliding airframe carries it, louder and longer. `explode: false` for a crash into
 * water.
 */
export function synthCrash(
  ctx: BaseAudioContext,
  dest: AudioNode,
  size = 1,
  t0 = ctx.currentTime,
  severity: 1 | 2 | 3 = 3,
  explode = true,
  rnd: () => number = seededRandom(31),
) {
  const k = Math.min(4, Math.max(0.7, size));
  const white = noiseBuffer(ctx);
  const out = ctx.createGain();
  out.gain.value = severity === 1 || !explode ? 2.6 : 0.8;
  out.connect(compressor(ctx, dest, -12, 6));
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
    s.start(at, rnd() * 1.5);
    s.stop(at + decay + 0.05);
  };
  // Impact: a deep thud (the airframe hitting the ground).
  burst(t0, 90 / Math.sqrt(k), 0.9, 1.0, 0.35, 'lowpass');
  burst(t0 + 0.01, 220, 1.2, 0.6, 0.2);
  // Metal tearing and crumpling: a cluster of hard, resonant crunches.
  for (let i = 0; i < 14; i++) {
    const at = t0 + 0.02 + rnd() * 0.35;
    burst(at, 400 + rnd() * 1800, 4 + rnd() * 8, 0.25 + rnd() * 0.3, 0.03 + rnd() * 0.08);
  }
  // A screech of tearing sheet metal (sweeping, rough).
  {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(900 + rnd() * 400, t0 + 0.05);
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
  // Parts scraping and sliding over the ground; a whole airframe on its belly for seconds.
  {
    const s = ctx.createBufferSource();
    s.buffer = white;
    s.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    const end = t0 + (severity === 1 ? 4.5 : 1.2 + 0.4 * k);
    g.gain.setValueAtTime(0.0001, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.15);
    for (let t = t0 + 0.2; t < end; t += 0.07 + rnd() * 0.1)
      g.gain.exponentialRampToValueAtTime(0.03 + rnd() * 0.1, t);
    g.gain.exponentialRampToValueAtTime(0.0001, end + 0.3);
    s.connect(bp).connect(g).connect(out);
    s.start(t0 + 0.05, rnd());
    s.stop(end + 0.4);
  }
  if (severity > 1 && explode)
    synthExplosion(ctx, dest, severity === 2 ? size * 0.6 : size, t0 + EXPLOSION_DELAY, rnd);
}

export interface CrashSoundOptions {
  /** Distance from the listener (camera) to the crash, m: quieter and duller far away. */
  distance?: number;
  /** Into water: a splash and crunch, no explosion. */
  water?: boolean;
  /** Seed of the random parts (a replay sounds the same). */
  seed?: number;
}

/** Plays crashes through the engine's master output (and so its volume and mute). */
export class CrashSound {
  constructor(private readonly audio: AudioEngine) {}

  /**
   * At the moment of the impact (the wreck is created in the same frame). `size` is the
   * aircraft's length over 10 m.
   */
  play(severity: 1 | 2 | 3, size: number, options: CrashSoundOptions = {}) {
    const ctx = this.audio.audio;
    const d = Math.max(0, options.distance ?? 0);
    // Spherical spreading beyond a near field, and the air takes the highs over distance.
    const level = Math.min(1, 60 / Math.max(60, d));
    const g = ctx.createGain();
    g.gain.value = level;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(600, 18000 / (1 + d / 400));
    lp.connect(g).connect(this.audio.output);
    // Taken apart once everything has played (the explosion's rumble lasts longest).
    const t0 = ctx.currentTime;
    synthCrash(ctx, lp, size, t0, severity, !options.water, seededRandom(options.seed || 31));
    const end = t0 + EXPLOSION_DELAY + 14 * Math.sqrt(Math.min(4, Math.max(0.7, size)));
    const stop = ctx.createConstantSource();
    stop.offset.value = 0;
    stop.connect(g);
    stop.onended = () => {
      g.disconnect();
      lp.disconnect();
      stop.disconnect();
    };
    stop.start(t0);
    stop.stop(end);
  }
}
