import { Quaternion, Vector3 } from 'three';

const SENS = 0.0022; // rad per pixel
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

  /** Stick commands that turn an aircraft with the given body axes towards the aim. */
  steer(forward: Vector3, up: Vector3, right: Vector3) {
    const d = this.direction;
    const tx = d.dot(right);
    const ty = d.dot(up);
    const tz = d.dot(forward);
    const yawErr = Math.atan2(tx, tz);
    const pitchErr = Math.atan2(ty, Math.hypot(tz, tx));
    const off = Math.acos(Math.max(-1, Math.min(1, tz)));
    // Bank towards the aim when it is off to the side; near the nose let the wings level out.
    const w = Math.min(1, Math.max(0, (off - 0.03) / 0.15));
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    return {
      pitch: clamp(pitchErr * 4),
      roll: clamp(yawErr * 2.2 * w),
      yaw: clamp(yawErr * 3),
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
