import { t } from '../i18n';
import { status } from '../state';

/** Renderer, frame rate and resolution; only with `?debug` in the address. */
export function DebugOverlay() {
  const [w, h] = status.resolution.value;
  return (
    <dl class="debug num" aria-hidden="true">
      <div>
        <dt>{t('status.renderer')}</dt>
        <dd>{status.renderer.value || '…'}</dd>
      </div>
      <div>
        <dt>{t('status.fps')}</dt>
        <dd>{Math.round(status.fps.value)}</dd>
      </div>
      <div>
        <dt>{t('status.resolution')}</dt>
        <dd>{w ? `${w}×${h}` : '…'}</dd>
      </div>
      <div>
        <dt>{t('status.device')}</dt>
        <dd>
          {t(status.device.value === 'mobile' ? 'status.device.mobile' : 'status.device.desktop')}
        </dd>
      </div>
    </dl>
  );
}
