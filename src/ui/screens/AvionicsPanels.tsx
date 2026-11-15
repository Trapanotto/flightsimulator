import { useSignal } from '@preact/signals';
import type { AutopilotTelemetry, ControlSpec } from '@sim';
import { game } from '../api';
import {
  controlLabel,
  formatControlValue,
  groupLabel,
  positionLabel,
  pressControl,
  stepKnob,
  switchGroups,
} from '../cockpitMeta';
import { Segmented, Slider } from '../components/controls';
import {
  IconAutopilot,
  IconBack,
  IconFast,
  IconChevronDown,
  IconChevronUp,
  IconMinus,
  IconPlus,
  IconStack,
  IconSwap,
  IconSwitches,
} from '../components/icons';
import { Panel, PanelButton } from '../components/Panel';
import { MINUS, formatHeading, groupThousands } from '../format';
import { lang, t } from '../i18n';
import { actions, showTouch } from '../nav';
import {
  type Band,
  VFR_SQUAWK,
  formatFrequency,
  formatSquawk,
  parseFrequency,
  parseSquawk,
  stepFrequency,
} from '../radio';

// --- Reading and writing the cockpit --------------------------------------------------------

function spec(id: string): ControlSpec | undefined {
  return game.controls.value.find((s) => s.id === id);
}

/** A control's value as the app last reported it (its initial value before the first report). */
function value(id: string): number {
  return game.cockpit.value?.[id] ?? spec(id)?.initial ?? 0;
}

function set(id: string, v: number) {
  actions.setControl?.(id, v);
}

function press(id: string) {
  pressControl(actions.setControl, id);
}

const has = (id: string) => game.controls.value.some((s) => s.id === id);

// --- A text field for a frequency or a code -------------------------------------------------

/**
 * Shows a value and takes a typed one: Enter sets it, Escape (or leaving the field) restores
 * what was there. While it has focus the field is the pilot's, not the app's.
 */
function ValueInput(props: {
  value: string;
  label: string;
  invalidText: string;
  parse: (text: string) => number | null;
  onCommit: (v: number) => void;
  class?: string;
  inputMode?: 'decimal' | 'numeric';
}) {
  const editing = useSignal<string | null>(null);
  const invalid = useSignal(false);
  const shown = editing.value ?? props.value;
  const commit = (el: HTMLInputElement) => {
    const v = editing.value === null ? null : props.parse(editing.value);
    if (v === null) {
      invalid.value = true;
      el.select();
      return;
    }
    props.onCommit(v);
    editing.value = null;
    invalid.value = false;
    el.blur();
  };
  return (
    <input
      class={`value-input num ${props.class ?? ''}${invalid.value ? ' is-invalid' : ''}`}
      type="text"
      inputMode={props.inputMode ?? 'decimal'}
      autocomplete="off"
      spellcheck={false}
      aria-label={props.label}
      aria-invalid={invalid.value}
      title={invalid.value ? props.invalidText : props.label}
      value={shown}
      onFocus={(e) => {
        editing.value = shown;
        e.currentTarget.select();
      }}
      onInput={(e) => {
        editing.value = e.currentTarget.value;
        invalid.value = false;
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(e.currentTarget);
        } else if (e.key === 'Escape') {
          // The field's own Escape: it must not also close the panel.
          e.preventDefault();
          e.stopPropagation();
          editing.value = null;
          invalid.value = false;
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        editing.value = null;
        invalid.value = false;
      }}
    />
  );
}

/** A pair of − / + buttons around a caption. */
function Stepper(props: {
  name: string;
  unit: string;
  onStep: (dir: 1 | -1) => void;
  disabled?: boolean;
}) {
  return (
    <span class="stepper">
      <PanelButton
        label={t('stack.down', { radio: props.name, unit: props.unit })}
        onClick={() => props.onStep(-1)}
        disabled={props.disabled}
      >
        <IconMinus size={16} />
      </PanelButton>
      <span class="stepper-unit">{props.unit}</span>
      <PanelButton
        label={t('stack.up', { radio: props.name, unit: props.unit })}
        onClick={() => props.onStep(1)}
        disabled={props.disabled}
      >
        <IconPlus size={16} />
      </PanelButton>
    </span>
  );
}

// --- Radio stack ------------------------------------------------------------------------------

