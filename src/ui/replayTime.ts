/** The replay bar's numbers: pure functions, tested in Node. */

/** A time of the replay as mm:ss; minutes go on past 59 rather than adding an hour field. */
export function formatReplayTime(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The playback speeds the replay offers (the contract's `replaySpeed`). */
export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

export function formatSpeedFactor(speed: number): string {
  return `${speed}×`;
}
