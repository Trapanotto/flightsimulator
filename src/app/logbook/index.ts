/**
 * The logbook: records each flight (track, times, landings) and keeps the flights in browser
 * storage. Plain TypeScript; the app feeds it telemetry and writes `game.logbook`.
 */
export { FlightLogger, type FlightLoggerOptions, TRACK_POINTS } from './logger';
export { GeoRunwayFinder, type RunwayFinder, type RunwayHit } from './runways';
export {
  LOGBOOK_CAP,
  LOGBOOK_KEY,
  LOGBOOK_VERSION,
  Logbook,
  parseLogbook,
  worthKeeping,
} from './store';
export { TrackRecorder, type TrackPoint, groundDistance, simplify } from './track';
export type { LandingRecord, LogEntry, LogOutcome, StorageLike } from './types';
