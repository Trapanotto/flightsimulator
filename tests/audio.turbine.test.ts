import { describe, expect, it } from 'vitest';
import type { EngineTelemetry } from '@sim';
import {
  airframeWind,
  buffetLevel,
  dopplerFactor,
  gearRoarLevel,
  listening,
  shockLevel,
  soundSpeedAt,
} from '../src/audio/airframe';
import { windLevel } from '../src/audio/levels';
import {
  A320_SOUND,
  C172_SOUND,
  FA18_SOUND,
  PC12_SOUND,
  soundProfileFor,
  type SoundProfile,
} from '../src/audio/profiles';
import {
  bladePassHz,
  cabinWeighted,
  coreFromFan,
  coreHz,
  coreTarget,
  fanFromCore,
  fanTipMach,
  jetVelocity,
  readTurbine,
  roarCornerHz,
  spoolCore,
  turbineMode,
  turbineVoice,
  voiceLoudness,
  type TurbineMode,
} from '../src/audio/turbine';

const eng = (over: Partial<EngineTelemetry> = {}): EngineTelemetry => ({
  running: true,
  rpm: 0,
  power: 0,
  fuelFlow: 0,
  ...over,
});

/** The voice of a type for an engine state, the gaps filled as the sound fills them. */
function voice(profile: SoundProfile, e: EngineTelemetry, inside = false, onGround = false) {
  const spec = profile.turbine!;
  const spooled = coreTarget(profile.engine, spec, e, false);
  const r = readTurbine(profile.engine, spec, e, false, spooled);
  const mode = turbineMode(r, spec);
  const v = turbineVoice(profile, r, mode, {
    sinceLightOff: 99,
    feather: mode === 'running' || mode === 'idle' || mode === 'reverse' ? 0 : 1,
    onGround,
  });
  return { v: cabinWeighted(v, profile, inside), mode, r };
}

describe('sound profiles', () => {
  it('chooses by aircraft id, then by category, else the Cessna', () => {
    expect(soundProfileFor({ id: 'c172' })).toBe(C172_SOUND);
    expect(soundProfileFor({ id: 'pc12' })).toBe(PC12_SOUND);
    expect(soundProfileFor({ id: 'a320' })).toBe(A320_SOUND);
    expect(soundProfileFor({ id: 'fa18' })).toBe(FA18_SOUND);
    expect(soundProfileFor({ id: 'b737', category: 'airliner' })).toBe(A320_SOUND);
    expect(soundProfileFor({ id: 'pc21', category: 'turboprop' })).toBe(PC12_SOUND);
    expect(soundProfileFor({ id: 'f5', category: 'fighter' })).toBe(FA18_SOUND);
    expect(soundProfileFor({ id: 'dr400' })).toBe(C172_SOUND);
  });

  it('places the twins symmetrically and the single engines on the centre line', () => {
    expect(PC12_SOUND.engines).toHaveLength(1);
    for (const p of [A320_SOUND, FA18_SOUND]) {
      expect(p.engines).toHaveLength(2);
      expect(p.engines![0]!.y).toBeCloseTo(-p.engines![1]!.y, 6);
    }
  });
});

