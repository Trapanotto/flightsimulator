import { ATTRIBUTION } from '../core/config';
import { type Lang, t } from '../i18n';
import { PLACES } from '../world/places';
import type { World, WorldStats } from '../world/World';

/** Overlay for the 3D view: instruments, places, test flight, controls hint and F3 debug panel. */
export class WorldView {
  readonly el: HTMLElement;
  private readonly debug: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly routeBtn: HTMLButtonElement;
  private readonly forwardBtn: HTMLButtonElement;
  private timer = 0;

  constructor(
    parent: HTMLElement,
    private readonly lang: Lang,
    private readonly world: World,
    onBack: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'world-ui';
    this.el.innerHTML = `
      <div class="topbar">
        <button class="btn btn-small" data-action="back">← ${t(lang, 'view.back')}</button>
        <div class="places" role="group" aria-label="${t(lang, 'view.places')}">
          ${PLACES.map((p, i) => `<button class="chip" data-place="${i}" title="${i + 1}">${p.name}</button>`).join('')}
          <button class="chip chip-accent" data-action="route">${t(lang, 'view.route')}</button>
        </div>
      </div>
      <div class="hud" aria-live="off"></div>
      <span class="loading-dot" hidden>${t(lang, 'view.loading')}</span>
      <button class="btn btn-small forward" data-action="forward" aria-pressed="false">▶ ${t(lang, 'view.forward')}</button>
      <p class="hint">${t(lang, 'view.help')}</p>
      <span class="attribution world-attribution">${ATTRIBUTION}</span>
      <pre class="debug" hidden></pre>
    `;
    parent.appendChild(this.el);
    this.debug = this.el.querySelector('.debug')!;
    this.hud = this.el.querySelector('.hud')!;
    this.loading = this.el.querySelector('.loading-dot')!;
    this.routeBtn = this.el.querySelector('[data-action="route"]')!;
    this.forwardBtn = this.el.querySelector('[data-action="forward"]')!;

    this.el.querySelector('[data-action="back"]')!.addEventListener('click', onBack);
    this.el.querySelectorAll<HTMLButtonElement>('[data-place]').forEach((b) =>
      b.addEventListener('click', () => {
        world.goTo(PLACES[Number(b.dataset.place)]!);
        b.blur();
      }),
    );
    this.routeBtn.addEventListener('click', () => {
      if (world.routeActive) world.stopRoute();
      else world.startRoute();
      this.routeBtn.blur();
    });
    this.forwardBtn.addEventListener('click', () => {
      world.fly.autoForward = !world.fly.autoForward;
      this.forwardBtn.setAttribute('aria-pressed', String(world.fly.autoForward));
      this.forwardBtn.blur();
    });
    window.addEventListener('keydown', this.onKey);
    if (import.meta.env.DEV || location.search.includes('debug')) this.debug.hidden = false;
    this.timer = window.setInterval(() => this.refresh(), 200);
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey);
    clearInterval(this.timer);
    this.el.remove();
  }

  private refresh() {
    const s = this.world.stats();
    const agl = s.agl === undefined ? '–' : `${Math.round(s.agl)} m`;
    this.hud.innerHTML = `
      <span><b>${Math.round(s.speedKmh)}</b> km/h</span>
      <span><b>${Math.round(s.altitude)}</b> m ü. M.</span>
      <span>AGL <b>${agl}</b></span>`;
    this.loading.hidden = s.tilesLoading === 0 && s.uploads === 0;
    this.routeBtn.textContent = this.world.routeActive
      ? t(this.lang, 'view.routeStop')
      : t(this.lang, 'view.route');
    if (!this.debug.hidden) this.debug.textContent = format(s);
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'F3') {
      e.preventDefault();
      this.debug.hidden = !this.debug.hidden;
    } else if (/^Digit[1-9]$/.test(e.code)) {
      const p = PLACES[Number(e.code.slice(5)) - 1];
      if (p) this.world.goTo(p);
    } else if (e.code === 'KeyR') {
      if (this.world.routeActive) this.world.stopRoute();
      else this.world.startRoute();
    } else if (e.code === 'KeyF') {
      this.forwardBtn.click();
    }
  };
}

function format(s: WorldStats): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const lines = [
    `FPS       ${s.fps.toFixed(0)}  (${s.frameMs.toFixed(1)} ms, max ${s.worstFrameMs.toFixed(0)})`,
    `Scale     ${Math.round(s.renderScale * 100)} % render resolution`,
    `CPU       update ${s.tickMs.toFixed(1)} ms · render ${s.renderMs.toFixed(1)} ms`,
    `Draws     ${s.calls}   Tris ${k(s.triangles)}`,
    `GPU       ${s.geometries} geo · ${s.textures} tex`,
    `Tiles     ${s.tilesRendered} drawn · ${s.tilesReady} ready · ${s.tilesLoading} loading`,
    `Detail    ${(s.coverage * 100).toFixed(0)} % · max z${s.maxZoom}${s.tilesFailed ? ` · ${s.tilesFailed} err` : ''}`,
    `Net       ${s.requestsInFlight} jobs · ${s.queued} queued · ${s.uploads} uploads`,
    `LV95      ${s.lv95[0].toFixed(0)} / ${s.lv95[1].toFixed(0)}`,
    `Origin    ${s.originKm.toFixed(1)} km from base`,
    `Depth     ${s.reversedDepth ? 'reversed-Z' : 'logarithmic'}`,
  ];
  const r = s.route;
  if (r) {
    lines.push(
      `Route     leg ${r.leg}/${r.legs} · ${r.distanceKm.toFixed(1)} km · ${r.seconds.toFixed(0)} s${r.done ? ' · done' : ''}`,
      `          pending ${((r.pendingFrames / Math.max(1, r.frames)) * 100).toFixed(0)} % · min detail ${(r.minCoverage * 100).toFixed(0)} % · worst ${r.worstFrameMs.toFixed(0)} ms`,
    );
  }
  return lines.join('\n');
}
