/** Looking lessons up for the menu and the app. */
import type { FlightPlan } from '@ui';
import { LESSONS } from './lessons';
import type { LessonDef, LessonInfo } from './types';

export function findLesson(id: string): LessonDef | undefined {
  return LESSONS.find((l) => l.id === id);
}

/**
 * The flight plan a lesson starts, as a copy the app may change (the interface also sets it
 * into `game.plan`). Undefined for an unknown id.
 */
export function lessonPlan(id: string): FlightPlan | undefined {
  const lesson = findLesson(id);
  return lesson && (JSON.parse(JSON.stringify(lesson.plan)) as FlightPlan);
}

/** The lessons as `game.lessons` lists them, with what was passed. */
export function lessonInfos(
  progress: { isPassed(id: string): boolean } | readonly string[],
  lessons: readonly LessonDef[] = LESSONS,
): LessonInfo[] {
  const passed = (id: string) =>
    Array.isArray(progress)
      ? progress.includes(id)
      : (progress as { isPassed(id: string): boolean }).isPassed(id);
  return lessons.map((l) => ({
    id: l.id,
    title: l.title,
    summary: l.summary,
    aircraft: l.aircraft,
    minutes: l.minutes,
    done: passed(l.id),
  }));
}
