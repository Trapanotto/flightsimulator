// Operates the interface demo in a real browser and checks what happens: keyboard through the
// menu, a flight from setup to pause, a setting that survives a reload, and two thumbs on the
// touch controls at once. Needs the dev server: `npx vite --port 5205 --strictPort`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base =
  process.argv.find((a) => a.startsWith('--base='))?.slice(7) ??
  'http://localhost:5205/flightsimulator/demo/ui.html';

async function launch() {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error('No Edge or Chrome found.');
}

const browser = await launch();
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
  }
}

const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el ? (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() : '';
  });
const screen = (page) => page.evaluate(() => window.__demo.game.screen.value);

// --- Keyboard through the menu, into a flight and the pause screen ---------------------------
await check('keyboard: menu → setup → flight → pause → resume', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${base}?screen=menu&lang=en`);
  await page.waitForSelector('.menu-item');
  assert.match(await focused(page), /^Fly/, 'Fly has focus on arrival');
  await page.keyboard.press('ArrowDown');
  assert.match(await focused(page), /^Hangar/);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.match(await focused(page), /^Settings/, 'arrow keys wrap');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.setup');
  await page.waitForTimeout(100); // effects run after the first paint
  assert.match(await focused(page), /LSZB/, 'focus moves to the chosen airport');
  // Arrow keys choose within the airport group.
  await page.keyboard.press('ArrowDown');
  assert.equal(
    await page.evaluate(() => document.querySelector('.apt.is-on .apt-icao').textContent),
    'LSZH',
  );
  // Tab stays inside the setup (focus trap): 60 tabs never leave it.
  for (let i = 0; i < 60; i++) await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => !!document.activeElement.closest('.setup')), 'focus trapped');
  // Escape goes back to the main menu.
  await page.keyboard.press('Escape');
  await page.waitForSelector('.setup', { state: 'detached' });
  assert.equal(await screen(page), 'menu');
  // Back in and start.
  await page.click('.menu-item.is-primary');
  await page.click('.setup-go');
  assert.equal(await screen(page), 'briefing');
  const plan = await page.evaluate(() => window.__demo.game.plan.value);
  assert.equal(plan.start.kind, 'runway');
  assert.equal(plan.start.airport, 'LSZH', 'the choice made with the arrow keys');
  await page.waitForFunction(() => window.__demo.game.screen.value === 'flight', null, {
    timeout: 8000,
  });
  await page.waitForSelector('.hud');
  await page.keyboard.press('p');
  await page.waitForSelector('.pause');
  await page.waitForTimeout(100);
  assert.match(await focused(page), /Resume/, 'focus on resume');
  await page.keyboard.press('Enter');
  assert.equal(await screen(page), 'flight');
  // The setup was remembered.
  await page.reload();
  await page.waitForSelector('.menu-item');
  await page.click('.menu-item.is-primary');
  assert.equal(
    await page.evaluate(() => document.querySelector('.apt.is-on .apt-icao').textContent),
    'LSZH',
    'last choice remembered',
  );
  await page.close();
});

// --- Loading to menu: the wordmark does not move ------------------------------------------------
await check('loading → menu without a layout jump', async () => {
  for (const vp of [
    { width: 1280, height: 720 },
    { width: 844, height: 390 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport: vp });
    await page.goto(`${base}?screen=loading&lang=de`);
    await page.waitForSelector('.loading-block');
    const before = await page.locator('.brand-title').boundingBox();
    await page.waitForSelector('.menu-item', { timeout: 6000 });
    await page.waitForTimeout(800);
    const after = await page.locator('.brand-title').boundingBox();
    assert.deepEqual(after, before, `${vp.width}x${vp.height}`);
    await page.close();
  }
});

// --- Settings: change, Esc closes without resuming, persists over a reload -------------------
await check('settings: units persist; Esc closes only the dialog', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${base}?screen=paused&still&lang=en`);
  await page.waitForSelector('.pause');
  await page.click('text=Settings');
  await page.waitForSelector('.settings');
  await page.waitForTimeout(100);
  assert.match(await focused(page), /General/);
  await page.click('.settings [role="radio"]:has-text("Metric")');
  assert.equal(await page.evaluate(() => window.__demo.settings.units.value), 'metric');
  // Tabs with arrow keys.
  await page.focus('[role="tab"][aria-selected="true"]');
  await page.keyboard.press('ArrowRight');
  assert.match(await focused(page), /Display/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.settings', { state: 'detached' });
  assert.equal(await screen(page), 'paused', 'Esc closed the dialog, not the pause');
  assert.match(await page.textContent('.hud-speed'), /km\/h/);
  await page.reload();
  await page.waitForSelector('.pause');
  assert.equal(await page.evaluate(() => window.__demo.settings.units.value), 'metric');
  // Corrupt storage must not break the start.
  await page.evaluate(() => localStorage.setItem('tfs.settings', '{broken'));
  await page.evaluate(() => localStorage.setItem('tfs.setup', '[1,2,3]'));
  await page.reload();
  await page.waitForSelector('.pause');
  assert.equal(await page.evaluate(() => window.__demo.settings.units.value), 'aviation');
  await page.evaluate(() => localStorage.clear());
  await page.close();
});