describe('turboprop (PT6A-67P, five blades)', () => {
  it('passes its blades at 1700 rpm times five: about 142 Hz', () => {
    expect(bladePassHz(1700, PC12_SOUND.blades)).toBeCloseTo(141.67, 2);
    const { v } = voice(PC12_SOUND, eng({ rpm: 1700, propRpm: 1700, n2: 97, torque: 0.9 }));
    // The worklet's blade pass is rps times the blade count.
    expect(v.rps * PC12_SOUND.blades).toBeCloseTo(141.67, 2);
  });

  it('whines with the gas generator: 37,468 rpm at 100 % Ng times the impeller vanes', () => {
    expect(coreHz(PC12_SOUND.turbine!, 100)).toBeCloseTo(624.47, 2);
    const idle = voice(PC12_SOUND, eng({ rpm: 1000, n2: 56, torque: 0.05, power: 0.02 }));
    expect(idle.v.core * PC12_SOUND.turbine!.compressorOrders[0]!).toBeCloseTo(
      ((0.56 * 37_468) / 60) * 15,
      3,
    );
    expect(idle.mode).toBe('idle');
  });

  it('has the whistle at idle and the propeller dominant at power', () => {
    const idle = voice(PC12_SOUND, eng({ rpm: 1000, n2: 56, torque: 0.05 })).v;
    const full = voice(PC12_SOUND, eng({ rpm: 1700, n2: 100, torque: 1, power: 1 })).v;
    expect(idle.whine * 0.06).toBeGreaterThan(idle.tone * 0.5 * 0.2);
    expect(full.tone).toBeGreaterThan(0.8);
    expect(full.tone * 0.5).toBeGreaterThan(full.whine * 0.06 * 5);
  });

  it('gets louder with torque, never quieter', () => {
    let last = 0;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const { v } = voice(PC12_SOUND, eng({ rpm: 1700, n2: 70 + 30 * t, torque: t, power: t }));
      const l = voiceLoudness(v, 'turboprop');
      expect(l).toBeGreaterThanOrEqual(last);
      last = l;
    }
  });

  it('growls in beta and reverse, and quietens when feathered', () => {
    const rev = voice(
      PC12_SOUND,
      eng({ rpm: 1650, n2: 90, torque: 0.5, power: 0.6, reversing: true }),
      false,
      true,
    );
    expect(rev.mode).toBe('reverse');
    expect(rev.v.beta).toBeGreaterThan(0.6);
    const spec = PC12_SOUND.turbine!;
    const r = readTurbine('turboprop', spec, eng({ rpm: 1200, n2: 60, torque: 0.1 }), false, 0);
    const fine = turbineVoice(PC12_SOUND, r, 'idle', {
      sinceLightOff: 99,
      feather: 0,
      onGround: false,
    });
    const feathered = turbineVoice(PC12_SOUND, r, 'idle', {
      sinceLightOff: 99,
      feather: 1,
      onGround: false,
    });
    expect(feathered.tone).toBeLessThan(0.5 * fine.tone);
  });
});

