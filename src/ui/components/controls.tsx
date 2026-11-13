import type { ComponentChildren, VNode } from 'preact';
import { useRef } from 'preact/hooks';
import { arrowNav } from '../focus';

export interface SegOption<T> {
  value: T;
  label: string;
  sub?: string;
  icon?: VNode;
}

/**
 * A choice of a few options (ARIA radio group): one Tab stop, arrow keys move and select,
 * as a native radio group does.
 */
export function Segmented<T extends string | number>(props: {
  label: string;
  options: SegOption<T>[];
  value: T | undefined;
  onChange: (v: T) => void;
  variant?: 'row' | 'tiles';
  class?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { options, value, onChange } = props;
  const selected = options.findIndex((o) => o.value === value);
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={props.label}
      class={`seg seg--${props.variant ?? 'row'} ${props.class ?? ''}`}
      onKeyDown={(e) => {
        const next = arrowNav(e, ref.current, '[role="radio"]', 'both');
        if (next) next.click();
      }}
    >
      {options.map((o, i) => {
        const on = i === selected;
        return (
          <button
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (selected < 0 && i === 0) ? 0 : -1}
            class={`seg-option${on ? ' is-on' : ''}`}
            onClick={() => onChange(o.value)}
            key={String(o.value)}
          >
            {o.icon}
            <span class="seg-text">
              <span class="seg-label">{o.label}</span>
              {o.sub && <span class="seg-sub">{o.sub}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** An on/off setting: the whole row is the switch, with its label and an optional hint. */
export function Toggle(props: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  icon?: VNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      class={`toggle${props.checked ? ' is-on' : ''}`}
      onClick={() => props.onChange(!props.checked)}
    >
      {props.icon}
      <span class="toggle-text">
        <span class="toggle-label">{props.label}</span>
        {props.hint && <span class="toggle-hint">{props.hint}</span>}
      </span>
      <span class="switch" aria-hidden="true">
        <span class="switch-knob" />
      </span>
    </button>
  );
}

/** A native range input, styled; the filled part of the track follows the value. */
export function Slider(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onInput: (v: number) => void;
  valueText?: string;
  trackStyle?: string;
  class?: string;
  id?: string;
  describedBy?: string;
}) {
  const f = (props.value - props.min) / (props.max - props.min || 1);
  return (
    <input
      id={props.id}
      type="range"
      class={`slider ${props.class ?? ''}`}
      aria-label={props.label}
      aria-valuetext={props.valueText}
      aria-describedby={props.describedBy}
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value}
      style={`--fill:${(f * 100).toFixed(2)}%;${props.trackStyle ?? ''}`}
      onInput={(e) => props.onInput(Number((e.currentTarget as HTMLInputElement).value))}
    />
  );
}

/** A keyboard key as printed on a keycap. */
export function Keycap({ children }: { children: ComponentChildren }) {
  return <kbd class="keycap">{children}</kbd>;
}

/** A labelled group of fields inside a panel. */
export function Field(props: {
  label: string;
  children: ComponentChildren;
  aside?: ComponentChildren;
  id?: string;
}) {
  return (
    <section class="field" aria-labelledby={props.id}>
      <header class="field-head">
        <h3 class="caps" id={props.id}>
          {props.label}
        </h3>
        {props.aside && <div class="field-aside">{props.aside}</div>}
      </header>
      {props.children}
    </section>
  );
}
