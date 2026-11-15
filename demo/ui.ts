/**
 * Demo of the interface without the 3D app: a painted stand-in for the scene, fake airports,
 * a fake flight and fake actions that move `game.screen` the way the app will.
 *
 * URL switches:
 *   screen=loading|menu|setup|briefing|flight|paused|settings|crash
 *   device=mobile   lang=de|en   bg=day|snow|night   view=cockpit   warn=stall|overspeed
 *   progress=0..1 (frozen loading/briefing progress)   still (frozen telemetry)
 *   noairports   noaircraft   live (briefing with a live weather report)   debug   msg=<text>
 *
 * Phase 3 (a fake cockpit, avionics, radio dialogue, checklists and failures):
 *   p3                       switch the fakes on (also on for flights started with ATC)
 *   panel=radio,checklist,stack,autopilot,switches   open panels
 *   checklist=approach|start  open a checklist     ap  autopilot engaged     off  avionics off
 *   annun=lowVolts,lowVacuum,…   lit annunciators     plan=ils|alps|cold   briefing plans
 *   collapsed  radio panel collapsed     tools  touch menu open     failures  pause list open
 *
 * Phase 4 (several types; see uiFleet.ts):
 *   fleet                    PC-12, A320 and F/A-18 join the Cessna (and all airports load)
 *   aircraft=pc12|a320|fa18  the type of the flight or briefing     screen=hangar  the hangar
 *   speedbrake=0..1  rev  sb and reverse levers     g=<n> alpha=<deg>  fighter readouts
 */
import { AIRPORTS as GEO_AIRPORTS, isPaved } from '@geo';
import {
  AIRCRAFT,
  type AircraftId,
  type AvionicsTelemetry,
  type FailureId,
  type SystemsTelemetry,
  type Telemetry,
  limitControl,
} from '@sim';
import {
  type AirportOption,
  type ChecklistView,
  type FlightPlan,
  type RadioMessage,
  type UiActions,
  game,
  mountUi,
  nav,
  panels,
  setLang,
  settings,
  status,
  touchInput,
} from '@ui';
import { CONTROLS, FLYING, engines, installFleet } from './uiFleet';

const q = new URLSearchParams(location.search);
const screenParam = q.get('screen') ?? 'loading';
const fleet = q.has('fleet') || q.has('aircraft');

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
if (fleet && !q.has('noaircraft')) installFleet();
/** The type of the demo's flight and briefing. */
const typeId: AircraftId = (['pc12', 'a320', 'fa18'] as const).includes(q.get('aircraft') as 'pc12')
  ? (q.get('aircraft') as AircraftId)
  : 'c172';
