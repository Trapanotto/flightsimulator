import { describe, expect, it } from 'vitest';
import {
  AI_CARD_RANGE,
  AI_PITCH_SCALE,
  ASI_SCALE,
  C172S_ASI,
  C172S_TACH,
  KG_PER_GAL_AVGAS,
  MS_TO_FPM,
  MS_TO_KT,
  M_TO_FT,
  altimeterAngles,
  asiAngle,
  attitudeCardOffset,
  attitudeCardV,
  compassLabelAt,
  flapIndicatorAngle,
  fuelPerTankGal,
  headingDelta,
  lag,
  slipBallAngle,
  smallGaugeAngle,
  tachAngle,
  turnCoordinatorAngle,
  vsiAngle,
} from '../../src/aircraft/instruments';
import {
  autoLights,
  beaconIntensity,
  glowVisibility,
  strobeIntensity,
} from '../../src/aircraft/lights';
import type { Telemetry } from '../../src/sim';

describe('unit conversions', () => {
  it('uses the exact definitions of knot, foot and US gallon', () => {
    expect((1852 / 3600) * MS_TO_KT).toBeCloseTo(1, 4); // 1 kt = 1852 m/h
    expect(0.3048 * M_TO_FT).toBeCloseTo(1, 12);
    expect((0.3048 / 60) * MS_TO_FPM).toBeCloseTo(1, 12);
    expect(KG_PER_GAL_AVGAS).toBeCloseTo(2.7255, 3);
  });
});

describe('airspeed indicator', () => {
  it('carries the 172S markings of the POH', () => {
    expect(C172S_ASI.white).toEqual([40, 85]);
    expect(C172S_ASI.green).toEqual([48, 129]);
    expect(C172S_ASI.yellow).toEqual([129, 163]);
    expect(C172S_ASI.vne).toBe(163);
  });

  it('points at the value fed to it and grows clockwise', () => {
    expect(asiAngle(100)).toBe(174);
    expect(asiAngle(40)).toBe(30);
    expect(asiAngle(70)).toBeCloseTo((78 + 126) / 2, 9);
    for (let i = 1; i < ASI_SCALE.length; i++)
      expect(ASI_SCALE[i]![1]).toBeGreaterThan(ASI_SCALE[i - 1]![1]);
    expect(asiAngle(-5)).toBe(0);
    expect(asiAngle(400)).toBe(352);
  });
});

describe('altimeter', () => {
  it('splits the altitude over the three pointers', () => {
    const a = altimeterAngles(12345);
    expect(a.p100).toBeCloseTo(345 * 0.36, 9);
    expect(a.p1000).toBeCloseTo(2345 * 0.036, 9);
    expect(a.p10000).toBeCloseTo(12345 * 0.0036, 9);
  });

  it('wraps below sea level the way the dial does', () => {
    const a = altimeterAngles(-100);
    expect(a.p100).toBeCloseTo(324, 9);
    expect(a.p1000).toBeCloseTo(356.4, 9);
  });
});

describe('vertical speed, tachometer, small gauges', () => {
  it('VSI: 0 at 9 o clock, climb clockwise, pinned at 2000 ft/min', () => {
    expect(vsiAngle(0)).toBe(-90);
    expect(vsiAngle(1000)).toBe(-5);
    expect(vsiAngle(-1000)).toBe(-175);
    expect(vsiAngle(5000)).toBe(80);
  });

  it('tachometer: green arc of the 172S 2100-2700 rpm, linear dial', () => {
    expect(C172S_TACH.green).toEqual([2100, 2700]);
    expect(tachAngle(0)).toBe(-125);
    expect(tachAngle(3500)).toBe(125);
    expect(tachAngle(1750)).toBe(0);
  });

  it('small gauges and the flap indicator sweep symmetrically', () => {
    expect(smallGaugeAngle(0, 0, 10)).toBe(-50);
    expect(smallGaugeAngle(5, 0, 10)).toBe(0);
    expect(smallGaugeAngle(20, 0, 10)).toBe(50);
    expect(flapIndicatorAngle(0)).toBe(-60);
    expect(flapIndicatorAngle(1)).toBe(60);
  });

  it('fuel: total kilograms split over the two tanks in gallons', () => {
    expect(fuelPerTankGal(2 * 26.5 * KG_PER_GAL_AVGAS)).toBeCloseTo(26.5, 9);
    expect(fuelPerTankGal(-3)).toBe(0);
  });
});

describe('turn coordinator', () => {
  it('banks the symbol 20 degrees at standard rate, right is clockwise', () => {
    expect(turnCoordinatorAngle(3, 0)).toBe(20);
    expect(turnCoordinatorAngle(-3, 0)).toBe(-20);
    expect(turnCoordinatorAngle(30, 0)).toBe(40);
  });

  it('moves the ball to the right in a right sideslip', () => {
    expect(slipBallAngle(0)).toBe(0);
    expect(slipBallAngle((2 * Math.PI) / 180)).toBeGreaterThan(0);
    expect(slipBallAngle(1)).toBe(10);
  });
});

