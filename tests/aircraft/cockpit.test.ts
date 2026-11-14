import { describe, expect, it } from 'vitest';
import {
  DualKnobTurn,
  KnobTurn,
  ROCKER_DEG,
  dimmerDeg,
  rockerAngle,
  selectorDeg,
  slideShare,
  stepsBetween,
  xpdrDigits,
  MAGNETO_DEG,
} from '../../src/aircraft/controlPoses';
import {
  dragControl,
  pressControl,
  turnKnob,
  wheelControl,
} from '../../src/aircraft/controlClicks';
import {
  autopilotModes,
  avionicsFromCockpit,
  content,
  formatBearing,
  formatDmeDistance,
  formatDmeMinutes,
  formatDmeSpeed,
  formatFrequency,
  formatSquawk,
  formatVerticalSpeed,
  mapOffsetNm,
  mapRange,
} from '../../src/aircraft/displays';
import { CABIN, OCCLUDERS, inBox, pickBox, rayBox, sideOf } from '../../src/aircraft/picking';
import { darkness, displayGlow, highlightGlow, panelGlow } from '../../src/aircraft/lights';
import { C172_CONTROLS, CockpitPanel, type ControlSpec } from '../../src/sim';

const spec = (id: string): ControlSpec => C172_CONTROLS.find((s) => s.id === id)!;

describe('control poses', () => {
  it('tilts a rocker into the panel at the top when on', () => {
    expect(rockerAngle(1)).toBeCloseTo((ROCKER_DEG * Math.PI) / 180, 9);
    expect(rockerAngle(0)).toBeCloseTo((-ROCKER_DEG * Math.PI) / 180, 9);
  });

  it('turns the key clockwise from OFF to START and clamps the index', () => {
    const angles = [0, 1, 2, 3, 4].map((i) => selectorDeg(MAGNETO_DEG, i));
    for (let i = 1; i < 5; i++) expect(angles[i]!).toBeGreaterThan(angles[i - 1]!);
    expect(selectorDeg(MAGNETO_DEG, 9)).toBe(MAGNETO_DEG[4]);
  });

  it('moves push-pull knobs out for idle, lean, alternate air, a set brake and a closed valve', () => {
    expect(slideShare('throttle', 1)).toBe(0);
    expect(slideShare('throttle', 0)).toBe(1);
    expect(slideShare('mixture', 0.25)).toBeCloseTo(0.75, 9);
    expect(slideShare('carbHeat', 1)).toBe(1);
    expect(slideShare('parkingBrake', 1)).toBe(1);
    expect(slideShare('fuelShutoff', 1)).toBe(0);
    expect(slideShare('flaps', 2, spec('flaps'))).toBeCloseTo(2 / 3, 9);
    expect(slideShare('com1Swap', 1)).toBe(1);
  });

  it('sweeps the dimmer over 270 degrees', () => {
    expect(dimmerDeg(0)).toBe(-135);
    expect(dimmerDeg(1)).toBe(135);
  });

  it('splits a squawk into its octal digits', () => {
    expect(xpdrDigits(7000)).toEqual([7, 0, 0, 0]);
    expect(xpdrDigits(1234)).toEqual([1, 2, 3, 4]);
  });

  it('turns a knob by the steps it was turned, the short way round, and ignores jumps', () => {
    const hdg = spec('headingBug');
    expect(stepsBetween(hdg, 359, 0)).toBe(1);
    expect(stepsBetween(hdg, 0, 359)).toBe(-1);
    const k = new KnobTurn(4);
    k.update(hdg, 10);
    expect(k.update(hdg, 12)).toBe(8);
    expect(k.update(hdg, 190)).toBe(8); // a jump of 178 steps is not a turn
  });

  it('turns the inner knob for kHz and the outer ring for MHz, not at all on a swap', () => {
    const s = spec('com1Standby');
    const d = new DualKnobTurn(1000, true);
    d.update(s, 121_500);
    expect(d.update(s, 121_525)).toEqual({ inner: 15, outer: 0 });
    expect(d.update(s, 122_525)).toEqual({ inner: 15, outer: 15 });
    // 975 -> 000 within the MHz is one step up.
    d.update(s, 122_975);
    const before = d.inner;
    expect(d.update(s, 122_000).inner).toBe(before + 15);
    // A swap changes both parts: the knob stays.
    expect(d.update(s, 118_100)).toEqual({ inner: before + 15, outer: 15 });
  });
});

