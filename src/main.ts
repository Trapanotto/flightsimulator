import './styles.css';
import { StartScreen } from './ui/StartScreen';
import { PLACES } from './world/places';
import { type Lang, detectLang, t } from './i18n';
import type { World } from './world/World';
import type { WorldView } from './ui/WorldView';
import type { Hangar } from './hangar/Hangar';
import type { HangarView } from './ui/HangarView';
import type { FlightGame } from './game/FlightGame';
import type { FlightView } from './ui/FlightView';
import type { Showcase } from './game/Showcase';
import { type Course, courseById } from './game/challenges';
import { findAircraft } from './aircraft/types';

// Tile cache for repeat visits (public/sw.js); only in the built site.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    .catch((err) => console.warn('tile cache', err));
}

const lang = detectLang();
document.documentElement.lang = lang;

const worldCanvas = document.querySelector<HTMLCanvasElement>('#world')!;
const hangarCanvas = document.querySelector<HTMLCanvasElement>('#hangar')!;
const ui = document.querySelector<HTMLElement>('#ui')!;

let world: World | undefined;
let view: WorldView | undefined;
let hangar: Hangar | undefined;
let hangarView: HangarView | undefined;
let game: FlightGame | undefined;
let flightView: FlightView | undefined;

async function openWorld(currentLang: Lang) {
  const wasShowing = !!showcase;
  stopShowcase();
  ui.hidden = true;
  worldCanvas.hidden = false;

  // The 3D engine is loaded on demand so the menu appears fast.
  const [, { WorldView }] = await Promise.all([import('./world/World'), import('./ui/WorldView')]);
  const w = await ensureWorld();
  view = new WorldView(
    document.body,
    currentLang,
    w,
    closeWorld,
    () => void showSettings(currentLang),
  );
  if (wasShowing) w.goTo(PLACES[3]!);
  w.start();
  // ?route starts the Geneva -> St. Moritz test flight right away (optionally ?route=900 km/h).
  const route = new URLSearchParams(location.search).get('route');
  if (route !== null) w.startRoute(Number(route) || 500);
}

function closeWorld() {
  world?.stop();
  view?.destroy();
  view = undefined;
  worldCanvas.hidden = true;
  menuShown();
}

async function showSettings(currentLang: Lang) {
  const { openSettings } = await import('./ui/SettingsDialog');
  openSettings(currentLang, (s) => {
    world?.applySettings(s);
    if (game) {
      game.controls.invertPitch = s.invertPitch;
      game.setSound(s.sound, s.volume);
    }
  });
}

/** Creates the world once; explore and flight mode share it (and its tile cache). */
async function ensureWorld() {
  const { World } = await import('./world/World');
  const first = !world;
  world ??= new World(worldCanvas);
  if (import.meta.env.DEV || /debug|capture/.test(location.search))
    (window as unknown as { __world: World }).__world = world;
  if (first) {
    world.init().catch((err) => {
      console.error(err);
      alert(String(err));
    });
  }
  return world;
}

// ---- animated start screen: the fleet over the Alps behind the menu ----

