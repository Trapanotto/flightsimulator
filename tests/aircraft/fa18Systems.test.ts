import { describe, expect, it } from 'vitest';
import {
  HUD_GEOMETRY,
  NOZZLE,
  ON_SPEED,
  earthToBody,
  gearLights,
  gearSequence,
  hudPixelsPerDegree,
  hudProject,
  nozzleExitRadius,
  nozzleOpening,
  onSpeed,
  surfacesFrom,
  vapour,
} from '../../src/aircraft/fa18Parts';
import {
  formatFuelLb,
  formatG,
  formatHeading,
  formatHudAltitude,
  formatMach,
  formatTimeToGo,
  hudKey,
  type HudData,
} from '../../src/aircraft/fa18Displays';

const DEG = Math.PI / 180;
const SIZE = { w: 512, h: 512 };

describe('gear sequence', () => {
  it('is stowed and closed up, down and locked with the main doors shut again', () => {
    expect(gearSequence(0)).toEqual({ main: 0, twist: 1, nose: 0, mainDoors: 0, noseDoors: 0 });
    const d = gearSequence(1);
    expect([d.main, d.nose, d.twist, d.mainDoors, d.noseDoors]).toEqual([1, 1, 0, 0, 1]);
  });

  it('opens the doors before a leg moves and keeps them open while it does', () => {
    for (let g = 0; g <= 1.0001; g += 0.01) {
      const p = gearSequence(g);
      if (p.main > 0 && p.main < 1) expect(p.mainDoors, `g=${g}`).toBe(1);
      if (p.nose > 0 && p.nose < 1) expect(p.noseDoors, `g=${g}`).toBe(1);
    }
  });

  it('turns the main wheels flat while the legs swing up, monotonically', () => {
    let last = gearSequence(0);
    for (let g = 0.01; g <= 1.0001; g += 0.01) {
      const p = gearSequence(g);
      expect(p.main).toBeGreaterThanOrEqual(last.main);
      expect(p.twist).toBeLessThanOrEqual(last.twist);
      last = p;
    }
    // Half way up the wheels are already turning; fully down they stand upright.
    expect(gearSequence(0.5).twist).toBeGreaterThan(0);
    expect(gearSequence(0.5).twist).toBeLessThan(1);
  });

  it('lights three greens when locked down and the handle light while anything moves', () => {
    expect(gearLights(1)).toEqual({ down: true, transit: false });
    expect(gearLights(0)).toEqual({ down: false, transit: false });
    expect(gearLights(0.5).transit).toBe(true);
    expect(gearLights(0.05).transit).toBe(true);
  });
});

describe('nozzles and afterburner', () => {
  const e = (n2: number, ab = 0, running = true) => ({
    running,
    rpm: n2,
    power: 0.5,
    fuelFlow: 0,
    n2,
    afterburner: ab,
  });

  it('follows the reported opening: 0.78 at idle, 0.08 at military, 1 in full afterburner', () => {
    expect(nozzleOpening({ ...e(70), nozzle: 0.78 })).toBe(0.78);
    expect(nozzleExitRadius(1)).toBeCloseTo(NOZZLE.maxR, 6);
    expect(nozzleExitRadius(0)).toBeCloseTo(NOZZLE.minR, 6);
  });

  it('derives it when unreported: open at idle, closed at military, open with the afterburner', () => {
    const idle = nozzleOpening(e(70));
    const mil = nozzleOpening(e(97));
    const ab = nozzleOpening(e(100, 1));
    expect(idle).toBeCloseTo(0.78, 2);
    expect(mil).toBeLessThan(0.15);
    expect(ab).toBe(1);
  });
});

describe('flight control surfaces from the plain telemetry', () => {
  const base = { alpha: 0, flaps: 0, elevator: 0, aileron: 0, rudder: 0, onGround: false };

  it('schedules the leading-edge flaps with angle of attack and droops the ailerons with the flaps', () => {
    expect(surfacesFrom({ ...base, alpha: 10 * DEG }).lef).toBeGreaterThan(10);
    expect(surfacesFrom({ ...base, alpha: 40 * DEG }).lef).toBe(34);
    const full = surfacesFrom({ ...base, flaps: 1 });
    expect(full.tef).toBe(45);
    expect(full.aileronL).toBe(full.aileronR);
    expect(full.aileronL).toBeGreaterThan(40);
  });

  it('moves the stabilators together for pitch and apart for roll', () => {
    const s = surfacesFrom({ ...base, elevator: 0.5, aileron: 0.5 });
    expect((s.stabL + s.stabR) / 2).toBeCloseTo(12, 6);
    expect(s.stabR).toBeGreaterThan(s.stabL);
  });
});

describe('vapour', () => {
  it('appears over the LEX at high angle of attack in moist air, not in cruise', () => {
    expect(vapour(4 * DEG, 1, 1).lex).toBe(0);
    expect(vapour(25 * DEG, 1, 1).lex).toBeGreaterThan(0.6);
    expect(vapour(25 * DEG, 1, 0).lex).toBe(0);
    expect(vapour(5 * DEG, 7.5, 1).tip).toBeGreaterThan(0.8);
  });
});

