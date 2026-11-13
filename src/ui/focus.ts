import { type RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

/** Elements that take Tab focus inside `root`, in document order, skipping hidden ones. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0 && !el.closest('[inert]'),
  );
}

/**
 * Escape for the topmost overlay. Listens on the window in the capture phase so it runs
 * before the app's own key handling (where Esc means pause/resume), and stops the event:
 * closing a dialog must not also resume the flight.
 */
export function useEscape(onEscape: (() => void) | undefined) {
  useEffect(() => {
    if (!onEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onEscape();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onEscape]);
}

/**
 * Modal focus handling: focus moves in (to `[data-autofocus]` or the first control), Tab is
 * kept inside, Escape calls `onClose`, and focus returns to where it was when the dialog ends.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose?: () => void) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const before = document.activeElement as HTMLElement | null;
    const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(el)[0];
    // preventScroll: a dialog that opens must not move the page behind it.
    (first ?? el).focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables(el);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? i <= 0
          ? items[items.length - 1]
          : items[i - 1]
        : i === items.length - 1
          ? items[0]
          : items[i + 1];
      e.preventDefault();
      next?.focus();
    };
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onKey);
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, []);
  useEscape(onClose);
}

/**
 * Arrow keys move focus between the items of a group (`selector` inside `container`),
 * wrapping at the ends. Returns the newly focused item, or null if the key was not handled.
 */
export function arrowNav(
  e: KeyboardEvent,
  container: HTMLElement | null,
  selector: string,
  orientation: 'vertical' | 'horizontal' | 'both' = 'vertical',
): HTMLElement | null {
  if (!container) return null;
  const prevKeys =
    orientation === 'vertical'
      ? ['ArrowUp']
      : orientation === 'horizontal'
        ? ['ArrowLeft']
        : ['ArrowUp', 'ArrowLeft'];
  const nextKeys =
    orientation === 'vertical'
      ? ['ArrowDown']
      : orientation === 'horizontal'
        ? ['ArrowRight']
        : ['ArrowDown', 'ArrowRight'];
  const items = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.getClientRects().length > 0,
  );
  if (!items.length) return null;
  const i = items.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (prevKeys.includes(e.key)) next = items[i <= 0 ? items.length - 1 : i - 1];
  else if (nextKeys.includes(e.key)) next = items[i < 0 || i === items.length - 1 ? 0 : i + 1];
  else if (e.key === 'Home') next = items[0];
  else if (e.key === 'End') next = items[items.length - 1];
  if (!next) return null;
  e.preventDefault();
  next.focus();
  return next;
}
