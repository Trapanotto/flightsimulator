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

  reset() {
    this.holdHeading = undefined;
    this.command = 0;
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
      } else {
        this.holdHeading ??= heading;
        // Steer back to the heading held, damped by the turn rate (degrees, degrees/s).
        const error = headingDiff(this.holdHeading, heading);
        want = clamp(0.12 * error - 0.05 * rate, -1, 1);
      }
    } else {
      this.holdHeading = undefined;
      // Centre the ball: rudder towards the side the air comes from.
      want = clamp(4 * telemetry.beta, -0.6, 0.6);
    }
    // Feet move quickly but not instantly.
    this.command += clamp(want - this.command, -4 * dt, 4 * dt);
    controls.yaw = clamp(controls.yaw + this.command, -1, 1);
  }
}
