/**
 * Turbine engine sound from telemetry: what the engine is doing (mode) and the frequencies
 * and levels of each part of its sound (voice). Plain maths, tested without audio; the worklet
 * (engine-worklet.js) only renders what this decides.
 */
import type { EngineTelemetry } from '@sim';
import type { EngineKind, SoundProfile, TurbineSpec } from './profiles';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Speed of sound at sea level, m/s. */
export const SOUND_SPEED = 340.3;

/** What a turbine is doing, as the ear tells it apart. */
export type TurbineMode = 'stopped' | 'starting' | 'idle' | 'running' | 'reverse' | 'shutdown';

/** An engine's state with the gaps of the telemetry filled. Speeds in per cent. */
export interface TurbineReading {
  running: boolean;
  starting: boolean;
  /** Gas generator (Ng, N2), %. */
  core: number;
  /** Fan (N1), % (a turboprop: the propeller as a share of its governed speed). */
  fan: number;
  /** Propeller or fan rpm. */
  shaftRpm: number;
  /** Output 0..1 (thrust or power; afterburner not included). */
  power: number;
  /** Torque 0..1 (turboprops; the power where not reported). */
  torque: number;
  reversing: boolean;
  afterburner: number;
  /** Nozzle opening 0..1. */
  nozzle: number;
}

/**
 * Fills what the telemetry leaves out. `spooled` is the caller's lagging estimate of the gas
 * generator speed (`spoolCore`), used only when neither N2 nor any shaft speed is reported.
 */
export function readTurbine(
  kind: EngineKind,
  spec: TurbineSpec,
  e: EngineTelemetry | undefined,
  starter: boolean,
  spooled: number,
): TurbineReading {
  const running = e?.running ?? false;
  const starting = e?.starting ?? starter;
  const rawPower = Math.max(0, e?.power ?? 0);
  const afterburner = kind === 'afterburning' ? clamp01(e?.afterburner ?? (rawPower - 1) / 0.6) : 0;
  const power = clamp01(rawPower);
  const rpm = Math.max(0, e?.rpm ?? 0);
  let core: number;
  let fan: number;
  let shaftRpm: number;
  if (kind === 'turboprop') {
    // A free turbine: the propeller turns independently of the gas generator.
    shaftRpm = Math.max(0, e?.propRpm ?? rpm);
    fan = (100 * shaftRpm) / spec.fanRpm100;
    core = e?.n2 ?? spooled;
  } else {
    const fromShaft = e?.n1 ?? (rpm > 1 ? (100 * rpm) / spec.fanRpm100 : undefined);
    core = e?.n2 ?? (fromShaft !== undefined ? coreFromFan(spec, fromShaft) : spooled);
    fan = fromShaft ?? fanFromCore(spec, core);
    shaftRpm = (fan / 100) * spec.fanRpm100;
  }
  const nozzle =
    e?.nozzle ??
    (afterburner > 0
      ? 0.6 + 0.4 * afterburner
      : // Open at idle (less back pressure, gentler idle thrust), closing with power.
        1 - clamp01((core - spec.idleCore) / (100 - spec.idleCore)) * 0.8);
  return {
    running,
    starting,
    core: Math.max(0, core),
    fan: Math.max(0, fan),
    shaftRpm,
    power,
    torque: Math.max(0, e?.torque ?? power),
    reversing: e?.reversing ?? false,
    afterburner,
    nozzle: clamp01(nozzle),
  };
}

/**
 * Where the gas generator settles for the telemetry (the target of `spoolCore`): starter
 * speed while it cranks, idle to 100 % with the power while it runs, nothing otherwise.
 */
export function coreTarget(
  kind: EngineKind,
  spec: TurbineSpec,
  e: EngineTelemetry | undefined,
  starter: boolean,
): number {
  if (e?.running) {
    const p = clamp01(e.power);
    // Thrust grows with about the square of the fan speed, so the speed with its root.
    const fan = spec.idleFan + (100 - spec.idleFan) * Math.sqrt(p);
    if (kind === 'turboprop') return spec.idleCore + (100 - spec.idleCore) * p;
    return coreFromFan(spec, fan);
  }
  if (e?.starting ?? starter) return spec.lightOff + 6;
  return 0;
}

/** The lagging gas generator speed: a turbine spools up in seconds and runs down slower. */
export function spoolCore(
  core: number,
  target: number,
  dt: number,
  spec: Pick<TurbineSpec, 'spoolUp' | 'spoolDown'>,
): number {
  const tau = target > core ? spec.spoolUp : spec.spoolDown;
  return target + (core - target) * Math.exp(-dt / tau);
}

/** N2 for an N1: idle to idle and 100 to 100 in a straight line, below idle in proportion. */
export function coreFromFan(spec: TurbineSpec, fan: number): number {
  if (fan >= spec.idleFan)
    return (
      spec.idleCore +
      ((fan - spec.idleFan) * (100 - spec.idleCore)) / Math.max(1, 100 - spec.idleFan)
    );
  return (fan / spec.idleFan) * spec.idleCore;
}

