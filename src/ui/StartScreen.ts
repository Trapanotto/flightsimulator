import { APP_VERSION, ATTRIBUTION } from '../core/config';
import { type Lang, type MessageKey, storeLang, t } from '../i18n';

/** Main menu shown on load. Buttons for later phases are visible but disabled. */
export class StartScreen {
  constructor(
    private readonly root: HTMLElement,
    private lang: Lang,
    private readonly actions: { explore: (lang: Lang) => void; hangar: (lang: Lang) => void },
  ) {
    this.render();
  }

  private render(): void {
    const tr = (key: MessageKey) => t(this.lang, key);
    const soon = `<span class="soon">${tr('menu.soon')}</span>`;

    this.root.innerHTML = `
      <main class="start" style="--hero: url('${import.meta.env.BASE_URL}assets/ui/hero.jpg')">
        <header class="brand">
          <p class="brand-kicker">Trapanotto</p>
          <h1 class="brand-title">Flight Simulator</h1>
          <p class="brand-tagline">${tr('tagline')}</p>
        </header>

        <nav class="menu" aria-label="Hauptmenü">
          <button class="btn btn-primary" data-action="preview">${tr('menu.preview')}</button>
          <button class="btn" data-action="hangar">${tr('menu.hangar')}</button>
          <button class="btn" disabled>${tr('menu.fly')} ${soon}</button>
          <button class="btn" disabled>${tr('menu.challenges')} ${soon}</button>
          <button class="btn" disabled>${tr('menu.settings')} ${soon}</button>
          <button class="btn" data-action="credits">${tr('menu.credits')}</button>
        </nav>

        <footer class="footer">
          <span class="attribution">${ATTRIBUTION}</span>
          <span class="meta">
            <span>v${APP_VERSION} · ${tr('status.phase')}</span>
            <span class="lang" role="group" aria-label="Sprache / Language">
              <button data-lang="de" aria-pressed="${this.lang === 'de'}">DE</button>
              <button data-lang="en" aria-pressed="${this.lang === 'en'}">EN</button>
            </span>
          </span>
        </footer>

        <dialog class="credits" aria-labelledby="credits-title">
          <h2 id="credits-title">${tr('credits.title')}</h2>
          <p>${tr('credits.data')}</p>
          <p>${tr('credits.code')}</p>
          <p>${tr('credits.libs')}</p>
          <form method="dialog"><button class="btn">${tr('credits.close')}</button></form>
        </dialog>
      </main>
    `;

    this.root
      .querySelector('[data-action="preview"]')!
      .addEventListener('click', () => this.actions.explore(this.lang));
    this.root
      .querySelector('[data-action="hangar"]')!
      .addEventListener('click', () => this.actions.hangar(this.lang));

    const dialog = this.root.querySelector<HTMLDialogElement>('dialog.credits')!;
    this.root
      .querySelector('[data-action="credits"]')!
      .addEventListener('click', () => dialog.showModal());

    this.root.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.lang = btn.dataset.lang as Lang;
        storeLang(this.lang);
        document.documentElement.lang = this.lang;
        this.render();
      });
    });
  }
}
