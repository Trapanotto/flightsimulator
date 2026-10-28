import { describe, expect, it } from 'vitest';
import raw from '../public/assets/airports/aeroways.json?raw';
import { type AeroData, aeroInTile, indexAero } from '../src/terrain/aeroMask';

const data = JSON.parse(raw) as AeroData;
const index = indexAero(data);

describe('airport pavement (taxiways, aprons)', () => {
  it('has the taxiways and aprons of the Swiss airports', () => {
    expect(data.taxiways.length).toBeGreaterThan(1000);
    expect(data.aprons.length).toBeGreaterThan(100);
    for (const t of data.taxiways) {
      expect(t.w).toBeGreaterThan(3);
      expect(t.c.length % 2).toBe(0);
    }
  });

  it('finds the pavement of a tile at Zürich and none over open country', () => {
    // A zoom-15 terrain tile (~0.0055° wide) over the Zürich airport.
    const zrh = aeroInTile(index, { west: 8.553, east: 8.5585, south: 47.453, north: 47.4585 });
    expect(zrh?.taxiways.length).toBeGreaterThan(0);
    const alps = aeroInTile(index, { west: 7.9, east: 7.9055, south: 46.55, north: 46.5555 });
    expect(alps).toBeNull();
  });
});
