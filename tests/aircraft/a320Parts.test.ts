import { describe, expect, it } from 'vitest';
import {
  CONFIGS,
  N1_RPM,
  configLabel,
  fanBlur,
  fanRpm,
  gearLights,
  gearSequence,
  highLift,
  spoilerPose,
} from '../../src/aircraft/a320Parts';
import {
  FmaBoxes,
  baroText,
  defaultSpeeds,
  fcuAltitudeText,
  fcuHeadingText,
  fcuSpeedText,
  fcuVsText,
  fmaColor,
  fmaLines,
  freqText,
  fuelFlowKgh,
  leverAngle,
  ndRangeNm,
  readA320,
  rudderTrimText,
  thrustLimit,
} from '../../src/aircraft/a320Format';
import { KEY_REGIONS, PANEL_PAINTER, PANEL_WINDOW_REGIONS } from '../../src/aircraft/a320Panel';
import type { AvionicsTelemetry } from '../../src/sim';

describe('A320 gear sequence', () => {
  it('opens the doors, moves the legs, and closes the doors behind them', () => {
    const up = gearSequence(0);
    const down = gearSequence(1);
    expect(up).toEqual({ main: 0, nose: 0, mainDoors: 0, noseDoors: 0 });
    expect(down.main).toBe(1);
    expect(down.nose).toBe(1);
    // With the gear down the hydraulic doors are shut again (only the leg doors stay open).
    expect(down.mainDoors).toBe(0);
    expect(down.noseDoors).toBe(0);
    // The doors are open before the legs start to move, and while they move.
    const early = gearSequence(0.14);
    expect(early.mainDoors).toBeGreaterThan(0.95);
    expect(early.main).toBe(0);
    expect(gearSequence(0.5).mainDoors).toBe(1);
    // The legs move monotonically.
    let last = -1;
    for (let g = 0; g <= 1.0001; g += 0.05) {
      const p = gearSequence(g);
      expect(p.main).toBeGreaterThanOrEqual(last);
      last = p.main;
    }
  });

  it('lights three greens down and locked, UNLK while anything moves', () => {
    expect(gearLights(1)).toEqual({ down: true, up: false, transit: false });
    expect(gearLights(0)).toEqual({ down: false, up: true, transit: false });
    expect(gearLights(0.5).transit).toBe(true);
    // Legs locked down but the doors still closing: still in transit.
    expect(gearLights(0.93)).toMatchObject({ down: true, transit: true });
  });
});

describe('A320 slats and flaps', () => {
  it('has the published configurations (FCOM: 0, 1, 1+F, 2, 3, FULL)', () => {
    expect(CONFIGS.map((c) => [c.slats, c.flaps])).toEqual([
      [0, 0],
      [18, 0],
      [22, 15],
      [22, 20],
      [27, 35],
    ]);
    // The flaps are where the simulation has them (share of 35 degrees), the slats follow the lever.
    expect(highLift(0, 0, 250)).toEqual({ slats: 0, flaps: 0, label: '0' });
    expect(highLift(1, 10 / 35, 150)).toEqual({ slats: 18, flaps: 10, label: '1+F' });
    expect(highLift(1, 0, 230)).toEqual({ slats: 18, flaps: 0, label: '1' });
    expect(highLift(2, 15 / 35, 180)).toEqual({ slats: 22, flaps: 15, label: '2' });
    expect(highLift(3, 20 / 35, 150)).toEqual({ slats: 22, flaps: 20, label: '3' });
    expect(highLift(4, 1, 140)).toEqual({ slats: 27, flaps: 35, label: 'FULL' });
  });

  it('shows no configuration while the flaps run between the positions', () => {
    const h = highLift(4, 0.8, 150);
    expect(h.slats).toBe(27);
    expect(h.flaps).toBeCloseTo(28, 5);
    expect(h.label).toBe('');
    expect(configLabel(22, 15)).toBe('2');
    expect(configLabel(20, 10)).toBe('');
  });
});

