import { type Object3D, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

export type CameraMode = 'menu' | 'outside' | 'cockpit';

/** Where the camera sits relative to an aircraft model (from AircraftVisual.view). */
export interface ViewPoints {
  eye: { x: number; y: number; z: number };
  chaseDistance: number;
  chaseHeight: number;
}

const UP = new Vector3(0, 1, 0);
/**
 * Where the pilot's eyes rest: a little below the horizon, so the instruments and the view
 * ahead are both in sight (radians of the rig's pitch; negative looks down).
 */
const COCKPIT_PITCH = -0.3;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Places the camera: a slow orbit in the menu, a chase view behind the aircraft, or the
 * pilot's eyes. Dragging looks around in every mode; the wheel or a pinch changes the distance
 * outside.
 */
export class CameraRig {
  mode: CameraMode = 'menu';
  /** The menu camera circles the aircraft slowly (off for screenshot tests). */
  autoOrbit = true;
  /** Look offsets from dragging, radians. */
  private yaw = 0;
  private pitch = 0;
  private zoom = 1;
  private sinceInput = Infinity;
  private menuAngle = 0.6;
  private readonly offset = new Vector3();
  private readonly wanted = new Vector3();
  private readonly forward = new Vector3();
  private readonly target = new Vector3();
  private readonly q = new Quaternion();
  private readonly look = new Quaternion();
  private first = true;

  /** Height of the ground in render space under a point, to keep the camera above it. */
  groundY?: (x: number, z: number) => number | undefined;

  setMode(mode: CameraMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.yaw = 0;
    this.pitch = mode === 'cockpit' ? COCKPIT_PITCH : 0;
    this.first = true;
  }

  /** Dragging by dx, dy pixels. */
  drag(dx: number, dy: number) {
    const k = 0.0045;
    this.yaw -= dx * k;
    this.pitch = clamp(this.pitch + dy * k, -1.2, 1.3);
    if (this.mode === 'cockpit') this.yaw = clamp(this.yaw, -2.5, 2.5);
    this.sinceInput = 0;
  }

  /** Wheel or pinch: factor > 1 moves away. */
  dolly(factor: number) {
    this.zoom = clamp(this.zoom * factor, 0.35, 12);
    this.sinceInput = 0;
  }

  /**
   * Per frame, after the aircraft has been placed. `flying` lets the chase view swing back
   * behind the aircraft a few seconds after the last drag.
   */
  update(
    dt: number,
    camera: PerspectiveCamera,
    aircraft: Object3D,
    view: ViewPoints,
    flying: boolean,
  ) {
    this.sinceInput += dt;
    if (this.mode === 'cockpit') {
      // Eyes: the eye point in the model, looking along the model's +z; a camera looks along
      // its own -z, hence the half turn.
      camera.position.set(view.eye.x, view.eye.y, view.eye.z).applyQuaternion(aircraft.quaternion);
      camera.position.add(aircraft.position);
      if (flying && this.sinceInput > 4) {
        const k = Math.min(1, dt * 2.5);
        this.yaw -= this.yaw * k;
        this.pitch -= (this.pitch - COCKPIT_PITCH) * k;
      }
      this.look.setFromAxisAngle(UP, Math.PI + this.yaw);
      this.q.setFromAxisAngle(new Vector3(1, 0, 0), this.pitch * 0.8);
      camera.quaternion.copy(aircraft.quaternion).multiply(this.look).multiply(this.q);
      return;
    }

    // Outside: behind the aircraft along its heading, level with the horizon (not rolling
    // with it), or circling it slowly in the menu.
    this.forward.set(0, 0, 1).applyQuaternion(aircraft.quaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();
    let around = this.yaw;
    let elevation: number;
    let distance = view.chaseDistance * this.zoom;
    if (this.mode === 'menu') {
      if (this.autoOrbit && this.sinceInput > 6) this.menuAngle += dt * 0.05;
      around += this.menuAngle + Math.PI * 0.75;
      elevation = clamp(0.16 + this.pitch, 0.03, 1.4);
      distance *= 0.85;
    } else {
      if (flying && this.sinceInput > 4) {
        const k = Math.min(1, dt * 1.5);
        this.yaw -= this.yaw * k;
        this.pitch -= this.pitch * k;
      }
      elevation = clamp(Math.atan2(view.chaseHeight, view.chaseDistance) + this.pitch, -0.4, 1.45);
    }
    // Offset from the aircraft: backwards, turned around the vertical, raised.
    this.wanted
      .copy(this.forward)
      .multiplyScalar(-Math.cos(elevation) * distance)
      .applyAxisAngle(UP, around);
    this.wanted.y = Math.sin(elevation) * distance;
    // The spring acts on the offset, not on the world position: no lag at speed.
    if (this.first) this.offset.copy(this.wanted);
    else this.offset.lerp(this.wanted, 1 - Math.exp(-dt * 6));
    this.first = false;
    camera.position.copy(aircraft.position).add(this.offset);
    const ground = this.groundY?.(camera.position.x, camera.position.z);
    if (ground !== undefined && camera.position.y < ground + 1.2) camera.position.y = ground + 1.2;
    this.target.copy(aircraft.position);
    this.target.y += view.chaseHeight * 0.25;
    camera.lookAt(this.target);
  }

  /**
   * Mouse and touch on the canvas: drag to look, wheel or two-finger pinch for the distance.
   * Returns a function that removes the listeners.
   */
  attach(el: HTMLElement): () => void {
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const down = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture(e.pointerId);
      pinch = spread();
    };
    const move = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      if (pointers.size === 1) this.drag(e.clientX - p.x, e.clientY - p.y);
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size === 2) {
        const s = spread();
        if (pinch > 0 && s > 0) this.dolly(pinch / s);
        pinch = s;
      }
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      pinch = spread();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.dolly(Math.exp(e.deltaY * 0.0012));
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
    };
  }
}