describe('turbofan (CFM56-5B, 36 fan blades)', () => {
  const spec = A320_SOUND.turbine!;

  it('sings at the fan blade pass: 5000 rpm times 36 is 3000 Hz at 100 % N1', () => {
    const { v } = voice(A320_SOUND, eng({ rpm: 5000, n1: 100, n2: 100, power: 1 }));
    expect(v.rps * A320_SOUND.blades).toBeCloseTo(3000, 6);
    const idle = voice(A320_SOUND, eng({ rpm: 1000, n1: 20, n2: 58 })).v;
    expect(idle.rps * A320_SOUND.blades).toBeCloseTo(600, 6);
  });

  it('starts the buzz-saw when the fan tips go supersonic, not at idle', () => {
    expect(fanTipMach(spec, 20)).toBeLessThan(0.5);
    expect(fanTipMach(spec, 100)).toBeGreaterThan(1.3);
    // Sonic tips somewhere around two thirds of the fan speed.
    let sonic = 0;
    for (let n = 0; n <= 100; n += 1) if (fanTipMach(spec, n) < 1) sonic = n;
    expect(sonic).toBeGreaterThan(55);
    expect(sonic).toBeLessThan(75);
    expect(voice(A320_SOUND, eng({ n1: 20, n2: 58 })).v.buzz).toBe(0);
    expect(voice(A320_SOUND, eng({ n1: 95, n2: 97, power: 1 })).v.buzz).toBeGreaterThan(0.9);
  });

  it('roars with the jet velocity: Lighthill, and a deeper roar from a wider nozzle', () => {
    expect(jetVelocity(spec, 0)).toBe(spec.jetIdle);
    expect(jetVelocity(spec, 1)).toBe(spec.jetMax);
    expect(roarCornerHz(400, 1)).toBeCloseTo(2 * roarCornerHz(400, 2), 6);
    expect(roarCornerHz(600, 1)).toBeGreaterThan(roarCornerHz(300, 1));
    const at = (power: number) => {
      const { v, r } = voice(A320_SOUND, eng({ n1: 70, n2: 85, power }));
      // Less the soft rush of the flow through a turning engine.
      return v.roar - 0.15 * (r.core / 100);
    };
    // Velocity ratio to the fourth power: the pressure of the eighth-power law.
    const ratio = jetVelocity(spec, 0.25) / jetVelocity(spec, 0.6);
    expect(at(0.25) / at(0.6)).toBeCloseTo(ratio ** 4, 6);
  });

  it('gets louder with thrust, never quieter, and roars in reverse', () => {
    let last = 0;
    for (let p = 0; p <= 1.0001; p += 0.1) {
      const n1 = 20 + 78 * Math.sqrt(p);
      const { v } = voice(A320_SOUND, eng({ n1, n2: coreFromFan(spec, n1), power: p }));
      const l = voiceLoudness(v, 'turbofan');
      expect(l).toBeGreaterThanOrEqual(last);
      last = l;
    }
    const idle = voice(A320_SOUND, eng({ n1: 20, n2: 58 }), false, true);
    const rev = voice(
      A320_SOUND,
      eng({ n1: 75, n2: 88, power: 0.7, reversing: true }),
      false,
      true,
    );
    expect(rev.mode).toBe('reverse');
    expect(voiceLoudness(rev.v, 'turbofan')).toBeGreaterThan(3 * voiceLoudness(idle.v, 'turbofan'));
  });

  it('fills N1 and N2 from each other, from the fan rpm or from the power', () => {
    expect(coreFromFan(spec, 20)).toBeCloseTo(58, 6);
    expect(coreFromFan(spec, 100)).toBeCloseTo(100, 6);
    expect(fanFromCore(spec, coreFromFan(spec, 70))).toBeCloseTo(70, 6);
    // While the core starts the fan lags far behind.
    expect(fanFromCore(spec, 25)).toBeLessThan(5);
    const fromRpm = readTurbine('turbofan', spec, eng({ rpm: 4000, power: 0.6 }), false, 0);
    expect(fromRpm.fan).toBeCloseTo(80, 6);
    expect(fromRpm.core).toBeCloseTo(coreFromFan(spec, 80), 6);
    const fromPower = readTurbine(
      'turbofan',
      spec,
      eng({ power: 1 }),
      false,
      coreTarget('turbofan', spec, eng({ power: 1 }), false),
    );
    expect(fromPower.fan).toBeCloseTo(100, 6);
  });

  it('spools up with a lag and runs down slower', () => {
    let up = spec.idleCore;
    let down = 100;
    for (let i = 0; i < 30; i++) {
      up = spoolCore(up, 100, 0.1, spec);
      down = spoolCore(down, spec.idleCore, 0.1, spec);
    }
    expect(up).toBeGreaterThan(spec.idleCore + 0.5 * (100 - spec.idleCore));
    expect(up).toBeLessThan(100);
    expect(100 - down).toBeLessThan(up - spec.idleCore);
  });
});

describe('afterburning turbofan (F404)', () => {
  it('is louder with the afterburner, crackles, and has more low end', () => {
    const mil = voice(FA18_SOUND, eng({ n1: 100, n2: 100, power: 1 })).v;
    const ab = voice(FA18_SOUND, eng({ n1: 100, n2: 100, power: 1.6, afterburner: 1 })).v;
    expect(mil.crackle).toBe(0);
    expect(ab.crackle).toBeGreaterThan(0.9);
    expect(ab.rumble).toBeGreaterThan(mil.rumble);
    expect(voiceLoudness(ab, 'afterburning')).toBeGreaterThan(voiceLoudness(mil, 'afterburning'));
    // The afterburner without an explicit level: power above 1.
    const r = readTurbine(
      'afterburning',
      FA18_SOUND.turbine!,
      eng({ n1: 100, power: 1.3 }),
      false,
      0,
    );
    expect(r.afterburner).toBeCloseTo(0.5, 6);
    // The nozzle opens for the afterburner: a deeper roar per velocity.
    expect(r.nozzle).toBeGreaterThan(0.6);
  });

  it('roars harder at military power than an airliner at take-off', () => {
    const mil = voice(FA18_SOUND, eng({ n1: 100, n2: 100, power: 1 })).v;
    const to = voice(A320_SOUND, eng({ n1: 95, n2: 97, power: 1 })).v;
    expect(mil.roarHz).toBeGreaterThan(to.roarHz);
  });
});

