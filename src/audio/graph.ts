/** Shared building blocks of the sound graphs: buffers made once per context, gain shaping. */
import type { EnvelopePoint } from './keying';

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** Seeded generator (Park-Miller): every run sounds the same. */
export function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/** White noise, two seconds, looped: the raw material of wind, rumble, static and rain. */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buffer = noiseCache.get(ctx);
  if (buffer) return buffer;
  buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rnd = seededRandom(1234567);
  for (let i = 0; i < data.length; i++) data[i] = rnd() * 2 - 1;
  noiseCache.set(ctx, buffer);
  return buffer;
}

/** A looping noise source, started at once. */
export function noiseLoop(ctx: BaseAudioContext, rate = 1, offset = 0): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  src.playbackRate.value = rate;
  src.start(0, offset);
  return src;
}

/**
 * A short mechanical transient: a few damped resonances (the metal parts) struck by a burst of
 * noise. Rendered once into a buffer; playing it is one cheap source node per event.
 */
export function impactBuffer(
  ctx: BaseAudioContext,
  modes: readonly { hz: number; decay: number; gain: number }[],
  length: number,
  noise = 0.3,
  noiseDecay = 0.002,
  seed = 99,
): AudioBuffer {
  const n = Math.max(1, Math.round(length * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buffer.getChannelData(0);
  const rnd = seededRandom(seed);
  const fs = ctx.sampleRate;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    let s = noise * (rnd() * 2 - 1) * Math.exp(-t / noiseDecay);
    for (const m of modes) s += m.gain * Math.sin(2 * Math.PI * m.hz * t) * Math.exp(-t / m.decay);
    d[i] = s;
    peak = Math.max(peak, Math.abs(s));
  }
  // Normalised, and faded to zero at the end so the buffer never stops on a step.
  const fade = Math.min(n, Math.round(0.002 * fs));
  for (let i = 0; i < n; i++) {
    d[i]! /= peak || 1;
    if (i >= n - fade) d[i]! *= (n - 1 - i) / fade;
  }
  return buffer;
}

/** Plays a buffer once at `when` with a gain; the nodes free themselves after it ends. */
export function playOnce(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  to: AudioNode,
  gain: number,
  when = ctx.currentTime,
  rate = 1,
) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(to);
  src.onended = () => g.disconnect();
  src.start(when);
}

/** Smoothly towards a value: never a jump, so never a click. */
export function glide(param: AudioParam, value: number, now: number, tau = 0.05) {
  param.setTargetAtTime(value, now, tau);
}

/**
 * Writes envelope breakpoints as linear ramps. A point equal to the one before is a hold,
 * set rather than ramped, so the ramp to the next point starts there and not earlier. Only
 * for params driven by envelopes alone: a ramp after a setTargetAtTime is ill-defined.
 */
export function applyEnvelope(param: AudioParam, points: readonly EnvelopePoint[], from = 0) {
  let last = from;
  points.forEach((p, i) => {
    if (i === 0 || p.value === last) param.setValueAtTime(p.value, p.time);
    else param.linearRampToValueAtTime(p.value, p.time);
    last = p.value;
  });
}

/** A gain node at zero. */
export function silentGain(ctx: BaseAudioContext, to?: AudioNode): GainNode {
  const g = ctx.createGain();
  g.gain.value = 0;
  if (to) g.connect(to);
  return g;
}
