/**
 * The flight school: guided lessons from the first take-off to the instrument approach.
 * Plain TypeScript over the telemetry and the cockpit; the app starts a lesson's flight plan,
 * feeds the runner every frame and publishes its view to `game.lesson`.
 */
export { LESSONS } from './lessons';
export { findLesson, lessonInfos, lessonPlan } from './curriculum';
export {
  LessonRunner,
  controlsOf,
  format as formatMeasure,
  type DebriefLine,
  type LessonState,
} from './runner';
export { PROGRESS_KEY, SchoolProgress, type StorageLike } from './progress';
export { RunwayGeometry, type RunwayPosition } from './runway';
export { controlsIn, holds, valueOf, type SchoolContext } from './conditions';
export type {
  Bilingual,
  Bounds,
  Cond,
  ControlValues,
  EventField,
  FailDef,
  HintDef,
  LessonDef,
  LessonInfo,
  LessonView,
  MeasureDef,
  ModeKey,
  Place,
  Reference,
  SchoolKey,
  StepDef,
  ValueKey,
} from './types';
