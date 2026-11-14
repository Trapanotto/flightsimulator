import { useEffect, useRef } from 'preact/hooks';
import { game } from '../api';
import { Keycap } from '../components/controls';
import { IconBack, IconCheck, IconChecklist, IconSide } from '../components/icons';
import { Panel } from '../components/Panel';
import { t } from '../i18n';
import { actions, showTouch } from '../nav';
import { CHECK_KEY, keyLabel, panels } from '../panels';

/**
 * The checklists: a list to choose from, then the open one with its items. The app moves the
 * current item on as it sees the switches set; items it cannot see are ticked by hand.
 */
export function ChecklistPanel(props: { onClose: () => void }) {
  const list = game.checklists.value;
  const open = game.checklist.value;
  const touch = showTouch.value;
  const bodyRef = useRef<HTMLOListElement>(null);
  const current = open?.items.findIndex((i) => i.state === 'current') ?? -1;
  const done = open?.items.filter((i) => i.state === 'done').length ?? 0;

  // Keep the current item in view as the app moves it on.
  useEffect(() => {
    const ol = bodyRef.current;
    const li = ol?.querySelector<HTMLElement>('.check-item.is-current');
    if (!ol || !li) return;
    const top = li.offsetTop - ol.offsetTop;
    if (top < ol.scrollTop || top + li.offsetHeight > ol.scrollTop + ol.clientHeight)
      ol.scrollTo({ top: Math.max(0, top - ol.clientHeight / 3), behavior: 'smooth' });
  }, [open?.id, current]);

  return (
    <Panel
      id="checklist"
      class="checklist-panel"
      title={open?.title ?? t('checklist.choose')}
      icon={<IconChecklist size={18} />}
      onClose={props.onClose}
      aside={
        open && (
          <span class="check-progress num">
            {t('checklist.progress', { done, n: open.items.length })}
          </span>
        )
      }
      actions={
        !touch && (
          <button
            type="button"
            class="panel-btn"
            aria-label={t('panel.side')}
            title={t('panel.side')}
            onClick={() =>
              (panels.checklistSide.value =
                panels.checklistSide.value === 'right' ? 'left' : 'right')
            }
          >
            <IconSide size={18} />
          </button>
        )
      }
    >
      {!open ? (
        list.length ? (
          <ul class="check-lists">
            {list.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  class="check-list-btn"
                  onClick={() => actions.openChecklist?.(c.id)}
                >
                  {c.title}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p class="panel-empty">{t('checklist.none')}</p>
        )
      ) : (
        <>
          <button type="button" class="check-back" onClick={() => actions.openChecklist?.(null)}>
            <IconBack size={16} />
            {t('checklist.back')}
          </button>
          <ol class="check-items" ref={bodyRef}>
            {open.items.map((item, i) => (
              <li
                key={`${open.id}-${i}`}
                class={`check-item is-${item.state}`}
                aria-current={item.state === 'current' ? 'step' : undefined}
              >
                <span class="check-mark" aria-hidden="true">
                  {item.state === 'done' && <IconCheck size={14} />}
                </span>
                <span class="check-label">{item.label}</span>
                <span class="check-leader" aria-hidden="true" />
                <span class="check-expect">{item.expect}</span>
                <span class="visually-hidden">, {t(`checklist.state.${item.state}`)}</span>
              </li>
            ))}
          </ol>
          <div class="check-foot">
            {current >= 0 ? (
              <button type="button" class="btn check-btn" onClick={() => actions.checkItem?.()}>
                <IconCheck size={18} />
                {t('checklist.check')}
                {!touch && <Keycap>{keyLabel(CHECK_KEY)}</Keycap>}
              </button>
            ) : (
              <p class="check-complete" role="status">
                <IconCheck size={18} />
                {t('checklist.complete')}
              </p>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

/** The current item in one line, for the HUD while the panel is closed. */
export function ChecklistHint() {
  const open = game.checklist.value;
  const item = open?.items.find((i) => i.state === 'current');
  if (!open || !item) return null;
  return (
    <div class="check-hint" role="status">
      <IconChecklist size={16} />
      <span class="check-hint-label">{item.label}</span>
      <span class="check-hint-expect">{item.expect}</span>
    </div>
  );
}
