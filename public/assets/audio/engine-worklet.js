// Engine sound synthesis, sample by sample (AudioWorklet; used by src/audio/AircraftSound.ts).
//
// Instead of filtered white noise (which sounds like a vacuum cleaner) the sound is built
// from what makes it in reality:
//   piston       exhaust pulses: 2 per crank revolution (4 cylinders), each a decaying burst
//                that rings the exhaust pipe, slightly different every time (the "burble"),
//                plus the propeller's blade pass
//   turboprop    propeller blade pass (a sharp, sawing pulse whose harmonics grow with the
//                blade loading and fade when feathered), its growl in beta, the compressor
//                whine of the gas generator, exhaust rumble, starter and igniters
//   turbofan     fan tone at the blade pass, buzz-saw (the shocks of the supersonic fan tips,
//                a little different on every blade, so every shaft order sounds), compressor
//                whine, a deep restless roar (pink noise, low-passed, slow random swells),
//                reverser roar, bleed air and igniters while starting
//   afterburning the same, harder, and the afterburner's crackle: amplitude-modulated noise
//                and sharp pops over a strong low rumble
//
// One node renders every engine of the aircraft, one output channel each (the mobile budget
// allows one worklet). Parameters (k-rate) per engine, suffixed with the engine index from the
// second engine on (rps, rps1): rps (propeller or fan shaft, revolutions per second), and
//   piston: load (output 0..1), firing (share of strokes that burn: 0 cranking or
//           windmilling, about half while it catches, 1 running), starter (0/1), boost
//   turbine: core (gas generator, rev/s), tone, buzz, whine, roar, roarHz, rumble, crackle,
//           beta, ignite, feather, starter: the levels decided by src/audio/turbine.ts
// and pitch (Doppler factor, shared). The engine kind, blade and cylinder counts and the
// compressor stage counts come by message: { kind, blades, cylinders, orders }.

const TAU = Math.PI * 2;
const MAX_ENGINES = 2;
const PER_ENGINE = [
  'rps',
  'load',
  'boost',
  'firing',
  'starter',
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
];
const NAMES = [];
for (let e = 0; e < MAX_ENGINES; e++) NAMES.push(PER_ENGINE.map((k) => (e === 0 ? k : `${k}${e}`)));
const DEFAULTS = { firing: 1, roarHz: 400 };
const MAX = { rps: 400, core: 400, roarHz: 8000 };

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

