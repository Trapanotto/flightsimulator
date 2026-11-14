/**
 * Procedures: simulated air traffic control and the checklists of the C172S. Plain
 * TypeScript without DOM or renderer; the app feeds them the flight and shows what they
 * return through `game.atc` and `game.checklist`.
 */
export {
  AtcController,
  type AtcConfig,
  type AtcEvent,
  type AtcInstruction,
  type AtcSituation,
  type AtcState,
  type AtcView,
  type DeviationKind,
  type RadioMessage,
} from './atc';
export {
  type AtcAirport,
  type AtcRunway,
  type AtcStation,
  type AtcWorld,
  BUILTIN_ATC_WORLD,
  type ReportingPoint,
  type StationRole,
  TableAtcWorld,
  runwaysFromGeo,
} from './world';
export { type AtcWeather, type CloudCover, atcWeatherFromSky, runwayInUse } from './weather';
export { type Line } from './phraseology';
export { atcConfigFromPlan, atcSituation } from './adapter';
export {
  C172_CHECKLISTS,
  type Check,
  type ChecklistDef,
  type ChecklistItemDef,
  type TelemetryKey,
} from './checklists';
export { ChecklistRunner, type ChecklistView, type Lang } from './checklistRunner';
