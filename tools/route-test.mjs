// Flies the Geneva -> St. Moritz test route in headless Edge/Chrome and logs streaming stats.
// Usage: npm run test:route -- [kmh=500] [minutes=2] [url=http://localhost:5180/flightsimulator/]
// Needs the dev server running (npm run dev -- --port 5180), because stats come from window.__world.
import { chromium } from 'playwright-core';

const [kmh = '500', minutes = '2', base = 'http://localhost:5180/flightsimulator/'] =
  process.argv.slice(2);
const executablePath =
  process.env.BROWSER ?? ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome'].find(Boolean);

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: [
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--use-angle=default',
    '--enable-unsafe-swiftshader',
  ],
});
const [vw, vh] = (process.env.VIEWPORT ?? '1920x1080').split('x').map(Number);
const page = await browser.newPage({ viewport: { width: vw, height: vh } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[page error]', m.text());
});
const extra = process.env.PARAMS ? `&${process.env.PARAMS}` : '';
await page.goto(`${base}?route=${kmh}${extra}`);
await page.click('[data-action="preview"]');
await page.waitForFunction(() => window.__world?.terrain, null, { timeout: 30_000 });

const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});
console.log(`GPU: ${gpu}\nRoute at ${kmh} km/h, max ${minutes} min\n`);
console.log(
  '  time  leg      km   fps  frame  worst scale   cpuU  cpuR  drawn ready load queue  detail  min  pending',
);

const t0 = Date.now();
let s;
for (;;) {
  await page.waitForTimeout(10_000);
  s = await page.evaluate(() => window.__world.stats());
  const r = s.route;
  const sec = Math.round((Date.now() - t0) / 1000);
  console.log(
    `${String(sec).padStart(5)}s  ${r.leg}/${r.legs} ${r.distanceKm.toFixed(1).padStart(7)} ${s.fps.toFixed(0).padStart(5)} ${s.frameMs.toFixed(1).padStart(6)} ${s.worstFrameMs.toFixed(0).padStart(6)} ${(s.renderScale * 100).toFixed(0).padStart(4)}% ${s.tickMs.toFixed(1).padStart(6)} ${s.renderMs.toFixed(1).padStart(5)} ${String(s.tilesRendered).padStart(6)} ${String(s.tilesReady).padStart(5)} ${String(s.tilesLoading).padStart(4)} ${String(s.queued).padStart(5)} ${(s.coverage * 100).toFixed(0).padStart(6)}% ${(r.minCoverage * 100).toFixed(0).padStart(4)}% ${((r.pendingFrames / Math.max(1, r.frames)) * 100).toFixed(0).padStart(6)}%`,
  );
  if (r.done || sec > Number(minutes) * 60) break;
}
console.log(
  '\nSummary:',
  JSON.stringify({ gpu, kmh: Number(kmh), ...s.route, failedTiles: s.tilesFailed }, null, 1),
);
await browser.close();
