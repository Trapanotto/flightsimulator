// The performance course: `npm run bench` flies fixed scenes in a real browser with the frame
// limit off and prints how long a frame takes (mean, 95th and 99th percentile, worst).
// `npm run bench -- --save` stores the result in tools/bench-baseline.json; later runs print
// the change against it. A local tool like the screenshots: the numbers belong to this machine.
//
//   --only=<name>   one scene
//   --seconds=<n>   measuring time per scene (default 20)
//   --size=<w>x<h>  another window size for every scene
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const QHD = { width: 2560, height: 1440 };
const flight = (aircraft, start, extra = {}) => ({
  aircraft,
  start,
  time: 11,
  weather: 'fair',
  season: 'summer',
  airport: start.airport ?? 'LSZB',
  atc: false,
  ...extra,
});
/** Each scene: a flight plan, the view, and the screen it is measured on. */
const SCENES = [
  {
    name: 'c172-bern-outside',
    plan: flight('c172', { kind: 'approach', airport: 'LSZB', runway: '14', distanceNm: 4 }),
    view: 'outside',
    viewport: QHD,
  },
  {
    name: 'c172-bern-cockpit',
    plan: flight('c172', { kind: 'approach', airport: 'LSZB', runway: '14', distanceNm: 4 }),
    view: 'cockpit',
    viewport: QHD,
  },
  {
    name: 'a320-zurich-stratus',
    plan: flight(
      'a320',
      { kind: 'approach', airport: 'LSZH', runway: '14', distanceNm: 8 },
      { weather: 'lowStratus', season: 'winter' },
    ),
    view: 'cockpit',
    viewport: QHD,
  },
  {
    name: 'fa18-alps-cloudy',
    plan: flight(
      'fa18',
      { kind: 'air', lon: 7.96, lat: 46.6, altitude: 3600, headingDeg: 70, speed: 180 },
      { weather: 'cloudy', airport: 'LSMM' },
    ),
    view: 'outside',
    viewport: QHD,
  },
  {
    name: 'c172-bern-dusk',
    plan: flight(
      'c172',
      { kind: 'approach', airport: 'LSZB', runway: '14', distanceNm: 4 },
      { time: 20.7 },
    ),
    view: 'outside',
    viewport: QHD,
  },
  {
    name: 'phone-c172-bern',
    plan: flight('c172', { kind: 'approach', airport: 'LSZB', runway: '14', distanceNm: 4 }),
    view: 'outside',
    viewport: { width: 844, height: 390 },
    query: 'device=mobile',
  },
];

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = arg('only');
const seconds = +(arg('seconds') ?? 20);
const save = process.argv.includes('--save');
// --size=1280x720 measures every scene at another size (is it the pixels or the processor?).
const size = arg('size')?.split('x').map(Number);
const baselineFile = path.resolve('tools/bench-baseline.json');
const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};

const server = await createServer({ server: { port: 5198, strictPort: true }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:5198${server.config.base}`;

async function launch() {
  const args = [
    '--enable-unsafe-webgpu',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    // Frames as fast as the machine can: with the display's limit on, every scene reads 16.7 ms.
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
  ];
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true, args });
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error('No Edge or Chrome found for the performance course.');
}

const browser = await launch();
const results = {};
try {
  for (const scene of SCENES) {
    if (only && scene.name !== only) continue;
    const page = await browser.newPage({
      viewport: size ? { width: size[0], height: size[1] } : scene.viewport,
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // A fixed date: the same sun and the same season every run.
    await page.goto(`${base}?t=2026-06-21T09:00:00Z${scene.query ? '&' + scene.query : ''}`);
    await page.waitForFunction(() => window.__app?.ready, null, { timeout: 120_000 });
    await page.evaluate((plan) => window.__app.startFlight(plan), scene.plan);
    await page.waitForFunction(() => window.__app.game.screen.value === 'flight', null, {
      timeout: 120_000,
    });
    if (scene.view === 'cockpit') await page.keyboard.press('KeyC');
    // Shaders, tiles and the first seconds of streaming are not what this measures.
    await page.waitForTimeout(8000);
    const frames = await page.evaluate(
      (ms) =>
        new Promise((resolve) => {
          const out = [];
          let last = performance.now();
          const end = last + ms;
          const tick = (now) => {
            out.push(now - last);
            last = now;
            if (now < end) requestAnimationFrame(tick);
            else resolve(out);
          };
          requestAnimationFrame(tick);
        }),
      seconds * 1000,
    );
    frames.shift();
    frames.sort((a, b) => a - b);
    const at = (q) => frames[Math.min(frames.length - 1, Math.floor(frames.length * q))];
    const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
    const r = {
      mean: +mean.toFixed(2),
      p95: +at(0.95).toFixed(2),
      p99: +at(0.99).toFixed(2),
      worst: +frames[frames.length - 1].toFixed(1),
      frames: frames.length,
    };
    results[scene.name] = r;
    const b = baseline[scene.name];
    const change = b
      ? `  (${r.mean > b.mean ? '+' : ''}${(((r.mean - b.mean) / b.mean) * 100).toFixed(0)} % vs. baseline ${b.mean} ms)`
      : '';
    console.log(
      `${scene.name.padEnd(22)} mean ${String(r.mean).padStart(6)} ms (${(1000 / r.mean).toFixed(0).padStart(3)} fps)  p95 ${String(r.p95).padStart(6)}  p99 ${String(r.p99).padStart(6)}  worst ${String(r.worst).padStart(6)}${change}`,
    );
    for (const e of errors) console.log('  page error:', e.slice(0, 200));
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (save) {
  writeFileSync(baselineFile, JSON.stringify({ ...baseline, ...results }, null, 2) + '\n');
  console.log('saved', baselineFile);
}