/** N1 for an N2: the inverse, except that the fan lags far behind while the core starts. */
export function fanFromCore(spec: TurbineSpec, core: number): number {
  if (core >= spec.idleCore)
    return (
      spec.idleFan +
      ((core - spec.idleCore) * (100 - spec.idleFan)) / Math.max(1, 100 - spec.idleCore)
    );
  return spec.idleFan * Math.pow(clamp01(core / spec.idleCore), 2);
}

/** The mode, from the reading: the edges the ear hears (light-off, reverse, spooling down). */
export function turbineMode(r: TurbineReading, spec: TurbineSpec): TurbineMode {
  if (r.running) {
    // Lit but not yet at idle: still accelerating to it (on the starter below the cut-out).
    if (r.core < spec.idleCore - 4) return 'starting';
    if (r.reversing) return 'reverse';
    return r.power < 0.08 && r.core < spec.idleCore + 10 ? 'idle' : 'running';
  }
  if (r.starting) return 'starting';
  return r.core > 2 || r.shaftRpm > 30 ? 'shutdown' : 'stopped';
}

/** Blade passing frequency: shaft revolutions per second times the blades, Hz. */
export function bladePassHz(rpm: number, blades: number): number {
  return (rpm / 60) * blades;
}

/** Shaft frequency of the gas generator at `core` per cent, Hz. */
export function coreHz(spec: TurbineSpec, core: number): number {
  return ((core / 100) * spec.coreRpm100) / 60;
}

/**
 * Relative Mach number at the fan tip: the blade's own speed and the inflow, which grows
 * with the fan speed (axial Mach about 0.6 at 100 %). Above 1 the tips carry shocks: their
 * pressure pattern turns with the fan and is heard as the buzz-saw, at every multiple of
 * the shaft frequency.
 */
export function fanTipMach(spec: TurbineSpec, fan: number): number {
  const rps = ((fan / 100) * spec.fanRpm100) / 60;
  const tip = (Math.PI * spec.fanDiameter * rps) / SOUND_SPEED;
  const axial = 0.6 * (fan / 100);
  return Math.hypot(tip, axial);
}

/** Fully expanded jet velocity, m/s: from idle to full dry power, then to full afterburner. */
export function jetVelocity(spec: TurbineSpec, power: number, afterburner = 0): number {
  const dry = spec.jetIdle + (spec.jetMax - spec.jetIdle) * Math.sqrt(clamp01(power));
  return dry + ((spec.jetBurner ?? spec.jetMax) - spec.jetMax) * clamp01(afterburner);
}

/**
 * Corner of the jet roar, Hz. Jet noise peaks at a Strouhal number near 0.2 of exhaust
 * velocity over nozzle diameter; the corner sits a few octaves above the peak so the roar
 * keeps its body. A wider nozzle (afterburner) makes it deeper, a faster jet harder.
 */
export function roarCornerHz(velocity: number, nozzleDiameter: number): number {
  return 8 * ((0.2 * velocity) / nozzleDiameter);
}

/** What the worklet renders for one engine. Frequencies in Hz, levels 0..1. */
export interface EngineVoice {
  /** Propeller or fan shaft, revolutions per second (blade pass = rps times blades). */
  rps: number;
  /** Gas generator shaft, revolutions per second. */
  core: number;
  /** Blade passing tone (propeller or fan). */
  tone: number;
  /** Fan shock (buzz-saw) tones. */
  buzz: number;
  /** Compressor whine. */
  whine: number;
  /** Broadband exhaust or jet roar, and its corner. */
  roar: number;
  roarHz: number;
  /** Low rumble: light-off, afterburner. */
  rumble: number;
  /** Afterburner crackle. */
  crackle: number;
  /** Propeller in beta or reverse; a jet's reversers. */
  beta: number;
  /** Igniters ticking. */
  ignite: number;
  /** Propeller feathered 0..1. */
  feather: number;
  /** Starter (turboprop: starter-generator whine; jet: air starter and bleed air). */
  starter: number;
}

/** Edges and slow states the voice needs beyond the reading, kept by the caller. */
export interface VoiceMemory {
  /** Seconds since the engine lit (large when long ago or never). */
  sinceLightOff: number;
  /** Propeller feathering 0 fine .. 1 feathered, lagging (`featherTarget`). */
  feather: number;
  onGround: boolean;
}

/** A turboprop's propeller stays feathered until the engine is at idle, and feathers when shut down. */
export function featherTarget(mode: TurbineMode): number {
  return mode === 'idle' || mode === 'running' || mode === 'reverse' ? 0 : 1;
}

/** The thump and rumble of the light-off, fading in about a second. */
export function lightOffRumble(sinceLightOff: number): number {
  return sinceLightOff < 0 || sinceLightOff > 4 ? 0 : 0.2 * Math.exp(-sinceLightOff / 0.7);
}

