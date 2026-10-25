import { type Lang, type MessageKey, t } from '../i18n';
import {
  QUALITY_LEVELS,
  type Settings,
  type TimeOfDay,
  type Weather,
  detectQuality,
  loadSettings,
  saveSettings,
} from '../core/settings';

type Option<T extends string> = { value: T; label: MessageKey };

/** Settings dialog (graphics, time of day, weather, controls). Changes apply immediately. */
export function openSettings(lang: Lang, onChange: (s: Settings) => void) {
  const tr = (k: MessageKey) => t(lang, k);
  const settings = loadSettings();
  const detected = detectQuality();
  const dialog = document.createElement('dialog');
  dialog.className = 'credits settings';

  const group = <T extends string>(
    key: keyof Settings,
    title: MessageKey,
    options: Array<Option<T>>,
  ) => `
    <fieldset>
      <legend>${tr(title)}</legend>
      <div class="hangar-controls">
        ${options
          .map(
            (o) =>
              `<button type="button" class="chip" data-key="${key}" data-value="${o.value}" aria-pressed="${settings[key] === o.value}">${tr(o.label)}${o.value === 'auto' ? ` (${tr(`quality.${detected}` as MessageKey)})` : ''}</button>`,
          )
          .join('')}
      </div>
    </fieldset>`;

  dialog.innerHTML = `
    <h2>${tr('menu.settings')}</h2>
    ${group('quality', 'settings.quality', [
      { value: 'auto', label: 'quality.auto' },
      ...QUALITY_LEVELS.map((q) => ({ value: q, label: `quality.${q}` as MessageKey })),
    ])}
    ${group<TimeOfDay>('time', 'settings.time', [
      { value: 'real', label: 'time.real' },
      { value: 'morning', label: 'time.morning' },
      { value: 'noon', label: 'time.noon' },
      { value: 'golden', label: 'time.golden' },
    ])}
    ${group<Weather>('weather', 'settings.weather', [
      { value: 'clear', label: 'weather.clear' },
      { value: 'fair', label: 'weather.fair' },
      { value: 'cloudy', label: 'weather.cloudy' },
    ])}
    <fieldset>
      <legend>${tr('settings.controls')}</legend>
      <label class="toggle"><input type="checkbox" data-key="invertPitch" ${settings.invertPitch ? 'checked' : ''} /> ${tr('settings.invertPitch')}</label>
    </fieldset>
    <fieldset>
      <legend>${tr('settings.sound')}</legend>
      <label class="toggle"><input type="checkbox" data-key="sound" ${settings.sound ? 'checked' : ''} /> ${tr('settings.soundOn')}</label>
      <label class="toggle">${tr('settings.volume')} <input type="range" data-key="volume" min="0" max="1" step="0.05" value="${settings.volume}" /></label>
    </fieldset>
    <form method="dialog"><button class="btn">${tr('credits.close')}</button></form>
  `;
  document.body.appendChild(dialog);

  const apply = () => {
    saveSettings(settings);
    onChange({ ...settings });
  };
  dialog.querySelectorAll<HTMLButtonElement>('button[data-key]').forEach((b) =>
    b.addEventListener('click', () => {
      const key = b.dataset.key as keyof Settings;
      (settings as unknown as Record<string, string>)[key] = b.dataset.value!;
      dialog
        .querySelectorAll<HTMLButtonElement>(`button[data-key="${key}"]`)
        .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      apply();
    }),
  );
  dialog
    .querySelector<HTMLInputElement>('input[data-key="invertPitch"]')!
    .addEventListener('change', (e) => {
      settings.invertPitch = (e.target as HTMLInputElement).checked;
      apply();
    });
  dialog
    .querySelector<HTMLInputElement>('input[data-key="sound"]')!
    .addEventListener('change', (e) => {
      settings.sound = (e.target as HTMLInputElement).checked;
      apply();
    });
  dialog
    .querySelector<HTMLInputElement>('input[data-key="volume"]')!
    .addEventListener('input', (e) => {
      settings.volume = Number((e.target as HTMLInputElement).value);
      apply();
    });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
