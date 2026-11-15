import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { game } from '../api';
import { IconCamera, IconClose, IconPause, IconPlay } from '../components/icons';
import { arrowNav, useEscape } from '../focus';
import { t } from '../i18n';
import { REPLAY_SPEEDS, formatReplayTime, formatSpeedFactor } from '../logbook';
import { actions, showTouch } from '../nav';

/** How far the arrow keys jump, seconds. */
const JUMP = 5;

/**
 * The replay: only a slim bar at the bottom, the recorded flight fills the screen. Space
 * plays and pauses, the arrow keys jump, Escape closes (the app's pause key must not act
 * while the flight stands still for the replay, so the bar takes those keys first).
 */
export function ReplayBar() {
  const r = game.replay.value;
  const drag = useSignal<number | null>(null);
  const speedOpen = useSignal(false);
  const speedRef = useRef<HTMLDivElement>(null);
  const speedBtn = useRef<HTMLButtonElement>(null);
  const touch = showTouch.value;

  const closeSpeeds = () => {
    speedOpen.value = false;
    speedBtn.current?.focus({ preventScroll: true });
  };
  useEscape(speedOpen.value ? closeSpeeds : () => actions.closeReplay?.());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      // Inside the speed list the arrows choose a speed.
      if (speedRef.current?.contains(e.target as Node)) return;
      const v = game.replay.peek();
      if (!v) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        e.stopImmediatePropagation();
        actions.replayPlay?.(!v.playing);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const to = v.time + (e.key === 'ArrowLeft' ? -JUMP : JUMP);
        actions.replaySeek?.(Math.max(v.start, Math.min(v.end, to)));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // A press outside the speed list closes it.
  useEffect(() => {
    if (!speedOpen.value) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!speedRef.current?.contains(target) && !speedBtn.current?.contains(target))
        speedOpen.value = false;
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [speedOpen.value]);

  useEffect(() => {
    if (speedOpen.value)
      speedRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [speedOpen.value]);

  const start = r?.start ?? 0;
  const end = Math.max(start, r?.end ?? 0);
  const time = Math.max(start, Math.min(end, drag.value ?? r?.time ?? 0));
  const fill = end > start ? (time - start) / (end - start) : 0;
  const playing = !!r?.playing;
  const speed = r?.speed ?? 1;
  const seek = (v: number) => {
    drag.value = v;
    actions.replaySeek?.(v);
  };

  return (
    <div class="replay fade-in" role="region" aria-label={t('replay.label')}>
      <p class="replay-hint">{t(touch ? 'replay.hint.touch' : 'replay.hint.mouse')}</p>
      <div class="replay-bar glass">
        <button
          type="button"
          class="btn btn--icon replay-play"
          aria-label={t(playing ? 'replay.pause' : 'replay.play')}
          title={t(playing ? 'replay.pause' : 'replay.play')}
          disabled={!r || !actions.replayPlay}
          onClick={() => actions.replayPlay?.(!playing)}
        >
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <span class="replay-time num" aria-hidden="true">
          {formatReplayTime(time)}
        </span>
        <input
          type="range"
          class="slider replay-track"
          aria-label={t('replay.timeline')}
          aria-valuetext={t('replay.time', {
            t: formatReplayTime(time),
            e: formatReplayTime(end),
          })}
          min={start}
          max={end}
          step={0.1}
          value={time}
          disabled={!r || !actions.replaySeek}
          style={`--fill:${(fill * 100).toFixed(2)}%`}
          onInput={(e) => seek(Number((e.currentTarget as HTMLInputElement).value))}
          onChange={() => (drag.value = null)}
          onPointerUp={() => (drag.value = null)}
          onPointerCancel={() => (drag.value = null)}
        />
        <span class="replay-time replay-end num" aria-hidden="true">
          {formatReplayTime(end)}
        </span>
        <div class="replay-tools">
          {actions.replaySpeed && (
            <div class="replay-speed">
              <button
                ref={speedBtn}
                type="button"
                class="btn replay-speed-btn num"
                aria-label={`${t('replay.speed')}: ${formatSpeedFactor(speed)}`}
                aria-haspopup="true"
                aria-expanded={speedOpen.value}
                onClick={() => (speedOpen.value = !speedOpen.value)}
              >
                {formatSpeedFactor(speed)}
              </button>
              {speedOpen.value && (
                <div
                  ref={speedRef}
                  class="replay-speeds glass enter"
                  role="menu"
                  aria-label={t('replay.speed')}
                  onKeyDown={(e) => arrowNav(e, speedRef.current, 'button', 'vertical')}
                >
                  {/* Fastest on top, as on a lever pushed up. */}
                  {[...REPLAY_SPEEDS].reverse().map((s) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      key={s}
                      aria-checked={s === speed}
                      class={`replay-speed-opt num${s === speed ? ' is-on' : ''}`}
                      onClick={() => {
                        actions.replaySpeed?.(s);
                        closeSpeeds();
                      }}
                    >
                      {formatSpeedFactor(s)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {actions.openPhoto && (
            <button
              type="button"
              class="btn btn--icon"
              aria-label={t('replay.photo')}
              title={t('replay.photo')}
              onClick={() => actions.openPhoto?.()}
            >
              <IconCamera />
            </button>
          )}
          <button
            type="button"
            class="btn btn--icon"
            aria-label={t('replay.close')}
            title={t('replay.close')}
            onClick={() => actions.closeReplay?.()}
          >
            <IconClose />
          </button>
        </div>
      </div>
    </div>
  );
}