describe('A320 spoilers', () => {
  it('raises all ten panels as ground spoilers on the ground', () => {
    const p = spoilerPose(1, 0, true);
    expect(p.left).toEqual([50, 50, 50]);
    expect(p.right).toEqual([50, 50, 50]);
  });

  it('uses panels 2-4 as the speed brake in the air', () => {
    const p = spoilerPose(0.5, 0, false);
    expect(p.left).toEqual([0, 20, 0]);
    expect(p.right).toEqual([0, 20, 0]);
  });

  it('raises panels 2-5 of the down-going wing with the roll', () => {
    const right = spoilerPose(0, 1, false);
    expect(right.right[1]).toBeCloseTo(35, 5);
    expect(right.right[2]).toBeCloseTo(35, 5);
    expect(right.left).toEqual([0, 0, 0]);
    const left = spoilerPose(0, -0.5, false);
    expect(left.left[1]).toBeGreaterThan(10);
    expect(left.right).toEqual([0, 0, 0]);
    // With the speed brake out, the up-going wing's panels come down by the roll command.
    const both = spoilerPose(1, 0.3, false);
    expect(both.right[1]).toBe(40);
    expect(both.left[1]).toBeLessThan(40);
  });
});

describe('A320 engines', () => {
  it('turns the fan at N1 (100 % = 5000 rpm) and blurs it at speed', () => {
    expect(N1_RPM).toBe(5000);
    expect(fanRpm({ running: true, rpm: 0, power: 0.5, fuelFlow: 0.5, n1: 60 })).toBe(3000);
    expect(fanRpm({ running: false, rpm: 120, power: 0, fuelFlow: 0 })).toBe(120);
    expect(fanBlur(0)).toEqual({ disc: 0, blades: true });
    expect(fanBlur(5000)).toEqual({ disc: 1, blades: false });
  });
});

