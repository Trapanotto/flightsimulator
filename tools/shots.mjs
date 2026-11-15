// Screenshot comparison of fixed scenes: `npm run shots` compares against the stored images in
// tests/shots/baseline, `npm run shots:update` stores new ones (after an intended change).
// Differences are written to tests/shots/out. Runs a real browser with a GPU, so it is a local
// tool, not part of CI (a CI machine renders in software and would never match).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { createServer } from 'vite';

/** Every scene is drawn with a fixed time and camera (`?shot=1`). */
const SCENES = [
  { name: 'home-desktop', query: 'shot=1', width: 1280, height: 720 },
  { name: 'home-mobile', query: 'shot=1&device=mobile', width: 390, height: 844 },
  // The fallback for browsers without WebGPU has to keep working.
  { name: 'home-webgl', query: 'shot=1&webgl=1', width: 1280, height: 720 },
  // The home screen is interface only; these draw the world: a Cessna lined up at Bern,
  // frozen in the photo mode with its panel hidden.
  { name: 'flight-desktop', query: 'shot=1', width: 1280, height: 720, flight: true },
  { name: 'flight-mobile', query: 'shot=1&device=mobile', width: 844, height: 390, flight: true },
  { name: 'flight-webgl', query: 'shot=1&webgl=1', width: 1280, height: 720, flight: true },
];
const FLIGHT = {
  aircraft: 'c172',
  start: { kind: 'runway', airport: 'LSZB', runway: '14' },
  time: 11,
  weather: 'clear',
  season: 'summer',
  airport: 'LSZB',
  atc: false,
};
/** A scene fails when more than this share of its pixels differ. */
const MAX_DIFF = 0.01;

const update = process.argv.includes('--update');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const baselineDir = path.resolve('tests/shots/baseline');
const outDir = path.resolve('tests/shots/out');
mkdirSync(baselineDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:5199${server.config.base}`;

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
let failed = 0;
try {
  for (const scene of SCENES) {
    if (only && scene.name !== only) continue;
    const page = await browser.newPage({
      viewport: { width: scene.width, height: scene.height },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}?${scene.query}`);
    await page.waitForFunction(() => window.__app?.ready, null, { timeout: 120_000 });
    await page.evaluate(() => document.fonts.ready);
    if (scene.flight) {
      await page.evaluate((plan) => window.__app.startFlight(plan), FLIGHT);
      await page.waitForFunction(() => window.__app.game.screen.value === 'flight', null, {
        timeout: 120_000,
      });
      // The chase camera eases into its place behind the aircraft first.
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.__app.actions.openPhoto());
      await page.waitForTimeout(400);
      await page.keyboard.press('KeyH');
    }
    // Let the last terrain tiles fade in and the sky settle.
    await page.waitForTimeout(2500);
    const backend = await page.evaluate(() => window.__app.backend);
    const shot = PNG.sync.read(await page.screenshot());
    await page.close();
    if (errors.length) {
      console.log(`FAIL ${scene.name}: page error: ${errors[0]}`);
      failed++;
      continue;
    }

    const file = path.join(baselineDir, `${scene.name}.png`);
    if (update || !existsSync(file)) {
      writeFileSync(file, PNG.sync.write(shot));
      console.log(`${update ? 'updated' : 'created'} ${scene.name} (${backend})`);
      continue;
    }
    const want = PNG.sync.read(readFileSync(file));
    if (want.width !== shot.width || want.height !== shot.height) {
      console.log(
        `FAIL ${scene.name}: size ${shot.width}x${shot.height}, stored ${want.width}x${want.height}`,
      );
      failed++;
      continue;
    }
    const diff = new PNG({ width: shot.width, height: shot.height });
    const pixels = pixelmatch(want.data, shot.data, diff.data, shot.width, shot.height, {
      threshold: 0.1,
    });
    const share = pixels / (shot.width * shot.height);
    if (share > MAX_DIFF) {
      writeFileSync(path.join(outDir, `${scene.name}.png`), PNG.sync.write(shot));
      writeFileSync(path.join(outDir, `${scene.name}.diff.png`), PNG.sync.write(diff));
      console.log(
        `FAIL ${scene.name}: ${(share * 100).toFixed(2)} % of pixels differ (${backend}), see tests/shots/out`,
      );
      failed++;
    } else {
      console.log(`ok   ${scene.name}: ${(share * 100).toFixed(2)} % differ (${backend})`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
