import { useSignal } from '@preact/signals';
import { useRef } from 'preact/hooks';
import { settings } from '../api';
import { Field, Segmented, Slider, Toggle } from '../components/controls';
import { IconClose, IconMute, IconSound } from '../components/icons';
import { arrowNav, useDialog } from '../focus';
import { type Lang, lang, setLang, t } from '../i18n';
import { nav, showTouch } from '../nav';
import { KEY_ROWS, KeyCombo } from './Briefing';

type Tab = 'general' | 'sound' | 'controls';
const TABS: Tab[] = ['general', 'sound', 'controls'];

/**
 * Turning tilt steering on is a tap, which is what iOS needs to ask for motion access.
 * Returns null when it may be switched on, or the reason it may not.
 */
async function requestTilt(): Promise<'denied' | 'unavailable' | null> {
  if (typeof DeviceOrientationEvent === 'undefined') return 'unavailable';
  const ask = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> })
    .requestPermission;
  if (!ask) return null;
  try {
    return (await ask()) === 'granted' ? null : 'denied';
  } catch {
    return 'denied';
  }
}

function General() {
  return (
    <>
      <Field label={t('settings.quality')} id="set-quality" aside={null}>
        <Segmented
          label={t('settings.quality')}
          class="seg--wrap"
          value={settings.quality.value}
          onChange={(v) => (settings.quality.value = v)}
          options={(['auto', 'low', 'medium', 'high'] as const).map((q) => ({
            value: q,
            label: t(`quality.${q}`),
          }))}
        />
        <p class="field-hint">{t('settings.quality.hint')}</p>
      </Field>
      <Field label={t('settings.units')} id="set-units">
        <Segmented
          label={t('settings.units')}
          value={settings.units.value}
          onChange={(v) => (settings.units.value = v)}
          options={[
            { value: 'aviation', label: t('units.aviation'), sub: t('units.aviation.sub') },
            { value: 'metric', label: t('units.metric'), sub: t('units.metric.sub') },
          ]}
        />
      </Field>
      <Field label={t('settings.language')} id="set-lang">
        <Segmented<Lang>
          label={t('settings.language')}
          value={lang.value}
          onChange={setLang}
          options={[
            { value: 'de', label: t('lang.de') },
            { value: 'en', label: t('lang.en') },
          ]}
        />
      </Field>
    </>
  );
}

function Sound() {
  const v = settings.volume.value;
  const muted = settings.muted.value;
  return (
    <>
      <Field
        label={t('settings.volume')}
        id="set-volume"
        aside={<span class="num">{Math.round(v * 100)}%</span>}
      >
        <div class={`volume-row${muted ? ' is-muted' : ''}`}>
          <IconSound />
          <Slider
            label={t('settings.volume')}
            min={0}
            max={100}
            step={1}
            value={Math.round(v * 100)}
            valueText={`${Math.round(v * 100)}%`}
            onInput={(n) => {
              settings.volume.value = n / 100;
              if (muted && n > 0) settings.muted.value = false;
            }}
          />
        </div>
      </Field>
      <Toggle
        label={t('settings.mute')}
        icon={<IconMute />}
        checked={muted}
        onChange={(m) => (settings.muted.value = m)}
      />
    </>
  );
}

function Controls() {
  const tiltProblem = useSignal<'denied' | 'unavailable' | null>(null);
  return (
    <>
      <div class="toggle-list">
        <Toggle
          label={t('settings.invertPitch')}
          hint={t('settings.invertPitch.hint')}
          checked={settings.invertPitch.value}
          onChange={(v) => (settings.invertPitch.value = v)}
        />
        {showTouch.value && (
          <Toggle
            label={t('settings.tilt')}
            hint={
              tiltProblem.value === 'denied'
                ? t('settings.tilt.denied')
                : tiltProblem.value === 'unavailable'
                  ? t('settings.tilt.unavailable')
                  : t('settings.tilt.hint')
            }
            checked={settings.tiltSteering.value}
            onChange={async (on) => {
              if (!on) {
                settings.tiltSteering.value = false;
                return;
              }
              const problem = await requestTilt();
              tiltProblem.value = problem;
              settings.tiltSteering.value = problem === null;
            }}
          />
        )}
      </div>
      <Field label={t('settings.keys')} id="set-keys">
        <dl class="key-list">
          {KEY_ROWS.map((row) => (
            <div class="key-row" key={row.label}>
              <dt>{t(row.label)}</dt>
              <dd>
                <KeyCombo keys={row.keys} />
              </dd>
            </div>
          ))}
        </dl>
        <p class="field-hint">{t('settings.keys.hint')}</p>
      </Field>
    </>
  );
}

/** Settings as a dialog over the menu or the pause screen; every change applies at once. */
export function SettingsDialog() {
  const ref = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const tab = useSignal<Tab>('general');
  const close = () => (nav.settingsOpen.value = false);
  useDialog(ref, close);
  const label = (k: Tab) => t(`settings.tab.${k}`);

  return (
    <div class="modal-layer fade-in" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        class="settings glass enter"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header class="settings-head">
          <h2 id="settings-title" class="settings-title">
            {t('settings.title')}
          </h2>
          <button
            type="button"
            class="btn btn--icon btn--ghost"
            aria-label={t('settings.close')}
            onClick={close}
          >
            <IconClose />
          </button>
        </header>
        <div
          ref={tabsRef}
          class="tabs"
          role="tablist"
          aria-label={t('settings.title')}
          onKeyDown={(e) => arrowNav(e, tabsRef.current, '[role="tab"]', 'horizontal')?.click()}
        >
          {TABS.map((k) => (
            <button
              type="button"
              role="tab"
              key={k}
              id={`settings-tab-${k}`}
              aria-selected={tab.value === k}
              aria-controls="settings-panel"
              tabIndex={tab.value === k ? 0 : -1}
              class={`tab${tab.value === k ? ' is-on' : ''}`}
              data-autofocus={tab.value === k ? '' : undefined}
              onClick={() => (tab.value = k)}
            >
              {label(k)}
            </button>
          ))}
        </div>
        <div
          id="settings-panel"
          class="settings-body"
          role="tabpanel"
          aria-labelledby={`settings-tab-${tab.value}`}
        >
          {tab.value === 'general' && <General />}
          {tab.value === 'sound' && <Sound />}
          {tab.value === 'controls' && <Controls />}
        </div>
      </div>
    </div>
  );
}
