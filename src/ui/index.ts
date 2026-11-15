/**
 * ui – menus, flight planning and on-screen displays (Preact). Talks to the rest of the app
 * through signals (`game`, `settings`, `touchInput`, `status`) and callbacks, never through
 * the renderer.
 * Depends on: the other packages' public types (and AIRCRAFT from sim).
 */
import { effect } from '@preact/signals';
import { h, render } from 'preact';
import { App } from './App';
import type { UiActions } from './api';
import { lang } from './i18n';
import { debugOn, setActions, touchSeen } from './nav';
import { browserStorage, persistSettings } from './persist';
import './styles/tokens.css';
import './styles/base.css';
import './styles/controls.css';
import './styles/menu.css';
import './styles/setup.css';
import './styles/briefing.css';
import './styles/hud.css';
import './styles/touch.css';
import './styles/panels.css';
import './styles/dialogs.css';
import './styles/replay.css';
import './styles/startpick.css';
import './styles/pilot.css';

export { status } from './state';
export {
  type AirportOption,
  type RunwayStrip,
  type AtcView,
  type ChecklistView,
  type FrequencyInfo,
  type PlannedFailure,
  type RadioMessage,
  type FlightPlan,
  type Levers,
  type Screen,
  type StartPlace,
  type UiActions,
  type WeatherChoice,
  type WeatherReport,
  type Bilingual,
  type LandingRecord,
  type LessonInfo,
  type LessonView,
  type LogEntry,
  type PhotoSettings,
  type PilotView,
  type ReplayView,
  game,
  settings,
  touchInput,
} from './api';
export { ALL_MESSAGES, type Lang, type MessageKey, lang, setLang, t } from './i18n';
export { nav } from './nav';
/** Which in-flight panels are open (interface state; the demo and tests open them directly). */
export { panels } from './panels';
export { validatePlan } from './plan';
/** Phase 4: the key codes the interface shows for speed brake, reverse and gear (the app binds them). */
export { FLEET_KEYS } from './fleet';

/** Mounts the interface into `root` and returns a function that removes it. */
export function mountUi(root: HTMLElement, actions?: UiActions): () => void {
  setActions(actions);
  debugOn.value = new URLSearchParams(location.search).has('debug');
  const stopSettings = persistSettings(browserStorage());
  const stopLang = effect(() => {
    document.documentElement.lang = lang.value;
  });

  // The first touch anywhere brings the touch controls, also on a laptop with a touch screen.
  const onPointer = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      touchSeen.value = true;
      window.removeEventListener('pointerdown', onPointer, true);
    }
  };
  window.addEventListener('pointerdown', onPointer, true);

  render(h(App, {}), root);
  return () => {
    render(null, root);
    stopSettings();
    stopLang();
    window.removeEventListener('pointerdown', onPointer, true);
  };
}
