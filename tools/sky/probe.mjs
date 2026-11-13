// Runs code against the live sky demo and prints the result (debugging the GPU side: read
// back lookup tables, change uniforms, take a screenshot after a change).
//   node tools/sky/probe.mjs "<demo query>" "<async code>" [screenshot.png]
// The code sees `sky`, `renderer` and `d` (window.__demo) and may `return` a JSON value.
// `half(h)` decodes a half float from readRenderTargetPixelsAsync.
import { chromium } from 'playwright-core';

const [query = '', code = 'return 1', shot] = process.argv.slice(2);
const port = process.env.SKY_PORT ?? '5202';
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 400)));
  await page.goto(`http://localhost:${port}/flightsimulator/demo/sky.html?shot=1&${query}`);
  await page.waitForFunction(() => window.__demo?.ready || window.__demo?.error, null, {
    timeout: 90_000,
  });
  const out = await page.evaluate(async (c) => {
    const half = (h) => {
      const s = h & 0x8000 ? -1 : 1;
      const e = (h >> 10) & 0x1f;
      const f = h & 0x3ff;
      if (e === 0) return s * 2 ** -14 * (f / 1024);
      return s * 2 ** (e - 15) * (1 + f / 1024);
    };
    const d = window.__demo;
    const run = new Function('sky', 'renderer', 'd', 'half', `return (async () => { ${c} })()`);
    return await run(d.sky, d.renderer, d, half);
  }, code);
  console.log(JSON.stringify(out, null, 1));
  if (shot) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shot });
  }
} finally {
  await browser.close();
}