describe('A320 display formatting', () => {
  it('shows the FCU windows as the real unit does', () => {
    expect(fcuSpeedText(250, false, false)).toBe('250');
    expect(fcuSpeedText(250, false, true)).toBe('---');
    expect(fcuSpeedText(78, true, false)).toBe('.78');
    expect(fcuHeadingText(5, false)).toBe('005');
    expect(fcuHeadingText(360, false)).toBe('000');
    expect(fcuHeadingText(90, true)).toBe('---');
    expect(fcuAltitudeText(5000)).toBe('05000');
    expect(fcuAltitudeText(35000)).toBe('35000');
    expect(fcuVsText(-1200, true)).toBe('-12oo');
    expect(fcuVsText(700, true)).toBe('+07oo');
    expect(fcuVsText(700, false)).toBe('-----');
    expect(baroText(1013.2, false)).toBe('1013');
    expect(baroText(1013.25, true)).toBe('Std');
    expect(freqText(118_100)).toBe('118.100');
    expect(rudderTrimText(0)).toBe('0.0');
    expect(rudderTrimText(-0.1)).toBe('L 2.0');
    expect(ndRangeNm(1)).toBe(20);
  });

  it('colours the FMA by the Airbus conventions', () => {
    expect(fmaColor(1, 0, 'CLB')).toBe('green');
    expect(fmaColor(1, 1, 'ALT')).toBe('blue');
    expect(fmaColor(0, 0, 'MAN TOGA')).toBe('white');
    expect(fmaColor(0, 0, 'THR LK')).toBe('amber');
    expect(fmaColor(3, 0, 'CAT 3')).toBe('white');
    expect(fmaColor(3, 2, 'DH 100')).toBe('blue');
    expect(fmaColor(4, 0, 'AP1+2')).toBe('white');
    expect(fmaLines([['SPEED'], ['G/S', 'LAND']])[1]).toEqual(['G/S', 'LAND', '']);
    expect(fmaLines(undefined)).toHaveLength(5);
  });

  it('boxes a newly engaged mode for ten seconds, not what was there from the start', () => {
    const b = new FmaBoxes();
    const fma = (v: string) => [['SPEED'], [v], ['NAV'], [], []];
    expect(b.update(fma('CLB'), 0)[1]).toBe(false);
    expect(b.update(fma('ALT*'), 5)[1]).toBe(true);
    expect(b.update(fma('ALT*'), 14.9)[1]).toBe(true);
    expect(b.update(fma('ALT*'), 15.1)[1]).toBe(false);
  });

  it('reads the Airbus block of the autopilot telemetry defensively', () => {
    const av = {
      autopilot: {
        airbus: {
          fma: {
            thrust: 'SPEED',
            thrustCaution: '',
            vertical: 'G/S',
            verticalArmed: '',
            lateral: 'LOC',
            lateralArmed: '',
            combined: false,
            capability: 'CAT 3 DUAL',
            minimum: 'DH 100',
            autopilot: 'AP1+2',
            flightDirectors: '1 FD 2',
            autothrust: 'armed',
            changed: [false, true, false, false, false],
          },
          speeds: {
            vls: 128,
            f: NaN,
            greenDot: 'x',
            alphaProt: 118,
            target: 133,
            managed: true,
            mach: false,
          },
          fcu: {
            speed: NaN,
            mach: false,
            heading: 137,
            altitude: 5000,
            verticalSpeed: NaN,
            speedDot: true,
          },
          controls: {
            law: 'normal',
            config: 'FULL',
            slats: 27,
            flaps: 35,
            autobrake: 'medium',
            autobrakeDecel: true,
          },
          ecam: {
            warnings: ['ENG 1 FAIL'],
            memo: ['SEAT BELTS', 3],
            masterWarning: true,
            masterCaution: false,
          },
        },
      },
    } as unknown as AvionicsTelemetry;
    const a = readA320(av);
    expect(a.fma?.[1]).toEqual(['G/S', '']);
    expect(a.fma?.[3]).toEqual(['CAT 3', 'DUAL', 'DH 100']);
    expect(a.fma?.[4]).toEqual(['AP1+2', '1 FD 2', 'A/THR']);
    expect(a.athrArmed).toBe(true);
    expect(a.fmaChanged).toEqual([false, true, false, false, false]);
    // NaN hides a speed; a wrong type is dropped.
    expect(a.speeds).toEqual({ vls: 128, vAlphaProt: 118 });
    expect(a.target).toEqual({ speed: 133, managed: true, mach: false, trend: undefined });
    expect(a.fcu?.speed).toBeUndefined();
    expect(a.fcu?.heading).toBe(137);
    expect(a.ap1 && a.ap2).toBe(true);
    expect(a.autobrake).toEqual({ mode: 'medium', decel: true });
    expect(a.config).toBe('FULL');
    expect(a.flaps).toBe(35);
    expect(a.warnings).toEqual(['ENG 1 FAIL']);
    expect(a.memo).toBeUndefined();
    expect(readA320(undefined)).toEqual({});
    expect(readA320({ autopilot: {} } as AvionicsTelemetry)).toEqual({});
  });

  it('gives engine and thrust figures in the E/WD units', () => {
    expect(fuelFlowKgh(0.25)).toBe(900);
    expect(thrustLimit(1, true).mode).toBe('TOGA');
    expect(thrustLimit(0.82, true).mode).toBe('FLX');
    expect(thrustLimit(0.82, false).mode).toBe('MCT');
    expect(thrustLimit(0.62, false).mode).toBe('CLB');
    // Thrust lever detents: CL 25, FLX/MCT 35, TOGA 45 degrees.
    expect(leverAngle(0.62, false)).toBeCloseTo(25, 5);
    expect(leverAngle(0.82, false)).toBeCloseTo(35, 5);
    expect(leverAngle(1, false)).toBeCloseTo(45, 5);
    expect(leverAngle(1, true)).toBe(-20);
    const sp = defaultSpeeds(4);
    expect(sp.vls).toBeGreaterThan(sp.vAlphaProt);
    expect(sp.vAlphaProt).toBeGreaterThan(sp.vAlphaMax);
    expect(defaultSpeeds(0).greenDot).toBe(213);
  });
});

describe('A320 panel atlas', () => {
  it('keeps every window inside the canvas without overlaps', () => {
    const rects = Object.values(PANEL_PAINTER.regions);
    expect(rects.length).toBe(
      Object.keys(PANEL_WINDOW_REGIONS).length + Object.keys(KEY_REGIONS).length,
    );
    for (const r of rects) {
      expect(r.x + r.w).toBeLessThanOrEqual(PANEL_PAINTER.width);
      expect(r.y + r.h).toBeLessThanOrEqual(PANEL_PAINTER.height);
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${i}/${j}`).toBe(false);
      }
  });
});
