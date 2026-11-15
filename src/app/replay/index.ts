/**
 * Replay and photo mode (phase 5): the recorded last minutes of a flight and its playback.
 * Plain TypeScript: tested in Node. The camera of both modes is `FreeCamera` in
 * `../freeCamera.ts`; `savePicture` saves the canvas.
 */
export {
  FlightRecording,
  type RecordSource,
  type RecordingOptions,
  type ReplayFrame,
} from './recording';
export { REPLAY_SPEEDS, ReplayPlayer, type ReplayView } from './player';
export { pictureName, savePicture } from './picture';
