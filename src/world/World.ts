import { Group, Mesh, MeshStandardNodeMaterial, PlaneGeometry, type Camera } from 'three/webgpu';
import {
  abs,
  cameraPosition,
  color,
  float,
  fract,
  fwidth,
  length,
  min,
  mix,
  positionWorld,
  smoothstep,
} from 'three/tsl';
import type { LocalFrame } from '@geo';

/** How much of the world is drawn; set from the device class and the graphics setting. */
export interface WorldQuality {
  /** Metres to the far edge of what is drawn. */
  viewDistance: number;
}

/** Presets per device class; the app picks one. */
export const WORLD_QUALITY: Record<'desktop' | 'mobile', WorldQuality> = {
  desktop: { viewDistance: 150_000 },
  mobile: { viewDistance: 80_000 },
};

/** The ground at one place. */
export interface GroundInfo {
  /** Height above the ellipsoid, metres. */
  height: number;
  /** Unit normal of the surface in render space (x east, y up, z south). */
  normal: { x: number; y: number; z: number };
  /** What is there: decides wheel friction and whether a landing is survivable. */
  surface: 'asphalt' | 'concrete' | 'grass' | 'gravel' | 'snow' | 'water' | 'terrain';
}

/**
 * The ground and everything standing on it: terrain, trees, buildings, water, airports.
 *
 * Phase 0 placeholder: a flat reference plane with a 100 m / 1 km grid at the frame's origin
 * height. Phase 1 replaces the inside with the streamed terrain; this interface stays.
 */
export class World {
  /** Add to the scene. */
  readonly object = new Group();
  private readonly plane: Mesh;

  constructor(
    private frame: LocalFrame,
    quality: WorldQuality,
  ) {
    const p = positionWorld.xz;
    // Antialiased grid lines: distance to the nearest line in pixels.
    const grid = (cell: number) => {
      const c = p.div(cell);
      const d = abs(fract(c.sub(0.5)).sub(0.5)).div(fwidth(c));
      return float(1).sub(min(min(d.x, d.y), 1));
    };
    // The grids fade out with distance, where the lines would only shimmer.
    const dist = length(positionWorld.sub(cameraPosition));
    const fine = grid(100).mul(float(1).sub(smoothstep(1500, 6000, dist)));
    const coarse = grid(1000).mul(float(1).sub(smoothstep(20_000, 60_000, dist)));
    const material = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
    material.colorNode = mix(
      mix(color(0x4f6b3c), color(0xa9c48c), fine.mul(0.85)),
      color(0xdfe7d2),
      coarse.mul(0.8),
    );
    const size = quality.viewDistance * 2;
    this.plane = new Mesh(new PlaneGeometry(size, size, 1, 1), material);
    this.plane.rotation.x = -Math.PI / 2;
    this.plane.receiveShadow = true;
    this.object.name = 'World';
    this.object.add(this.plane);
  }

  /** Loads what is needed before the first frame (data source descriptions and the like). */
  async init(): Promise<void> {}

  /** The render frame moved (floating origin). */
  setFrame(frame: LocalFrame) {
    this.frame = frame;
  }

  /** Per frame: load and place what the camera sees. */
  update(camera: Camera) {
    // The plane follows the camera in whole kilometres, so the grid stays put.
    this.plane.position.x = Math.round(camera.position.x / 1000) * 1000;
    this.plane.position.z = Math.round(camera.position.z / 1000) * 1000;
  }

  /**
   * Height of the ground above the ellipsoid at lon/lat in metres, or undefined while that
   * place is not loaded.
   */
  groundHeight(_lon: number, _lat: number): number | undefined {
    return this.frame.origin.h;
  }

  /** The ground at lon/lat, or undefined while that place is not loaded. */
  ground(lon: number, lat: number): GroundInfo | undefined {
    const height = this.groundHeight(lon, lat);
    if (height === undefined) return undefined;
    return { height, normal: { x: 0, y: 1, z: 0 }, surface: 'grass' };
  }

  /** Credits of the data shown, for the interface. */
  readonly attribution: string[] = [];

  /** True while tiles for the current view are still loading. */
  get loading(): boolean {
    return false;
  }
}