/** One engine: all the state of its synthesis. */
class Voice {
  constructor(fs, seed, detune) {
    this.fs = fs;
    this.seed = seed;
    // Twin engines never turn at quite the same speed: the slow beat between them.
    this.detune = detune;
    // Phases (0..1).
    this.shaft = 0;
    this.fire = 0;
    this.blade = 0;
    this.whine = 0;
    this.whine2 = 0;
    this.fanBuzz = 0;
    this.gear = 0;
    this.motor = 0;
    this.howl = 0;
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
    this.buzzLp = new Lowpass();
    this.buzzLp.set(2400, fs);
    this.hissLp = new Lowpass();
    this.hissLp.set(1500, fs);
    this.growl = new Resonator(380, 1.6, fs);
    this.reverser = new Resonator(900, 0.9, fs);
    this.tick = new Resonator(3200, 6, fs);
    // Pink noise state (Paul Kellet's filter) and brown noise.
    this.p = [0, 0, 0, 0, 0, 0, 0];
    this.brown = 0;
    // Slow random swell of a jet roar.
    this.swell = 1;
    this.swellTarget = 1;
    this.swellTimer = 0;
    this.crackle = 0;
    // Afterburner: the fast random envelope of the burning flow.
    this.am = 1;
    this.amTarget = 1;
    this.amTimer = 0;
    // Igniters: time to the next spark, and its decaying burst.
    this.spark = 0;
    this.sparkEnv = 0;
    this.sparkDecay = Math.exp(-1 / (0.0015 * fs));
    // Shock strength of every fan blade: no two tips are quite the same. Drawn from a
    // generator of their own, so the noise sequence of the voice stays as it was.
    this.shocks = [];
    let s = seed ^ 0x5bd1e995;
    for (let i = 0; i < 64; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      this.shocks.push(0.25 + 0.75 * ((s >>> 0) / 4294967296));
    }
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

  /** The cylinders' exhaust and the propeller, as the Cessna has always sounded. */
  piston(out, n, v, pitch, blades, cylinders) {
    const fs = this.fs;
    const rps = v.rps * pitch;
    const load = v.load;
    const firing = v.firing;
    const starter = v.starter;
    this.lp.set(500 + 1700 * load, fs);
    this.propLp.set(900 + 1400 * load, fs);
    if (!(rps > 0.5)) {
      out.fill(0);
      return;
    }
    for (let i = 0; i < n; i++) {
      let s = 0;
      const shaftInc = rps / fs;
      this.shaft = (this.shaft + shaftInc) % 1;
      // Without combustion every compression stroke brakes the crank and the next one lets
      // it run on: the uneven chug of a cranking or windmilling engine.
      const speed = 1 - 0.4 * (1 - firing) * Math.cos(TAU * this.fire);
      // Exhaust pulses: cylinders/2 per revolution, with a little timing jitter.
      const strokes = (rps * cylinders) / 2;
      this.fire += ((strokes * speed) / fs) * (1 + 0.012 * this.rand());
      if (this.fire >= 1) {
        this.fire -= 1;
        this.cyl = (this.cyl + 1) % cylinders;
        if (firing >= 1 || (this.rand() + 1) / 2 < firing) {
          // Idle is lumpy, full power even; louder with load.
          const lump = 1 + (1 - load) * 0.35 * this.rand();
          this.burstAmp = (0.35 + 0.65 * load) * this.cylGain[this.cyl] * lump;
        } else {
          // A stroke that does not burn only puffs compressed air through the exhaust.
          this.burstAmp = 0.15 * this.cylGain[this.cyl];
        }
        this.burst = 1;
      }
      // The burst: a sharp kick plus a short noise puff, decaying in ~4 ms.
      const env = this.burst;
      this.burst *= this.burstDecay;
      const exc = this.burstAmp * env * (0.6 + 0.6 * this.rand());
      const exhaust = this.pipeLo.step(exc) * 1.3 + this.pipeHi.step(exc) * 0.7;
      s += this.lp.step(exhaust + exc * 0.18);
      // Propeller: blade pass, sharper and louder with tip speed and load.
      this.blade = (this.blade + (rps * blades * speed) / fs) % 1;
      const tip = Math.min(1, rps / 45);
      const prop = this.pulse(this.blade, 6) * (0.15 + 0.35 * load) * tip * tip;
      s += this.propLp.step(prop) * 0.9;
      s += this.body.step(this.brownNoise()) * 0.08 * (0.3 + load);
      if (starter > 0) {
        // Starter: the pinion meshing with the 149-tooth ring gear whines at 149 x the crank
        // speed; the motor itself turns about 16 times faster than the crank and hums.
        this.gear = (this.gear + (rps * 149 * speed) / fs) % 1;
        this.motor = (this.motor + (rps * 16 * speed) / fs) % 1;
        const st = starter * Math.min(1, rps / 3);
        s +=
          st *
          (this.pulse(this.gear, 4) * 0.15 +
            Math.sin(TAU * this.motor) * 0.1 +
            this.rand() * 0.025);
      }
      // Soft saturation instead of hard clipping (no crackle when it gets loud).
      out[i] = Math.tanh(s * 0.9);
    }
  }

  /** Compressor tones of the gas generator: each stage's blade count times the core shaft. */
  compressor(core, orders) {
    const fs = this.fs;
    const lim = 0.45 * fs;
    let s = 0;
    const f1 = core * orders[0];
    if (f1 < lim) {
      this.whine = (this.whine + f1 / fs) % 1;
      s += Math.sin(TAU * this.whine) * 0.6;
      if (2 * f1 < lim) s += Math.sin(2 * TAU * this.whine) * 0.18;
    }
    const f2 = core * (orders[1] ?? orders[0] * 1.6);
    if (f2 < lim) {
      this.whine2 = (this.whine2 + f2 / fs) % 1;
      s += Math.sin(TAU * this.whine2) * 0.3;
    }
    return s;
  }

  /** Igniters: a sharp snap a few times a second while they are on. */
  igniter(level) {
    if (level > 0) {
      this.spark -= 1;
      if (this.spark <= 0) {
        this.spark = this.fs / 2.6;
        this.sparkEnv = level;
      }
    }
    if (this.sparkEnv < 1e-5) return 0;
    this.sparkEnv *= this.sparkDecay;
    return this.tick.step(this.sparkEnv * this.rand()) * 4;
  }

  /** Nothing turns and no spark rings: the voice can skip its work. */
  silent(rps, core, v) {
    return rps < 0.05 && core < 0.5 && v.ignite <= 0 && v.rumble <= 0 && this.sparkEnv < 1e-5;
  }

  turboprop(out, n, v, pitch, blades, orders) {
    const fs = this.fs;
    const det = this.detune;
    const rps = v.rps * pitch * det;
    const core = v.core * pitch * det;
    // Blade loading and feathering: a loaded blade at fine pitch saws (sharp pulse, many
    // harmonics); a feathered blade only stirs the air.
    const sharp = 2 + 9 * (1 - v.feather) * Math.min(1, v.tone * 1.5);
    this.propLp.set(350 + 2600 * Math.min(1, v.tone) * (1 - 0.6 * v.feather), fs);
    this.lp.set(v.roarHz, fs);
    if (this.silent(rps, core, v)) {
      out.fill(0);
      return;
    }
    for (let i = 0; i < n; i++) {
      let s = 0;
      this.shaft = (this.shaft + rps / fs) % 1;
      this.blade = (this.blade + (rps * blades) / fs) % 1;
      // One blade a little different: a beat at the shaft frequency, deep in beta.
      const beat = 1 + (0.07 + 0.3 * v.beta) * Math.sin(TAU * this.shaft);
      const bp = this.pulse(this.blade, sharp);
      s += this.propLp.step(bp * v.tone * beat);
      if (v.beta > 0) {
        // Beta and reverse: the flat blades chop their own wake, a growl pulsing with each blade.
        const chop = 0.5 + 0.5 * Math.cos(TAU * this.blade);
        s += this.growl.step(this.rand()) * chop * beat * v.beta * 0.9;
      }
      if (v.whine > 0) s += this.compressor(core, orders) * v.whine * 0.06;
      s += this.lp.step(this.pink()) * v.roar * 0.6;
      if (v.rumble > 0) s += this.rumbleLp.step(this.brownNoise()) * v.rumble * 0.8;
      if (v.starter > 0) {
        // The starter-generator, geared to the gas generator: a rising electric whine.
        this.motor = (this.motor + (core * 9) / fs) % 1;
        s += Math.sin(TAU * this.motor) * 0.012 * v.starter * Math.min(1, core / 10);
      }
      s += this.igniter(v.ignite) * 0.25;
      out[i] = Math.tanh(s * 0.9);
    }
  }

  jet(out, n, v, pitch, blades, orders, afterburning) {
    const fs = this.fs;
    const det = this.detune;
    const rps = v.rps * pitch * det;
    const core = v.core * pitch * det;
    this.roarLp.set(Math.min(0.4 * fs, v.roarHz * pitch), fs);
    this.lp.set(Math.min(0.4 * fs, 1.6 * v.roarHz * pitch), fs);
    if (this.silent(rps, core, v)) {
      out.fill(0);
      return;
    }
    const nb = Math.min(64, blades);
    for (let i = 0; i < n; i++) {
      let s = 0;
      // Restless roar: pink noise, low-passed, swelling slowly at random.
      this.swellTimer -= 1;
      if (this.swellTimer <= 0) {
        this.swellTarget = 0.75 + 0.5 * Math.abs(this.rand());
        this.swellTimer = fs * (0.08 + 0.25 * Math.abs(this.rand()));
      }
      this.swell += (this.swellTarget - this.swell) * (6 / fs);
      const pink = this.pink();
      const roar = this.roarLp.step(pink) * 1.5;
      const rumble = this.rumbleLp.step(this.brownNoise());
      s += (roar * 0.6 * v.roar + rumble * (0.25 * v.roar + 0.5 * v.rumble)) * this.swell;
      // Fan: blade-pass tone; a fighter's idle howl wavers a little.
      const howl = afterburning ? 1 + 0.004 * Math.sin(TAU * this.howl) : 1;
      this.howl = (this.howl + 3.1 / fs) % 1;
      this.blade = (this.blade + (rps * blades * howl) / fs) % 1;
      s += (Math.sin(TAU * this.blade) + 0.3 * Math.sin(2 * TAU * this.blade)) * 0.1 * v.tone;
      if (v.buzz > 0) {
        // Buzz-saw: each blade's shock an N-wave of its own strength, once per revolution.
        this.fanBuzz = (this.fanBuzz + rps / fs) % 1;
        const pos = this.fanBuzz * nb;
        const k = Math.floor(pos);
        const nwave = (1 - 2 * (pos - k)) * this.shocks[k];
        s += this.buzzLp.step(nwave) * 0.4 * v.buzz;
      }
      if (v.whine > 0) s += this.compressor(core, orders) * 0.07 * v.whine;
      if (v.beta > 0) {
        // Reversers: the jet turned forward, a harsh broad roar higher than the jet itself.
        s += this.reverser.step(pink * 3) * v.beta * 0.55 * this.swell;
      }
      if (v.starter > 0) {
        // Bleed air rushing into the air starter, and the starter turbine's whine.
        const white = this.rand();
        s += (white - this.hissLp.step(white)) * 0.012 * v.starter;
        this.motor = (this.motor + (core * 7.3) / fs) % 1;
        s += Math.sin(TAU * this.motor) * 0.012 * v.starter * Math.min(1, core / 20);
      }
      if (afterburning && v.crackle > 0) {
        // The flame burning in lumps: noise with a fast random envelope, and sharp pops.
        this.amTimer -= 1;
        if (this.amTimer <= 0) {
          this.amTarget = 0.05 + 3 * Math.abs(this.rand()) ** 4;
          this.amTimer = fs * (0.004 + 0.016 * Math.abs(this.rand()));
        }
        this.am += (this.amTarget - this.am) * (400 / fs);
        s += this.lp.step(pink) * this.am * 1.4 * v.crackle;
        if (Math.abs(this.rand()) > 1 - 0.0025 * v.crackle)
          this.crackle = 0.5 + 0.5 * Math.abs(this.rand());
        s += this.crackle * this.rand() * 0.8 * v.crackle;
        this.crackle *= 0.9;
      }
      s += this.igniter(v.ignite) * 0.25;
      out[i] = Math.tanh(s * 0.9);
    }
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const list = [
      { name: 'pitch', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' },
    ];
    for (let e = 0; e < MAX_ENGINES; e++)
      PER_ENGINE.forEach((name, j) =>
        list.push({
          name: NAMES[e][j],
          defaultValue: DEFAULTS[name] ?? 0,
          minValue: 0,
          maxValue: MAX[name] ?? 1,
          automationRate: 'k-rate',
        }),
      );
    return list;
  }

  constructor() {
    super();
    this.kind = 'piston';
    this.blades = 2;
    this.cylinders = 4;
    this.orders = [15, 26];
    // The first engine keeps the seed the Cessna has always had.
    this.voices = [new Voice(sampleRate, 22222, 1), new Voice(sampleRate, 918273, 1.0035)];
    this.v = {};
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.kind) this.kind = d.kind;
      if (d.blades) this.blades = d.blades;
      if (d.cylinders) this.cylinders = d.cylinders;
      if (d.orders) this.orders = d.orders;
    };
  }

  process(_inputs, outputs, params) {
    const channels = outputs[0];
    if (!channels || !channels[0]) return true;
    const pitch = params.pitch[0];
    const n = channels[0].length;
    const v = this.v;
    for (let e = 0; e < channels.length; e++) {
      const out = channels[e];
      if (e >= MAX_ENGINES) {
        out.fill(0);
        continue;
      }
      const names = NAMES[e];
      for (let j = 0; j < names.length; j++) v[PER_ENGINE[j]] = params[names[j]][0];
      const voice = this.voices[e];
      if (this.kind === 'piston') voice.piston(out, n, v, pitch, this.blades, this.cylinders);
      else if (this.kind === 'turboprop')
        voice.turboprop(out, n, v, pitch, this.blades, this.orders);
      else voice.jet(out, n, v, pitch, this.blades, this.orders, this.kind === 'afterburning');
    }
    return true;
  }
}

registerProcessor('engine-sound', EngineProcessor);
