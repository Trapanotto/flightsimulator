// Screenshots of the tree demo (demo/trees.html) in a real browser with a GPU, for looking at
// the trees while developing them. Needs a running dev server:
//   npx vite --port 5211 --strictPort
//   node tools/world/trees-shots.mjs [--out=.scratch/trees] [--only=a,b] [--port=5211] [--bench=1]
// Writes <name>.png and <name>.json (stats) per scene.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const outDir = path.resolve(arg('out', '.scratch/trees'));
const only = arg('only', '');
const port = arg('port', '5211');
const bench = arg('bench', '0') === '1';
const extra = arg('query', '');
const timeout = Number(arg('timeout', '120000'));
mkdirSync(outDir, { recursive: true });

const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 390, height: 844 };
const SCENES = [
  { name: 'belpberg', query: 'view=belpberg', ...DESKTOP },
  { name: 'edge', query: 'view=edge', ...DESKTOP },
  { name: 'kandersteg', query: 'view=kandersteg', ...DESKTOP },
  { name: 'treeline', query: 'view=treeline', ...DESKTOP },
  { name: 'high', query: 'view=high', ...DESKTOP },
  { name: 'top', query: 'view=top', ...DESKTOP },
  { name: 'top-notrees', query: 'view=top&trees=0', ...DESKTOP },
  { name: 'airport', query: 'view=airport', ...DESKTOP },
  { name: 'edge-spring', query: 'view=edge&season=spring', ...DESKTOP },
  { name: 'edge-autumn', query: 'view=edge&season=autumn', ...DESKTOP },
  { name: 'edge-winter', query: 'view=edge&season=winter', ...DESKTOP },
  { name: 'belpberg-autumn', query: 'view=belpberg&season=autumn', ...DESKTOP },
  { name: 'kandersteg-winter', query: 'view=kandersteg&season=winter', ...DESKTOP },
  { name: 'kandersteg-autumn', query: 'view=kandersteg&season=autumn', ...DESKTOP },
  { name: 'belpberg-night', query: 'view=belpberg&night=1', ...DESKTOP },
  { name: 'belpberg-webgl', query: 'view=belpberg&webgl=1', ...DESKTOP },
  { name: 'edge-webgl', query: 'view=edge&webgl=1', ...DESKTOP },
  { name: 'belpberg-mobile', query: 'view=belpberg&device=mobile', ...PHONE },
  { name: 'edge-mobile', query: 'view=edge&device=mobile', ...PHONE },
  { name: 'fly', query: 'view=fly', flySeconds: 30, ...DESKTOP },
  // Moving the render origin must not move a single tree: compared pixel by pixel.
  { name: 'rebase', query: 'view=edge&still=1', rebase: true, ...DESKTOP },
  { name: 'rebase-notrees', query: 'view=edge&still=1&trees=0', rebase: true, ...DESKTOP },
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
      `http://localhost:${port}/flightsimulator/demo/trees.html?clean=1&${scene.query}${extra ? '&' + extra : ''}`,
    );
    await page.waitForFunction(() => window.__demo?.ready, null, { timeout: 60_000 });
    if (scene.flySeconds) await page.waitForTimeout(scene.flySeconds * 1000);
    await page
      .waitForFunction(
        () => {
          const d = window.__demo;
          if (d.loading) d.doneSince = undefined;
          else d.doneSince ??= performance.now();
          return d.doneSince !== undefined && performance.now() - d.doneSince > 1500;
        },
        null,
        { timeout, polling: 100 },
      )
      .catch(() => errors.push('timeout: still loading'));
    const loadSeconds = (Date.now() - t0) / 1000;
    await page.waitForTimeout(1000);
    const file = path.join(outDir, `${scene.name}.png`);
    await page.screenshot({ path: file });
    let rebaseDiff;
    if (scene.rebase) {
      // 3 km east and 2 km north: the picture must stay the same.
      await page.evaluate(() => window.__demo.rebase(3000, 2000));
      await page.waitForTimeout(1000);
      const after = path.join(outDir, `${scene.name}-after.png`);
      await page.screenshot({ path: after });
      const a = PNG.sync.read(readFileSync(file));
      const b = PNG.sync.read(readFileSync(after));
      rebaseDiff =
        pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 }) /
        (a.width * a.height);
    }
    const stats = await page.evaluate(() => {
      const d = window.__demo;
      return { ...d, bench: undefined, setVisible: undefined, rebase: undefined };
    });
    let benchMs;
    if (bench) {
      const withTrees = await page.evaluate(() => window.__demo.bench(60, true));
      const without = await page.evaluate(() => window.__demo.bench(60, false));
      const withTrees2 = await page.evaluate(() => window.__demo.bench(60, true));
      benchMs = { withTrees: Math.min(withTrees, withTrees2), without };
    }
    writeFileSync(
      path.join(outDir, `${scene.name}.json`),
      JSON.stringify({ loadSeconds, benchMs, rebaseDiff, stats, errors }, null, 2),
    );
    const t = stats.trees;
    console.log(
      `${scene.name}: ${stats.backend} load ${loadSeconds.toFixed(1)} s, trees ${t.instances} (${t.instancesDrawn} drawn), ` +
        `chunks ${t.chunksReady}/${t.chunks}, tree draws ${t.draws}, draws ${stats.drawCalls}, tris ${(stats.triangles / 1e6).toFixed(2)} M, ` +
        `tree gpu ~${(t.gpuBytes / 2 ** 20).toFixed(1)} MB, cpu ${stats.cpuMs.toFixed(1)} ms (max ${stats.cpuMaxMs.toFixed(1)}), frame ${stats.frameMs.toFixed(1)} ms` +
        (benchMs
          ? `, bench ${benchMs.withTrees.toFixed(2)} / ${benchMs.without.toFixed(2)} ms with / without trees`
          : '') +
        (errors.length ? `\n  ${errors.slice(0, 6).join('\n  ')}` : ''),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
