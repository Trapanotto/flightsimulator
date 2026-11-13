import { existsSync, readdirSync, statSync } from 'node:fs';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { solarPosition } from '../src/sky/solar';
import { ALL_MESSAGES } from '../src/ui/i18n';
import { PACKAGES } from '../vite.config';

describe('packages', () => {
  it('each has a public index and nothing else lives in src', () => {
    for (const p of PACKAGES) expect(existsSync(`src/${p}/index.ts`), p).toBe(true);
    const dirs = readdirSync('src').filter((f) => statSync(`src/${f}`).isDirectory());
    expect(dirs.sort()).toEqual([...PACKAGES].sort());
  });

  // The boundaries of docs/ARCHITEKTUR.md are lint rules; this proves the rules bite.
  const lint = async (file: string, code: string) => {
    const [result] = await new ESLint().lintText(code, { filePath: file });
    return result!.messages.filter((m) => m.ruleId === 'no-restricted-imports').length;
  };

  it('the simulation may not import the renderer or other packages', async () => {
    expect(await lint('src/sim/x.ts', "import 'three';")).toBe(1);
    expect(await lint('src/sim/x.ts', "import '@world';")).toBe(1);
    expect(await lint('src/sim/x.ts', "import './types';")).toBe(0);
  });

  it('packages may only use their declared dependencies, through the index', async () => {
    expect(await lint('src/world/x.ts', "import '@geo';")).toBe(0);
    expect(await lint('src/world/x.ts', "import '@sim';")).toBe(1);
    expect(await lint('src/aircraft/x.ts', "import '@sim';")).toBe(0);
    expect(await lint('src/aircraft/x.ts', "import '@world';")).toBe(1);
    expect(await lint('src/sky/x.ts', "import '@geo';")).toBe(1);
    expect(await lint('src/app/x.ts', "import '@ui';")).toBe(0);
    expect(await lint('src/app/x.ts', "import '../ui/state';")).toBe(1);
    expect(await lint('src/app/x.ts', "import '@ui/state';")).toBe(1);
  }, 30_000);
});

describe('i18n', () => {
  it('has every text in every language', () => {
    const keys = Object.keys(ALL_MESSAGES.de).sort();
    expect(Object.keys(ALL_MESSAGES.en).sort()).toEqual(keys);
    for (const lang of Object.values(ALL_MESSAGES))
      for (const text of Object.values(lang)) expect(text.trim().length).toBeGreaterThan(0);
  });
});

describe('solarPosition', () => {
  it('puts the midsummer noon sun high in the south over Bern', () => {
    // Solar noon in Bern on 21 June is about 11:32 UTC.
    const s = solarPosition(new Date('2026-06-21T11:32:00Z'), 46.95, 7.44);
    expect(s.elevation).toBeGreaterThan(66);
    expect(s.elevation).toBeLessThan(67);
    expect(Math.abs(s.azimuth - 180)).toBeLessThan(2);
  });

  it('has the sun below the horizon at midnight and low in winter', () => {
    expect(solarPosition(new Date('2026-06-21T23:00:00Z'), 46.95, 7.44).elevation).toBeLessThan(
      -15,
    );
    const winterNoon = solarPosition(new Date('2026-12-21T11:30:00Z'), 46.95, 7.44);
    expect(winterNoon.elevation).toBeGreaterThan(19);
    expect(winterNoon.elevation).toBeLessThan(20.5);
  });
});
