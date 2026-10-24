import { describe, expect, it } from 'vitest';
import de from '../src/i18n/de.json';
import en from '../src/i18n/en.json';

describe('i18n', () => {
  it('has the same keys in every language', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
  });

  it('has no empty strings', () => {
    for (const table of [de, en]) {
      for (const value of Object.values(table)) expect(value.trim()).not.toBe('');
    }
  });
});