export function turbineVoice(
  profile: SoundProfile,
  r: TurbineReading,
  mode: TurbineMode,
  m: VoiceMemory,
): EngineVoice {
  const spec = profile.turbine!;
  const core = coreHz(spec, r.core);
  const g = clamp01(r.core / 100);
  const lit = mode !== 'stopped' && mode !== 'shutdown' && r.running;
  const crank = mode === 'starting' && r.core < spec.starterCutout;
  const ignite =
    mode === 'starting' && r.core >= spec.ignitionOn && r.core < spec.starterCutout ? 1 : 0;
  const rumble = lightOffRumble(m.sinceLightOff);
  if (profile.engine === 'turboprop') {
    const tip = clamp01(r.shaftRpm / spec.fanRpm100);
    const torque = clamp01(r.torque);
    // Propeller loading noise grows steeply with tip speed, and with the thrust it makes.
    const tone = tip * tip * tip * (0.3 + 0.7 * torque) * (1 - 0.65 * m.feather);
    // Beta: the blades near flat pitch chop the air (reverse: harder with reverse power);
    // a little of it on the ground at idle, where the PT6 sits in beta.
    const beta = r.reversing
      ? 0.45 + 0.55 * clamp01(r.power)
      : m.onGround && mode === 'idle'
        ? 0.18 * tip
        : 0;
    return {
      rps: r.shaftRpm / 60,
      core,
      tone,
      buzz: 0,
      whine: g * g,
      // Before light-off only the air the compressor pushes through.
      roar: (lit ? 0.15 + 0.85 * torque : 0.04) * clamp01(r.core / spec.idleCore),
      roarHz: 200 + 450 * torque,
      rumble,
      crackle: 0,
      beta,
      ignite,
      feather: m.feather,
      starter: crank ? 1 : 0,
    };
  }
  const fan = r.fan;
  const f = clamp01(fan / 100);
  const ab = profile.engine === 'afterburning' ? r.afterburner : 0;
  const u = jetVelocity(spec, lit ? r.power : 0, ab);
  const umax = spec.jetBurner ?? spec.jetMax;
  // Lighthill: radiated power with the eighth power of the jet velocity, so the pressure
  // with the fourth.
  const jet = lit ? Math.pow(u / umax, 4) : 0;
  // The bypass and core flow of a turning engine: a soft rush even at idle.
  const flow = 0.15 * g;
  const diameter = spec.nozzle[0] + (spec.nozzle[1] - spec.nozzle[0]) * r.nozzle;
  const reverse = r.reversing && lit ? 0.35 + 0.65 * clamp01(r.power) : 0;
  return {
    rps: r.shaftRpm / 60,
    core,
    tone: f > 0 ? Math.pow(0.4 + 0.6 * f, 2) * clamp01(fan / 8) : 0,
    buzz: smoothstep(0.98, 1.2, fanTipMach(spec, fan)),
    whine: g * g,
    // Reversed, the jet leaves through the cascades: less of its own roar, more of theirs.
    roar:
      clamp01(flow + (profile.engine === 'afterburning' ? 1.2 : 0.95) * jet) *
      (reverse > 0 ? 0.25 : 1),
    roarHz: roarCornerHz(lit ? u : spec.jetIdle * f, diameter),
    rumble: clamp01(rumble + 0.6 * ab),
    crackle: ab > 0 ? 0.35 + 0.65 * ab : 0,
    beta: reverse,
    ignite,
    feather: 0,
    starter: crank ? 1 : 0,
  };
}

/** Where the inside listener hears the parts of an engine: the cabin's weighting. */
export function cabinWeighted(v: EngineVoice, profile: SoundProfile, inside: boolean): EngineVoice {
  const c = profile.cabin;
  if (!inside || !c) return v;
  return {
    ...v,
    tone: v.tone * c.tone,
    buzz: v.buzz * c.buzz,
    whine: v.whine * c.whine,
    roar: v.roar * c.roar,
    rumble: v.rumble * c.roar,
    crackle: v.crackle * c.roar,
    beta: v.beta * c.tone,
    ignite: v.ignite * c.whine,
  };
}

/**
 * A rough loudness of a voice (the RMS the worklet makes of it, before the tanh): for tests
 * and the level order between states, not for the graph.
 */
export function voiceLoudness(v: EngineVoice, kind: EngineKind): number {
  // Amplitudes of each part as the worklet scales them.
  const parts =
    kind === 'turboprop'
      ? [v.tone * 0.5, v.whine * 0.06, v.roar * 0.3, v.beta * 0.25, v.rumble * 0.4]
      : [
          v.tone * 0.1,
          v.buzz * 0.2,
          v.whine * 0.07,
          v.roar * 0.6,
          v.beta * 0.25,
          v.rumble * 0.4,
          v.crackle * 0.3,
        ];
  return Math.sqrt(parts.reduce((s, p) => s + p * p, 0));
}
