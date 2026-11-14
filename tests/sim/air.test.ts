/**
 * The air model on synthetic terrain: wind profile, terrain flow, thermals, breezes,
 * turbulence, smoothness, determinism and cost.
 */
import { describe, expect, it } from 'vitest';
import { AirModel, type AirWeather } from '../../src/sim/air/airModel';
import type { AirTerrain } from '../../src/sim/air/terrainField';
import type { Vec3 } from '../../src/sim/types';
import {
  RIDGE_HEIGHT,
  cone,
  latAt,
  lonAt,
  plane,
  ridge,
  ridgeHeight,
  terrain,
  valley,
} from './airTerrains';

const v = (): Vec3 => ({ x: 0, y: 0, z: 0 });

/** Overcast, neutral, 10 m/s from the west: wind and terrain only, no sun-driven air. */
const WINDY: AirWeather = {
  windFromDeg: 270,
  windSpeed: 10,
  sunElevationDeg: -10,
  cloudCover: 1,
  temperature: 10,
  stability: 0,
};
/** A summer afternoon with a light breeze. */
const SUNNY: AirWeather = {
  windFromDeg: 270,
  windSpeed: 3,
  sunElevationDeg: 55,
  sunAzimuthDeg: 220,
  cloudCover: 0.2,
  temperature: 26,
};
/** Calm weather for the breezes, by day and by night. */
const CALM_DAY: AirWeather = {
  windFromDeg: 0,
  windSpeed: 0.5,
  sunElevationDeg: 50,
  cloudCover: 0,
  temperature: 22,
};
const CALM_NIGHT: AirWeather = { ...CALM_DAY, sunElevationDeg: -15 };

const model = (weather: AirWeather, seed = 1) => {
  const m = new AirModel({ seed });
  m.setWeather(weather);
  return m;
};

/** Fields of the last sample at a point (x east, y north in metres, h above sea level). */
const at = (m: AirModel, t: AirTerrain, x: number, y: number, h: number, time = 100) => {
  const out = m.sample(lonAt(x), latAt(y), h, time, t, v());
  return { ...m.last, out: { ...out } };
};

describe('wind with height', () => {
  const m = model(WINDY);
  const flat = plane(400);
  const dirFrom = (e: number, n: number) => ((Math.atan2(-e, -n) * 180) / Math.PI + 360) % 360;

  it('gives the reported wind 10 m above open ground', () => {
    const s = at(m, flat, 0, 0, 410);
    expect(Math.hypot(s.windEast, s.windNorth)).toBeCloseTo(10, 1);
    expect(dirFrom(s.windEast, s.windNorth)).toBeCloseTo(270, 0);
  });

  it('strengthens and veers with height, then blends into the free flow', () => {
    const speeds: number[] = [];
    const dirs: number[] = [];
    for (const agl of [10, 50, 200, 500, 1000, 1500, 3000]) {
      const s = at(m, flat, 0, 0, 400 + agl);
      speeds.push(Math.hypot(s.windEast, s.windNorth));
      dirs.push(dirFrom(s.windEast, s.windNorth));
    }
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]!).toBeGreaterThanOrEqual(speeds[i - 1]! - 1e-9);
      expect(dirs[i]!).toBeGreaterThanOrEqual(dirs[i - 1]! - 1e-9);
    }
    // Neutral power law (1/7 to 1/6): about twice the surface wind at the top.
    expect(speeds[4]! / speeds[0]!).toBeGreaterThan(1.7);
    expect(speeds[4]! / speeds[0]!).toBeLessThan(2.3);
    // Ekman veer over land: 20-40° clockwise (northern hemisphere).
    expect(dirs[6]! - dirs[0]!).toBeGreaterThan(20);
    expect(dirs[6]! - dirs[0]!).toBeLessThan(40);
    // Free flow: no change from 1500 m to 3000 m above ground.
    expect(Math.abs(speeds[6]! - speeds[5]!)).toBeLessThan(0.15);
  });

  it('has a steeper profile in stable and a flatter one in convective air', () => {
    const ratio = (stability: number) => {
      const mm = model({ ...WINDY, stability });
      const lo = at(mm, flat, 0, 0, 410);
      const hi = at(mm, flat, 0, 0, 1400);
      return Math.hypot(hi.windEast, hi.windNorth) / Math.hypot(lo.windEast, lo.windNorth);
    };
    expect(ratio(1)).toBeGreaterThan(ratio(0));
    expect(ratio(0)).toBeGreaterThan(ratio(-1));
  });
});

