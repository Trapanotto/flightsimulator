// Phase 4 acceptance test in headless Edge/Chrome (real GPU, real terrain streaming):
//   1. take off at Bern-Belp 32 with the keyboard, climb, gear up
//   2. fly through the Lauterbrunnen valley (test autopilot)
//   3. approach Sion 25 on a 3° glide path and land (test autopilot)
// Usage: node tools/flight-test.mjs [base=http://localhost:5180/flightsimulator/]
// Screenshots go to build/flight_*.png. Needs the dev server (window.__game).
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:5180/flightsimulator/';
const browser = await chromium.launch({
  executablePath: process.env.BROWSER ?? '/usr/bin/microsoft-edge',
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('[page error]', String(e)));
await page.goto(`${base}?debug#fly`);
const ready = () =>
  page.waitForFunction(() => window.__game?.aircraft && !window.__game.waitingForTerrain, null, {
    timeout: 90_000,
  });
const state = () =>
  page.evaluate(() => {
    const g = window.__game,
      f = g.fm,
      w = window.__world;
    const [lon, lat, h] = w.toGeo(f.position);
    return {
      kmh: Math.round(f.speed * 3.6),
      alt: Math.round(h),
      agl: Math.round((g.heightAboveGround ?? 0) - 1.53),
      vs: +f.verticalSpeed.toFixed(1),
      onGround: f.onGround,
      crashed: f.crashed,
      gear: f.gearDown,
      lon: +lon.toFixed(4),
      lat: +lat.toFixed(4),
      msg: g.message?.text ?? '',
      fps: Math.round(w.stats().fps),
    };
  });
const log = async (label) => console.log(label.padEnd(26), JSON.stringify(await state()));
const shot = (name) => page.screenshot({ path: `build/flight_${name}.png` });
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
};

// ---- 1. Take-off at Bern-Belp with real key presses ----
await ready();
await page.waitForTimeout(1000);
await log('Bern, on runway');
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(1800);
await page.keyboard.up('ShiftLeft');
await page.waitForFunction(() => window.__game.fm.speed > 36, null, { timeout: 40_000 });
await log('rotate speed');
await page.keyboard.down('KeyS');
await page.waitForTimeout(900);
await page.keyboard.up('KeyS');
await page
  .waitForFunction(() => !window.__game.fm.onGround, null, { timeout: 20_000 })
  .catch(() => {});
await page.waitForTimeout(4000);
await page.keyboard.press('KeyG');
await page.waitForTimeout(8000);
await log('after take-off');
const t1 = await state();
check(
  !t1.onGround && !t1.crashed && t1.agl > 40,
  'take-off at Bern-Belp: airborne, climbing, no crash',
);
check(t1.gear === false, 'gear retracted with G');
await shot('1_takeoff');

// Test autopilot: aims at a target (lon, lat, h) via the mouse-flight steering, holds a speed.
async function autopilot(seconds, waypoints, opts = {}) {
  return page.evaluate(
    async ({ seconds, waypoints, opts }) => {
      const g = window.__game,
        w = window.__world,
        f = g.fm;
      Object.defineProperty(g.aim, 'active', { configurable: true, get: () => true });
      let i = 0;
      const t0 = performance.now();
      const result = { reached: 0, crashed: false, landed: false, minAgl: 1e9, events: [] };
      while ((performance.now() - t0) / 1000 < seconds) {
        await new Promise((r) => setTimeout(r, 50));
        if (f.crashed) {
          result.crashed = true;
          break;
        }
        const wp = waypoints[i];
        if (!wp) break;
        const target = w.fromGeo(wp.lon, wp.lat, wp.h);
        const to = target.clone().sub(f.position);
        const up = f.worldUp;
        const horiz = to.clone().addScaledVector(up, -to.dot(up)).length();
        if (horiz < (wp.radius ?? 1200)) {
          i++;
          result.reached = i;
          continue;
        }
        g.aim.direction.copy(to.normalize());
        const kmh = wp.kmh ?? opts.kmh ?? 400;
        g.controls.touch.throttle = Math.max(0, Math.min(1, 0.55 + (kmh / 3.6 - f.speed) * 0.08));
        const agl = (g.heightAboveGround ?? 1e9) - 1.53;
        result.minAgl = Math.min(result.minAgl, agl);
      }
      delete g.aim.active;
      return result;
    },
    { seconds, waypoints, opts },
  );
}

