import { signal } from '@preact/signals';

/**
 * The in-flight panels (phase 3): the radio dialogue, the checklist and the three avionics
 * panels that stand in for the 3D cockpit on touch devices. Which are open is interface state
 * the app does not need to know.
 */
export type PanelId = 'radio' | 'checklist' | 'stack' | 'autopilot' | 'switches';

export const PANELS: readonly PanelId[] = ['radio', 'checklist', 'stack', 'autopilot', 'switches'];

/** The avionics panels share one place at the bottom of the screen: one at a time. */
export const AVIONICS_PANELS: readonly PanelId[] = ['stack', 'autopilot', 'switches'];

/** KeyboardEvent.code that opens and closes each panel (keys the app does not use). */
export const PANEL_KEYS: Readonly<Record<PanelId, string>> = {
  radio: 'KeyR',
  checklist: 'KeyL',
  stack: 'KeyN',
  autopilot: 'KeyU',
  switches: 'KeyK',
};

/** Ticks the current checklist item. */
export const CHECK_KEY = 'KeyX';
/** Tunes the frequency the controller asked for (COM 1 standby, then swap). */
export const TUNE_KEY = 'KeyT';

/**
 * Opens or closes a panel. On a phone only one panel fits (a bottom sheet); on a larger
 * screen the radio and the checklist have places of their own and stay open next to one
 * avionics panel.
 */
export function togglePanel(open: readonly PanelId[], id: PanelId, single: boolean): PanelId[] {
  if (open.includes(id)) return open.filter((p) => p !== id);
  if (single) return [id];
  const keep = AVIONICS_PANELS.includes(id)
    ? open.filter((p) => !AVIONICS_PANELS.includes(p))
    : [...open];
  return [...keep, id];
}

export interface KeyInput {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  /** The key went to a text field (typing a frequency). */
  typing: boolean;
}

export interface KeyContext {
  /** Flying, not paused, not crashed. */
  flying: boolean;
  /** Panels that have something to show for this flight. */
  available: readonly PanelId[];
  /** Radio replies on offer right now (number keys pick them). */
  replies: number;
  /** A checklist is open and has a current item. */
  canCheck: boolean;
  /** The controller gave a frequency to change to. */
  canTune: boolean;
}

export type KeyAction =
  | { type: 'toggle'; panel: PanelId }
  | { type: 'reply'; index: number }
  | { type: 'check' }
  | { type: 'tune' };

/**
 * What a key press does in flight, or null when it is not the interface's: the app keeps
 * every key it uses. Keys with Ctrl, Alt or Cmd belong to the browser, held keys repeat
 * nothing, and typing into a field is typing.
 */
export function flightKeyAction(k: KeyInput, ctx: KeyContext): KeyAction | null {
  if (!ctx.flying || k.typing || k.repeat || k.ctrlKey || k.altKey || k.metaKey) return null;
  const digit = /^(?:Digit|Numpad)([1-4])$/.exec(k.code);
  if (digit) {
    const index = Number(digit[1]) - 1;
    return index < ctx.replies ? { type: 'reply', index } : null;
  }
  if (k.code === CHECK_KEY) return ctx.canCheck ? { type: 'check' } : null;
  if (k.code === TUNE_KEY) return ctx.canTune ? { type: 'tune' } : null;
  for (const id of PANELS)
    if (PANEL_KEYS[id] === k.code)
      return ctx.available.includes(id) ? { type: 'toggle', panel: id } : null;
  return null;
}

/** The letter printed on a key code's cap ('KeyR' → 'R'). */
export function keyLabel(code: string): string {
  return code.replace(/^Key|^Digit/, '');
}

/** Interface state of the panels. */
export const panels = {
  open: signal<PanelId[]>([]),
  /** Touch: the menu of panels under the top bar. */
  toolsOpen: signal(false),
  /** The radio panel shows only its first line. */
  radioCollapsed: signal(false),
  /** Which edge the checklist sits at on a large screen. */
  checklistSide: signal<'left' | 'right'>('right'),
};