function RadioCard(props: { prefix: 'com1' | 'com2' | 'nav1' | 'nav2'; band: Band }) {
  const { prefix, band } = props;
  const name = prefix.toUpperCase().replace(/(\d)/, ' $1');
  const av = game.telemetry.value?.avionics;
  const nav = band === 'nav' ? av?.[prefix as 'nav1' | 'nav2'] : undefined;
  const active = value(`${prefix}Active`);
  const standby = value(`${prefix}Standby`);
  const step = (coarse: boolean) => (dir: 1 | -1) =>
    set(`${prefix}Standby`, stepFrequency(standby, band, coarse, dir));
  return (
    <div class="radio-card" role="group" aria-label={name}>
      <div class="rc-head">
        <span class="rc-name">{name}</span>
        <span class="rc-active num">
          <span class="visually-hidden">{t('stack.active')} </span>
          {formatFrequency(active, band)}
        </span>
        {nav && <span class={`rc-ident${nav.valid ? '' : ' is-off'}`}>{nav.ident || '–––'}</span>}
      </div>
      <div class="rc-row">
        <PanelButton
          class="rc-swap"
          label={t('stack.swap', { radio: name })}
          onClick={() => press(`${prefix}Swap`)}
        >
          <IconSwap size={18} />
        </PanelButton>
        <ValueInput
          value={formatFrequency(standby, band)}
          label={t('stack.type', { radio: name })}
          invalidText={t('stack.invalid')}
          parse={(s) => parseFrequency(s, band)}
          onCommit={(v) => set(`${prefix}Standby`, v)}
        />
        <Stepper name={name} unit="MHz" onStep={step(true)} />
        <Stepper name={name} unit="kHz" onStep={step(false)} />
      </div>
    </div>
  );
}

function AdfCard() {
  const av = game.telemetry.value?.avionics;
  const f = value('adfFrequency');
  const step = (coarse: boolean) => (dir: 1 | -1) =>
    set('adfFrequency', stepFrequency(f, 'adf', coarse, dir));
  return (
    <div class="radio-card" role="group" aria-label="ADF">
      <div class="rc-head">
        <span class="rc-name">ADF</span>
        <span class="rc-active num">
          {formatFrequency(f, 'adf')}
          <span class="rc-unit"> kHz</span>
        </span>
        {av && (
          <span class={`rc-ident${av.adf.valid ? '' : ' is-off'}`}>{av.adf.ident || '–––'}</span>
        )}
      </div>
      <div class="rc-row">
        <ValueInput
          value={formatFrequency(f, 'adf')}
          label={t('stack.type', { radio: 'ADF' })}
          invalidText={t('stack.invalid')}
          parse={(s) => parseFrequency(s, 'adf')}
          onCommit={(v) => set('adfFrequency', v)}
          inputMode="numeric"
        />
        <Stepper name="ADF" unit="10" onStep={step(true)} />
        <Stepper name="ADF" unit="1" onStep={step(false)} />
      </div>
    </div>
  );
}

