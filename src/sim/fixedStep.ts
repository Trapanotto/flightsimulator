/** Simulation rate in Hz. Rendering interpolates between steps. */
export const SIM_HZ = 120;
export const SIM_DT = 1 / SIM_HZ;

/**
 * Runs the simulation in fixed steps whatever the frame rate, so a flight is repeatable
 * (replay, tests) and stable on slow devices.
 */
export class FixedStep {
  private accumulator = 0;
  /** Steps taken since the start. */
  steps = 0;

  constructor(
    readonly dt = SIM_DT,
    /** A long frame (tab in the background, a stall) is cut to this many steps. */
    private readonly maxStepsPerFrame = 8,
  ) {}

  /**
   * Call once per frame with the frame time in seconds. Calls `step` zero or more times and
   * returns the blend factor 0..1 between the previous and the current state for rendering.
   */
  advance(frameDt: number, step: (dt: number) => void): number {
    this.accumulator += Math.max(0, frameDt);
    const max = this.maxStepsPerFrame * this.dt;
    if (this.accumulator > max) this.accumulator = max;
    // The epsilon keeps a frame of exactly n steps from losing one to rounding.
    while (this.accumulator >= this.dt - 1e-9) {
      step(this.dt);
      this.accumulator -= this.dt;
      this.steps++;
    }
    if (this.accumulator < 0) this.accumulator = 0;
    return this.accumulator / this.dt;
  }

  /** Simulated time in seconds. */
  get time(): number {
    return this.steps * this.dt;
  }

  reset() {
    this.accumulator = 0;
    this.steps = 0;
  }
}
