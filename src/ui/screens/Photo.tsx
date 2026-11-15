import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { type PhotoSettings, game } from '../api';
import { Slider, Toggle } from '../components/controls';
import { IconCamera, IconClose, IconHide, IconPlane } from '../components/icons';
import { useEscape } from '../focus';
import { MINUS, formatClock } from '../format';
import { t } from '../i18n';
import { actions, showTouch } from '../nav';

/** What the panel shows before the app has delivered `game.photo`. */
const FALLBACK: PhotoSettings = { fov: 50, roll: 0, time: 12, aircraft: true };

function degrees(v: number): string {
  const r = Math.round(v);
  return `${r < 0 ? MINUS : ''}${Math.abs(r)}°`;
}

/** A tap: short and nearly still, so a drag of the camera never counts. */
const TAP_MS = 400;
const TAP_PX = 10;

/**
 * The photo mode: the flight frozen, a free camera (the app's), and a small panel that can
 * itself be hidden for a clean view (H, the eye button; a tap or click anywhere brings it
 * back). The shutter asks the app for the picture, which it renders without the interface.
 */
export function PhotoMode() {
  const p = game.photo.value ?? FALLBACK;
  const hidden = useSignal(false);
  const shots = useSignal(0);
  const told = useSignal(false);
  const touch = showTouch.value;
  const set = (patch: Partial<PhotoSettings>) => actions.photoSet?.(patch);

  useEscape(() => actions.closePhoto?.());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        e.stopImmediatePropagation();
        hidden.value = !hidden.value;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Hidden: a tap anywhere shows the panel again. Listened for on the window, so the camera
  // keeps every drag; only a short still press counts.
  useEffect(() => {
    if (!hidden.value) return;
    let down: { x: number; y: number; t: number; id: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || down.id !== e.pointerId) return;
      const still = Math.hypot(e.clientX - down.x, e.clientY - down.y) < TAP_PX;
      if (still && e.timeStamp - down.t < TAP_MS) hidden.value = false;
      down = null;
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
    };
  }, [hidden.value]);

  // How to get the panel back, said once for a moment after hiding it.
  useEffect(() => {
    if (!hidden.value) return;
    told.value = true;
    const id = setTimeout(() => (told.value = false), 2400);
    return () => clearTimeout(id);
  }, [hidden.value]);

  // "Saved" is said for a moment after each picture.
  useEffect(() => {
    if (!shots.value) return;
    const id = setTimeout(() => (shots.value = 0), 1800);
    return () => clearTimeout(id);
  }, [shots.value]);

  const shoot = () => {
    actions.photoSave?.();
    shots.value++;
  };

  if (hidden.value)
    return (
      <div class="photo is-hidden">
        {told.value && (
          <p class="photo-told fade-in" role="status">
            {t(touch ? 'photo.shown.touch' : 'photo.shown.mouse')}
          </p>
        )}
      </div>
    );

  return (
    <div class="photo">
      {shots.value > 0 && <div class="photo-flash" key={shots.value} aria-hidden="true" />}
      <section class="photo-panel glass enter" aria-labelledby="photo-title">
        <header class="photo-head">
          <IconCamera size={18} />
          <h2 id="photo-title" class="photo-title">
            {t('photo.title')}
          </h2>
          <button
            type="button"
            class="btn btn--icon btn--ghost photo-btn"
            aria-label={`${t('photo.hide')} (H)`}
            title={`${t('photo.hide')} (H)`}
            onClick={() => (hidden.value = true)}
          >
            <IconHide size={18} />
          </button>
          <button
            type="button"
            class="btn btn--icon btn--ghost photo-btn"
            aria-label={t('photo.close')}
            title={t('photo.close')}
            onClick={() => actions.closePhoto?.()}
          >
            <IconClose size={18} />
          </button>
        </header>
        {actions.photoSet && (
          <div class="photo-fields">
            <label class="photo-field">
              <span class="photo-label">{t('photo.fov')}</span>
              <span class="photo-value num">{degrees(p.fov)}</span>
              <Slider
                label={t('photo.fov')}
                min={10}
                max={100}
                step={1}
                value={p.fov}
                valueText={degrees(p.fov)}
                onInput={(v) => set({ fov: v })}
              />
            </label>
            <label class="photo-field">
              <span class="photo-label">{t('photo.roll')}</span>
              <span class="photo-value num">{degrees(p.roll)}</span>
              <Slider
                label={t('photo.roll')}
                min={-45}
                max={45}
                step={1}
                value={p.roll}
                valueText={degrees(p.roll)}
                onInput={(v) => set({ roll: v })}
              />
            </label>
            <label class="photo-field">
              <span class="photo-label">{t('photo.time')}</span>
              <span class="photo-value num">{formatClock(p.time)}</span>
              <Slider
                label={t('photo.time')}
                min={0}
                max={24}
                step={0.25}
                value={p.time}
                valueText={formatClock(p.time)}
                onInput={(v) => set({ time: v })}
              />
            </label>
            <Toggle
              label={t('photo.aircraft')}
              icon={<IconPlane size={18} />}
              checked={p.aircraft}
              onChange={(v) => set({ aircraft: v })}
            />
          </div>
        )}
        <div class="photo-foot">
          <p class="photo-help">{t(touch ? 'photo.hint.touch' : 'photo.hint.mouse')}</p>
          {actions.photoSave && (
            <button
              type="button"
              class="photo-shutter"
              aria-label={t('photo.shutter')}
              title={t('photo.shutter')}
              onClick={shoot}
            >
              <span class="photo-shutter-ring" aria-hidden="true" />
            </button>
          )}
        </div>
        <p class="visually-hidden" role="status">
          {shots.value > 0 ? t('photo.taken') : ''}
        </p>
      </section>
    </div>
  );
}
