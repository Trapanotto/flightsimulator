/** Parts of the model on their own: the test world, section aerodynamics, engine. */
import { describe, expect, it } from 'vitest';
import { TestEnvironment, ecefToGeodetic, geodeticToEcef } from '../../src/sim';
import { sectionCoefficients, staticSeparation } from '../../src/sim/airfoil';
import { C172 } from '../../src/sim/c172';
import { DEG, KT } from './harness';

describe('TestEnvironment', () => {
  it('converts between geodetic and ECEF coordinates', () => {
    for (const [lat, lon, h] of [
      [46.9, 7.5, 510],
      [-33.9, 151.2, 3000],
      [89.5, -120, 10],
      [0, 0, 0],
    ] as const) {
      const g = ecefToGeodetic(geodeticToEcef(lat, lon, h));
      expect(g.lat).toBeCloseTo(lat, 8);
      expect(g.lon).toBeCloseTo(lon, 8);
      expect(g.height).toBeCloseTo(h, 4);
    }
  });

  it('gives an orthonormal local frame, ISA air and the wind it was given', () => {
    const env = new TestEnvironment({ wind: { fromDeg: 270, speed: 10 }, elevation: 500 });
    const p = env.position(1000);
    const up = env.up(p, { x: 0, y: 0, z: 0 });
    const north = env.north(p, { x: 0, y: 0, z: 0 });
    expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 12);
    expect(up.x * north.x + up.y * north.y + up.z * north.z).toBeCloseTo(0, 12);
    expect(env.altitude(p)).toBeCloseTo(1500, 3);
    const air = env.air(p, { wind: { x: 0, y: 0, z: 0 }, density: 0, temperature: 0, pressure: 0 });
    expect(air.density).toBeCloseTo(1.0581, 3);
    // A westerly blows towards the east.
    const east = {
      x: north.y * up.z - north.z * up.y,
      y: north.z * up.x - north.x * up.z,
      z: north.x * up.y - north.y * up.x,
    };
    expect(air.wind.x * east.x + air.wind.y * east.y + air.wind.z * east.z).toBeCloseTo(10, 6);
    const g = env.ground(p)!;
    expect(g.height).toBe(500);
  });

  it('tilts the ground of a slope and keeps it continuous', () => {
    const env = new TestEnvironment({ slope: { gradient: 0.1, downhillDeg: 0 } });
    const a = env.ground(env.position(0, 0))!;
    const b = env.ground(env.position(0, 100))!;
    expect(a.height - b.height).toBeCloseTo(10, 1);
    const up = env.up(env.origin, { x: 0, y: 0, z: 0 });
    const cos = a.normal.x * up.x + a.normal.y * up.y + a.normal.z * up.z;
    expect(Math.acos(cos) / DEG).toBeCloseTo(Math.atan(0.1) / DEG, 2);
  });
});

describe('section aerodynamics', () => {
  const foil = C172.strips[1]!.foil;
  const out = { cl: 0, cd: 0, cm: 0 };

  it('covers the full circle smoothly, with a stall and flat-plate behaviour', () => {
    let last: { cl: number; cd: number } | undefined;
    let clMax = 0;
    let alphaClMax = 0;
    for (let a = -180; a <= 180; a += 0.25) {
      const f = staticSeparation(foil, a * DEG);
      const c = sectionCoefficients(foil, a * DEG, 0, f, out);
      expect(Number.isFinite(c.cl) && Number.isFinite(c.cd) && Number.isFinite(c.cm)).toBe(true);
      expect(c.cd).toBeGreaterThan(0);
      if (last) {
        expect(Math.abs(c.cl - last.cl)).toBeLessThan(0.08);
        expect(Math.abs(c.cd - last.cd)).toBeLessThan(0.05);
      }
      last = { cl: c.cl, cd: c.cd };
      if (c.cl > clMax) {
        clMax = c.cl;
        alphaClMax = a;
      }
    }
    // NACA 2412 at flight Reynolds numbers: maximum about 1.5-1.7 at about 15-17°.
    expect(clMax).toBeGreaterThan(1.4);
    expect(clMax).toBeLessThan(1.75);
    expect(alphaClMax).toBeGreaterThan(13);
    expect(alphaClMax).toBeLessThan(18);
    // Broadside the section is a plate: no lift, drag about its plate value.
    const side = sectionCoefficients(foil, 90 * DEG, 0, 0, out);
    expect(Math.abs(side.cl)).toBeLessThan(0.01);
    expect(side.cd).toBeGreaterThan(1.1);
  });

  it('gains lift and a nose-down moment from a deflected flap', () => {
    const clean = { ...sectionCoefficients(foil, 4 * DEG, 0, 1, out) };
    const flap = sectionCoefficients(foil, 4 * DEG, 10 * DEG, 1, out);
    expect(flap.cl - clean.cl).toBeGreaterThan(0.8);
    expect(flap.cm).toBeLessThan(clean.cm);
  });
});

describe('handbook data', () => {
  it('keeps the published figures in AircraftInfo', () => {
    expect(C172.info.vs / KT).toBeCloseTo(48, 5);
    expect(C172.info.vs0 / KT).toBeCloseTo(40, 5);
    expect(C172.info.maxTakeoffMass).toBeCloseTo(1156.7, 0);
    expect(C172.mass + C172.fuelCapacity).toBeCloseTo(C172.info.maxTakeoffMass, 5);
    const area = C172.strips
      .filter((s) => C172.wingGroups.includes(s.group))
      .reduce((a, s) => a + s.area, 0);
    // The strips cover the published 174 ft² within the fuselage carry-through.
    expect(Math.abs(area / C172.wingArea - 1)).toBeLessThan(0.03);
  });
});
