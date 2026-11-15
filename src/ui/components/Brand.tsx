import { Segmented } from './controls';
import { IconGlobe } from './icons';
import { type Lang, lang, setLang, t } from '../i18n';
import { status } from '../state';

/** The wordmark: the Swiss cross and the game's name as one title, all of it alike. */
export function Brand({ id }: { id?: string }) {
  return (
    <h1 class="brand" id={id}>
      <span class="brand-mark" aria-hidden="true" />
      <span class="brand-text">{t('app.title')}</span>
    </h1>
  );
}

/** German or English, as short as the header allows. */
export function LanguageSwitch() {
  return (
    <div class="lang-switch">
      <IconGlobe size={18} />
      <Segmented<Lang>
        label={t('menu.language')}
        value={lang.value}
        onChange={setLang}
        options={[
          { value: 'de', label: 'DE' },
          { value: 'en', label: 'EN' },
        ]}
      />
    </div>
  );
}

/** The version, once the app has told it. */
export function Version() {
  return status.version.value ? (
    <span class="home-version num">{t('menu.version', { v: status.version.value })}</span>
  ) : null;
}
