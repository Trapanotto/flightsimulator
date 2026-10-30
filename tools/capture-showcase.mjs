// Records the start-screen showcase as a smooth video: the world is stepped frame by frame
// with a fixed time step (however slow each grab is), and each frame waits for the terrain.
//
// Usage: node tools/capture-showcase.mjs [url] [shots=6]
//   url defaults to http://localhost:5180/flightsimulator/
// Env: BROWSER=path to Edge/Chrome, FPS=30, SIZE=1920x1080, T=16:30 (time of day),
//      FRAMES=build/showcase-frames (scratch dir)
// Output (needs ffmpeg on PATH):
//   public/assets/ui/hero.jpg       poster frame (start screen still)
//   public/assets/ui/og.jpg         link preview (1200x630)
//   docs/showcase.webp              animated preview for the README
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [base = 'http://localhost:5180/flightsimulator/', shotsArg = '6'] = process.argv.slice(2);
const SHOTS = Number(shotsArg);
const FPS = Number(process.env.FPS ?? 30);
const [W, H] = (process.env.SIZE ?? '1920x1080').split('x').map(Number);
const SHOT_SECONDS = 7;
const DIP = 0.3; // seconds of fade to black around each cut
const frames = process.env.FRAMES ?? 'build/showcase-frames';
fs.rmSync(frames, { recursive: true, force: true });
fs.mkdirSync(frames, { recursive: true });

const browser = await chromium.launch({
  executablePath:
    process.env.BROWSER ??
    (process.platform === 'win32'
      ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
      : '/usr/bin/microsoft-edge'),
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('page error', String(e)));
const url = `${base}?capture&quality=ultra&t=${process.env.T ?? '16:30'}`;
await page.goto(url);
await page.waitForFunction(() => document.querySelector('#ui')?.classList.contains('live'), null, {
  timeout: 90_000,
});
// Only the 3D view: menu off, a black layer for the fades on top.
await page.evaluate(() => {
  document.querySelector('#ui').style.display = 'none';
  const fade = document.createElement('div');
  fade.id = 'capture-fade';
  fade.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none';
  document.body.append(fade);
});

/** Steps one frame, waits for the terrain around the camera, renders it again. */
async function step(dt) {
  return page.evaluate(async (dt) => {
    const w = window.__world;
    w.captureFrame(dt);
    const t0 = performance.now();
    for (;;) {
      const s = w.stats();
      if (
        (s.coverage >= 0.995 && s.requestsInFlight === 0 && s.uploads === 0) ||
        performance.now() - t0 > 4000
      )
        break;
      await new Promise((r) => setTimeout(r, 40));
      w.captureFrame(0);
    }
    const sc = window.__showcase;
    const c = w.camera;
    // Camera direction relative to the aircraft position (origin shifts cancel out).
    const d = c.getWorldDirection(c.position.clone()).toArray();
    const rel = sc.anchor
      .clone()
      .sub(c.position)
      .toArray()
      .map((x) => +x.toFixed(3));
    // Where the aircraft is on screen (-1..1 = inside the frame).
    const ndc = sc.anchor.clone().project(c).toArray();
    return { shotTime: sc.shotTime, shot: sc.shot, type: sc.type.id, dir: d, rel, ndc };
  }, dt);
}

// Start on a fresh shot with a fresh aircraft.
await page.evaluate(() => {
  const s = window.__showcase;
  s.shotIndex = -1;
  s.shotsWithAircraft = -1;
  s.cut();
});
// Warm up: let the first frames load the terrain.
for (let i = 0; i < 10; i++) await step(0);

const total = Math.round(SHOTS * SHOT_SECONDS * FPS);
const log = [];
for (let i = 0; i < total; i++) {
  const t = i / FPS;
  const info = await step(i === 0 ? 0 : 1 / FPS);
  // Dip to black at the start, at every cut and at the end, so the clip loops cleanly.
  const inShot = t % SHOT_SECONDS;
  const edge = Math.min(inShot, SHOT_SECONDS - inShot);
  const fade = edge < DIP ? 1 - edge / DIP : 0;
  await page.evaluate((o) => {
    document.getElementById('capture-fade').style.opacity = String(o);
  }, fade * fade);
  await page.screenshot({
    path: path.join(frames, `f${String(i).padStart(5, '0')}.jpg`),
    type: 'jpeg',
    quality: 92,
  });
  log.push({ i, ...info });
  if (i % FPS === 0) console.log(`${t.toFixed(0)} s / ${total / FPS} s  ${info.type} ${info.shot}`);
}
fs.writeFileSync(path.join(frames, 'frames.json'), JSON.stringify(log));
// Smoothness: worst frame-to-frame change of the camera's turn rate (deg/s²) within a shot.
let worst = 0;
for (let i = 2; i < log.length; i++) {
  const [a, b, c] = [log[i - 2], log[i - 1], log[i]];
  if (a.shot !== c.shot || c.shotTime < 2 / FPS) continue;
  const ang = (u, v) => Math.acos(Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])) * 57.3;
  const r1 = ang(a.dir, b.dir) * FPS;
  const r2 = ang(b.dir, c.dir) * FPS;
  worst = Math.max(worst, Math.abs(r2 - r1) * FPS);
}
console.log('camera turn-rate jerk, worst:', worst.toFixed(1), 'deg/s²');
// The aircraft must stay in the picture (the wing shot looks along the wing).
const shots = {};
for (const f of log) {
  const k = `${f.type} ${f.shot}`;
  shots[k] ??= [0, 0];
  shots[k][1]++;
  const [x, y, z] = f.ndc;
  if (Math.abs(x) < 0.95 && Math.abs(y) < 0.95 && z < 1) shots[k][0]++;
}
for (const [k, [inside, n]] of Object.entries(shots))
  console.log(`  ${k}: aircraft in frame ${((100 * inside) / n).toFixed(0)} %`);
await browser.close();

// ---- encode ----
const ff = (args) =>
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
const input = ['-framerate', String(FPS), '-i', path.join(frames, 'f%05d.jpg')];
// Poster and link preview: a frame of the second shot (side view); POSTER=seconds.
const posterFrame = Math.round(Number(process.env.POSTER ?? SHOT_SECONDS * 1.5) * FPS);
const poster = path.join(frames, `f${String(posterFrame).padStart(5, '0')}.jpg`);
ff(['-i', poster, '-vf', 'scale=1600:900:flags=lanczos', '-q:v', '3', 'public/assets/ui/hero.jpg']);
// Open Graph wants 1200x630 (1.9:1): crop the 16:9 frame a little top and bottom.
ff([
  ...['-i', poster, '-vf', 'scale=1200:675:flags=lanczos,crop=1200:630'],
  ...['-q:v', '3', 'public/assets/ui/og.jpg'],
]);
// README preview: the first two shots, smaller and at 12 fps.
fs.mkdirSync('docs', { recursive: true });
ff([
  ...input,
  ...['-t', String(SHOT_SECONDS * 2), '-vf', 'fps=12,scale=640:360:flags=lanczos'],
  ...['-c:v', 'libwebp', '-quality', '60', '-loop', '0', '-an'],
  'docs/showcase.webp',
]);
const outputs = ['hero.jpg', 'og.jpg'].map((f) => `public/assets/ui/${f}`);
for (const f of [...outputs, 'docs/showcase.webp'])
  console.log(f, (fs.statSync(f).size / 1e6).toFixed(2), 'MB');
