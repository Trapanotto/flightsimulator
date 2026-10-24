// Takes screenshots of the running app in headless Edge/Chrome (real GPU).
// Usage: node tools/screenshot.mjs <url> <out.png> [waitMs=6000] [js-to-run-before]
// Env: VIEWPORT=1600x900, AFTER=ms to wait after the script (default 1500)
import { chromium } from 'playwright-core';

const [url, out, wait = '6000', script] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.BROWSER ?? '/usr/bin/microsoft-edge',
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist'],
});
const [vw, vh] = (process.env.VIEWPORT ?? '1600x900').split('x').map(Number);
const page = await browser.newPage({ viewport: { width: vw, height: vh } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForTimeout(Number(wait));
if (script) {
  await page.evaluate(script);
  await page.waitForTimeout(Number(process.env.AFTER ?? 1500));
}
await page.screenshot({ path: out });
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
console.log('saved', out);
await browser.close();
