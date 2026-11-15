/**
 * The F/A-18's flight control system (src/sim/fa18/fcs.ts): load factor command and g
 * limiter, pitch rate at low speed and the angle of attack command above 22°, roll rate
 * command and its coordination at high angle of attack, the flap schedule, the powered
 * approach, take-off trim, departure resistance, the spin recovery mode and the mechanical
 * backup.
 */
import { describe, expect, it } from 'vitest';
import { FA18_FCS } from '../../src/sim/fa18/fcs';
import { TAKEOFF_TRIM } from '../../src/sim/fa18/systems';
import { DEG, KT, fly } from './harness';
import { FLAPS, fa18Airborne, fa18OnGround, fcs, hud, setFuel } from './fa18Harness';
import { HornetPilot } from './fa18Procedures';

/** A full aft pull from 1 s on, the peak load factor over `seconds`. */
function pull(
  altitude: number,
  ktas: number,
  seconds = 6,
  setup?: (f: ReturnType<typeof fa18Airborne>) => void,
) {
  const f = fa18Airborne(altitude, ktas);
  setup?.(f);
  const t = f.ac.telemetry;
  f.ac.controls.throttle.fill(1);
  let peak = 0;
  let peakAlpha = 0;
  let t5 = NaN;
  fly(f, seconds, () => {
    f.ac.controls.pitch = t.time > 1 ? 1 : 0;
    peak = Math.max(peak, t.loadFactor);
    peakAlpha = Math.max(peakAlpha, t.alpha);
    if (Number.isNaN(t5) && t.loadFactor > 5) t5 = t.time - 1;
  });
  return { f, peak, peakAlpha, onset5g: t5 };
}

describe('F/A-18 flight control system: pitch', () => {
  it('holds 1 g hands-off: altitude and attitude stay, trimmed by the FCS', () => {
    const f = fa18Airborne(3000, 450);
    const t = f.ac.telemetry;
    const h0 = t.altitude;
    fly(f, 60);
    expect(Math.abs(t.altitude - h0)).toBeLessThan(40);
    expect(Math.abs(t.loadFactor - 1)).toBeLessThan(0.02);
    expect(Math.abs(t.bank)).toBeLessThan(1 * DEG);
    expect(fcs(f).mode).toBe('ua');
  });

  it('commands load factor in proportion to the stick at speed', () => {
    const f = fa18Airborne(4500, 450);
    const t = f.ac.telemetry;
    const pilot = new HornetPilot(f);
    f.ac.controls.throttle.fill(1);
    const gs: number[] = [];
    for (const stick of [0.3, 0.6]) {
      fly(f, 4, (dt) => {
        f.ac.controls.pitch = stick;
        pilot.bankTo(0, dt);
      });
      gs.push(t.loadFactor);
      fly(f, 4, (dt) => {
        f.ac.controls.pitch = 0;
        pilot.bankTo(0, dt);
      });
    }
    expect(gs[0]).toBeGreaterThan(1.5);
    expect(gs[1]).toBeGreaterThan(gs[0]! + 1);
    // Back to 1 g with the stick released.
    expect(Math.abs(t.loadFactor - 1)).toBeLessThan(0.3);
  });

  it('limits a full aft pull to 7.5 g at the design mass and less when heavier', () => {
    const light = pull(4500, 550, 6, (f) => setFuel(f, FA18_FCS.designMass - f.ac.def.mass));
    expect(fcs(light.f).gLimit).toBeCloseTo(7.5, 2);
    expect(light.peak).toBeGreaterThan(7.5 * 0.96);
    expect(light.peak).toBeLessThan(7.5 * 1.04);
    // 16 000 kg: the same wing load, 7.5 × 14 677 / 16 000 = 6.9 g.
    const heavy = pull(4500, 550);
    expect(fcs(heavy.f).gLimit).toBeCloseTo((7.5 * FA18_FCS.designMass) / heavy.f.ac.mass, 1);
    expect(heavy.peak).toBeLessThan(fcs(heavy.f).gLimit * 1.04);
    expect(heavy.peak).toBeGreaterThan(fcs(heavy.f).gLimit * 0.96);
    // The g comes quickly: 5 g within about two seconds of the pull.
    expect(light.onset5g).toBeLessThan(2.2);
    for (const r of [light, heavy]) expect(r.f.ac.telemetry.crashed).toBeUndefined();
  });

  it('lets the pilot pull a third more with the paddle, short of breaking the airframe', () => {
    const r = pull(4500, 600, 6, (f) => {
      setFuel(f, FA18_FCS.designMass - f.ac.def.mass);
      f.ac.cockpit.set('gLimiterOverride', 1);
    });
    expect(fcs(r.f).gLimit).toBeCloseTo(10, 1);
    expect(r.peak).toBeGreaterThan(8.6);
    expect(r.peak).toBeLessThan(10.5);
    expect(r.f.ac.telemetry.crashed).toBeUndefined();
    expect(hud(r.f).advisories).toContain('G LIM OVRD');
  });

  it('pushes to no more than -3 g', () => {
    const f = fa18Airborne(4500, 500);
    const t = f.ac.telemetry;
    let low = 1;
    fly(f, 4, () => {
      f.ac.controls.pitch = t.time > 0.5 ? -1 : 0;
      low = Math.min(low, t.loadFactor);
    });
    expect(low).toBeGreaterThan(-3.2);
    expect(low).toBeLessThan(-2.5);
  });

  it('flies pitch rate at low speed and angle of attack above 22°', () => {
    // Half stick at 180 kt: the stick's pitch rate takes the angle of attack to 22° and the
    // FCS holds it there; full aft stick goes on to its limit.
    const f = fa18Airborne(4000, 200);
    const t = f.ac.telemetry;
    const pilot = new HornetPilot(f);
    f.ac.controls.throttle.fill(1);
    let maxQ = 0;
    fly(f, 6, (dt) => {
      f.ac.controls.pitch = 0.5;
      pilot.bankTo(0, dt);
      maxQ = Math.max(maxQ, f.ac.state.angularVelocity.y);
    });
    expect(Math.abs(t.alpha - FA18_FCS.alphaCommand)).toBeLessThan(3 * DEG);
    expect(maxQ).toBeGreaterThan(10 * DEG);
    expect(maxQ).toBeLessThan(45 * DEG);
    let maxAlpha = 0;
    fly(f, 5, (dt) => {
      f.ac.controls.pitch = 1;
      pilot.bankTo(0, dt);
      maxAlpha = Math.max(maxAlpha, t.alpha);
    });
    expect(maxAlpha).toBeGreaterThan(35 * DEG);
    expect(maxAlpha).toBeLessThan(FA18_FCS.alphaMax + 5 * DEG);
  });
});

