// Screenshots of the airports demo (demo/airports.html) in a real browser with a GPU, for
// looking at the airports while developing them. Needs a running dev server:
//   npx vite --port 5213 --strictPort
//   node tools/airports/shots.mjs [--out=.scratch/shots] [--only=a,b] [--port=5213] [--bench]
// A scene is "<name>=<query>"; without --only every scene in SCENES is taken. Writes
// <name>.png and <name>.json (stats) per scene.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const outDir = path.resolve(arg('out', '.scratch/shots'));
const only = arg('only', '');
const port = arg('port', '5213');
const timeout = Number(arg('timeout', '150000'));
const bench = process.argv.includes('--bench');
mkdirSync(outDir, { recursive: true });

const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 390, height: 844 };
const s = (name, query, size = DESKTOP) => ({ name, query, ...size });
const SCENES = [
  s('lszb14-eye', 'airport=LSZB&rwy=14&view=eye'),
  s('lszb32-eye', 'airport=LSZB&rwy=32&view=eye'),
  s('lszb14-final100', 'airport=LSZB&rwy=14&view=final100'),
  s('lszb14-final1500', 'airport=LSZB&rwy=14&view=final1500'),
  s('lszb14-app5k', 'airport=LSZB&rwy=14&view=app5k'),
  s('lszb14-low', 'airport=LSZB&rwy=14&view=low'),
  s('lszb14-high', 'airport=LSZB&rwy=14&view=high'),
  s('lszb14-overhead', 'airport=LSZB&rwy=14&view=overhead'),
  s('lszb14-far', 'airport=LSZB&rwy=14&view=far'),
  s('lszb14-taxi', 'airport=LSZB&rwy=14&view=taxi'),
  s('lszb14-side', 'airport=LSZB&rwy=14&view=side'),
  s('lszb14-final1500-night', 'airport=LSZB&rwy=14&view=final1500&time=23'),
  s('lszb14-app5k-night', 'airport=LSZB&rwy=14&view=app5k&time=23'),
  s('lszb14-low-night', 'airport=LSZB&rwy=14&view=low&time=23'),
  s('lszb14-high-night', 'airport=LSZB&rwy=14&view=high&time=23'),
  s('lszb14-far-night', 'airport=LSZB&rwy=14&view=far&time=23'),
  s('lszb14-eye-night', 'airport=LSZB&rwy=14&view=eye&time=23'),
  s('lszb14-final1500-dusk', 'airport=LSZB&rwy=14&view=final1500&time=21.7'),
  s('lszh14-eye', 'airport=LSZH&rwy=14&view=eye'),
  s('lszh32-eye', 'airport=LSZH&rwy=32&view=eye'),
  s('lszh16-eye', 'airport=LSZH&rwy=16&view=eye'),
  s('lszh34-final1500', 'airport=LSZH&rwy=34&view=final1500'),
  s('lszh14-overhead', 'airport=LSZH&rwy=14&view=overhead'),
  s('lszh16-far', 'airport=LSZH&rwy=16&view=far'),
  s('lszh14-taxi', 'airport=LSZH&rwy=14&view=taxi'),
  s('lszh16-app5k-night', 'airport=LSZH&rwy=16&view=app5k&time=23'),
  s('lszh14-overhead-night', 'airport=LSZH&rwy=14&view=overhead&time=23'),
  s('lsgs25-eye', 'airport=LSGS&rwy=25&view=eye'),
  s('lsgs25-final1500', 'airport=LSGS&rwy=25&view=final1500'),
  s('lsgs25-overhead', 'airport=LSGS&rwy=25&view=overhead'),
  s('lszs21-eye', 'airport=LSZS&rwy=21&view=eye'),
  s('lszs21-final1500', 'airport=LSZS&rwy=21&view=final1500'),
  s('lszs03-far', 'airport=LSZS&rwy=03&view=far'),
  s('lszw14-eye', 'airport=LSZW&rwy=14&view=eye'),
  s('lszw14-overhead', 'airport=LSZW&rwy=14&view=overhead'),
  s('lszw14-final1500', 'airport=LSZW&rwy=14&view=final1500'),
  s('lszb14-eye-webgl', 'airport=LSZB&rwy=14&view=eye&webgl=1'),
  s('lszb14-final1500-night-webgl', 'airport=LSZB&rwy=14&view=final1500&time=23&webgl=1'),
  s('lszb14-final1500-mobile', 'airport=LSZB&rwy=14&view=final1500&device=mobile', PHONE),
  s('lszb14-eye-mobile-night', 'airport=LSZB&rwy=14&view=eye&device=mobile&time=23', PHONE),
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

const custom = only
  .split(',')
  .filter((x) => x.includes('='))
  .map((x) => {
    const [name, q] = x.split(/=(.*)/s);
    return s(name, q.replaceAll(';', '&'), q.includes('device=mobile') ? PHONE : DESKTOP);
  });
const wanted = custom.length
  ? custom
  : SCENES.filter((sc) => !only || only.split(',').includes(sc.name));

const browser = await launch();
try {
  for (const scene of wanted) {
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
      `http://localhost:${port}/flightsimulator/demo/airports.html?clean=1&${scene.query}`,
    );
    await page.waitForFunction(() => window.__demo?.ready, null, { timeout: 60_000 });
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
    await page.waitForTimeout(1200);
    const file = path.join(outDir, `${scene.name}.png`);
    await page.screenshot({ path: file });
    const stats = await page.evaluate(() => ({
      ...window.__demo,
      papi: window.__demo.papi().filter((p) => p.distance < 8000),
      bench: undefined,
      site: undefined,
    }));
    let benchMs;
    if (bench)
      benchMs = await page.evaluate(async () => ({
        with: await window.__demo.bench(60, true),
        without: await window.__demo.bench(60, false),
        with2: await window.__demo.bench(60, true),
        without2: await window.__demo.bench(60, false),
      }));
    writeFileSync(
      path.join(outDir, `${scene.name}.json`),
      JSON.stringify({ loadSeconds, benchMs, stats, errors }, null, 2),
    );
    const l = stats.layer;
    console.log(
      `${scene.name}: ${stats.backend} ${loadSeconds.toFixed(1)} s, airports ${l.shown}/${l.airports}, ` +
        `lights ${l.lights}, draws ${stats.drawCalls}` +
        (benchMs ? `, bench ${benchMs.with.toFixed(2)}/${benchMs.without.toFixed(2)} ms` : '') +
        (errors.length ? `  ERRORS: ${errors.slice(0, 3).join(' | ')}` : ''),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