function XpdrCard() {
  const s = spec('xpdrMode');
  const av = game.telemetry.value?.avionics;
  const code = value('xpdrCode');
  const mode = value('xpdrMode');
  return (
    <div class="radio-card xpdr-card" role="group" aria-label={controlLabel('xpdrMode')}>
      <div class="rc-head">
        <span class="rc-name">XPDR</span>
        <span class="rc-active num">{formatSquawk(code)}</span>
        {s?.positions && (
          <Segmented<number>
            label={controlLabel('xpdrMode')}
            class="seg--compact"
            value={mode}
            onChange={(v) => set('xpdrMode', v)}
            options={s.positions.map((p, i) => ({ value: i, label: positionLabel('xpdrMode', p) }))}
          />
        )}
      </div>
      <div class="rc-row">
        <ValueInput
          class="xpdr-code"
          value={formatSquawk(code)}
          label={t('stack.code.type')}
          invalidText={t('stack.code.invalid')}
          parse={parseSquawk}
          onCommit={(v) => set('xpdrCode', v)}
          inputMode="numeric"
        />
        <PanelButton
          class="panel-btn--text"
          label={`${t('stack.vfr')} ${VFR_SQUAWK}`}
          onClick={() => set('xpdrCode', VFR_SQUAWK)}
        >
          {t('stack.vfr')}
        </PanelButton>
        <PanelButton
          class={`panel-btn--text${av?.transponder.ident ? ' is-on' : ''}`}
          label={controlLabel('xpdrIdent')}
          onClick={() => press('xpdrIdent')}
        >
          IDENT
        </PanelButton>
        <span
          class={`xpdr-reply${av?.transponder.reply || av?.transponder.ident ? ' is-on' : ''}`}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

/** One line in the panel's header: distance, speed and time, and the receiver it listens to. */
function Dme() {
  const s = spec('dmeSource');
  const dme = game.telemetry.value?.avionics?.dme;
  const dist = dme?.distanceNm;
  return (
    <span class="dme" role="group" aria-label={t('stack.dme')}>
      <span class="rc-name">{t('stack.dme')}</span>
      <span class="dme-read num">
        {dist === undefined ? (
          <span class="dme-off">{t('stack.noSignal')}</span>
        ) : (
          <>
            <span class="dme-big">{dist.toFixed(1)}</span>
            <span class="rc-unit">NM</span>
            <span class="dme-small">
              {dme?.groundSpeedKt !== undefined ? `${Math.round(dme.groundSpeedKt)} kt` : ''}
              {dme?.minutes !== undefined ? ` · ${Math.round(dme.minutes)} min` : ''}
            </span>
          </>
        )}
      </span>
      {s?.positions && (
        <Segmented<number>
          label={controlLabel('dmeSource')}
          class="seg--compact"
          value={value('dmeSource')}
          onChange={(v) => set('dmeSource', v)}
          options={s.positions.map((p, i) => ({ value: i, label: positionLabel('dmeSource', p) }))}
        />
      )}
    </span>
  );
}
/** COM and NAV radios, ADF, transponder and DME, as on the real stack. */
export function StackPanel(props: { onClose: () => void }) {
  const av = game.telemetry.value?.avionics;
  // On a phone the header has no room for it: the DME gets a line of its own.
  const touch = showTouch.value;
  return (
    <Panel
      id="stack"
      class="stack-panel"
      title={t('panel.stack')}
      icon={<IconStack size={18} />}
      onClose={props.onClose}
      aside={
        av && !av.powered ? (
          <span class="panel-warn">{t('stack.off')}</span>
        ) : (
          !touch && has('dmeSource') && <Dme />
        )
      }
    >
      {touch && has('dmeSource') && <Dme />}
      <div class={`stack-grid${av && !av.powered ? ' is-dark' : ''}`}>
        {has('com1Active') && <RadioCard prefix="com1" band="com" />}
        {has('com2Active') && <RadioCard prefix="com2" band="com" />}
        {has('nav1Active') && <RadioCard prefix="nav1" band="nav" />}
        {has('nav2Active') && <RadioCard prefix="nav2" band="nav" />}
        {has('adfFrequency') && <AdfCard />}
        {has('xpdrCode') && <XpdrCard />}
      </div>
    </Panel>
  );
}

// --- Autopilot --------------------------------------------------------------------------------

const LATERAL: Record<AutopilotTelemetry['lateral'], string> = {
  roll: 'ROL',
  hdg: 'HDG',
  nav: 'NAV',
  apr: 'APR',
};
const VERTICAL: Record<AutopilotTelemetry['vertical'], string> = {
  pitch: 'PIT',
  vs: 'VS',
  alt: 'ALT',
  gs: 'GS',
  flc: 'FLC',
};

/** The modes as the autopilot's display shows them: active ones, then armed ones. */
export function autopilotModes(ap: AutopilotTelemetry | undefined): {
  active: string[];
  armed: string[];
} {
  if (!ap?.engaged) return { active: [], armed: [] };
  const armed: string[] = [];
  if (ap.lateralArmed) armed.push(LATERAL[ap.lateralArmed]);
  if (ap.verticalArmed) armed.push(VERTICAL[ap.verticalArmed]);
  return { active: ['AP', LATERAL[ap.lateral], VERTICAL[ap.vertical]], armed };
}

/**
 * What runs beside the autopilot on the types that have it (phase 4): yaw damper, flight
 * director and autothrottle. They work with the autopilot off too, so they are told apart.
 */
export function autopilotHelpers(ap: AutopilotTelemetry | undefined): string[] {
  if (!ap) return [];
  const out: string[] = [];
  if (ap.yawDamper) out.push('YD');
  if (ap.flightDirector) out.push('FD');
  if (ap.autothrottle?.engaged) out.push('A/THR');
  return out;
}

/** The selected speed of FLC or the autothrottle, as the display shows it, or ''. */
export function selectedSpeedText(ap: AutopilotTelemetry | undefined): string {
  if (!ap) return '';
  const uses = ap.vertical === 'flc' || !!ap.autothrottle?.engaged;
  if (!uses) return '';
  if (ap.selectedMach !== undefined) return `M ${ap.selectedMach.toFixed(2)}`;
  return ap.selectedSpeed !== undefined ? `${Math.round(ap.selectedSpeed)} kt` : '';
}

function signedFpm(v: number): string {
  const r = Math.round(v / 100) * 100;
  return `${r > 0 ? '+' : r < 0 ? MINUS : ''}${groupThousands(Math.abs(r), lang.value)}`;
}

/** A knob with fine and coarse steps both ways and its value in between. */
function KnobRow(props: {
  id: string;
  label: string;
  text: string;
  fine: string;
  coarse: string;
  extra?: preact.ComponentChildren;
}) {
  const s = spec(props.id);
  if (!s) return null;
  const step = (coarse: boolean, dir: 1 | -1) =>
    set(props.id, stepKnob(s, value(props.id), coarse, dir));
  return (
    <div class="knob-row" role="group" aria-label={props.label}>
      <span class="knob-label">{props.label}</span>
      <span class="knob-ctl">
        <PanelButton label={`${props.label} −${props.coarse}`} onClick={() => step(true, -1)}>
          <IconFast size={16} />
        </PanelButton>
        <PanelButton label={`${props.label} −${props.fine}`} onClick={() => step(false, -1)}>
          <IconMinus size={16} />
        </PanelButton>
        <output class="knob-value num">{props.text}</output>
        <PanelButton label={`${props.label} +${props.fine}`} onClick={() => step(false, 1)}>
          <IconPlus size={16} />
        </PanelButton>
        <PanelButton
          class="is-flip"
          label={`${props.label} +${props.coarse}`}
          onClick={() => step(true, 1)}
        >
          <IconFast size={16} />
        </PanelButton>
      </span>
      {props.extra}
    </div>
  );
}

/** Mode buttons, annunciations and the knobs the autopilot follows. */
export function AutopilotPanel(props: { onClose: () => void }) {
  const ap = game.telemetry.value?.avionics?.autopilot;
  const modes = autopilotModes(ap);
  const helpers = autopilotHelpers(ap);
  const speed = selectedSpeedText(ap);
  const on = (m: string) => modes.active.includes(m) || helpers.includes(m);
  const armed = (m: string) => modes.armed.includes(m);
  const btn = (id: string, text: string, mode?: string, extra = '') =>
    has(id) && (
      <PanelButton
        key={id}
        class={`ap-btn${mode && armed(mode) ? ' is-armed' : ''}${extra}`}
        label={controlLabel(id)}
        pressed={mode ? on(mode) : undefined}
        onClick={() => press(id)}
      >
        {text}
      </PanelButton>
    );
  const hdg = game.telemetry.value?.instruments?.heading ?? game.telemetry.value?.headingDeg;
  const navSource = spec('navSource');
  // In FLC the pitch wheel picks a speed (nose down is faster), otherwise a vertical speed.
  const wheel = ap?.vertical === 'flc' && ap.engaged ? 'SPD' : 'VS';
  return (
    <Panel
      id="autopilot"
      class="ap-panel"
      title={t('panel.autopilot')}
      icon={<IconAutopilot size={18} />}
      onClose={props.onClose}
    >
      <div class={`ap-display num${ap?.engaged ? ' is-on' : ''}`} role="status">
        <span class="ap-modes">
          {ap?.engaged ? (
            <>
              {modes.active.map((m) => (
                <span class="ap-mode" key={m}>
                  {m}
                </span>
              ))}
              {modes.armed.map((m) => (
                <span class="ap-mode is-armed" key={`a-${m}`}>
                  {m}
                  <span class="visually-hidden"> {t('ap.armed')}</span>
                </span>
              ))}
            </>
          ) : (
            <span class={`ap-mode is-off${ap?.disconnectWarning ? ' is-warn' : ''}`}>
              {ap?.disconnectWarning ? t('ap.disconnect') : t('ap.off')}
            </span>
          )}
        </span>
        {helpers.length > 0 && (
          <span class="ap-helpers">
            {helpers.map((m) => (
              <span class="ap-mode is-helper" key={`h-${m}`}>
                {m}
              </span>
            ))}
          </span>
        )}
        {ap && (
          <span class="ap-sel">
            <span>
              {groupThousands(ap.selectedAltitude, lang.value)}
              <small> ft</small>
            </span>
            {ap.vertical === 'vs' && ap.engaged && (
              <span>
                {signedFpm(ap.selectedVerticalSpeed)}
                <small> ft/min</small>
              </span>
            )}
            {speed && (
              <span title={t('ap.speed')}>
                {speed.endsWith(' kt') ? (
                  <>
                    {speed.slice(0, -3)}
                    <small> kt</small>
                  </>
                ) : (
                  speed
                )}
              </span>
            )}
          </span>
        )}
      </div>
      <div class="ap-buttons" role="group" aria-label={t('ap.modes')}>
        {btn('apEngage', 'AP', 'AP')}
        {btn('yawDamper', 'YD', 'YD')}
        {btn('flightDirector', 'FD', 'FD')}
        {btn('apHdg', 'HDG', 'HDG')}
        {btn('apNav', 'NAV', 'NAV')}
        {btn('apApr', 'APR', 'APR')}
        {btn('apAlt', 'ALT', 'ALT')}
        {btn('apVs', 'VS', 'VS')}
        {btn('apFlc', 'FLC', 'FLC')}
        {has('apVsUp') && (
          <PanelButton
            class="ap-btn"
            label={controlLabel('apVsUp')}
            onClick={() => press('apVsUp')}
          >
            <IconChevronUp size={16} />
            {wheel}
          </PanelButton>
        )}
        {has('apVsDown') && (
          <PanelButton
            class="ap-btn"
            label={controlLabel('apVsDown')}
            onClick={() => press('apVsDown')}
          >
            <IconChevronDown size={16} />
            {wheel}
          </PanelButton>
        )}
        {btn('goAround', 'GA', undefined)}
        {btn('apDisconnect', 'AP DISC', undefined, ' is-disc')}
      </div>
      <div class="knob-rows">
        <KnobRow
          id="apAltitude"
          label={t('ap.altitude')}
          text={`${groupThousands(value('apAltitude'), lang.value)} ft`}
          fine="100 ft"
          coarse="1000 ft"
        />
        <KnobRow
          id="headingBug"
          label={t('ap.heading')}
          text={`${formatHeading(value('headingBug'))}°`}
          fine="1°"
          coarse="10°"
          extra={
            hdg !== undefined && (
              <button
                type="button"
                class="btn knob-sync"
                // A cockpit with its own sync button presses it; otherwise the bug is set.
                onClick={() =>
                  has('headingSync')
                    ? press('headingSync')
                    : set('headingBug', Math.round(hdg) % 360)
                }
              >
                {t('ap.sync')}
              </button>
            )
          }
        />
        <KnobRow
          id="obs1"
          label={t('ap.course')}
          text={`${formatHeading(value('obs1'))}°`}
          fine="1°"
          coarse="10°"
        />
        {navSource?.positions && (
          <div class="knob-row" role="group" aria-label={t('ap.navSource')}>
            <span class="knob-label">{t('ap.navSource')}</span>
            <Segmented<number>
              label={t('ap.navSource')}
              class="seg--compact"
              value={value('navSource')}
              onChange={(v) => set('navSource', v)}
              options={navSource.positions.map((p, i) => ({
                value: i,
                label: positionLabel('navSource', p),
              }))}
            />
          </div>
        )}
      </div>
    </Panel>
  );
}

// --- Switches -----------------------------------------------------------------------------------

/** A selector with many positions: one step either way, the label in between. */
function SelectorStepper({ s }: { s: ControlSpec }) {
  const positions = s.positions ?? [];
  const i = Math.round(value(s.id));
  const label = controlLabel(s.id);
  const next = positions[i + 1];
  // START springs back: it is held, not set.
  const momentaryNext = next === 'start';
  return (
    <span class="sel-step">
      <PanelButton
        label={`${label}: ${positionLabel(s.id, positions[i - 1] ?? '', positions)}`}
        disabled={i <= 0}
        onClick={() => set(s.id, i - 1)}
      >
        <IconBack size={16} />
      </PanelButton>
      <output class="sel-value">{positionLabel(s.id, positions[i] ?? '', positions)}</output>
      {momentaryNext ? (
        <PanelButton
          class="is-flip"
          label={`${label}: ${positionLabel(s.id, next, positions)}`}
          onPress={() => set(s.id, i + 1)}
          onRelease={() => set(s.id, i)}
        >
          <IconBack size={16} />
        </PanelButton>
      ) : (
        <PanelButton
          class="is-flip"
          label={`${label}: ${positionLabel(s.id, next ?? '', positions)}`}
          disabled={next === undefined}
          onClick={() => set(s.id, i + 1)}
        >
          <IconBack size={16} />
        </PanelButton>
      )}
    </span>
  );
}

function ControlRow({ s }: { s: ControlSpec }) {
  const label = controlLabel(s.id);
  const v = value(s.id);
  if (s.kind === 'toggle') {
    const on = v >= 0.5;
    return (
      <button
        type="button"
        role="switch"
        aria-checked={on}
        class={`ctl-row ctl-toggle${on ? ' is-on' : ''}`}
        onClick={() => set(s.id, on ? 0 : 1)}
      >
        <span class="ctl-label">{label}</span>
        <span class="switch" aria-hidden="true">
          <span class="switch-knob" />
        </span>
      </button>
    );
  }
  let control: preact.ComponentChildren;
  if (s.kind === 'selector') {
    const positions = s.positions ?? [];
    const short =
      positions.length <= 4 &&
      positions.every((p) => positionLabel(s.id, p, positions).length <= 6);
    control = short ? (
      <Segmented<number>
        label={label}
        class="seg--compact"
        value={Math.round(v)}
        onChange={(n) => set(s.id, n)}
        options={positions.map((p, i) => ({ value: i, label: positionLabel(s.id, p, positions) }))}
      />
    ) : (
      <SelectorStepper s={s} />
    );
  } else if (s.kind === 'lever') {
    const min = s.min ?? 0;
    const max = s.max ?? 1;
    control = (
      <span class="ctl-lever">
        <Slider
          label={label}
          min={0}
          max={100}
          step={1}
          value={Math.round(((v - min) / (max - min || 1)) * 100)}
          valueText={formatControlValue(s, v)}
          onInput={(n) => set(s.id, min + (n / 100) * (max - min))}
        />
        <output class="ctl-value num">{formatControlValue(s, v)}</output>
      </span>
    );
  } else if (s.kind === 'knob') {
    const many = ((s.max ?? 1) - (s.min ?? 0)) / (s.step ?? 0.05) > 40;
    control = (
      <span class="knob-ctl">
        {many && (
          <PanelButton label={`${label} −10`} onClick={() => set(s.id, stepKnob(s, v, true, -1))}>
            <IconFast size={16} />
          </PanelButton>
        )}
        <PanelButton label={`${label} −`} onClick={() => set(s.id, stepKnob(s, v, false, -1))}>
          <IconMinus size={16} />
        </PanelButton>
        <output class="knob-value num">{formatControlValue(s, v)}</output>
        <PanelButton label={`${label} +`} onClick={() => set(s.id, stepKnob(s, v, false, 1))}>
          <IconPlus size={16} />
        </PanelButton>
        {many && (
          <PanelButton
            class="is-flip"
            label={`${label} +10`}
            onClick={() => set(s.id, stepKnob(s, v, true, 1))}
          >
            <IconFast size={16} />
          </PanelButton>
        )}
      </span>
    );
  } else {
    control = (
      <PanelButton
        class="panel-btn--text"
        label={label}
        onPress={() => set(s.id, 1)}
        onRelease={() => set(s.id, 0)}
      >
        {label}
      </PanelButton>
    );
  }
  return (
    <div class={`ctl-row ctl-${s.kind}`} role="group" aria-label={label}>
      <span class="ctl-label">{label}</span>
      {control}
    </div>
  );
}

/** Everything else in the cockpit, grouped, each control drawn after its kind. */
export function SwitchesPanel(props: { onClose: () => void }) {
  const groups = switchGroups(game.controls.value);
  return (
    <Panel
      id="switches"
      class="switches-panel"
      title={t('panel.switches')}
      icon={<IconSwitches size={18} />}
      onClose={props.onClose}
    >
      <div class="switch-groups">
        {groups.map((g) => (
          <section class="switch-group" key={g.group} aria-labelledby={`sw-${g.group}`}>
            <h3 class="caps" id={`sw-${g.group}`}>
              {groupLabel(g.group, game.controls.value)}
            </h3>
            {g.specs.map((s) => (
              <ControlRow s={s} key={s.id} />
            ))}
          </section>
        ))}
      </div>
    </Panel>
  );
}
