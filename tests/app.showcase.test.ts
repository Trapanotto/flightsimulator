import { describe, expect, it } from 'vitest';
import {
  PATH_LENGTH,
  ROUTE,
  bankAt,
  curvatureAt,
  headingAt,
  pointAt,
} from '../src/app/showcasePath';
import { SHOWCASE_SPEED } from '../src/app/Showcase';

const MY = 110_540;
const MX = Math.cos((46.61 * Math.PI) / 180) * 111_320;

describe('the loop of the menu flight', () => {
  it('is a closed loop of a sensible length', () => {
    expect(PATH_LENGTH).toBeGreaterThan(25_000);
    expect(PATH_LENGTH).toBeLessThan(45_000);
    const a = pointAt(0);
    const b = pointAt(PATH_LENGTH);
    expect(b.lon).toBeCloseTo(a.lon, 9);
    expect(b.lat).toBeCloseTo(a.lat, 9);
    expect(b.altitude).toBeCloseTo(a.altitude, 6);
  });

  it('moves a metre per metre, without jumps', () => {
    let last = pointAt(0);
    for (let s = 10; s <= PATH_LENGTH + 10; s += 10) {
      const p = pointAt(s);
      const d = Math.hypot(
        (p.lon - last.lon) * MX,
        (p.lat - last.lat) * MY,
        p.altitude - last.altitude,
      );
      expect(d).toBeGreaterThan(9);
      expect(d).toBeLessThan(11);
      last = { ...p };
    }
  });

  it('stays between the valley floor and the summits, close to its waypoints', () => {
    for (let s = 0; s < PATH_LENGTH; s += 50) {
      const h = pointAt(s).altitude;
      expect(h).toBeGreaterThan(1400);
      expect(h).toBeLessThan(2500);
    }
    // Smoothing cuts the corners, but not by kilometres.
    for (const [lon, lat] of ROUTE) {
      let best = Infinity;
      for (let s = 0; s < PATH_LENGTH; s += 20) {
        const p = pointAt(s);
        best = Math.min(best, Math.hypot((p.lon - lon) * MX, (p.lat - lat) * MY));
      }
      expect(best).toBeLessThan(900);
    }
  });

  it('climbs and descends no steeper than a light aircraft can', () => {
    for (let s = 0; s < PATH_LENGTH; s += 50) {
      const slope = (pointAt(s + 50).altitude - pointAt(s).altitude) / 50;
      expect(Math.abs(slope)).toBeLessThan(0.16);
    }
  });

  it('banks gently: under 50 degrees, changing slowly', () => {
    const v = SHOWCASE_SPEED;
    let last = bankAt(0, v);
    for (let s = 0; s < PATH_LENGTH; s += v / 10) {
      const b = bankAt(s, v);
      expect(Math.abs(b)).toBeLessThan((50 * Math.PI) / 180);
      // Roll rate under 25 degrees per second.
      expect(Math.abs(b - last) * 10).toBeLessThan((25 * Math.PI) / 180);
      last = b;
    }
    // Left turns bank left: the sign of the bank follows the curvature.
    for (let s = 0; s < PATH_LENGTH; s += 500)
      if (Math.abs(curvatureAt(s)) > 1e-5)
        expect(Math.sign(bankAt(s, v))).toBe(Math.sign(curvatureAt(s)));
  });

  it('starts heading up the Lauterbrunnen valley, roughly south', () => {
    const h = headingAt(0);
    expect(h).toBeGreaterThan(130);
    expect(h).toBeLessThan(230);
  });
});
