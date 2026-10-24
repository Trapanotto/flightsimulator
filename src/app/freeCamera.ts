import * as THREE from 'three';
import { EnuFrame, threeToEnu } from '../geo/wgs84';

const START_SPEED = 90;
const MIN_SPEED = 5;
const MAX_SPEED = 2_000;
const LOOK_SENSITIVITY = 0.0022;

export interface CameraStart {
  lon: number;
  lat: number;
  height: number;
  targetLon: number;
  targetLat: number;
  targetHeight: number;
  /** Optional initial heading in degrees (0 = north, 90 = east). */
  headingDeg?: number;
  /** Optional initial pitch in degrees (positive = up). */
  pitchDeg?: number;
}

/**
 * Phase-1 free flight camera. Pointer lock for looking, WASD/QE for movement,
 * mouse wheel for speed. It deliberately feels like a free camera, not an
 * aircraft yet.
 */
export class FreeCamera {
  private yaw = 0;
  private pitch = 0;
  private speed = START_SPEED;
  private readonly keys = new Set<string>();
  private readonly frame: EnuFrame;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly start: CameraStart;
  private readonly initialPosition = new THREE.Vector3();
  private readonly initialYaw: number;
  private readonly initialPitch: number;
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private disposed = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    frame: EnuFrame,
    canvas: HTMLCanvasElement,
    start: CameraStart,
  ) {
    this.camera = camera;
    this.frame = frame;
    this.canvas = canvas;
    this.start = start;

    const position = frame.toEnu(start.lon, start.lat, start.height);
    camera.position.set(position.e, position.u, -position.n);

    if (start.headingDeg === undefined && start.pitchDeg === undefined) {
      const target = frame.toEnu(
        start.targetLon,
        start.targetLat,
        start.targetHeight,
      );
      const dx = target.e - position.e;
      const dy = target.u - position.u;
      const dz = -(target.n - position.n);
      const horizontal = Math.hypot(dx, dz);
      this.yaw = Math.atan2(-dx, -dz);
      this.pitch = Math.atan2(dy, horizontal);
    } else {
      this.yaw = -((start.headingDeg ?? 0) * Math.PI) / 180;
      this.pitch = ((start.pitchDeg ?? 0) * Math.PI) / 180;
    }
    this.applyRotation();

    this.initialPosition.copy(camera.position);
    this.initialYaw = this.yaw;
    this.initialPitch = this.pitch;

    this.bind();
  }

  private bind() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onBlur);
    this.canvas.addEventListener('click', this.onCanvasClick);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('contextmenu', this.onContextMenu);
  }

  update(dt: number) {
    if (this.disposed) return;

    const forward = new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    const right = new THREE.Vector3(
      Math.cos(this.yaw),
      0,
      -Math.sin(this.yaw),
    );

    const move = new THREE.Vector3();
    if (this.keys.has('KeyW')) move.add(forward);
    if (this.keys.has('KeyS')) move.sub(forward);
    if (this.keys.has('KeyD')) move.add(right);
    if (this.keys.has('KeyA')) move.sub(right);
    if (this.keys.has('KeyE') || this.keys.has('Space')) move.y += 1;
    if (this.keys.has('KeyQ')) move.y -= 1;

    if (move.lengthSq() > 0) {
      move.normalize();
      let speed = this.speed;
      if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) {
        speed *= 5;
      }
      if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) {
        speed *= 0.2;
      }
      this.camera.position.addScaledVector(move, speed * dt);
    }

    this.applyRotation();
  }

  getSpeed(): number {
    return this.speed;
  }

  reset() {
    this.camera.position.copy(this.initialPosition);
    this.yaw = this.initialYaw;
    this.pitch = this.initialPitch;
    this.speed = START_SPEED;
    this.applyRotation();
  }

  getGeodetic() {
    const enu = threeToEnu(
      this.camera.position.x,
      this.camera.position.y,
      this.camera.position.z,
    );
    return this.frame.fromEnuGeodetic(enu.e, enu.n, enu.u);
  }

  getHeading(): number {
    const heading = (-this.yaw * 180) / Math.PI;
    return (heading + 360) % 360;
  }

  isPointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  requestPointerLock() {
    if (document.pointerLockElement === this.canvas) return;
    try {
      const result = this.canvas.requestPointerLock?.();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          // Embedded previews and some browsers disallow pointer lock.
          // Dragging with the left mouse button remains available.
        });
      }
    } catch {
      // Ignore: drag-to-look is the fallback.
    }
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('click', this.onCanvasClick);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('contextmenu', this.onContextMenu);
  }

  private applyRotation() {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'KeyR') {
      this.reset();
      return;
    }
    this.keys.add(event.code);
    if (
      ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(
        event.code,
      )
    ) {
      event.preventDefault();
    }
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private onBlur = () => {
    this.keys.clear();
  };

  private onCanvasClick = () => {
    this.requestPointerLock();
  };

  private onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    if (document.pointerLockElement === this.canvas) return;
    this.dragging = true;
    this.lastPointer = { x: event.clientX, y: event.clientY };
  };

  private onMouseUp = () => {
    this.dragging = false;
  };

  private onMouseMove = (event: MouseEvent) => {
    let dx = 0;
    let dy = 0;

    if (document.pointerLockElement === this.canvas) {
      dx = event.movementX;
      dy = event.movementY;
    } else if (this.dragging) {
      dx = event.clientX - this.lastPointer.x;
      dy = event.clientY - this.lastPointer.y;
      this.lastPointer = { x: event.clientX, y: event.clientY };
    } else {
      return;
    }

    this.yaw -= dx * LOOK_SENSITIVITY;
    this.pitch -= dy * LOOK_SENSITIVITY;
    this.pitch = Math.max(
      -Math.PI / 2 + 0.01,
      Math.min(Math.PI / 2 - 0.01, this.pitch),
    );
  };

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0012);
    this.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, this.speed * factor));
  };

  private onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  };

  private onPointerLockChange = () => {
    this.dragging = false;
  };

  private onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };

  getStart(): CameraStart {
    return this.start;
  }
}
