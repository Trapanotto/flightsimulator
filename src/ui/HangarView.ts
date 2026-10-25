import { AIRCRAFT, aircraftById, saveAircraftChoice } from '../aircraft/types';
import { type Lang, t } from '../i18n';
import type { Hangar } from '../hangar/Hangar';

/** Aircraft choice and studio controls: gear, flaps, propeller, control demo, LOD. */
export class HangarView {
  readonly el: HTMLElement;
  private readonly info: HTMLElement;
  private timer = 0;

  constructor(
    parent: HTMLElement,
    lang: Lang,
    private readonly hangar: Hangar,
    onBack: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'world-ui hangar-ui';
    this.el.innerHTML = `
      <div class="topbar">
        <button class="btn btn-small" data-action="back">← ${t(lang, 'view.back')}</button>
      </div>
      <div class="hangar-card">
        <p class="brand-kicker">Trapanotto Airlines</p>
        <div class="fleet" role="radiogroup" aria-label="${t(lang, 'hangar.fleet')}">
          ${AIRCRAFT.map(
            (a) => `<button class="chip" role="radio" data-aircraft="${a.id}"
              aria-checked="${a.id === hangar.type.id}">${a.name}</button>`,
          ).join('')}
        </div>
        <h2 data-v="name">${hangar.type.name}</h2>
        <p class="hangar-sub" data-v="sub">${hangar.type.info[lang]} · ${hangar.type.registration}</p>
        <div class="hangar-controls">
          <button class="chip" data-toggle="gear" aria-pressed="true">${t(lang, 'hangar.gear')}</button>
          <button class="chip" data-toggle="flaps" aria-pressed="false">${t(lang, 'hangar.flaps')}</button>
          <button class="chip" data-toggle="demo" aria-pressed="true">${t(lang, 'hangar.demo')}</button>
          <button class="chip" data-toggle="spin" aria-pressed="true">${t(lang, 'hangar.rotate')}</button>
        </div>
        <label class="hangar-slider">${t(lang, 'hangar.prop')}
          <input type="range" min="0" max="100" value="0" data-input="rpm" />
        </label>
        <div class="hangar-controls" role="group" aria-label="LOD">
          <button class="chip" data-lod="auto" aria-pressed="true">LOD auto</button>
          <button class="chip" data-lod="0" aria-pressed="false">0</button>
          <button class="chip" data-lod="1" aria-pressed="false">1</button>
          <button class="chip" data-lod="2" aria-pressed="false">2</button>
        </div>
        <p class="hangar-info" aria-live="polite"></p>
      </div>
    `;
    parent.appendChild(this.el);
    this.info = this.el.querySelector('.hangar-info')!;
    this.el.querySelector('[data-action="back"]')!.addEventListener('click', onBack);
    const gearChip = this.el.querySelector<HTMLButtonElement>('[data-toggle="gear"]')!;
    const showType = () => {
      const type = hangar.type;
      this.el.querySelector('[data-v="name"]')!.textContent = type.name;
      this.el.querySelector('[data-v="sub"]')!.textContent =
        `${type.info[lang]} · ${type.registration}`;
      gearChip.disabled = type.physics.fixedGear;
      gearChip.setAttribute('aria-pressed', 'true');
      this.el
        .querySelectorAll<HTMLButtonElement>('[data-aircraft]')
        .forEach((b) => b.setAttribute('aria-checked', String(b.dataset.aircraft === type.id)));
    };
    showType();
    this.el.querySelectorAll<HTMLButtonElement>('[data-aircraft]').forEach((b) =>
      b.addEventListener('click', () => {
        const type = aircraftById(b.dataset.aircraft);
        saveAircraftChoice(type.id);
        hangar.type = type;
        showType();
        void hangar.load(type);
      }),
    );

    this.el.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) =>
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        const a = hangar.aircraft;
        switch (b.dataset.toggle) {
          case 'gear':
            if (a) a.controls.gear = on ? 1 : 0;
            break;
          case 'flaps':
            if (a) a.controls.flaps = on ? 1 : 0;
            break;
          case 'demo':
            hangar.demo = on;
            if (!on && a) a.controls.aileron = a.controls.elevator = a.controls.rudder = 0;
            break;
          case 'spin':
            hangar.controls.autoRotate = on;
            break;
        }
      }),
    );
    this.el
      .querySelector<HTMLInputElement>('[data-input="rpm"]')!
      .addEventListener('input', (e) => {
        if (hangar.aircraft)
          hangar.aircraft.controls.rpm = Number((e.target as HTMLInputElement).value) / 100;
      });
    const lodButtons = this.el.querySelectorAll<HTMLButtonElement>('[data-lod]');
    lodButtons.forEach((b) =>
      b.addEventListener('click', () => {
        lodButtons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        hangar.forcedLod = b.dataset.lod === 'auto' ? null : Number(b.dataset.lod);
      }),
    );
    this.timer = window.setInterval(() => this.refresh(lang), 250);
  }

  destroy() {
    clearInterval(this.timer);
    this.el.remove();
  }

  private refresh(lang: Lang) {
    const a = this.hangar.aircraft;
    if (!a) {
      this.info.textContent = t(lang, 'hangar.loading');
      return;
    }
    const level = this.hangar.forcedLod ?? a.level;
    const dist = this.hangar.camera.position.distanceTo(this.hangar.controls.target);
    this.info.textContent = `LOD ${level} · ${a.triangles[level]?.toLocaleString()} ${t(lang, 'hangar.tris')} · ${dist.toFixed(0)} m`;
  }
}
