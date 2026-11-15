/**
 * The A320-214 against its published figures (sources in src/sim/a320.ts and in each test;
 * "reconstructed" marks a figure remembered from the FCOM or the airport planning document
 * rather than read from it). Sea level ISA, no wind unless stated. The target is 5 %.
 */
import { describe, expect, it } from 'vitest';
import { A320, A320_FUEL, A320_MLW, A320_MTOW, A320_OEW } from '../../src/sim/a320';
import { CL_MAX, characteristicSpeeds, newSpeeds } from '../../src/sim/a320/speeds';
import { FlightModel } from '../../src/sim/flightModel';
import { SIM_DT } from '../../src/sim';
import { createAvionics } from '../../src/sim/avionics/avionics';
import { DEG, FT, KT, fly } from './harness';
import {
  a320AccelerateStop,
  a320Climb,
  a320ClimbRate,
  a320Cruise,
  a320IdleDescent,
  a320Landing,
  a320Stall,
  a320Takeoff,
  cruising,
} from './a320Procedures';
import { onApproach } from './a320Zurich';

function within(name: string, actual: number, published: number, tolerance = 0.05) {
  const d = actual / published - 1;
  expect(
    Math.abs(d),
    `${name}: ${actual.toFixed(1)} vs ${published} (${(d * 100).toFixed(1)} %)`,
  ).toBeLessThan(tolerance);
}

const LBF = 4.448222;

