/**
 * The A320's fly-by-wire laws against the FCOM's description (DSC-27-20): load factor and
 * roll rate demand, the protections, automatic trim, flare and ground mode, and the fall
 * back to direct law.
 */
import { describe, expect, it } from 'vitest';
import { ALPHA_MAX, ALPHA_PROT, CL_MAX } from '../../src/sim/a320/speeds';
import { DEG, FPM, FT, KT, fly } from './harness';
import { a320Airborne, a320OnGround, airbus } from './a320Harness';
import { levers } from './a320Procedures';

describe('A320 normal law', () => {
  it('holds the flight path and the bank hands off, and trims itself', () => {
    const f = a320Airborne(10_000 * FT, 290, { mass: 64_000 });
    const t = f.ac.telemetry;
    fly(f, 30);
    expect(Math.abs(t.verticalSpeed / FPM)).toBeLessThan(200);
    expect(airbus(f).controls.law).toBe('normal');
    // A 2 s roll input to about 25° of bank, then hands off: the bank stays.
    fly(f, 1.7, () => void (f.ac.controls.roll = 1));
    f.ac.controls.roll = 0;
    fly(f, 3);
    const bank = t.bank;
    fly(f, 20);
    expect(bank / DEG).toBeGreaterThan(15);
    expect(Math.abs(t.bank - bank) / DEG).toBeLessThan(2);
    // The turn is coordinated.
    expect(Math.abs(t.beta) / DEG).toBeLessThan(1);
    // Automatic trim: after a pull-up held for a while the elevator has handed its work back
    // to the stabiliser.
    fly(f, 3, () => void (f.ac.controls.pitch = 0.3));
    f.ac.controls.pitch = 0;
    const ths = t.stabiliser!;
    fly(f, 20);
    expect(Math.abs(t.elevator)).toBeLessThan(0.08);
    expect(t.stabiliser).not.toBeCloseTo(ths, 4);
  }, 30_000);

  it('rolls at 15°/s at full stick and limits the bank to 67°, back to 33° when released', () => {
    const f = a320Airborne(10_000 * FT, 290, { mass: 64_000 });
    const t = f.ac.telemetry;
    let rate = 0;
    let maxBank = 0;
    fly(f, 10, () => {
      f.ac.controls.roll = 1;
      rate = Math.max(rate, f.ac.state.angularVelocity.x / DEG);
      maxBank = Math.max(maxBank, t.bank / DEG);
    });
    expect(rate).toBeGreaterThan(13);
    expect(rate).toBeLessThan(16.5);
    expect(maxBank).toBeLessThan(67.5);
    expect(maxBank).toBeGreaterThan(64);
    expect(airbus(f).controls.bankLimit).toBe(true);
    f.ac.controls.roll = 0;
    fly(f, 15);
    expect(t.bank / DEG).toBeGreaterThan(31);
    expect(t.bank / DEG).toBeLessThan(35);
  }, 30_000);

  it('limits the load factor to +2.5 / -1 g clean and +2 / 0 g with slats out', () => {
    const clean = a320Airborne(15_000 * FT, 330, { mass: 60_000 });
    let max = 0;
    fly(clean, 4, () => {
      clean.ac.controls.pitch = 1;
      max = Math.max(max, clean.ac.telemetry.loadFactor);
    });
    expect(max).toBeGreaterThan(2.3);
    expect(max).toBeLessThan(2.6);
    const push = a320Airborne(15_000 * FT, 330, { mass: 60_000 });
    let min = 1;
    fly(push, 3, () => {
      push.ac.controls.pitch = -1;
      min = Math.min(min, push.ac.telemetry.loadFactor);
    });
    // Full forward stick: towards -1 g, cut short by the 15° nose-down attitude limit.
    expect(min).toBeLessThan(0);
    expect(min).toBeGreaterThan(-1.1);
    const flaps = a320Airborne(8000 * FT, 210, { mass: 60_000, flapLever: 2 });
    max = 0;
    fly(flaps, 4, () => {
      flaps.ac.controls.pitch = 1;
      max = Math.max(max, flaps.ac.telemetry.loadFactor);
    });
    expect(max).toBeGreaterThan(1.7);
    expect(max).toBeLessThan(2.1);
    expect(clean.ac.telemetry.crashed).toBeUndefined();
  }, 30_000);

  it('limits the pitch attitude to 30° nose up and 15° nose down', () => {
    const f = a320Airborne(15_000 * FT, 330, { mass: 60_000 });
    let max = 0;
    fly(f, 20, () => {
      f.ac.controls.pitch = 0.6;
      max = Math.max(max, f.ac.telemetry.pitch / DEG);
    });
    expect(max).toBeLessThan(32);
    expect(max).toBeGreaterThan(25);
    const g = a320Airborne(25_000 * FT, 330, { mass: 60_000 });
    let min = 0;
    fly(g, 15, () => {
      g.ac.controls.pitch = -0.4;
      min = Math.min(min, g.ac.telemetry.pitch / DEG);
    });
    expect(min).toBeGreaterThan(-16);
  }, 30_000);

  it('stays at alpha max with the stick held full back at low speed and does not stall', () => {
    for (const lever of [0, 4]) {
      const f = a320Airborne(10_000 * FT, lever === 0 ? 220 : 150, {
        mass: 60_000,
        flapLever: lever,
        gearDown: lever === 4,
      });
      const t = f.ac.telemetry;
      const config = lever === 0 ? ('0' as const) : ('FULL' as const);
      levers(f, 0);
      let maxAlpha = 0;
      let maxCl = 0;
      let protection = false;
      fly(f, 60, () => {
        f.ac.controls.pitch = 1;
        f.ac.controls.roll = 0;
        if (t.time > 20) maxAlpha = Math.max(maxAlpha, t.alpha);
        const q = 0.5 * 1.225 * t.ias * t.ias;
        if (t.time > 2) maxCl = Math.max(maxCl, (f.ac.mass * 9.80665 * t.loadFactor) / (q * 122.6));
        protection ||= airbus(f).controls.alphaProtection;
      });
      expect(protection).toBe(true);
      // About alpha max, never beyond the stall (the lift's maximum lies a few degrees on):
      // the lift coefficient stays below its maximum, the wings level. The nose rises and
      // falls in a slow phugoid at alpha max, as the aircraft does with the stick held back.
      expect(maxAlpha).toBeLessThan(ALPHA_MAX[config] + 1.5 * DEG);
      expect(maxAlpha).toBeGreaterThan(ALPHA_PROT[config]);
      expect(maxCl).toBeLessThan(CL_MAX[config] * 1.03);
      expect(Math.abs(t.bank) / DEG).toBeLessThan(5);
      expect(t.crashed).toBeUndefined();
    }
  }, 60_000);

  it('sets take-off thrust at alpha floor and locks it (A.FLOOR, then TOGA LK)', () => {
    const f = a320Airborne(8000 * FT, 200, { mass: 60_000, flapLever: 1 });
    const t = f.ac.telemetry;
    const b = airbus(f);
    levers(f, 0.3);
    let floor = false;
    let n1 = 0;
    fly(f, 60, () => {
      f.ac.controls.pitch = 1;
      if (b.fma.thrust === 'A.FLOOR') floor = true;
      if (floor) n1 = Math.max(n1, t.engines[0]!.n1!);
    });
    expect(floor).toBe(true);
    expect(n1).toBeGreaterThan(85);
    // The pilot lowers the nose: the thrust stays locked until the autothrust is disconnected.
    fly(f, 15, () => void (f.ac.controls.pitch = -0.2));
    f.ac.controls.pitch = 0;
    fly(f, 2);
    expect(b.fma.thrust).toBe('TOGA LK');
    f.ac.cockpit.set('athrDisconnect', 1);
    fly(f, 0.05);
    f.ac.cockpit.set('athrDisconnect', 0);
    fly(f, 1);
    expect(b.fma.thrust).toBe('');
  }, 30_000);

  it('pitches up by itself in an overspeed and limits the speed with the stick held forward', () => {
    const f = a320Airborne(10_000 * FT, 400, { mass: 60_000 });
    const t = f.ac.telemetry;
    levers(f, 0.5);
    let maxKias = 0;
    let protection = false;
    let pitchUp = false;
    fly(f, 25, () => {
      f.ac.controls.pitch = -0.3;
      maxKias = Math.max(maxKias, t.ias / KT);
      const hsp = airbus(f).controls.highSpeedProtection;
      protection ||= hsp;
      // With the stick still forward the protection raises the nose.
      if (hsp && f.ac.state.angularVelocity.y > 1 * DEG) pitchUp = true;
    });
    expect(protection).toBe(true);
    expect(pitchUp).toBe(true);
    // The pilot's nose-down authority fades from VMO, the nose-up order grows from VMO + 6:
    // the speed stays within about VMO + 20 (FCOM: the aircraft is brought back towards VMO).
    expect(maxKias).toBeLessThan(350 + 22);
    f.ac.controls.pitch = 0;
    fly(f, 40);
    expect(t.ias / KT).toBeLessThan(357);
    expect(t.crashed).toBeUndefined();
  }, 30_000);

  it('lowers the nose in the flare mode below 50 ft so the pilot has to flare', () => {
    const f = a320Airborne(120 * FT, 132, { mass: 60_000, flapLever: 4, gearDown: true });
    const t = f.ac.telemetry;
    const b = airbus(f);
    // On a 3° path, hands off once below 50 ft.
    let at50 = NaN;
    let flare = false;
    fly(f, 20, () => {
      const agl = (t.agl ?? 0) / FT;
      if (agl > 50) {
        const gamma = Math.asin(t.verticalSpeed / t.tas);
        f.ac.controls.pitch = (t.tas / 9.81) * ((-3 * DEG - gamma) / 2);
      } else {
        f.ac.controls.pitch = 0;
        if (Number.isNaN(at50)) at50 = t.pitch;
        flare ||= b.controls.flareMode;
      }
      return agl < 10;
    });
    expect(flare).toBe(true);
    expect(t.pitch).toBeLessThan(at50 - 0.3 * DEG);
  }, 30_000);
});

