import { useSignal } from '@preact/signals';
import { AIRCRAFT } from '@sim';
import { useRef } from 'preact/hooks';
import { game } from '../api';
import {
  IconChevronDown,
  IconExit,
  IconPlay,
  IconRestart,
  IconSettings,
  IconWarning,
} from '../components/icons';
import { arrowNav, useDialog } from '../focus';
import { t } from '../i18n';
import { actions, nav, showTouch } from '../nav';
import { FAILURE_IDS } from '../plan';

function flownTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * The pause screen. Esc and P are the app's (it resumes); the dialog itself only traps focus,
 * so the keys keep working the same way everywhere.
 */
/** Failures to trigger for practice; a second choice repairs. */
function FailureList() {
  const active = game.failures.value;
  return (
    <div
      id="pause-failures"
      class="pause-failures fade-in"
      role="group"
      aria-label={t('pause.failure')}
    >
      <p class="pause-failures-hint">{t('pause.failure.hint')}</p>
      {FAILURE_IDS.map((id) => {
        const on = active.includes(id);
        return (
          <button
            type="button"
            key={id}
            class={`btn pause-failure${on ? ' is-on' : ''}`}
            aria-pressed={on}
            onClick={() => actions.setFailure?.(id, !on)}
          >
            <span class="pause-failure-lamp" aria-hidden="true" />
            <span class="pause-failure-text">{t(`failure.${id}`)}</span>
            {on && <span class="pause-failure-state">{t('pause.failure.active')}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function PauseMenu() {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const failuresOpen = useSignal(false);
  useDialog(ref);
  const plan = game.plan.value;
  const airport = game.airports.value.find((a) => a.icao === plan?.airport);
  const info = AIRCRAFT.find((a) => a.id === plan?.aircraft);
  // Read once: the clock stands still while paused, so no subscription is needed.
  const time = game.telemetry.peek()?.time;
  const facts = [
    airport?.name ?? plan?.airport,
    info?.name,
    time !== undefined ? t('pause.flown', { t: flownTime(time) }) : null,
  ].filter(Boolean);

  return (
    <div class="pause-layer fade-in" inert={nav.settingsOpen.value}>
      <div
        ref={ref}
        class="pause glass enter"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pause-title"
      >
        <header class="pause-head">
          <h2 id="pause-title" class="pause-title">
            {t('pause.title')}
          </h2>
          {facts.length > 0 && <p class="pause-facts num">{facts.join(' · ')}</p>}
        </header>
        <div
          ref={listRef}
          class="pause-list"
          onKeyDown={(e) => arrowNav(e, listRef.current, 'button', 'vertical')}
        >
          <button
            type="button"
            class="btn btn--primary btn--block"
            data-autofocus
            onClick={() => actions.resume()}
          >
            <IconPlay />
            {t('pause.resume')}
          </button>
          <button type="button" class="btn btn--block" onClick={() => actions.restart()}>
            <IconRestart />
            {t('pause.restart')}
          </button>
          <button
            type="button"
            class="btn btn--block"
            onClick={() => (nav.settingsOpen.value = true)}
          >
            <IconSettings />
            {t('pause.settings')}
          </button>
          {actions.setFailure && (
            <button
              type="button"
              class={`btn btn--block pause-failure-btn${failuresOpen.value ? ' is-open' : ''}`}
              aria-expanded={failuresOpen.value}
              aria-controls="pause-failures"
              onClick={() => (failuresOpen.value = !failuresOpen.value)}
            >
              <IconWarning />
              {t('pause.failure')}
              <IconChevronDown size={18} />
            </button>
          )}
          {actions.setFailure && failuresOpen.value && <FailureList />}
          <button type="button" class="btn btn--block" onClick={() => actions.exitToMenu()}>
            <IconExit />
            {t('pause.exit')}
          </button>
        </div>
        {!showTouch.value && <p class="pause-hint">{t('pause.hint')}</p>}
      </div>
    </div>
  );
}
