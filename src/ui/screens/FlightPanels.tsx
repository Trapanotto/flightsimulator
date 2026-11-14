import { computed, useSignal, useSignalEffect } from '@preact/signals';
import type { VNode } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { game, settings } from '../api';
import { avionicsAvailable } from '../cockpitMeta';
import {
  IconAutopilot,
  IconChecklist,
  IconRadio,
  IconStack,
  IconSwitches,
  IconTools,
} from '../components/icons';
import { arrowNav, useEscape } from '../focus';
import { type MessageKey, t } from '../i18n';
import { actions, crashed, showTouch } from '../nav';
import {
  AVIONICS_PANELS,
  PANELS,
  PANEL_KEYS,
  type PanelId,
  flightKeyAction,
  keyLabel,
  panels,
  togglePanel,
} from '../panels';
import { hintFrequency } from '../radio';
import { AutopilotPanel, StackPanel, SwitchesPanel } from './AvionicsPanels';
import { ChecklistHint, ChecklistPanel } from './ChecklistPanel';
import { RadioPanel, tuneHinted } from './RadioPanel';

const PANEL_ICON: Record<PanelId, () => VNode> = {
  radio: () => <IconRadio />,
  checklist: () => <IconChecklist />,
  stack: () => <IconStack />,
  autopilot: () => <IconAutopilot />,
  switches: () => <IconSwitches />,
};

const PANEL_LABEL: Record<PanelId, MessageKey> = {
  radio: 'panel.radio',
  checklist: 'panel.checklist',
  stack: 'panel.stack',
  autopilot: 'panel.autopilot',
  switches: 'panel.switches',
};

/** The panels this flight has something for. */
export const availablePanels = computed<PanelId[]>(() => {
  const av = avionicsAvailable(game.controls.value);
  return PANELS.filter((id) =>
    id === 'radio'
      ? game.atc.value !== null
      : id === 'checklist'
        ? game.checklists.value.length > 0 || game.checklist.value !== null
        : av[id as 'stack' | 'autopilot' | 'switches'],
  );
});

export function toggle(id: PanelId) {
  panels.open.value = togglePanel(panels.open.value, id, showTouch.value);
  panels.toolsOpen.value = false;
}

function close(id: PanelId) {
  panels.open.value = panels.open.value.filter((p) => p !== id);
  // Keyboard users land back on the button that opened it, not on nothing.
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.closest(`[data-panel="${id}"]`)) {
    document.querySelector<HTMLElement>(`[data-tool="${id}"]`)?.focus({ preventScroll: true });
  }
}

/**
 * The interface's keys in flight (panels, radio replies, checklist, tuning). Listens on the
 * window like the app; keys the app uses are never taken (see flightKeyAction).
 */
function useFlightKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      const open = panels.open.value;
      const atc = game.atc.value;
      const checklist = game.checklist.value;
      const action = flightKeyAction(
        {
          code: e.code,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          repeat: e.repeat,
          typing,
        },
        {
          flying: game.screen.value === 'flight' && !crashed.value,
          available: availablePanels.value,
          replies: open.includes('radio') ? (atc?.options.length ?? 0) : 0,
          canCheck: !!checklist?.items.some((i) => i.state === 'current') && !!actions.checkItem,
          canTune: hintFrequency(atc?.hint) !== null && !!actions.setControl,
        },
      );
      if (!action) return;
      e.preventDefault();
      if (action.type === 'toggle') toggle(action.panel);
      else if (action.type === 'reply') {
        const o = atc?.options[action.index];
        if (o) actions.atcReply?.(o.id);
      } else if (action.type === 'check') actions.checkItem?.();
      else tuneHinted();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Desktop: a row of buttons at the bottom right, one per panel, with its key. */