// --- Touch: stick and throttle with two fingers at once ---------------------------------------
await check('touch: two thumbs, stick returns to centre, throttle stays', async () => {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(`${base}?screen=flight&still&device=mobile&lang=de`);
  await page.waitForSelector('.stick-zone');
  const cdp = await context.newCDPSession(page);
  const box = async (sel) => page.locator(sel).boundingBox();
  const stick = await box('.stick-base');
  const lever = await box('.throttle-track');
  const sc = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2 };
  const r = stick.width / 2 - 8;
  const lx = lever.x + lever.width / 2;
  const touch = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map(([id, x, y]) => ({ id, x, y, radiusX: 4, radiusY: 4, force: 1 })),
    });
  // Finger 1 on the stick, finger 2 on the throttle.
  await touch('touchStart', [[1, sc.x, sc.y]]);
  await touch('touchStart', [
    [1, sc.x, sc.y],
    [2, lx, lever.y + lever.height - 25],
  ]);
  // Stick fully right and down (pull back), throttle up near the top, in the same moves.
  for (let i = 1; i <= 5; i++) {
    await touch('touchMove', [
      [1, sc.x + ((r * 1.6 * i) / 5) * 0.7071, sc.y + ((r * 1.6 * i) / 5) * 0.7071],
      [2, lx, lever.y + lever.height - 25 - ((lever.height - 50) * i) / 5],
    ]);
  }
  // Pointer moves are delivered once per frame: let the last one arrive.
  await page.waitForTimeout(100);
  const during = await page.evaluate(() => {
    const t = window.__demo.touchInput;
    return { pitch: t.pitch.value, roll: t.roll.value, throttle: t.throttle.value };
  });
  assert.ok(during.pitch > 0.5, `pitch up while pulling: ${during.pitch}`);
  assert.ok(during.roll > 0.5, `roll right: ${during.roll}`);
  assert.ok(Math.hypot(during.pitch, during.roll) <= 1.0001, 'inside the unit circle');
  assert.ok(during.throttle > 0.95, `throttle near full: ${during.throttle}`);
  // Lift the stick finger only: stick back to centre (null), throttle unaffected.
  // (A CDP touchEnd lists the fingers that lift.)
  await touch('touchEnd', [[1, sc.x, sc.y]]);
  await page.waitForTimeout(50);
  const after = await page.evaluate(() => {
    const t = window.__demo.touchInput;
    return { pitch: t.pitch.value, roll: t.roll.value, throttle: t.throttle.value };
  });
  assert.equal(after.pitch, null);
  assert.equal(after.roll, null);
  assert.ok(after.throttle > 0.95, 'throttle stays where it was put');
  await touch('touchEnd', []);
  // The flight buttons: a tap on gear counts once; brake held is true until released.
  const gear = await box('.pad-gear');
  const before = await page.evaluate(() => window.__demo.touchInput.gearToggle.value);
  await touch('touchStart', [[3, gear.x + 20, gear.y + 20]]);
  await touch('touchEnd', []);
  assert.equal(await page.evaluate(() => window.__demo.touchInput.gearToggle.value), before + 1);
  const brake = await box('.pad-brake');
  await touch('touchStart', [[4, brake.x + 20, brake.y + 20]]);
  assert.equal(await page.evaluate(() => window.__demo.touchInput.brake.value), true);
  await touch('touchEnd', []);
  assert.equal(await page.evaluate(() => window.__demo.touchInput.brake.value), false);
  // The page never scrolled or zoomed.
  assert.equal(await page.evaluate(() => window.scrollY + window.scrollX), 0);
  assert.equal(await page.evaluate(() => window.visualViewport?.scale ?? 1), 1);
  await context.close();
});

