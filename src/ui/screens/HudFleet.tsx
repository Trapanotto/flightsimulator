import { useComputed, useSignalEffect } from '@preact/signals';
import type { AircraftInfo, EngineTelemetry } from '@sim';
import { useRef } from 'preact/hooks';
import { game } from '../api';
import { MACH_SHOWN_FROM, engineKind, overspeedLimit } from '../fleet';
import { formatMach, formatPercent } from '../format';
import { t } from '../i18n';

/**
 * The HUD's parts that differ by type (phase 4). Like the rest of the HUD they render once per
 * flight: values are computed signals bound to text nodes and bars are transforms written in
 * effects, every part a fixed width, so nothing moves when a number changes.
 */

/** Share of VNE the speed band runs to: a little past the red line. */
const BAND_TOP = 1.12;

/**
 * The airspeed against the type's speeds, as on an airspeed indicator: amber below the stall
 * speed, green above it, amber close to the limit and a red line at it (VNE, or at height the
 * airspeed of the maximum Mach number). The pointer is the present airspeed.
 */
export function SpeedBand({ info }: { info: AircraftInfo }) {
  const band = useRef<HTMLSpanElement>(null);
  const pointer = useRef<HTMLElement>(null);
  const top = info.vne * BAND_TOP;
  useSignalEffect(() => {
    const tel = game.telemetry.value;
    const el = band.current;
    if (!tel || !el) return;
    const limit = overspeedLimit(info, tel.ias, tel.mach);
    const stall = (tel.flaps > 0.5 ? info.vs0 : info.vs) / top;
    el.style.setProperty('--stall', `${(stall * 100).toFixed(1)}%`);
    el.style.setProperty('--caution', `${((limit * 0.92 * 100) / top).toFixed(1)}%`);
    el.style.setProperty('--limit', `${((limit * 100) / top).toFixed(1)}%`);
    if (pointer.current) {
      const f = Math.min(1, Math.max(0, tel.ias / top));
      pointer.current.style.transform = `translate3d(${(f * 100).toFixed(1)}cqw,0,0)`;
    }
  });
  return (
    <span class="hud-band" ref={band} aria-hidden="true">
      <i class="hud-band-pointer" ref={pointer} />
    </span>
  );
}

/** How the speed card warns: amber near the stall or the limit, red beyond the limit. */
export function useSpeedState(info: AircraftInfo | undefined) {
  return useComputed(() => {
    const tel = game.telemetry.value;
    if (!info || !tel || tel.crashed) return '';
    const limit = overspeedLimit(info, tel.ias, tel.mach);
    if (tel.ias > limit) return ' is-over';
    if (tel.ias > limit * 0.95) return ' is-near';
    const stall = tel.flaps > 0.5 ? info.vs0 : info.vs;
    if (!tel.onGround && tel.ias < stall * 1.1) return ' is-slow';
    return '';
  });
}

/** Mach number under the airspeed of a fast type, from about Mach 0.4 on (its place kept). */
export function MachRow() {
  const tel = game.telemetry;
  const text = useComputed(() => formatMach(tel.value?.mach ?? 0));
  const cls = useComputed(
    () => `hud-mach num${(tel.value?.mach ?? 0) >= MACH_SHOWN_FROM ? '' : ' is-quiet'}`,
  );
  return (
    <span class={cls} aria-label={t('hud.mach')}>
      {text}
    </span>
  );
}

/** A fighter pilot's two numbers: load factor and angle of attack. */
export function FighterRow() {
  const tel = game.telemetry;
  const g = useComputed(() => (tel.value ? tel.value.loadFactor.toFixed(1) : '–'));
  const aoa = useComputed(() => (tel.value ? ((tel.value.alpha * 180) / Math.PI).toFixed(1) : '–'));
  const gClass = useComputed(() => {
    const n = tel.value?.loadFactor ?? 1;
    return `hud-fx-value num${n > 6 || n < -2 ? ' is-warn' : ''}`;
  });
  return (
    <span class="hud-fx">
      <span class="hud-fx-item" title={t('hud.loadFactor')}>
        <span class="hud-fx-label">G</span>
        <span class={gClass}>{g}</span>
        <span class="visually-hidden">{t('hud.loadFactor')}</span>
      </span>
      <span class="hud-fx-item" title={t('hud.alpha')}>
        <span class="hud-fx-label">α</span>
        <span class="hud-fx-value num">
          {aoa}
          <small>°</small>
        </span>
        <span class="visually-hidden">{t('hud.alpha')}</span>
      </span>
    </span>
  );
}

/** One bar with its value, the shape of the throttle and flaps rows. */
function Bar(props: {
  label: string;
  long: string;
  fill: (tel: NonNullable<typeof game.telemetry.value>) => number;
  text: (tel: NonNullable<typeof game.telemetry.value>) => string;
  unit: string;
  /** A class for the fill while the value is past a limit (or lit, for the speed brake). */
  state?: (tel: NonNullable<typeof game.telemetry.value>) => string;
}) {
  const fill = useRef<HTMLSpanElement>(null);
  const text = useComputed(() => (game.telemetry.value ? props.text(game.telemetry.value) : '–'));
  const cls = useComputed(
    () =>
      `sys-meter${game.telemetry.value && props.state ? props.state(game.telemetry.value) : ''}`,
  );
  useSignalEffect(() => {
    const tel = game.telemetry.value;
    if (fill.current && tel)
      fill.current.style.transform = `scaleX(${Math.min(1, Math.max(0, props.fill(tel)))})`;
  });
  return (
    <div class="sys sys-bar" role="group" aria-label={props.long}>
      <span class="sys-label caps" aria-hidden="true">
        {props.label}
      </span>
      <span class={cls}>
        <span class="sys-fill" ref={fill} />
      </span>
      <span class="sys-value num">
        {text}
        <small>{props.unit}</small>
      </span>
    </div>
  );
}