function Toolbar({ list }: { list: PanelId[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const open = panels.open.value;
  return (
    <div
      ref={ref}
      class="tools"
      role="toolbar"
      aria-label={t('tools.open')}
      onKeyDown={(e) => arrowNav(e, ref.current, '.tool', 'horizontal')}
      onMouseDown={(e) => e.preventDefault()}
    >
      {list.map((id) => (
        <button
          type="button"
          key={id}
          data-tool={id}
          class={`tool${open.includes(id) ? ' is-on' : ''}`}
          aria-pressed={open.includes(id)}
          aria-label={`${t(PANEL_LABEL[id])} (${keyLabel(PANEL_KEYS[id])})`}
          title={`${t(PANEL_LABEL[id])} (${keyLabel(PANEL_KEYS[id])})`}
          onClick={() => toggle(id)}
        >
          {PANEL_ICON[id]()}
          <span class="tool-key" aria-hidden="true">
            {keyLabel(PANEL_KEYS[id])}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Touch: the button in the top bar and the menu it opens. */
export function ToolsButton() {
  const list = availablePanels.value;
  if (!list.length) return null;
  const isOpen = panels.toolsOpen.value;
  const anyPanel = panels.open.value.length > 0;
  const replies = (game.atc.value?.options.length ?? 0) > 0 && !panels.open.value.includes('radio');
  return (
    <button
      type="button"
      class={`btn btn--icon btn--glass hud-btn hud-tools${isOpen || anyPanel ? ' is-on' : ''}`}
      aria-label={t('tools.open')}
      aria-expanded={isOpen}
      aria-controls="tools-menu"
      onClick={() => (panels.toolsOpen.value = !isOpen)}
    >
      <IconTools />
      {replies && <span class="tool-dot" aria-hidden="true" />}
    </button>
  );
}

function ToolsMenu({ list }: { list: PanelId[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const shut = () => (panels.toolsOpen.value = false);
  useEscape(shut);
  const open = panels.open.value;
  return (
    <>
      <div class="tools-scrim" onPointerDown={shut} />
      <div
        id="tools-menu"
        ref={ref}
        class="tools-menu glass enter"
        role="menu"
        aria-label={t('tools.open')}
        onKeyDown={(e) => arrowNav(e, ref.current, '[role="menuitemcheckbox"]', 'both')}
      >
        {list.map((id) => (
          <button
            type="button"
            key={id}
            role="menuitemcheckbox"
            aria-checked={open.includes(id)}
            data-tool={id}
            class={`tools-item${open.includes(id) ? ' is-on' : ''}`}
            onClick={() => toggle(id)}
          >
            {PANEL_ICON[id]()}
            <span>{t(PANEL_LABEL[id])}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/** The newest call from the controller as a line of text, while the radio panel is shut. */
export function RadioCaption() {
  const text = useSignal<string | null>(null);
  const seen = useRef<string>('');
  useSignalEffect(() => {
    const log = game.atc.value?.log ?? [];
    const last = [...log].reverse().find((m) => m.from === 'atc');
    const key = last ? `${last.time}|${last.text}` : '';
    if (!last || key === seen.current) return;
    const first = seen.current === '';
    seen.current = key;
    // Not on arrival: only calls that come in during the flight.
    if (first && log.length > 1) return;
    text.value = `${last.station}: ${last.text}`;
    const id = setTimeout(() => (text.value = null), 7000);
    return () => clearTimeout(id);
  });
  const radioShown = panels.open.value.includes('radio') && !panels.radioCollapsed.value;
  if (!text.value || radioShown || !settings.radioText.value) return null;
  return (
    <p class="radio-caption" role="status">
      <IconRadio size={16} />
      <span>{text.value}</span>
    </p>
  );
}

/** The current checklist item shows on the HUD while its panel is closed (a setting). */
export function showChecklistHint(open: readonly PanelId[] = panels.open.value): boolean {
  return settings.checklistHints.value && !open.includes('checklist');
}

/**
 * Every panel of the flight and the ways to open them. On a large screen the radio sits on
 * the left, the checklist on a side of its own, the avionics at the bottom between the cards;
 * on a phone one panel at a time as a sheet between the thumbs.
 */
export function FlightPanels() {
  useFlightKeys();
  const touch = showTouch.value;
  const list = availablePanels.value;
  const open = panels.open.value.filter((p) => list.includes(p));
  const paused = game.screen.value !== 'flight';

  // The radio opens by itself when a flight with a controller begins (on a large screen).
  const hadAtc = useRef(false);
  useSignalEffect(() => {
    const atc = game.atc.value !== null;
    if (atc && !hadAtc.current && !showTouch.peek())
      panels.open.value = togglePanel(
        panels.open.peek().filter((p) => p !== 'radio'),
        'radio',
        false,
      );
    hadAtc.current = atc;
  });

  if (!list.length) return null;
  const panel = (id: PanelId) => {
    const onClose = () => close(id);
    switch (id) {
      case 'radio':
        return <RadioPanel onClose={onClose} key={id} />;
      case 'checklist':
        return <ChecklistPanel onClose={onClose} key={id} />;
      case 'stack':
        return <StackPanel onClose={onClose} key={id} />;
      case 'autopilot':
        return <AutopilotPanel onClose={onClose} key={id} />;
      case 'switches':
        return <SwitchesPanel onClose={onClose} key={id} />;
    }
  };
  const hint = showChecklistHint(open) && <ChecklistHint />;

  if (touch)
    return (
      <div class={`flight-panels is-touch${paused ? ' is-paused' : ''}`} inert={paused}>
        {panels.toolsOpen.value && !paused && <ToolsMenu list={list} />}
        {open[0] && <div class="sheet">{panel(open[0])}</div>}
      </div>
    );

  const side = panels.checklistSide.value;
  const left = open.filter((p) => p === 'radio' || (p === 'checklist' && side === 'left'));
  const right = open.filter((p) => p === 'checklist' && side === 'right');
  const bottom = open.find((p) => AVIONICS_PANELS.includes(p));
  return (
    <div class={`flight-panels${paused ? ' is-paused' : ''}`} inert={paused}>
      <div class="dock dock--left">{left.map(panel)}</div>
      <div class="dock dock--right">
        {right.map(panel)}
        {hint}
        <Toolbar list={list} />
      </div>
      {bottom && <div class="dock dock--bottom">{panel(bottom)}</div>}
    </div>
  );
}
