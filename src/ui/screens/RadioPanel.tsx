import { useEffect, useRef } from 'preact/hooks';
import { game } from '../api';
import { pressControl } from '../cockpitMeta';
import { Keycap } from '../components/controls';
import { IconChevronDown, IconChevronUp, IconRadio } from '../components/icons';
import { Panel } from '../components/Panel';
import { t } from '../i18n';
import { actions, showTouch } from '../nav';
import { TUNE_KEY, keyLabel, panels } from '../panels';
import { formatFrequency, hintFrequency } from '../radio';

/** How many messages the panel shows; older ones fade out towards the top. */
const LOG_LINES = 5;

/** Sets the hinted frequency on COM 1 standby and swaps it to active, as a pilot would. */
export function tuneHinted() {
  const khz = hintFrequency(game.atc.value?.hint);
  if (khz === null || !actions.setControl) return;
  actions.setControl('com1Standby', khz);
  pressControl(actions.setControl, 'com1Swap');
}

/**
 * The radio: who is on COM 1, the last calls (the controller's on the left, the pilot's on
 * the right, newest at the bottom) and the replies on offer.
 */
export function RadioPanel(props: { onClose: () => void }) {
  const atc = game.atc.value;
  const logRef = useRef<HTMLOListElement>(null);
  const collapsed = panels.radioCollapsed.value;
  const touch = showTouch.value;
  const log = atc?.log.slice(-LOG_LINES) ?? [];
  const last = log[log.length - 1];
  // The newest call stays in view, also when the panel is squeezed by the space around it.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const toEnd = () => (el.scrollTop = el.scrollHeight);
    toEnd();
    // The box and its content both change size (fonts arriving, the panel squeezed).
    const ro = new ResizeObserver(toEnd);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [last?.time, last?.text, collapsed]);
  if (!atc) return null;
  const hinted = hintFrequency(atc.hint);
  const options = atc.options.slice(0, 4);
  return (
    <Panel
      id="radio"
      class="radio-panel"
      title={atc.station ?? t('radio.noStation')}
      icon={<IconRadio size={18} />}
      collapsed={collapsed}
      onClose={props.onClose}
      aside={
        <span class="radio-freq num">
          <span class="visually-hidden">COM 1 </span>
          {formatFrequency(atc.frequency, 'com')}
          {collapsed && options.length > 0 && (
            <span class="radio-badge" aria-label={t('radio.replies')}>
              {options.length}
            </span>
          )}
        </span>
      }
      actions={
        <button
          type="button"
          class="panel-btn"
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'panel.expand' : 'panel.collapse')}
          title={t(collapsed ? 'panel.expand' : 'panel.collapse')}
          onClick={() => (panels.radioCollapsed.value = !collapsed)}
        >
          {collapsed ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
        </button>
      }
    >
      <ol class="radio-log" ref={logRef} aria-label={t('radio.log')} aria-live="polite">
        {log.length === 0 && <li class="radio-empty">{t('radio.empty')}</li>}
        {log.map((m, i) => (
          <li
            key={`${m.time}-${i}`}
            class={`radio-msg is-${m.from}`}
            style={{ '--age': log.length - 1 - i }}
          >
            <span class="radio-who caps">{m.from === 'pilot' ? t('radio.you') : m.station}</span>
            <span class="radio-text">{m.text}</span>
          </li>
        ))}
      </ol>
      {atc.hint && (
        <div class="radio-hint">
          <span class="radio-hint-text">
            <span class="caps">{t('radio.next')}</span>
            <span class="radio-hint-value">{atc.hint}</span>
          </span>
          {hinted !== null && actions.setControl && (
            <button
              type="button"
              class="btn radio-tune"
              aria-label={t('radio.tune.label', { f: formatFrequency(hinted, 'com') })}
              onClick={tuneHinted}
            >
              {t('radio.tune')}
              {!touch && <Keycap>{keyLabel(TUNE_KEY)}</Keycap>}
            </button>
          )}
        </div>
      )}
      {options.length > 0 && (
        <div class="radio-options" role="group" aria-label={t('radio.replies')}>
          {options.map((o, i) => (
            <button
              type="button"
              key={o.id}
              class="radio-option"
              onClick={() => actions.atcReply?.(o.id)}
            >
              {!touch && <Keycap>{i + 1}</Keycap>}
              <span class="radio-option-text">{o.text}</span>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}
