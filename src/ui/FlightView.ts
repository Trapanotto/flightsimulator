import { Vector3 } from 'three';
import { ATTRIBUTION } from '../core/config';
import { type Lang, type MessageKey, t } from '../i18n';
import { RUNWAYS } from '../game/airports';
import type { FlightGame, StartPlace } from '../game/FlightGame';
import { PLACES } from '../world/places';
import { Instruments } from './Instruments';
import { Minimap } from './Minimap';
import { PlaceSearch } from './PlaceSearch';
import type { World } from '../world/World';

/** Start places in flight mode: all runways, plus two air starts in the Alps. */
export const FLIGHT_PLACES: Array<{ label: string; place: StartPlace }> = [
  ...RUNWAYS.map((r) => ({
    label: `${r.airport} ${r.ident}`,
    place: { kind: 'runway', runway: r } as StartPlace,
  })),
  ...['Lauterbrunnen', 'Matterhorn'].map((n) => {
    const p = PLACES.find((x) => x.name === n)!;
    return {
      label: `${n} ✈`,
      place: {
        kind: 'air',
        name: n,
        lon: p.lon,
        lat: p.lat,
        h: p.h,
        heading: p.heading,
      } as StartPlace,
    };
  }),
];

const tmp = new Vector3();

/** HUD, start places, touch controls and messages for flight mode. */
export class FlightView {
  readonly el: HTMLElement;
  private readonly q = <T extends HTMLElement>(sel: string) => this.el.querySelector<T>(sel)!;
  private raf = 0;
  private readonly instruments: Instruments;
  private readonly minimap: Minimap;
  private placeTimer = 0;

