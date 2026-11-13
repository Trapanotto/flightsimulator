// Screenshots of the world demo (demo/world.html) in a real browser with a GPU, for looking at
// the terrain while developing it. Needs a running dev server:
//   npx vite --port 5201 --strictPort
//   node tools/world/shots.mjs [--out=.scratch/shots] [--only=name] [--port=5201]
// Writes <name>.png and <name>.json (stats) per scene.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const outDir = path.resolve(arg('out', '.scratch/shots'));
const only = arg('only', '');
const port = arg('port', '5201');
const timeout = Number(arg('timeout', '150000'));
mkdirSync(outDir, { recursive: true });

const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 390, height: 844 };
const SCENES = [
  { name: 'belp', query: 'view=belp', ...DESKTOP },
  { name: 'thun', query: 'view=thun', ...DESKTOP },
  { name: 'lake', query: 'view=lake', ...DESKTOP },
  { name: 'low', query: 'view=low', ...DESKTOP },
  { name: 'shore', query: 'view=shore', ...DESKTOP },
  { name: 'glint', query: 'view=glint&sun=130,14', ...DESKTOP },
  { name: 'alps', query: 'view=alps', ...DESKTOP },
  { name: 'thun-marks', query: 'view=thun&marks=1', ...DESKTOP },
  { name: 'lake-marks', query: 'view=lake&marks=1', ...DESKTOP },
  { name: 'runway', query: 'view=runway', ...DESKTOP },
  { name: 'top', query: 'view=top', ...DESKTOP },
  { name: 'shadow', query: 'view=runway&shadow=1', ...DESKTOP },
  { name: 'shadow-webgl', query: 'view=runway&shadow=1&webgl=1', ...DESKTOP },
  // A small tile budget forces evictions while flying: nothing may break or leak.
  { name: 'evict', query: 'view=belp&fly=1&tiles=90', flySeconds: 25, ...DESKTOP },
  { name: 'thun-webgl', query: 'view=thun&webgl=1', ...DESKTOP },
  { name: 'low-webgl', query: 'view=low&webgl=1', ...DESKTOP },
  { name: 'thun-mobile', query: 'view=thun&device=mobile', ...PHONE },
  { name: 'low-mobile', query: 'view=low&device=mobile', ...PHONE },
  // Moving the render origin must not move the picture: compared pixel by pixel below.
  { name: 'rebase', query: 'view=lake', rebase: true, ...DESKTOP },
  // Flying at 120 m/s for 20 s: streaming, cancellation and the floating origin under way.
  { name: 'fly', query: 'view=belp&fly=1', flySeconds: 20, ...DESKTOP },
  { name: 'thun-1440p', query: 'view=thun', width: 2560, height: 1440 },
];
const extra = arg('query', '');

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
      if (m.type() === 'warning') errors.push(`warning: ${m.text()}`);
    });
    // Failed requests other than tiles outside the coverage (403/404 are expected there).
    page.on('response', (r) => {
      const expected = /3d\.geo\.admin|vectortiles|wmts|favicon/.test(r.url());
      if (r.status() >= 400 && !expected) errors.push(`HTTP ${r.status()} ${r.url()}`);
    });
    const t0 = Date.now();
    await page.goto(
      `http://localhost:${port}/flightsimulator/demo/world.html?clean=1&${scene.query}${extra ? '&' + extra : ''}`,
    );
    await page.waitForFunction(() => window.__demo?.ready, null, { timeout: 60_000 });
    // Done = nothing missing for a second (the view may need a few rounds of refinement).
    if (scene.flySeconds) await page.waitForTimeout(scene.flySeconds * 1000);
    await page
      .waitForFunction(
        () => {
          const d = window.__demo;
          if (d.loading) d.doneSince = undefined;
          else d.doneSince ??= performance.now();
          return d.doneSince !== undefined && performance.now() - d.doneSince > 1000;
        },
        null,
        { timeout, polling: 100 },
      )
      .catch(() => errors.push('timeout: still loading'));
    const loadSeconds = (Date.now() - t0) / 1000;
    await page.waitForTimeout(1500);
    const stats = await page.evaluate(() => {
      const d = window.__demo;
      return { ...d, rebase: undefined, ground: undefined, bench: undefined };
    });
    const benchMs = await page.evaluate(() => window.__demo.bench(60));
    const file = path.join(outDir, `${scene.name}.png`);
    await page.screenshot({ path: file });
    if (scene.rebase) {
      // 4 km east and 3 km north: the picture must not change.
      await page.evaluate(() => window.__demo.rebase(4000, 3000));
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(outDir, `${scene.name}-after.png`) });
    }
    const ground = await page.evaluate(() => ({
      belpRunway: window.__demo.ground(7.49975, 46.9122),
      thunLake: window.__demo.ground(7.7, 46.7),
    }));
    writeFileSync(
      path.join(outDir, `${scene.name}.json`),
      JSON.stringify({ loadSeconds, benchMs, stats, ground, errors }, null, 2),
    );
    const w = stats.world;
    console.log(
      `${scene.name}: ${stats.backend} load ${loadSeconds.toFixed(1)} s, tiles ${w.tilesDrawn}/${w.tilesLoaded} z${w.maxZoom}, ` +
        `draws ${stats.drawCalls}, tris ${(stats.triangles / 1e6).toFixed(2)} M, ` +
        `gpu ~${(w.gpuBytes / 2 ** 20).toFixed(0)} MB, cpu max ${stats.cpuMaxMs.toFixed(1)} ms, cancelled ${w.cancelled}, frame ${stats.frameMs.toFixed(1)} ms, cpu ${stats.cpuMs.toFixed(1)} ms, bench ${benchMs.toFixed(2)} ms/frame` +
        (stats.gpuMs != null ? `, gpu ${stats.gpuMs.toFixed(1)} ms` : '') +
        (errors.length ? `\n  ${errors.slice(0, 5).join('\n  ')}` : ''),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