// ---- 2. Lauterbrunnen valley ----
await page.evaluate(() => {
  const p = window.__game; // air start at the valley entrance, heading south
  p.start({ kind: 'air', name: 'Lauterbrunnen', lon: 7.909, lat: 46.63, h: 1900, heading: 180 });
});
await ready();
await page.waitForTimeout(1500);
await log('Lauterbrunnen start');
const valley = await autopilot(70, [
  { lon: 7.908, lat: 46.595, h: 1700, kmh: 330 }, // over Lauterbrunnen village
  { lon: 7.905, lat: 46.565, h: 1800, kmh: 330 }, // Stechelberg
  { lon: 7.86, lat: 46.545, h: 2600, kmh: 330 }, // climb out west
]);
await log('after valley');
console.log('  valley', JSON.stringify(valley));
check(!valley.crashed && valley.reached >= 2, 'Lauterbrunnen valley flown (2 waypoints), no crash');
await shot('2_lauterbrunnen');

// ---- 3. Landing at Sion 25 ----
// Final approach fix: 8 km east of the threshold on the extended centre line, 3° glide path.
const approach = await page.evaluate(() => {
  const w = window.__world;
  const thr = { lat: 46.221981, lon: 7.339386 },
    end = { lat: 46.216698, lon: 7.314575 };
  const dLat = thr.lat - end.lat,
    dLon = thr.lon - end.lon;
  const len = Math.hypot(dLat * 111_320, dLon * 111_320 * Math.cos((thr.lat * Math.PI) / 180));
  const at = (m) => ({ lat: thr.lat + (dLat * m) / len, lon: thr.lon + (dLon * m) / len }); // m > 0: east of threshold
  const elev = w.groundAt(thr.lon, thr.lat) ?? 482;
  return { at: [8000, 5000, 3000, 1500, 600, 0, -350].map((m) => ({ ...at(m), m })), elev };
});
const glide = (m) => approach.elev + 1.53 + Math.max(0, m) * Math.tan((3 * Math.PI) / 180) + 4;
const fix = approach.at[0];
await page.evaluate(
  ({ fix, h }) => {
    window.__game.start({
      kind: 'air',
      name: 'Sion final',
      lon: fix.lon,
      lat: fix.lat,
      h,
      heading: 253,
    });
  },
  { fix, h: glide(fix.m) },
);
await ready();
// Landing configuration: gear down, full flaps.
await page.evaluate(() => {
  const g = window.__game;
  g.fm.gearDown = true;
  g.fm.flaps = 1;
  g.fm.speed = 50;
});
await page.waitForTimeout(500);
await log('Sion final 8 km');
const final = await autopilot(
  150,
  approach.at
    .slice(1)
    .map((p) => ({
      lon: p.lon,
      lat: p.lat,
      h: glide(p.m),
      kmh: p.m > 1500 ? 175 : 150,
      radius: 250,
    })),
);
await log('over threshold');
// Flare and roll-out: idle, nose slightly up, then brake.
await page.evaluate(async () => {
  const g = window.__game,
    f = g.fm;
  Object.defineProperty(g.aim, 'active', { configurable: true, get: () => true });
  const t0 = performance.now();
  while (performance.now() - t0 < 40_000 && !f.crashed) {
    await new Promise((r) => setTimeout(r, 30));
    const agl = (g.heightAboveGround ?? 99) - 1.53;
    g.controls.touch.throttle = f.onGround ? 0 : agl > 6 ? 0.3 : 0;
    // Aim a little above the horizon in the flare so the sink rate goes to ~1 m/s.
    const fwd = f.forward.clone().addScaledVector(f.worldUp, -f.forward.dot(f.worldUp)).normalize();
    const pitch = f.onGround
      ? 0
      : agl > 8
        ? -0.05
        : 0.04 + Math.max(0, -f.verticalSpeed - 1) * 0.02;
    g.aim.direction.copy(fwd.addScaledVector(f.worldUp, pitch).normalize());
    if (f.onGround && f.speed < 1) break;
  }
  delete g.aim.active;
});
const brakeDown = page.keyboard.down('KeyB');
await brakeDown;
await page.waitForTimeout(6000);
await page.keyboard.up('KeyB');
await log('after landing');
const t3 = await state();
const msgs = await page.evaluate(() => window.__game.message?.text ?? '');
check(
  !t3.crashed && t3.onGround && t3.kmh < 20,
  `landed at Sion and stopped (${msgs || 'message gone'})`,
);
check(!final.crashed, 'approach flown without crash');
await shot('3_sion');

// Camera modes render without errors.
for (const mode of ['cockpit', 'wing', 'orbit', 'chase']) {
  await page.evaluate((m) => (window.__game.rig.mode = m), mode);
  await page.waitForTimeout(600);
  await shot(`cam_${mode}`);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
