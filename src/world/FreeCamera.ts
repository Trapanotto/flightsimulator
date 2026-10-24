import { type PerspectiveCamera, Vector3 } from 'three';
import { DEG } from '../geo/ellipsoid';

/** Local directions at a point on the earth, in render coordinates. */
export interface Basis {
  up: Vector3;
  north: Vector3;
  east: Vector3;
}

const MIN_AGL = 12;

/**
 * Spectator camera for testing the terrain: fly anywhere with mouse + keyboard (or touch).
 * Heading and pitch are relative to the true local horizon, so "up" stays up across the country.
 */
export class FreeCamera {
  yaw = 0;
  pitch = -10 * DEG;
  /** Base speed in m/s; Shift x5, Ctrl x0.2. Default 500 km/h. */
  speed = 139;
  autoForward = false;
  readonly velocity = new Vector3();
  private readonly keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly horiz = new Vector3();
  private readonly move = new Vector3();

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  get speedFactor() {
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) return 5;
    if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) return 0.2;
    return 1;
  }

  /** Forward direction for the current heading/pitch. */
  forward(b: Basis, out = new Vector3()) {
    this.horiz
      .copy(b.north)
      .multiplyScalar(Math.cos(this.yaw))
      .addScaledVector(b.east, Math.sin(this.yaw));
    return out
      .copy(this.horiz)
      .multiplyScalar(Math.cos(this.pitch))
      .addScaledVector(b.up, Math.sin(this.pitch));
  }

  /**
   * Moves the camera. groundAt returns terrain height under the camera (or undefined),
   * altitude is the camera's current height in metres.
   */
  update(dt: number, b: Basis, altitude: number, groundAt: number | undefined) {
    const k = this.keys;
    const turn = 1.2 * dt;
    if (k.has('ArrowLeft')) this.yaw -= turn;
    if (k.has('ArrowRight')) this.yaw += turn;
    if (k.has('ArrowUp')) this.pitch += turn;
    if (k.has('ArrowDown')) this.pitch -= turn;
    this.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, this.pitch));

    this.forward(b, this.fwd);
    this.right
      .copy(b.east)
      .multiplyScalar(Math.cos(this.yaw))
      .addScaledVector(b.north, -Math.sin(this.yaw));

    this.move.set(0, 0, 0);
    if (k.has('KeyW') || this.autoForward) this.move.add(this.fwd);
    if (k.has('KeyS')) this.move.sub(this.fwd);
    if (k.has('KeyD')) this.move.add(this.right);
    if (k.has('KeyA')) this.move.sub(this.right);
    if (k.has('KeyE') || k.has('Space')) this.move.add(b.up);
    if (k.has('KeyQ')) this.move.sub(b.up);
    if (this.move.lengthSq() > 0) this.move.normalize();

    this.velocity.copy(this.move).multiplyScalar(this.speed * this.speedFactor);
    this.camera.position.addScaledVector(this.velocity, dt);

    // Never go below the ground.
    if (groundAt !== undefined) {
      const newAlt = altitude + this.velocity.dot(b.up) * dt;
      if (newAlt < groundAt + MIN_AGL)
        this.camera.position.addScaledVector(b.up, groundAt + MIN_AGL - newAlt);
    }
    this.aim(b);
  }

  aim(b: Basis) {
    this.camera.up.copy(b.up);
    this.camera.lookAt(this.forward(b, this.fwd).add(this.camera.position));
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    this.keys.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  private readonly onPointerDown = (e: PointerEvent) => {
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    // Drag the world: moving the pointer right turns the view left (like grabbing the scenery).
    const s = (this.camera.fov * DEG) / this.canvas.clientHeight;
    this.yaw -= dx * s;
    this.pitch += dy * s;
  };

  private readonly onPointerUp = () => {
    this.dragging = false;
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.speed = Math.max(10, Math.min(3000, this.speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  };
}