describe('A320-214 published figures', () => {
  it('keeps the certificate and airport planning figures in its definition', () => {
    expect(A320.info.maxTakeoffMass).toBe(73_500);
    expect(A320_MLW).toBe(64_500);
    expect(A320_OEW).toBe(42_400);
    expect(A320.mass + A320.fuelCapacity).toBeCloseTo(A320_MTOW, 6);
    expect(A320_FUEL).toBeCloseTo(18_730, -1);
    expect(A320.wingArea).toBeCloseTo(122.6, 1);
    expect(A320.wingSpan).toBeCloseTo(34.1, 2);
    expect(A320.meanChord).toBeCloseTo(4.19, 2);
    const area = A320.strips
      .filter((s) => A320.wingGroups.includes(s.group))
      .reduce((a, s) => a + s.area, 0);
    expect(Math.abs(area / A320.wingArea - 1)).toBeLessThan(0.01);
    const sweep = A320.strips.find((s) => s.name === 'wing-left-3')!.sweep!;
    expect(sweep / DEG).toBeCloseTo(25, 6);
    expect(A320.limits!.vmo / KT).toBeCloseTo(350, 6);
    expect(A320.limits!.mmo).toBe(0.82);
    expect(A320.limits!.vfe.slice(1).map((v) => Math.round(v / KT))).toEqual([215, 200, 185, 177]);
    expect(A320.gear!.vle / KT).toBeCloseTo(280, 6);
    expect(A320.gear!.vlo / KT).toBeCloseTo(250, 6);
    for (const e of A320.engines) {
      expect(e.kind).toBe('turbofan');
      if (e.kind === 'turbofan') expect(e.engine.ratedThrust / LBF).toBeCloseTo(27_000, 6);
    }
    expect(A320.controls.trimUp / DEG).toBeCloseTo(13.5, 6);
    expect(A320.controls.trimDown / DEG).toBeCloseTo(4, 6);
  });

  it('stalls (1 g) at about 155 kt clean and 108 kt in CONF FULL at 60 t', () => {
    const clean = a320Stall(0, 60_000);
    const two = a320Stall(2, 60_000);
    const three = a320Stall(3, 60_000);
    const full = a320Stall(4, 60_000);
    // The task's figures: clean 150 to 160 kt, FULL about 108 kt; CONF 2 and 3 about 117 and
    // 113 kt (reconstructed from the FCOM's VLS tables, VLS = 1.23 VS1g).
    expect(clean.vs1g).toBeGreaterThan(150);
    expect(clean.vs1g).toBeLessThan(160);
    within('VS1g CONF FULL', full.vs1g, 108);
    within('VS1g CONF 2', two.vs1g, 117);
    within('VS1g CONF 3', three.vs1g, 113);
    // The computers' aerodynamic data are this airframe's.
    for (const [r, conf] of [
      [clean, '0'],
      [two, '2'],
      [three, '3'],
      [full, 'FULL'],
    ] as const)
      within(`CLmax ${conf}`, r.clMax, CL_MAX[conf], 0.06);
  }, 120_000);

  it('approaches at about 137 kt at the maximum landing mass (VAPP = VLS + 5)', () => {
    const s = characteristicSpeeds(A320_MLW, 'FULL', 1000, false, true, 0.2, 137, newSpeeds());
    within('VAPP', s.vapp, 137);
    // Green dot by the FCOM's rule at 60 t: about 205 kt.
    const g = characteristicSpeeds(60_000, '0', 10_000, false, false, 0.45, 250, newSpeeds());
    within('green dot', g.greenDot, 205);
  });

  it('takes off from about 2000 m at MTOW in CONF 1+F with its V speeds', () => {
    const all = a320Takeoff(A320_MTOW);
    const out = a320Takeoff(A320_MTOW, { failAtV1: true });
    const stop = a320AccelerateStop(A320_MTOW);
    for (const r of [all, out]) expect(r.crashed).toBeUndefined();
    expect(stop.crashed).toBeUndefined();
    // Take-off field length (CS 25.113): the longest of 115 % of the all-engine distance to
    // 35 ft, the engine-out distance to 35 ft and the accelerate-stop distance. AC: about
    // 2000 m at 73.5 t, sea level ISA (reconstructed: read from the chart from memory).
    const tofl = Math.max(1.15 * all.to35, out.to35, stop.distance);
    within('take-off field length', tofl, 2000);
    // V speeds at MTOW CONF 1+F: VR about 150, V2 about 156 kt (reconstructed, FCOM).
    const v = characteristicSpeeds(A320_MTOW, '1+F', 0, true, true, 0, 0, newSpeeds());
    within('VR', v.vr, 150);
    within('V2', v.v2, 156);
    expect(all.liftOffKias).toBeGreaterThan(v.vr);
    expect(out.v35Kias).toBeGreaterThan(v.v2 - 3);
    // Rotation no further than the tail strike attitude (11.7° on the ground).
    expect(all.maxPitchDeg).toBeLessThan(20);
    // Engine failure at V1, take-off continued: the pilot keeps the runway with the rudder.
    expect(out.headingDeviation).toBeLessThan(8);
    // CS 25.121(b): the second segment gradient with one engine is at least 2.4 %.
    expect(out.gradient).toBeGreaterThan(2.4);
    expect(out.gradient).toBeLessThan(6);
    console.log(
      `A320 take-off at ${A320_MTOW} kg: AEO to 35 ft ${all.to35.toFixed(0)} m (x1.15 ${(1.15 * all.to35).toFixed(0)}), OEI ${out.to35.toFixed(0)} m, ASD ${stop.distance.toFixed(0)} m, VLOF ${all.liftOffKias.toFixed(0)} kt, OEI gradient ${out.gradient.toFixed(2)} %, V1/VR/V2 ${v.v1.toFixed(0)}/${v.vr.toFixed(0)}/${v.v2.toFixed(0)}`,
    );
  }, 120_000);

  it('climbs at about 2500 ft/min at 250 kt and reaches FL 350 in about 21 minutes', () => {
    const r = a320Climb(64_000);
    // Initial rate at 250 kt, 64 t (the task's figure), through 5000 ft.
    within('rate of climb at 250 kt', r.rate10, 2500);
    // FCOM climb table, 64 t from 1500 ft, ISA: about 21 min, 130 NM, 1650 kg
    // (reconstructed; within 10 %, see the report).
    within('time to FL 350', r.minutes, 21, 0.1);
    within('distance to FL 350', r.distanceNm, 130, 0.1);
    within('fuel to FL 350', r.fuel, 1650, 0.1);
    console.log(
      `A320 climb at 64 t: ${r.minutes.toFixed(1)} min, ${r.distanceNm.toFixed(0)} NM, ${r.fuel.toFixed(0)} kg; rates ${r.rates.map((x) => x.toFixed(0)).join(' ')} ft/min at 5, 15, 25, 33 thousand ft`,
    );
  }, 120_000);

  it('cruises at FL 370 and Mach 0.78 on about 2500 kg/h at 60 t', () => {
    const r = a320Cruise(37_000, 0.78, 60_000);
    expect(Math.abs(r.mach - 0.78)).toBeLessThan(0.005);
    expect(Math.abs(r.vsFpm)).toBeLessThan(100);
    // The task: 2400 to 2600 kg/h in total.
    expect(r.fuelFlow).toBeGreaterThan(2400);
    expect(r.fuelFlow).toBeLessThan(2600);
    console.log(
      `A320 cruise FL370 M0.78 60 t: ${r.fuelFlow.toFixed(0)} kg/h, N1 ${r.n1.toFixed(1)} %, alpha ${r.alphaDeg.toFixed(1)}°`,
    );
  }, 60_000);

  it('still climbs at its FL 398 ceiling', () => {
    // Service ceiling: 300 ft/min left in the climb (type certificate: 39 800 ft).
    expect(a320ClimbRate(39_800, 0.78, 56_000)).toBeGreaterThan(300);
    expect(a320ClimbRate(39_000, 0.78, 60_000)).toBeGreaterThan(300);
  }, 60_000);

  it('descends at idle on about a 3° path at 300 kt', () => {
    const r = a320IdleDescent(300, 60_000);
    expect(r.mode).toBe('THR IDLE');
    within('idle descent angle', r.angleDeg, 3);
  }, 60_000);

  it('lands with the autobrake at the maximum landing mass: LO and MED bracket about 1500 m', () => {
    const lo = a320Landing(A320_MLW, 1);
    const med = a320Landing(A320_MLW, 2);
    for (const r of [lo, med]) {
      expect(r.crashed).toBeUndefined();
      expect(r.groundSpoilers).toBe(true);
      expect(r.touchdownSink).toBeGreaterThan(-400);
    }
    // FCOM: the autobrake holds 1.7 m/s² in LO and 3 m/s² in MED.
    within('LO deceleration', lo.deceleration, 1.7);
    within('MED deceleration', med.deceleration, 3.0);
    // From 50 ft to the stop, no reverse credit: about 1500 m (the task's figure) lies
    // between LO and MED here.
    expect(lo.total).toBeGreaterThan(1500);
    expect(med.total).toBeLessThan(1500);
    expect(lo.total).toBeLessThan(2000);
    expect(med.total).toBeGreaterThan(1000);
    console.log(
      `A320 landing at ${A320_MLW} kg, VAPP ${lo.vapp.toFixed(0)} kt: LO ${lo.total.toFixed(0)} m (roll ${lo.groundRoll.toFixed(0)}), MED ${med.total.toFixed(0)} m (roll ${med.groundRoll.toFixed(0)}), decel ${lo.deceleration.toFixed(2)} / ${med.deceleration.toFixed(2)} m/s²`,
    );
  }, 120_000);
});

