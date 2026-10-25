import { Vector3 } from 'three';
import { ATTRIBUTION } from '../core/config';
import { type Lang, type MessageKey, t } from '../i18n';
import { RUNWAYS } from '../game/airports';
import type { FlightGame, StartPlace } from '../game/FlightGame';
import { PLACES } from '../world/places';
import type { ChallengeEvent } from '../game/ChallengeRun';
import { formatTime, loadBestTimes } from '../game/challenges';
import { medalBadge, openChallengePicker } from './ChallengePicker';
import { type MapMarker, Minimap } from './Minimap';
import { PlaceSearch } from './PlaceSearch';
import type { World } from '../world/World';
import { TR1 } from '../physics/FlightModel';

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
  private readonly minimap: Minimap;

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
      <div class="fmap">
        <div class="fmap-heading" data-v="hdg">000°</div>
      </div>

      <div class="fmenu">
        <button class="btn btn-small fmenu-toggle" data-action="menu" aria-expanded="false">☰ ${tr('view.back')}</button>
        <div class="fmenu-panel" hidden>
          <button class="btn btn-small" data-action="back">← ${tr('flight.mainMenu')}</button>
          <button class="btn btn-small btn-primary" data-action="challenges">${tr('menu.challenges')}</button>
          <button class="btn btn-small" data-action="settings">${tr('menu.settings')}</button>
          <p class="fmenu-label">${tr('view.places')}</p>
          <div class="places" role="group" aria-label="${tr('view.places')}">
            ${FLIGHT_PLACES.map((p, i) => `<button class="chip" data-place="${i}">${p.label}</button>`).join('')}
          </div>
          <div class="fmenu-search"></div>
          <p class="fmenu-label">${tr('flight.controls')}</p>
          <p class="fmenu-help">${tr('flight.help')}</p>
        </div>
      </div>

      <div class="chud" data-v="chud" hidden>
        <span class="chud-name" data-v="cname"></span>
        <span class="chud-time" data-v="ctime">0:00.0</span>
        <span class="chud-sub"><span data-v="cgates"></span> · <span data-v="cbest"></span></span>
      </div>
      <div class="ring-marker" hidden><i></i><span data-v="cdist"></span></div>
      <div class="cresult" hidden></div>
      <div class="reticle aim" hidden></div>
      <div class="reticle nose" hidden></div>

      <div class="fstrip left">
        <div class="fcell"><span>${tr('hud.airspeed')}</span><b><i data-v="speed">0</i><small>km/h</small></b></div>
        <div class="fcell" data-v="engineCell"><span>${tr('hud.engine')}</span><b><i data-v="rpm">0</i><small>${tr('hud.rpm')}</small></b></div>
      </div>
      <div class="fstrip right">
        <div class="fcell"><span>${tr('hud.flaps')}</span><b><i data-v="flaps">0°</i></b></div>
        <div class="fcell"><span>${tr('hud.trim')}</span><b><i data-v="trim">0 %</i></b></div>
        <div class="fcell"><span>${tr('hud.altitude')}</span><b><i data-v="alt">0</i><small>m</small></b></div>
        <div class="fcell"><span>${tr('hud.vs')}</span><b><i data-v="vs">0.0</i><small>m/s</small></b></div>
      </div>

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

      <span class="attribution world-attribution">${ATTRIBUTION}</span>
    `;
    parent.appendChild(this.el);

    this.q('[data-action="menu"]').addEventListener('click', (e) => {
      (e.currentTarget as HTMLElement).blur();
      this.toggleMenu();
    });
    this.q('[data-action="back"]').addEventListener('click', onBack);
    this.q('[data-action="settings"]').addEventListener('click', () => {
      this.toggleMenu(false);
      onSettings?.();
    });
    this.q('[data-action="challenges"]').addEventListener('click', () => {
      this.toggleMenu(false);
      this.pickChallenge();
    });
    game.onChallengeEvent = (e) => this.onChallengeEvent(e);
    this.el.querySelectorAll<HTMLButtonElement>('[data-place]').forEach((b) =>
      b.addEventListener('click', () => {
        game.start(FLIGHT_PLACES[Number(b.dataset.place)]!.place);
        b.blur();
        this.toggleMenu(false);
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
    this.minimap = new Minimap(this.q('.fmap'), true);
    game.onToggleMap = () => this.minimap.toggle();
    new PlaceSearch(this.q('.fmenu-search'), lang, (hit) => {
      this.toggleMenu(false);
      game.start({ kind: 'air', name: hit.name, lon: hit.lon, lat: hit.lat, h: 0, heading: 0 });
    });

    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.refresh();
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.game.onChallengeEvent = undefined;
    this.el.remove();
  }

  /** Menu top right: start places, search, challenges, settings, controls help. */
  private toggleMenu(open?: boolean) {
    const panel = this.q('.fmenu-panel');
    const show = open ?? panel.hidden;
    panel.hidden = !show;
    this.q('[data-action="menu"]').setAttribute('aria-expanded', String(show));
  }

  /** Course list; the game pauses while it is open. */
  private pickChallenge() {
    const g = this.game;
    const wasPaused = g.paused;
    g.paused = true;
    let picked = false;
    const dialog = openChallengePicker(this.lang, (course) => {
      picked = true;
      this.hideResult();
      g.paused = false;
      g.startChallenge(course);
    });
    dialog.addEventListener('close', () => {
      if (!picked) g.paused = wasPaused;
    });
  }

  private onChallengeEvent(e: ChallengeEvent) {
    if (e.type === 'finish') this.showResult();
  }

  private hideResult() {
    this.q('.cresult').hidden = true;
  }

  /** Result card: time, medal, best time; again / other course / free flight. */
  private showResult() {
    const run = this.game.challenge;
    const r = run?.result;
    if (!run || !r) return;
    const tr = (k: MessageKey) => this.tr(k);
    const best = loadBestTimes()[run.course.id];
    const box = this.q('.cresult');
    box.innerHTML = `
      <p class="cresult-kicker">${tr('challenge.finish')}</p>
      <h2>${run.course.name[this.lang]}</h2>
      <p class="cresult-time">${formatTime(r.time)}</p>
      <p class="cresult-medal">${
        r.medal
          ? `${medalBadge(this.lang, r.medal)} ${tr(`medal.${r.medal}` as MessageKey)}`
          : tr('challenge.noMedal')
      }</p>
      <p class="cresult-best">${
        r.newBest
          ? `<b>${tr('challenge.newBest')}</b>`
          : best !== undefined
            ? `${tr('challenge.best')} ${formatTime(best)}`
            : ''
      }</p>
      <div class="cresult-actions">
        <button class="btn btn-small btn-primary" data-r="again">${tr('challenge.again')}</button>
        <button class="btn btn-small" data-r="other">${tr('challenge.other')}</button>
        <button class="btn btn-small" data-r="free">${tr('challenge.free')}</button>
      </div>`;
    box.hidden = false;
    const course = run.course;
    box.querySelector('[data-r="again"]')!.addEventListener('click', () => {
      this.hideResult();
      this.game.startChallenge(course);
    });
    box.querySelector('[data-r="other"]')!.addEventListener('click', () => {
      this.hideResult();
      this.pickChallenge();
    });
    box.querySelector('[data-r="free"]')!.addEventListener('click', () => {
      this.hideResult();
      this.game.endChallenge();
    });
  }

  /** Clock, ring counter and best time while a challenge runs. */
  private refreshChallenge() {
    const run = this.game.challenge;
    this.show('chud', !!run);
    if (!run) {
      this.hideResult();
      return;
    }
    const n = run.gates.length;
    this.set('cname', run.course.name[this.lang]);
    this.set('ctime', formatTime(run.result?.time ?? run.time));
    this.set(
      'cgates',
      run.awaitingLanding
        ? this.tr('challenge.land')
        : `${this.tr('challenge.gate')} ${Math.min(run.next + 1, n)}/${n}`,
    );
    const best = loadBestTimes()[run.course.id];
    this.set(
      'cbest',
      best === undefined
        ? this.tr('challenge.noBest')
        : `${this.tr('challenge.best')} ${formatTime(best)}`,
    );
  }

  private markers(): MapMarker[] {
    const run = this.game.challenge;
    if (!run || run.finished) return [];
    const gates = run.course.gates;
    const last = gates.length - 1;
    const out: MapMarker[] = gates.slice(run.next, run.next + 5).map((g, i) => ({
      lon: g.lon,
      lat: g.lat,
      kind: i === 0 ? 'next' : run.next + i === last ? 'finish' : 'later',
    }));
    const r = run.course.landing;
    if (r && run.next + 5 > last) {
      out.push({
        lon: (r.from.lon + r.to.lon) / 2,
        lat: (r.from.lat + r.to.lat) / 2,
        kind: out.length ? 'finish' : 'next',
      });
    }
    return out;
  }

  /** Arrow/diamond towards the next ring; clamped to the screen edge when it is off screen. */
  private placeRingMarker() {
    const el = this.q('.ring-marker');
    const target = this.game.challenge?.target;
    if (!target || this.game.waitingForTerrain) {
      el.hidden = true;
      return;
    }
    const cam = this.world.camera;
    const dist = cam.position.distanceTo(target);
    const v = tmp.copy(target).project(cam);
    const behind = v.z > 1;
    let x = behind ? -v.x : v.x;
    let y = behind ? -v.y : v.y;
    const inside = !behind && Math.abs(x) < 0.92 && Math.abs(y) < 0.85;
    if (!inside) {
      // Push the point onto the screen border along its direction from the centre.
      const k = Math.max(Math.abs(x) / 0.92, Math.abs(y) / 0.85, 1e-6);
      x /= k;
      y /= k;
    }
    el.hidden = false;
    el.classList.toggle('edge', !inside);
    el.style.setProperty('--angle', `${Math.atan2(-y * innerHeight, x * innerWidth)}rad`);
    el.style.transform = `translate(${((x + 1) / 2) * innerWidth}px, ${((1 - y) / 2) * innerHeight}px)`;
    this.set('cdist', dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(1)} km`);
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
    const b = this.world.basisAt(fm.position);
    const heading = (Math.atan2(fm.forward.dot(b.east), fm.forward.dot(b.north)) * 180) / Math.PI;
    const hdg = Math.round((heading + 360) % 360) % 360;
    // Map a few times per second, numbers at ~20 Hz, reticles every frame.
    if (this.frame % 6 === 0) {
      const [lon, lat, alt] = this.world.toGeo(fm.position);
      const hag = g.heightAboveGround ?? alt;
      this.minimap.update(lon, lat, heading, hag, this.markers());
      this.set('hdg', `${String(hdg).padStart(3, '0')}°`);
    }
    if (this.frame++ % 3 === 0) {
      const [, , alt] = this.world.toGeo(fm.position);
      this.set('speed', String(Math.round(fm.speed * 3.6)));
      // TR-1 turboprop: 30 % idle to 100 % at 2700 rpm.
      const rpm = fm.crashed ? 0 : Math.round(((0.3 + 0.7 * fm.throttle) * 2700) / 10) * 10;
      this.set('rpm', String(rpm));
      this.q('[data-v="engineCell"]').classList.toggle('boost', fm.boosting);
      this.set('flaps', `${Math.round(fm.flaps * 30)}°`);
      const trimRange = fm.trim >= 0 ? TR1.trimMax : -TR1.trimMin;
      this.set('trim', `${Math.round((fm.trim / trimRange) * 100)} %`);
      this.set('alt', String(Math.round(alt)));
      const vs = fm.verticalSpeed;
      this.set('vs', `${vs > 0.05 ? '+' : ''}${vs.toFixed(1)}`);

      const warn =
        fm.crashed || g.waitingForTerrain ? '' : g.pullUp ? 'PULL UP' : fm.stalled ? 'STALL' : '';
      this.set('warn', warn);
      this.show('warn', warn !== '');
      const m = g.message;
      if (m) {
        const [key, value] = m.text.split('|');
        const label = t(this.lang, key as MessageKey) ?? key;
        this.set('msg', value ? `${label} · ${value}` : label);
        this.q('[data-v="msg"]').dataset.kind = m.kind;
      }
      this.show('msg', !!m);
      this.show('wait', g.waitingForTerrain);
      this.show('pause', g.paused);
      this.refreshChallenge();
    }
    this.placeRingMarker();
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