// --- The HUD updates in place: text changes, but no nodes are re-created --------------------
await check('HUD: 20 updates a second without re-rendering', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${base}?screen=flight&lang=en`);
  await page.waitForSelector('.hud');
  await page.waitForTimeout(300);
  const counts = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const c = { text: 0, nodes: 0, updates: 0 };
        const stop = window.__demo.game.telemetry.subscribe(() => c.updates++);
        // Keep the fake aircraft moving so the numbers change.
        window.__demo.sim.throttle = 1;
        new MutationObserver((list) => {
          for (const m of list) {
            if (m.type === 'characterData') c.text++;
            else if (m.type === 'childList' && !m.target.closest?.('.notice, .warnings')) c.nodes++;
          }
        }).observe(document.querySelector('.hud'), {
          subtree: true,
          childList: true,
          characterData: true,
        });
        setTimeout(() => {
          stop();
          resolve(c);
        }, 1500);
      }),
  );
  assert.ok(counts.updates >= 25, `telemetry updates: ${counts.updates}`);
  assert.ok(counts.text > 10, `text updated in place: ${counts.text}`);
  assert.equal(counts.nodes, 0, 'no element was re-created');
  results.push(
    `     (${counts.updates} telemetry updates, ${counts.text} text changes, ${counts.nodes} node changes)`,
  );
  await page.close();
});

// --- Touch targets are at least 44 px on touch devices ------------------------------------------
await check('touch targets at least 44 px', async () => {
  const small = [];
  for (const vp of [
    { width: 844, height: 390 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport: vp });
    for (const s of [
      'menu',
      'setup',
      'settings',
      'flight&still',
      'paused&still',
      'flight&still&p3&panel=radio',
      'flight&still&p3&panel=stack',
      'flight&still&p3&panel=autopilot&ap',
      'flight&still&p3&panel=switches',
      'flight&still&p3&panel=checklist&checklist=approach',
      'flight&still&p3&tools',
    ]) {
      await page.goto(base + '?screen=' + s + '&device=mobile&lang=de');
      await page.waitForTimeout(700);
      const found = await page.evaluate(() =>
        [...document.querySelectorAll('.ui button, .ui input, .ui [role=slider]')]
          .filter((el) => !el.closest('[inert]'))
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.bottom > 0 && r.top < innerHeight)
          .filter(({ r }) => Math.min(r.width, r.height) < 43.5)
          .map(
            ({ el, r }) =>
              (el.className || el.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
          ),
      );
      for (const f of found) small.push(vp.width + 'x' + vp.height + ' ' + s + ': ' + f);
    }
    await page.close();
  }
  assert.deepEqual(small, []);
});

// --- No horizontal overflow at any size ------------------------------------------------------
await check('no horizontal scrolling at any size or screen', async () => {
  const sizes = [
    [1920, 1080],
    [1280, 720],
    [1024, 768],
    [844, 390],
    [390, 844],
  ];
  const screens = [
    'menu',
    'setup',
    'settings',
    'briefing&progress=0.5',
    'flight&still',
    'paused&still',
  ];
  const bad = [];
  for (const [w, h] of sizes) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    for (const s of screens) {
      const device = w < 1100 ? '&device=mobile' : '';
      await page.goto(`${base}?screen=${s}&lang=de${device}`);
      await page.waitForTimeout(150);
      const over = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const out = [];
        for (const el of document.querySelectorAll('.ui *')) {
          // Clipped on purpose (the tape) or hidden and inert (the menu behind the setup).
          if (el.closest('.tape-window, [inert]')) continue;
          const r = el.getBoundingClientRect();
          if (
            r.width &&
            (r.right > vw + 1 || r.left < -1) &&
            getComputedStyle(el).visibility !== 'hidden'
          )
            out.push(el.className || el.tagName);
        }
        return { scroll: document.documentElement.scrollWidth > vw, out: out.slice(0, 3) };
      });
      if (over.scroll || over.out.length) bad.push(`${w}x${h} ${s}: ${over.out.join(', ')}`);
    }
    await page.close();
  }
  assert.deepEqual(bad, []);
});

// --- Phase 3: panels by key, Escape, replies, tuning; the flight keys keep working ---------
await check(
  'panels: keys, Escape without pausing, focus kept, replies, tuning, typing',
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${base}?screen=flight&still&p3&lang=en`);
    await page.waitForSelector('.radio-panel');
    const open = () => page.evaluate(() => window.__demo.panels.open.value.join(','));
    const bodyFocused = () => page.evaluate(() => document.activeElement === document.body);
    assert.equal(await open(), 'radio', 'the radio opens by itself with ATC');
    await page.keyboard.press('n');
    assert.equal(await open(), 'radio,stack');
    await page.keyboard.press('u');
    assert.equal(await open(), 'radio,autopilot', 'one avionics panel at a time');
    assert.ok(await bodyFocused(), 'opening took no focus: the flight keys still go to the app');
    await page.click('.ap-panel .ap-btn');
    assert.ok(await bodyFocused(), 'a click in a panel took no focus');
    // Escape inside a panel closes it and does not pause.
    await page.focus('.ap-panel .ap-btn');
    await page.keyboard.press('Escape');
    assert.equal(await open(), 'radio');
    assert.equal(await screen(page), 'flight');
    // Reply 1; the controller hands over to the tower; T tunes it (standby, then swap).
    await page.keyboard.press('1');
    await page.waitForFunction(() => window.__demo.game.atc.value?.options.length, null, {
      timeout: 4000,
    });
    await page.keyboard.press('1');
    await page.waitForFunction(() => window.__demo.game.atc.value?.hint, null, { timeout: 4000 });
    await page.keyboard.press('t');
    await page.waitForFunction(
      () => window.__demo.game.cockpit.value?.com1Active === 118100,
      null,
      {
        timeout: 2000,
      },
    );
    // Typing a frequency: the keys go to the field, not to the panels.
    await page.keyboard.press('n');
    await page.click('.radio-card .value-input');
    await page.keyboard.type('121.5n');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.__demo.game.cockpit.value.com1Standby), 121500);
    assert.equal(await open(), 'radio,stack', 'typing n did not close the stack');
    // Checklist: L opens, X ticks.
    await page.keyboard.press('l');
    await page.click('.check-list-btn');
    await page.keyboard.press('x');
    assert.equal(
      await page.evaluate(() => window.__demo.game.checklist.value.items[0].state),
      'done',
    );
    await page.close();
  },
);