describe('attitude indicator', () => {
  it('shows the horizon at the centre in level flight and below it nose up', () => {
    expect(attitudeCardV(0.5, 0)).toBeCloseTo(0.5, 9);
    // 10 deg nose up: the centre of the dial shows sky 10 deg above the horizon.
    const centre = attitudeCardV(0.5, 10);
    expect(centre).toBeCloseTo((AI_CARD_RANGE - 10) / (2 * AI_CARD_RANGE), 9);
    // The horizon then sits AI_PITCH_SCALE * 10 dial radii below the centre.
    const v = 0.5 + (10 * AI_PITCH_SCALE) / (2 * 0.7);
    expect(attitudeCardV(v, 10)).toBeCloseTo(0.5, 9);
  });

  it('the shader offset reproduces attitudeCardV', () => {
    const scale = (2 * 0.7) / AI_PITCH_SCALE / (2 * AI_CARD_RANGE);
    for (const pitch of [-20, -5, 0, 7, 25]) {
      for (const v of [0, 0.3, 0.5, 1]) {
        const shader = v * scale + (0.5 - scale / 2) + attitudeCardOffset(pitch);
        expect(shader).toBeCloseTo(attitudeCardV(v, pitch), 9);
      }
    }
  });
});

describe('compass and headings', () => {
  it('prints the wet-compass card reversed: N at the pilot, W to the right', () => {
    expect(compassLabelAt(0)).toBe(0);
    expect(compassLabelAt(0.25)).toBe(270);
    expect(compassLabelAt(0.75)).toBe(90);
  });

  it('takes the short way round', () => {
    expect(headingDelta(350, 10)).toBe(20);
    expect(headingDelta(10, 350)).toBe(-20);
    expect(headingDelta(0, 180)).toBe(180);
  });

  it('lags without overshoot and is exact for a zero time constant', () => {
    expect(lag(0, 10, 1, 1)).toBeCloseTo(10 * (1 - Math.exp(-1)), 9);
    expect(lag(0, 10, 0.1, 0)).toBe(10);
    expect(lag(3, 10, 0, 1)).toBe(3);
  });
});

describe('exterior lights', () => {
  it('glow weakly in daylight and fully at night', () => {
    expect(glowVisibility(4.2)).toBeCloseTo(0.2, 6);
    expect(glowVisibility(1)).toBeCloseTo(0.2, 6);
    expect(glowVisibility(400)).toBeCloseTo(1, 6);
    expect(glowVisibility(1e5)).toBeCloseTo(1, 6);
    // Dusk lies in between, and brighter surroundings never mean a stronger glow.
    let last = 0;
    for (const e of [4.2, 10, 40, 150, 400]) {
      const v = glowVisibility(e);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    expect(glowVisibility(40)).toBeGreaterThan(0.4);
    expect(glowVisibility(40)).toBeLessThan(0.8);
  });

  const base: Telemetry = {
    time: 0,
    ias: 0,
    tas: 0,
    groundSpeed: 0,
    altitude: 500,
    agl: 0,
    verticalSpeed: 0,
    headingDeg: 0,
    trackDeg: 0,
    pitch: 0,
    bank: 0,
    alpha: 0,
    beta: 0,
    loadFactor: 1,
    onGround: true,
    stallWarning: false,
    flaps: 0,
    gear: 1,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    engines: [{ running: false, rpm: 0, power: 0, fuelFlow: 0 }],
    fuel: 100,
    crashed: undefined,
  };

  it('are dark with the engine off, beacon and nav with it running', () => {
    expect(Object.values(autoLights(base)).some(Boolean)).toBe(false);
    const run = { ...base, engines: [{ running: true, rpm: 1000, power: 0.1, fuelFlow: 0 }] };
    expect(autoLights(run)).toMatchObject({
      nav: true,
      beacon: true,
      strobe: false,
      landing: false,
    });
    expect(autoLights({ ...run, groundSpeed: 30 })).toMatchObject({ strobe: true, landing: true });
    expect(autoLights({ ...run, onGround: false, agl: 1500 })).toMatchObject({
      strobe: true,
      landing: false,
    });
  });

  it('flash in fixed patterns: beacon 45/min, strobe double flash', () => {
    expect(beaconIntensity(0.05)).toBe(1);
    expect(beaconIntensity(0.6)).toBe(0);
    expect(beaconIntensity(60 / 45 + 0.05)).toBe(1);
    expect(strobeIntensity(0.02)).toBe(1);
    expect(strobeIntensity(0.08)).toBe(0);
    expect(strobeIntensity(0.14)).toBe(1);
    expect(strobeIntensity(0.5)).toBe(0);
  });
});
