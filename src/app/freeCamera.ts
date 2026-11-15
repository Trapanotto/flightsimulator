import { Euler, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

export type FreeCameraMode = 'orbit' | 'free';

/** Anything with a render-space position: the aircraft's Object3D.position. */
interface Point {
  x: number;
  y: number;
  z: number;
}

const UP = new Vector3(0, 1, 0);
const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Radians per pixel of a drag. */
const LOOK = 0.0045;
/** Closest the camera comes to the ground and, orbiting, to the aircraft's centre, m. */
const GROUND_CLEARANCE = 1.2;
const MIN_ORBIT = 1.5;
const MOVE_KEYS: Record<string, readonly [number, number, number]> = {
  KeyW: [0, 0, -1],
  KeyS: [0, 0, 1],
  KeyA: [-1, 0, 0],
  KeyD: [1, 0, 0],
  KeyQ: [0, -1, 0],
  KeyE: [0, 1, 0],
};

/**
 * The camera of the photo mode and the replay. It starts where the flight's camera was and
 * orbits the aircraft: dragging circles round it, the wheel or a pinch moves closer or
 * further, a right or middle drag (two fingers) shifts the view. WASD with Q/E (down/up)
 * flies it freely, Shift faster; dragging then looks around, and F orbits the aircraft again.
 *
 * With `follow(target)` the camera keeps its offset to the target every frame, in both
 * modes: in a replay it travels with the aircraft as a chase drone would. `follow(null)`
 * leaves it standing in the world (a tower view the aircraft flies past); the app then has
 * to `shift` it when it moves the render origin.
 *
 * Its listeners are only attached while the photo or replay screen is up. They run in the
 * capture phase and stop the event there, so the flight's `CameraRig` and the cockpit
 * pointer, attached to the same canvas for good, do not also react.
 */
export class FreeCamera {
  mode: FreeCameraMode = 'orbit';
  /** Vertical field of view, degrees (10..100). */
  fov = 55;
  /** Roll about the view axis, degrees (-45..45), positive turns the picture clockwise. */
  roll = 0;
  /** Height of the ground in render space under a point, as `CameraRig.groundY`. */
  groundY?: (x: number, z: number) => number | undefined;

  /** Camera position minus the target's (or the render origin's without a target). */
  private readonly offset = new Vector3();
  /** Orbit centre minus the target's position: panning moves it off the aircraft. */
  private readonly pivot = new Vector3();
  private yaw = 0;
  private pitch = 0;
  private target: Point | null = null;
  private readonly keys = new Set<string>();
  private fast = false;
  private detachFn: (() => void) | undefined;

  private readonly at = new Vector3();
  private readonly v = new Vector3();
  private readonly move = new Vector3();
  private readonly q = new Quaternion();
  private readonly qRoll = new Quaternion();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');

  /**
   * Takes over from the flight's camera: same place, same direction. `target` (the
   * aircraft's position object) is followed from now on.
   */
  begin(camera: PerspectiveCamera, target: Point | null) {
    this.target = target;
    this.mode = target ? 'orbit' : 'free';
    this.offset.copy(camera.position).sub(this.origin(this.at));
    this.pivot.set(0, 0, 0);
    this.euler.setFromQuaternion(camera.quaternion, 'YXZ');
    this.yaw = this.euler.y;
    this.pitch = this.euler.x;
    this.roll = 0;
    this.fov = clamp(camera.fov, 10, 100);
    this.keys.clear();
  }

  /** Follows `target` from here on, keeping the camera where it is; null stays in place. */
  follow(target: Point | null) {
    const camera = this.v.copy(this.offset).add(this.origin(this.at));
    this.target = target;
    this.offset.copy(camera).sub(this.origin(this.at));
    if (!target && this.mode === 'orbit') this.mode = 'free';
  }

  /** Back to orbiting the target, centred on it. */
  orbit() {
    if (!this.target) return;
    this.mode = 'orbit';
    this.pivot.set(0, 0, 0);
  }

  /** The render origin moved by `delta` (a rebase): a camera standing in the world moves back. */
  shift(delta: Point) {
    if (!this.target) this.offset.sub(this.v.set(delta.x, delta.y, delta.z));
  }

  /** Distance from the camera to the target, m (to the origin without one). */
  get distance() {
    return this.offset.length();
  }

  /** Dragging by dx, dy pixels: orbit the target, or look around in free flight. */
  drag(dx: number, dy: number) {
    if (this.mode === 'orbit') {
      // Around the vertical through the pivot, then up and down, short of straight over it.
      const rel = this.v.copy(this.offset).sub(this.pivot);
      const r = Math.max(rel.length(), MIN_ORBIT);
      let azimuth = Math.atan2(rel.x, rel.z) - dx * LOOK;
      const elevation = clamp(Math.asin(clamp(rel.y / r, -1, 1)) + dy * LOOK, -1.45, 1.45);
      if (!Number.isFinite(azimuth)) azimuth = 0;
      rel.set(
        Math.cos(elevation) * Math.sin(azimuth),
        Math.sin(elevation),
        Math.cos(elevation) * Math.cos(azimuth),
      );
      this.offset.copy(this.pivot).addScaledVector(rel, r);
    } else {
      this.yaw -= dx * LOOK;
      this.pitch = clamp(this.pitch - dy * LOOK, -1.55, 1.55);
    }
  }

  /** Shifting the view by dx, dy pixels of a canvas `height` pixels tall: the scene follows the pointer. */
  pan(dx: number, dy: number, height: number) {
    const metresPerPixel =
      (2 * Math.tan((this.fov * DEG) / 2) * this.reach()) / Math.max(height, 1);
    this.orientation(this.q);
    this.move.set(-dx * metresPerPixel, dy * metresPerPixel, 0).applyQuaternion(this.q);
    this.offset.add(this.move);
    this.pivot.add(this.move);
  }

  /**
   * Wheel or pinch: moves along the view, `amount` > 0 backwards. In orbit it scales the
   * distance to the pivot; in free flight a step is a share of the distance to the aircraft,
   * so it is fine close by and quick far away.
   */
  dolly(amount: number) {
    if (this.mode === 'orbit') {
      const rel = this.v.copy(this.offset).sub(this.pivot);
      const r = rel.length() || MIN_ORBIT;
      const next = clamp(r * Math.exp(amount), MIN_ORBIT, 20_000);
      this.offset.copy(this.pivot).addScaledVector(rel, next / r);
    } else {
      this.orientation(this.q);
      this.move.set(0, 0, 1).applyQuaternion(this.q);
      this.offset.addScaledVector(this.move, amount * Math.max(this.reach(), 2));
    }
  }

  /** Per frame, after the aircraft has been placed. `dt` is real time (flying keys). */
  update(dt: number, camera: PerspectiveCamera) {
    this.fly(dt);
    const origin = this.origin(this.at);
    camera.position.copy(this.offset).add(origin);
    const ground = this.groundY?.(camera.position.x, camera.position.z);
    if (ground !== undefined && camera.position.y < ground + GROUND_CLEARANCE) {
      camera.position.y = ground + GROUND_CLEARANCE;
      this.offset.y = camera.position.y - origin.y;
    }
    if (this.mode === 'orbit') {
      // Keep looking at the pivot; the look angles carry over into free flight.
      const d = this.v.copy(origin).add(this.pivot).sub(camera.position);
      if (d.lengthSq() > 1e-6) {
        this.yaw = Math.atan2(-d.x, -d.z);
        this.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      }
    }
    this.orientation(camera.quaternion);
    const fov = clamp(this.fov, 10, 100);
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /** Changes `fov` and `roll` from the photo settings, within their ranges. */
  set(settings: { fov?: number; roll?: number }) {
    if (settings.fov !== undefined) this.fov = clamp(settings.fov, 10, 100);
    if (settings.roll !== undefined) this.roll = clamp(settings.roll, -45, 45);
  }

  private fly(dt: number) {
    if (this.keys.size === 0 || dt <= 0) return;
    this.move.set(0, 0, 0);
    for (const k of this.keys) {
      const m = MOVE_KEYS[k];
      if (!m) continue;
      this.move.x += m[0];
      this.move.y += m[1];
      this.move.z += m[2];
    }
    if (this.move.lengthSq() === 0) return;
    // Moving with the keys is free flight: the camera no longer turns towards the pivot.
    this.mode = 'free';
    const vertical = this.move.y;
    this.move.y = 0;
    // Forward and sideways along the view turned flat, up and down along the vertical:
    // the way a drone flies, and the horizon does not tilt the path.
    this.move.applyAxisAngle(UP, this.yaw);
    this.move.y = vertical;
    const speed = Math.max(4, this.reach() * 0.6) * (this.fast ? 5 : 1);
    this.offset.addScaledVector(this.move.normalize(), speed * dt);
  }

  /** Distance that sets the scale of moving: to the aircraft, at least a few metres. */
  private reach() {
    return Math.max(this.target ? this.offset.length() : 50, 3);
  }

  private origin(out: Vector3) {
    return this.target ? out.set(this.target.x, this.target.y, this.target.z) : out.set(0, 0, 0);
  }

  private orientation(out: Quaternion) {
    this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
    out.setFromEuler(this.euler);
    // A camera looks along -z: a clockwise picture is a turn about +z by minus the angle.
    this.qRoll.setFromAxisAngle(this.v.set(0, 0, 1), -this.roll * DEG);
    return out.multiply(this.qRoll);
  }

  /** Mouse, touch and keys on `el` until `detach`. */
  attach(el: HTMLElement) {
    this.detach();
    const pointers = new Map<number, { x: number; y: number; pan: boolean }>();
    let spread = 0;
    let mid = { x: 0, y: 0 };
    const measure = () => {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      spread = Math.hypot(a.x - b.x, a.y - b.y);
      mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    const stop = (e: Event) => {
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    const down = (e: PointerEvent) => {
      stop(e);
      pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        pan: e.button === 1 || e.button === 2,
      });
      el.setPointerCapture?.(e.pointerId);
      measure();
    };
    const moveListener = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      stop(e);
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size === 1) {
        if (p.pan) this.pan(dx, dy, el.clientHeight);
        else this.drag(dx, dy);
      } else if (pointers.size === 2) {
        // Two fingers: the midpoint pans, the spread dollies.
        const before = { spread, mid };
        measure();
        if (before.spread > 0 && spread > 0) this.dolly(Math.log(before.spread / spread));
        this.pan(mid.x - before.mid.x, mid.y - before.mid.y, el.clientHeight);
      }
    };
    const up = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      stop(e);
      measure();
    };
    const wheel = (e: WheelEvent) => {
      stop(e);
      // Lines (Firefox) to about pixels.
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.dolly(clamp(delta * 0.0015, -0.5, 0.5));
    };
    const menu = (e: Event) => e.preventDefault();
    const keyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      this.fast = e.shiftKey;
      if (e.code === 'KeyF') this.orbit();
      else if (MOVE_KEYS[e.code]) this.keys.add(e.code);
    };
    const keyUp = (e: KeyboardEvent) => {
      this.fast = e.shiftKey;
      this.keys.delete(e.code);
    };
    const blur = () => this.keys.clear();
    const capture = { capture: true };
    const active = { capture: true, passive: false };
    el.addEventListener('pointerdown', down, capture);
    el.addEventListener('pointermove', moveListener, capture);
    el.addEventListener('pointerup', up, capture);
    el.addEventListener('pointercancel', up, capture);
    el.addEventListener('wheel', wheel, active);
    el.addEventListener('contextmenu', menu);
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    this.detachFn = () => {
      el.removeEventListener('pointerdown', down, capture);
      el.removeEventListener('pointermove', moveListener, capture);
      el.removeEventListener('pointerup', up, capture);
      el.removeEventListener('pointercancel', up, capture);
      el.removeEventListener('wheel', wheel, active);
      el.removeEventListener('contextmenu', menu);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
      this.keys.clear();
    };
  }

  detach() {
    this.detachFn?.();
    this.detachFn = undefined;
  }
}