describe('terrain flow', () => {
  it('has no terrain effect on a plane', () => {
    const m = model(WINDY);
    const flat = plane(400);
    const ref = at(m, flat, 0, 0, 600);
    for (const [x, y] of [
      [1234, -567],
      [-8000, 3000],
      [20_000, 15_000],
    ]) {
      const s = at(m, flat, x!, y!, 600);
      expect(s.terrainUp).toBe(0);
      expect(s.breezeUp).toBe(0);
      expect(s.windEast).toBeCloseTo(ref.windEast, 9);
      expect(s.windNorth).toBeCloseTo(ref.windNorth, 9);
    }
  });

  it('gives 2-5 m/s of ridge lift upwind of a steep 500 m ridge in 10 m/s, fading with height', () => {
    const m = model(WINDY);
    const r = ridge();
    let best = { w: -Infinity, x: 0 };
    for (let x = -1500; x <= 500; x += 50) {
      const s = at(m, r, x, 0, Math.max(ridgeHeight(x) + 100, RIDGE_HEIGHT + 50));
      if (s.terrainUp > best.w) best = { w: s.terrainUp, x };
    }
    expect(best.w).toBeGreaterThan(2);
    expect(best.w).toBeLessThan(5);
    // Upwind of the crest, within a few hundred metres of it.
    expect(best.x).toBeLessThan(0);
    expect(best.x).toBeGreaterThan(-900);
    const low = at(m, r, best.x, 0, RIDGE_HEIGHT + 50).terrainUp;
    const mid = at(m, r, best.x, 0, RIDGE_HEIGHT + 400).terrainUp;
    const high = at(m, r, best.x, 0, RIDGE_HEIGHT + 1200).terrainUp;
    expect(mid).toBeLessThan(0.6 * low);
    expect(high).toBeLessThan(0.2 * low);
    expect(mid).toBeGreaterThan(0);
  });

  it('sinks of similar size in the lee, with rotor turbulence below the crest', () => {
    const m = model(WINDY);
    const r = ridge();
    let sink = Infinity;
    let lift = -Infinity;
    for (let x = -1500; x <= 1500; x += 50) {
      const w = at(m, r, x, 0, ridgeHeight(x) + 100).terrainUp;
      sink = Math.min(sink, w);
      lift = Math.max(lift, w);
    }
    expect(sink).toBeLessThan(-2);
    expect(sink).toBeGreaterThan(-6);
    expect(Math.abs(sink) / lift).toBeGreaterThan(0.6);
    expect(Math.abs(sink) / lift).toBeLessThan(1.6);
    const windward = at(m, r, -700, 0, ridgeHeight(-700) + 60).turbulence;
    const lee = at(m, r, 700, 0, ridgeHeight(700) + 60).turbulence;
    expect(lee).toBeGreaterThan(1.3 * windward);
  });

  it('speeds up over the crest and shelters a valley across the wind', () => {
    const m = model(WINDY);
    const flat = plane(0);
    const r = ridge();
    const speed = (s: { windEast: number; windNorth: number }) =>
      Math.hypot(s.windEast, s.windNorth);
    const open = speed(at(m, flat, 0, 0, 80));
    const crest = speed(at(m, r, 0, 0, RIDGE_HEIGHT + 80));
    expect(crest / open).toBeGreaterThan(1.2);
    expect(crest / open).toBeLessThan(1.9);
    // The valley runs north-south, the wind blows across it from the west.
    const vm = model(WINDY);
    const val = valley();
    const floor = speed(at(vm, val, 0, 0, 544 + 80));
    const openAgain = speed(at(m, flat, 0, 0, 80));
    expect(floor / openAgain).toBeLessThan(0.85);
    expect(floor / openAgain).toBeGreaterThan(0.4);
  });

  it('lifts on the windward side of an isolated cone and less in stable air', () => {
    const c = cone();
    // On the windward flank, 200 m below the summit (ground at 800 m is 500 m from the top).
    const lift = (weather: AirWeather) => {
      const m = model(weather);
      let best = -Infinity;
      for (let x = -1500; x <= -600; x += 50) best = Math.max(best, at(m, c, x, 0, 800).terrainUp);
      // Per m/s of the wind arriving at that height.
      const free = at(m, plane(400), 0, 0, 800);
      return best / Math.hypot(free.windEast, free.windNorth);
    };
    const neutral = lift(WINDY);
    expect(neutral * 20).toBeGreaterThan(1);
    expect(neutral * 20).toBeLessThan(4);
    // Stable air in a light wind flows round an isolated hill rather than over it (Froude
    // number U / (N H) below 1).
    const light = { ...WINDY, windSpeed: 3 };
    expect(lift({ ...light, stability: 1 })).toBeLessThan(0.7 * lift({ ...light, stability: -1 }));
    const m = model(WINDY);
    expect(at(m, c, 800, 0, 1000).terrainUp).toBeLessThan(-0.5);
  });

  it('fades the terrain effects in smoothly when the terrain arrives', () => {
    let loaded = false;
    const r = ridgeHeight;
    const t = terrain((x) => r(x));
    const late: AirTerrain = { height: (lon, lat) => (loaded ? t.height(lon, lat) : undefined) };
    const m = model(WINDY);
    const flat = plane(0);
    const ctrl = model(WINDY);
    const x = -500;
    const s0 = at(m, late, x, 0, 650, 0);
    expect(s0.terrainUp).toBe(0);
    expect(s0.terrainKnown).toBe(0);
    // Without terrain the wind is that of a nominal 300 m above ground.
    const nominal = at(ctrl, flat, 0, 0, 300, 0);
    expect(s0.windEast).toBeCloseTo(nominal.windEast, 6);
    loaded = true;
    let last = s0.out;
    let maxStep = 0;
    for (let i = 1; i <= 120 * 6; i++) {
      const s = at(m, late, x, 0, 650, i / 120);
      maxStep = Math.max(maxStep, Math.hypot(s.out.x - last.x, s.out.y - last.y, s.out.z - last.z));
      last = s.out;
    }
    expect(maxStep).toBeLessThan(0.1);
    expect(at(m, late, x, 0, 650, 6).terrainUp).toBeGreaterThan(1.5);
  });
});

