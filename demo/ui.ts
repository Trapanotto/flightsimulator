/**
 * Demo of the interface without the 3D app: a painted stand-in for the scene, fake airports,
 * a fake flight and fake actions that move `game.screen` the way the app will.
 *
 * URL switches:
 *   screen=loading|menu|setup|briefing|flight|paused|settings|crash
 *   device=mobile   lang=de|en   bg=day|snow|night   view=cockpit   warn=stall|overspeed
 *   progress=0..1 (frozen loading/briefing progress)   still (frozen telemetry)
 *   noairports   noaircraft   live (briefing with a live weather report)   debug   msg=<text>
 */
import { AIRCRAFT, type Telemetry } from '@sim';
import {
  type AirportOption,
  type FlightPlan,
  type UiActions,
  game,
  mountUi,
  nav,
  setLang,
  settings,
  status,
  touchInput,
} from '@ui';

const q = new URLSearchParams(location.search);
const screenParam = q.get('screen') ?? 'loading';

// --- Stand-ins ---------------------------------------------------------------------------

if (!q.has('noaircraft') && !AIRCRAFT.length)
  AIRCRAFT.push({
    id: 'c172',
    name: 'Cessna 172 Skyhawk',
    engines: 1,
    vs: 24.7, // 48 KIAS clean
    vs0: 20.6, // 40 KIAS landing flaps
    vne: 84.9, // 165 KIAS
    maxTakeoffMass: 1111,
    retractableGear: false,
  });

const AIRPORTS: AirportOption[] = [
  {
    icao: 'LSZB',
    name: 'Bern-Belp',
    lon: 7.4971,
    lat: 46.9141,
    elevation: 510,
    runways: ['14', '32'],
  },
  {
    icao: 'LSZH',
    name: 'Zürich',
    lon: 8.5492,
    lat: 47.4647,
    elevation: 432,
    runways: ['28', '10', '16', '34', '14', '32'],
  },
  { icao: 'LSGG', name: 'Genève', lon: 6.109, lat: 46.2381, elevation: 411, runways: ['22', '04'] },
  { icao: 'LSGS', name: 'Sion', lon: 7.3267, lat: 46.2196, elevation: 482, runways: ['25', '07'] },
  {
    icao: 'LSZS',
    name: 'Samedan',
    lon: 9.8841,
    lat: 46.5341,
    elevation: 1707,
    runways: ['03', '21'],
  },
  {
    icao: 'LSZA',
    name: 'Lugano-Agno',
    lon: 8.9106,
    lat: 46.004,
    elevation: 279,
    runways: ['01', '19'],
  },
];

const lang = q.get('lang');
if (lang === 'de' || lang === 'en') setLang(lang);
if (q.get('device') === 'mobile') status.device.value = 'mobile';
status.version.value = '1.0.0-alpha.0';
status.renderer.value = 'WebGPU';
status.simHz.value = 120;
status.fps.value = 60;
status.resolution.value = [window.innerWidth, window.innerHeight];
if (!q.has('noairports')) game.airports.value = AIRPORTS;
if (q.has('shot')) document.body.classList.add('shots');

// --- Painted background ---------------------------------------------------------------------

