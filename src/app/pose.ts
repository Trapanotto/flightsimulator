import type { LocalFrame } from '@geo';
import type { AircraftState, Quat, Vec3 } from '@sim';

const RAD = Math.PI / 180;

/** A position and orientation in render space, as three.js objects take them. */
export interface RenderPose {
  position: Vec3;
  quaternion: Quat;
}

function quatMul(a: Quat, b: Quat, out: Quat): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

/** Quaternion of the rotation whose matrix has the rows r0, r1, r2. */
function quatFromRows(r0: Vec3, r1: Vec3, r2: Vec3, out: Quat): Quat {
  const m00 = r0.x, m01 = r0.y, m02 = r0.z; // prettier-ignore
  const m10 = r1.x, m11 = r1.y, m12 = r1.z; // prettier-ignore
  const m20 = r2.x, m21 = r2.y, m22 = r2.z; // prettier-ignore
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out.w = 0.25 / s;
    out.x = (m21 - m12) * s;
    out.y = (m02 - m20) * s;
    out.z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out.w = (m21 - m12) / s;
    out.x = 0.25 * s;
    out.y = (m01 + m10) / s;
    out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out.w = (m02 - m20) / s;
    out.x = (m01 + m10) / s;
    out.y = 0.25 * s;
    out.z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out.w = (m10 - m01) / s;
    out.x = (m02 + m20) / s;
    out.y = (m12 + m21) / s;
    out.z = 0.25 * s;
  }
  return out;
}

/**
 * Rotation from a 3D model's axes (x left, y up, z forward) to the simulation's body axes
 * (x forward, y right, z down): model x -> body -y, model y -> body -z, model z -> body +x.
 * As a matrix its columns are those images; here as rows of the same matrix.
 */
const MODEL_TO_BODY = quatFromRows(
  { x: 0, y: 0, z: 1 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 0, w: 1 },
);

/** Rotation from ECEF to the render frame at lon/lat (rows: east, up, south). */
export function ecefToFrameRotation(lon: number, lat: number, out: Quat): Quat {
  const sl = Math.sin(lon * RAD);
  const cl = Math.cos(lon * RAD);
  const sp = Math.sin(lat * RAD);
  const cp = Math.cos(lat * RAD);
  return quatFromRows(
    { x: -sl, y: cl, z: 0 },
    { x: cp * cl, y: cp * sl, z: sp },
    { x: sp * cl, y: sp * sl, z: -cp },
    out,
  );
}

const tmpQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
const frameQ: Quat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Where to draw an aircraft: its simulation state (ECEF, body axes) as a position and
 * orientation of its 3D model in the render frame.
 */
export function stateToRenderPose(state: AircraftState, frame: LocalFrame, out: RenderPose) {
  frame.toLocal(state.position, out.position);
  ecefToFrameRotation(frame.origin.lon, frame.origin.lat, frameQ);
  // model -> body -> world (ECEF) -> render frame
  quatMul(state.orientation, MODEL_TO_BODY, tmpQ);
  quatMul(frameQ, tmpQ, out.quaternion);
  return out;
}

/** Blends two states for drawing between simulation steps (alpha 0 = a, 1 = b). */
export function lerpState(a: AircraftState, b: AircraftState, alpha: number, out: AircraftState) {
  const l = (x: number, y: number) => x + (y - x) * alpha;
  out.position.x = l(a.position.x, b.position.x);
  out.position.y = l(a.position.y, b.position.y);
  out.position.z = l(a.position.z, b.position.z);
  out.velocity.x = l(a.velocity.x, b.velocity.x);
  out.velocity.y = l(a.velocity.y, b.velocity.y);
  out.velocity.z = l(a.velocity.z, b.velocity.z);
  out.angularVelocity.x = l(a.angularVelocity.x, b.angularVelocity.x);
  out.angularVelocity.y = l(a.angularVelocity.y, b.angularVelocity.y);
  out.angularVelocity.z = l(a.angularVelocity.z, b.angularVelocity.z);
  // Normalised lerp on the short arc: steps are 1/120 s apart, so the angle is tiny.
  const qa = a.orientation;
  const qb = b.orientation;
  const sign = qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w < 0 ? -1 : 1;
  let x = l(qa.x, qb.x * sign);
  let y = l(qa.y, qb.y * sign);
  let z = l(qa.z, qb.z * sign);
  let w = l(qa.w, qb.w * sign);
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n;
  y /= n;
  z /= n;
  w /= n;
  out.orientation.x = x;
  out.orientation.y = y;
  out.orientation.z = z;
  out.orientation.w = w;
  return out;
}

export function copyState(from: AircraftState, to: AircraftState) {
  return lerpState(from, from, 0, to);
}

export function emptyState(): AircraftState {
  return {
    position: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
  };
}
