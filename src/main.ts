import './styles.css';
import { App } from './app/App';
import { Ui } from './ui/ui';

function supportsWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

function fatal(message: string) {
  const error = document.getElementById('error');
  const text = document.getElementById('error-message');
  const loading = document.getElementById('loading');
  if (text) text.textContent = message;
  error?.classList.remove('hidden');
  loading?.classList.add('is-hidden');
}

const canvas = document.querySelector<HTMLCanvasElement>('#scene');

if (!canvas) {
  fatal('Das Render-Canvas fehlt. Bitte lade die Seite neu.');
} else if (!supportsWebGL2()) {
  fatal(
    'WebGL2 wird benötigt. Bitte aktualisiere deinen Browser oder aktiviere die Hardware-Beschleunigung.',
  );
} else {
  const ui = new Ui();
  ui.onRetry(() => location.reload());

  const app = new App(canvas, ui);
  window.tfs = { app, version: '0.1.0' };

  app.init().catch((error: unknown) => {
    console.error(error);
    fatal(
      `Die Welt-Engine konnte nicht gestartet werden: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}