const typeInfo = () => AIRCRAFT.find((a) => a.id === (game.plan.value?.aircraft ?? typeId));

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
// With the fleet, every airport as the app offers them, with their runways (the eligibility
// of a type needs lengths and surfaces).
if (!q.has('noairports'))
  game.airports.value = fleet
    ? GEO_AIRPORTS.map((a) => ({
        icao: a.icao,
        name: a.name,
        lon: a.lon,
        lat: a.lat,
        elevation: a.elevation,
        runways: a.runways.flatMap((r) => r.ends.map((e) => e.ident)),
        strips: a.runways.map((r) => ({
          ends: r.ends.map((e) => e.ident),
          length: r.length,
          paved: isPaved(r.surface),
        })),
        military: a.military,
      }))
    : AIRPORTS;
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

  // A light aircraft on the apron, roughly where the app's menu camera shows it. In the
  // hangar the shown type flies in the free middle of the screen instead.
  const hangar = shownType !== null;
  const px = hangar ? w * 0.5 : w * 0.68;
  const py = hangar ? h * (w < h ? 0.34 : 0.46) : h * 0.74;
  const s = (Math.min(w, h) / 600) * (shownType === 'a320' ? 1.35 : shownType === 'c172' ? 0.8 : 1);
  if (shownType && shownType !== 'c172') {
    drawType(g, px, py, s, shownType, bg === 'night');
    return;
  }
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
/** A side view of a type, painted crudely enough to tell the four apart. */
function drawType(
  g: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
  type: AircraftId,
  night: boolean,
) {
  const body = night ? '#30363f' : type === 'fa18' ? '#8d969f' : '#f5f6f8';
  g.fillStyle = body;
  if (type === 'pc12') {
    g.beginPath();
    g.ellipse(px, py, 120 * s, 15 * s, 0, 0, Math.PI * 2);
    g.fill();
    g.fillRect(px - 10 * s, py + 4 * s, 120 * s, 7 * s);
    g.beginPath();
    g.moveTo(px - 100 * s, py - 8 * s);
    g.lineTo(px - 128 * s, py - 62 * s);
    g.lineTo(px - 112 * s, py - 62 * s);
    g.lineTo(px - 80 * s, py - 8 * s);
    g.fill();
    g.fillRect(px - 150 * s, py - 66 * s, 50 * s, 6 * s);
    g.fillStyle = '#c8202a';
    g.fillRect(px - 90 * s, py - 2 * s, 190 * s, 3 * s);
  } else if (type === 'a320') {
    g.beginPath();
    g.ellipse(px, py, 150 * s, 17 * s, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(px - 120 * s, py - 6 * s);
    g.lineTo(px - 150 * s, py - 66 * s);
    g.lineTo(px - 132 * s, py - 66 * s);
    g.lineTo(px - 90 * s, py - 6 * s);
    g.fill();
    g.fillStyle = night ? '#252a31' : '#d9dde3';
    g.beginPath();
    g.ellipse(px + 10 * s, py + 22 * s, 26 * s, 9 * s, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#c8202a';
    g.fillRect(px - 150 * s, py - 64 * s, 22 * s, 30 * s);
  } else {
    g.beginPath();
    g.moveTo(px + 120 * s, py);
    g.lineTo(px - 90 * s, py - 12 * s);
    g.lineTo(px - 120 * s, py - 4 * s);
    g.lineTo(px - 90 * s, py + 10 * s);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(px - 70 * s, py - 10 * s);
    g.lineTo(px - 104 * s, py - 56 * s);
    g.lineTo(px - 92 * s, py - 56 * s);
    g.lineTo(px - 40 * s, py - 10 * s);
    g.fill();
    g.beginPath();
    g.moveTo(px + 30 * s, py + 2 * s);
    g.lineTo(px - 60 * s, py + 26 * s);
    g.lineTo(px - 40 * s, py + 4 * s);
    g.fill();
  }
}

/** The type the hangar shows (`actions.showAircraft`), or null outside the hangar. */
let shownType: AircraftId | null = null;
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

// --- Phase 3 fakes: cockpit, avionics, radio, checklists ----------------------------------------

let p3 = q.has('p3');
const cockpit: Record<string, number> = {};
const controls = CONTROLS[typeId];
for (const s of controls) cockpit[s.id] = s.running ?? s.initial;
// An ILS approach to Zurich 14 tuned and identified.
Object.assign(cockpit, {
  com1Active: 125_950,
  com1Standby: 118_100,
  nav1Active: 108_300,
  nav1Standby: 110_500,
  obs1: 137,
  headingBug: 137,
  apAltitude: 4000,
  altimeterSetting: 1021,
});
if (q.has('off')) cockpit.avionics = 0;
const ap = {
  engaged: q.has('ap'),
  lateral: 'hdg' as 'roll' | 'hdg' | 'nav' | 'apr',
  lateralArmed: (q.has('ap') ? 'apr' : undefined) as 'nav' | 'apr' | undefined,
  vertical: (typeId === 'c172' ? 'alt' : 'flc') as 'pitch' | 'vs' | 'alt' | 'gs' | 'flc',
  verticalArmed: (q.has('ap') ? 'gs' : undefined) as 'alt' | 'gs' | undefined,
  vs: 500,
  // Phase 4: on the types that have them.
  yd: typeId !== 'c172',
  fd: typeId !== 'c172',
  athr: typeId === 'a320',
  speed: typeId === 'pc12' ? 160 : 250,
};
let identUntil = 0;
const failed = new Set<FailureId>();

function publishCockpit() {
  game.cockpit.value = { ...cockpit };
}

function setControl(id: string, value: number) {
  const s = controls.find((c) => c.id === id);
  if (!s) return;
  const before = cockpit[id] ?? 0;
  const v = limitControl(s, value);
  cockpit[id] = v;
  // Buttons act on the press, as the systems do.
  if (s.kind === 'button' && v === 1 && before === 0) {
    const swap = /^(com|nav)(\d)Swap$/.exec(id);
    if (swap) {
      const a = `${swap[1]}${swap[2]}Active`;
      const b = `${swap[1]}${swap[2]}Standby`;
      [cockpit[a], cockpit[b]] = [cockpit[b]!, cockpit[a]!];
      if (a === 'com1Active') radioTuned();
    }
    if (id === 'xpdrIdent') identUntil = sim.time + 18;
    if (id === 'apEngage') ap.engaged = !ap.engaged;
    if (id === 'apHdg') {
      ap.lateral = 'hdg';
      ap.lateralArmed = undefined;
    }
    if (id === 'apNav') ap.lateralArmed = 'nav';
    if (id === 'apApr') {
      ap.lateralArmed = 'apr';
      ap.verticalArmed = 'gs';
    }
    if (id === 'apAlt') ap.vertical = 'alt';
    if (id === 'apVs') ap.vertical = 'vs';
    if (id === 'apFlc') ap.vertical = 'flc';
    if (id === 'yawDamper') ap.yd = !ap.yd;
    if (id === 'flightDirector') ap.fd = !ap.fd;
    if (id === 'apAthr') ap.athr = !ap.athr;
    if (id === 'apVsUp' || id === 'apVsDown') {
      if (ap.vertical === 'flc') ap.speed += id === 'apVsUp' ? -1 : 1;
      else {
        ap.vertical = 'vs';
        ap.vs += id === 'apVsUp' ? 100 : -100;
      }
    }
  }
  publishCockpit();
  checklistTick();
}

function avionics(): AvionicsTelemetry {
  const powered = (cockpit.battery ?? 1) >= 1 && (cockpit.avionics ?? 1) >= 1;
  const t = sim.time;
  const nav = (n: 1 | 2) => {
    const f = cockpit[`nav${n}Active`]!;
    const ils = f === 108_300;
    const valid = powered && (ils || f === 110_500);
    return {
      frequency: f,
      standby: cockpit[`nav${n}Standby`]!,
      valid,
      ident: valid ? (ils ? 'IZH' : 'ZUE') : '',
      localizer: ils,
      course: cockpit[`obs${n}`] ?? 0,
      deviation: valid ? Math.sin(t * 0.3) * 0.32 : 0,
      toFrom: (valid ? 'to' : 'off') as 'to' | 'off',
      bearing: valid ? 137 : undefined,
      glideSlope: valid && ils ? Math.cos(t * 0.21) * 0.4 : undefined,
    };
  };
  const nav1 = nav(1);
  return {
    powered,
    com1: { active: cockpit.com1Active!, standby: cockpit.com1Standby! },
    com2: { active: cockpit.com2Active!, standby: cockpit.com2Standby! },
    nav1,
    nav2: nav(2),
    dme: {
      source: 'nav1',
      distanceNm: nav1.valid ? 7.4 : undefined,
      groundSpeedKt: nav1.valid ? 92 : undefined,
      minutes: nav1.valid ? 5 : undefined,
    },
    adf: {
      frequency: cockpit.adfFrequency ?? 0,
      valid: false,
      ident: '',
      relativeBearing: undefined,
    },
    transponder: {
      code: cockpit.xpdrCode!,
      mode: (['off', 'standby', 'on', 'alt'] as const)[cockpit.xpdrMode!] ?? 'off',
      ident: sim.time < identUntil,
      reply: powered && Math.floor(t) % 4 === 0,
    },
    markers: { outer: false, middle: false, inner: false },
    autopilot: {
      engaged: ap.engaged,
      lateral: ap.lateral,
      lateralArmed: ap.lateralArmed,
      vertical: ap.vertical,
      verticalArmed: ap.verticalArmed,
      selectedAltitude: cockpit.apAltitude!,
      selectedVerticalSpeed: ap.vs,
      disconnectWarning: false,
      ...(typeId === 'c172'
        ? {}
        : {
            yawDamper: controls.some((c) => c.id === 'yawDamper') ? ap.yd : undefined,
            flightDirector: ap.fd ? { pitch: 0.03, bank: -0.05 } : undefined,
            selectedSpeed: ap.speed,
            autothrottle:
              typeId === 'a320'
                ? { engaged: ap.athr, mode: ap.athr ? ('speed' as const) : ('off' as const) }
                : undefined,
          }),
    },
    gps: {
      plan: [],
      active: -1,
      distanceNm: undefined,
      bearing: undefined,
      desiredTrack: undefined,
      crossTrackNm: undefined,
      groundSpeedKt: 92,
      track: sim.heading,
      lon: 8.4,
      lat: 47.55,
    },
  };
}

function systems(): SystemsTelemetry {
  const lit = new Set((q.get('annun') ?? '').split(',').filter(Boolean));
  return {
    busVolts: 28,
    batteryAmps: 2,
    batteryCharge: 1,
    avionicsPowered: true,
    fuelLeft: 70,
    fuelRight: 70,
    fuelAvailable: true,
    vacuum: failed.has('vacuum') ? 0 : 5,
    oilTemperature: 90,
    oilPressure: 60,
    egt: 0.8,
    carbIce: 0,
    airframeIce: 0,
    pitotBlocked: failed.has('pitot'),
    lights: { beacon: false, landing: false, taxi: false, nav: false, strobe: false },
    panelLight: 0,
    annunciators: {
      lowVolts: lit.has('lowVolts') || failed.has('alternator'),
      lowFuelLeft: lit.has('lowFuelLeft') || failed.has('fuelLeak'),
      lowFuelRight: lit.has('lowFuelRight'),
      lowVacuum: lit.has('lowVacuum') || failed.has('vacuum'),
      oilPressure: lit.has('oilPressure'),
    },
  };
}

// The radio: a short ILS approach into Zurich, step by step.
const de = () => document.documentElement.lang === 'de';
interface RadioStep {
  atc: string;
  station: string;
  options: { id: string; text: string }[];
  hint?: string;
  /** The next step waits for COM 1 on this frequency. */
  waitFor?: number;
}
const RADIO: RadioStep[] = [
  {
    station: 'Zürich Arrival',
    atc: 'HB-TFS, Zurich Arrival, radar contact. Descend to 4000 feet, QNH 1021, cleared ILS approach runway 14, report established.',
    options: [
      { id: 'ack', text: 'Descend 4000 feet, QNH 1021, cleared ILS 14, wilco, HB-TFS' },
      { id: 'again', text: 'Say again, HB-TFS' },
    ],
  },
  {
    station: 'Zürich Arrival',
    atc: 'HB-TFS, contact Zurich Tower 118.100.',
    options: [{ id: 'ack', text: 'Tower 118.100, HB-TFS' }],
    hint: 'Zürich Tower 118.100',
    waitFor: 118_100,
  },
  {
    station: 'Zürich Tower',
    atc: 'HB-TFS, Zurich Tower, wind 050 degrees 3 knots, runway 14, cleared to land.',
    options: [{ id: 'ack', text: 'Cleared to land runway 14, HB-TFS' }],
  },
];
let radioStep = 0;
let waiting: number | null = null;
const log: RadioMessage[] = [
  {
    from: 'pilot',
    station: 'Zürich Arrival',
    text: 'Zurich Arrival, HB-TFS, Cessna 172, 12 miles northwest, 5000 feet, information Kilo, request ILS 14.',
    time: 700,
  },
];

function publishAtc(options: { id: string; text: string }[], hint: string | null) {
  const station = cockpit.com1Active === 118_100 ? 'Zürich Tower' : 'Zürich Arrival';
  game.atc.value = {
    station: cockpit.avionics ? station : null,
    frequency: cockpit.com1Active!,
    log: [...log],
    options,
    hint,
  };
}

function atcSays(i: number) {
  const s = RADIO[i];
  if (!s) return publishAtc([], null);
  log.push({ from: 'atc', station: s.station, text: s.atc, time: sim.time });
  publishAtc(s.options, s.hint ?? null);
}

function atcReply(id: string) {
  const s = RADIO[radioStep];
  const o = s?.options.find((x) => x.id === id);
  if (!s || !o) return;
  log.push({ from: 'pilot', station: s.station, text: o.text, time: sim.time });
  if (id === 'again') {
    publishAtc([], null);
    setTimeout(() => atcSays(radioStep), 1200);
    return;
  }
  radioStep++;
  if (s.waitFor) {
    waiting = s.waitFor;
    publishAtc([], s.hint ?? null);
    if (cockpit.com1Active === s.waitFor) radioTuned();
    return;
  }
  publishAtc([], null);
  setTimeout(() => atcSays(radioStep), 1500);
}

function radioTuned() {
  if (waiting === null || cockpit.com1Active !== waiting)
    return publishAtc(game.atc.value?.options ?? [], game.atc.value?.hint ?? null);
  waiting = null;
  publishAtc([], null);
  setTimeout(() => atcSays(radioStep), 1200);
}

// Checklists: the app ticks what it can see; the rest is ticked by hand.
interface CheckDef {
  label: [string, string];
  expect: [string, string];
  control?: string;
  value?: number;
}
const CHECKLISTS: Record<string, { title: [string, string]; items: CheckDef[] }> = {
  start: {
    title: ['Vor dem Anlassen', 'Before starting engine'],
    items: [
      {
        label: ['Sicherheitsgurte und Schultergurte', 'Seats and seat belts'],
        expect: ['Geschlossen', 'Secure'],
      },
      {
        label: ['Brandhahn', 'Fuel shutoff valve'],
        expect: ['Offen', 'On'],
        control: 'fuelShutoff',
        value: 1,
      },
      {
        label: ['Tankwahlschalter', 'Fuel selector'],
        expect: ['Beide', 'Both'],
        control: 'fuelSelector',
        value: 1,
      },
      {
        label: ['Avionik', 'Avionics switch'],
        expect: ['Aus', 'Off'],
        control: 'avionics',
        value: 0,
      },
      { label: ['Batterie', 'Battery'], expect: ['Ein', 'On'], control: 'battery', value: 1 },
      { label: ['Beacon', 'Beacon'], expect: ['Ein', 'On'], control: 'lightBeacon', value: 1 },
    ],
  },
  approach: {
    title: ['Anflug', 'Approach'],
    items: [
      {
        label: ['ATIS und QNH', 'ATIS and altimeter'],
        expect: ['Erhalten, gesetzt', 'Received, set'],
      },
      {
        label: ['Tankwahlschalter', 'Fuel selector'],
        expect: ['Beide', 'Both'],
        control: 'fuelSelector',
        value: 1,
      },
      { label: ['Gemisch', 'Mixture'], expect: ['Reich', 'Rich'], control: 'mixture', value: 1 },
      { label: ['Vergaservorwärmung', 'Carburettor heat'], expect: ['Nach Bedarf', 'As required'] },
      {
        label: ['Landescheinwerfer', 'Landing light'],
        expect: ['Ein', 'On'],
        control: 'lightLanding',
        value: 1,
      },
      {
        label: ['Höhenmessereinstellung kontrolliert', 'Altimeter setting cross-checked'],
        expect: ['1021', '1021'],
      },
      { label: ['Landeklappen', 'Flaps'], expect: ['Nach Bedarf', 'As required'] },
    ],
  },
  landing: {
    title: ['Vor der Landung', 'Before landing'],
    items: [
      { label: ['Gemisch', 'Mixture'], expect: ['Reich', 'Rich'], control: 'mixture', value: 1 },
      { label: ['Landeklappen', 'Flaps'], expect: ['30°', '30°'], control: 'flaps', value: 3 },
    ],
  },
};
let openList: string | null = null;
let doneCount = 0;

function publishChecklist() {
  const c = openList ? CHECKLISTS[openList] : undefined;
  const l = de() ? 0 : 1;
  game.checklists.value = Object.entries(CHECKLISTS).map(([id, c]) => ({ id, title: c.title[l] }));
  if (!c || !openList) {
    game.checklist.value = null;
    return;
  }
  const view: ChecklistView = {
    id: openList,
    title: c.title[l],
    items: c.items.map((it, i) => ({
      label: it.label[l],
      expect: it.expect[l],
      state: i < doneCount ? 'done' : i === doneCount ? 'current' : 'todo',
      control: it.control,
    })),
  };
  game.checklist.value = view;
}

function checklistTick() {
  const c = openList ? CHECKLISTS[openList] : undefined;
  let moved = false;
  while (c) {
    const it = c.items[doneCount];
    if (!it?.control || cockpit[it.control] !== it.value) break;
    doneCount++;
    moved = true;
  }
  if (moved) publishChecklist();
}

function startP3() {
  p3 = true;
  game.controls.value = controls;
  publishCockpit();
  atcSays(0);
  publishChecklist();
  game.failures.value = [];
  game.frequencies.value = [
    { name: 'Zürich ATIS', frequency: 128_525 },
    { name: 'Zürich Arrival', frequency: 125_950 },
    { name: 'Zürich Tower', frequency: 118_100 },
    { name: 'ILS 14 IZH', frequency: 108_300 },
  ];
}

function stopP3() {
  game.controls.value = [];
  game.cockpit.value = null;
  game.atc.value = null;
  game.checklists.value = [];
  game.checklist.value = null;
}

/** Speed brake and reverse of the fake flight: the URL's, then the keys' and the touch levers'. */
const levers4 = { speedbrake: Number(q.get('speedbrake') ?? 0), reverse: q.has('rev') };

function telemetry(): Telemetry {
  const warn = q.get('warn');
  const info = typeInfo();
  const id = info?.id ?? 'c172';
  const jet = id === 'a320' || id === 'fa18';
  // Mach follows the airspeed the way it does at the fake flight's height.
  const machPerMs = (FLYING[id].mach ?? 0) / FLYING[id].ias;
  const ias = warn === 'overspeed' ? (info?.vne ?? 84) * 1.03 : sim.ias;
  return {
    time: sim.time,
    ias,
    tas: sim.ias,
    groundSpeed: sim.ias,
    altitude: sim.altitude,
    agl: sim.altitude - 510,
    verticalSpeed: sim.vs,
    headingDeg: sim.heading,
    trackDeg: sim.heading,
    pitch: 0,
    bank: 0,
    alpha: (Number(q.get('alpha') ?? (id === 'fa18' ? 4.2 : 2)) * Math.PI) / 180,
    beta: 0,
    loadFactor: Number(q.get('g') ?? 1),
    onGround: sim.onGround,
    stallWarning: warn === 'stall' || (!sim.onGround && sim.ias < 24),
    flaps: sim.flaps,
    gear: sim.gear,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    engines: engines(id, sim.throttle, levers4.reverse),
    fuel: 120,
    crashed: sim.crashed,
    ...(jet || id === 'pc12' ? { mach: ias * machPerMs || ias / 340 } : {}),
    ...(info?.speedbrake ? { speedbrake: levers4.speedbrake } : {}),
    ...(p3 ? { avionics: avionics(), systems: systems() } : {}),
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
    ...(typeInfo()?.speedbrake ? { speedbrake: levers4.speedbrake } : {}),
    ...(typeInfo()?.reverse ? { reverse: levers4.reverse } : {}),
  };
}

let lastSpeedbrake = touchInput.speedbrake.value;
let lastGear = touchInput.gearToggle.value;
let gearAnim = 0;

/** Retractable types move their gear over a few seconds; the Cessna's stays. */
function toggleGear() {
  if (!typeInfo()?.retractableGear) return message('msg.gearFixed');
  const target = sim.gear > 0.5 ? 0 : 1;
  message(target ? 'msg.gearDown' : 'msg.gearUp');
  cancelAnimationFrame(gearAnim);
  const from = sim.gear;
  const t0 = performance.now();
  const tick = () => {
    const f = Math.min(1, (performance.now() - t0) / 6000);
    sim.gear = from + (target - from) * f;
    if (f < 1) gearAnim = requestAnimationFrame(tick);
  };
  tick();
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
  // Phase 4 levers: the keys the app will bind (J/M, H held) and the touch controls.
  if (touchInput.speedbrake.value !== null && touchInput.speedbrake.value !== lastSpeedbrake)
    levers4.speedbrake = touchInput.speedbrake.value;
  lastSpeedbrake = touchInput.speedbrake.value;
  levers4.speedbrake = Math.max(0, Math.min(1, levers4.speedbrake + key('j', 'm') * dt * 0.8));
  if (!q.has('rev')) levers4.reverse = touchInput.reverse.value || keys.has('h');
  if (touchInput.gearToggle.value !== lastGear) {
    lastGear = touchInput.gearToggle.value;
    toggleGear();
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
    if (q.has('p3') || plan.atc) startP3();
    runProgress('flight', 3);
  },
  setControl,
  atcReply,
  openChecklist(id) {
    openList = id;
    doneCount = 0;
    publishChecklist();
    checklistTick();
  },
  checkItem() {
    doneCount++;
    publishChecklist();
    checklistTick();
  },
  setFailure(id, on) {
    if (on) failed.add(id);
    else failed.delete(id);
    game.failures.value = [...failed];
    if (id === 'com1') game.message.value = on ? 'COM 1 failed' : null;
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
    stopP3();
    p3 = q.has('p3');
  },
  toggleView() {
    game.view.value = game.view.value === 'outside' ? 'cockpit' : 'outside';
    message(game.view.value === 'cockpit' ? 'msg.viewCockpit' : 'msg.viewOutside');
  },
  preview(plan) {
    console.info('preview', plan);
  },
  showAircraft(id) {
    console.info('showAircraft', id);
    shownType = id;
    paint();
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
  if (k === 'g') toggleGear();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// --- Mount and open the requested screen -------------------------------------------------------

mountUi(document.getElementById('ui')!, actions);

const flying: Partial<typeof sim> = {
  heading: 132,
  ias: FLYING[typeId].ias,
  altitude: FLYING[typeId].altitude,
  vs: 2.6,
  throttle: FLYING[typeId].throttle,
  flaps: FLYING[typeId].flaps,
  gear: FLYING[typeId].gear,
  onGround: false,
  time: 754,
};
const defaultPlan: FlightPlan = {
  aircraft: typeId,
  start: { kind: 'runway', airport: 'LSZB', runway: '14' },
  time: 'now',
  weather: 'fair',
  airport: 'LSZB',
};

const BRIEFING_PLANS: Record<string, FlightPlan> = {
  ils: {
    aircraft: typeId,
    start: { kind: 'approach', airport: 'LSZH', runway: '14', distanceNm: 10 },
    time: 9,
    weather: 'lowStratus',
    season: 'autumn',
    airport: 'LSZH',
    destination: { airport: 'LSZH', runway: '14' },
    atc: true,
    coldStart: false,
    failures: [{ id: 'vacuum', after: 'random' }],
  },
  alps: {
    aircraft: typeId,
    start: { kind: 'runway', airport: 'LSZB', runway: '14' },
    time: 9,
    weather: 'clear',
    season: 'summer',
    airport: 'LSZB',
    destination: { airport: 'LSZS', runway: '21' },
    route: [
      { ident: 'INTERLAKEN', lon: 7.86, lat: 46.68 },
      { ident: 'GRIMSEL', lon: 8.33, lat: 46.56 },
      { ident: 'JULIER', lon: 9.73, lat: 46.47 },
    ],
    atc: true,
    coldStart: true,
    failures: [],
  },
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
  case 'hangar':
  case 'settings':
    game.screen.value = 'menu';
    if (screenParam === 'setup') nav.page.value = 'setup';
    if (screenParam === 'hangar') nav.page.value = 'hangar';
    if (screenParam === 'settings') nav.settingsOpen.value = true;
    break;
  case 'briefing':
    game.plan.value = q.has('live')
      ? { ...defaultPlan, weather: 'live' }
      : (BRIEFING_PLANS[q.get('plan') ?? ''] ?? defaultPlan);
    if (p3) startP3();
    game.screen.value = 'briefing';
    runProgress('flight', 6);
    break;
  case 'flight':
  case 'paused':
  case 'crash':
    game.plan.value = defaultPlan;
    if (p3) {
      startP3();
      // The dialogue as it stands a few calls in.
      if (q.has('collapsed')) panels.radioCollapsed.value = true;
      if (q.get('checklist')) {
        openList = q.get('checklist');
        doneCount = 2;
        publishChecklist();
      }
      for (const id of q.get('fail')?.split(',') ?? []) actions.setFailure?.(id as FailureId, true);
    }
    startFeed(flying);
    if (screenParam === 'crash') sim.crashed = 'terrain';
    publish();
    game.screen.value = screenParam === 'paused' ? 'paused' : 'flight';
    if (q.get('panel')) panels.open.value = q.get('panel')!.split(',') as typeof panels.open.value;
    if (q.has('tools')) panels.toolsOpen.value = true;
    if (q.get('msg')) message(q.get('msg')!);
    break;
}

// No global declaration: every demo page has its own shape of __demo.
(window as unknown as { __demo: unknown }).__demo = {
  game,
  touchInput,
  settings,
  nav,
  panels,
  sim,
  AIRCRAFT,
};
