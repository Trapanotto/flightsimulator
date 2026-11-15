/**
 * The A320's systems through the cockpit: a start from cold and dark in the order of the
 * checklist (batteries, ADIRS, APU, bleed, engine 2 then engine 1 on IGN/START), the
 * automatic start sequence's figures, the electrical, hydraulic and fuel systems, the
 * thrust levers, autobrake, ground spoilers, nose wheel steering and the ECAM.
 */
import { describe, expect, it } from 'vitest';
import { A320_TANKS } from '../../src/sim/a320';
import { ADIRS_ALIGN_TIME, APU_START_TIME } from '../../src/sim/a320/systems';
import { FT, KT, fly } from './harness';
import {
  a320Airborne,
  a320OnGround,
  airbus,
  press,
  tankLoad,
  type A320Flight,
} from './a320Harness';
import { cruising, levers } from './a320Procedures';

/** Runs until the condition holds, returns the seconds it took (Infinity if it never did). */
function until(f: A320Flight, seconds: number, condition: () => boolean): number {
  const t0 = f.ac.telemetry.time;
  const r = fly(f, seconds, () => condition());
  return r < seconds ? f.ac.telemetry.time - t0 : Infinity;
}

/** The checklist's start of one engine on IGN/START; returns what the sequence did. */
function startEngine(f: A320Flight, engine: 1 | 2) {
  const e = f.ac.telemetry.engines[engine - 1]!;
  const b = airbus(f);
  const i = engine - 1;
  f.ac.cockpit.set(`engineMaster${engine}`, 1);
  const marks = { ignitionN2: NaN, lightOffN2: NaN, cutoutN2: NaN, idle: NaN };
  let wasValve = false;
  const t0 = f.ac.telemetry.time;
  fly(f, 120, () => {
    const s = b.systems.start;
    if (Number.isNaN(marks.ignitionN2) && s.ignition[i]) marks.ignitionN2 = e.n2!;
    if (Number.isNaN(marks.lightOffN2) && e.running) marks.lightOffN2 = e.n2!;
    if (wasValve && !s.valve[i] && Number.isNaN(marks.cutoutN2)) marks.cutoutN2 = e.n2!;
    wasValve = s.valve[i] === true;
    if (e.running && e.n2! > 58) {
      marks.idle = f.ac.telemetry.time - t0;
      return true;
    }
    return false;
  });
  fly(f, 10);
  return { ...marks, n1: e.n1!, n2: e.n2!, egt: e.turbineTemperature! };
}

