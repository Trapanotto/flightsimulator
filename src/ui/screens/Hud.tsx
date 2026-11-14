import { useComputed, useSignal, useSignalEffect } from '@preact/signals';
import { AIRCRAFT } from '@sim';
import { useEffect, useRef } from 'preact/hooks';
import { game, settings } from '../api';
import { IconExit, IconPause, IconRestart, IconView, IconWarning } from '../components/icons';
import { useDialog } from '../focus';
import {
  altitudeUnit,
  formatAltitude,
  formatHeading,
  formatPercent,
  formatSpeed,
  formatVerticalSpeed,
  speedUnit,
  verticalSpeedUnit,
} from '../format';
import { type MessageKey, isMessageKey, lang, t } from '../i18n';
import { actions, showTouch } from '../nav';
import { autopilotModes } from './AvionicsPanels';
import { ChecklistHint } from './ChecklistPanel';
import { FlightPanels, RadioCaption, ToolsButton, showChecklistHint } from './FlightPanels';

/** Pixels per degree on the heading tape. */
const PX_PER_DEG = 4;
/** The tape spans one and a half turns so the visible window never runs off its end. */
const TAPE_FROM = -180;
const TAPE_TO = 540;

const CARDINAL: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
const CARDINAL_DE: Record<number, string> = { 0: 'N', 90: 'O', 180: 'S', 270: 'W' };

/** Static ticks and labels of the heading tape; built once, then only moved. */
function TapeMarks({ de }: { de: boolean }) {
  const marks = [];
  for (let d = TAPE_FROM; d <= TAPE_TO; d += 5) {
    const h = ((d % 360) + 360) % 360;
    const major = h % 10 === 0;
    const x = (d - TAPE_FROM) * PX_PER_DEG;
    const card = (de ? CARDINAL_DE : CARDINAL)[h];
    marks.push(
      <span key={d} class={`tape-tick${major ? ' is-major' : ''}`} style={{ left: `${x}px` }}>
        {major && (
          <span class={`tape-label${card ? ' is-cardinal' : h % 30 === 0 ? ' is-thirty' : ''}`}>
            {card ?? String(h / 10).padStart(2, '0')}
          </span>
        )}
      </span>,
    );
  }
  return <>{marks}</>;
}

function HeadingTape() {
  const strip = useRef<HTMLDivElement>(null);
  const tel = game.telemetry;
  const hdg = useComputed(() => (tel.value ? formatHeading(tel.value.headingDeg) : '–––'));
  // Writes the transform directly: the tape moves 20 times a second without re-rendering.
  useSignalEffect(() => {
    const h = tel.value?.headingDeg ?? 0;
    const el = strip.current;
    if (!el) return;
    const wrapped = ((h % 360) + 360) % 360;
    el.style.transform = `translate3d(${(-(wrapped - TAPE_FROM) * PX_PER_DEG).toFixed(1)}px,0,0)`;
  });
  return (
    <div class="tape" aria-label={t('hud.hdg')} role="group">
      <div class="tape-window" aria-hidden="true">
        <div class="tape-strip" ref={strip}>
          <TapeMarks de={lang.value === 'de'} />
        </div>
      </div>
      <div class="tape-pointer" aria-hidden="true" />
      <div class="tape-readout num">
        <span class="visually-hidden">{t('hud.hdg')} </span>
        {hdg}
        <span class="tape-deg" aria-hidden="true">
          °
        </span>
      </div>
    </div>
  );
}

function SpeedCard() {
  const tel = game.telemetry;
  const units = settings.units.value;
  const ias = useComputed(() =>
    tel.value ? formatSpeed(tel.value.ias, settings.units.value) : '–',
  );
  return (
    <div class="hud-card hud-speed">
      <span class="hud-label caps">{t('hud.ias')}</span>
      <span class="hud-value num">{ias}</span>
      <span class="hud-unit">{speedUnit(units)}</span>
    </div>
  );
}

function AltitudeCard() {
  const tel = game.telemetry;
  const units = settings.units.value;
  const alt = useComputed(() =>
    tel.value ? formatAltitude(tel.value.altitude, settings.units.value, lang.value) : '–',
  );
  const vs = useComputed(() =>
    tel.value
      ? formatVerticalSpeed(tel.value.verticalSpeed, settings.units.value, lang.value)
      : '–',
  );
  const vsDir = useComputed(() => {
    const v = tel.value?.verticalSpeed ?? 0;
    return `hud-vs-arrow${v > 0.25 ? ' is-up' : v < -0.25 ? ' is-down' : ''}`;
  });
  // Height above the ground matters near it; above about 2500 ft it is noise.
  const agl = useComputed(() => {
    const a = tel.value?.agl;
    return a !== undefined && a < 760 && !tel.value?.onGround
      ? formatAltitude(Math.max(0, a), settings.units.value, lang.value)
      : '';
  });
  const aglClass = useComputed(() => `hud-agl${agl.value ? '' : ' is-hidden'}`);
  return (
    <div class="hud-card hud-alt">
      <span class="hud-label caps">{t('hud.alt')}</span>
      <span class="hud-value num">{alt}</span>
      <span class="hud-unit">{altitudeUnit(units)}</span>
      <span class="hud-vs num">
        <span class={vsDir} aria-hidden="true" />
        <span class="visually-hidden">{t('hud.vs')} </span>
        {vs}
        <span class="hud-vs-unit">{verticalSpeedUnit(units)}</span>
      </span>
      <span class={aglClass}>
        <span class="num">{agl}</span> {altitudeUnit(units)} {t('hud.agl')}
      </span>
    </div>
  );
}

