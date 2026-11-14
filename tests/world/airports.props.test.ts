import { InstancedMesh, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { LocalFrame, findAirport, seaLevelToEllipsoid } from '../../src/geo';
import {
  KNOT,
  PropKit,
  SOCK,
  nearestPlace,
  propPlaces,
  setWindsockConditions,
  sockAxis,
  windsockBands,
  windsockDroopDeg,
  windsockExtension,
  windsockUniforms,
  windsockYaw,
} from '../../src/world/airports/props';

/** Where the sock's +x points after turning by windsockYaw, as (east, north). */
const pointing = (fromDeg: number) => {
  const a = windsockYaw(fromDeg);
  // A turn by a about y takes +x to (cos a, 0, -sin a); north is -z.
  return { east: Math.cos(a), north: Math.sin(a) };
};

describe('windsock', () => {
  it('is fully extended at 15 knots (7.7 m/s) and limp in calm air', () => {
    expect(15 * KNOT).toBeCloseTo(7.72, 2);
    expect(windsockExtension(7.72)).toBeCloseTo(1, 3);
    expect(windsockExtension(20)).toBe(1);
    expect(windsockExtension(0)).toBe(0);
    expect(windsockDroopDeg(0)).toBe(90);
    expect(windsockDroopDeg(15 * KNOT)).toBeCloseTo(0, 9);
  });

  it('stands out one band of five for every 3 knots', () => {
    for (const kt of [3, 6, 9, 12, 15]) expect(windsockBands(kt * KNOT)).toBeCloseTo(kt / 3, 9);
    // Between limp and horizontal: 18 degrees less droop per band.
    expect(windsockDroopDeg(3 * KNOT)).toBeCloseTo(72, 9);
    expect(windsockDroopDeg(9 * KNOT)).toBeCloseTo(36, 9);
  });

  it('points downwind', () => {
    const cases: Array<[number, number, number]> = [
      [270, 1, 0], // from the west: towards the east
      [0, 0, -1], // from the north: south
      [360, 0, -1],
      [90, -1, 0], // from the east: west
      [180, 0, 1], // from the south: north
      [225, Math.SQRT1_2, Math.SQRT1_2], // from the south-west: north-east
    ];
    for (const [from, east, north] of cases) {
      const p = pointing(from);
      expect(p.east).toBeCloseTo(east, 9);
      expect(p.north).toBeCloseTo(north, 9);
    }
  });

  it('bends from hanging straight down to horizontal', () => {
    const limp = sockAxis(0, 1);
    expect(limp.x).toBeCloseTo(0, 2);
    expect(limp.y).toBeCloseTo(-SOCK.length, 2);
    const full = sockAxis(1, 1);
    expect(full.x).toBeCloseTo(SOCK.length, 2);
    expect(full.y).toBeCloseTo(0, 2);
    // Its middle stands at the droop angle; the tail sags more than the mouth, but never past
    // the vertical; the cloth keeps its length.
    for (const kt of [3, 6, 9, 12]) {
      const e = windsockExtension(kt * KNOT);
      expect((sockAxis(e, 0.5).angle * 180) / Math.PI).toBeCloseTo(windsockDroopDeg(kt * KNOT), 9);
      expect(sockAxis(e, 1).angle).toBeGreaterThan(sockAxis(e, 0).angle);
      expect(sockAxis(e, 1).angle).toBeLessThanOrEqual(Math.PI / 2);
      let length = 0;
      let prev = sockAxis(e, 0);
      for (let i = 1; i <= 100; i++) {
        const p = sockAxis(e, i / 100);
        length += Math.hypot(p.x - prev.x, p.y - prev.y);
        prev = p;
      }
      expect(length).toBeCloseTo(SOCK.length, 3);
    }
  });

  it('takes its uniforms from the conditions, phases wrapped for single precision', () => {
    setWindsockConditions({
      night: 0,
      exposure: 1,
      season: 'summer',
      snowLine: 3000,
      lightDirection: new Vector3(0, 1, 0),
      time: 36_000.25,
      wind: { fromDeg: 270, speed: 9 * KNOT },
    });
    const u = windsockUniforms;
    expect(u.yaw.value).toBeCloseTo(0, 9);
    expect(u.extension.value).toBeCloseTo(0.6, 9);
    for (const v of u.phase.value.toArray()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(2 * Math.PI);
    }
  });
});

describe('props', () => {
  const site = (icao: string) => {
    const a = findAirport(icao)!;
    const frame = new LocalFrame(a.lon, a.lat, seaLevelToEllipsoid(a.lon, a.lat, a.elevation));
    return propPlaces(frame, a, undefined);
  };

  it('share one material and one attribute layout whatever the number of instances', () => {
    // Different numbers of markers (grass runways of different lengths) must not change the
    // shader: no InstancedMesh, whose matrices are a uniform array sized by the count.
    const kit = new PropKit();
    const a = kit.create(site('LSZB'));
    const b = kit.create(site('LSZW'));
    expect(a.length).toBe(2);
    expect(b.length).toBe(2);
    expect(a[1]!.places.length).not.toBe(b[1]!.places.length);
    for (let k = 0; k < 2; k++) {
      const ma = a[k]!.mesh;
      const mb = b[k]!.mesh;
      expect(ma).not.toBeInstanceOf(InstancedMesh);
      expect(ma.material).toBe(mb.material);
      const layout = (m: typeof ma) =>
        Object.entries(m.geometry.attributes).map(([n, x]) => `${n}:${x.itemSize}`);
      expect(layout(ma)).toEqual(layout(mb));
    }
    kit.dispose();
  });

  it('cast no shadows that nobody sees', () => {
    const kit = new PropKit();
    for (const p of kit.create(site('LSZB'))) expect(p.mesh.castShadow).toBe(false);
    kit.dispose();
    // The layer switches a windsock's shadow on by its distance to the nearest sock.
    const place = new Float32Array([0, 0, 0, 1, 30, 0, 40, 2]);
    expect(nearestPlace(place, 2, { x: 30, y: 10, z: 40 })).toBeCloseTo(10, 9);
    expect(nearestPlace(place, 1, { x: 30, y: 0, z: 40 })).toBeCloseTo(50, 9);
  });
});
