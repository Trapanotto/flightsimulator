// Demo of the audio package: every sound as a scenario on a timeline, fed with fake telemetry.
// Served by Vite at /flightsimulator/demo/audio.html. Click a scenario to hear it; the browser
// tests call window.__demo.render(name) to render it offline and analyse the samples.
import {
  A320_SOUND,
  AircraftSound,
  AudioEngine,
  CockpitSound,
  FA18_SOUND,
  NavAudio,
  PC12_SOUND,
  RadioSquelch,
  RadioVoice,
  browserSpeech,
  fanFromCore,
  type AircraftSoundInput,
  type CameraRelative,
  type SoundProfile,
} from '@audio';
import type { AvionicsTelemetry, Cockpit, EngineTelemetry, Telemetry } from '@sim';

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
  /** Output channels of the offline render (stereo for the twins); mono if not given. */
  channels?: number;
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

// ---- Phase 4: the turbine types, through a whole ground run ----

/**
 * The phases of a ground run, s: stopped, start (starter, light-off at `lit`), idle, full
 * power, back to idle, reverse or afterburner, idle, shutdown.
 */
const RUN = {
  start: 1,
  lit: 5,
  idle: 9,
  full: 13,
  fullEnd: 19,
  special: 21,
  specialEnd: 25,
  shutdown: 27,
  end: 34,
};

/** A fake engine model, stepped per frame: enough to drive the sound through every mode. */
function groundRun(profile: SoundProfile, report: boolean) {
  const spec = profile.turbine!;
  const n = profile.engines?.length ?? 1;
  let core = 0;
  let prop = 0;
  let last = 0;
  let thrust = 0;
  return (t: number): { engines: EngineTelemetry[]; starters: boolean[] } => {
    const dt = Math.max(0, t - last);
    last = t;
    const starting = t >= RUN.start && t < RUN.idle && core < spec.starterCutout;
    const running = t >= RUN.lit && t < RUN.shutdown;
    const full = t >= RUN.full && t < RUN.fullEnd;
    const special = t >= RUN.special && t < RUN.specialEnd;
    const fighter = profile.engine === 'afterburning';
    // The fighter's special phase is the afterburner, the others' reverse.
    const burner = fighter && special;
    const reversing = !fighter && special;
    const power = full || burner ? 1 : reversing ? 0.75 : 0;
    // Thrust lags the lever a little, the speeds lag more.
    thrust += (power - thrust) * (1 - Math.exp(-dt / 0.6));
    let target = 0;
    if (running) target = spec.idleCore + (100 - spec.idleCore) * power ** 0.5;
    else if (starting) target = spec.lightOff + 6;
    const tau = target > core ? (running && core < spec.idleCore ? 1.4 : 1.2) : 2.5;
    core = target + (core - target) * Math.exp(-dt / tau);
    if (core < 0.05 && !running && !starting) core = 0;
    const turboprop = profile.engine === 'turboprop';
    // The free propeller: unfeathers to about 1000 rpm at idle, governed at 1700 with power.
    const propTarget =
      running && core > spec.idleCore - 6 ? 1000 + 700 * Math.min(1, thrust * 2.5) : 0;
    prop += (propTarget - prop) * (1 - Math.exp(-dt / (propTarget > prop ? 1.5 : 4)));
    const fan = fanFromCore(spec, core);
    const engines: EngineTelemetry[] = [];
    for (let i = 0; i < n; i++) {
      // The second engine of a pair turns a hair faster.
      const k = 1 + 0.004 * i;
      const base = {
        running,
        rpm: turboprop ? prop : (fan / 100) * spec.fanRpm100 * k,
        power: burner ? 1.6 : thrust,
        fuelFlow: 0,
      };
      engines.push(
        report
          ? {
              ...base,
              n2: core * k,
              n1: turboprop ? undefined : fan * k,
              propRpm: turboprop ? prop : undefined,
              torque: turboprop ? thrust : undefined,
              afterburner: fighter ? (burner ? 1 : 0) : undefined,
              reversing,
              starting,
            }
          : // Only what a phase 3 engine reports (a jet not even its fan rpm).
            { ...base, rpm: turboprop ? base.rpm : 0 },
      );
    }
    return { engines, starters: Array.from({ length: n }, () => starting) };
  };
}

const run = (profile: SoundProfile, inside: boolean, report = true): Scenario => ({
  duration: RUN.end,
  channels: 2,
  async build(audio) {
    const s = new AircraftSound(audio, profile);
    await s.start();
    const engine = groundRun(profile, report);
    return (t) => {
      const { engines, starters } = engine(t);
      const reversing = !report && t >= RUN.special && t < RUN.specialEnd;
      if (reversing) for (const e of engines) e.reversing = true;
      s.update(telemetry({ time: t, engines }), inside, true, report ? {} : { starters });
    };
  },
});

/** An aircraft in flight with its engines steady; `over` sets the rest per time. */
const steady = (
  profile: SoundProfile | undefined,
  duration: number,
  inside: boolean,
  engine: Partial<EngineTelemetry>,
  over: (t: number) => { t?: Partial<Telemetry>; input?: AircraftSoundInput },
): Scenario => ({
  duration,
  channels: 2,
  async build(audio) {
    const s = new AircraftSound(audio, profile);
    await s.start();
    const n = profile?.engines?.length ?? 1;
    const engines = Array.from({ length: n }, () => ({
      running: true,
      rpm: 0,
      power: 0,
      fuelFlow: 0,
      ...engine,
    }));
    return (t) => {
      const o = over(t);
      s.update(
        telemetry({ time: t, engines, onGround: false, gear: 0, ...o.t }),
        inside,
        true,
        o.input,
      );
    };
  },
});

