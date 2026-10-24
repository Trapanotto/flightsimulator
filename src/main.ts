import './styles.css';
import { StartScreen } from './ui/StartScreen';
import { type Lang, detectLang, t } from './i18n';
import type { World } from './world/World';
import type { WorldView } from './ui/WorldView';
import type { Hangar } from './hangar/Hangar';
import type { HangarView } from './ui/HangarView';
import type { FlightGame } from './game/FlightGame';
import type { FlightView } from './ui/FlightView';

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
  ui.hidden = false;
}

async function showSettings(currentLang: Lang) {
  const { openSettings } = await import('./ui/SettingsDialog');
  openSettings(currentLang, (s) => {
    world?.applySettings(s);
    if (game) game.controls.invertPitch = s.invertPitch;
  });
}

/** Creates the world once; explore and flight mode share it (and its tile cache). */
async function ensureWorld() {
  const { World } = await import('./world/World');
  const first = !world;
  world ??= new World(worldCanvas);
  if (import.meta.env.DEV || location.search.includes('debug'))
    (window as unknown as { __world: World }).__world = world;
  if (first) {
    world.init().catch((err) => {
      console.error(err);
      alert(String(err));
    });
  }
  return world;
}

async function openFlight(currentLang: Lang) {
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
  flightView = new FlightView(
    document.body,
    currentLang,
    w,
    game,
    closeFlight,
    () => void showSettings(currentLang),
  );
  w.start();
  game.start(FLIGHT_PLACES[0]!.place);
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
  ui.hidden = false;
}

async function openHangar(currentLang: Lang) {
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
  if (first) {
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
  ui.hidden = false;
}

if (!document.createElement('canvas').getContext('webgl2')) {
  ui.innerHTML = `<p class="fatal">${t(lang, 'status.webglMissing')}</p>`;
} else {
  new StartScreen(ui, lang, {
    fly: (l) => void openFlight(l),
    explore: (l) => void openWorld(l),
    hangar: (l) => void openHangar(l),
    settings: (l) => void showSettings(l),
  });
  if (location.hash === '#hangar') void openHangar(lang);
  if (location.hash === '#fly') void openFlight(lang);
}
