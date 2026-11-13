// Screenshots of the ground (seasons, night, close-ups) from the world demo in a real browser
// with a GPU, for judging the terrain look while developing it. Needs a running dev server:
//   npx vite --port 5214 --strictPort
//   node tools/world/ground-shots.mjs [--out=.scratch/ground/after] [--only=a,b] [--port=5214]
//                                     [--query=extra=1] [--bench=60]
// Writes <name>.png and <name>.json (stats: load time, tiles, memory, worker build times,
// frame cost) per scene, and a summary line per scene on stdout.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const outDir = path.resolve(arg('out', '.scratch/ground/shots'));
const only = arg('only', '');
const port = arg('port', '5214');
const timeout = Number(arg('timeout', '180000'));
const benchFrames = Number(arg('bench', '60'));
const extra = arg('query', '');
mkdirSync(outDir, { recursive: true });

const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 390, height: 844 };
const NIGHT = 'hour=23.75';
const SCENES = [
  // Daytime reference views (summer): must not change against the phase 1 look.
  { name: 'belp-day', query: 'view=belp', ...DESKTOP },
  { name: 'thun-day', query: 'view=thun', ...DESKTOP },
  { name: 'low-day', query: 'view=low', ...DESKTOP },
  // Night.
  { name: 'bern1500-night', query: `view=bern1500&${NIGHT}`, ...DESKTOP },
  { name: 'bern300-night', query: `view=bern300&${NIGHT}`, ...DESKTOP },
  { name: 'mittelland-night', query: `view=mittelland&${NIGHT}`, ...DESKTOP },
  { name: 'zurich-night', query: `view=zurich&${NIGHT}`, ...DESKTOP },
  { name: 'grindelwald-night', query: `view=grindelwald&${NIGHT}`, ...DESKTOP },
  { name: 'belp-dusk', query: 'view=belp&hour=21.6', ...DESKTOP },
  // Seasons.
  { name: 'alps-spring', query: 'view=alps4000&season=spring', ...DESKTOP },
  { name: 'alps-summer', query: 'view=alps4000&season=summer', ...DESKTOP },
  { name: 'alps-autumn', query: 'view=alps4000&season=autumn', ...DESKTOP },
  { name: 'alps-winter', query: 'view=alps4000&season=winter', ...DESKTOP },
  { name: 'belp600-spring', query: 'view=belp600&season=spring', ...DESKTOP },
  { name: 'belp600-summer', query: 'view=belp600&season=summer', ...DESKTOP },
  { name: 'belp600-autumn', query: 'view=belp600&season=autumn', ...DESKTOP },
  { name: 'belp600-winter', query: 'view=belp600&season=winter', ...DESKTOP },
  { name: 'grindelwald-winter', query: 'view=grindelwald&season=winter&hour=13', ...DESKTOP },
  // Close to the ground.
  { name: 'meadow30', query: 'view=meadow30', ...DESKTOP },
  { name: 'field30', query: 'view=field30', ...DESKTOP },
  { name: 'road50', query: 'view=road50', ...DESKTOP },
  { name: 'runwaygrass', query: 'view=runwaygrass', ...DESKTOP },
  { name: 'northface', query: 'view=northface&hour=18.5', ...DESKTOP },
  // Fallback and phone.
  { name: 'bern1500-night-webgl', query: `view=bern1500&${NIGHT}&webgl=1`, ...DESKTOP },
  { name: 'alps-winter-webgl', query: 'view=alps4000&season=winter&webgl=1', ...DESKTOP },
  { name: 'bern1500-night-mobile', query: `view=bern1500&${NIGHT}&device=mobile`, ...PHONE },
  { name: 'belp600-autumn-mobile', query: 'view=belp600&season=autumn&device=mobile', ...PHONE },
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
      `http://localhost:${port}/flightsimulator/demo/world.html?clean=1&${scene.query}${extra ? '&' + extra : ''}`,
    );
    await page.waitForFunction(() => window.__demo?.ready, null, { timeout: 90_000 });
    // Done = nothing missing for a second (the view may need a few rounds of refinement).
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
    // The sky's environment and the clouds' history settle over a few frames.
    await page.waitForTimeout(1500);
    const stats = await page.evaluate(() => {
      const d = window.__demo;
      return { ...d, rebase: undefined, ground: undefined, bench: undefined };
    });
    const benchMs =
      benchFrames > 0 ? await page.evaluate((n) => window.__demo.bench(n), benchFrames) : 0;
    await page.screenshot({ path: path.join(outDir, `${scene.name}.png`) });
    writeFileSync(
      path.join(outDir, `${scene.name}.json`),
      JSON.stringify({ loadSeconds, benchMs, stats, errors }, null, 2),
    );
    const w = stats.world;
    const perTile = w.uploaded
      ? (w.gpuBytes / Math.max(1, w.tilesLoaded) / 2 ** 20).toFixed(2)
      : '-';
    const build = w.buildMs !== undefined && w.built ? (w.buildMs / w.built).toFixed(1) : '-';
    const bake = w.bakeMs !== undefined && w.built ? (w.bakeMs / w.built).toFixed(1) : '-';
    const per = (v) => (v !== undefined && w.built ? (v / w.built).toFixed(1) : '-');
    const parts = `lights ${per(w.lightsMs)} roads ${per(w.roadsMs)} horizon ${per(w.horizonMs)} mips ${per(w.mipsMs)}`;
    console.log(
      `${scene.name}: ${stats.backend} load ${loadSeconds.toFixed(1)} s, tiles ${w.tilesDrawn}/${w.tilesLoaded} z${w.maxZoom}, ` +
        `gpu ~${(w.gpuBytes / 2 ** 20).toFixed(0)} MB (${perTile} MB/tile), build ${build} ms/tile (cpu ${bake}: ${parts}), ` +
        `cpu max ${stats.cpuMaxMs.toFixed(1)} ms, bench ${benchMs.toFixed(2)} ms/frame` +
        (errors.length ? `\n  ${errors.slice(0, 5).join('\n  ')}` : ''),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
