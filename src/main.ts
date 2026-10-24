import './styles.css';
import { Backdrop } from './render/Backdrop';
import { StartScreen } from './ui/StartScreen';
import { type Lang, detectLang, t } from './i18n';
import type { World } from './world/World';
import type { WorldView } from './ui/WorldView';

const lang = detectLang();
document.documentElement.lang = lang;

const backdropCanvas = document.querySelector<HTMLCanvasElement>('#backdrop')!;
const worldCanvas = document.querySelector<HTMLCanvasElement>('#world')!;
const ui = document.querySelector<HTMLElement>('#ui')!;

let world: World | undefined;
let view: WorldView | undefined;

async function openWorld(currentLang: Lang) {
  backdrop.stop();
  backdropCanvas.hidden = true;
  ui.hidden = true;
  worldCanvas.hidden = false;

  // The 3D engine is loaded on demand so the menu appears fast.
  const [{ World }, { WorldView }] = await Promise.all([
    import('./world/World'),
    import('./ui/WorldView'),
  ]);
  const first = !world;
  world ??= new World(worldCanvas);
  if (import.meta.env.DEV) (window as unknown as { __world: World }).__world = world;
  view = new WorldView(document.body, currentLang, world, closeWorld);
  world.start();
  if (first) {
    const v = view;
    world
      .init((loaded, total) => v.setProgress(loaded, total))
      .catch((err) => {
        console.error(err);
        alert(String(err));
      });
  } else {
    view.setProgress(1, 1);
  }
}

function closeWorld() {
  world?.stop();
  view?.destroy();
  view = undefined;
  worldCanvas.hidden = true;
  backdropCanvas.hidden = false;
  ui.hidden = false;
  backdrop.start();
}

const backdrop = new Backdrop(backdropCanvas);

if (!document.createElement('canvas').getContext('webgl2')) {
  ui.innerHTML = `<p class="fatal">${t(lang, 'status.webglMissing')}</p>`;
} else {
  backdrop.start();
  new StartScreen(ui, lang, (l) => void openWorld(l));
}
