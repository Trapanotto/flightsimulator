// Screenshots of the building demo (demo/buildings.html) in a real browser with a GPU, for
// looking at the buildings while developing them. Needs a running dev server:
//   npx vite --port 5212 --strictPort
//   node tools/world/buildings-shots.mjs [--out=.scratch/shots] [--only=a,b] [--port=5212]
//     [--query=extra=1] [--bench=1]
// Writes <name>.png and <name>.json (stats, and with --bench the frame cost with and without
// the building layer) per scene.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const outDir = path.resolve(arg('out', '.scratch/shots'));
const only = arg('only', '');
const port = arg('port', '5212');
const timeout = Number(arg('timeout', '150000'));
const benchmark = arg('bench', '') === '1';
const extra = arg('query', '');
mkdirSync(outDir, { recursive: true });

const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 390, height: 844 };
const SCENES = [
  { name: 'bern', query: 'view=bern', ...DESKTOP },
  { name: 'bern-night', query: 'view=bern&hour=23.5', ...DESKTOP },
  { name: 'bern-golden', query: 'view=bern&hour=20.6', ...DESKTOP },
  { name: 'belp', query: 'view=belp', ...DESKTOP },
  { name: 'zurich', query: 'view=zurich', ...DESKTOP },
  { name: 'zurich-night', query: 'view=zurich&hour=23.5', ...DESKTOP },
  { name: 'emmental', query: 'view=emmental', ...DESKTOP },
  { name: 'grindelwald', query: 'view=grindelwald', ...DESKTOP },
  { name: 'grindelwald-winter', query: 'view=grindelwald&season=winter&hour=12', ...DESKTOP },
  { name: 'street', query: 'view=street', ...DESKTOP },
  { name: 'far', query: 'view=far', ...DESKTOP },
  { name: 'far-night', query: 'view=far&hour=23.5', ...DESKTOP },
  { name: 'fly', query: 'view=fly', flySeconds: 25, ...DESKTOP },
  { name: 'bern-webgl', query: 'view=bern&webgl=1', ...DESKTOP },
  { name: 'street-webgl-night', query: 'view=street&webgl=1&hour=23.5', ...DESKTOP },
  { name: 'bern-mobile', query: 'view=bern&device=mobile', ...PHONE },
  { name: 'zurich-mobile-night', query: 'view=zurich&device=mobile&hour=23.5', ...PHONE },
];

async function launch() {
  const args = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'];
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true, args });
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error('No Edge or Chrome found for the screenshots.');
}

const browser = await launch();
try {
  for (const scene of SCENES) {
    if (only && !only.split(',').includes(scene.name)) continue;
    const page = await browser.newPage({
      viewport: { width: scene.width, height: scene.height },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'warning' || m.type() === 'error') errors.push(`${m.type()}: ${m.text()}`);
    });
    const t0 = Date.now();
    await page.goto(
      `http://localhost:${port}/flightsimulator/demo/buildings.html?clean=1&${scene.query}${extra ? '&' + extra : ''}`,
    );
    await page.waitForFunction(() => window.__demo?.ready, null, { timeout });
    if (scene.flySeconds) await page.waitForTimeout(scene.flySeconds * 1000);
    else
      await page
        .waitForFunction(() => window.__demo && !window.__demo.loading, null, { timeout })
        .catch(() => errors.push('timeout: still loading'));
    const loadSeconds = (Date.now() - t0) / 1000;
    // Let the last tiles fade in.
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, `${scene.name}.png`) });
    const stats = await page.evaluate(() => {
      const d = window.__demo;
      return { ...d, bench: undefined, setBuildings: undefined };
    });
    let bench;
    if (benchmark) {
      bench = await page.evaluate(async () => {
        const d = window.__demo;
        await d.bench(20);
        const on = await d.bench(60);
        d.setBuildings(false);
        await d.bench(20);
        const off = await d.bench(60);
        d.setBuildings(true);
        return { withBuildingsMs: on, withoutBuildingsMs: off };
      });
    }
    writeFileSync(
      path.join(outDir, `${scene.name}.json`),
      JSON.stringify({ loadSeconds, ...stats, bench, errors }, null, 2),
    );
    const b = stats.buildings;
    console.log(
      `${scene.name}: ${stats.backend} loaded ${loadSeconds.toFixed(1)} s, ${b.buildings} buildings, ` +
        `${b.cells} cells, ${b.footprintTiles} footprint tiles, ${(b.triangles / 1e6).toFixed(2)} M tris, ` +
        `${(b.downloaded / 2 ** 20).toFixed(1)} MB, draw calls ${stats.drawCalls}` +
        (bench
          ? `, frame ${bench.withBuildingsMs.toFixed(2)} / ${bench.withoutBuildingsMs.toFixed(2)} ms`
          : '') +
        (errors.length ? `\n  ${errors.slice(0, 5).join('\n  ')}` : ''),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
