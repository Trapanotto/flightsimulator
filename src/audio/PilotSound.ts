/**
 * What the pilot outside the aircraft hears, synthesised: the rush of the air in free fall
 * (louder and brighter with the airspeed), the canopy cracking open at line stretch and
 * fluttering while it inflates, and a soft flutter of the fabric under the open canopy.
 */
import type { Parachutist } from '@sim';
import type { AudioEngine } from './AudioEngine';
import { glide, noiseLoop, seededRandom, silentGain } from './graph';

/** Loudness of the free-fall rush at terminal velocity (the master is ~0.7). */
const RUSH = 0.5;

export class PilotSound {
  private rush?: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode };
  private flutter?: { src: AudioBufferSourceNode; gain: GainNode; lfo: OscillatorNode };
  private wasDeploying = false;
  private active = false;

  constructor(private readonly audio: AudioEngine) {}

  private build() {
    const ctx = this.audio.audio;
    const out = this.audio.ambience;
    const src = noiseLoop(ctx, 1, 0.3);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.6;
    filter.frequency.value = 400;
    const gain = silentGain(ctx, out);
    src.connect(filter).connect(gain);
    this.rush = { src, filter, gain };
    // The fabric: low noise, amplitude-modulated by a fast flap.
    const fsrc = noiseLoop(ctx, 0.5, 1.1);
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 700;
    const am = ctx.createGain();
    am.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 11;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(am.gain);
    lfo.start();
    const fgain = silentGain(ctx, out);
    fsrc.connect(low).connect(am).connect(fgain);
    this.flutter = { src: fsrc, gain: fgain, lfo };
  }

  /** Per frame while the pilot is outside; `null` (seated again) silences it. */
  update(p: Parachutist | null) {
    if (!p) {
      if (this.active) this.silence();
      return;
    }
    if (!this.rush) this.build();
    this.active = true;
    const ctx = this.audio.audio;
    const now = ctx.currentTime;
    const v = p.state.velocity;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const flying = p.mode !== 'walk';
    const r = flying ? Math.min(1.4, speed / 55) : 0;
    glide(this.rush!.gain.gain, RUSH * r * r, now, 0.15);
    glide(this.rush!.filter.frequency, 250 + 900 * r, now, 0.2);
    const deploying = p.mode === 'canopy' && p.deploy < 1;
    if (deploying && !this.wasDeploying) this.crack();
    this.wasDeploying = deploying;
    // Inflating: a loud flapping; open: a light flutter that grows with the speed.
    const f = deploying ? 0.5 : p.mode === 'canopy' ? Math.min(0.12, (speed / 14) ** 2 * 0.08) : 0;
    glide(this.flutter!.gain.gain, f, now, deploying ? 0.05 : 0.4);
    glide(this.flutter!.lfo.frequency, deploying ? 14 : 6 + speed * 0.3, now, 0.3);
  }

  /** The snap of the pilot chute and the bag leaving the container. */
  private crack() {
    const ctx = this.audio.audio;
    const n = Math.round(ctx.sampleRate * 0.35);
    const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buffer.getChannelData(0);
    const rnd = seededRandom(31337);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      d[i] = (rnd() * 2 - 1) * Math.exp(-t / 0.06) * (1 + 0.6 * Math.sin(t * 2 * Math.PI * 40));
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = 0.6;
    src.connect(g).connect(this.audio.ambience);
    src.onended = () => g.disconnect();
    src.start();
  }

  private silence() {
    const now = this.audio.audio.currentTime;
    if (this.rush) glide(this.rush.gain.gain, 0, now, 0.1);
    if (this.flutter) glide(this.flutter.gain.gain, 0, now, 0.1);
    this.active = false;
    this.wasDeploying = false;
  }

  dispose() {
    this.rush?.src.stop();
    this.flutter?.src.stop();
    this.flutter?.lfo.stop();
    this.rush?.gain.disconnect();
    this.flutter?.gain.disconnect();
    this.rush = undefined;
    this.flutter = undefined;
  }
}
