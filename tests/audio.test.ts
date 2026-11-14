import { describe, expect, it } from 'vitest';
import {
  CATCH_TIME,
  brakeSquealLevel,
  engineLevel,
  engineMode,
  firingShare,
  groundRollLevel,
  gyroSpin,
  rainLevel,
  surfaceSound,
  touchdownLevel,
  windLevel,
} from '../src/audio/levels';

describe('sound levels', () => {
  it('has a silent stopped engine and a louder one at higher rpm, quieter inside', () => {
    expect(engineLevel(0, false)).toBe(0);
    expect(engineLevel(600, false)).toBeGreaterThan(0.2);
    expect(engineLevel(2700, false)).toBeGreaterThan(engineLevel(1000, false));
    expect(engineLevel(2700, true)).toBeLessThan(engineLevel(2700, false));
    expect(engineLevel(5000, false)).toBeLessThanOrEqual(1);
  });

  it('lets the wind grow with the square of the airspeed', () => {
    expect(windLevel(0, 80, false)).toBe(0);
    expect(windLevel(40, 80, false)).toBeCloseTo(windLevel(80, 80, false) / 4, 6);
    expect(windLevel(200, 80, false)).toBe(windLevel(80, 80, false));
  });

  it('rumbles only while rolling on the ground', () => {
    expect(groundRollLevel(false, 30, false)).toBe(0);
    expect(groundRollLevel(true, 0, false)).toBe(0);
    expect(groundRollLevel(true, 20, false)).toBeGreaterThan(0);
  });
});

describe('engine start and stop', () => {
  it('tells stopped, cranking, catching, running and windmilling apart', () => {
    expect(engineMode(false, 0, false, 99)).toBe('stopped');
    expect(engineMode(false, 250, true, 99)).toBe('cranking');
    expect(engineMode(true, 400, true, 0.2)).toBe('catching');
    expect(engineMode(true, 800, false, CATCH_TIME + 0.1)).toBe('running');
    expect(engineMode(false, 900, false, 99)).toBe('windmilling');
  });

  it('fires no stroke while cranking or windmilling, some while catching, all when running', () => {
    expect(firingShare('cranking', 0)).toBe(0);
    expect(firingShare('windmilling', 0)).toBe(0);
    expect(firingShare('catching', 0)).toBeGreaterThan(0.3);
    expect(firingShare('catching', 0)).toBeLessThan(firingShare('catching', 1));
    expect(firingShare('running', 9)).toBe(1);
  });

  it('lets a cranking engine be heard and fades in from a standstill', () => {
    expect(engineLevel(10, true)).toBe(0);
    expect(engineLevel(280, true)).toBeGreaterThan(0.1);
    expect(engineLevel(60, true)).toBeLessThan(engineLevel(280, true));
  });
});

describe('ground sounds', () => {
  it('chirps on asphalt, louder when firmer and faster, never on grass', () => {
    const soft = touchdownLevel(0.5, 28, 'asphalt');
    const firm = touchdownLevel(2.5, 28, 'asphalt');
    expect(soft.chirp).toBeGreaterThan(0);
    expect(firm.chirp).toBeGreaterThan(soft.chirp);
    expect(firm.thump).toBeGreaterThan(soft.thump);
    expect(touchdownLevel(1, 10, 'asphalt').chirp).toBeLessThan(soft.chirp);
    expect(touchdownLevel(2.5, 28, 'grass').chirp).toBe(0);
    expect(touchdownLevel(9, 60, 'concrete').chirp).toBeLessThanOrEqual(1);
  });

  it('rumbles deeper and swishes on grass, crunches on gravel', () => {
    expect(surfaceSound('grass').rumbleHz).toBeLessThan(surfaceSound('asphalt').rumbleHz);
    expect(surfaceSound('grass').crunch).toBeGreaterThan(0);
    expect(surfaceSound('gravel').crunchHz).toBeGreaterThan(surfaceSound('grass').crunchHz);
    expect(surfaceSound(undefined)).toEqual(surfaceSound('asphalt'));
  });

  it('squeals the brakes faintly, only held firmly while rolling on a hard surface', () => {
    expect(brakeSquealLevel(1, 8, 'asphalt', true)).toBeGreaterThan(0);
    expect(brakeSquealLevel(1, 8, 'asphalt', true)).toBeLessThan(0.05);
    expect(brakeSquealLevel(0.2, 8, 'asphalt', true)).toBe(0);
    expect(brakeSquealLevel(1, 0, 'asphalt', true)).toBe(0);
    expect(brakeSquealLevel(1, 8, 'grass', true)).toBe(0);
  });
});

describe('cockpit sound levels', () => {
  it('rains harder with precipitation and speed, nothing when dry', () => {
    expect(rainLevel(0, 50, true)).toBe(0);
    expect(rainLevel(1, 50, true)).toBeGreaterThan(rainLevel(0.2, 50, true));
    expect(rainLevel(1, 50, true)).toBeGreaterThan(rainLevel(1, 0, true));
    expect(rainLevel(1, 50, true)).toBeLessThan(engineLevel(2400, true));
  });

  it('spins a gyro up in seconds and lets it coast down for much longer', () => {
    let s = 0;
    for (let i = 0; i < 100; i++) s = gyroSpin(s, true, 0.1);
    expect(s).toBeGreaterThan(0.8);
    let d = 1;
    for (let i = 0; i < 100; i++) d = gyroSpin(d, false, 0.1);
    expect(d).toBeGreaterThan(0.75);
    expect(gyroSpin(0.5, false, 0)).toBe(0.5);
  });
});
