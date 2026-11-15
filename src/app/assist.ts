import type { ControlInput, Telemetry } from '@sim';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const DEG = Math.PI / 180;
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
  /**
   * Strength of the steering on the ground, 1 for a light propeller aircraft. A heavy jet
   * answers its rudder and nose wheel slowly and strongly: the same foot swings it from side
   * to side, a light one keeps it on the centre line.
   */
  groundGain = 1;
  /**
   * Centre the ball in the air. Off for aircraft whose flight controls coordinate turns
   * themselves: two helpers on one rudder fight each other.
   */
  coordinate = true;
  private holdHeading: number | undefined;
  private lastHeading = 0;
  private command = 0;
  /** Rudder that has turned out to be needed to hold the heading (the pull of the engine). */
  private bias = 0;
  /**
   * Hold the wings level while the pilot leaves the ailerons alone and the bank is small.
   * In a climb the spiral mode of a propeller aircraft is unstable (the bank doubles every
   * ten seconds or so): a pilot holds it with a finger on the yoke without thinking, a
   * keyboard pilot cannot. A bank the pilot has rolled into (beyond a few degrees) is theirs.
   */
  level = true;
  /** Rudder the air has turned out to need (the climb's steady right foot). */
  private airBias = 0;
  private lastBank = 0;

  reset() {
    this.holdHeading = undefined;
    this.command = 0;
    this.bias = 0;
    this.airBias = 0;
  }

  /**
   * Call once per simulation step after the pilot's input has been written to `controls`;
   * adds the assisting rudder to `controls.yaw`.
   */
  apply(dt: number, telemetry: Telemetry, controls: ControlInput) {
    const heading = telemetry.headingDeg;
    const rate = headingDiff(heading, this.lastHeading) / dt;
    this.lastHeading = heading;
    const rollRate = (telemetry.bank - this.lastBank) / dt;
    this.lastBank = telemetry.bank;
    if (
      this.enabled &&
      this.level &&
      !telemetry.onGround &&
      !telemetry.crashed &&
      Math.abs(controls.roll) < 0.02
    ) {
      // Full help within 6 degrees of bank, none beyond 12: a turn stays a turn.
      const bank = Math.abs(telemetry.bank) / DEG;
      const share = clamp((12 - bank) / 6, 0, 1);
      controls.roll = clamp(
        controls.roll + share * clamp(-1.5 * telemetry.bank - 0.4 * rollRate, -0.12, 0.12),
        -1,
        1,
      );
    }
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
        this.bias = clamp(this.bias + 0.5 * this.groundGain * error * dt, -0.7, 0.7);
        // Rudder and nose wheel bite harder the faster the aircraft rolls: what steers a
        // Cessna at 50 knots swings an airliner from side to side at 150.
        const k = clamp(20 / telemetry.groundSpeed, 0.2, 1);
        want = clamp(this.groundGain * k * (0.35 * error - 0.08 * rate) + this.bias, -1, 1);
      }
    } else {
      this.holdHeading = undefined;
      this.bias = 0;
      // Centre the ball: rudder towards the side the air comes from. A steady need (right
      // rudder in the climb) builds up slowly as a lasting foot, so that no sideslip has to
      // remain to ask for it: a leftover slip rolls the aircraft through its dihedral.
      if (this.coordinate) {
        this.airBias = clamp(this.airBias + 1.2 * telemetry.beta * dt, -0.3, 0.3);
        want = clamp(4 * telemetry.beta + this.airBias, -0.6, 0.6);
      }
    }
    // Feet move quickly but not instantly.
    this.command += clamp(want - this.command, -4 * dt, 4 * dt);
    controls.yaw = clamp(controls.yaw + this.command, -1, 1);
  }
}