describe('thermals', () => {
  const flat = plane(400);

  it('reach 1-4 m/s in the afternoon and average to about zero over an area', () => {
    const m = model(SUNNY);
    let sum = 0;
    let n = 0;
    let max = -Infinity;
    let min = Infinity;
    for (let i = 0; i < 120; i++)
      for (let j = 0; j < 120; j++) {
        const s = at(m, flat, i * 120 - 7000, j * 120 - 7000, 1200, 30_000);
        sum += s.thermalUp;
        n++;
        max = Math.max(max, s.thermalUp);
        min = Math.min(min, s.thermalUp);
      }
    const mean = sum / n;
    expect(max).toBeGreaterThan(1.5);
    expect(max).toBeLessThan(4.5);
    expect(min).toBeLessThan(-0.2);
    expect(Math.abs(mean)).toBeLessThan(0.08);
  });

  it('are none at night or under overcast', () => {
    for (const w of [
      { ...SUNNY, sunElevationDeg: -5 },
      { ...SUNNY, cloudCover: 1 },
    ]) {
      const m = model(w);
      for (let i = 0; i < 50; i++)
        expect(at(m, flat, i * 211, i * 97, 1000, 30_000).thermalUp).toBe(0);
    }
  });

  it('stay in place for a while, drift with the wind and reach the cloud base', () => {
    const m = model({ ...SUNNY, cloudBase: 2400 });
    // Find a strong core.
    let core = { w: -Infinity, x: 0, y: 0 };
    for (let i = 0; i < 60; i++)
      for (let j = 0; j < 60; j++) {
        const s = at(m, flat, i * 75, j * 75, 1200, 30_000);
        if (s.thermalUp > core.w) core = { w: s.thermalUp, x: i * 75, y: j * 75 };
      }
    expect(core.w).toBeGreaterThan(1);
    // The same core 20 s later, moved downwind (wind from the west: towards the east).
    let moved = { w: -Infinity, x: 0 };
    for (let dx = -200; dx <= 600; dx += 10) {
      const w = at(m, flat, core.x + dx, core.y, 1200, 30_020).thermalUp;
      if (w > moved.w) moved = { w, x: dx };
    }
    expect(moved.w).toBeGreaterThan(0.8 * core.w);
    expect(moved.x).toBeGreaterThan(30);
    expect(moved.x).toBeLessThan(300);
    // Up to the cloud base (2000 m above the ground), not beyond; the column leans downwind.
    let nearBase = -Infinity;
    let above = 0;
    for (let dx = -500; dx <= 5000; dx += 25) {
      nearBase = Math.max(nearBase, at(m, flat, core.x + dx, core.y, 2300, 30_000).thermalUp);
      above = Math.max(above, Math.abs(at(m, flat, core.x + dx, core.y, 2700, 30_000).thermalUp));
    }
    expect(nearBase).toBeGreaterThan(0.4 * core.w);
    expect(above).toBe(0);
  });

  it('are stronger on a slope facing the sun', () => {
    // Afternoon sun from the south-west: compare the south-west and north-east flanks.
    const m = model(SUNNY);
    const c = cone();
    const spread = (dir: number) => {
      let s2 = 0;
      let n = 0;
      for (let k = 0; k < 40; k++)
        for (const r of [500, 750, 1000]) {
          const a = dir + (k - 20) * 1.5;
          const x = r * Math.sin((a * Math.PI) / 180);
          const y = r * Math.cos((a * Math.PI) / 180);
          for (let t = 0; t < 10; t++) {
            const w = at(m, c, x, y, 1700, 20_000 + t * 300).thermalUp;
            s2 += w * w;
            n++;
          }
        }
      return Math.sqrt(s2 / n);
    };
    expect(spread(220)).toBeGreaterThan(1.3 * spread(40));
  });
});

