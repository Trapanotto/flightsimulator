import { Matrix4, type Object3D, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';
import { type LocalFrame, seaLevelToEllipsoid } from '@geo';
import { type PathPoint, bankAt, pointAt } from './showcasePath';

/** Seconds a camera shot lasts. */
const SHOT_SECONDS = 8;
/** Seconds the picture takes to fade out before a cut, and in after it. */
const FADE_SECONDS = 0.35;
/** Speed along the loop, m/s (about 105 knots). */
export const SHOWCASE_SPEED = 54;
/** The camera never comes closer to the terrain than this, m. */
const CLEARANCE = 12;

type Shot = 'side' | 'chase' | 'flyby' | 'wide' | 'orbit';
// Opens with the side view: the whole aircraft against the mountains.
const SHOTS: Shot[] = ['side', 'chase', 'flyby', 'wide', 'orbit'];

const UP = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

/**
 * The flight behind the menu: the aircraft follows a smoothed loop through the Bernese
 * Oberland (showcasePath.ts) while the camera cuts between shots. Nothing is simulated: the
 * aircraft is on rails, banked as a coordinated turn would be, and the camera follows with a
 * spring so nothing shakes.
 */
export class Showcase {
  /** Distance flown along the loop, m. */
  s = 0;
  /** Where the aircraft is (degrees, metres above the ellipsoid). */
  readonly geo = { lon: 0, lat: 0, h: 0 };
  /** 0..1: how much of the picture shows; dips to 0 around a camera cut. */
  fade = 1;

  private shotTime = 0;
  private shotIndex = 0;
  private bank = 0;
  private orbitAngle = 0;
  private snap = true;
  private lift = 0;
  /** The fixed camera of the fly-by shot (ECEF: it stays put when the render origin moves). */
  private readonly fixedCam = new Vector3();
  private readonly camOff = new Vector3();
  private readonly lookOff = new Vector3();

  private readonly point: PathPoint = { lon: 0, lat: 0, altitude: 0 };
  private readonly pos = new Vector3();
  private readonly ahead = new Vector3();
  private readonly behind = new Vector3();
  private readonly fwd = new Vector3();
  private readonly left = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly look = new Vector3();
  private readonly wanted = new Vector3();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();

  /** Back to the start of the loop and the first shot. */
  reset() {
    this.s = 0;
    this.shotTime = 0;
    this.shotIndex = 0;
    this.bank = bankAt(0, SHOWCASE_SPEED);
    this.snap = true;
    this.lift = 0;
    this.fade = 1;
    pointAt(0, this.point);
    this.geo.lon = this.point.lon;
    this.geo.lat = this.point.lat;
    this.geo.h = seaLevelToEllipsoid(this.point.lon, this.point.lat, this.point.altitude);
  }

  /** Render-space position at distance s along the loop. */
  private at(s: number, frame: LocalFrame, out: Vector3): Vector3 {
    const p = pointAt(s, this.point);
    frame.fromGeodetic(p.lon, p.lat, seaLevelToEllipsoid(p.lon, p.lat, p.altitude), out);
    return out;
  }

  /**
   * Per frame: moves the aircraft `dt` seconds along the loop (0 holds it still, as behind the
   * loading screen) and places it and the camera. `size` is the aircraft's span or length,
   * `groundY` the terrain height in render space under a point, `viewport` the canvas size in
   * CSS pixels (the aircraft is framed in the part of the screen the menu leaves free).
   */
  update(
    dt: number,
    frame: LocalFrame,
    aircraft: Object3D,
    camera: PerspectiveCamera,
    size: number,
    groundY: (x: number, z: number) => number | undefined,
    viewport: { width: number; height: number },
  ) {
    const v = SHOWCASE_SPEED;
    this.s += v * dt;

    // Pose: along the path tangent, banked for the turn (coordinated: tan(bank) = v²·κ/g),
    // the bank eased in so nothing snaps the wings.
    const pos = this.at(this.s, frame, this.pos);
    const p = this.point;
    this.geo.lon = p.lon;
    this.geo.lat = p.lat;
    this.geo.h = seaLevelToEllipsoid(p.lon, p.lat, p.altitude);
    this.at(this.s + v * 0.5, frame, this.ahead);
    this.at(this.s - v * 0.5, frame, this.behind);
    const fwd = this.fwd.subVectors(this.ahead, this.behind).normalize();
    this.bank += (bankAt(this.s, v) - this.bank) * (1 - Math.exp(-dt / 0.6));
    // A model has x left, y up, z forward.
    this.left.crossVectors(UP, fwd).normalize();
    this.up.crossVectors(fwd, this.left).normalize();
    this.right.copy(this.left).negate();
    aircraft.quaternion.setFromRotationMatrix(this.m.makeBasis(this.left, this.up, fwd));
    // Turning left (positive bank) puts the left wing down: roll about the nose by -bank.
    aircraft.quaternion.multiply(this.q.setFromAxisAngle(AXIS_Z, -this.bank));
    aircraft.position.copy(pos);

    if (dt > 0) {
      this.shotTime += dt;
      if (this.shotTime > SHOT_SECONDS) this.cut(frame, size);
      this.fade = Math.min(
        1,
        this.shotTime / FADE_SECONDS,
        (SHOT_SECONDS - this.shotTime) / FADE_SECONDS,
      );
    }
    this.placeCamera(dt, frame, camera, size, groundY, viewport);
  }

  private cut(frame: LocalFrame, size: number) {
    this.shotTime = 0;
    this.shotIndex = (this.shotIndex + 1) % SHOTS.length;
    const shot = SHOTS[this.shotIndex]!;
    if (shot === 'flyby') {
      // A fixed camera a few seconds ahead on the route, off to the side and a bit higher.
      const v = SHOWCASE_SPEED;
      const p = this.at(this.s + v * 3.8, frame, new Vector3());
      const ahead = this.at(this.s + v * 3.8 + 50, frame, new Vector3());
      const side = ahead.sub(p).cross(UP).normalize();
      // About a second of flight away: a sweeping pan, not a whip.
      p.addScaledVector(side, Math.max(size * 3, v * 1.1)).addScaledVector(UP, size * 0.6);
      frame.toEcef(p, this.fixedCam);
    }
    if (shot === 'orbit') this.orbitAngle = (this.s * 0.01) % (Math.PI * 2);
    this.snap = true;
  }

  private placeCamera(
    dt: number,
    frame: LocalFrame,
    cam: PerspectiveCamera,
    size: number,
    groundY: (x: number, z: number) => number | undefined,
    viewport: { width: number; height: number },
  ) {
    const shot = SHOTS[this.shotIndex]!;
    const pos = this.pos;
    const fwd = this.fwd;
    const look = this.look.copy(pos);
    const want = this.wanted.copy(pos);
    let fov = 55;
    switch (shot) {
      case 'chase':
        want.addScaledVector(fwd, -size * 1.4).addScaledVector(UP, size * 0.32);
        look.addScaledVector(fwd, size * 2);
        break;
      case 'side':
        want
          .addScaledVector(this.right, size * 1.3)
          .addScaledVector(fwd, size * 0.25)
          .addScaledVector(UP, size * 0.12);
        fov = 45;
        break;
      case 'flyby':
        frame.toLocal(this.fixedCam, want);
        fov = 40;
        break;
      case 'orbit':
        this.orbitAngle += dt * 0.18;
        want
          .addScaledVector(fwd, Math.cos(this.orbitAngle) * size * 1.5)
          .addScaledVector(this.right, Math.sin(this.orbitAngle) * size * 1.5)
          .addScaledVector(UP, size * 0.45);
        break;
      case 'wide':
        want.addScaledVector(fwd, -size * 6 - SHOWCASE_SPEED * 1.5).addScaledVector(UP, size * 2.2);
        fov = 50;
        break;
    }
    // Follow with a spring on the offsets from the aircraft (the aircraft itself never lags
    // out of the frame); the fixed camera stays exact.
    want.sub(pos);
    look.sub(pos);
    if (this.snap || shot === 'flyby') this.camOff.copy(want);
    else this.camOff.lerp(want, 1 - Math.exp(-dt / 0.6));
    if (this.snap) this.lookOff.copy(look);
    else this.lookOff.lerp(look, 1 - Math.exp(-dt / 0.6));
    this.snap = false;
    cam.position.copy(pos).add(this.camOff);
    // Never inside the terrain; the lift eases in and out.
    const ground = groundY(cam.position.x, cam.position.z);
    const need =
      ground === undefined ? this.lift : Math.max(0, ground + CLEARANCE - cam.position.y);
    this.lift = dt > 0 ? this.lift + (need - this.lift) * (1 - Math.exp(-dt / 0.3)) : need;
    cam.position.y += this.lift;
    cam.up.copy(UP);
    cam.lookAt(look.add(pos));

    // On wide screens the menu sits on the left: frame the aircraft in the right part. On
    // upright ones the menu fills the lower half: frame it above.
    const { width: w, height: h } = viewport;
    const shiftX = w > h * 1.3 ? -Math.round(w * 0.14) : 0;
    const shiftY = w < h ? Math.round(h * 0.2) : 0;
    // Upright screens see little to the sides: a wider angle keeps the aircraft whole.
    if (w < h) fov += 15;
    const view = cam.view?.enabled ? cam.view : undefined;
    const stale =
      shiftX || shiftY
        ? !view ||
          view.offsetX !== shiftX ||
          view.offsetY !== shiftY ||
          view.fullWidth !== w ||
          view.fullHeight !== h
        : !!view;
    if (Math.abs(cam.fov - fov) > 0.01 || stale) {
      cam.fov = fov;
      // setViewOffset also sets the aspect from the full size.
      if (shiftX || shiftY) cam.setViewOffset(w, h, shiftX, shiftY, w, h);
      else cam.clearViewOffset();
      cam.updateProjectionMatrix();
    }
  }

  /** Gives the camera back as a flight needs it. */
  release(cam: PerspectiveCamera) {
    cam.clearViewOffset();
    this.fade = 1;
  }
}
