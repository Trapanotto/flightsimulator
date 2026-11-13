/**
 * ui – menus, flight planning and on-screen displays (Preact). Talks to the rest of the app
 * through signals (`status`) and callbacks, never through the renderer.
 * Depends on: the other packages' public types.
 */
import { h, render } from 'preact';
import type { UiActions } from './api';
import { Shell } from './Shell';
import './styles.css';

export { status } from './state';
export {
  type AirportOption,
  type FlightPlan,
  type Screen,
  type StartPlace,
  type UiActions,
  game,
  settings,
  touchInput,
} from './api';
export { ALL_MESSAGES, type Lang, type MessageKey, lang, setLang, t } from './i18n';

/** Mounts the interface into `root` and returns a function that removes it. */
export function mountUi(root: HTMLElement, _actions?: UiActions): () => void {
  render(h(Shell, {}), root);
  return () => render(null, root);
}
