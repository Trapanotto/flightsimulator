import { describe, expect, it } from 'vitest';
import { LocalFrame, findAirport, seaLevelToEllipsoid } from '../../src/geo';
import { decodeDetail } from '../../src/world/airports/detail';
import {
  type Draped,
  RUNWAY_PARAMS,
  buildGround,
  buildRunways,
  packRunway,
  placeHold,
  runwayAxes,
} from '../../src/world/airports/geometry';
import { buildGlyphAtlas, glyphDistance, GLYPH_COUNT } from '../../src/world/airports/glyphs';
import { runwayMarkings } from '../../src/world/airports/layout';
import { buildLights } from '../../src/world/airports/lights';
import { MAX_PULL, pullFraction } from '../../src/world/airports/pull';

const frameOf = (icao: string) => {
  const a = findAirport(icao)!;
  return { a, frame: new LocalFrame(a.lon, a.lat, seaLevelToEllipsoid(a.lon, a.lat, a.elevation)) };
};

/** Every triangle of a draped mesh faces up (+y) once laid flat. */
function facesUp(frame: LocalFrame, d: Draped) {
  const p = (i: number) =>
    frame.fromGeodetic(d.lon[i]!, d.lat[i]!, frame.origin.h, { x: 0, y: 0, z: 0 });
  let up = 0;
  let total = 0;
  for (let t = 0; t < d.index.length; t += 3) {
    const a = p(d.index[t]!);
    const b = p(d.index[t + 1]!);
    const c = p(d.index[t + 2]!);
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    if (Math.abs(ny) < 1e-6) continue;
    total++;
    if (ny > 0) up++;
  }
  return up / total;
}

describe('draped airport meshes', () => {
  it('builds Bern-Belp runway grid facing up, along the runway', () => {
    const { a, frame } = frameOf('LSZB');
    const d = buildRunways(frame, a, { step: 8, across: 7.5 });
    expect(d.index.length).toBeGreaterThan(0);
    expect(facesUp(frame, d)).toBe(1);
    const st = d.attributes.st!.array;
    const r = a.runways[0]!;
    let maxS = -Infinity;
    for (let i = 0; i < st.length; i += 2) maxS = Math.max(maxS, st[i]!);
    expect(maxS).toBeGreaterThan(r.length);
    expect(maxS).toBeLessThan(r.length + 4);
  });

  it('builds taxiways, aprons and holds from a detail file, all facing up', () => {
    const { a, frame } = frameOf('LSZH');
    // A small hand-made detail file in the format of tools/airports/build.mjs.
    const detail = decodeDetail({
      v: 1,
      icao: 'LSZH',
      origin: [a.lon, a.lat],
      scale: 1e-7,
      taxiways: [{ w: 23, c: [0, 0, 50000, 0, 50000, 30000] }],
      aprons: [{ c: [-20000, -20000, -10000, -20000, -10000, -10000, -20000, -10000] }],
      windsocks: [[1000, 1000]],
      holds: [[25000, 0]],
      towers: [],
    });
    expect(detail.taxiways[0]!.line[2]).toBeCloseTo(a.lon + 0.005, 9);
    const d = buildGround(frame, a, detail, { step: 8, across: 7.5 });
    expect(facesUp(frame, d)).toBeGreaterThan(0.999);
    const kinds = new Set<number>();
    const g = d.attributes.ground!.array;
    for (let i = 0; i < g.length; i += 3) kinds.add(g[i]!);
    expect([...kinds].sort()).toEqual([0, 1, 3]);
  });

  it('turns a holding position towards the nearest runway', () => {
    const { a, frame } = frameOf('LSZB');
    const axes = runwayAxes(frame, a.runways[0]!);
    // A taxiway at right angles to the runway, 100 m from it.
    const x0 = axes.ax + axes.dx * 500 + axes.rx * 100;
    const z0 = axes.az + axes.dz * 500 + axes.rz * 100;
    const line = {
      pts: [
        [x0 + axes.rx * 50, z0 + axes.rz * 50],
        [x0 - axes.rx * 50, z0 - axes.rz * 50],
      ] as Array<[number, number]>,
      half: 7.5,
    };
    const h = placeHold([x0, z0], [line], [axes])!;
    // Pointing towards the runway: against its right vector.
    expect(h.dx * axes.rx + h.dz * axes.rz).toBeCloseTo(-1, 6);
  });

  it('packs the marking parameters of a runway', () => {
    const { a } = frameOf('LSZH');
    const m = runwayMarkings(a.runways[0]!)!;
    const p = packRunway(m);
    expect(p).toHaveLength(RUNWAY_PARAMS);
    expect(p[0]).toBe(m.length);
    expect(p[1]).toBe(60);
    expect(p[5]).toBe(8); // stripes per side on 60 m
  });

  it('builds a few thousand lights at most for Zurich', () => {
    const { a, frame } = frameOf('LSZH');
    const b = buildLights(frame, a, undefined, {
      centreSpacing: 15,
      touchdownZone: true,
      taxiSpacing: 30,
    });
    expect(b.count).toBeGreaterThan(500);
    expect(b.count).toBeLessThan(5000);
    expect(b.colourA).toHaveLength(b.count * 3);
    expect(b.params).toHaveLength(b.count * 4);
  });
});

describe('designator glyphs', () => {
  it('are solid inside and empty outside, in a 3 x 9 m box', () => {
    for (let g = 0; g < GLYPH_COUNT; g++) {
      expect(glyphDistance(g, -0.5, 4.5)).toBeGreaterThan(0);
      expect(glyphDistance(g, 3.5, 4.5)).toBeGreaterThan(0);
      expect(glyphDistance(g, 1.5, 9.5)).toBeGreaterThan(0);
    }
    expect(glyphDistance(0, 1.5, 4.5)).toBeGreaterThan(0); // the hole of the 0
    expect(glyphDistance(8, 1.5, 4.5)).toBeLessThan(0); // the middle bar of the 8
    expect(glyphDistance(1, 1.5, 4.5)).toBeLessThan(0); // the stroke of the 1
    const atlas = buildGlyphAtlas();
    expect(atlas.data.length).toBe(atlas.width * atlas.height);
  });
});

describe('pull towards the camera', () => {
  it('covers a few centimetres at the wheels and metres from high up', () => {
    expect(pullFraction(1.2) * 1.2).toBeCloseTo(0.036, 3);
    expect(pullFraction(1000) * 1000).toBeCloseTo(5.03, 2);
    expect(pullFraction(0)).toBe(MAX_PULL);
  });
});
