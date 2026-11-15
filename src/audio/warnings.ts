/**
 * Prerendered warning sounds and mechanical impacts of the larger types. Each is rendered
 * once per context; the loops are played by one looping source each, keyed by its gain, so a
 * warning never builds nodes while it sounds.
 */
import { impactBuffer, seededRandom } from './graph';

export interface AlertBuffers {
  /** PC-12 stick shaker: the eccentric motor rattling the column, about 17 Hz. */
  shaker: AudioBuffer;
  /** Airbus stall warning cricket: bursts of a harsh high chirp. */
  cricket: AudioBuffer;
  /** Fighter warning tone: a fast high beeping. */
  tone: AudioBuffer;
  /** Overspeed clacker: a mechanical clack eight times a second. */
  clacker: AudioBuffer;
  /** Altitude alert: a soft chord chime, once. */
  chime: AudioBuffer;
  /** The gear reaching its lock. */
  gearLock: AudioBuffer;
  /** The afterburner lighting: a deep thump. */
  burnerThump: AudioBuffer;
}

/** Pattern rates, Hz. Each loop holds whole periods, so its seam falls between two strikes. */
export const SHAKER_HZ = 17;
export const CLACKER_HZ = 8;

/** Renders `length` seconds through `fn(t)` into a buffer, faded at the ends. */
function render(
  ctx: BaseAudioContext,
  length: number,
  fn: (t: number, i: number) => number,
  fadeEnds = true,
): AudioBuffer {
  const fs = ctx.sampleRate;
  const n = Math.round(length * fs);
  const buffer = ctx.createBuffer(1, n, fs);
  const d = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    d[i] = fn(i / fs, i);
    peak = Math.max(peak, Math.abs(d[i]!));
  }
  const fade = fadeEnds ? Math.min(n >> 1, Math.round(0.003 * fs)) : 0;
  for (let i = 0; i < n; i++) {
    d[i]! /= peak || 1;
    if (i < fade) d[i]! *= i / fade;
    if (i >= n - fade) d[i]! *= (n - 1 - i) / fade;
  }
  return buffer;
}

/** A train of short struck bursts at `rate` per second, each ringing at the given modes. */
function strikes(
  ctx: BaseAudioContext,
  length: number,
  rate: number,
  modes: readonly { hz: number; decay: number; gain: number }[],
  noise: number,
  seed: number,
): AudioBuffer {
  const rnd = seededRandom(seed);
  const period = 1 / rate;
  // One random variation per strike keeps a rattle from sounding like a buzzer.
  const vary = Array.from({ length: Math.ceil(length * rate) + 1 }, () => 0.75 + 0.5 * rnd());
  return render(
    ctx,
    length,
    (t) => {
      const k = Math.floor(t / period);
      const local = t - k * period;
      const g = vary[k] ?? 1;
      let s = noise * (rnd() * 2 - 1) * Math.exp(-local / 0.002);
      for (const m of modes)
        s += m.gain * Math.sin(2 * Math.PI * m.hz * local) * Math.exp(-local / m.decay);
      return s * g;
    },
    false,
  );
}

export function alertBuffers(ctx: BaseAudioContext): AlertBuffers {
  const shaker = strikes(
    ctx,
    1,
    SHAKER_HZ,
    [
      { hz: 140, decay: 0.012, gain: 1 },
      { hz: 420, decay: 0.006, gain: 0.5 },
      { hz: 1100, decay: 0.002, gain: 0.25 },
    ],
    0.6,
    31,
  );
  const clacker = strikes(
    ctx,
    1,
    CLACKER_HZ,
    [
      { hz: 1900, decay: 0.006, gain: 1 },
      { hz: 650, decay: 0.01, gain: 0.6 },
    ],
    0.8,
    32,
  );
  // Cricket: four rasping chirps in half a second, then a pause.
  const cricket = render(
    ctx,
    1,
    (t) => {
      const k = Math.floor(t / 0.11);
      const local = t - k * 0.11;
      if (k > 3 || local > 0.07) return 0;
      const env = Math.sin((Math.PI * local) / 0.07) ** 2;
      // A square-ish tone with a fast flutter: the insect-like rasp.
      const tone =
        Math.sign(Math.sin(2 * Math.PI * 2900 * t)) * 0.6 + Math.sin(2 * Math.PI * 4350 * t) * 0.4;
      return tone * env * (0.6 + 0.4 * Math.sin(2 * Math.PI * 60 * t));
    },
    false,
  );
  const tone = render(
    ctx,
    0.4,
    (t) => {
      const on = t % 0.2 < 0.12;
      const env = on ? Math.min(1, (t % 0.2) / 0.004, (0.12 - (t % 0.2)) / 0.004) : 0;
      return (
        env * (Math.sin(2 * Math.PI * 1000 * t) * 0.8 + Math.sin(2 * Math.PI * 3000 * t) * 0.2)
      );
    },
    false,
  );
  // A major chord struck like a bell: the soft chime of the altitude alert.
  const chime = render(ctx, 1.6, (t) => {
    const notes = [523.25, 659.25, 783.99];
    let s = 0;
    for (const f of notes)
      s +=
        (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t)) *
        Math.exp(-t / 0.55);
    return s * Math.min(1, t / 0.004);
  });
  const gearLock = impactBuffer(
    ctx,
    [
      { hz: 75, decay: 0.05, gain: 1 },
      { hz: 230, decay: 0.02, gain: 0.6 },
      { hz: 900, decay: 0.006, gain: 0.3 },
    ],
    0.25,
    0.5,
    0.004,
    41,
  );
  const burnerThump = impactBuffer(
    ctx,
    [
      { hz: 38, decay: 0.12, gain: 1 },
      { hz: 65, decay: 0.07, gain: 0.7 },
      { hz: 160, decay: 0.03, gain: 0.3 },
    ],
    0.45,
    0.8,
    0.02,
    42,
  );
  return { shaker, cricket, tone, clacker, chime, gearLock, burnerThump };
}
