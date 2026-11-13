import {
  BoxGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  type Object3D,
} from 'three/webgpu';
import type { AircraftId, ControlInput, Telemetry } from '@sim';

/**
 * What the app needs from an aircraft on screen. The model's own frame is three's: x left,
 * y up, z forward; the app places `object` in render space from the simulation state.
 */
export interface AircraftVisual {
  readonly object: Object3D;
  /** Camera placement, in the model's frame (metres). */
  readonly view: {
    /** The pilot's eye point. */
    eye: { x: number; y: number; z: number };
    /** Outside camera: distance behind and height above the aircraft. */
    chaseDistance: number;
    chaseHeight: number;
  };
  /**
   * Per frame: moving parts (control surfaces, propeller, gear, flaps), lights and the cockpit
   * instruments, all from the telemetry. `controls` moves yoke, pedals and levers.
   */
  update(dt: number, telemetry: Telemetry, controls: ControlInput): void;
  /** The camera sits in the cockpit: show the interior at full detail, hide what would clip. */
  setCockpitView(inside: boolean): void;
  dispose(): void;
}

/** Loads the model of a type. Rejects if its files cannot be loaded. */
export function loadAircraftVisual(id: AircraftId): Promise<AircraftVisual> {
  return Promise.reject(new Error(`loadAircraftVisual('${id}'): the models arrive in phase 1`));
}

/**
 * Phase 0 placeholder: a 10 m marker with a nose, to check lighting, scale and orientation.
 * The real aircraft arrive in phase 1.
 */
export function createReferenceMarker(): AircraftVisual {
  const object = new Group();
  object.name = 'ReferenceMarker';
  const paint = new MeshStandardNodeMaterial({ color: 0xf2f2f0, roughness: 0.35, metalness: 0 });
  const accent = new MeshStandardNodeMaterial({ color: 0xd2232a, roughness: 0.4, metalness: 0 });
  const body = new Mesh(new BoxGeometry(1.4, 1.4, 8), paint);
  const wing = new Mesh(new BoxGeometry(11, 0.18, 1.6), paint);
  wing.position.set(0, 0.3, 0.6);
  const fin = new Mesh(new BoxGeometry(0.16, 1.8, 1.3), accent);
  fin.position.set(0, 1.4, -3.3);
  const nose = new Mesh(new ConeGeometry(0.7, 1.6, 24), accent);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 4.8;
  for (const m of [body, wing, fin, nose]) {
    m.castShadow = true;
    m.receiveShadow = true;
    object.add(m);
  }
  return {
    object,
    view: { eye: { x: 0, y: 1, z: 1 }, chaseDistance: 22, chaseHeight: 6 },
    update() {},
    setCockpitView() {},
    dispose() {
      object.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose();
      });
      paint.dispose();
      accent.dispose();
    },
  };
}