/** Throttle, flaps, gear and brakes; on touch devices the on-screen controls show these. */
function Systems() {
  const tel = game.telemetry;
  const lev = game.levers;
  const throttle = useComputed(() => lev.value?.throttle ?? tel.value?.engines[0]?.power ?? 0);
  const throttleText = useComputed(() => formatPercent(throttle.value));
  const throttleFill = useRef<HTMLSpanElement>(null);
  const flapsText = useComputed(() => formatPercent(tel.value?.flaps ?? lev.value?.flaps ?? 0));
  const flapsFill = useRef<HTMLSpanElement>(null);
  useSignalEffect(() => {
    if (throttleFill.current) throttleFill.current.style.transform = `scaleX(${throttle.value})`;
    const f = tel.value?.flaps ?? lev.value?.flaps ?? 0;
    if (flapsFill.current) flapsFill.current.style.transform = `scaleX(${f})`;
  });
  const gear = useComputed(() => {
    const g = tel.value?.gear ?? 1;
    return g >= 0.99 ? 'down' : g <= 0.01 ? 'up' : 'moving';
  });
  const gearClass = useComputed(() => `sys sys-gear is-${gear.value}`);
  const gearText = useComputed(() =>
    t(
      gear.value === 'down'
        ? 'hud.gear.down'
        : gear.value === 'up'
          ? 'hud.gear.up'
          : 'hud.gear.moving',
    ),
  );
  const brakeClass = useComputed(() => {
    const l = lev.value;
    return `sys sys-brake${l?.parkingBrake ? ' is-park' : l?.brake ? ' is-on' : ''}`;
  });
  const brakeText = useComputed(() =>
    lev.value?.parkingBrake ? t('hud.parking') : t('hud.brake'),
  );
  return (
    <div class="hud-systems hud-card" role="group" aria-label={t('hud.flightData')}>
      <div class="sys sys-bar">
        <span class="sys-label caps">{t('hud.throttle')}</span>
        <span class="sys-meter">
          <span class="sys-fill" ref={throttleFill} />
        </span>
        <span class="sys-value num">
          {throttleText}
          <small>%</small>
        </span>
      </div>
      <div class="sys sys-bar">
        <span class="sys-label caps">{t('hud.flaps')}</span>
        <span class="sys-meter sys-meter--notched">
          <span class="sys-fill" ref={flapsFill} />
        </span>
        <span class="sys-value num">
          {flapsText}
          <small>%</small>
        </span>
      </div>
      <div class="sys-chips">
        <span class={gearClass}>
          <span class="sys-lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span class="sys-chip-text">
            <span class="sys-label caps">{t('hud.gear')}</span>
            <span class="sys-state">{gearText}</span>
          </span>
        </span>
        <span class={brakeClass}>
          <span class="sys-lamp" aria-hidden="true" />
          <span class="sys-state">{brakeText}</span>
        </span>
      </div>
    </div>
  );
}

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

