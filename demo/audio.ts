// Demo of the audio package: every sound as a scenario on a timeline, fed with fake telemetry.
// Served by Vite at /flightsimulator/demo/audio.html. Click a scenario to hear it; the browser
// tests call window.__demo.render(name) to render it offline and analyse the samples.
import {
  AircraftSound,
  AudioEngine,
  CockpitSound,
  NavAudio,
  RadioSquelch,
  RadioVoice,
  browserSpeech,
  type AircraftSoundInput,
} from '@audio';
import type { AvionicsTelemetry, Cockpit, Telemetry } from '@sim';

const FS = 48_000;
/** Frames per second of the fake app loop. */
const FRAME = 1 / 60;

function telemetry(over: Partial<Telemetry> = {}): Telemetry {
  return {
    time: 0,
    ias: 0,
    tas: 0,
    groundSpeed: 0,
    altitude: 500,
    agl: 0,
    verticalSpeed: 0,
    headingDeg: 0,
    trackDeg: 0,
    pitch: 0,
    bank: 0,
    alpha: 0,
    beta: 0,
    loadFactor: 1,
    onGround: true,
    stallWarning: false,
    flaps: 0,
    gear: 1,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    engines: [{ running: false, rpm: 0, power: 0, fuelFlow: 0 }],
    fuel: 100,
    crashed: undefined,
    ...over,
  };
}

function avionics(markers: Partial<AvionicsTelemetry['markers']> = {}): AvionicsTelemetry {
  const nav = {
    frequency: 112_600,
    standby: 110_000,
    valid: true,
    ident: 'KLO',
    localizer: false,
    course: 0,
    deviation: 0,
    toFrom: 'to' as const,
    bearing: 0,
    glideSlope: undefined,
  };
  return {
    powered: true,
    com1: { active: 118_100, standby: 121_500 },
    com2: { active: 118_100, standby: 121_500 },
    nav1: nav,
    nav2: nav,
    dme: { source: 'nav1', distanceNm: 5, groundSpeedKt: 100, minutes: 3 },
    adf: { frequency: 300, valid: false, ident: '', relativeBearing: undefined },
    transponder: { code: 7000, mode: 'alt', ident: false, reply: false },
    markers: { outer: false, middle: false, inner: false, ...markers },
    autopilot: {
      engaged: false,
      lateral: 'roll',
      lateralArmed: undefined,
      vertical: 'pitch',
      verticalArmed: undefined,
      selectedAltitude: 3000,
      selectedVerticalSpeed: 0,
      disconnectWarning: false,
    },
    gps: {
      plan: [],
      active: -1,
      distanceNm: undefined,
      bearing: undefined,
      desiredTrack: undefined,
      crossTrackNm: undefined,
      groundSpeedKt: 0,
      track: 0,
      lon: 8.5,
      lat: 47.4,
    },
  };
}

const cockpitWith = (values: Record<string, number>): Cockpit => ({
  specs: [],
  get: (id) => values[id] ?? 0,
  set: () => {},
  has: (id) => id in values,
});

/** A scenario: built once on an engine, then stepped every frame with the time since start. */
interface Scenario {
  duration: number;
  build(audio: AudioEngine): Promise<(t: number) => void>;
}

const nav = (markers: Partial<AvionicsTelemetry['markers']>, ident?: string): Scenario => ({
  duration: ident ? 17 : 3,
  async build(audio) {
    const n = new NavAudio(audio);
    n.start();
    const av = avionics(markers);
    return (t) => n.update(av, { ident: t >= 0.2 ? ident : undefined, active: true });
  },
});

