import { ATTRIBUTION } from '../core/config';
import { type Lang, t } from '../i18n';
import type { World, WorldStats } from '../world/World';

/** Overlay for the 3D view: back button, load progress, controls hint and F3 debug panel. */
export class WorldView {
  readonly el: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressWrap: HTMLElement;
  private readonly debug: HTMLElement;
  private debugTimer = 0;

  constructor(
    parent: HTMLElement,
    lang: Lang,
    private readonly world: World,
    onBack: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'world-ui';
    this.el.innerHTML = `
      <button class="btn btn-small back">← ${t(lang, 'view.back')}</button>
      <div class="progress" role="progressbar" aria-label="${t(lang, 'view.loading')}">
        <span class="progress-label">${t(lang, 'view.loading')}</span>
        <span class="progress-track"><span class="progress-bar"></span></span>
      </div>
      <p class="hint">${t(lang, 'view.help')}</p>
      <span class="attribution world-attribution">${ATTRIBUTION}</span>
      <pre class="debug" hidden></pre>
    `;
    parent.appendChild(this.el);
    this.progressBar = this.el.querySelector('.progress-bar')!;
    this.progressWrap = this.el.querySelector('.progress')!;
    this.debug = this.el.querySelector('.debug')!;
    this.el.querySelector('.back')!.addEventListener('click', onBack);
    window.addEventListener('keydown', this.onKey);
    if (import.meta.env.DEV || location.search.includes('debug')) this.toggleDebug(true);
  }

  setProgress(loaded: number, total: number) {
    const p = total ? loaded / total : 0;
    this.progressBar.style.transform = `scaleX(${p})`;
    this.progressWrap.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    if (loaded >= total) this.progressWrap.classList.add('done');
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey);
    clearInterval(this.debugTimer);
    this.el.remove();
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'F3') {
      e.preventDefault();
      this.toggleDebug(this.debug.hidden);
    }
  };

  private toggleDebug(show: boolean) {
    this.debug.hidden = !show;
    clearInterval(this.debugTimer);
    if (show) {
      this.debugTimer = window.setInterval(
        () => (this.debug.textContent = format(this.world.stats())),
        250,
      );
    }
  }
}

function format(s: WorldStats): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return [
    `FPS       ${s.fps.toFixed(0)}  (${s.frameMs.toFixed(1)} ms)`,
    `Draws     ${s.calls}`,
    `Tris      ${k(s.triangles)}`,
    `GPU       ${s.geometries} geo · ${s.textures} tex`,
    `Tiles     ${s.tilesLoaded}/${s.tilesTotal}${s.tilesFailed ? ` (${s.tilesFailed} err)` : ''}`,
    `Requests  ${s.requestsInFlight} active · ${s.queued} queued`,
    `Höhe      ${s.altitude.toFixed(0)} m`,
    `LV95      ${s.lv95[0].toFixed(0)} / ${s.lv95[1].toFixed(0)}`,
    `Depth     ${s.reversedDepth ? 'reversed-Z' : 'logarithmic'}`,
  ].join('\n');
}