describe('slope and valley winds', () => {
  const val = valley();
  const floorHeight = 500 + 1200 * 2 * Math.exp(-4);

  it('blow up the valley by day and down it at night, a few m/s near the ground', () => {
    const day = at(model(CALM_DAY), val, 0, 0, floorHeight + 30);
    const night = at(model(CALM_NIGHT), val, 0, 0, floorHeight + 30);
    // The floor rises to the north.
    expect(day.breezeNorth).toBeGreaterThan(1);
    expect(day.breezeNorth).toBeLessThan(5);
    expect(night.breezeNorth).toBeLessThan(-0.5);
    expect(night.breezeNorth).toBeGreaterThan(-5);
  });

  it('blow up the slopes by day and down at night, and fade in wind', () => {
    const x = 1800;
    const h = 500 + 1200 * Math.exp(-((1200 / 1500) ** 2)) + 1200 * Math.exp(-((4800 / 1500) ** 2));
    const day = at(model(CALM_DAY), val, x, 0, h + 20);
    const night = at(model(CALM_NIGHT), val, x, 0, h + 20);
    // The eastern ridge rises towards the east from here.
    expect(day.breezeEast).toBeGreaterThan(0.8);
    expect(day.breezeUp).toBeGreaterThan(0.2);
    expect(night.breezeEast).toBeLessThan(-0.3);
    const windy = at(model({ ...CALM_DAY, windSpeed: 12 }), val, x, 0, h + 20);
    expect(Math.abs(windy.breezeEast)).toBeLessThan(0.15 * day.breezeEast);
    // Shallow: gone 400 m above the slope.
    expect(Math.abs(at(model(CALM_DAY), val, x, 0, h + 400).breezeEast)).toBeLessThan(0.1);
  });
});

