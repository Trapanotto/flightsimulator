import type { TerrainStats } from '../terrain/quadtree';

export interface Telemetry {
  altitude: number;
  lon: number;
  lat: number;
  heading: number;
  speed: number;
  fps: number;
}

export interface FrameStats extends TerrainStats {
  calls: number;
  frameMs: number;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing DOM element #${id}`);
  return element as T;
}

const numberFormat = new Intl.NumberFormat('de-CH');

export class Ui {
  private readonly loading = byId<HTMLDivElement>('loading');
  private readonly loadingStatus = byId<HTMLParagraphElement>('loading-status');
  private readonly progressBar = byId<HTMLDivElement>('progress-bar');
  private readonly debug = byId<HTMLDivElement>('debug');
  private readonly help = byId<HTMLDivElement>('help');
  private readonly pointerHint = byId<HTMLDivElement>('pointer-hint');
  private readonly error = byId<HTMLDivElement>('error');
  private readonly errorMessage = byId<HTMLParagraphElement>('error-message');
  private readonly errorRetry = byId<HTMLButtonElement>('error-retry');

  private readonly alt = byId<HTMLSpanElement>('alt-value');
  private readonly coord = byId<HTMLSpanElement>('coord-value');
  private readonly heading = byId<HTMLSpanElement>('heading-value');
  private readonly speed = byId<HTMLSpanElement>('speed-value');
  private readonly fps = byId<HTMLSpanElement>('fps-value');

  private readonly dbgSource = byId<HTMLSpanElement>('debug-source');
  private readonly dbgVisible = byId<HTMLElement>('dbg-visible');
  private readonly dbgLoaded = byId<HTMLElement>('dbg-loaded');
  private readonly dbgTextured = byId<HTMLElement>('dbg-textured');
  private readonly dbgPending = byId<HTMLElement>('dbg-pending');
  private readonly dbgTriangles = byId<HTMLElement>('dbg-triangles');
  private readonly dbgCalls = byId<HTMLElement>('dbg-calls');
  private readonly dbgNodes = byId<HTMLElement>('dbg-nodes');
  private readonly dbgFrame = byId<HTMLElement>('dbg-frame');

  private loadingHidden = false;
  private debugVisible = new URLSearchParams(location.search).has('debug');

  constructor() {
    if (this.debugVisible) this.debug.classList.remove('hidden');

    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyH') {
        this.help.classList.toggle('is-hidden');
      }
      if (event.code === 'F3') {
        event.preventDefault();
        this.debugVisible = !this.debugVisible;
        this.debug.classList.toggle('hidden', !this.debugVisible);
      }
    });
  }

  onRetry(callback: () => void) {
    this.errorRetry.addEventListener('click', () => {
      this.error.classList.add('hidden');
      callback();
    });
  }

  setLoading(status: string, progress: number) {
    if (this.loadingHidden) return;
    this.loadingStatus.textContent = status;
    this.progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }

  hideLoading() {
    if (this.loadingHidden) return;
    this.loadingHidden = true;
    this.progressBar.style.width = '100%';
    this.loadingStatus.textContent = 'Bereit. Klick ins Bild und flieg los.';
    window.setTimeout(() => this.loading.classList.add('is-hidden'), 450);
  }

  setSource(live: boolean) {
    this.dbgSource.textContent = live ? 'swisstopo live' : 'fallback';
  }

  updateTelemetry(telemetry: Telemetry) {
    this.alt.textContent = numberFormat.format(Math.round(telemetry.altitude));
    this.coord.textContent = `${telemetry.lat.toFixed(4)}° N  ${telemetry.lon.toFixed(4)}° E`;
    this.heading.textContent = String(Math.round(telemetry.heading)).padStart(3, '0');
    this.speed.textContent = numberFormat.format(Math.round(telemetry.speed * 1.94384));
    this.fps.textContent = String(Math.round(telemetry.fps));
  }

  updateDebug(stats: FrameStats) {
    if (!this.debugVisible) return;

    this.dbgVisible.textContent = String(stats.visible);
    this.dbgLoaded.textContent = String(stats.loaded);
    this.dbgTextured.textContent = String(stats.textured);
    this.dbgPending.textContent = String(stats.pending);
    this.dbgTriangles.textContent = numberFormat.format(
      Math.round(stats.triangles),
    );
    this.dbgCalls.textContent = String(stats.calls);
    this.dbgNodes.textContent = String(stats.nodes);
    this.dbgFrame.textContent = `${stats.frameMs.toFixed(1)} ms`;
  }

  setPointerLocked(locked: boolean) {
    document.body.classList.toggle('pointer-locked', locked);
    this.pointerHint.textContent = locked
      ? 'ESC gibt die Maus wieder frei'
      : 'Klick ins Bild für Maussteuerung';
  }

  showError(message: string) {
    this.errorMessage.textContent = message;
    this.error.classList.remove('hidden');
    this.loading.classList.add('is-hidden');
  }
}
