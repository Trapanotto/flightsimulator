import { describe, expect, it } from 'vitest';
import { LEAF, LOOK, scotopicLoss } from '../../src/world/trees/leaf';
import { Form, SPECIES_COUNT, Species, formOf } from '../../src/world/trees/species';

describe('near-tree variety', () => {
  it('has a setting for every species', () => {
    for (let s = 0; s < SPECIES_COUNT; s++) {
      expect(LEAF[s as Species]).toHaveLength(4);
      expect(LOOK[s as Species]).toHaveLength(3);
      // Sprays of leaves or needles between a hand and an arm wide.
      expect(LEAF[s as Species][3]).toBeGreaterThan(0.1);
      expect(LEAF[s as Species][3]).toBeLessThan(0.5);
    }
  });
  it('makes oaks lumpier and gappier than beeches', () => {
    const [beech, oak] = [LEAF[Species.Beech], LEAF[Species.Oak]];
    expect(oak[0]).toBeGreaterThan(beech[0]);
    expect(oak[1]).toBeGreaterThan(beech[1]);
    expect(LOOK[Species.Oak][2]).toBeGreaterThan(LOOK[Species.Beech][2]);
  });
  it('never leaves out a conifer whorl (it would cut the cone in two)', () => {
    for (let s = 0; s < SPECIES_COUNT; s++)
      if (formOf(s) === Form.Conifer) expect(LEAF[s as Species][0]).toBe(0);
  });
});

describe('crowns at night', () => {
  it('keep their colour by day and lose most of it under the moon', () => {
    expect(scotopicLoss(0)).toBe(0);
    expect(scotopicLoss(1)).toBeGreaterThan(0.8);
    expect(scotopicLoss(1)).toBeLessThanOrEqual(1);
    expect(scotopicLoss(2)).toBe(scotopicLoss(1));
    expect(scotopicLoss(0.5)).toBeLessThan(scotopicLoss(1));
  });
});