// --- Phase 4: the hangar by keyboard, the setup with the chosen type --------------------------
await check('hangar: keyboard, swipe, showAircraft, fly this aircraft', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${base}?screen=menu&fleet&lang=en`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.menu-item');
  const shown = [];
  page.on('console', (m) => {
    const text = m.text();
    if (text.startsWith('showAircraft')) shown.push(text.split(' ')[1]);
  });
  await page.keyboard.press('ArrowDown');
  assert.match(await focused(page), /^Hangar/);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.hangar');
  await page.waitForTimeout(100);
  assert.match(await focused(page), /^Cessna/, 'focus on the chosen card');
  // Arrow keys in the strip and anywhere else step through the types.
  await page.keyboard.press('ArrowRight');
  assert.match(await page.textContent('.hangar-name'), /PC-12/);
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowRight');
  assert.match(await page.textContent('.hangar-name'), /A320/);
  // Effects (and the console) run after the paint.
  await page.waitForTimeout(100);
  assert.deepEqual(shown.slice(-1), ['a320'], 'the scene shows the chosen type');
  // Fly this aircraft: the setup opens with the A320, at an airport it may use.
  await page.click('.hangar-fly');
  await page.waitForSelector('.setup');
  assert.equal(
    await page.evaluate(
      () => document.querySelector('.craft-tile.is-on .craft-tile-name').textContent,
    ),
    'A320',
  );
  assert.equal(
    await page.evaluate(() => document.querySelector('.apt.is-on .apt-icao').textContent),
    'LSZH',
  );
  assert.equal(shown.at(-1), 'null', 'the scene goes back to its own aircraft');
  // An airport the A320 may not use cannot be chosen.
  await page.click('.apt.is-off >> nth=0', { force: true });
  assert.equal(
    await page.evaluate(() => document.querySelector('.apt.is-on .apt-icao').textContent),
    'LSZH',
  );
  await page.keyboard.press('Escape');
  // Back in the hangar, Escape returns to the menu.
  await page.click('.menu-item >> nth=1');
  await page.waitForSelector('.hangar');
  await page.waitForTimeout(100); // effects run after the first paint
  await page.keyboard.press('Escape');
  await page.waitForSelector('.hangar', { state: 'detached' });
  await page.evaluate(() => localStorage.clear());
  await page.close();

  // A swipe on a phone moves to the next type.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const phone = await context.newPage();
  await phone.goto(`${base}?screen=hangar&fleet&device=mobile&lang=de`);
  await phone.waitForSelector('.hangar-sheet');
  const about = await phone.locator('.hangar-about').boundingBox();
  const cdp = await context.newCDPSession(phone);
  const y = about.y + 10;
  const send = (type, x) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x, y, radiusX: 4, radiusY: 4, force: 1 }],
    });
  await send('touchStart', 300);
  for (let i = 1; i <= 5; i++) await send('touchMove', 300 - i * 40);
  await send('touchEnd', 100);
  await phone.waitForTimeout(100);
  assert.match(await phone.textContent('.hangar-name'), /PC-12/, 'swiped to the next type');
  await context.close();
});

// --- Phase 4: speed brake lever and reverse on touch ------------------------------------------
await check('touch: speed brake lever stays, reverse held, hidden on the Cessna', async () => {
  for (const vp of [
    { width: 844, height: 390 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport: vp, hasTouch: true });
    const page = await context.newPage();
    await page.goto(`${base}?screen=flight&still&device=mobile&lang=de&aircraft=a320`);
    await page.waitForSelector('.speedbrake-track');
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map(([id, x, y]) => ({ id, x, y, radiusX: 4, radiusY: 4, force: 1 })),
      });
    const sb = await page.locator('.speedbrake-track').boundingBox();
    const flat = sb.width > sb.height;
    const from = flat ? [sb.x + 10, sb.y + sb.height / 2] : [sb.x + sb.width / 2, sb.y + 10];
    const to = flat
      ? [sb.x + sb.width - 2, sb.y + sb.height / 2]
      : [sb.x + sb.width / 2, sb.y + sb.height - 2];
    await touch('touchStart', [[1, ...from]]);
    for (let i = 1; i <= 5; i++)
      await touch('touchMove', [
        [1, from[0] + ((to[0] - from[0]) * i) / 5, from[1] + ((to[1] - from[1]) * i) / 5],
      ]);
    await page.waitForTimeout(80);
    await touch('touchEnd', []);
    const sbValue = await page.evaluate(() => window.__demo.touchInput.speedbrake.value);
    assert.ok(sbValue > 0.95, `speed brake fully out: ${sbValue}`);
    const rev = await page.locator('.pad-rev').boundingBox();
    await touch('touchStart', [[2, rev.x + 20, rev.y + 20]]);
    assert.equal(await page.evaluate(() => window.__demo.touchInput.reverse.value), true);
    await touch('touchEnd', []);
    assert.equal(await page.evaluate(() => window.__demo.touchInput.reverse.value), false);
    // Nothing of it overlaps another control.
    const boxes = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '.stick-base, .throttle-track, .rudder-track, .pad-btn, .speedbrake-track',
        ),
      ].map((el) => {
        const r = el.getBoundingClientRect();
        return { c: el.className, x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    );
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.ok(!overlap, `${vp.width}x${vp.height}: ${a.c} overlaps ${b.c}`);
      }
    await context.close();
  }
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(`${base}?screen=flight&still&device=mobile&lang=de&fleet`);
  await page.waitForSelector('.pad');
  assert.equal(await page.locator('.speedbrake, .pad-rev').count(), 0, 'the Cessna has neither');
  await context.close();
});

// --- Phase 4: the HUD of a jet keeps its layout as the values change --------------------------
await check('HUD of the A320 and the F/A-18: no layout shift as values change', async () => {
  for (const type of ['a320', 'fa18']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${base}?screen=flight&still&lang=de&aircraft=${type}`);
    await page.waitForSelector('.hud-systems');
    const rects = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.hud-card, .sys-bar, .sys-n1, .hud-mach, .hud-fx')].map(
          (el) => {
            const r = el.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height].map(Math.round).join(',');
          },
        ),
      );
    const before = await rects();
    // The values that change width the most: three digits to one, Mach below 0.4, g negative.
    await page.evaluate(() => {
      const g = window.__demo.game;
      const t = g.telemetry.value;
      g.telemetry.value = {
        ...t,
        ias: 9,
        mach: 0.02,
        loadFactor: -2.5,
        alpha: 0.3,
        engines: t.engines.map((e) => ({ ...e, n1: 101.4, afterburner: 1 })),
      };
    });
    await page.waitForTimeout(50);
    assert.deepEqual(await rects(), before, `${type}: nothing moved`);
    await page.close();
  }
});

await browser.close();
console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
