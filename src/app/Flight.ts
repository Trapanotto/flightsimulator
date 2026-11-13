import type { Object3D } from 'three/webgpu';
import type { LocalFrame } from '@geo';
import {
  type AircraftState,
  type Environment,
  FixedStep,
  type InitialCondition,
  type SimAircraft,
} from '@sim';
import { type RenderPose, copyState, emptyState, lerpState, stateToRenderPose } from './pose';

/**
 * One flight: the simulated aircraft advanced in fixed steps, and where to draw it between
 * steps. Rendering always shows a blend of the last two simulation states, so motion is
 * smooth at any frame rate.
 */
export class Flight {
  private readonly loop = new FixedStep();
  private readonly previous: AircraftState = emptyState();
  private readonly blended: AircraftState = emptyState();
  private readonly pose: RenderPose = {
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
  };
  paused = false;

  constructor(
    readonly aircraft: SimAircraft,
    private readonly env: Environment,
    private readonly start: InitialCondition,
  ) {
    this.restart();
  }

  /** Back to the start of this flight. */
  restart() {
    this.aircraft.reset(this.start, this.env);
    copyState(this.aircraft.state, this.previous);
    this.loop.reset();
  }

  /**
   * Advances the simulation by the frame time. `beforeStep` runs before each fixed step
   * (the pilot's input is applied there).
   */
  advance(frameDt: number, beforeStep: (dt: number) => void): number {
    if (this.paused) return 1;
    return this.loop.advance(frameDt, (dt) => {
      copyState(this.aircraft.state, this.previous);
      beforeStep(dt);
      this.aircraft.step(dt, this.env);
    });
  }

  /** Places the model for drawing: `alpha` blends the last two states. */
  place(object: Object3D, frame: LocalFrame, alpha: number): AircraftState {
    lerpState(this.previous, this.aircraft.state, alpha, this.blended);
    stateToRenderPose(this.blended, frame, this.pose);
    object.position.set(this.pose.position.x, this.pose.position.y, this.pose.position.z);
    const q = this.pose.quaternion;
    object.quaternion.set(q.x, q.y, q.z, q.w);
    return this.blended;
  }

  /** Simulated seconds since the start. */
  get time() {
    return this.loop.time;
  }
}
