import { Quaternion, Vector3 } from 'three';

const SENS = 0.0022; // rad per pixel
/** Steepest bank the mouse flight asks for, rad. */
const MAX_BANK = 0.75;
const tmpQ = new Quaternion();
const tmp = new Vector3();

/**
 * Mouse flight ("fly where you look"): the mouse moves an aim direction, a small autopilot
 * turns the aircraft towards it. Pointer lock is requested on click; Esc releases it.
 */
export class MouseAim {
  readonly direction = new Vector3(0, 0, 1);
  enabled = true;
  private locked = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('click', this.onClick);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMove);
  }

  get active(): boolean {
    return this.enabled && this.locked;
  }

  dispose() {
    this.canvas.removeEventListener('click', this.onClick);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('mousemove', this.onMove);
    if (this.locked) document.exitPointerLock();
  }

  /** Points the aim at `dir` (e.g. aircraft nose after a reset). */
  reset(dir: Vector3) {
    this.direction.copy(dir).normalize();
  }

  /** Keeps the aim from drifting below the horizon too far etc. Call each frame. */
  private pendingX = 0;
  private pendingY = 0;
  update(worldUp: Vector3) {
    if (!this.active) {
      this.pendingX = this.pendingY = 0;
      return;
    }
    // Yaw about the local vertical, pitch about the aim's horizontal right axis.
    tmpQ.setFromAxisAngle(worldUp, -this.pendingX * SENS);
    this.direction.applyQuaternion(tmpQ);
    tmp.crossVectors(this.direction, worldUp).normalize();
    const elevation = Math.asin(Math.max(-1, Math.min(1, this.direction.dot(worldUp))));
    const dPitch = Math.max(-1.45 - elevation, Math.min(1.45 - elevation, -this.pendingY * SENS));
    tmpQ.setFromAxisAngle(tmp, dPitch);
    this.direction.applyQuaternion(tmpQ).normalize();
    this.pendingX = this.pendingY = 0;
  }

  /**
   * Stick commands that turn an aircraft with the given body axes towards the aim, like a
   * pilot: bank in proportion to the heading error (wings level once the nose points at the
   * aim), pull the nose onto the aim in the aircraft's own frame. The rudder is left to the
   * yaw damper, which keeps the turn coordinated.
   */
  steer(forward: Vector3, up: Vector3, right: Vector3, worldUp: Vector3) {
    const d = this.direction;
    const clamp = (v: number, m = 1) => Math.max(-m, Math.min(m, v));
    // Heading error in the horizontal plane (positive = aim to the right).
    const fx = d.dot(right) - right.dot(worldUp) * d.dot(worldUp);
    const fz = d.dot(forward) - forward.dot(worldUp) * d.dot(worldUp);
    const headingErr = Math.atan2(fx, fz);
    const bank = Math.asin(clamp(-right.dot(worldUp)));
    const wantBank = clamp(headingErr * 2, MAX_BANK);
    // Pitch error in the aircraft's frame: in a bank, pulling turns the nose onto the aim.
    const ty = d.dot(up);
    const pitchErr = Math.atan2(ty, Math.hypot(d.dot(forward), d.dot(right)));
    return {
      pitch: clamp(pitchErr * 4),
      roll: clamp((wantBank - bank) * 2.5),
      yaw: 0,
    };
  }

  private readonly onClick = () => {
    if (this.enabled && !this.locked) void this.canvas.requestPointerLock?.();
  };

  private readonly onLockChange = () => {
    this.locked = document.pointerLockElement === this.canvas;
  };

  private readonly onMove = (e: MouseEvent) => {
    if (!this.locked) return;
    this.pendingX += e.movementX;
    this.pendingY += e.movementY;
  };
}
