// Screenshots of the aircraft demo for review (not a regression test): every view/state pair
// below, into .scratch/shots/. Needs the dev server: `npx vite --port 5204 --strictPort`.
// Usage: node tools/aircraft/shots.mjs [filter] [--webgl] [--port=5204]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--'));
const webgl = args.includes('--webgl');
const port = args.find((a) => a.startsWith('--port='))?.slice(7) ?? '5204';
const SHOTS = [
  ['front-left', 'climb-turn'],
  ['side', 'parked'],
  ['front', 'cruise'],
  ['top', 'landing'],
  ['rear', 'climb-turn'],
  ['tail', 'climb-turn'],
  ['low', 'landing'],
  ['cockpit', 'climb-turn'],
  ['panel', 'climb-turn'],
  ['panel', 'cruise'],
  ['panel', 'landing'],
  ['panel', 'parked'],
  ['front-left', 'landing', 'night=1'],
  ['rear', 'cruise', 'night=1'],
  ['front-left', 'parked', 'device=mobile'],
];
const outDir = path.resolve('.scratch/shots');
mkdirSync(outDir, { recursive: true });

async function launch() {
  const flags = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'];
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true, args: flags });
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error('No Edge or Chrome found for the screenshots.');
}

const browser = await launch();
try {
  for (const [view, state, extra] of SHOTS) {
    const name = `${view}_${state}${extra ? '_' + extra.replace(/[=&]/g, '') : ''}${webgl ? '_webgl' : ''}`;
    if (filter && !name.includes(filter)) continue;
    const page = await browser.newPage({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
    });
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const query = `view=${view}&state=${state}&shot=1${extra ? '&' + extra : ''}${webgl ? '&webgl=1' : ''}`;
    await page.goto(`http://localhost:${port}/flightsimulator/demo/aircraft.html?${query}`);
    try {
      await page.waitForFunction(() => window.__demo?.ready, null, { timeout: 90_000 });
    } catch (e) {
      console.log(`FAIL ${name}: ${errors[0] ?? e}`);
      await page.close();
      continue;
    }
    await page.waitForTimeout(300);
    const backend = await page.evaluate(() => window.__demo.backend);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    console.log(
      `${name} (${backend})${errors.length ? ' errors: ' + errors.slice(0, 3).join(' | ') : ''}`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
