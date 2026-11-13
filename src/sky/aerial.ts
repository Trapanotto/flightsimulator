/**
 * Aerial perspective: the air between the camera and what was drawn. Reconstructs distance
 * and direction of every pixel from the depth buffer and looks the in-scattered light and
 * the transmittance up in the aerial perspective table (luts.ts), which follows the curved
 * Earth out to 220 km.
 */
import type { NodeBuilder } from 'three/webgpu';
import {
  Fn,
  clamp,
  float,
  floor,
  log,
  max,
  min,
  mix,
  normalize,
  select,
  sqrt,
  vec2,
  vec3,
} from 'three/tsl';
import type { AtmosphereLuts } from './luts';
import {
  AP_AZIMUTH,
  AP_ELEVATION,
  AP_MAX_DISTANCE,
  AP_SLICES,
  apAzimuthToU,
  apElevationToV,
  azimuthBetween,
  rgb,
  type F,
  type V2,
  type V3,
} from './nodes';
import type { SkyUniforms } from './uniforms';

/** View-space ray through a screen position (uv with y down, as the post passes have it). */
export function viewRay(u: SkyUniforms, uv: V2): V3 {
  const ndc = vec2(uv.x.mul(2).sub(1), float(1).sub(uv.y).mul(2).sub(1));
  // From the projection's x/y terms only: works for every depth convention and view offsets.
  return normalize(
    vec3(
      ndc.x.add(u.projectionOffset.x).div(u.projection.x),
      ndc.y.add(u.projectionOffset.y).div(u.projection.y),
      -1,
    ),
  );
}

/**
 * View-space z (negative) of a depth buffer value, for the depth convention of the renderer
 * the shader is built for: standard, reversed (`reversedDepthBuffer`) or logarithmic
 * (`logarithmicDepthBuffer`).
 */
export const depthToViewZ = Fn(([depth, near, far]: [F, F, F], builder: NodeBuilder) => {
  const renderer = builder.renderer as {
    logarithmicDepthBuffer?: boolean;
    reversedDepthBuffer?: boolean;
  };
  if (renderer.logarithmicDepthBuffer === true) {
    // three writes log2(z / near) / log2(far / near) (not reversed, even with reversed depth).
    return depth
      .mul(log(far.div(near)))
      .exp()
      .mul(near)
      .negate();
  }
  if (renderer.reversedDepthBuffer === true)
    return near.mul(far).div(near.sub(far).mul(depth).sub(near));
  return near.mul(far).div(far.sub(near).mul(depth).sub(far));
});

/**
 * Distance (metres) along the view ray and whether the pixel is empty sky (depth at the far
 * plane, where the dome is drawn without writing depth).
 */
export function sceneDistance(
  u: SkyUniforms,
  depth: F,
  rayView: V3,
): { dist: F; sky: Node<'bool'> } {
  const viewZ = depthToViewZ(depth, u.near, u.far) as unknown as F;
  const dist = viewZ.div(min(rayView.z, -1e-6));
  return { dist, sky: viewZ.negate().greaterThanEqual(u.far.mul(0.995)) };
}

type Node<T> = import('three/webgpu').Node<T>;

/**
 * In-scattered light (sky units, not exposed) and transmittance from the camera to a point
 * at `distKm` in direction `dir`.
 */
export function aerialLookup(
  u: SkyUniforms,
  luts: AtmosphereLuts,
  dir: V3,
  distKm: F,
): { inscatter: V3; transmittance: V3 } {
  const mu = clamp(dir.dot(u.up), -1, 1);
  const az = azimuthBetween(dir, u.sunDir, u.up);
  const x = apAzimuthToU(az)
    .mul(AP_AZIMUTH - 1)
    .add(0.5);
  const y = apElevationToV(mu)
    .mul(AP_ELEVATION - 1)
    .add(0.5)
    .div(AP_ELEVATION);
  const s = sqrt(max(distKm, 0).div(AP_MAX_DISTANCE)).mul(AP_SLICES).sub(1);
  const sc = clamp(s, -1, AP_SLICES - 1);
  const k0 = floor(sc);
  const f = sc.sub(k0);
  const width = AP_AZIMUTH * AP_SLICES;
  const at = (k: F) => vec2(k.mul(AP_AZIMUTH).add(x).div(width), y);
  const k0c = max(k0, 0);
  const k1c = min(k0.add(1), AP_SLICES - 1);
  const first = k0.lessThan(0);
  const in0 = rgb(luts.apInscatterNode.sample(at(k0c)).level(float(0)));
  const in1 = rgb(luts.apInscatterNode.sample(at(k1c)).level(float(0)));
  const t0 = rgb(luts.apTransmittanceNode.sample(at(k0c)).level(float(0)));
  const t1 = rgb(luts.apTransmittanceNode.sample(at(k1c)).level(float(0)));
  // Before the first slice the air fades in from nothing at the camera.
  const a = select(first, vec3(0), in0).div(luts.sunScale);
  const ta = select(first, vec3(1), t0);
  return { inscatter: mix(a, in1.div(luts.sunScale), f), transmittance: mix(ta, t1, f) };
}