function paint() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const bg = q.get('bg') ?? 'day';
  const horizon = h * 0.58;
  const pal =
    bg === 'snow'
      ? {
          sky0: '#bcd3ea',
          sky1: '#f4f8fc',
          far: '#e8eef5',
          farCap: '#ffffff',
          mid: '#f1f4f8',
          ground0: '#f7f9fb',
          ground1: '#e9eef3',
          shadow: '#c8d4e0',
        }
      : bg === 'night'
        ? {
            sky0: '#03060d',
            sky1: '#16243d',
            far: '#0d1424',
            farCap: '#1a2438',
            mid: '#090e18',
            ground0: '#070b12',
            ground1: '#04070c',
            shadow: '#000',
          }
        : {
            sky0: '#3f78c4',
            sky1: '#cfe2f3',
            far: '#7f93ab',
            farCap: '#eef3f8',
            mid: '#5f7f52',
            ground0: '#7d9a5c',
            ground1: '#4f6e3c',
            shadow: '#3a4a35',
          };

  const sky = g.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, pal.sky0);
  sky.addColorStop(1, pal.sky1);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, horizon + 2);

  // Deterministic "random" so screenshots are stable.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

  if (bg === 'night') {
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(255,255,255,${0.3 + rnd() * 0.7})`;
      g.fillRect(rnd() * w, rnd() * horizon * 0.9, rnd() < 0.1 ? 2 : 1, rnd() < 0.1 ? 2 : 1);
    }
  }

  // Alps: a jagged far ridge with snow caps.
  g.fillStyle = pal.far;
  g.beginPath();
  g.moveTo(0, horizon);
  const peaks: [number, number][] = [];
  for (let x = 0; x <= w + 40; x += 40) {
    const y = horizon - (60 + Math.abs(Math.sin(x * 0.006) * 140) + rnd() * 50) * (h / 900);
    peaks.push([x, y]);
    g.lineTo(x, y);
  }
  g.lineTo(w, horizon);
  g.fill();
  g.fillStyle = pal.farCap;
  for (const [x, y] of peaks) {
    if (y > horizon - 130 * (h / 900)) continue;
    g.beginPath();
    g.moveTo(x - 22, y + 30);
    g.lineTo(x, y);
    g.lineTo(x + 22, y + 30);
    g.fill();
  }

  // Hills and ground.
  g.fillStyle = pal.mid;
  g.beginPath();
  g.moveTo(0, horizon + 10);
  for (let x = 0; x <= w; x += 30) g.lineTo(x, horizon - 18 - Math.sin(x * 0.01) * 16);
  g.lineTo(w, h);
  g.lineTo(0, h);
  g.fill();
  const ground = g.createLinearGradient(0, horizon, 0, h);
  ground.addColorStop(0, pal.ground0);
  ground.addColorStop(1, pal.ground1);
  g.fillStyle = ground;
  g.fillRect(0, horizon + 4, w, h - horizon);

  // Runway in perspective, with centre line.
  const cx = w * 0.56;
  g.fillStyle = bg === 'snow' ? '#9aa6b2' : bg === 'night' ? '#151a22' : '#5b6066';
  g.beginPath();
  g.moveTo(cx - 14, horizon + 6);
  g.lineTo(cx + 14, horizon + 6);
  g.lineTo(cx + w * 0.22, h);
  g.lineTo(cx - w * 0.22, h);
  g.fill();
  g.strokeStyle = bg === 'night' ? '#ffd27a' : '#fff';
  g.setLineDash([18, 22]);
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(cx, horizon + 8);
  g.lineTo(cx, h);
  g.stroke();
  g.setLineDash([]);
  if (bg === 'night') {
    for (let i = 0; i < 18; i++) {
      const f = i / 18;
      const y = horizon + 8 + f * f * (h - horizon);
      const half = 14 + (w * 0.22 - 14) * f * f;
      g.fillStyle = '#fff3c4';
      g.fillRect(cx - half - 3, y, 3, 3);
      g.fillRect(cx + half, y, 3, 3);
    }
    for (let i = 0; i < 120; i++) {
      g.fillStyle = `rgba(255,${180 + rnd() * 60},120,${0.5 + rnd() * 0.5})`;
      g.fillRect(rnd() * w, horizon + rnd() * 40, 2, 2);
    }
  }

  // A light aircraft on the apron, roughly where the app's menu camera shows it.
  const px = w * 0.68;
  const py = h * 0.74;
  const s = Math.min(w, h) / 600;
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.beginPath();
  g.ellipse(px, py + 34 * s, 150 * s, 16 * s, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = bg === 'night' ? '#30363f' : '#f5f6f8';
  g.beginPath();
  g.ellipse(px, py, 95 * s, 16 * s, 0, 0, Math.PI * 2);
  g.fill();
  g.fillRect(px - 160 * s, py - 24 * s, 320 * s, 9 * s);
  g.fillStyle = '#c8202a';
  g.fillRect(px - 90 * s, py - 2 * s, 180 * s, 4 * s);
  g.fillStyle = bg === 'night' ? '#30363f' : '#f5f6f8';
  g.beginPath();
  g.moveTo(px + 80 * s, py - 6 * s);
  g.lineTo(px + 112 * s, py - 46 * s);
  g.lineTo(px + 120 * s, py - 6 * s);
  g.fill();
}
paint();
window.addEventListener('resize', paint);

// --- Fake flight -------------------------------------------------------------------------------

const keys = new Set<string>();
const sim = {
  heading: 140,
  ias: 0,
  altitude: 510,
  vs: 0,
  throttle: 0,
  flaps: 0,
  gear: 1,
  onGround: true,
  time: 0,
  crashed: undefined as string | undefined,
};
let feed = 0;
const still = q.has('still');

function telemetry(): Telemetry {
  const warn = q.get('warn');
  return {
    time: sim.time,
    ias: warn === 'overspeed' ? 88 : sim.ias,
    tas: sim.ias,
    groundSpeed: sim.ias,
    altitude: sim.altitude,
    agl: sim.altitude - 510,
    verticalSpeed: sim.vs,
    headingDeg: sim.heading,
    trackDeg: sim.heading,
    pitch: 0,
    bank: 0,
    alpha: 0,
    beta: 0,
    loadFactor: 1,
    onGround: sim.onGround,
    stallWarning: warn === 'stall' || (!sim.onGround && sim.ias < 24),
    flaps: sim.flaps,
    gear: sim.gear,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    engines: [
      { running: true, rpm: 800 + sim.throttle * 1900, power: sim.throttle, fuelFlow: 0.01 },
    ],
    fuel: 120,
    crashed: sim.crashed,
  };
}

function publish() {
  game.telemetry.value = telemetry();
  game.levers.value = {
    throttle: sim.throttle,
    flaps: sim.flaps,
    gearDown: sim.gear > 0.5,
    brake: touchInput.brake.value || keys.has('b'),
    parkingBrake: false,
  };
}

let lastFlapsUp = touchInput.flapsUp.value;
let lastFlapsDown = touchInput.flapsDown.value;
let lastThrottle: number | null = null;

function step() {
  if (game.screen.value !== 'flight') return;
  const dt = 0.05;
  sim.time += dt;
  const key = (a: string, b: string) => (keys.has(a) ? 1 : 0) - (keys.has(b) ? 1 : 0);
  // Touch and keyboard mixed as the app is asked to: summed and clamped.
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const pitch = clamp((touchInput.pitch.value ?? 0) + key('s', 'w'));
  const roll = clamp((touchInput.roll.value ?? 0) + key('d', 'a'));
  if (touchInput.throttle.value !== null && touchInput.throttle.value !== lastThrottle)
    sim.throttle = touchInput.throttle.value;
  lastThrottle = touchInput.throttle.value;
  sim.throttle = Math.max(0, Math.min(1, sim.throttle + key('shift', 'control') * dt * 0.6));
  if (touchInput.flapsUp.value !== lastFlapsUp) {
    lastFlapsUp = touchInput.flapsUp.value;
    sim.flaps = Math.max(0, sim.flaps - 1 / 3);
    message('msg.flapsUp');
  }
  if (touchInput.flapsDown.value !== lastFlapsDown) {
    lastFlapsDown = touchInput.flapsDown.value;
    sim.flaps = Math.min(1, sim.flaps + 1 / 3);
    message('msg.flapsDown');
  }
  if (still) {
    publish();
    return;
  }
  sim.ias += (sim.throttle * 60 - sim.ias * 0.6 - pitch * 6) * dt * 0.5;
  sim.heading = (sim.heading + roll * 12 * dt + 360) % 360;
  if (sim.onGround && sim.ias > 28 && pitch > 0.2) sim.onGround = false;
  if (!sim.onGround) {
    sim.vs += (pitch * 6 - sim.vs) * dt * 2;
    sim.altitude += sim.vs * dt;
    if (sim.altitude < 510) {
      sim.altitude = 510;
      if (sim.vs < -6) sim.crashed = 'ground';
      sim.onGround = true;
      sim.vs = 0;
    }
  }
  publish();
}
setInterval(step, 50);

function message(text: string) {
  game.message.value = null;
  game.message.value = text;
}

function startFeed(fixed?: Partial<typeof sim>) {
  Object.assign(
    sim,
    {
      heading: 140,
      ias: 0,
      altitude: 510,
      vs: 0,
      throttle: 0,
      flaps: 0,
      gear: 1,
      onGround: true,
      time: 0,
      crashed: undefined,
    },
    fixed,
  );
  publish();
}

// --- Fake actions -------------------------------------------------------------------------

function runProgress(next: 'menu' | 'flight', seconds: number) {
  cancelAnimationFrame(feed);
  const fixed = q.get('progress');
  if (fixed !== null) {
    game.loadProgress.value = Number(fixed);
    return;
  }
  const t0 = performance.now();
  const tick = () => {
    const p = Math.min(1, (performance.now() - t0) / (seconds * 1000));
    game.loadProgress.value = p;
    if (p < 1) feed = requestAnimationFrame(tick);
    else {
      game.screen.value = next;
      if (next === 'flight') startFeed();
    }
  };
  tick();
}

const actions: UiActions = {
  startFlight(plan: FlightPlan) {
    console.info('startFlight', plan);
    game.plan.value = plan;
    game.screen.value = 'briefing';
    game.loadProgress.value = 0;
    runProgress('flight', 3);
  },
  pause() {
    if (game.screen.value === 'flight') game.screen.value = 'paused';
  },
  resume() {
    if (game.screen.value === 'paused') game.screen.value = 'flight';
  },
  restart() {
    game.screen.value = 'briefing';
    game.loadProgress.value = 0;
    runProgress('flight', 1.5);
  },
  exitToMenu() {
    game.telemetry.value = null;
    game.levers.value = null;
    game.screen.value = 'menu';
  },
  toggleView() {
    game.view.value = game.view.value === 'outside' ? 'cockpit' : 'outside';
    message(game.view.value === 'cockpit' ? 'msg.viewCockpit' : 'msg.viewOutside');
  },
  preview(plan) {
    console.info('preview', plan);
  },
};

// The app's keyboard: Esc and P pause and resume, C changes the view, and flight keys.
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  const k = e.key.toLowerCase();
  if (k === 'escape' || k === 'p') {
    if (game.screen.value === 'flight') actions.pause();
    else if (game.screen.value === 'paused') actions.resume();
    return;
  }
  if (game.screen.value !== 'flight') return;
  keys.add(k);
  if (k === 'c') actions.toggleView();
  if (k === 'f') touchInput.flapsDown.value++;
  if (k === 'v') touchInput.flapsUp.value++;
  if (k === 'g') message('msg.gearFixed');
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// --- Mount and open the requested screen -------------------------------------------------------

mountUi(document.getElementById('ui')!, actions);

const flying: Partial<typeof sim> = {
  heading: 132,
  ias: 50.9,
  altitude: 1524,
  vs: 2.6,
  throttle: 0.78,
  flaps: 1 / 3,
  gear: 1,
  onGround: false,
  time: 754,
};
const defaultPlan: FlightPlan = {
  aircraft: 'c172',
  start: { kind: 'runway', airport: 'LSZB', runway: '14' },
  time: 'now',
  weather: 'fair',
  airport: 'LSZB',
};

if (q.get('view') === 'cockpit') game.view.value = 'cockpit';
if (q.has('live'))
  game.weather.value = {
    cloudCover: 0.4,
    cloudBase: 1650,
    cloudTop: 2600,
    visibility: 28000,
    windFromDeg: 235,
    windSpeed: 4.6,
    precipitation: 0,
    temperature: 14.2,
  };

switch (screenParam) {
  case 'loading':
    game.screen.value = 'loading';
    runProgress('menu', 2.5);
    break;
  case 'menu':
  case 'setup':
  case 'settings':
    game.screen.value = 'menu';
    if (screenParam === 'setup') nav.page.value = 'setup';
    if (screenParam === 'settings') nav.settingsOpen.value = true;
    break;
  case 'briefing':
    game.plan.value = q.has('live') ? { ...defaultPlan, weather: 'live' } : defaultPlan;
    game.screen.value = 'briefing';
    runProgress('flight', 6);
    break;
  case 'flight':
  case 'paused':
  case 'crash':
    game.plan.value = defaultPlan;
    startFeed(flying);
    if (screenParam === 'crash') sim.crashed = 'terrain';
    publish();
    game.screen.value = screenParam === 'paused' ? 'paused' : 'flight';
    if (q.get('msg')) message(q.get('msg')!);
    break;
}

// No global declaration: every demo page has its own shape of __demo.
(window as unknown as { __demo: unknown }).__demo = {
  game,
  touchInput,
  settings,
  nav,
  sim,
  AIRCRAFT,
};