describe('click rules', () => {
  it('flips a toggle, holds a button, steps a selector by side', () => {
    expect(pressControl(spec('battery'), 0, { side: 0 })).toEqual({ value: 1 });
    expect(pressControl(spec('com1Swap'), 0, { side: 0 })).toEqual({ value: 1, release: 0 });
    expect(pressControl(spec('fuelSelector'), 1, { side: 1 }).value).toBe(2);
    expect(pressControl(spec('fuelSelector'), 1, { side: -1 }).value).toBe(0);
    expect(pressControl(spec('fuelSelector'), 2, { side: 1 }).value).toBe(2);
    expect(pressControl(spec('navSource'), 1, { side: 0 }).value).toBe(0);
  });

  it('holds START while pressed and lets the key return to BOTH', () => {
    expect(pressControl(spec('magnetos'), 3, { side: 1 })).toEqual({ value: 4, release: 3 });
    expect(pressControl(spec('magnetos'), 2, { side: 1 })).toEqual({ value: 3 });
  });

  it('tunes kHz within the MHz and MHz within the band, as the radios do', () => {
    const com = spec('com1Standby');
    expect(turnKnob(com, 121_500, 1)).toBe(121_525);
    expect(turnKnob(com, 121_975, 1)).toBe(121_000);
    expect(turnKnob(com, 121_000, -1)).toBe(121_975);
    expect(turnKnob(com, 136_975, 1, 1000)).toBe(118_975);
    expect(turnKnob(com, 118_100, -1, 1000)).toBe(136_100);
    const nav = spec('nav1Standby');
    expect(turnKnob(nav, 110_950, 1)).toBe(110_000);
    expect(turnKnob(nav, 117_500, 1, 1000)).toBe(108_500);
  });

  it('keeps transponder digits octal without carrying', () => {
    const x = spec('xpdrCode');
    expect(turnKnob(x, 7000, 1, 1000)).toBe(0);
    expect(turnKnob(x, 1207, 1, 1)).toBe(1200);
    expect(turnKnob(x, 1200, -1, 10)).toBe(1270);
  });

  it('adds coarse steps to the ADF and the selected altitude, clamped', () => {
    expect(turnKnob(spec('adfFrequency'), 300, 1, 100)).toBe(400);
    expect(turnKnob(spec('adfFrequency'), 1700, 1, 100)).toBe(1750);
    expect(turnKnob(spec('apAltitude'), 3000, -1, 1000)).toBe(2000);
    expect(turnKnob(spec('apAltitude'), 3000, 1)).toBe(3100);
  });

  it('turns knobs with the wheel and drags levers, alternate air the other way', () => {
    expect(wheelControl(spec('obs1'), 359, 2, { side: 0 })).toBe(1);
    expect(dragControl(spec('throttle'), 0.5, -90, 900)).toBeGreaterThan(0.5);
    expect(dragControl(spec('carbHeat'), 0.5, 90, 900)).toBeGreaterThan(0.5);
    expect(dragControl(spec('trim'), 0, 90, 900)).toBeGreaterThan(0);
  });
});

describe('display formatting', () => {
  it('shows frequencies with two decimals', () => {
    expect(formatFrequency(110_500)).toBe('110.50');
    expect(formatFrequency(118_100)).toBe('118.10');
    expect(formatFrequency(121_525)).toBe('121.52');
    expect(formatFrequency(108_050)).toBe('108.05');
  });

  it('shows the squawk as four digits', () => {
    expect(formatSquawk(7000)).toBe('7000');
    expect(formatSquawk(21)).toBe('0021');
  });

  it('shows the DME with one decimal below 100 NM and dashes without a signal', () => {
    expect(formatDmeDistance(12.44)).toBe('12.4');
    expect(formatDmeDistance(123.4)).toBe('123');
    expect(formatDmeDistance(undefined)).toBe('--.-');
    expect(formatDmeSpeed(118.6)).toBe('119');
    expect(formatDmeSpeed(undefined)).toBe('---');
    expect(formatDmeMinutes(6.4)).toBe('6');
    expect(formatDmeMinutes(undefined)).toBe('--');
  });

  it('writes bearings and vertical speeds as pilots read them', () => {
    expect(formatBearing(5)).toBe('005°');
    expect(formatBearing(0)).toBe('360°');
    expect(formatVerticalSpeed(500)).toBe('+500');
    expect(formatVerticalSpeed(-1240)).toBe('-1200');
  });

  it('annunciates the autopilot modes', () => {
    const ap = avionicsFromCockpit(new CockpitPanel(C172_CONTROLS))!.autopilot;
    expect(autopilotModes(ap).lateral).toBe('');
    const on = { ...ap, engaged: true, lateral: 'hdg' as const, lateralArmed: 'nav' as const };
    expect(autopilotModes(on)).toMatchObject({ lateral: 'HDG', lateralArmed: 'NAV ARM' });
  });

  it('shows the knobs without the avionics, powered by the master and avionics switches', () => {
    const c = new CockpitPanel(C172_CONTROLS);
    const data = (p: CockpitPanel) => ({
      avionics: avionicsFromCockpit(p),
      systems: undefined,
      altimeterSetting: 1013,
      gpsCdi: false,
      time: 0,
    });
    expect(content('COM1', data(c))).toBe('');
    c.set('battery', 1);
    c.set('avionics', 1);
    expect(content('COM1', data(c))).toBe('118.10|121.50');
    expect(content('KOLL', data(c))).toBe('1013');
  });

  it('picks a map range that shows the next waypoint', () => {
    expect(mapRange(3)).toBe(5);
    expect(mapRange(40)).toBe(100);
    const o = mapOffsetNm(7, 47, 7, 47.5);
    expect(o.north).toBeCloseTo(30, 6);
    expect(o.east).toBeCloseTo(0, 9);
  });
});