describe('turbulence', () => {
  const flat = plane(400);

  const stats = (m: AirModel, agl: number) => {
    // A long straight path at 60 m/s, the gusts sampled by distance and time.
    const n = 40_000;
    const out = v();
    const e: number[] = [];
    const w: number[] = [];
    let sigU = 0;
    let sigW = 0;
    for (let i = 0; i < n; i++) {
      const tt = i * 0.5;
      m.sample(lonAt(-60_000 + 30 * i), latAt(10 * i), 400 + agl, tt, flat, out);
      e.push(m.last.gustEast);
      w.push(out.z);
      sigU = m.last.sigmaHorizontal;
      sigW = m.last.sigmaVertical;
    }
    const sd = (a: number[]) => {
      const mean = a.reduce((s, x) => s + x, 0) / a.length;
      return Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length);
    };
    return { sdE: sd(e), sdW: sd(w), sigU, sigW, w };
  };

  it('matches the intended intensity within 20 %', () => {
    for (const agl of [80, 1000]) {
      const s = stats(model(WINDY, 7), agl);
      // The surface wind runs east here, so the east gust is the longitudinal one.
      expect(s.sdE / s.sigU).toBeGreaterThan(0.8);
      expect(s.sdE / s.sigU).toBeLessThan(1.2);
      expect(s.sdW / s.sigW).toBeGreaterThan(0.8);
      expect(s.sdW / s.sigW).toBeLessThan(1.2);
    }
  });

  it('has the intensities of MIL-F-8785C at low altitude', () => {
    // σw = 0.1 W20; σu = σw / (0.177 + 0.000823 h)^0.4 with h in feet.
    const s = at(model(WINDY), flat, 0, 0, 400 + 60);
    const w20 = 10 * Math.pow(0.61, 0.16);
    expect(s.sigmaVertical).toBeCloseTo(Math.hypot(0.1 * w20, 0.05), 2);
    const hft = 60 / 0.3048;
    expect(s.sigmaHorizontal).toBeCloseTo(
      Math.hypot((0.1 * w20) / Math.pow(0.177 + 0.000823 * hft, 0.4), 0.05),
      2,
    );
  });

  it('has a Dryden-like correlation length along the path', () => {
    // At 1000 m above ground Lw = 533 m; the samples are 31.6 m apart.
    const s = stats(model(WINDY, 3), 1000);
    const corr = (lag: number) => {
      let a = 0;
      let b = 0;
      for (let i = 0; i + lag < s.w.length; i++) {
        a += s.w[i]! * s.w[i + lag]!;
        b += s.w[i]! * s.w[i]!;
      }
      return a / b;
    };
    const lag = Math.round(533 / 31.6);
    expect(corr(1)).toBeGreaterThan(0.85);
    expect(corr(lag)).toBeGreaterThan(0.15);
    expect(corr(lag)).toBeLessThan(0.75);
    expect(Math.abs(corr(20 * lag))).toBeLessThan(0.2);
  });

  it('is light in calm stable air and grows with wind', () => {
    const calm = at(model({ ...CALM_NIGHT, windSpeed: 1, stability: 1 }), flat, 0, 0, 700);
    expect(calm.sigmaVertical).toBeLessThan(0.15);
    expect(calm.turbulence).toBeLessThan(0.08);
    const windy = at(model({ ...WINDY, windSpeed: 15 }), flat, 0, 0, 700);
    expect(windy.turbulence).toBeGreaterThan(3 * calm.turbulence);
    const m = model(WINDY);
    expect(m.turbulenceAt(lonAt(0), latAt(0), 700, 100, flat)).toBeGreaterThan(0);
    expect(m.turbulenceAt(lonAt(0), latAt(0), 700, 100, flat)).toBeLessThanOrEqual(1);
  });
});