describe('A320 systems', () => {
  it('starts from cold and dark by the checklist: batteries, ADIRS, APU, bleed, engines 2 and 1', () => {
    const f = a320OnGround({ mass: 64_000, enginesRunning: false });
    const { ac } = f;
    const c = ac.cockpit;
    const b = airbus(f);
    const t = ac.telemetry;
    fly(f, 1);
    expect(b.systems.electrical.dcBat).toBe(false);
    expect(t.engines.every((e) => !e.running)).toBe(true);
    // Electrical: batteries; ADIRS to NAV.
    c.set('battery', 1);
    c.set('battery2', 1);
    c.set('adirs', 1);
    fly(f, 2);
    expect(b.systems.electrical.dcBat).toBe(true);
    expect(b.systems.electrical.acEss).toBe(false);
    expect(b.systems.adirs.aligned).toBe(false);
    expect(b.ecam.memo.some((m) => m.startsWith('IR IN ALIGN'))).toBe(true);
    // APU: master, start; AVAIL after about 40 s, its generator takes the AC buses.
    c.set('apuMaster', 1);
    fly(f, 4);
    press(f, 'apuStart');
    const apu = until(f, 120, () => b.systems.apu.available);
    expect(apu).toBeGreaterThan(APU_START_TIME * 0.9);
    expect(apu).toBeLessThan(APU_START_TIME + 10);
    expect(b.ecam.memo).toContain('APU AVAIL');
    expect(b.systems.electrical.source).toEqual(['apu', 'apu']);
    expect(b.systems.electrical.acEss).toBe(true);
    c.set('apuBleed', 1);
    fly(f, 2);
    expect(b.systems.bleed[0]).toBeGreaterThan(30);
    expect(b.systems.bleed[1]).toBeGreaterThan(30);
    // Before start: beacon, fuel pumps, the mode selector to IGN/START.
    c.set('lightBeacon', 1);
    c.set('fuelPumpsLeft', 1);
    c.set('fuelPumpsRight', 1);
    c.set('fuelPumpsCenter', 1);
    c.set('engineMode', 2);
    // Engine 2 first (it drives the yellow system, the parking brake's).
    const two = startEngine(f, 2);
    // FCOM DSC-70 (CFM56-5B): ignition at 16 % N2, starter cut-out at 50 %, idle about 19.5 %
    // N1 and 58.5 % N2.
    expect(two.ignitionN2).toBeGreaterThan(15);
    expect(two.ignitionN2).toBeLessThan(18);
    expect(two.lightOffN2).toBeGreaterThan(15);
    expect(two.lightOffN2).toBeLessThan(25);
    expect(two.cutoutN2).toBeGreaterThan(48);
    expect(two.cutoutN2).toBeLessThan(53);
    expect(two.n1).toBeGreaterThan(18.5);
    expect(two.n1).toBeLessThan(20.5);
    expect(two.n2).toBeGreaterThan(57);
    expect(two.n2).toBeLessThan(60);
    // Stable idle about 50 s after the master went on.
    expect(two.idle).toBeGreaterThan(40);
    expect(two.idle).toBeLessThan(65);
    expect(b.systems.hydraulics.yellow).toBeGreaterThan(2800);
    const one = startEngine(f, 1);
    expect(one.n2).toBeGreaterThan(57);
    expect(one.idle).toBeLessThan(65);
    // After start: mode selector back to NORM, APU bleed off, the generators on line.
    c.set('engineMode', 1);
    c.set('apuBleed', 0);
    fly(f, 5);
    expect(b.systems.electrical.source).toEqual(['gen1', 'gen2']);
    expect(b.systems.hydraulics.green).toBeGreaterThan(2800);
    expect(b.systems.hydraulics.blue).toBeGreaterThan(2800);
    expect(b.systems.hydraulics.yellow).toBeGreaterThan(2800);
    // The rest of the alignment, then the flight controls are in normal law.
    fly(f, ADIRS_ALIGN_TIME);
    expect(b.systems.adirs.aligned).toBe(true);
    expect(b.controls.law).toBe('normal');
    expect(b.ecam.warnings).toEqual([]);
    // The take-off memo shows what is still to do.
    expect(b.ecam.memo[0]).toContain('T.O AUTO BRK');
    c.set('autobrake', 3);
    c.set('spoilersArmed', 1);
    c.set('seatBelts', 2);
    ac.controls.flaps = 1 / 4;
    fly(f, 25);
    expect(b.controls.config).toBe('1+F');
    expect(b.ecam.memo.slice(0, 5).every((m) => !m.includes('NOT DONE'))).toBe(true);
    // And it taxies and takes off: thrust levers to TOGA, the flight directors in SRS.
    c.set('parkingBrake', 0);
    levers(f, 1);
    fly(f, 2);
    expect(b.fma.thrust).toBe('MAN TOGA');
    expect(b.fma.vertical).toBe('SRS');
    expect(b.fma.lateral).toBe('RWY');
    expect(b.fma.autothrust).toBe('armed');
  }, 120_000);

  it('burns the centre tank first with the slats retracted, the wings with them out', () => {
    const f = cruising(31_000, 440, { mass: 66_000 });
    f.ac.setFuelTanks([5000, 5000, 3000]);
    fly(f, 1);
    const [l0, r0, c0] = [...f.ac.systems.fuel.amount];
    fly(f, 300);
    const a = f.ac.systems.fuel.amount;
    expect(a[0]).toBeCloseTo(l0!, 0);
    expect(a[1]).toBeCloseTo(r0!, 0);
    expect(c0! - a[2]!).toBeGreaterThan(150);
    // Slats out: the centre pumps stop, each engine draws its own wing.
    const g = a320Airborne(8000 * FT, 210, { mass: 64_000, flapLever: 1 });
    g.ac.setFuelTanks([5000, 5000, 3000]);
    fly(g, 120);
    const b = g.ac.systems.fuel.amount;
    expect(b[2]).toBeCloseTo(3000, 0);
    expect(b[0]).toBeLessThan(5000 - 20);
    expect(Math.abs(b[0]! - b[1]!)).toBeLessThan(1);
    expect(airbus(g).systems.fuel.pumps.centre).toBe(false);
    void tankLoad;
    void A320_TANKS;
  }, 60_000);

  it('feeds both engines from the fuller wing with the crossfeed open', () => {
    const f = cruising(31_000, 440, { mass: 64_000 });
    f.ac.setFuelTanks([5200, 4800, 0]);
    f.ac.cockpit.set('fuelCrossfeed', 1);
    fly(f, 300);
    const a = f.ac.systems.fuel.amount;
    expect(Math.abs(a[0]! - a[1]!)).toBeLessThan(60);
  }, 60_000);

  it('sets thrust from the levers: detents, the manual range between, and reverse', () => {
    const f = a320OnGround({ mass: 60_000 });
    const t = f.ac.telemetry;
    f.ac.controls.parkingBrake = true;
    const n1At = (lever: number) => {
      levers(f, lever);
      fly(f, 15);
      return t.engines[0]!.n1!;
    };
    const idle = n1At(0);
    const half = n1At(0.3);
    const clb = n1At(0.62);
    const mct = n1At(0.82);
    const toga = n1At(1);
    expect(idle).toBeCloseTo(19.5, 0);
    expect(half).toBeGreaterThan(idle + 10);
    expect(half).toBeLessThan(clb - 5);
    expect(mct).toBeGreaterThan(clb);
    expect(toga).toBeGreaterThan(mct);
    // Take-off N1 at sea level ISA, static: about 95 % (FCOM, reconstructed).
    expect(toga).toBeGreaterThan(92);
    expect(toga).toBeLessThan(97);
    // Without the autothrust, the levers alone: no autothrust output.
    expect(airbus(f).fma.autothrust).not.toBe('active');
    levers(f, 0);
    fly(f, 10);
    f.ac.controls.reverse = true;
    levers(f, 1);
    fly(f, 10);
    expect(t.engines.every((e) => e.reversing)).toBe(true);
    expect(t.engines[0]!.power).toBeLessThan(0);
  }, 30_000);

  it('steers the nose wheel by the tiller at taxi speed and only a little by the pedals at speed', () => {
    const f = a320OnGround({ mass: 60_000 });
    const t = f.ac.telemetry;
    const b = airbus(f);
    f.ac.controls.parkingBrake = false;
    levers(f, 0.25);
    fly(f, 12, () => void levers(f, t.groundSpeed > 6 ? 0.1 : 0.25));
    f.ac.controls.yaw = 1;
    fly(f, 1);
    expect(b.controls.steering).toBeGreaterThan(50);
    const h0 = t.headingDeg;
    fly(f, 5);
    expect(Math.abs(((t.headingDeg - h0 + 540) % 360) - 180)).toBeGreaterThan(20);
    // At speed the pedals give at most a few degrees.
    const g = a320OnGround({ mass: 60_000 });
    g.ac.controls.parkingBrake = false;
    levers(g, 1);
    fly(g, 30, () => {
      g.ac.controls.yaw = g.ac.telemetry.ias / KT > 90 ? 1 : 0;
      return g.ac.telemetry.ias / KT > 100;
    });
    fly(g, 0.5);
    expect(airbus(g).controls.steering).toBeLessThan(6);
  }, 30_000);

  it('deploys the ground spoilers and brakes at MAX on a rejected take-off', () => {
    const f = a320OnGround({ mass: 70_000, flapLever: 1 });
    const t = f.ac.telemetry;
    const b = airbus(f);
    f.ac.cockpit.set('spoilersArmed', 1);
    f.ac.cockpit.set('autobrake', 3);
    f.ac.controls.parkingBrake = false;
    levers(f, 1);
    fly(f, 60, () => t.ias / KT > 120);
    levers(f, 0);
    let spoilers = false;
    let decel = false;
    const stop = fly(f, 60, () => {
      spoilers ||= b.controls.groundSpoilers;
      decel ||= b.controls.autobrakeDecel;
      return t.groundSpeed < 0.5;
    });
    expect(stop).toBeLessThan(40);
    expect(spoilers).toBe(true);
    expect(decel).toBe(true);
    expect(t.crashed).toBeUndefined();
  }, 30_000);

  it('reports an engine failure on the ECAM and lights the master caution until pressed', () => {
    const f = cruising(20_000, 380, { mass: 60_000 });
    const b = airbus(f);
    fly(f, 2);
    expect(b.ecam.warnings).toEqual([]);
    f.ac.failures.set('engine', true);
    fly(f, 5);
    expect(b.ecam.warnings).toContain('ENG 1 FAIL');
    expect(b.ecam.masterCaution).toBe(true);
    press(f, 'masterCaution');
    expect(b.ecam.masterCaution).toBe(false);
    expect(b.ecam.warnings).toContain('ENG 1 FAIL');
  }, 30_000);

  it('aligns the ADIRS in about a minute; until then no normal law', () => {
    const f = a320OnGround({ mass: 60_000 });
    const b = airbus(f);
    fly(f, 1);
    expect(b.systems.adirs.aligned).toBe(true);
    f.ac.cockpit.set('adirs', 0);
    fly(f, 1);
    expect(b.systems.adirs.aligned).toBe(false);
    expect(b.controls.law).toBe('direct');
    f.ac.cockpit.set('adirs', 1);
    const s = until(f, 120, () => b.systems.adirs.aligned);
    expect(s).toBeGreaterThan(ADIRS_ALIGN_TIME - 1);
    expect(s).toBeLessThan(ADIRS_ALIGN_TIME + 1);
    expect(b.controls.law).toBe('normal');
  }, 30_000);
});