/** The menu runs over the live 3D scene (else the still image), not with reduced motion. */
function liveMenu() {
  return !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let showcase: Showcase | undefined;
let showcaseToken = 0;

/** Live 3D background for the menu (not on reduced motion or weak/mobile GPUs). */
async function startShowcase() {
  if (showcase) return;
  if (!liveMenu()) {
    ui.classList.remove('loading');
    return;
  }
  ui.classList.add('loading');
  ui.style.setProperty('--progress', '0');
  const token = ++showcaseToken;
  const [{ Showcase }, { World }] = await Promise.all([
    import('./game/Showcase'),
    import('./world/World'),
  ]);
  void World;
  const w = await ensureWorld();
  if (token !== showcaseToken || ui.hidden) return;
  if (w.qualityLevel === 'low') {
    ui.classList.remove('loading');
    return;
  }
  const s = new Showcase(w);
  showcase = s;
  // State on #ui (not .start): the start screen re-renders on a language switch.
  s.onProgress = (p) => ui.style.setProperty('--progress', p.toFixed(3));
  s.onReady = () => {
    ui.classList.remove('loading');
    ui.classList.add('live');
  };
  s.onCut = () => {
    ui.classList.remove('cut');
    void ui.offsetWidth;
    ui.classList.add('cut');
  };
  w.game = s;
  worldCanvas.hidden = false;
  w.start();
  // ?capture: the recording script steps the showcase frame by frame.
  if (location.search.includes('capture'))
    (window as unknown as { __showcase: Showcase }).__showcase = s;
}

/** Ends the menu background before another mode takes over the world. */
function stopShowcase() {
  showcaseToken++;
  if (!showcase) return;
  showcase.dispose();
  showcase = undefined;
  ui.classList.remove('live', 'cut', 'loading');
  if (world) {
    world.stop();
    world.game = undefined;
  }
  worldCanvas.hidden = true;
}

/** Back in the menu: let the fleet fly again. */
function menuShown() {
  ui.hidden = false;
  // The loader covers the menu until the live scene is back.
  if (liveMenu()) ui.classList.add('loading');
  setTimeout(() => void startShowcase(), 400);
}

async function openFlight(currentLang: Lang, course?: Course) {
  stopShowcase();
  ui.hidden = true;
  worldCanvas.hidden = false;
  const [{ FlightGame }, { FlightView, FLIGHT_PLACES }] = await Promise.all([
    import('./game/FlightGame'),
    import('./ui/FlightView'),
  ]);
  const w = await ensureWorld();
  game = new FlightGame(w);
  if (import.meta.env.DEV || location.search.includes('debug'))
    (window as unknown as { __game: FlightGame }).__game = game;
  w.game = game;
  game.controls.invertPitch = w.settings.invertPitch;
  game.setSound(w.settings.sound, w.settings.volume);
  flightView = new FlightView(
    document.body,
    currentLang,
    w,
    game,
    closeFlight,
    () => void showSettings(currentLang),
  );
  w.start();
  if (course) game.startChallenge(course);
  else game.start(FLIGHT_PLACES[0]!.place);
  game.load().catch((err) => console.error(err));
}

function closeFlight() {
  flightView?.destroy();
  flightView = undefined;
  if (world) {
    world.stop();
    world.game = undefined;
  }
  game?.dispose();
  game = undefined;
  if (document.pointerLockElement) document.exitPointerLock();
  worldCanvas.hidden = true;
  menuShown();
}

async function openHangar(currentLang: Lang) {
  stopShowcase();
  ui.hidden = true;
  hangarCanvas.hidden = false;
  const [{ Hangar }, { HangarView }] = await Promise.all([
    import('./hangar/Hangar'),
    import('./ui/HangarView'),
  ]);
  const first = !hangar;
  hangar ??= new Hangar(hangarCanvas);
  if (import.meta.env.DEV || location.search.includes('debug'))
    (window as unknown as { __hangar: Hangar }).__hangar = hangar;
  hangarView = new HangarView(document.body, currentLang, hangar, closeHangar);
  hangar.start();
  if (first && location.hash === '#buildings') {
    hangar.showBuildings().catch((err) => console.error(err));
  } else if (first) {
    hangar.load().catch((err) => {
      console.error(err);
      alert(String(err));
    });
  }
}

function closeHangar() {
  hangar?.stop();
  hangarView?.destroy();
  hangarView = undefined;
  hangarCanvas.hidden = true;
  menuShown();
}

if (!document.createElement('canvas').getContext('webgl2')) {
  ui.innerHTML = `<p class="fatal">${t(lang, 'status.webglMissing')}</p>`;
} else {
  new StartScreen(ui, lang, {
    fly: (l) => void openFlight(l),
    explore: (l) => void openWorld(l),
    hangar: (l) => void openHangar(l),
    settings: (l) => void showSettings(l),
    challenge: (l, c) => void openFlight(l, c),
  });
  if (location.hash === '#hangar' || location.hash === '#buildings') void openHangar(lang);
  if (location.hash === '#fly') void openFlight(lang);
  // #challenge=lauterbrunnen starts a course directly (tests, links).
  const course = courseById(location.hash.match(/^#challenge=([\w-]+)/)?.[1] ?? '');
  if (course && findAircraft(course.aircraft)) void openFlight(lang, course);
  if (!location.hash) {
    // Loading screen right away (no flash of the menu over the still image).
    if (liveMenu()) ui.classList.add('loading');
    setTimeout(() => void startShowcase(), 300);
  }
}
