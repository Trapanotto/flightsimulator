// Engine sound synthesis, sample by sample (AudioWorklet; used by src/audio/FlightAudio.ts).
//
// Instead of filtered white noise (which sounds like a vacuum cleaner) the sound is built
// from what makes it in reality:
//   piston     exhaust pulses: 2 per crank revolution (4 cylinders), each a decaying burst
//              that rings the exhaust pipe, slightly different every time (the "burble"),
//              plus the propeller's blade pass
//   turboprop  propeller blade pass (a sharp, sawing pulse), turbine whine, exhaust rumble
//   jet        fan tone at the blade pass, "buzz-saw" harmonics at high N1, and a deep,
//              restless roar (pink noise, low-passed, with slow random swells)
//   fighter    deeper roar; afterburner adds a low rumble and crackle (random impulses)
//
// Parameters (k-rate): rps (shaft revolutions per second), load (engine output 0..1),
// boost (afterburner 0/1), pitch (Doppler factor). The engine kind, blade and cylinder
// counts come by message: { kind, blades, cylinders }.

const TAU = Math.PI * 2;

class Resonator {
  // Two-pole band-pass (exhaust pipe or body resonance).
  constructor(freq, q, fs) {
    this.y1 = 0;
    this.y2 = 0;
    this.set(freq, q, fs);
  }
  set(freq, q, fs) {
    const w = (TAU * freq) / fs;
    const r = Math.exp(-w / (2 * q));
    this.a1 = -2 * r * Math.cos(w);
    this.a2 = r * r;
    // Normalised: about unity gain at the resonance (an unscaled two-pole rings ~30x).
    this.g = (1 - r) * 2 * Math.sin(w);
  }
  step(x) {
    const y = this.g * x - this.a1 * this.y1 - this.a2 * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class Lowpass {
  // One-pole low-pass; cascade two for 12 dB/octave.
  constructor() {
    this.a = 0;
    this.b = 0;
    this.k = 0.1;
  }
  set(freq, fs) {
    this.k = 1 - Math.exp((-TAU * freq) / fs);
  }
  step(x) {
    this.a += (x - this.a) * this.k;
    this.b += (this.a - this.b) * this.k;
    return this.b;
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rps', defaultValue: 0, minValue: 0, maxValue: 200, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'boost', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const fs = sampleRate;
    this.fs = fs;
    this.kind = 'piston';
    this.blades = 2;
    this.cylinders = 4;
    this.seed = 22222;
    // Phases (0..1).
    this.shaft = 0;
    this.fire = 0;
    this.blade = 0;
    this.whine = 0;
    this.fanBuzz = 0;
    // Piston: current exhaust burst.
    this.burst = 0;
    this.burstAmp = 0;
    this.cyl = 0;
    // Each cylinder a little different (loping idle); fixed per engine.
    this.cylGain = [1, 0.86, 1.08, 0.93, 1.02, 0.9];
    this.burstDecay = Math.exp(-1 / (0.0042 * fs));
    this.pipeLo = new Resonator(115, 2.5, fs);
    this.pipeHi = new Resonator(390, 1.8, fs);
    this.body = new Resonator(70, 1.2, fs);
    this.lp = new Lowpass();
    this.propLp = new Lowpass();
    this.roarLp = new Lowpass();
    this.rumbleLp = new Lowpass();
    this.rumbleLp.set(110, fs);
    // Pink noise state (Paul Kellet's filter) and brown noise.
    this.p = [0, 0, 0, 0, 0, 0, 0];
    this.brown = 0;
    // Slow random swell of a jet roar.
    this.swell = 1;
    this.swellTarget = 1;
    this.swellTimer = 0;
    this.crackle = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.kind) this.kind = d.kind;
      if (d.blades) this.blades = d.blades;
      if (d.cylinders) this.cylinders = d.cylinders;
    };
  }

  rand() {
    // xorshift, -1..1
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return (this.seed / 4294967296) * 2 - 1;
  }

  pink() {
    const w = this.rand();
    const p = this.p;
    p[0] = 0.99886 * p[0] + w * 0.0555179;
    p[1] = 0.99332 * p[1] + w * 0.0750759;
    p[2] = 0.969 * p[2] + w * 0.153852;
    p[3] = 0.8665 * p[3] + w * 0.3104856;
    p[4] = 0.55 * p[4] + w * 0.5329522;
    p[5] = -0.7616 * p[5] - w * 0.016898;
    const out = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + w * 0.5362;
    p[6] = w * 0.115926;
    return out * 0.11;
  }

  brownNoise() {
    this.brown = (this.brown + 0.02 * this.rand()) * 0.998;
    return this.brown * 3.5;
  }

  /** Sharp periodic pressure pulse (a blade passing), zero mean, rich in harmonics. */
  pulse(phase, sharp) {
    const c = 0.5 - 0.5 * Math.cos(TAU * phase);
    return Math.pow(c, sharp) - 0.5 / Math.sqrt(sharp * 1.6);
  }

