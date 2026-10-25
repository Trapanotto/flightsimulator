import { describe, expect, it } from 'vitest';
import { parseLabel } from '../src/ui/PlaceSearch';

describe('search labels', () => {
  it('splits kind and name and drops all HTML', () => {
    expect(parseLabel('<i>Ort</i> <b>Gandria</b> (TI) - Lugano')).toEqual({
      kind: 'Ort',
      name: 'Gandria (TI) - Lugano',
    });
    expect(parseLabel('<b>Bern</b>')).toEqual({ kind: '', name: 'Bern' });
    expect(parseLabel('<i>x</i><img src=x onerror=alert(1)>Name').name).toBe('Name');
  });
});