describe('turbine modes', () => {
  const spec = A320_SOUND.turbine!;
  const mode = (e: Partial<EngineTelemetry>, starter = false, spooled = 0): TurbineMode =>
    turbineMode(readTurbine('turbofan', spec, eng(e), starter, spooled), spec);

  it('tells stopped, starting, idle, running, reverse and shutdown apart', () => {
    expect(mode({ running: false, n1: 0, n2: 0 })).toBe('stopped');
    expect(mode({ running: false, starting: true, n2: 15 })).toBe('starting');
    expect(mode({ running: false, n2: 0 }, true)).toBe('starting');
    // Lit, accelerating to idle.
    expect(mode({ running: true, n2: 40, n1: 8 })).toBe('starting');
    expect(mode({ running: true, n2: 58, n1: 20 })).toBe('idle');
    expect(mode({ running: true, n2: 90, n1: 80, power: 0.7 })).toBe('running');
    expect(mode({ running: true, n2: 80, n1: 65, power: 0.6, reversing: true })).toBe('reverse');
    expect(mode({ running: false, n2: 30, n1: 6 })).toBe('shutdown');
  });

  it('works without the turbine fields: the spool of the power and the starter', () => {
    expect(mode({ running: false, rpm: 0 }, true, 10)).toBe('starting');
    expect(mode({ running: true, rpm: 0 }, false, coreTarget('turbofan', spec, eng(), false))).toBe(
      'idle',
    );
    expect(mode({ running: false, rpm: 0 }, false, 20)).toBe('shutdown');
  });

  it('ticks the igniters and runs the starter during the start only', () => {
    const v = (e: Partial<EngineTelemetry>) => voice(A320_SOUND, eng(e)).v;
    expect(v({ running: false, starting: true, n2: 10 }).ignite).toBe(0);
    expect(v({ running: false, starting: true, n2: 18 }).ignite).toBe(1);
    expect(v({ running: false, starting: true, n2: 18 }).starter).toBe(1);
    expect(v({ running: true, n2: 58, n1: 20 }).ignite).toBe(0);
    expect(v({ running: true, n2: 58, n1: 20 }).starter).toBe(0);
  });
});

describe('inside against outside', () => {
  it('is quieter inside every type, the airliner most', () => {
    const states: [SoundProfile, Partial<EngineTelemetry>][] = [
      [PC12_SOUND, { rpm: 1700, n2: 95, torque: 0.9, power: 0.9 }],
      [A320_SOUND, { n1: 90, n2: 95, power: 0.9 }],
      [FA18_SOUND, { n1: 100, n2: 100, power: 1 }],
    ];
    const ratio = states.map(([p, e]) => {
      const out = voiceLoudness(voice(p, eng(e)).v, p.engine) * p.outside!;
      const ins = voiceLoudness(voice(p, eng(e), true).v, p.engine) * p.cabin!.engine;
      expect(ins).toBeLessThan(out);
      return ins / out;
    });
    expect(ratio[1]).toBeLessThan(ratio[0]!);
  });

  it('lets the wind outweigh the engines in the airliner at cruise, less so in the Cessna', () => {
    // (The Cessna at 110 kt against the Airbus at 250 kt overall is checked in the browser:
    // it depends on the cabin filters as much as on these levels.)
    expect(windLevel(56.6, C172_SOUND.windFullSpeed, true)).toBeGreaterThan(0.1);
    const cruise = voice(A320_SOUND, eng({ n1: 85, n2: 92, power: 0.55 }), true).v;
    const engine = voiceLoudness(cruise, 'turbofan') * A320_SOUND.cabin!.engine;
    expect(airframeWind(A320_SOUND, 140, true)).toBeGreaterThan(engine);
  });
});

