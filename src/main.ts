import './styles.css';
import { StartScreen } from './ui/StartScreen';
import { type Lang, detectLang, t } from './i18n';
import type { World } from './world/World';
import type { WorldView } from './ui/WorldView';
import type { Hangar } from './hangar/Hangar';
import type { HangarView } from './ui/HangarView';

const lang = detectLang();
document.documentElement.lang = lang;

const worldCanvas = document.querySelector<HTMLCanvasElement>('#world')!;
const hangarCanvas = document.querySelector<HTMLCanvasElement>('#hangar')!;
const ui = document.querySelector<HTMLElement>('#ui')!;

let world: World | undefined;
let view: WorldView | undefined;
let hangar: Hangar | undefined;
let hangarView: HangarView | undefined;

async function openWorld(currentLang: Lang) {
  ui.hidden = true;
  worldCanvas.hidden = false;

  // The 3D engine is loaded on demand so the menu appears fast.
  const [{ World }, { WorldView }] = await Promise.all([
    import('./world/World'),
    import('./ui/WorldView'),
  ]);
  const first = !world;
  world ??= new World(worldCanvas);
  if (import.meta.env.DEV || location.search.includes('debug'))
    (window as unknown as { __world: World }).__world = world;
  view = new WorldView(document.body, currentLang, world, closeWorld);
  world.start();
  if (first) {
    world.init().catch((err) => {
      console.error(err);
      alert(String(err));
    });
  }
  // ?route starts the Geneva -> St. Moritz test flight right away (optionally ?route=900 km/h).
  const route = new URLSearchParams(location.search).get('route');
  if (route !== null) world.startRoute(Number(route) || 500);
}

function closeWorld() {
  world?.stop();
  view?.destroy();
  view = undefined;
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
    explore: (l) => void openWorld(l),
    hangar: (l) => void openHangar(l),
  });
  if (location.hash === '#hangar') void openHangar(lang);
}
