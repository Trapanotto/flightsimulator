import {
  BoxGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  type Object3D,
} from 'three/webgpu';
import type { AircraftId, ControlInput, Telemetry } from '@sim';
import type { AircraftLights } from './lights';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * What the app needs from an aircraft on screen. The model's own frame is three's: x left,
 * y up, z forward; the app places `object` in render space from the simulation state.
 * The model's origin is the aircraft's centre of gravity (the simulation's reference point).
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
   * Where the tyres touch the ground with the gear at rest, model frame (nose, left, right).
   * Empty when a model has no gear.
   */
  readonly wheelContacts: readonly Vec3Like[];
  /**
   * Per frame: moving parts (control surfaces, propeller, gear, flaps), lights and the cockpit
   * instruments, all from the telemetry. `controls` moves yoke, pedals and levers.
   */
  update(dt: number, telemetry: Telemetry, controls: ControlInput): void;
  /** The camera sits in the cockpit: show the interior at full detail, hide what would clip. */
  setCockpitView(inside: boolean): void;
  /**
   * Metres added to `telemetry.altitude` (height above the ellipsoid) before the altimeter
   * shows it: the negative geoid height turns it into height above sea level (about -49 m
   * in Switzerland); a QNH correction can be folded in as well.
   */
  setAltimeterOffset(metres: number): void;
  /**
   * Exterior light switches. 'auto' (the default) follows what a pilot would do from the
   * telemetry; an object overrides single lights and keeps the rest.
   */
  setLights(lights: Partial<AircraftLights> | 'auto'): void;
  /**
   * The sky's exposure (about 4 at noon, hundreds at night): the lamps' glow shows weakly in
   * daylight and fully in the dark.
   */
  setExposure(exposure: number): void;
  dispose(): void;
}

export interface AircraftVisualOptions {
  /** 'low' for phones: smaller dial and skin textures, no clear coat. */
  quality?: 'high' | 'low';
  /**
   * Adds one spot light for the landing light. It is created with the aircraft and only
   * dimmed afterwards, so adding it never recompiles shaders later. Off by default.
   */
  landingLightSpot?: boolean;
  /** Scales the glow sprites of the exterior lights (default 1). */
  glowScale?: number;
  /** Overrides the model URL (default: BASE_URL + assets/aircraft/<id>.glb). */
  url?: string;
}

/** Loads the model of a type. Rejects if its files cannot be loaded. */
export async function loadAircraftVisual(
  id: AircraftId,
  options: AircraftVisualOptions = {},
): Promise<AircraftVisual> {
  switch (id) {
    case 'c172': {
      const { loadC172 } = await import('./C172Visual');
      return loadC172(options);
    }
    default:
      throw new Error(`loadAircraftVisual('${String(id)}'): no model for this type`);
  }
}

/**
 * Phase 0 placeholder: a 10 m marker with a nose, to check lighting, scale and orientation.
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
    wheelContacts: [],
    update() {},
    setCockpitView() {},
    setAltimeterOffset() {},
    setLights() {},
    setExposure() {},
    dispose() {
      object.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose();
      });
      paint.dispose();
      accent.dispose();
    },
  };
}
