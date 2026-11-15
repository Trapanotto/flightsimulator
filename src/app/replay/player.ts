import type { game } from '@ui';
import type { FlightRecording, ReplayFrame } from './recording';

/** `ReplayView` of the interface contract (`@ui` does not export the type by name). */
export type ReplayView = NonNullable<(typeof game)['replay']['value']>;

/** The speeds the replay bar offers. */
export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

/**
 * Plays a recording back: a play head in flight seconds that runs at a chosen speed and stops
 * at the end. The recording is not changed; while it is shown the app stops recording.
 */
export class ReplayPlayer {
  time: number;
  playing = true;
  speed = 1;
  private readonly out: ReplayFrame;

  constructor(readonly recording: FlightRecording) {
    this.out = recording.createFrame();
    this.time = recording.start;
  }

  get start() {
    return this.recording.start;
  }

  get end() {
    return this.recording.end;
  }

  /**
   * Moves the play head by a frame's real time. Returns the flight seconds that passed (pass
   * them to `visual.update` so propellers turn at the recorded speed); 0 while paused.
   */
  advance(realDt: number): number {
    // The oldest frames may have been overwritten since the last call.
    const from = Math.min(Math.max(this.time, this.start), this.end);
    if (!this.playing) {
      this.time = from;
      return 0;
    }
    if (from >= this.end) {
      this.time = this.end;
      this.playing = false;
      return 0;
    }
    this.time = Math.min(from + Math.max(0, realDt) * this.speed, this.end);
    if (this.time >= this.end) this.playing = false;
    return this.time - from;
  }

  /** Jumps to a time of the recording (clamped). */
  seek(time: number) {
    this.time = Math.min(Math.max(time, this.start), this.end);
  }

  /** Plays from the start again when asked to play at the end. */
  play(playing: boolean) {
    if (playing && this.time >= this.end) this.time = this.start;
    this.playing = playing && this.end > this.start;
  }

  setSpeed(speed: number) {
    this.speed = Math.min(Math.max(speed, REPLAY_SPEEDS[0]), REPLAY_SPEEDS[5]);
  }

  /** The flight at the play head; the same object every call. */
  frame(): ReplayFrame {
    return this.recording.sample(this.time, this.out);
  }

  /** For `game.replay` (a new object each call, as a signal wants). */
  view(): ReplayView {
    return {
      time: this.time,
      start: this.start,
      end: this.end,
      playing: this.playing,
      speed: this.speed,
    };
  }
}
