// Screenshots of the interface demo (demo/ui.html) at every target size, for design review.
// Needs a running dev server: `npx vite --port 5205 --strictPort`, then
// `node tools/ui/shots.mjs [--filter=menu] [--out=.scratch/shots]`.
// Not a comparison test: the pictures are for looking at.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const base = arg('base', 'http://localhost:5205/flightsimulator/demo/ui.html');
const outDir = path.resolve(arg('out', '.scratch/shots'));
const filter = arg('filter', '');
mkdirSync(outDir, { recursive: true });

const SIZES = {
  fhd: { width: 1920, height: 1080 },
  hd: { width: 1280, height: 720 },
  tablet: { width: 1024, height: 768, mobile: true },
  land: { width: 844, height: 390, mobile: true },
  port: { width: 390, height: 844, mobile: true },
};

const SCREENS = [
  ['loading', 'screen=loading&progress=0.64'],
  ['menu', 'screen=menu'],
  ['setup', 'screen=setup'],
  ['settings', 'screen=settings'],
  ['briefing', 'screen=briefing&progress=0.42'],
  ['flight', 'screen=flight&still&msg=msg.flapsDown'],
  ['paused', 'screen=paused&still'],
];

const scenes = [];
for (const [name, query] of SCREENS)
  for (const [size, vp] of Object.entries(SIZES))
    for (const lang of ['de', 'en']) {
      // English only where German was the long case: menu and setup get both everywhere.
      if (lang === 'en' && !['menu', 'setup'].includes(name) && size !== 'hd') continue;
      const device = vp.mobile ? '&device=mobile' : '';
      scenes.push({
        name: `${name}-${size}-${lang}`,
        url: `${base}?${query}&lang=${lang}${device}&shot`,
        vp,
      });
    }
// Readability over the extremes of the scene.
for (const bg of ['snow', 'night'])
  for (const [name, query] of [
    ['menu', 'screen=menu'],
    ['flight', 'screen=flight&still&warn=stall'],
  ]) {
    scenes.push({
      name: `${name}-hd-${bg}`,
      url: `${base}?${query}&bg=${bg}&lang=de&shot`,
      vp: SIZES.hd,
    });
    scenes.push({
      name: `${name}-land-${bg}`,
      url: `${base}?${query}&bg=${bg}&lang=de&device=mobile&shot`,
      vp: SIZES.land,
    });
  }
scenes.push({
  name: 'cockpit-hd',
  url: `${base}?screen=flight&still&view=cockpit&warn=stall&lang=de&shot`,
  vp: SIZES.hd,
});
scenes.push({ name: 'crash-hd', url: `${base}?screen=crash&still&lang=de&shot`, vp: SIZES.hd });
scenes.push({
  name: 'crash-land',
  url: `${base}?screen=crash&still&lang=de&device=mobile&shot`,
  vp: SIZES.land,
});
scenes.push({
  name: 'setup-empty-hd',
  url: `${base}?screen=setup&noairports&noaircraft&lang=de&shot`,
  vp: SIZES.hd,
});
scenes.push({
  name: 'briefing-live-hd',
  url: `${base}?screen=briefing&progress=0.8&live&lang=en&shot`,
  vp: SIZES.hd,
});
scenes.push({
  name: 'flight-debug-hd',
  url: `${base}?screen=flight&still&debug&lang=en`,
  vp: SIZES.hd,
});
// Phase 3: the panels, the navigation strip and the new briefing, on a large screen and a phone.
for (const [name, query] of [
  ['p3-radio-stack', 'screen=flight&still&p3&panel=radio,stack,checklist&checklist=approach'],
  ['p3-autopilot', 'screen=flight&still&p3&panel=autopilot&ap&annun=lowVolts'],
  ['p3-switches', 'screen=flight&still&p3&panel=switches'],
  ['p3-briefing-ils', 'screen=briefing&progress=0.4&plan=ils&p3'],
])
  for (const size of ['hd', 'land', 'port'])
    scenes.push({
      name: `${name}-${size}-de`,
      url: `${base}?${query}&lang=de${SIZES[size].mobile ? '&device=mobile' : ''}&shot`,
      vp: SIZES[size],
    });

async function launch() {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error('No Edge or Chrome found for the screenshots.');
}

const browser = await launch();
let n = 0;
for (const s of scenes) {
  if (filter && !s.name.includes(filter)) continue;
  const context = await browser.newContext({
    viewport: { width: s.vp.width, height: s.vp.height },
    deviceScaleFactor: 1,
    hasTouch: !!s.vp.mobile,
    isMobile: false,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(s.url);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(outDir, `${s.name}.png`) });
  if (errors.length) console.log(`${s.name}: ${errors.join(' | ')}`);
  await context.close();
  n++;
}
await browser.close();
console.log(`${n} screenshots in ${outDir}`);
