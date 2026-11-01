import { describe, expect, it } from 'vitest';
import { severityOf } from '../src/game/Wreck';

describe('crash severity', () => {
  const vs = 30;
  it('a slow belly or hard landing leaves the airframe whole', () => {
    expect(severityOf({ reason: 'gear-up', speed: 40, sink: 2, bank: 0, vStall: vs })).toBe(1);
    expect(severityOf({ reason: 'hard-landing', speed: 35, sink: 7, bank: 0, vStall: vs })).toBe(1);
  });
  it('a wing tip or a fast touchdown tears off a wing', () => {
    expect(severityOf({ reason: 'wingtip', speed: 45, sink: 3, bank: 0.6, vStall: vs })).toBe(2);
    expect(severityOf({ reason: 'gear-up', speed: 55, sink: 4, bank: 0, vStall: vs })).toBe(2);
  });
  it('nose first, very fast or falling hard destroys it', () => {
    expect(severityOf({ reason: 'nose', speed: 45, sink: 20, bank: 0, vStall: vs })).toBe(3);
    expect(severityOf({ reason: 'terrain', speed: 90, sink: 5, bank: 0, vStall: vs })).toBe(3);
    expect(severityOf({ reason: 'terrain', speed: 40, sink: 25, bank: 0, vStall: vs })).toBe(3);
  });
});
