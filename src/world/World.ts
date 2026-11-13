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

/**
 * The ground and everything standing on it: terrain, trees, buildings, water, airports.
 *
 * Phase 0 placeholder: a flat reference plane with a 100 m / 1 km grid at the frame's origin
 * height. Phase 1 replaces the inside with the streamed terrain; this interface stays.
 */
export class World {
  /** Add to the scene. */
  readonly object = new Group();
  private readonly ground: Mesh;

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
    this.ground = new Mesh(new PlaneGeometry(size, size, 1, 1), material);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.object.name = 'World';
    this.object.add(this.ground);
  }

  /** The render frame moved (floating origin). */
  setFrame(frame: LocalFrame) {
    this.frame = frame;
  }

  /** Per frame: load and place what the camera sees. */
  update(camera: Camera) {
    // The plane follows the camera in whole kilometres, so the grid stays put.
    this.ground.position.x = Math.round(camera.position.x / 1000) * 1000;
    this.ground.position.z = Math.round(camera.position.z / 1000) * 1000;
  }

  /**
   * Height of the ground above the ellipsoid at lon/lat in metres, or undefined while that
   * place is not loaded.
   */
  groundHeight(_lon: number, _lat: number): number | undefined {
    return this.frame.origin.h;
  }

  /** True while tiles for the current view are still loading. */
  get loading(): boolean {
    return false;
  }
}
