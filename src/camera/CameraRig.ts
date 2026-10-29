import { type PerspectiveCamera, Quaternion, Vector3 } from 'three';

export type CameraMode = 'chase' | 'cockpit' | 'wing' | 'orbit';
/** Cockpit view: pitch of the line of sight below the nose (rad), the displays stay in view. */
export const COCKPIT_LOOK_DOWN = 0.2;
export const CAMERA_MODES: CameraMode[] = ['chase', 'cockpit', 'wing', 'orbit'];

/** What the rig needs to know about the aircraft each frame (render coordinates). */
export interface CameraTarget {
  position: Vector3;
  quaternion: Quaternion;
  forward: Vector3;
  up: Vector3;
  velocity: Vector3;
  speed: number;
  /** Local vertical at the aircraft. */
  worldUp: Vector3;
}

/** Three.js cameras look down -Z, the aircraft nose is +Z. */
const FLIP = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);

const tmp = new Vector3();
const tmp2 = new Vector3();
const tmpQ = new Quaternion();

export class CameraRig {
  mode: CameraMode = 'chase';
  /** When set (mouse flight), the chase camera looks along this direction instead of the nose. */
  aim: Vector3 | null = null;
  orbitYaw = 0.6;
  orbitPitch = 0.25;
  orbitDistance = 18;
  /** Per aircraft type: pilot eye and wing camera (model coordinates), chase distance/height. */
  private readonly eye = new Vector3(0, 0.86, 1.05);
  private readonly wing = new Vector3(3.9, 0.35, -0.9);
  private chaseDistance = 13;
  private chaseHeight = 3.2;
  /** Camera shake amount (0..1), decays by itself. */
  shake = 0;
  private readonly chasePos = new Vector3();
  private readonly chaseUp = new Vector3(0, 1, 0);
  private initialised = false;
  private t = 0;
  private dragging = false;
  private lx = 0;
  private ly = 0;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    /** Returns the camera's height above terrain, or undefined. */
    private readonly heightAboveGround: (p: Vector3) => number | undefined,
  ) {
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  dispose() {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  setType(t: {
    eye: number[];
    wingCam: number[];
    chaseDistance: number;
    chaseHeight: number;
    length: number;
  }) {
    this.eye.fromArray(t.eye);
    this.wing.fromArray(t.wingCam);
    this.chaseDistance = t.chaseDistance;
    this.chaseHeight = t.chaseHeight;
    this.orbitDistance = Math.max(18, t.length * 1.8);
    this.initialised = false;
  }

  next() {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length]!;
    this.initialised = false;
  }

  /** Jump without smoothing (after a reset or teleport). */
  snap() {
    this.initialised = false;
  }

  /** Floating origin moved: keep the smoothed state in place. */
  rebase(delta: Vector3) {
    this.chasePos.sub(delta);
  }

  update(dt: number, a: CameraTarget) {
    this.t += dt;
    const cam = this.camera;
    const fast = Math.min(1, Math.max(0, (a.speed - 50) / 90));
    let fov = 60 + 14 * fast;
    let near = 0.5;

    switch (this.mode) {
      case 'chase': {
        const look = this.aim ?? a.forward;
        // Up: mostly the horizon, a bit of the aircraft's bank for drama.
        tmp.copy(a.worldUp).lerp(a.up, 0.25).normalize();
        const k = 1 - Math.exp(-dt * 5);
        this.chaseUp.lerp(tmp, this.initialised ? k : 1).normalize();
        const dist = this.chaseDistance * (1 + 0.3 * fast);
        tmp2
          .copy(a.position)
          .addScaledVector(look, -dist)
          .addScaledVector(this.chaseUp, this.chaseHeight);
        if (!this.initialised) this.chasePos.copy(tmp2);
        // Spring: fast enough to keep up at 600 km/h, soft enough to feel the motion.
        this.chasePos.lerp(tmp2, 1 - Math.exp(-dt * 7));
        cam.position.copy(this.chasePos);
        cam.up.copy(this.chaseUp);
        tmp
          .copy(a.position)
          .addScaledVector(look, this.chaseDistance)
          .addScaledVector(this.chaseUp, this.chaseHeight * 0.38);
        cam.lookAt(tmp);
        break;
      }
      case 'cockpit':
      case 'wing': {
        const local = this.mode === 'cockpit' ? this.eye : this.wing;
        cam.position.copy(local).applyQuaternion(a.quaternion).add(a.position);
        cam.quaternion.copy(a.quaternion).multiply(FLIP);
        if (this.mode === 'cockpit') {
          // Look down enough to see the instruments below the windshield.
          cam.quaternion.multiply(tmpQ.setFromAxisAngle(new Vector3(1, 0, 0), -COCKPIT_LOOK_DOWN));
          fov = 72;
          near = 0.08;
        }
        break;
      }
      case 'orbit': {
        // Orbit in the local horizon frame around the aircraft.
        const up = a.worldUp;
        tmp.copy(a.forward).addScaledVector(up, -a.forward.dot(up)).normalize();
        tmp2.crossVectors(tmp, up).normalize();
        const cp = Math.cos(this.orbitPitch);
        const dir = new Vector3()
          .addScaledVector(tmp, -Math.cos(this.orbitYaw) * cp)
          .addScaledVector(tmp2, Math.sin(this.orbitYaw) * cp)
          .addScaledVector(up, Math.sin(this.orbitPitch));
        cam.position.copy(a.position).addScaledVector(dir, this.orbitDistance);
        cam.up.copy(up);
        cam.lookAt(a.position);
        break;
      }
    }

    // Never below the terrain. Cameras fixed to the aircraft only need a small margin (a
    // Cessna pilot's eye is under 2 m above the runway); free cameras keep 2 m.
    const minHag = this.mode === 'cockpit' || this.mode === 'wing' ? 0.5 : 2;
    const hag = this.heightAboveGround(cam.position);
    if (hag !== undefined && hag < minHag) cam.position.addScaledVector(a.worldUp, minHag - hag);

    if (this.shake > 0) {
      const s = this.shake * 0.25;
      cam.position.x += Math.sin(this.t * 47) * s;
      cam.position.y += Math.sin(this.t * 53 + 1) * s;
      this.shake = Math.max(0, this.shake - dt * 1.5);
    }

    if (Math.abs(cam.fov - fov) > 0.01 || cam.near !== near) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 3);
      if (this.mode === 'cockpit') cam.fov = fov;
      cam.near = near;
      cam.updateProjectionMatrix();
    }
    this.initialised = true;
  }

  private readonly onDown = (e: PointerEvent) => {
    if (this.mode !== 'orbit') return;
    this.dragging = true;
    this.lx = e.clientX;
    this.ly = e.clientY;
  };

  private readonly onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.orbitYaw -= (e.clientX - this.lx) * 0.006;
    this.orbitPitch = Math.max(
      -0.3,
      Math.min(1.4, this.orbitPitch + (e.clientY - this.ly) * 0.006),
    );
    this.lx = e.clientX;
    this.ly = e.clientY;
  };

  private readonly onUp = () => {
    this.dragging = false;
  };

  private readonly onWheel = (e: WheelEvent) => {
    if (this.mode !== 'orbit') return;
    e.preventDefault();
    this.orbitDistance = Math.max(
      6,
      Math.min(200, this.orbitDistance * (e.deltaY > 0 ? 1.12 : 1 / 1.12)),
    );
  };
}
