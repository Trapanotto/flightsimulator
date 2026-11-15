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
  SWISS_RADAR,
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
  type Phase,
  type TelemetryKey,
} from './checklists';
export { PC12_CHECKLISTS } from './checklistsPc12';
export { A320_CHECKLISTS } from './checklistsA320';
export { FA18_CHECKLISTS } from './checklistsFa18';
export { ATC_AIRCRAFT, type AtcAircraft, type Category, checklistsFor } from './fleet';
export {
  ChecklistRunner,
  type ChecklistView,
  type Lang,
  evaluate,
  phaseOf,
  telemetryValue,
} from './checklistRunner';