const SCENARIOS: Record<string, Scenario> = {
  'morse-KLO': nav({}, 'KLO'),
  'marker-outer': nav({ outer: true }),
  'marker-middle': nav({ middle: true }),
  'marker-inner': nav({ inner: true }),

  // A controller's transmission 0.5..2.0 s and a pilot's 3.0..4.0 s, over a steady 440 Hz
  // tone on the ambience bus to see the ducking.
  'radio-fx': {
    duration: 5,
    async build(audio) {
      const ctx = audio.audio;
      const tone = ctx.createOscillator();
      tone.frequency.value = 440;
      const g = ctx.createGain();
      g.gain.value = 0.3;
      tone.connect(g).connect(audio.ambience);
      tone.start();
      const fx = new RadioSquelch(audio);
      fx.start();
      const events: [number, () => void][] = [
        [0.5, () => fx.keyOn('atc')],
        [2.0, () => fx.keyOff('atc')],
        [3.0, () => fx.keyOn('pilot')],
        [4.0, () => fx.keyOff('pilot')],
      ];
      return (t) => {
        while (events.length && events[0]![0] <= t) events.shift()![1]();
      };
    },
  },

  // Switch 0.5, knob 1.0 and 1.02 (rate-limited), lever 1.2..1.5, flaps 2..3.5, disconnect
  // 4..6, fuel pump 6.5..7.5, rain 8..10, gyros spinning down from 10.
  cockpit: {
    duration: 12,
    async build(audio) {
      const c = new CockpitSound(audio);
      c.start();
      const fired = new Set<string>();
      const once = (key: string, t: number, at: number, fn: () => void) => {
        if (t >= at && !fired.has(key)) {
          fired.add(key);
          fn();
        }
      };
      return (t) => {
        once('switch', t, 0.5, () => c.switchClick(true));
        once('knob1', t, 1.0, () => c.knobTick());
        once('knob2', t, 1.01, () => c.knobTick());
        if (t >= 1.2 && t < 1.5) c.lever(0.01);
        const av = avionics();
        av.autopilot.disconnectWarning = t >= 4 && t < 6;
        const flaps = Math.min(1, Math.max(0, (t - 2) / 1.5)) * 0.33;
        c.update(
          telemetry({
            time: t,
            flaps,
            tas: 40,
            avionics: av,
            systems: t < 10 ? systems(28) : systems(0),
          }),
          {
            inside: true,
            active: true,
            precipitation: t >= 8 && t < 10 ? 0.8 : 0,
            cockpit: cockpitWith({ fuelPump: t >= 6.5 && t < 7.5 ? 1 : 0 }),
          },
        );
      };
    },
  },

  // Starter 1..3 s at cranking speed, catches at 3 and runs up to 1100 rpm, mixture cut at 6,
  // coasts down to a stop at 8; then windmilling at 900 rpm from 9.
  'engine-start': {
    duration: 11,
    async build(audio) {
      const s = new AircraftSound(audio);
      await s.start();
      return (t) => {
        let rpm = 0;
        let running = false;
        if (t >= 1 && t < 3) rpm = Math.min(250, (t - 1) * 800);
        else if (t >= 3 && t < 6) {
          running = true;
          rpm = 250 + Math.min(1, (t - 3) / 1.5) * 850;
        } else if (t >= 6 && t < 8) rpm = 1100 * (1 - (t - 6) / 2);
        else if (t >= 9) rpm = 900;
        const input: AircraftSoundInput = { starter: t >= 1 && t < 3.3 };
        s.update(
          telemetry({
            time: t,
            engines: [{ running, rpm, power: running ? 0.1 : 0, fuelFlow: 0 }],
            onGround: t < 9,
            tas: t >= 9 ? 30 : 0,
          }),
          true,
          true,
          input,
        );
      };
    },
  },

  // Airborne at 28 m/s sinking 2 m/s, touching down on asphalt at 1 s, braking from 3 s;
  // the same on grass from 5 s.
  touchdown: {
    duration: 8,
    async build(audio) {
      const s = new AircraftSound(audio);
      await s.start();
      return (t) => {
        const grass = t >= 5;
        const local = grass ? t - 5 : t;
        const onGround = local >= 1;
        const gs = onGround ? Math.max(2, 28 - (local - 1) * 6) : 28;
        s.update(
          telemetry({
            time: t,
            engines: [{ running: true, rpm: 900, power: 0.05, fuelFlow: 0 }],
            onGround,
            groundSpeed: gs,
            tas: gs,
            verticalSpeed: onGround ? 0 : -2,
          }),
          false,
          true,
          { surface: grass ? 'grass' : 'asphalt', brake: !grass && local >= 2 ? 1 : 0 },
        );
      };
    },
  },
};