describe('airframe', () => {
  it('buzzes towards Mach 1 in the fighter only', () => {
    expect(shockLevel(FA18_SOUND, 0.6, 200)).toBeLessThan(0.01);
    expect(shockLevel(FA18_SOUND, 0.95, 250)).toBeGreaterThan(shockLevel(FA18_SOUND, 0.85, 250));
    expect(shockLevel(FA18_SOUND, 1.2, 300)).toBeGreaterThanOrEqual(
      shockLevel(FA18_SOUND, 1.0, 300),
    );
    expect(shockLevel(A320_SOUND, 0.95, 250)).toBe(0);
    expect(soundSpeedAt(0)).toBeCloseTo(340.3, 0);
    expect(soundSpeedAt(11_000)).toBeCloseTo(295.1, 0);
  });

  it('buffets with the speed brake and roars with the gear, both growing with speed', () => {
    expect(buffetLevel(A320_SOUND, 0, 150)).toBe(0);
    expect(buffetLevel(A320_SOUND, 1, 150)).toBeGreaterThan(buffetLevel(A320_SOUND, 1, 80));
    expect(gearRoarLevel(A320_SOUND, 0, 120)).toBe(0);
    expect(gearRoarLevel(A320_SOUND, 1, 90)).toBeGreaterThan(gearRoarLevel(A320_SOUND, 1, 60));
    expect(gearRoarLevel(C172_SOUND, 1, 50)).toBe(0);
  });
});

describe('listener', () => {
  it('shifts the pitch by Doppler: c / (c + range rate)', () => {
    expect(dopplerFactor(0)).toBe(1);
    expect(dopplerFactor(-100)).toBeCloseTo(340.3 / 240.3, 6);
    expect(dopplerFactor(100)).toBeCloseTo(340.3 / 440.3, 6);
    // Camera ahead of the aircraft, the aircraft flying at it at 100 m/s.
    const l = listening(A320_SOUND, false, {
      offset: { x: 300, y: 50, z: 0 },
      velocity: { x: -100, y: 0, z: 0 },
    });
    expect(l.pitch).toBeGreaterThan(1.3);
    expect(l.forward).toBeGreaterThan(l.aft);
  });

  it('falls off with distance and dulls far away; sounds as before without a camera', () => {
    const near = listening(A320_SOUND, false, {
      offset: { x: -45, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    });
    const far = listening(A320_SOUND, false, {
      offset: { x: -450, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    });
    expect(near.gain).toBe(1);
    expect(far.gain).toBeCloseTo(0.1, 6);
    expect(far.lowpassHz).toBeLessThan(near.lowpassHz);
    const none = listening(C172_SOUND, false);
    expect(none).toMatchObject({ gain: 1, lowpassHz: 18_000, pitch: 1, forward: 1, aft: 1 });
  });

  it('pans the twins by their side, the left engine left from behind and from the cockpit', () => {
    const behind = listening(A320_SOUND, false);
    expect(behind.pans[0]).toBeLessThan(-0.05);
    expect(behind.pans[1]).toBeCloseTo(-behind.pans[0]!, 6);
    const cockpit = listening(A320_SOUND, true);
    expect(cockpit.pans[0]).toBeLessThan(0);
    expect(cockpit.pans[1]).toBeGreaterThan(0);
    // Looking from ahead the sides swap.
    const ahead = listening(A320_SOUND, false, {
      offset: { x: 60, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    });
    expect(ahead.pans[0]).toBeGreaterThan(0);
    // From the side the far engine arrives later.
    const side = listening(A320_SOUND, false, {
      offset: { x: 0, y: 40, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    });
    expect(side.delays[0]).toBeCloseTo(11.5 / 340.3, 3);
    expect(side.delays[1]).toBe(0);
  });
});
