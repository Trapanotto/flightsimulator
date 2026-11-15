import { computed, signal } from '@preact/signals';
import { AIRCRAFT } from '@sim';
import { type UiActions, game } from './api';
import { status } from './state';

/**
 * Navigation inside the interface: pages and dialogs that the app does not need to know
 * about. `game.screen` (written by the app) decides the big picture; these decide what is
 * open within it.
 */
export const nav = {
  /** Page of the main menu. */
  page: signal<'main' | 'setup' | 'hangar'>('main'),
  /** The settings dialog, over the menu or over the pause screen. */
  settingsOpen: signal(false),
};

/** Set by the first touch anywhere: a laptop with a touch screen gets the touch controls too. */
export const touchSeen = signal(false);

/** On-screen flight controls are shown on phones and tablets and after the first touch. */
export const showTouch = computed(() => status.device.value === 'mobile' || touchSeen.value);

/** The type of the flight being prepared or flown (its `info`), or undefined. */
export const flownAircraft = computed(() =>
  AIRCRAFT.find((a) => a.id === game.plan.value?.aircraft),
);

/** The flight has ended in a crash (a boolean, so readers re-render only when it flips). */
export const crashed = computed(() => !!game.telemetry.value?.crashed);

/** `?debug` in the address shows the debug overlay. */
export const debugOn = signal(false);

const noop = () => {};

/** The app's callbacks; harmless no-ops until mountUi() receives real ones. */
export let actions: UiActions = {
  startFlight: noop,
  pause: noop,
  resume: noop,
  restart: noop,
  exitToMenu: noop,
  toggleView: noop,
};

export function setActions(a: UiActions | undefined) {
  if (a) actions = a;
}
