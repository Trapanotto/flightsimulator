/**
 * ui – menus, flight planning and on-screen displays (Preact). Talks to the rest of the app
 * through signals (`status`) and callbacks, never through the renderer.
 * Depends on: the other packages' public types.
 */
import { h, render } from 'preact';
import { Shell } from './Shell';
import './styles.css';

export { status } from './state';
export { ALL_MESSAGES, type Lang, type MessageKey, lang, setLang, t } from './i18n';

/** Mounts the interface into `root` and returns a function that removes it. */
export function mountUi(root: HTMLElement): () => void {
  render(h(Shell, {}), root);
  return () => render(null, root);
}
