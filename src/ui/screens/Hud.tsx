import { useComputed, useSignal, useSignalEffect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { game, settings, touchInput } from '../api';
import {
  IconChevronDown,
  IconChevronUp,
  IconClose,
  IconExit,
  IconGear,
  IconMore,
  IconPause,
  IconRestart,
  IconReverse,
  IconSpeedbrake,
  IconTools,
  IconView,
  IconWarning,
} from '../components/icons';
import { arrowNav, useEscape } from '../focus';
import { panels } from '../panels';
import {
  altitudeUnit,
  formatAltitude,
  formatHeading,
  formatPercent,
  formatSpeed,
  speedUnit,
} from '../format';
import { overspeedLimit, typeFeatures } from '../fleet';
import { throttleLabel } from '../fleetText';
import { type MessageKey, isMessageKey, lang, t } from '../i18n';
import { actions, flownAircraft, pilotOut, showTouch } from '../nav';
import { LeaveButton, PilotHud } from './PilotHud';
import { useSpeedState } from './HudFleet';
import { ChecklistHint } from './ChecklistPanel';
import { controlLabel, formatControlValue, positionLabel } from '../cockpitMeta';
import {
  FlightPanels,
  PANEL_ICON,
  PANEL_LABEL,
  RadioCaption,
  availablePanels,
  showChecklistHint,
  toggle,
} from './FlightPanels';
import { PANEL_KEYS, keyLabel } from '../panels';

/** game.message as a short notice; a message key is translated, plain text shown as is. */
function Notice() {
  const text = useSignal<string | null>(null);
  const shown = useSignal(false);
  useSignalEffect(() => {
    const m = game.message.value;
    if (!m) {
      shown.value = false;
      return;
    }
    text.value = m;
    shown.value = true;
    const id = setTimeout(() => (shown.value = false), 3200);
    return () => clearTimeout(id);
  });
  const m = text.value;
  return (
    <div class={`notice${shown.value ? ' is-shown' : ''}`} role="status" aria-live="polite">
      {m ? (isMessageKey(m) ? t(m) : m) : ''}
    </div>
  );
}

/** Names the cockpit control under the pointer, with its present setting. */
function ControlHint() {
  const p = game.pointedControl.value;
  if (!p || game.view.value !== 'cockpit') return null;
  const spec = game.controls.value.find((s) => s.id === p.id);
  const value = game.cockpit.value?.[p.id];
  let setting = '';
  if (spec && value !== undefined) {
    if (spec.kind === 'selector') {
      const position = spec.positions?.[Math.round(value)];
      if (position !== undefined)
        setting = positionLabel(p.id, position, spec.positions ?? [position]);
    } else if (spec.kind === 'toggle') setting = t(value ? 'pos.on' : 'pos.off');
    else if (spec.kind !== 'button') setting = formatControlValue(spec, value);
  }
  // Beside the pointer, kept on the screen.
  const left = Math.min(Math.max(p.x, 90), window.innerWidth - 90);
  const below = p.y < 70;
  return (
    <div
      class={`control-hint${below ? ' control-hint--below' : ''}`}
      style={{ left: `${left}px`, top: `${p.y}px` }}
      aria-hidden="true"
    >
      <span class="control-hint-name">{controlLabel(p.id)}</span>
      {setting && <span class="control-hint-value">{setting}</span>}
    </div>
  );
}

function Warnings() {
  const tel = game.telemetry;
  const stall = useComputed(() => !!tel.value?.stallWarning && !tel.value.crashed);
  const vne = useComputed(() => {
    const info = flownAircraft.value;
    return (
      !!info &&
      !!tel.value &&
      tel.value.ias > overspeedLimit(info, tel.value.ias, tel.value.mach) &&
      !tel.value.crashed
    );
  });
  return (
    <div class="warnings" role="alert">
      {stall.value && (
        <span class="warn warn--stall">
          <IconWarning size={18} />
          {t('warn.stall')}
        </span>
      )}
      {vne.value && (
        <span class="warn warn--caution">
          <IconWarning size={18} />
          {t('warn.overspeed')}
        </span>
      )}
    </div>
  );
}

const ANNUNCIATORS = [
  'lowVolts',
  'lowFuelLeft',
  'lowFuelRight',
  'lowVacuum',
  'oilPressure',
] as const;

/** The annunciator panel's lamps that are lit, as quiet amber tags. */
function Annunciators() {
  const lit = useComputed(() => {
    const a = game.telemetry.value?.systems?.annunciators;
    return a ? ANNUNCIATORS.filter((k) => a[k]).join(' ') : '';
  });
  const keys = lit.value ? (lit.value.split(' ') as (typeof ANNUNCIATORS)[number][]) : [];
  return (
    <div class="annun" role="status" aria-label={t('annun.label')}>
      {keys.map((k) => (
        <span class="annun-tag" key={k}>
          {t(`annun.${k}`)}
        </span>
      ))}
    </div>
  );
}

const CRASH_TEXT: Record<string, MessageKey> = {
  ground: 'crash.ground',
  terrain: 'crash.terrain',
  overstress: 'crash.overstress',
  water: 'crash.water',
};

/** Seconds before the strip appears: the impact itself is seen with nothing over it. */
const CRASH_DIALOG_DELAY = 1.5;

/** The crash dialog, once the crash has been seen. */
function CrashPanel({ reason }: { reason: string }) {
  const shown = useSignal(false);
  useEffect(() => {
    const id = setTimeout(() => (shown.value = true), CRASH_DIALOG_DELAY * 1000);
    return () => clearTimeout(id);
  }, []);
  return shown.value ? <CrashDialog reason={reason} /> : null;
}

function CrashDialog({ reason }: { reason: string }) {
  // A slim strip at the bottom, not a dialog: the wreck is what one looks at.
  return (
    <div class="crash-layer">
      <div class="crash enter" role="status" aria-live="polite">
        <span class="crash-icon">
          <IconWarning size={14} />
        </span>
        <span class="crash-title">{t('crash.title')}</span>
        <span class="crash-reason">{t(CRASH_TEXT[reason] ?? 'crash.other')}</span>
        <span class="crash-actions">
          <button type="button" class="crash-btn" onClick={() => actions.restart()}>
            <IconRestart size={14} />
            {t('crash.restart')}
          </button>
          <button type="button" class="crash-btn" onClick={() => actions.exitToMenu()}>
            <IconExit size={14} />
            {t('crash.menu')}
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * The heads-up display. Renders once per flight; the numbers are bound to computed signals
 * (text nodes update in place) and moving parts are written as transforms in effects, so 20
 * telemetry updates a second never re-render the tree.
 */
export function Hud() {
  // Out of the aircraft the aircraft's displays give way to the jumper's.
  return pilotOut.value ? <PilotHud /> : <FlightHud />;
}

/**
 * The flight, kept to the minimum over the picture on every screen: one slim bar with speed,
 * heading and altitude, pause and "more"; warnings in one line under it. Everything else
 * (flaps, gear, speed brake, reverse, view, getting out, the panels) waits in the "more" sheet.
 * On touch the stick and the throttle with the brake are the touch controls'; with keys a
 * small line at the bottom left shows where the levers are, since nothing else would.
 */
function FlightHud() {
  const touch = showTouch.value;
  const paused = game.screen.value === 'paused';
  const tel = game.telemetry;
  const crashed = useComputed(() => tel.value?.crashed);
  const info = flownAircraft.value;
  const speedState = useSpeedState(info);
  const more = useSignal(false);
  const replies = useComputed(
    () => (game.atc.value?.options.length ?? 0) > 0 && !panels.open.value.includes('radio'),
  );
  const units = settings.units.value;
  const ias = useComputed(() =>
    tel.value ? formatSpeed(tel.value.ias, settings.units.value) : '–',
  );
  const hdg = useComputed(() => (tel.value ? formatHeading(tel.value.headingDeg) : '–––'));
  const alt = useComputed(() =>
    tel.value ? formatAltitude(tel.value.altitude, settings.units.value, lang.value) : '–',
  );
  const vsDir = useComputed(() => {
    const v = tel.value?.verticalSpeed ?? 0;
    return `hud-vs-arrow${v > 0.25 ? ' is-up' : v < -0.25 ? ' is-down' : ''}`;
  });
  const speedClass = useComputed(() => `tbar-item tbar-speed${speedState.value}`);
  // A sheet that was open when the flight was paused or ended does not come back by itself.
  useEffect(() => {
    if (paused || crashed.value) more.value = false;
  }, [paused, crashed.value]);
  useEffect(() => {
    if (paused) return;
    if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.ui'))
      document.activeElement.blur();
  }, [paused]);

  return (
    <div
      class={`hud hud--simple${touch ? ' is-touch' : ''}${game.view.value === 'cockpit' ? ' is-cockpit' : ''}${paused ? ' is-paused' : ''}${crashed.value ? ' is-crashed' : ''}`}
      inert={paused}
    >
      <div class="tbar-row">
        <div class="tbar" role="group" aria-label={t('hud.flightData')}>
          <span class={speedClass}>
            <span class="visually-hidden">{t('hud.ias')} </span>
            <b class="num">{ias}</b>
            <small>{speedUnit(units)}</small>
          </span>
          <span class="tbar-item tbar-hdg">
            <span class="visually-hidden">{t('hud.hdg')} </span>
            <b class="num">{hdg}</b>
            <small>°</small>
          </span>
          <span class="tbar-item tbar-alt">
            <span class="visually-hidden">{t('hud.alt')} </span>
            <b class="num">{alt}</b>
            <small>{altitudeUnit(units)}</small>
            <span class={vsDir} aria-hidden="true" />
          </span>
        </div>
        <button
          type="button"
          class="btn btn--icon btn--glass hud-btn"
          aria-label={t('hud.pause')}
          onClick={() => actions.pause()}
        >
          <IconPause />
        </button>
        <button
          type="button"
          class={`btn btn--icon btn--glass hud-btn${more.value ? ' is-on' : ''}`}
          aria-label={t('more.open')}
          aria-expanded={more.value}
          aria-controls="more-sheet"
          onClick={() => (more.value = !more.value)}
        >
          <IconMore />
          {replies.value && <span class="tool-dot" aria-hidden="true" />}
        </button>
      </div>

      {!touch && !crashed.value && <LeverLine />}
      <ControlHint />
      <div class="hud-alerts">
        <Warnings />
        <Annunciators />
        <Notice />
        <RadioCaption />
        {showChecklistHint() && <ChecklistHint />}
      </div>

      {!crashed.value && <FlightPanels />}
      {more.value && !paused && !crashed.value && (
        <MoreSheet onClose={() => (more.value = false)} />
      )}
      {crashed.value && !paused && <CrashPanel reason={crashed.value} />}
    </div>
  );
}

/** One large button of the "more" sheet: an icon, what it does, and its state below. */
function MoreButton(props: {
  label: string;
  state?: string;
  icon: preact.JSX.Element;
  on?: boolean;
  /** The key that does the same, shown on keyboard screens. */
  keyHint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class={`more-btn${props.on ? ' is-on' : ''}`}
      aria-pressed={props.on}
      onClick={props.onClick}
    >
      {props.icon}
      <span class="more-label">{props.label}</span>
      {props.state && <span class="more-state num">{props.state}</span>}
      {props.keyHint && !showTouch.value && <kbd class="more-key">{props.keyHint}</kbd>}
    </button>
  );
}

/**
 * Everything of the flight that is not stick and throttle, as large buttons in a sheet from
 * the bottom. It writes the same `touchInput` the old button pad did: counters for flaps and
 * gear, values for the speed brake and reverse.
 */
function MoreSheet({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  const info = flownAircraft.value;
  const f = typeFeatures(info);
  const tel = game.telemetry.value;
  const lev = game.levers.value;
  const flaps = formatPercent(tel?.flaps ?? lev?.flaps ?? 0);
  const g = tel?.gear ?? 1;
  const gear = g >= 0.99 ? 'hud.gear.down' : g <= 0.01 ? 'hud.gear.up' : 'hud.gear.moving';
  const sbOn = (touchInput.speedbrake.value ?? lev?.speedbrake ?? 0) > 0.5;
  const revOn = touchInput.reverse.value || !!lev?.reverse;
  const cockpit = game.view.value === 'cockpit';
  const hasPanels = availablePanels.value.length > 0;
  const touch = showTouch.value;
  return (
    <>
      <div class="more-scrim" onPointerDown={onClose} />
      <div
        ref={ref}
        id="more-sheet"
        class="more-sheet glass enter"
        role="dialog"
        aria-label={t('more.title')}
        onKeyDown={(e) => arrowNav(e, ref.current, 'button', 'both')}
      >
        <header class="more-head">
          <h2 class="caps">{t('more.title')}</h2>
          <button
            type="button"
            class="btn btn--icon btn--ghost"
            aria-label={t('panel.close')}
            onClick={onClose}
          >
            <IconClose />
          </button>
        </header>
        <div class="more-grid">
          <MoreButton
            label={t('touch.flapsUp')}
            state={`${flaps} %`}
            icon={<IconChevronUp size={24} />}
            onClick={() => touchInput.flapsUp.value++}
          />
          <MoreButton
            label={t('touch.flapsDown')}
            state={`${flaps} %`}
            icon={<IconChevronDown size={24} />}
            onClick={() => touchInput.flapsDown.value++}
          />
          {info?.retractableGear && (
            <MoreButton
              label={t('touch.gear')}
              state={t(gear)}
              icon={<IconGear size={24} />}
              on={g >= 0.99}
              onClick={() => touchInput.gearToggle.value++}
            />
          )}
          {f.speedbrake && (
            <MoreButton
              label={t('touch.speedbrake')}
              state={t(sbOn ? 'more.on' : 'more.off')}
              icon={<IconSpeedbrake size={24} />}
              on={sbOn}
              onClick={() => (touchInput.speedbrake.value = sbOn ? 0 : 1)}
            />
          )}
          {f.reverse && (
            <MoreButton
              label={t('touch.reverse')}
              state={t(revOn ? 'more.on' : 'more.off')}
              icon={<IconReverse size={24} />}
              on={revOn}
              onClick={() => (touchInput.reverse.value = !revOn)}
            />
          )}
          <MoreButton
            label={t('hud.view')}
            state={t(cockpit ? 'hud.view.cockpit' : 'hud.view.outside')}
            icon={<IconView size={24} />}
            onClick={() => {
              actions.toggleView();
              onClose();
            }}
          />
          {hasPanels && touch && (
            <MoreButton
              label={t('more.panels')}
              icon={<IconTools size={24} />}
              onClick={() => {
                onClose();
                panels.toolsOpen.value = true;
              }}
            />
          )}
          {!touch &&
            availablePanels.value.map((id) => (
              <MoreButton
                key={id}
                label={t(PANEL_LABEL[id])}
                icon={PANEL_ICON[id]()}
                keyHint={keyLabel(PANEL_KEYS[id])}
                on={panels.open.value.includes(id)}
                onClick={() => {
                  onClose();
                  toggle(id);
                }}
              />
            ))}
          <LeaveButton onDone={onClose} />
        </div>
      </div>
    </>
  );
}

/**
 * Where the levers are, for a pilot on the keyboard: throttle, flaps, gear and the speed brake
 * where the type has one, as one quiet line in the bottom left corner.
 */
function LeverLine() {
  const info = flownAircraft.value;
  const tel = game.telemetry;
  const lev = game.levers;
  const throttle = useComputed(() =>
    formatPercent(lev.value?.throttle ?? tel.value?.engines[0]?.power ?? 0),
  );
  const flaps = useComputed(() => formatPercent(tel.value?.flaps ?? lev.value?.flaps ?? 0));
  const sb = useComputed(() => formatPercent(lev.value?.speedbrake ?? tel.value?.speedbrake ?? 0));
  const gear = useComputed(() => {
    const g = tel.value?.gear ?? 1;
    return g >= 0.99 ? 'hud.gear.down' : g <= 0.01 ? 'hud.gear.up' : 'hud.gear.moving';
  });
  const brake = useComputed(() =>
    lev.value?.parkingBrake ? 'hud.parking' : lev.value?.brake ? 'hud.brake' : '',
  );
  return (
    <dl class="lever-line num" aria-label={t('hud.flightData')}>
      <div>
        <dt>{throttleLabel(info)}</dt>
        <dd>
          {throttle}
          <small>%</small>
        </dd>
      </div>
      <div>
        <dt>{t('hud.flaps')}</dt>
        <dd>
          {flaps}
          <small>%</small>
        </dd>
      </div>
      {info?.speedbrake && (
        <div>
          <dt>{t('touch.speedbrake')}</dt>
          <dd>
            {sb}
            <small>%</small>
          </dd>
        </div>
      )}
      {info?.retractableGear && (
        <div>
          <dt>{t('hud.gear')}</dt>
          <dd>{t(gear.value as MessageKey)}</dd>
        </div>
      )}
      {brake.value && (
        <div class="is-brake">
          <dd>{t(brake.value as MessageKey)}</dd>
        </div>
      )}
    </dl>
  );
}