describe('smoothness, determinism and cost', () => {
  it('changes by less than 0.5 m/s per step on a flight across the ridge at 60 m/s', () => {
    for (const weather of [WINDY, SUNNY, { ...WINDY, windSpeed: 18 }]) {
      const m = model(weather);
      const r = ridge();
      const out = v();
      let last: Vec3 | undefined;
      let maxStep = 0;
      for (let i = 0; i < 120 * 100; i++) {
        const x = -3000 + 0.5 * i;
        const h = Math.max(ridgeHeight(x) + 40, 560);
        m.sample(lonAt(x), latAt(0.1 * i), h, 1000 + i / 120, r, out);
        if (last)
          maxStep = Math.max(maxStep, Math.hypot(out.x - last.x, out.y - last.y, out.z - last.z));
        last = { ...out };
      }
      expect(maxStep).toBeLessThan(0.5);
    }
  });

  it('is deterministic and independent of call order', () => {
    const points = Array.from({ length: 300 }, (_, i) => ({
      x: -2000 + ((i * 7919) % 4000),
      y: ((i * 104729) % 6000) - 3000,
      h: 500 + ((i * 31) % 1500),
      t: 1000 + ((i * 13) % 600),
    }));
    const run = (order: number[], seed = 5) => {
      const m = model(SUNNY, seed);
      const r = ridge();
      const res: Vec3[] = [];
      for (const k of order) {
        const p = points[k]!;
        res[k] = { ...m.sample(lonAt(p.x), latAt(p.y), p.h, p.t, r, v()) };
      }
      return res;
    };
    const forward = points.map((_, i) => i);
    const a = run(forward);
    const b = run([...forward].reverse());
    const c = run(forward.map((i) => (i * 37) % points.length));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    const other = run(forward, 6);
    expect(other).not.toEqual(a);
  });

  it('samples terrain sparingly and runs 10 000 samples in under 50 ms', () => {
    const m = model(SUNNY);
    const r = ridge();
    const out = v();
    const path = (offset: number) => {
      for (let i = 0; i < 10_000; i++)
        m.sample(lonAt(-3000 + 0.5 * i), latAt(offset + 0.2 * i), 800, offset + i / 120, r, out);
    };
    path(0); // warm up the JIT and the caches
    const before = r.calls;
    const times: number[] = [];
    for (let k = 1; k <= 3; k++) {
      const t0 = performance.now();
      path(3000 * k);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[1]!).toBeLessThan(50);
    // Three new 5 km paths: some hundreds of terrain samples, not thousands per path.
    expect((r.calls - before) / 3).toBeLessThan(600);
  });

  it('blends a weather change without a jolt', () => {
    const m = model(WINDY);
    const r = ridge();
    const out = v();
    let last: Vec3 | undefined;
    let maxStep = 0;
    for (let i = 0; i < 120 * 40; i++) {
      const t = 500 + i / 120;
      if (i === 120 * 5) m.setWeather({ ...SUNNY, windFromDeg: 300, windSpeed: 6 }, t);
      m.sample(lonAt(-800), latAt(0), 700, t, r, out);
      if (last)
        maxStep = Math.max(maxStep, Math.hypot(out.x - last.x, out.y - last.y, out.z - last.z));
      last = { ...out };
    }
    expect(maxStep).toBeLessThan(0.2);
  });

  it('draws the vertical air on a grid for a debug view', () => {
    const m = model(WINDY);
    const r = ridge();
    const n = 21;
    const grid = m.verticalGrid(
      lonAt(0),
      latAt(0),
      150,
      100,
      r,
      100,
      n,
      new Float32Array(n * n),
      true,
    );
    // Rows run south to north, columns west to east: lift on the west half, sink on the east.
    const row = Array.from(grid.slice(10 * n, 11 * n));
    expect(Math.max(...row.slice(0, 10))).toBeGreaterThan(2);
    expect(Math.min(...row.slice(11))).toBeLessThan(-2);
    // Without gusts, the same as the structured parts of a sample.
    const ground = at(m, r, -500, 0, 0).ground;
    const s = at(m, r, -500, 0, ground + 150);
    const g = m.verticalGrid(lonAt(-500), latAt(0), 150, 100, r, 100, 1, new Float32Array(1), true);
    expect(g[0]!).toBeCloseTo(s.terrainUp + s.thermalUp + s.breezeUp, 3);
  });
});