describe('F/A-18 flight control system: roll and yaw', () => {
  /** Full lateral stick for 2.5 s: the peak roll rate and the largest sideslip. */
  function roll(
    altitude: number,
    ktas: number,
    pitch = 0,
    setup?: (f: ReturnType<typeof fa18Airborne>) => void,
  ) {
    const f = fa18Airborne(altitude, ktas);
    setup?.(f);
    const ac = f.ac;
    const t = ac.telemetry;
    ac.controls.throttle.fill(1);
    let maxP = 0;
    let maxBeta = 0;
    fly(f, 6, () => {
      ac.controls.pitch = pitch;
      ac.controls.roll = t.time > 2 && t.time < 4.5 ? 1 : 0;
      if (t.time > 2) {
        // Roll rate about the velocity vector: body roll and yaw rates turned by alpha.
        const w = ac.state.angularVelocity;
        maxP = Math.max(maxP, w.x * Math.cos(t.alpha) + w.z * Math.sin(t.alpha));
        maxBeta = Math.max(maxBeta, Math.abs(t.beta));
      }
    });
    return { maxP: maxP / DEG, maxBeta: maxBeta / DEG, f };
  }

  it('rolls at about 220°/s at medium altitude and speed, stopping when the stick is centred', () => {
    const r = roll(4500, 420);
    expect(r.maxP).toBeGreaterThan(200);
    expect(r.maxP).toBeLessThan(240);
    expect(r.maxBeta).toBeLessThan(4);
    expect(Math.abs(r.f.ac.state.angularVelocity.x)).toBeLessThan(5 * DEG);
  });

  it('rolls slower at low dynamic pressure, supersonic and at high angle of attack', () => {
    const slow = roll(4500, 200);
    const supersonic = roll(11_000, 1030);
    expect(slow.maxP).toBeLessThan(150);
    expect(slow.maxP).toBeGreaterThan(60);
    expect(supersonic.maxP).toBeLessThan(150);
    expect(supersonic.maxP).toBeGreaterThan(90);
    expect(supersonic.f.ac.telemetry.mach).toBeGreaterThan(1.7);
  });

  it('coordinates a roll at 25° to 30° angle of attack about the velocity vector (ARI, RSRI)', () => {
    // Half aft stick at 180 kt holds about 22-30°; a full roll then may not build sideslip.
    const r = roll(4500, 220, 0.7);
    expect(r.f.ac.telemetry.alpha).toBeGreaterThan(18 * DEG);
    // Much slower than at low angle of attack: the rudders cannot yaw it faster.
    expect(r.maxP).toBeGreaterThan(18);
    expect(r.maxP).toBeLessThan(80);
    expect(r.maxBeta).toBeLessThan(6);
    expect(r.f.ac.telemetry.crashed).toBeUndefined();
  });

  it('holds the sideslip near zero in a full aft stick turn: no departure', () => {
    const f = fa18Airborne(5000, 350);
    const ac = f.ac;
    const t = ac.telemetry;
    ac.controls.throttle.fill(1);
    let maxBeta = 0;
    let maxAlpha = 0;
    const pilot = new HornetPilot(f);
    fly(f, 40, (dt) => {
      pilot.bankTo(70 * DEG, dt);
      ac.controls.pitch = t.time > 4 ? 1 : 0.3;
      if (t.time > 5) {
        maxBeta = Math.max(maxBeta, Math.abs(t.beta));
        maxAlpha = Math.max(maxAlpha, t.alpha);
      }
    });
    expect(maxAlpha).toBeGreaterThan(30 * DEG);
    expect(maxBeta).toBeLessThan(8 * DEG);
    expect(Math.abs(t.bank - 70 * DEG)).toBeLessThan(15 * DEG);
    expect(t.crashed).toBeUndefined();
  }, 30_000);

  it('departs only when crossed controls are held at very low speed, and recovers when they are released', () => {
    // Pro-spin inputs at the top of a zoom: full aft stick, full right lateral stick, full left
    // pedal. The FCS hands the surfaces over and the aircraft departs (a rolling departure:
    // this strip model does not settle into a developed spin, see the report). Standard
    // procedure: controls released, throttles idle.
    const f = fa18Airborne(9000, 140);
    const ac = f.ac;
    const t = ac.telemetry;
    ac.controls.throttle.fill(0);
    let departed = false;
    fly(f, 15, () => {
      ac.controls.pitch = 1;
      ac.controls.roll = 1;
      ac.controls.yaw = -1;
      departed ||= Math.abs(ac.state.angularVelocity.x) > 150 * DEG;
    });
    expect(departed).toBe(true);
    let recovered = NaN;
    const pilot = new HornetPilot(f);
    fly(f, 40, (dt) => {
      const w = ac.state.angularVelocity;
      const calm = Math.abs(w.x) < 10 * DEG && Math.abs(w.z) < 5 * DEG && t.alpha < 20 * DEG;
      if (Number.isNaN(recovered)) {
        ac.controls.pitch = 0;
        ac.controls.roll = 0;
        ac.controls.yaw = 0;
        if (calm) recovered = t.time;
      } else {
        // Wings level and pull out of the dive.
        pilot.bankTo(0, dt);
        ac.controls.pitch = t.pitch < -5 * DEG ? 0.6 : 0;
      }
    });
    expect(recovered - 15).toBeLessThan(12);
    expect(t.crashed).toBeUndefined();
    expect(t.pitch).toBeGreaterThan(-30 * DEG);
  }, 30_000);

  it('gives full authority in the spin recovery mode, and leaves it when the yaw stops', () => {
    const f = fa18Airborne(9000, 110);
    const ac = f.ac;
    ac.controls.throttle.fill(0);
    ac.cockpit.set('spinRecovery', 1);
    // A spin's yaw rate imposed at 110 kt.
    ac.state.angularVelocity.z = -60 * DEG;
    let engaged = false;
    let directAileron = false;
    fly(f, 20, () => {
      const r = ac.state.angularVelocity.z;
      // Lateral stick into the spin while the yaw rate lasts (NATOPS).
      ac.controls.roll = Math.abs(r) > 15 * DEG ? Math.sign(r) : 0;
      if (fcs(f).mode === 'spin') {
        engaged = true;
        if (Math.abs(ac.controls.roll) === 1 && Math.abs(ac.telemetry.aileron) > 0.95)
          directAileron = true;
      }
    });
    expect(engaged).toBe(true);
    expect(directAileron).toBe(true);
    expect(Math.abs(ac.state.angularVelocity.z)).toBeLessThan(10 * DEG);
    expect(fcs(f).mode).not.toBe('spin');
    expect(ac.telemetry.crashed).toBeUndefined();
  });
});

