import { AIRCRAFT } from '@sim';
import { useEffect, useRef } from 'preact/hooks';
import { type LessonInfo, game } from '../api';
import { CategoryIcon, IconArrowRight, IconBack, IconCheck, IconClock } from '../components/icons';
import { categoryOf, shortName } from '../fleet';
import { arrowNav, useDialog } from '../focus';
import { t, tr } from '../i18n';
import { suggestedLesson } from '../logbook';
import { actions, nav } from '../nav';

function LessonCard({ lesson, index, next }: { lesson: LessonInfo; index: number; next: boolean }) {
  const info = AIRCRAFT.find((a) => a.id === lesson.aircraft);
  const id = `lesson-${lesson.id}`;
  return (
    <li
      class={`lesson${next ? ' is-next' : ''}${lesson.done ? ' is-done' : ''}`}
      style={{ '--i': Math.min(index, 8) }}
    >
      <article aria-labelledby={`${id}-title`} aria-describedby={`${id}-sum`}>
        <header class="lesson-head">
          <span class="lesson-num num" aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span class="visually-hidden">{t('school.lesson', { n: index + 1 })}</span>
          {next && <span class="lesson-tag lesson-tag--next">{t('school.next')}</span>}
          {lesson.done && (
            <span class="lesson-tag lesson-tag--done">
              <IconCheck size={14} />
              {t('school.done')}
            </span>
          )}
        </header>
        <h2 class="lesson-title" id={`${id}-title`}>
          {tr(lesson.title)}
        </h2>
        <p class="lesson-sum" id={`${id}-sum`}>
          {tr(lesson.summary)}
        </p>
        <p class="lesson-meta">
          <span>
            <CategoryIcon category={categoryOf(info)} size={16} />
            {info ? shortName(info) : lesson.aircraft.toUpperCase()}
          </span>
          <span class="num">
            <IconClock size={16} />
            {t('school.minutes', { n: lesson.minutes })}
          </span>
        </p>
        <button
          type="button"
          class={`btn lesson-go${next ? ' btn--primary' : ''}`}
          data-autofocus={next ? '' : undefined}
          aria-describedby={`${id}-title`}
          onClick={() => actions.startLesson?.(lesson.id)}
        >
          {lesson.done ? t('school.again') : t('school.start')}
          <IconArrowRight size={18} />
        </button>
      </article>
    </li>
  );
}

/**
 * The flight school: the lessons in teaching order, as cards. The first one not yet passed is
 * the suggestion (highlighted, focused first); every lesson can be flown at any time, since a
 * pilot coming back may want to practise one again.
 */
export function FlightSchool() {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const back = () => (nav.page.value = 'main');
  useDialog(ref, back);
  // Further down the course the suggestion is below the fold: bring it into view once.
  useEffect(() => {
    ref.current?.querySelector('.lesson.is-next')?.scrollIntoView({ block: 'nearest' });
  }, []);
  const lessons = game.lessons.value;
  const next = suggestedLesson(lessons);
  const done = lessons.filter((l) => l.done).length;
  return (
    <div
      ref={ref}
      class="setup school enter"
      role="dialog"
      aria-modal="true"
      aria-labelledby="school-title"
    >
      <header class="setup-head">
        <button
          type="button"
          class="btn btn--ghost setup-back"
          aria-label={t('setup.back')}
          onClick={back}
          data-autofocus={next ? undefined : ''}
        >
          <IconBack />
          <span class="setup-back-text">{t('setup.backShort')}</span>
        </button>
        <h1 id="school-title" class="setup-title">
          {t('school.title')}
        </h1>
        {lessons.length > 0 && (
          <span class="school-progress num">
            <span
              class="school-meter"
              role="progressbar"
              aria-label={t('school.progress', { d: done, n: lessons.length })}
              aria-valuemin={0}
              aria-valuemax={lessons.length}
              aria-valuenow={done}
            >
              <span style={{ transform: `scaleX(${done / lessons.length})` }} />
            </span>
            {t('school.progress', { d: done, n: lessons.length })}
          </span>
        )}
      </header>
      <div class="school-body">
        <p class="school-intro">{t('school.intro')}</p>
        {lessons.length === 0 ? (
          <div class="empty">
            <span class="empty-title">{t('school.empty')}</span>
            <span class="empty-hint">{t('school.empty.hint')}</span>
          </div>
        ) : (
          <ol
            ref={listRef}
            class="lesson-list"
            aria-label={t('school.list')}
            onKeyDown={(e) => arrowNav(e, listRef.current, '.lesson-go', 'both')}
          >
            {lessons.map((l, i) => (
              <LessonCard key={l.id} lesson={l} index={i} next={l === next} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
