import './styles.css';
import { Backdrop } from './render/Backdrop';
import { StartScreen } from './ui/StartScreen';
import { detectLang, t } from './i18n';

const lang = detectLang();
document.documentElement.lang = lang;

const canvas = document.querySelector<HTMLCanvasElement>('#backdrop')!;
const ui = document.querySelector<HTMLElement>('#ui')!;

if (!document.createElement('canvas').getContext('webgl2')) {
  ui.innerHTML = `<p class="fatal">${t(lang, 'status.webglMissing')}</p>`;
} else {
  new Backdrop(canvas).start();
  new StartScreen(ui, lang);
}
