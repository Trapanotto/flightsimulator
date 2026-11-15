import { useEffect, useRef } from 'preact/hooks';
import { game } from '../api';
import {
  IconArrowRight,
  IconCheck,
  IconClose,
  IconReplay,
  IconRestart,
  IconSchool,
  IconWarning,
} from '../components/icons';
import { arrowNav, useDialog } from '../focus';
import { t, tr } from '../i18n';
import { nextLesson } from '../logbook';
import { actions, nav } from '../nav';

/** Segments for the steps; past a dozen they would be slivers, so the text alone counts. */
const MAX_SEGMENTS = 12;

/**
 * What the instructor says now, on the HUD under the heading tape (with the alerts, so a
 * warning still shows below it). It re-renders on its own when `game.lesson` changes, never
 * the rest of the HUD. The instruction is the largest text: it has to be read at a glance
 * while flying.
 */
export function LessonPanel() {
  const ref = useRef<HTMLElement>(null);
  const l = game.lesson.value;
  // The touch layout moves the panel sheets below the card, wherever the card ends up: it
  // grows with a hint and moves down with the navigation strip (a class on the HUD).
  useEffect(() => {
    const el = ref.current;
    const hud = el?.closest<HTMLElement>('.hud');
    if (!el || !hud || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const bottom = el.getBoundingClientRect().bottom - hud.getBoundingClientRect().top;
      hud.style.setProperty('--lesson-bottom', `${Math.ceil(bottom)}px`);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const mo = new MutationObserver(measure);
    mo.observe(hud, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', measure);
      hud.style.removeProperty('--lesson-bottom');
    };
  }, []);
  if (!l) return null;
  const hint = tr(l.hint);
  const segments = l.steps <= MAX_SEGMENTS ? l.steps : 0;
  return (
    <section
      ref={ref}
      class={`lesson-card${hint ? ' has-hint' : ''}`}
      aria-label={`${t('lesson.label')}: ${tr(l.title)}`}
    >
      <header class="lesson-card-head">
        <span class="lesson-card-icon" aria-hidden="true">
          <IconSchool size={16} />
        </span>
        <span class="lesson-card-title">{tr(l.title)}</span>
        <span class="lesson-card-step num">
          {t('lesson.step', { i: Math.min(l.step + 1, l.steps), n: l.steps })}
        </span>
      </header>
      {segments > 0 && (
        <span class="lesson-steps" aria-hidden="true">
          {Array.from({ length: segments }, (_, i) => (
            <i
              key={i}
              class={i < l.step ? 'is-done' : i === l.step && l.state === 'running' ? 'is-now' : ''}
            />
          ))}
        </span>
      )}
      <p class="lesson-card-text" aria-live="polite">
        {tr(l.instruction)}
      </p>
      {hint && (
        <p class="lesson-card-hint" role="status">
          <IconWarning size={16} />
          <span>{hint}</span>
        </p>
      )}
      {l.progress !== undefined && (
        <span
          class="lesson-card-progress"
          role="progressbar"
          aria-label={t('lesson.progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.max(0, Math.min(1, l.progress)) * 100)}
        >
          <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, l.progress))})` }} />
        </span>
      )}
    </section>
  );
}

/**
 * The end of a lesson: passed or not, what went how, and where to go from here. Takes the
 * place of the crash panel (a crash in a lesson fails it, and the debrief says why).
 */
export function LessonDebrief() {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useDialog(ref);
  const l = game.lesson.value;
  if (!l) return null;
  const passed = l.state === 'passed';
  const next = passed ? nextLesson(game.lessons.value, l.id) : undefined;
  const replay = game.canReplay.value && !!actions.openReplay;
  const toSchool = () => {
    // The menu opens on the flight school instead of the main page.
    nav.page.value = 'school';
    actions.exitToMenu();
  };
  const again = () => (actions.startLesson ? actions.startLesson(l.id) : actions.restart());
  return (
    <div class="crash-layer debrief-layer">
      <div
        ref={ref}
        class={`debrief glass enter${passed ? ' is-passed' : ' is-failed'}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="debrief-title"
        aria-describedby="debrief-sub"
      >
        <div class="debrief-main">
          <header class="debrief-head">
            <span class="debrief-icon" aria-hidden="true">
              {passed ? <IconCheck size={26} /> : <IconWarning size={24} />}
            </span>
            <div>
              <p class="caps debrief-lesson">{tr(l.title)}</p>
              <h2 id="debrief-title" class="debrief-title">
                {t(passed ? 'lesson.passed' : 'lesson.failed')}
              </h2>
            </div>
          </header>
          <p id="debrief-sub" class="debrief-sub">
            {t(passed ? 'lesson.passed.sub' : 'lesson.failed.sub')}
          </p>
          {l.debrief && l.debrief.length > 0 && (
            <dl class="debrief-rows" aria-label={t('lesson.debrief')}>
              {l.debrief.map((r, i) => (
                <div key={i} class={`debrief-row${r.ok ? ' is-ok' : ' is-bad'}`}>
                  <dt>
                    <span class="debrief-mark" aria-hidden="true">
                      {r.ok ? <IconCheck size={14} /> : <IconClose size={14} />}
                    </span>
                    {tr(r.label)}
                    <span class="visually-hidden"> ({t(r.ok ? 'lesson.ok' : 'lesson.notOk')})</span>
                  </dt>
                  <dd class="num">{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div
          ref={listRef}
          class="debrief-actions"
          onKeyDown={(e) => arrowNav(e, listRef.current, 'button', 'vertical')}
        >
          {next && actions.startLesson && (
            <button
              type="button"
              class="btn btn--primary"
              data-autofocus
              onClick={() => actions.startLesson?.(next.id)}
            >
              <span class="debrief-next">
                <span>{t('lesson.next')}</span>
                <small>{tr(next.title)}</small>
              </span>
              <IconArrowRight size={20} />
            </button>
          )}
          <button
            type="button"
            class={`btn${next ? '' : ' btn--primary'}`}
            data-autofocus={next ? undefined : ''}
            onClick={again}
          >
            <IconRestart />
            {t('lesson.again')}
          </button>
          {replay && (
            <button type="button" class="btn" onClick={() => actions.openReplay?.()}>
              <IconReplay />
              {t('lesson.replay')}
            </button>
          )}
          <button type="button" class="btn" onClick={toSchool}>
            <IconSchool />
            {t('lesson.school')}
          </button>
        </div>
      </div>
    </div>
  );
}