  process(_inputs, outputs, params) {
    const out = outputs[0][0];
    if (!out) return true;
    const fs = this.fs;
    const pitch = params.pitch[0];
    const rps = params.rps[0] * pitch;
    const load = params.load[0];
    const boost = params.boost[0];
    const running = rps > 0.5;
    const k = this.kind;
    const n = out.length;

    // Per-block filter settings.
    if (k === 'piston') {
      this.lp.set(500 + 1700 * load, fs);
      this.propLp.set(900 + 1400 * load, fs);
    } else if (k === 'turboprop') {
      this.lp.set(260 + 300 * load, fs);
      this.propLp.set(700 + 1600 * load, fs);
    } else {
      // Jet roar: the spectrum peak climbs with thrust, but stays low (no hiss).
      const deep = k === 'fighter' ? 0.7 : 1;
      this.roarLp.set((220 + 900 * load * load) * deep * (boost ? 0.75 : 1), fs);
      this.lp.set(180 + 200 * load, fs);
    }

    for (let i = 0; i < n; i++) {
      let s = 0;
      if (!running) {
        out[i] = 0;
        continue;
      }
      const shaftInc = rps / fs;
      this.shaft = (this.shaft + shaftInc) % 1;

      if (k === 'piston') {
        // Exhaust pulses: cylinders/2 per revolution, with a little timing jitter.
        const firing = (rps * this.cylinders) / 2;
        this.fire += (firing / fs) * (1 + 0.012 * this.rand());
        if (this.fire >= 1) {
          this.fire -= 1;
          this.cyl = (this.cyl + 1) % this.cylinders;
          // Idle is lumpy, full power even; louder with load.
          const lump = 1 + (1 - load) * 0.35 * this.rand();
          this.burstAmp = (0.35 + 0.65 * load) * this.cylGain[this.cyl] * lump;
          this.burst = 1;
        }
        // The burst: a sharp kick plus a short noise puff, decaying in ~4 ms.
        const env = this.burst;
        this.burst *= this.burstDecay;
        const exc = this.burstAmp * env * (0.6 + 0.6 * this.rand());
        const exhaust = this.pipeLo.step(exc) * 1.3 + this.pipeHi.step(exc) * 0.7;
        s += this.lp.step(exhaust + exc * 0.18);
        // Propeller: blade pass, sharper and louder with tip speed and load.
        this.blade = (this.blade + (rps * this.blades) / fs) % 1;
        const tip = Math.min(1, rps / 45);
        const prop = this.pulse(this.blade, 6) * (0.15 + 0.35 * load) * tip * tip;
        s += this.propLp.step(prop) * 0.9;
        s += this.body.step(this.brownNoise()) * 0.08 * (0.3 + load);
      } else if (k === 'turboprop') {
        // Propeller first: the big 5-blade prop saws (it dominates a PT6 aircraft).
        this.blade = (this.blade + (rps * this.blades) / fs) % 1;
        const tip = Math.min(1, rps / 28);
        // One blade a little different: a slow beat at the shaft frequency.
        const beat = 1 + 0.07 * Math.sin(TAU * this.shaft);
        const prop = this.pulse(this.blade, 9) * (0.22 + 0.5 * load) * (0.3 + 0.7 * tip * tip) * beat;
        s += this.propLp.step(prop) * 1.1;
        // Turbine whine: gas generator ~ 30-37k rpm -> 2-4 kHz tones, quiet.
        const wf = 1900 + 1900 * (0.55 + 0.45 * load) * pitch;
        this.whine = (this.whine + wf / fs) % 1;
        s += (Math.sin(TAU * this.whine) * 0.03 + Math.sin(TAU * this.whine * 2.02) * 0.01) * (0.7 + 0.3 * load);
        // Exhaust rumble.
        s += this.lp.step(this.pink()) * (0.25 + 0.55 * load);
      } else {
        // Jet: restless roar - pink noise, low-passed, swelling slowly at random.
        this.swellTimer -= 1;
        if (this.swellTimer <= 0) {
          this.swellTarget = 0.75 + 0.5 * Math.abs(this.rand());
          this.swellTimer = fs * (0.08 + 0.25 * Math.abs(this.rand()));
        }
        this.swell += (this.swellTarget - this.swell) * (6 / fs);
        const roar = this.roarLp.step(this.pink()) * 1.5;
        const rumble = this.rumbleLp.step(this.brownNoise()) * 0.8;
        s += (roar * (0.25 + 0.9 * load * load) + rumble * (0.2 + 0.6 * load)) * this.swell;
        // Fan: blade-pass tone; at high N1 the tips go supersonic -> buzz-saw (all shaft
        // harmonics, a raspy saw tooth at the shaft frequency).
        this.blade = (this.blade + (rps * this.blades) / fs) % 1;
        s += Math.sin(TAU * this.blade) * 0.035 * (0.3 + load);
        this.fanBuzz = (this.fanBuzz + rps / fs) % 1;
        const buzz = Math.max(0, (load - 0.72) / 0.28);
        s += this.lp.step((this.fanBuzz * 2 - 1) * 0.5) * 0.9 * buzz;
        // Core whine (high, faint).
        const wf = 3000 + 3500 * load;
        this.whine = (this.whine + (wf * pitch) / fs) % 1;
        s += Math.sin(TAU * this.whine) * 0.006 * (0.4 + load);
        if (k === 'fighter' && boost > 0) {
          // Afterburner: deeper rumble and crackle (sparse sharp pops).
          s += rumble * 0.9;
          if (Math.abs(this.rand()) > 0.9965) this.crackle = 0.6 + 0.4 * Math.abs(this.rand());
          s += this.crackle * this.rand();
          this.crackle *= 0.92;
        }
      }
      // Soft saturation instead of hard clipping (no crackle when it gets loud).
      out[i] = Math.tanh(s * 0.9);
    }
    // Same signal on all output channels.
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

registerProcessor('engine-sound', EngineProcessor);
