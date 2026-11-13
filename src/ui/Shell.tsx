import { lang, setLang, t } from './i18n';
import { status } from './state';

function Status({ label, value }: { label: string; value: string }) {
  return (
    <div class="status-item">
      <span class="status-label">{label}</span>
      <span class="status-value">{value}</span>
    </div>
  );
}

/** Phase 0 shell: brand, a note about the rebuild, and the live state of the foundation. */
export function Shell() {
  const [w, h] = status.resolution.value;
  const touch = status.device.value === 'mobile';
  return (
    <div class="shell">
      <header class="shell-top">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true" />
          <span class="brand-name">{t('app.title')}</span>
          {status.version.value && <span class="brand-version">{status.version.value}</span>}
        </div>
        <button
          type="button"
          class="link-button"
          onClick={() => setLang(lang.value === 'de' ? 'en' : 'de')}
        >
          {t('lang.switch')}
        </button>
      </header>

      <div class="shell-bottom">
        <section class="card">
          <span class="badge">{t('rebuild.badge')}</span>
          <h1>{t('rebuild.title')}</h1>
          <p>{t('rebuild.text')}</p>
          <p class="hint">{t(touch ? 'rebuild.hint.touch' : 'rebuild.hint.mouse')}</p>
        </section>

        <footer class="status-bar">
          <Status label={t('status.renderer')} value={status.renderer.value || '…'} />
          <Status
            label={t('status.device')}
            value={t(touch ? 'status.device.mobile' : 'status.device.desktop')}
          />
          <Status label={t('status.resolution')} value={w ? `${w} × ${h}` : '…'} />
          <Status label={t('status.fps')} value={String(Math.round(status.fps.value))} />
          <Status label={t('status.sim')} value={`${status.simHz.value} Hz`} />
        </footer>
      </div>
    </div>
  );
}
