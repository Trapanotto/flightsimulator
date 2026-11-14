import type { ComponentChildren, VNode } from 'preact';
import { t } from '../i18n';
import { IconClose } from './icons';

/**
 * A panel over the flight: glass like the HUD cards, a header with a title and its own
 * buttons, and a body. It never takes focus by itself, and a click inside keeps the focus
 * where it was (on nothing, usually), so the flight keys go on working while it is open.
 * Escape inside it closes it.
 */
export function Panel(props: {
  id: string;
  title: string;
  icon: VNode;
  class?: string;
  /** Extra header content (a frequency, a progress) before the buttons. */
  aside?: ComponentChildren;
  /** Header buttons before the close button. */
  actions?: ComponentChildren;
  onClose: () => void;
  /** Collapsed: only the header shows. */
  collapsed?: boolean;
  children?: ComponentChildren;
}) {
  return (
    <section
      class={`panel ${props.class ?? ''}${props.collapsed ? ' is-collapsed' : ''}`}
      role="region"
      aria-labelledby={`panel-${props.id}-title`}
      data-panel={props.id}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        // Handled here so the app does not take the same Escape as "pause".
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
      }}
      onMouseDown={(e) => {
        // Text fields and sliders need focus to work; everything else stays unfocused.
        if (!(e.target as HTMLElement).closest('input, textarea, select')) e.preventDefault();
      }}
    >
      <header class="panel-head">
        <span class="panel-icon" aria-hidden="true">
          {props.icon}
        </span>
        <h2 class="panel-title" id={`panel-${props.id}-title`}>
          {props.title}
        </h2>
        {props.aside && <div class="panel-aside">{props.aside}</div>}
        <div class="panel-actions">
          {props.actions}
          <button
            type="button"
            class="panel-btn"
            aria-label={`${props.title}: ${t('panel.close')}`}
            title={t('panel.close')}
            onClick={props.onClose}
          >
            <IconClose size={18} />
          </button>
        </div>
      </header>
      {!props.collapsed && <div class="panel-body">{props.children}</div>}
    </section>
  );
}

/** A small square button for panels: steppers, swaps and the like. */
export function PanelButton(props: {
  label: string;
  onClick?: () => void;
  onPress?: () => void;
  onRelease?: () => void;
  class?: string;
  pressed?: boolean;
  disabled?: boolean;
  title?: string;
  children: ComponentChildren;
}) {
  const momentary = !!props.onPress;
  return (
    <button
      type="button"
      class={`panel-btn ${props.class ?? ''}${props.pressed ? ' is-on' : ''}`}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.title ?? props.label}
      disabled={props.disabled}
      onClick={(e) => {
        if (!momentary) props.onClick?.();
        // Keyboard and assistive technology: a press is a press and a release.
        else if (e.detail === 0) {
          props.onPress?.();
          props.onRelease?.();
        }
      }}
      onPointerDown={
        momentary
          ? (e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              props.onPress?.();
            }
          : undefined
      }
      onPointerUp={momentary ? () => props.onRelease?.() : undefined}
      onPointerCancel={momentary ? () => props.onRelease?.() : undefined}
    >
      {props.children}
    </button>
  );
}