describe('picking', () => {
  const box = (control: string, x: number, side: [number, number, number] = [-1, 0, 0]) => ({
    control,
    center: [x, 0, 1] as const,
    half: [0.01, 0.01, 0.01] as const,
    side,
  });

  it('enters and leaves a box along the ray', () => {
    expect(rayBox([0, 0, 0], [0, 0, 1], [0, 0, 1], [0.1, 0.1, 0.1])).toEqual([0.9, 1.1]);
    expect(rayBox([0, 0, 0], [0, 0, -1], [0, 0, 1], [0.1, 0.1, 0.1])).toBeNull();
  });

  it('takes the nearer box, and the better-centred of two at the same depth', () => {
    const a = box('a', 0);
    const b = { ...box('b', 0.008), center: [0.008, 0, 1] as const };
    expect(pickBox([0, 0, 0], [0, 0, 1], [a, b], [])!.box.control).toBe('a');
    expect(pickBox([0.007, 0, 0], [0, 0, 1], [a, b], [])!.box.control).toBe('b');
    const near = { ...box('near', 0), center: [0, 0, 0.5] as const };
    expect(pickBox([0, 0, 0], [0, 0, 1], [a, near], [])!.box.control).toBe('near');
  });

  it('reaches nothing through an occluder', () => {
    const wall = { center: [0, 0, 0.5] as const, half: [1, 1, 0.01] as const };
    expect(pickBox([0, 0, 0], [0, 0, 1], [box('a', 0)], [wall])).toBeNull();
  });

  it('tells the halves apart', () => {
    const b = box('k', 0);
    expect(sideOf([-0.004, 0, 1], b.center, b.side)).toBe(1);
    expect(sideOf([0.004, 0, 1], b.center, b.side)).toBe(-1);
    expect(sideOf([0.004, 0, 1], b.center, [0, 0, 0])).toBe(0);
  });

  it('counts the pilot eye as inside the cabin and keeps it out of every occluder', () => {
    // Eye at BL 0.27, FS 1.06, WL 1.72 (tools/aircraft/c172/dims.py) in the model frame.
    const eye = [0.27, 1.72 - 1.22, 1.041 - 1.06] as const;
    expect(inBox(eye, CABIN.center, CABIN.half)).toBe(true);
    for (const o of OCCLUDERS) expect(inBox(eye, o.center, o.half)).toBe(false);
    expect(inBox([0, 3, 0], CABIN.center, CABIN.half)).toBe(false);
  });
});

describe('panel lighting', () => {
  it('lets post lights show at night only and dims the displays then', () => {
    expect(darkness(4.2)).toBe(0);
    expect(darkness(400)).toBe(1);
    expect(panelGlow(400, 1)).toBeGreaterThan(0.3);
    expect(panelGlow(400, 1)).toBeLessThan(0.5);
    expect(panelGlow(400, 0)).toBe(0);
    expect(panelGlow(4.2, 1)).toBeLessThan(0.05);
    expect(displayGlow(4.2)).toBeGreaterThan(displayGlow(400));
    expect(highlightGlow(4.2)).toBeGreaterThan(highlightGlow(400));
  });
});