const A320_CRUISE = { n1: 82, n2: 92, rpm: 4100, power: 0.5 };

Object.assign(SCENARIOS, {
  'pc12-out': run(PC12_SOUND, false),
  'pc12-in': run(PC12_SOUND, true),
  'a320-out': run(A320_SOUND, false),
  'a320-in': run(A320_SOUND, true),
  'fa18-out': run(FA18_SOUND, false),
  'fa18-in': run(FA18_SOUND, true),
  // The same runs with only running and power reported: the sound fills the rest.
  'a320-fallback': run(A320_SOUND, false, false),
  'pc12-fallback': run(PC12_SOUND, false, false),

  // Cruise inside: the Cessna at 110 kt, the Airbus at 250 kt indicated (and without wind).
  'c172-cruise-in': steady(undefined, 4, true, { rpm: 2400, power: 0.75 }, () => ({
    t: { tas: 56.6, ias: 56.6, gear: 1 },
  })),
  'a320-cruise-in': steady(A320_SOUND, 4, true, A320_CRUISE, () => ({
    t: { tas: 200, ias: 128.6 },
  })),
  'a320-cruise-in-still': steady(A320_SOUND, 4, true, A320_CRUISE, () => ({ t: {} })),

  // The airliner from the cabin: gear up 1..9 s, flaps 10..14, speed brake 15..19, stall
  // warning 20..22, overspeed 23..25, altitude alert at 26, gear down 30..38, touch-down at
  // 40 s at 70 m/s sinking 1.5 m/s, rolling out.
  'a320-airframe': steady(A320_SOUND, 45, true, { n1: 45, n2: 75, rpm: 2250, power: 0.12 }, (t) => {
    const gear = t < 1 ? 1 : t < 9 ? 1 - (t - 1) / 8 : t < 30 ? 0 : Math.min(1, (t - 30) / 8);
    const onGround = t >= 40;
    const gs = onGround ? Math.max(5, 70 - (t - 40) * 6) : 75;
    return {
      t: {
        gear,
        flaps: t < 10 ? 0 : Math.min(0.5, ((t - 10) / 4) * 0.5),
        speedbrake: t >= 15 && t < 19 ? 1 : 0,
        stallWarning: t >= 20 && t < 22,
        ias: gs,
        tas: gs,
        groundSpeed: gs,
        onGround,
        verticalSpeed: onGround ? 0 : -1.5,
      },
      input: { overspeed: t >= 23 && t < 25, altitudeAlert: t >= 26 && t < 27 },
    };
  }),
  // The PC-12 cockpit: stick shaker 1..3 s, overspeed 4..6, altitude alert at 7.
  'pc12-warnings': steady(
    PC12_SOUND,
    9,
    true,
    { rpm: 1700, propRpm: 1700, n2: 85, torque: 0.6, power: 0.6 },
    (t) => ({
      t: { stallWarning: t >= 1 && t < 3, ias: 80, tas: 80 },
      input: { overspeed: t >= 4 && t < 6, altitudeAlert: t >= 7 },
    }),
  ),
  // The fighter's cockpit accelerating from Mach 0.6 to 1.2 at military power.
  'fa18-transonic': steady(
    FA18_SOUND,
    20,
    true,
    { n1: 100, n2: 100, rpm: 13_270, power: 1 },
    (t) => {
      const mach = 0.6 + (0.6 * t) / 20;
      return { t: { mach, tas: mach * 295, ias: mach * 295 * 0.6, altitude: 11_000 } };
    },
  ),
  // A fly-by of the airliner at 80 m/s, 60 m beside the camera, passing at 10 s.
  'a320-flyby': steady(A320_SOUND, 20, false, { n1: 70, n2: 85, rpm: 3500, power: 0.35 }, (t) => {
    const camera: CameraRelative = {
      offset: { x: 800 - 80 * t, y: 60, z: 0 },
      velocity: { x: -80, y: 0, z: 0 },
    };
    return { t: { tas: 80, ias: 80 }, input: { camera } };
  }),

  // The airliner touching down at 70 m/s sinking 1.5 m/s at 1 s, heard from outside.
  'a320-touchdown-out': steady(
    A320_SOUND,
    4,
    false,
    { n1: 22, n2: 60, rpm: 1100, power: 0.02 },
    (t) => {
      const onGround = t >= 1;
      const gs = onGround ? 70 - (t - 1) * 3 : 70;
      return {
        t: {
          gear: 1,
          onGround,
          ias: gs,
          tas: gs,
          groundSpeed: gs,
          verticalSpeed: onGround ? 0 : -1.5,
        },
      };
    },
  ),

  // The Airbus autopilot disconnect: the cavalry charge while the warning stands, 0.5..3.5 s.
  'a320-disconnect': {
    duration: 5,
    async build(audio) {
      const c = new CockpitSound(audio);
      c.setAircraft({ id: 'a320', category: 'airliner' });
      c.start();
      return (t) => {
        const av = avionics();
        av.autopilot.disconnectWarning = t >= 0.5 && t < 3.5;
        c.update(telemetry({ time: t, avionics: av, systems: systems(28) }), {
          inside: true,
          active: true,
        });
      };
    },
  },
} satisfies Record<string, Scenario>);

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
async function render(name: string): Promise<{ fs: number; samples: string; channels: number }> {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`no scenario ${name}`);
  const channels = sc.channels ?? 1;
  const ctx = new OfflineAudioContext(channels, Math.round(sc.duration * FS), FS);
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
  // The channels one after the other.
  const all = new Float32Array(buffer.length * channels);
  for (let c = 0; c < channels; c++) all.set(buffer.getChannelData(c), c * buffer.length);
  const bytes = new Uint8Array(all.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { fs: FS, samples: btoa(bin), channels };
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
