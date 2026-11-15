import { describe, expect, it } from 'vitest';
import { LocalFrame, seaLevelToEllipsoid } from '@geo';
import {
  SWISSBUILDINGS_GRID,
  cellBounds,
  cellsInRange,
  shouldEvict,
  tilesInRange,
} from '../../src/world/buildings/grid';
import { GroundGrid, fillGaps } from '../../src/world/buildings/groundGrid';
import { FLAG_GROUND, MeshBuilder } from '../../src/world/buildings/mesh';
import { BUILDING_PRESETS, footprintLod } from '../../src/world/buildings/presets';
import { estimateHeight, planBuilding } from '../../src/world/buildings/style';
import { orientedBox } from '../../src/world/buildings/footprint';
import { KIND } from '../../src/world/buildings/mesh';

const bern = { lon: 7.451, lat: 46.948, agl: 300 };

describe('tile selection', () => {
  it('picks the zoom-14 tiles in range, nearest first', () => {
    const t = tilesInRange(bern, 14, 5000);
    expect(t.length).toBeGreaterThan(20);
    expect(t.length).toBeLessThan(60);
    // The tile under the camera comes first, at the camera's height.
    expect(t[0]!.distance).toBeCloseTo(300, 6);
    for (let i = 1; i < t.length; i++)
      expect(t[i]!.distance).toBeGreaterThanOrEqual(t[i - 1]!.distance);
    expect(t.every((w) => w.distance < 5000)).toBe(true);
    // Above the range nothing is wanted.
    expect(tilesInRange({ ...bern, agl: 6000 }, 14, 5000)).toHaveLength(0);
  });

  it('picks known 3D cells within range, at most the budget', () => {
    const g = SWISSBUILDINGS_GRID;
    const cx = Math.floor((bern.lon - g.west) / ((g.east - g.west) / g.size));
    const cy = Math.floor((bern.lat - g.south) / ((g.north - g.south) / g.size));
    const cells: number[] = [];
    for (let dy = -10; dy <= 10; dy++)
      for (let dx = -10; dx <= 10; dx++) cells.push((cy + dy) * 2048 + cx + dx);
    const near = cellsInRange(g, { ...bern, agl: 100 }, cells, 900, 1000);
    // About pi * 0.9^2 / (0.168 * 0.108) = 140 cells inside 900 m, plus those it touches.
    expect(near.length).toBeGreaterThan(90);
    expect(near.length).toBeLessThan(190);
    expect(cellsInRange(g, { ...bern, agl: 100 }, cells, 900, 40)).toHaveLength(40);
    const b = cellBounds(g, near[0]!.key);
    expect(bern.lon).toBeGreaterThanOrEqual(b.west);
    expect(bern.lon).toBeLessThan(b.east);
  });

  it('keeps tiles a little beyond their range before evicting them', () => {
    expect(shouldEvict(5500, 5000)).toBe(false);
    expect(shouldEvict(6300, 5000)).toBe(true);
  });

  it('switches footprint builds with hysteresis', () => {
    const p = BUILDING_PRESETS.desktop;
    expect(footprintLod(1000, undefined, p)).toBe(0);
    expect(footprintLod(p.footprintNearRange + 10, undefined, p)).toBe(1);
    expect(footprintLod(p.footprintDetailRange + 10, undefined, p)).toBe(2);
    expect(footprintLod(p.footprintRange + 10, undefined, p)).toBe(3);
    // Just past the boundary a tile keeps its build...
    expect(footprintLod(p.footprintDetailRange * 1.1, 1, p)).toBe(1);
    // ...well past it, it changes.
    expect(footprintLod(p.footprintDetailRange * 1.3, 1, p)).toBe(2);
    expect(footprintLod(p.footprintDetailRange * 0.9, 2, p)).toBe(2);
    expect(footprintLod(p.footprintDetailRange * 0.5, 2, p)).toBe(1);
    expect(footprintLod(p.footprintNearRange * 0.5, 1, p)).toBe(0);
  });

  it('gives the phone clearly less to draw', () => {
    const d = BUILDING_PRESETS.desktop;
    const m = BUILDING_PRESETS.mobile;
    expect(m.footprintRange).toBeLessThan(d.footprintRange / 2);
    expect(m.detailRange).toBeLessThan(d.detailRange / 2);
    expect(m.maxCells).toBeLessThan(d.maxCells / 4);
  });
});