function systems(volts: number): NonNullable<Telemetry['systems']> {
  return {
    busVolts: volts,
    batteryAmps: 0,
    batteryCharge: 1,
    avionicsPowered: volts > 20,
    fuelLeft: 50,
    fuelRight: 50,
    fuelAvailable: true,
    vacuum: 0,
    oilTemperature: 20,
    oilPressure: 0,
    egt: 0,
    carbIce: 0,
    airframeIce: 0,
    pitotBlocked: false,
    lights: { beacon: false, landing: false, taxi: false, nav: false, strobe: false },
    panelLight: 0,
    annunciators: {
      lowVolts: false,
      lowFuelLeft: false,
      lowFuelRight: false,
      lowVacuum: false,
      oilPressure: false,
    },
  };
}

/** Renders a scenario offline; the samples come back as base64 of a Float32Array. */
async function render(name: string): Promise<{ fs: number; samples: string }> {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`no scenario ${name}`);
  const ctx = new OfflineAudioContext(1, Math.round(sc.duration * FS), FS);
  const audio = new AudioEngine(ctx);
  audio.setVolume(1);
  const step = await sc.build(audio);
  // The app loop, as suspensions of the offline clock.
  for (let t = FRAME; t < sc.duration; t += FRAME) {
    const at = t;
    void ctx.suspend(at).then(() => {
      step(ctx.currentTime);
      void ctx.resume();
    });
  }
  step(0);
  const buffer = await ctx.startRendering();
  const bytes = new Uint8Array(buffer.getChannelData(0).buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { fs: FS, samples: btoa(bin) };
}

/** What the platform's speech synthesis offers, and whether a short message gets spoken. */
async function probeSpeech(anyVoice = false) {
  const real = browserSpeech();
  // `anyVoice`: let the queue take a non-English voice, to test the event timing on a
  // machine without English voices (the synthesiser then speaks with its default voice).
  const engine =
    real && anyVoice
      ? { ...real, voices: () => real.voices().map((v) => ({ ...v, lang: 'en-US' })) }
      : real;
  if (!engine) return { synth: false, voices: [], spoken: false, events: [] };
  const events: string[] = [];
  const t0 = performance.now();
  const log = (e: string) => events.push(`${e}@${Math.round(performance.now() - t0)}`);
  const radio = new RadioVoice(engine, { keyOn: () => log('keyOn'), keyOff: () => log('keyOff') });
  radio.unlock();
  const spoken = await Promise.race([
    radio.say('Cessna one two three, runway two eight, cleared for take-off.', 'atc'),
    new Promise<string>((r) => setTimeout(() => r('timeout'), 15_000)),
  ]);
  return {
    synth: true,
    voices: engine.voices().map((v) => `${v.name} [${v.lang}${v.localService ? ', local' : ''}]`),
    available: radio.available,
    spoken,
    events,
  };
}

// ---- the page: one button per scenario, live ----
const list = document.getElementById('scenarios')!;
let live: { audio: AudioEngine; stop: () => void } | undefined;
for (const name of Object.keys(SCENARIOS)) {
  const b = document.createElement('button');
  b.textContent = name;
  b.onclick = async () => {
    live?.stop();
    const audio = new AudioEngine();
    await audio.resume();
    const step = await SCENARIOS[name]!.build(audio);
    const t0 = audio.audio.currentTime;
    let raf = 0;
    const loop = () => {
      const t = audio.audio.currentTime - t0;
      if (t > SCENARIOS[name]!.duration) return live?.stop();
      step(t);
      raf = requestAnimationFrame(loop);
    };
    loop();
    live = {
      audio,
      stop: () => {
        cancelAnimationFrame(raf);
        audio.dispose();
        live = undefined;
      },
    };
  };
  list.append(b);
}
const say = document.createElement('button');
say.textContent = 'radio voice';
say.onclick = async () => {
  const audio = new AudioEngine();
  await audio.resume();
  const fx = new RadioSquelch(audio);
  fx.start();
  const radio = new RadioVoice(browserSpeech(), fx);
  radio.unlock();
  audio.onVolumeChange((v, m) => radio.setVolume(v, m));
  const a = await radio.say('Cessna one two three, runway two eight, cleared for take-off.', 'atc');
  const b = await radio.say('Cleared for take-off runway two eight, one two three.', 'pilot');
  document.getElementById('out')!.textContent = `spoken: ${a}, ${b}`;
};
list.append(say);

(window as unknown as { __demo: unknown }).__demo = {
  ready: true,
  scenarios: Object.keys(SCENARIOS),
  render,
  probeSpeech,
};
