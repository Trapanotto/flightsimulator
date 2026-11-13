// Screenshots of the sky demo (demo/sky.html) in a real browser with a GPU, launched the way
// tools/shots.mjs does. Needs the dev server: `npx vite --port 5202 --strictPort`.
//
//   node tools/sky/shots.mjs [--out=dir] [--measure] name=query[@WxH] ...
//
// Each argument is a file name and the demo's URL query, e.g.
//   noon='t=2026-06-21T11:30Z&heading=180'  phone='device=mobile@390x844'
// --measure also prints the average frame time over 120 frames after the screenshot.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const outDir = path.resolve(args.find((a) => a.startsWith('--out='))?.slice(6) ?? '.scratch');
const measure = args.includes('--measure');
const port = process.env.SKY_PORT ?? '5202';
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
  throw new Error('No Edge or Chrome found.');
}

const browser = await launch();
try {
  for (const arg of args.filter((a) => !a.startsWith('--'))) {
    const eq = arg.indexOf('=');
    const name = arg.slice(0, eq);
    let query = arg.slice(eq + 1);
    let width = 1280;
    let height = 720;
    const at = query.lastIndexOf('@');
    if (at >= 0) {
      [width, height] = query
        .slice(at + 1)
        .split('x')
        .map(Number);
      query = query.slice(0, at);
    }
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
    });
    const timing = measure ? 'timing=1&' : '';
    await page.goto(
      `http://localhost:${port}/flightsimulator/demo/sky.html?shot=1&${timing}${query}`,
    );
    try {
      await page.waitForFunction(() => window.__demo?.ready || window.__demo?.error, null, {
        timeout: 90_000,
      });
    } catch {
      errors.push('timeout');
    }
    await page.waitForTimeout(Number(process.env.SKY_WAIT ?? 1500));
    const state = await page.evaluate(() => ({
      backend: window.__demo?.backend,
      error: window.__demo?.error,
    }));
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    let ms = '';
    if (measure) {
      await page.evaluate(() => window.__demo.measure(60));
      const t = await page.evaluate(() => window.__demo.measure(180));
      ms = ` ${t.toFixed(2)} ms/frame`;
    }
    console.log(`${name} (${state.backend})${ms} -> ${file}`);
    if (state.error) console.log(`  error: ${state.error}`);
    for (const e of errors.slice(0, 8)) console.log(`  ${e.slice(0, 400)}`);
    await page.close();
  }
} finally {
  await browser.close();
}