describe('F/A-18 flight control system: flaps, approach, ground, backup', () => {
  it('schedules the leading- and trailing-edge flaps in AUTO with angle of attack and Mach', () => {
    const cruise = fa18Airborne(9000, 480);
    fly(cruise, 3);
    expect(fcs(cruise).lef).toBeLessThan(4 * DEG);
    expect(fcs(cruise).tef).toBeLessThan(1 * DEG);
    const slow = fa18Airborne(4000, 220);
    const t = slow.ac.telemetry;
    slow.ac.controls.throttle.fill(1);
    let lef = 0;
    let tef = 0;
    fly(slow, 8, () => {
      slow.ac.controls.pitch = 1;
      lef = Math.max(lef, fcs(slow).lef);
      tef = Math.max(tef, fcs(slow).tef);
    });
    expect(t.alpha).toBeGreaterThan(25 * DEG);
    expect(lef).toBeCloseTo(34 * DEG, 3);
    expect(tef).toBeCloseTo(17.5 * DEG, 3);
    expect(hud(slow).leadingEdgeFlap).toBeGreaterThan(30 * DEG);
  });

  it('flies the powered approach: neutral stick holds 8.1°, the trim sets the angle held', () => {
    const f = fa18Airborne(600, 140, { flaps: FLAPS.full, gearDown: true });
    const ac = f.ac;
    const t = ac.telemetry;
    const pilot = new HornetPilot(f);
    fly(f, 0.1);
    expect(fcs(f).mode).toBe('pa');
    ac.controls.pitchTrim = 0;
    fly(f, 20, (dt) => pilot.heading(0, dt));
    expect(Math.abs(t.alpha - FA18_FCS.onSpeedAlpha)).toBeLessThan(0.3 * DEG);
    expect(hud(f).onSpeed).toBe('onSpeed');
    // Trim a sixth nose up: the FCS holds a degree more.
    ac.controls.pitchTrim = 1 / 6;
    fly(f, 15, (dt) => pilot.heading(0, dt));
    expect(Math.abs(t.alpha - 9.1 * DEG)).toBeLessThan(0.4 * DEG);
    // The stick commands angle of attack: half aft asks for more, and it comes.
    fly(f, 5, (dt) => {
      ac.controls.pitch = 0.5;
      pilot.heading(0, dt);
    });
    expect(t.alpha).toBeGreaterThan(11 * DEG);
    expect(t.alpha).toBeLessThan(FA18_FCS.alphaMaxPa + 1 * DEG);
    expect(t.crashed).toBeUndefined();
  });

  it('sets 30° and 45° of trailing-edge flap with HALF and FULL, and blows them up above 240 KCAS', () => {
    const half = fa18Airborne(600, 160, { flaps: FLAPS.half, gearDown: true });
    fly(half, 4);
    expect(fcs(half).tef).toBeCloseTo(30 * DEG, 3);
    const fast = fa18Airborne(600, 300, { flaps: FLAPS.full });
    fly(fast, 4);
    expect(fcs(fast).mode).toBe('ua');
    expect(fcs(fast).tef).toBeLessThan(18 * DEG);
  });

  it('sets the take-off trim on the ground: 4° stabilator nose up', () => {
    const f = fa18OnGround();
    f.ac.cockpit.set('takeoffTrim', 1);
    fly(f, 2);
    f.ac.cockpit.set('takeoffTrim', 0);
    expect(f.ac.controls.pitchTrim).toBeCloseTo(TAKEOFF_TRIM, 6);
    expect(f.ac.telemetry.elevator * 24).toBeCloseTo(4, 1);
    expect(fcs(f).mode).toBe('ground');
  });

  it('retracts the speed brake above 6 g or 28° angle of attack', () => {
    const f = fa18Airborne(4500, 450);
    const t = f.ac.telemetry;
    f.ac.controls.speedbrake = 1;
    fly(f, 3);
    expect(t.speedbrake).toBeGreaterThan(0.9);
    let peak = 0;
    fly(f, 6, () => {
      f.ac.controls.pitch = 1;
      peak = Math.max(peak, t.loadFactor);
    });
    expect(peak).toBeGreaterThan(6);
    expect(t.speedbrake).toBeLessThan(0.05);
    // Stays in until the switch is cycled.
    f.ac.controls.pitch = 0;
    fly(f, 3);
    expect(t.speedbrake).toBeLessThan(0.05);
    f.ac.controls.speedbrake = 0;
    fly(f, 0.5);
    f.ac.controls.speedbrake = 1;
    fly(f, 3);
    expect(t.speedbrake).toBeGreaterThan(0.9);
  });

  it('falls back to the mechanical backup without the flight control computers', () => {
    const f = fa18Airborne(4500, 350);
    const ac = f.ac;
    const t = ac.telemetry;
    // Battery and both generators off: no power for the FCCs.
    ac.cockpit.set('battery', 0);
    fly(f, 1);
    expect(fcs(f).mode).toBe('mech');
    // The stabilators still answer the stick in pitch and roll; ailerons and rudders stand.
    let peak = 1;
    let rollRate = 0;
    fly(f, 3, () => {
      ac.controls.pitch = t.time < 2 ? 0.3 : 0;
      ac.controls.roll = t.time > 2.5 ? 0.5 : 0;
      peak = Math.max(peak, t.loadFactor);
      rollRate = Math.max(rollRate, Math.abs(ac.state.angularVelocity.x));
    });
    expect(peak).toBeGreaterThan(2);
    expect(rollRate).toBeGreaterThan(10 * DEG);
    expect(Math.abs(t.aileron)).toBeLessThan(0.01);
    expect(Math.abs(t.rudder)).toBeLessThan(0.01);
    expect(t.crashed).toBeUndefined();
    void KT;
  });
});