describe('head-up display geometry', () => {
  const g = HUD_GEOMETRY;
  const eyeCentre = hudProject(g, SIZE, 1, 0, 0)!;

  it('draws the boresight where the eye looks straight ahead through the plane', () => {
    expect(eyeCentre.x).toBeCloseTo(SIZE.w / 2, 6);
    expect(eyeCentre.y).toBeCloseTo(SIZE.h / 2 + (g.offsetY / g.height) * SIZE.h, 6);
  });

  it('covers about 20 degrees, the real HUD field of view', () => {
    const fov = (2 * Math.atan(g.height / 2 / g.distance)) / DEG;
    expect(fov).toBeGreaterThan(17);
    expect(fov).toBeLessThan(22);
  });

  it('spaces the pitch ladder 5 degrees apart as the eye sees 5 degrees (collimated)', () => {
    // A ladder line 5 degrees up, straight ahead, wings level.
    const [f, r, u] = earthToBody(0, 5 * DEG, 0, 0);
    const p = hudProject(g, SIZE, f, r, u)!;
    const px = eyeCentre.y - p.y;
    // The plane point it lands on is seen from the eye under exactly 5 degrees.
    const y = (px / SIZE.h) * g.height;
    expect(Math.atan(y / g.distance) / DEG).toBeCloseTo(5, 6);
    // Degrees per pixel near the centre agree with the projection.
    expect(px / 5).toBeCloseTo(hudPixelsPerDegree(g, SIZE.h), 0);
  });

  it('matches the camera: a HUD degree spans as many screen pixels as a degree of the view', () => {
    // A camera at the eye with a 55 degree vertical field on a 900 px tall screen.
    const screenPxPerDeg = (900 / 2 / Math.tan((55 / 2) * DEG)) * Math.tan(DEG);
    // The HUD plane seen from the eye: canvas pixels per screen pixel.
    const planePxPerScreenPx =
      SIZE.h / g.height / (900 / 2 / Math.tan((55 / 2) * DEG) / g.distance);
    expect(hudPixelsPerDegree(g, SIZE.h) / planePxPerScreenPx).toBeCloseTo(screenPxPerDeg, 6);
  });

  it('turns the horizon with the bank: a point right on the horizon drops in a right bank', () => {
    const [, r, u] = earthToBody(10 * DEG, 0, 0, 30 * DEG);
    expect(u).toBeLessThan(0);
    expect(r).toBeGreaterThan(0);
    // Pitch up: the horizon ahead goes below the boresight by the pitch angle.
    const [f2, , u2] = earthToBody(0, 0, 8 * DEG, 0);
    expect(Math.atan2(u2, f2) / DEG).toBeCloseTo(-8, 6);
  });

  it('puts the on-speed bracket round 8.1 degrees angle of attack', () => {
    expect(onSpeed(ON_SPEED.alpha)).toBe('onSpeed');
    expect(onSpeed(10)).toBe('slow');
    expect(onSpeed(6)).toBe('fast');
  });
});

describe('display formatting', () => {
  it('formats the heading tape, altitude box, Mach, g and time to go as the Hornet does', () => {
    expect(formatHeading(0)).toBe('360');
    expect(formatHeading(5.4)).toBe('005');
    expect(formatHeading(-90)).toBe('270');
    expect(formatHudAltitude(12_345)).toBe('12,350');
    expect(formatHudAltitude(420)).toBe('420');
    expect(formatHudAltitude(1_004)).toBe('1,000');
    expect(formatMach(0.823)).toBe('.82');
    expect(formatMach(1.2)).toBe('1.20');
    expect(formatG(6.54)).toBe('6.5');
    expect(formatTimeToGo(125)).toBe('2:05');
    expect(formatTimeToGo(undefined)).toBe('--:--');
    expect(formatTimeToGo(3 * 3600 + 120)).toBe('3:02H');
    expect(formatFuelLb(10_437)).toBe('10440');
    expect(formatFuelLb(-5)).toBe('0');
  });

  it('keeps the HUD picture when nothing a pixel shows has changed', () => {
    const d: HudData = {
      on: true,
      pitch: 2,
      bank: 0,
      heading: 90,
      ias: 300,
      mach: 0.5,
      g: 1,
      peakG: 1,
      alpha: 3,
      alt: 10_000,
      radar: false,
      vv: 0,
      fpa: 0,
      drift: 0,
      landing: false,
      hdgBug: 90,
      cautions: [],
      bingo: false,
    };
    expect(hudKey({ ...d, pitch: 2.01 })).toBe(hudKey(d));
    expect(hudKey({ ...d, pitch: 2.5 })).not.toBe(hudKey(d));
    expect(hudKey({ ...d, on: false })).toBe('off');
  });
});