describe('ground under the buildings', () => {
  const frame = new LocalFrame(7.45, 46.95, 0);
  // A slope rising 0.1 m per metre east from 540 m above sea level.
  const ground = (lon: number, lat: number) => {
    const p = frame.fromGeodetic(lon, lat, 0, { x: 0, y: 0, z: 0 });
    return seaLevelToEllipsoid(lon, lat, 540) + 0.1 * p.x;
  };

  it('samples the terrain in the tile frame and interpolates it', () => {
    const g = new GroundGrid(frame, -100, 100, -50, 50, 20);
    while (!g.ready) g.fill(ground, 37);
    const at0 = g.sample(0, 0);
    expect(g.sample(50, 0) - at0).toBeCloseTo(5, 1);
    expect(g.sample(-50, 10) - at0).toBeCloseTo(-5, 1);
    // Tile-frame y at the origin: the ellipsoid height (the frame sits on the ellipsoid).
    expect(at0).toBeCloseTo(seaLevelToEllipsoid(7.45, 46.95, 540), 1);
  });

  it('lifts each building onto its anchor and sinks wall feet into a slope', () => {
    const g = new GroundGrid(frame, -100, 100, -50, 50, 20);
    while (!g.ready) g.fill(ground, 1000);
    // One building anchored at x = 0; a roof vertex, and wall feet at x = -10 (lower ground)
    // and x = +10 (higher ground).
    const b = new MeshBuilder();
    b.begin({
      anchorX: 0,
      anchorZ: 0,
      cell: -1,
      seed: 0,
      roof: [0, 0, 0],
      wall: [0, 0, 0],
      kind: 0,
      eave: 6,
    });
    b.vertex(0, 8, 0);
    b.vertex(-10, -1, 0, FLAG_GROUND);
    b.vertex(10, -1, 0, FLAG_GROUND);
    const m = b.finish();
    const lift = new Float32Array(3);
    g.lift(m, lift);
    const gA = g.sample(0, 0);
    expect(lift[0]).toBeCloseTo(gA, 3);
    // Downhill foot: down to the terrain there, minus 0.4 m.
    expect(-1 + lift[1]!).toBeCloseTo(g.sample(-10, 0) - 0.4, 3);
    // Uphill foot: the building's own base is lower than that terrain anyway.
    expect(-1 + lift[2]!).toBeCloseTo(gA - 1, 3);
  });

  it('waits while there is no terrain, and fills holes from neighbours', () => {
    const g = new GroundGrid(frame, -100, 100, -50, 50, 20);
    expect(g.fill(() => undefined, 10_000).completed).toBe(false);
    expect(g.ready).toBe(false);
    const v = new Float32Array([1, NaN, 3, NaN, NaN, NaN, 7, NaN, 9]);
    fillGaps(v, 3, 3);
    expect(Array.from(v).every((x) => Number.isFinite(x))).toBe(true);
    expect(v[1]).toBeCloseTo(2, 6);
  });
});

describe('building plans', () => {
  const box = (L: number, W: number) => orientedBox([0, 0, L, 0, L, W, 0, W]);
  const facts = {
    fill: 1,
    holes: false,
    elevation: 550,
    density: 200,
    seed: 0.3,
  };

  it('estimates heights from the footprint when the data has none', () => {
    expect(estimateHeight(10, 100)).toBeLessThan(estimateHeight(150, 100));
    expect(estimateHeight(150, 100)).toBeLessThan(estimateHeight(150, 1000));
    expect(estimateHeight(5000, 100)).toBeGreaterThan(8);
  });

  it('keeps eaves below the ridge and the roof under half the house', () => {
    for (let s = 0; s < 1; s += 0.05) {
      const p = planBuilding({ ...facts, seed: s, area: 140, box: box(14, 10), height: 11 });
      expect(p.eave).toBeLessThanOrEqual(p.height);
      expect(p.height - p.eave).toBeLessThanOrEqual(p.height * 0.5 + 1e-9);
      expect(p.eave).toBeGreaterThan(2);
    }
  });

  it('gives large halls flat roofs and slender towers spires', () => {
    expect(planBuilding({ ...facts, area: 6000, box: box(100, 60), height: 12 }).roof).toBe('flat');
    const tower = planBuilding({ ...facts, area: 64, box: box(8, 8), height: 45 });
    expect(tower.kind).toBe(KIND.tower);
    expect(tower.height - tower.eave).toBeGreaterThan(8);
    const church = planBuilding({
      ...facts,
      area: 600,
      box: box(40, 15),
      height: 22,
      cls: 'place_of_worship',
    });
    expect(church.kind).toBe(KIND.church);
    expect(church.roof).toBe('gabled');
    expect(
      planBuilding({ ...facts, area: 200, box: box(20, 10), cls: 'roof', height: 5 }).kind,
    ).toBe(KIND.canopy);
  });

  it('builds alpine houses as chalets', () => {
    const p = planBuilding({ ...facts, elevation: 1300, area: 150, box: box(15, 10), height: 9 });
    expect(p.kind).toBe(KIND.chalet);
  });
});