describe('A320 ground mode and direct law', () => {
  it('drives the elevator straight from the stick on the ground', () => {
    const f = a320OnGround({ mass: 60_000 });
    const b = airbus(f);
    fly(f, 1);
    expect(b.controls.groundMode).toBe(true);
    fly(f, 2, () => void (f.ac.controls.pitch = 0.5));
    expect(f.ac.telemetry.elevator).toBeCloseTo(0.5, 1);
  }, 30_000);

  it('falls back to direct law without the inertial reference or with two hydraulic systems lost', () => {
    const f = a320Airborne(10_000 * FT, 280, { mass: 60_000 });
    const b = airbus(f);
    fly(f, 1);
    expect(b.controls.law).toBe('normal');
    f.ac.cockpit.set('adirs', 0);
    fly(f, 1);
    expect(b.controls.law).toBe('direct');
    expect(b.ecam.warnings).toContain('F/CTL DIRECT LAW');
    // Direct law: the stick is the elevator, no load factor demand, no automatic trim.
    fly(f, 1, () => void (f.ac.controls.pitch = 0.2));
    expect(f.ac.telemetry.elevator).toBeCloseTo(0.2, 1);
    f.ac.controls.pitch = 0;

    const g = a320Airborne(10_000 * FT, 280, { mass: 60_000 });
    g.ac.cockpit.set('hydGreen', 0);
    g.ac.cockpit.set('hydYellow', 0);
    fly(g, 60);
    expect(airbus(g).systems.hydraulics.green).toBeLessThan(1500);
    expect(airbus(g).systems.hydraulics.yellow).toBeLessThan(1500);
    expect(airbus(g).controls.law).toBe('direct');
    expect(airbus(g).ecam.warnings).toContain('HYD G SYS LO PR');
  }, 30_000);
});
