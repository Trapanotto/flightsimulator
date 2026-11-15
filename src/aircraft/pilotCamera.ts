/**
 * The camera for the pilot outside the aircraft, in render space (x east, y up, z south),
 * after the PilotVisual's `object` has been placed: first person from the eyes, or third
 * person – behind and above on foot and in free fall, and under the canopy behind the
 * jumper looking past them down the glide path, where the landing will be.
 *
 * Dragging looks around; the view swings back a few seconds after the last drag.
 */
import { type Object3D, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';
import type { Parachutist } from '@sim';

const UP = new Vector3(0, 1, 0);
const AXIS_X = new Vector3(1, 0, 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class PilotCamera {
  firstPerson = false;
  /** Height of the ground in render space under a point, to keep the camera above it. */
  groundY?: (x: number, z: number) => number | undefined;
  private yaw = 0;
  private pitch = 0;
  private zoom = 1;
  private sinceInput = Infinity;
  private first = true;
  private readonly forward = new Vector3();
  private readonly velocity = new Vector3();
  private readonly offset = new Vector3();
  private readonly wanted = new Vector3();
  private readonly target = new Vector3();
  private readonly aim = new Vector3();
  private readonly q = new Quaternion();
  private readonly look = new Quaternion();
  private readonly tmp = new Vector3();
  private readonly lead = new Vector3();

  /** Starts over without easing (on leaving the aircraft, on a switch of view). */
  snap() {
    this.first = true;
    this.yaw = 0;
    this.pitch = 0;
  }

  /** Dragging by dx, dy pixels. */
  drag(dx: number, dy: number) {
    const k = 0.0045;
    this.yaw -= dx * k;
    this.pitch = clamp(this.pitch + dy * k, -1.2, 1.2);
    this.sinceInput = 0;
  }

  /** Wheel or pinch: factor > 1 moves away (third person). */
  dolly(factor: number) {
    this.zoom = clamp(this.zoom * factor, 0.5, 4);
    this.sinceInput = 0;
  }

  /**
   * Per frame. `pilot` is the placed visual's object (origin at the hips, +z the heading),
   * `p` the simulated pilot (its velocity turns the view down the glide path).
   */
  update(dt: number, camera: PerspectiveCamera, pilot: Object3D, p: Parachutist) {
    this.sinceInput += dt;
    if (this.sinceInput > 3) {
      const k = Math.min(1, dt * 1.5);
      this.yaw -= this.yaw * k;
      this.pitch -= this.pitch * k;
    }
    this.renderVelocity(pilot, p);
    if (this.firstPerson) return this.eyes(camera, pilot, p);

    this.forward.set(0, 0, 1).applyQuaternion(pilot.quaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();
    let distance: number;
    let height: number;
    const t = this.aim.copy(pilot.position);
    if (p.mode === 'walk') {
      distance = 3.6;
      height = 1.25;
      t.y += 0.5;
    } else if (p.mode === 'freefall') {
      distance = 5.5;
      height = 2.2;
      t.y -= 0.6;
    } else {
      // Behind the jumper at the height of the lines, the wing in the top of the picture,
      // aiming past the jumper where the glide leads.
      distance = 12;
      height = 3;
      // Not while it opens: the free-fall speed would aim far below the jumper.
      const lead = this.lead.copy(this.velocity).multiplyScalar(1.2 * p.deploy * p.deploy);
      lead.y = Math.max(lead.y, -8);
      t.add(lead);
      t.y += 2.4;
    }
    distance *= this.zoom;
    const elevation = clamp(Math.atan2(height, distance) + this.pitch, -0.5, 1.4);
    const range = Math.hypot(distance, height);
    this.wanted
      .copy(this.forward)
      .multiplyScalar(-Math.cos(elevation) * range)
      .applyAxisAngle(UP, this.yaw);
    this.wanted.y = Math.sin(elevation) * range;
    // The spring acts on the offset, not on the world position: no lag at falling speed.
    const k = this.first ? 1 : 1 - Math.exp(-dt * 3);
    this.offset.lerp(this.wanted, k);
    // Like the offset, the aim is smoothed relative to the pilot: no lag at 55 m/s.
    t.sub(pilot.position);
    if (this.first) this.target.copy(t);
    else this.target.lerp(t, 1 - Math.exp(-dt * 4));
    this.first = false;
    camera.position.copy(pilot.position).add(this.offset);
    const ground = this.groundY?.(camera.position.x, camera.position.z);
    if (ground !== undefined && camera.position.y < ground + 0.6) camera.position.y = ground + 0.6;
    camera.lookAt(this.tmp.copy(pilot.position).add(this.target));
  }

  /** The pilot's velocity in render space, from the simulation's world frame. */
  private renderVelocity(pilot: Object3D, p: Parachutist) {
    // World -> body (x forward, y right, z down) by the pilot's orientation, then body ->
    // model (x left, y up, z forward), then model -> render by the placed object.
    const v = p.state.velocity;
    const q = p.state.orientation;
    // v' = v + w t + u x t with t = 2 u x v, u = -(q.x, q.y, q.z) for the inverse.
    const ux = -q.x;
    const uy = -q.y;
    const uz = -q.z;
    const tx = 2 * (uy * v.z - uz * v.y);
    const ty = 2 * (uz * v.x - ux * v.z);
    const tz = 2 * (ux * v.y - uy * v.x);
    const bx = v.x + q.w * tx + (uy * tz - uz * ty);
    const by = v.y + q.w * ty + (uz * tx - ux * tz);
    const bz = v.z + q.w * tz + (ux * ty - uy * tx);
    this.velocity.set(-by, -bz, bx).applyQuaternion(pilot.quaternion);
  }

  private eyes(camera: PerspectiveCamera, pilot: Object3D, p: Parachutist) {
    // Eye point in the model frame (origin the hips) and how far below the horizon it rests.
    let rest: number;
    if (p.mode === 'freefall') {
      camera.position.set(0, 0.1, 0.72);
      rest = -0.95;
    } else {
      camera.position.set(0, p.swimming ? 0.62 : 0.72, 0.1);
      rest = p.mode === 'canopy' ? -0.35 : -0.1;
    }
    camera.position.applyQuaternion(pilot.quaternion).add(pilot.position);
    // A camera looks along its own -z: half a turn to the model's +z.
    this.look.setFromAxisAngle(UP, Math.PI + this.yaw);
    this.q.setFromAxisAngle(AXIS_X, clamp(rest + this.pitch, -1.4, 1.4));
    camera.quaternion.copy(pilot.quaternion).multiply(this.look).multiply(this.q);
    this.first = true;
  }
}