describe('A320 determinism and cost', () => {
  it('flies the same approach twice to the same bit', () => {
    const a = onApproach();
    const b = onApproach();
    fly(a, 90);
    fly(b, 90);
    expect(a.ac.state.position).toEqual(b.ac.state.position);
    expect(a.ac.state.orientation).toEqual(b.ac.state.orientation);
    expect(a.ac.telemetry.engines[0]!.n1).toBe(b.ac.telemetry.engines[0]!.n1);
    expect(a.ac.telemetry.avionics!.autopilot.airbus!.fma).toEqual(
      b.ac.telemetry.avionics!.autopilot.airbus!.fma,
    );
  }, 60_000);

  it('costs at most 0.15 ms a step with the autopilot and all computers running', () => {
    const f = cruising(20_000, 380, { mass: 60_000 });
    fly(f, 5);
    const ac = f.ac as FlightModel;
    // Warm up the JIT, then measure the best of a few runs.
    for (let i = 0; i < 2000; i++) ac.step(SIM_DT, f.env);
    let best = Infinity;
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) ac.step(SIM_DT, f.env);
      best = Math.min(best, (performance.now() - t0) / 2000);
    }
    console.log(`A320 step: ${(best * 1000).toFixed(1)} µs`);
    expect(best).toBeLessThan(0.15);
    void createAvionics;
    void FT;
  }, 60_000);
});
