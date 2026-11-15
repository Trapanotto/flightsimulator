import type { ControlInput, Telemetry } from '@sim';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Signed difference a - b of two headings in degrees, -180..180. */
const headingDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

/**
 * Feet on the pedals for pilots without pedals.
 *
 * A propeller aircraft pulls to the left at full power and needs rudder to fly straight and
 * to turn cleanly. With a keyboard or a touch screen that is a third hand's work, so while the
 * pilot leaves the rudder alone this keeps the nose where it was on the ground and the
 * slip ball centred in the air. Any rudder input from the pilot takes over at once.
 */
export class RudderAssist {
  enabled = true;
  private holdHeading: number | undefined;
  private lastHeading = 0;
  private command = 0;
  /** Rudder that has turned out to be needed to hold the heading (the pull of the engine). */
  private bias = 0;

  reset() {
    this.holdHeading = undefined;
    this.command = 0;
    this.bias = 0;
  }

  /**
   * Call once per simulation step after the pilot's input has been written to `controls`;
   * adds the assisting rudder to `controls.yaw`.
   */
  apply(dt: number, telemetry: Telemetry, controls: ControlInput) {
    const heading = telemetry.headingDeg;
    const rate = headingDiff(heading, this.lastHeading) / dt;
    this.lastHeading = heading;
    if (!this.enabled || Math.abs(controls.yaw) > 0.02 || telemetry.crashed) {
      // The pilot steers: remember where the nose points for when they let go.
      this.holdHeading = undefined;
      this.command = 0;
      return;
    }
    let want = 0;
    if (telemetry.onGround) {
      if (telemetry.groundSpeed < 1) {
        this.holdHeading = heading;
        this.bias = 0;
      } else {
        this.holdHeading ??= heading;
        // Steer back to the heading held, damped by the turn rate (degrees, degrees/s).
        // A steady pull needs a steady foot: the error also builds up a lasting rudder
        // offset, otherwise the nose would settle a few degrees off.
        const error = headingDiff(this.holdHeading, heading);
        this.bias = clamp(this.bias + 0.5 * error * dt, -0.7, 0.7);
        // Rudder and nose wheel bite harder the faster the aircraft rolls: what steers a
        // Cessna at 50 knots swings an airliner from side to side at 150.
        const k = clamp(20 / telemetry.groundSpeed, 0.2, 1);
        want = clamp(k * (0.35 * error - 0.08 * rate) + this.bias, -1, 1);
      }
    } else {
      this.holdHeading = undefined;
      this.bias = 0;
      // Centre the ball: rudder towards the side the air comes from.
      want = clamp(4 * telemetry.beta, -0.6, 0.6);
    }
    // Feet move quickly but not instantly.
    this.command += clamp(want - this.command, -4 * dt, 4 * dt);
    controls.yaw = clamp(controls.yaw + this.command, -1, 1);
  }
}