/** The speed brake's travel, lit amber while it is out. */
export function SpeedbrakeRow() {
  const at = (tel: NonNullable<typeof game.telemetry.value>) =>
    tel.speedbrake ?? game.levers.value?.speedbrake ?? 0;
  return (
    <Bar
      label="SPD BRK"
      long={t('hud.speedbrake')}
      fill={at}
      text={(tel) => formatPercent(at(tel))}
      unit="%"
      state={(tel) => (at(tel) > 0.02 ? ' is-lit' : '')}
    />
  );
}

const ITT_SCALE = 900;
const ITT_LIMIT = 800;

/** One engine's turbine readout by index, for a turboprop or a jet. */
function engine(
  tel: NonNullable<typeof game.telemetry.value>,
  i: number,
): EngineTelemetry | undefined {
  return tel.engines[i];
}

/**
 * The engines: nothing new for a piston engine (the throttle says it), torque and ITT for a
 * turboprop, N1 of each engine side by side for a jet (amber while its afterburner burns).
 */
export function EngineBlock({ info }: { info: AircraftInfo }) {
  const kind = engineKind(info);
  if (kind === 'piston') return null;
  if (kind === 'turboprop')
    return (
      <div class="sys-engines" role="group" aria-label={t('hud.engines')}>
        <Bar
          label="TRQ"
          long={t('hud.torque')}
          fill={(tel) => engine(tel, 0)?.torque ?? 0}
          text={(tel) => String(Math.round((engine(tel, 0)?.torque ?? 0) * 100))}
          unit="%"
          state={(tel) => ((engine(tel, 0)?.torque ?? 0) > 1 ? ' is-over' : '')}
        />
        <Bar
          label="ITT"
          long={t('hud.itt')}
          fill={(tel) => (engine(tel, 0)?.turbineTemperature ?? 0) / ITT_SCALE}
          text={(tel) => String(Math.round(engine(tel, 0)?.turbineTemperature ?? 0))}
          unit="°"
          state={(tel) => ((engine(tel, 0)?.turbineTemperature ?? 0) > ITT_LIMIT ? ' is-over' : '')}
        />
      </div>
    );
  const count = Math.max(1, info.engines);
  return (
    <div class="sys-engines sys-n1" role="group" aria-label={t('hud.n1')}>
      <span class="sys-label caps" aria-hidden="true">
        N1
      </span>
      <span class="sys-n1-pair">
        {Array.from({ length: count }, (_, i) => (
          <N1 key={i} index={i} />
        ))}
      </span>
    </div>
  );
}

function N1({ index }: { index: number }) {
  const fill = useRef<HTMLSpanElement>(null);
  const text = useComputed(() => {
    const n1 = game.telemetry.value?.engines[index]?.n1;
    return n1 === undefined ? '–' : n1.toFixed(1);
  });
  const cls = useComputed(() => {
    const e = game.telemetry.value?.engines[index];
    return `sys-meter${(e?.afterburner ?? 0) > 0.02 ? ' is-ab' : (e?.n1 ?? 0) > 100 ? ' is-over' : ''}`;
  });
  useSignalEffect(() => {
    const n1 = game.telemetry.value?.engines[index]?.n1 ?? 0;
    if (fill.current)
      fill.current.style.transform = `scaleX(${Math.min(1, Math.max(0, n1 / 105))})`;
  });
  return (
    <span class="sys-n1-engine">
      <span class={cls}>
        <span class="sys-fill" ref={fill} />
      </span>
      <span class="sys-value num">{text}</span>
    </span>
  );
}

/** Reverse (the types that have it) or afterburner (the fighter) as a lamp beside the gear. */
export function FleetChips({ info }: { info: AircraftInfo }) {
  const reverse = useComputed(
    () => !!game.levers.value?.reverse || !!game.telemetry.value?.engines.some((e) => e.reversing),
  );
  const ab = useComputed(
    () => !!game.telemetry.value?.engines.some((e) => (e.afterburner ?? 0) > 0.02),
  );
  const fighter = engineKind(info) === 'jet' && !info.reverse;
  return (
    <>
      {info.reverse && (
        <span class={`sys sys-lampchip${reverse.value ? ' is-on' : ''}`}>
          <span class="sys-lamp" aria-hidden="true" />
          <span class="sys-state" title={t('hud.reverse')}>
            REV
            <span class="visually-hidden"> {t('hud.reverse')}</span>
          </span>
        </span>
      )}
      {fighter && (
        <span class={`sys sys-lampchip is-ab${ab.value ? ' is-on' : ''}`}>
          <span class="sys-lamp" aria-hidden="true" />
          <span class="sys-state" title={t('hud.afterburner')}>
            AB
            <span class="visually-hidden"> {t('hud.afterburner')}</span>
          </span>
        </span>
      )}
    </>
  );
}