  constructor(
    parent: HTMLElement,
    private readonly lang: Lang,
    private readonly world: World,
    private readonly game: FlightGame,
    onBack: () => void,
    onSettings?: () => void,
  ) {
    const tr = (k: MessageKey) => t(lang, k);
    this.el = document.createElement('div');
    this.el.className = 'world-ui flight-ui';
    this.el.innerHTML = `
      <div class="topbar">
        <button class="btn btn-small" data-action="back">← ${tr('view.back')}</button>
        <button class="btn btn-small" data-action="settings" aria-label="${tr('menu.settings')}">⚙</button>
        <div class="places" role="group" aria-label="${tr('view.places')}">
          ${FLIGHT_PLACES.map((p, i) => `<button class="chip" data-place="${i}">${p.label}</button>`).join('')}
        </div>
      </div>
      <div class="reticle aim" hidden></div>
      <div class="reticle nose" hidden></div>
      <div class="fhud">
        <div class="fhud-col">
          <span class="fhud-big" data-v="speed">0</span><span class="fhud-unit">km/h</span>
          <div class="bar"><span data-v="throttle"></span></div>
          <span class="fhud-small">${tr('hud.throttle')} <b data-v="thr">0</b> %</span>
          <div class="bar boost"><span data-v="boost"></span></div>
        </div>
        <div class="fhud-col right">
          <span class="fhud-big" data-v="alt">0</span><span class="fhud-unit">m ü. M.</span>
          <span class="fhud-small">AGL <b data-v="agl">–</b> m</span>
          <span class="fhud-small">↕ <b data-v="vs">0</b> m/s</span>
          <span class="fhud-small"><b data-v="g">1.0</b> G</span>
        </div>
      </div>
      <div class="fstatus">
        <span data-v="gear">${tr('hud.gear')}</span>
        <span data-v="flaps">${tr('hud.flaps')} 0 %</span>
        <span data-v="cam"></span>
      </div>
      <div class="near-place" data-v="place"></div>
      <div class="warning" data-v="warn" hidden></div>
      <div class="fmessage" data-v="msg" hidden></div>
      <div class="loading-dot" data-v="wait" hidden>${tr('flight.waiting')}</div>
      <div class="pause-overlay" data-v="pause" hidden>${tr('flight.paused')}</div>

      <div class="touch-stick" aria-hidden="true"><span class="knob"></span></div>
      <div class="touch-right">
        <input class="touch-throttle" type="range" min="0" max="100" value="0" aria-label="${tr('hud.throttle')}" />
        <div class="touch-buttons">
          <button class="chip" data-act="boost">Boost</button>
          <button class="chip" data-act="gear">${tr('hud.gear')}</button>
          <button class="chip" data-act="flaps">${tr('hud.flaps')}</button>
          <button class="chip" data-act="camera">${tr('hud.camera')}</button>
        </div>
      </div>

      <p class="hint">${tr('flight.help')}</p>
      <span class="attribution world-attribution">${ATTRIBUTION}</span>
    `;
    parent.appendChild(this.el);

    this.q('[data-action="back"]').addEventListener('click', onBack);
    this.q('[data-action="settings"]').addEventListener('click', () => onSettings?.());
    this.el.querySelectorAll<HTMLButtonElement>('[data-place]').forEach((b) =>
      b.addEventListener('click', () => {
        game.start(FLIGHT_PLACES[Number(b.dataset.place)]!.place);
        b.blur();
      }),
    );
    this.el.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => {
      const act = b.dataset.act!;
      if (act === 'boost') {
        b.addEventListener('pointerdown', () => (game.controls.touch.boost = true));
        b.addEventListener('pointerup', () => (game.controls.touch.boost = false));
        b.addEventListener('pointerleave', () => (game.controls.touch.boost = false));
      } else {
        b.addEventListener('click', () =>
          game.controls.trigger(act as 'gear' | 'flaps' | 'camera'),
        );
      }
    });
    const thr = this.q<HTMLInputElement>('.touch-throttle');
    thr.addEventListener('input', () => (game.controls.touch.throttle = Number(thr.value) / 100));
    this.setupStick();
    this.instruments = new Instruments(this.el);
    this.minimap = new Minimap(this.el);
    game.onToggleMap = () => this.minimap.toggle();
    new PlaceSearch(this.q('.topbar'), lang, (hit) =>
      game.start({ kind: 'air', name: hit.name, lon: hit.lon, lat: hit.lat, h: 0, heading: 0 }),
    );

    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.refresh();
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.el.remove();
  }

  private tr(k: MessageKey) {
    return t(this.lang, k);
  }

  private set(key: string, text: string) {
    const el = this.el.querySelector<HTMLElement>(`[data-v="${key}"]`);
    if (el && el.textContent !== text) el.textContent = text;
  }

  private show(key: string, on: boolean) {
    const el = this.el.querySelector<HTMLElement>(`[data-v="${key}"]`);
    if (el && el.hidden === on) el.hidden = !on;
  }

  private frame = 0;
  private refresh() {
    const g = this.game;
    const fm = g.fm;
    // Attitude and heading every frame; map and place name a few times per second.
    const b = this.world.basisAt(fm.position);
    const heading = (Math.atan2(fm.forward.dot(b.east), fm.forward.dot(b.north)) * 180) / Math.PI;
    this.instruments.update(heading, (fm.pitch * 180) / Math.PI, (fm.bank * 180) / Math.PI);
    this.instruments.visible = !g.waitingForTerrain && g.rig.mode !== 'orbit';
    if (this.frame % 6 === 0) {
      const [lon, lat, alt] = this.world.toGeo(fm.position);
      const hag = g.heightAboveGround ?? alt;
      this.minimap.update(lon, lat, heading, hag);
      if (performance.now() > this.placeTimer) {
        this.placeTimer = performance.now() + 1000;
        const near = this.world.buildings?.nearestPlace(lon, lat);
        this.set(
          'place',
          near ? (near.km < 1 ? near.name : `${this.tr('hud.near')} ${near.name}`) : '',
        );
      }
    }
    const tr = (k: MessageKey) => t(this.lang, k);
    // Numbers at ~20 Hz, reticles every frame.
    if (this.frame++ % 3 === 0) {
      const [, , alt] = this.world.toGeo(fm.position);
      const hag = g.heightAboveGround;
      this.set('speed', String(Math.round(fm.speed * 3.6)));
      this.set('alt', String(Math.round(alt)));
      this.set('agl', hag === undefined ? '–' : String(Math.max(0, Math.round(hag - 1.53))));
      this.set('vs', fm.verticalSpeed.toFixed(1));
      this.set('g', fm.gLoad.toFixed(1));
      this.set('thr', String(Math.round(fm.throttle * 100)));
      this.q('[data-v="throttle"]').style.transform = `scaleX(${fm.throttle})`;
      this.q('[data-v="boost"]').style.transform = `scaleX(${fm.boostLeft / 5})`;
      this.set('gear', `${tr('hud.gear')} ${fm.gearDown ? '▼' : '▲'}`);
      this.set('flaps', `${tr('hud.flaps')} ${Math.round(fm.flaps * 100)} %`);
      this.set('cam', `${tr('hud.camera')}: ${tr(`camera.${g.rig.mode}` as MessageKey)}`);

      const warn =
        fm.crashed || g.waitingForTerrain ? '' : g.pullUp ? 'PULL UP' : fm.stalled ? 'STALL' : '';
      this.set('warn', warn);
      this.show('warn', warn !== '');
      const m = g.message;
      if (m) {
        const [key, value] = m.text.split('|');
        const label = t(this.lang, key as MessageKey) ?? key;
        this.set('msg', value ? `${label} · ${value} m/s` : label);
        this.q('[data-v="msg"]').dataset.kind = m.kind;
      }
      this.show('msg', !!m);
      this.show('wait', g.waitingForTerrain);
      this.show('pause', g.paused);
    }
    this.placeReticle('.reticle.aim', g.aim.active ? g.aimPoint(tmp) : null);
    this.placeReticle('.reticle.nose', g.aim.active ? g.nosePoint(tmp) : null);
  }

  private placeReticle(sel: string, p: Vector3 | null) {
    const el = this.q(sel);
    if (!p) {
      el.hidden = true;
      return;
    }
    const v = p.project(this.world.camera);
    const visible = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
    el.hidden = !visible;
    if (visible) {
      el.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px)`;
    }
  }

  /** Left virtual stick: drag inside the circle; up = nose down (like a real stick). */
  private setupStick() {
    const pad = this.q('.touch-stick');
    const knob = this.q('.knob');
    const touch = this.game.controls.touch;
    let id: number | null = null;
    const move = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      const y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      touch.roll = x;
      touch.pitch = y; // pulling down (positive y) = nose up
      knob.style.transform = `translate(${x * 40}px, ${y * 40}px)`;
    };
    pad.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      pad.setPointerCapture(e.pointerId);
      touch.active = true;
      move(e);
    });
    pad.addEventListener('pointermove', (e) => e.pointerId === id && move(e));
    const end = () => {
      id = null;
      touch.active = false;
      touch.roll = touch.pitch = 0;
      knob.style.transform = '';
    };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
  }
}