function Warnings() {
  const tel = game.telemetry;
  const stall = useComputed(() => !!tel.value?.stallWarning && !tel.value.crashed);
  const vne = useComputed(() => {
    const info = AIRCRAFT.find((a) => a.id === game.plan.value?.aircraft);
    return !!info && !!tel.value && tel.value.ias > info.vne && !tel.value.crashed;
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

/** Full scale of the needles in pixels, from the centre. */
const CDI_PX = 34;
const GS_PX = 9;

/**
 * NAV 1 at a glance: the station, both needles, the DME and the autopilot's modes. Like the
 * rest of the HUD it never re-renders with the telemetry: text nodes and transforms only,
 * every part a fixed width.
 */
function NavStrip() {
  const tel = game.telemetry;
  const av = useComputed(() => {
    const a = tel.value?.avionics;
    return a?.powered ? a : undefined;
  });
  const ident = useComputed(() => (av.value?.nav1.valid ? av.value.nav1.ident || '–––' : '–––'));
  const cdiClass = useComputed(() => `nav-bar nav-cdi${av.value?.nav1.valid ? '' : ' is-off'}`);
  const gsClass = useComputed(
    () => `nav-bar nav-gs${av.value?.nav1.glideSlope === undefined ? ' is-off' : ''}`,
  );
  const dme = useComputed(() => {
    const d = av.value?.dme.distanceNm;
    return d === undefined ? '–.–' : d >= 100 ? d.toFixed(0) : d.toFixed(1);
  });
  // Green modes already say the autopilot is engaged: 'AP' itself would only take room.
  const apActive = useComputed(() => autopilotModes(av.value?.autopilot).active.slice(1).join(' '));
  const apArmed = useComputed(() => autopilotModes(av.value?.autopilot).armed.join(' '));
  const cdi = useRef<HTMLElement>(null);
  const gs = useRef<HTMLElement>(null);
  useSignalEffect(() => {
    const n = av.value?.nav1;
    const clamp = (v: number | undefined) => Math.max(-1, Math.min(1, v ?? 0));
    if (cdi.current)
      cdi.current.style.transform = `translate3d(${(clamp(n?.valid ? n.deviation : 0) * CDI_PX).toFixed(1)}px,0,0)`;
    if (gs.current)
      gs.current.style.transform = `translate3d(0,${(-clamp(n?.glideSlope) * GS_PX).toFixed(1)}px,0)`;
  });
  return (
    <div class="hud-data nav-strip hud-card" role="group" aria-label={t('nav.strip')}>
      <span class="nav-src caps">NAV 1</span>
      <span class="nav-ident">{ident}</span>
      <span class={cdiClass} role="img" aria-label={t('nav.cdi')}>
        <i class="nav-needle" ref={cdi} />
      </span>
      <span class={gsClass} role="img" aria-label={t('nav.gs')}>
        <i class="nav-needle" ref={gs} />
      </span>
      <span class="nav-dme num">
        {dme}
        <small>NM</small>
      </span>
      <span class="nav-ap num" aria-label={t('nav.ap')}>
        {apActive}
        <span class="nav-ap-armed">{apArmed}</span>
      </span>
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

function CrashPanel({ reason }: { reason: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref);
  return (
    <div class="crash-layer">
      <div
        ref={ref}
        class="crash glass enter"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="crash-title"
        aria-describedby="crash-reason"
      >
        <span class="crash-icon">
          <IconWarning size={26} />
        </span>
        <h2 id="crash-title" class="crash-title">
          {t('crash.title')}
        </h2>
        <p id="crash-reason" class="crash-reason">
          {t(CRASH_TEXT[reason] ?? 'crash.other')}
        </p>
        <div class="crash-actions">
          <button
            type="button"
            class="btn btn--primary"
            data-autofocus
            onClick={() => actions.restart()}
          >
            <IconRestart />
            {t('crash.restart')}
          </button>
          <button type="button" class="btn" onClick={() => actions.exitToMenu()}>
            <IconExit />
            {t('crash.menu')}
          </button>
        </div>
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
  const paused = game.screen.value === 'paused';
  const cockpit = game.view.value === 'cockpit';
  const touch = showTouch.value;
  const crashed = useComputed(() => game.telemetry.value?.crashed);
  const hasAvionics = useComputed(() => !!game.telemetry.value?.avionics);
  const nav = hasAvionics.value && settings.navStrip.value;
  const viewLabel = t(cockpit ? 'hud.view.cockpit' : 'hud.view.outside');

  // Keep focus off the flight buttons, also when the pause dialog hands focus back: Space or
  // Enter on a focused button would trigger it while the pilot flies with the keyboard.
  useEffect(() => {
    if (paused) return;
    if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.ui'))
      document.activeElement.blur();
  }, [paused]);

  return (
    <div
      class={`hud${cockpit ? ' is-cockpit' : ''}${touch ? ' is-touch' : ''}${paused ? ' is-paused' : ''}${nav ? ' has-nav' : ''}`}
      inert={paused}
    >
      <div class="hud-top">
        <button
          type="button"
          class="btn btn--icon btn--glass hud-btn"
          aria-label={`${t('hud.view')} (${viewLabel})`}
          onClick={(e) => {
            actions.toggleView();
            (e.currentTarget as HTMLElement).blur();
          }}
        >
          <IconView />
        </button>
        <div class="hud-data hud-data--tape">
          <HeadingTape />
        </div>
        <button
          type="button"
          class="btn btn--icon btn--glass hud-btn"
          aria-label={t('hud.pause')}
          onClick={() => actions.pause()}
        >
          <IconPause />
        </button>
        {touch && <ToolsButton />}
      </div>
      {nav && <NavStrip />}

      <div class="hud-data hud-side hud-side--left">
        <SpeedCard />
      </div>
      <div class="hud-data hud-side hud-side--right">
        <AltitudeCard />
      </div>
      {!touch && (
        <div class="hud-data hud-bottom-left">
          <Systems />
        </div>
      )}

      <div class="hud-alerts">
        <Warnings />
        <Annunciators />
        <Notice />
        <RadioCaption />
        {touch && showChecklistHint() && <ChecklistHint />}
      </div>

      {!crashed.value && <FlightPanels />}
      {crashed.value && !paused && <CrashPanel reason={crashed.value} />}
    </div>
  );
}
