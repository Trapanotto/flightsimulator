/**
 * Small vector and quaternion helpers. They write into `out` arguments so the step allocates
 * nothing: at 120 Hz garbage would show up as stutter in the renderer.
 */
import type { Quat, Vec3 } from './types';

export const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function scale(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** out = a + b * s */
export function addScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

export function cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export const length = (a: Vec3) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);

export function normalize(out: Vec3, a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 ? scale(out, a, 1 / l) : set(out, 0, 0, 0);
}

/** Body to world: out = q * v * q^-1. */
export function rotate(out: Vec3, q: Quat, v: Vec3): Vec3 {
  const { x, y, z, w } = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  const ox = v.x + w * tx + (y * tz - z * ty);
  const oy = v.y + w * ty + (z * tx - x * tz);
  const oz = v.z + w * tz + (x * ty - y * tx);
  out.x = ox;
  out.y = oy;
  out.z = oz;
  return out;
}

/** World to body: out = q^-1 * v * q. */
export function rotateInverse(out: Vec3, q: Quat, v: Vec3): Vec3 {
  const x = -q.x;
  const y = -q.y;
  const z = -q.z;
  const w = q.w;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  const ox = v.x + w * tx + (y * tz - z * ty);
  const oy = v.y + w * ty + (z * tx - x * tz);
  const oz = v.z + w * tz + (x * ty - y * tx);
  out.x = ox;
  out.y = oy;
  out.z = oz;
  return out;
}

/**
 * Advances an orientation by a body-frame angular velocity over dt (exact rotation of the
 * increment, then renormalised so rounding never lets the quaternion drift off unit length).
 */
export function integrateOrientation(q: Quat, w: Vec3, dt: number): void {
  const wx = w.x * dt;
  const wy = w.y * dt;
  const wz = w.z * dt;
  const angle = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (angle < 1e-12) return;
  const s = Math.sin(angle / 2) / angle;
  const dx = wx * s;
  const dy = wy * s;
  const dz = wz * s;
  const dw = Math.cos(angle / 2);
  // q = q * d (body-frame increment multiplies on the right)
  const x = q.w * dx + q.x * dw + q.y * dz - q.z * dy;
  const y = q.w * dy - q.x * dz + q.y * dw + q.z * dx;
  const z = q.w * dz + q.x * dy - q.y * dx + q.z * dw;
  const ww = q.w * dw - q.x * dx - q.y * dy - q.z * dz;
  const n = 1 / Math.sqrt(x * x + y * y + z * z + ww * ww);
  q.x = x * n;
  q.y = y * n;
  q.z = z * n;
  q.w = ww * n;
}

/** Orientation whose body axes x, y, z point along the given orthonormal world vectors. */
export function quatFromAxes(out: Quat, bx: Vec3, by: Vec3, bz: Vec3): Quat {
  // Rotation matrix columns are the body axes in world coordinates.
  const m00 = bx.x,
    m01 = by.x,
    m02 = bz.x;
  const m10 = bx.y,
    m11 = by.y,
    m12 = bz.y;
  const m20 = bx.z,
    m21 = by.z,
    m22 = bz.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    out.w = 0.25 * s;
    out.x = (m21 - m12) / s;
    out.y = (m02 - m20) / s;
    out.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out.w = (m21 - m12) / s;
    out.x = 0.25 * s;
    out.y = (m01 + m10) / s;
    out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out.w = (m02 - m20) / s;
    out.x = (m01 + m10) / s;
    out.y = 0.25 * s;
    out.z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out.w = (m10 - m01) / s;
    out.x = (m02 + m20) / s;
    out.y = (m12 + m21) / s;
    out.z = 0.25 * s;
  }
  const n = 1 / Math.sqrt(out.x ** 2 + out.y ** 2 + out.z ** 2 + out.w ** 2);
  out.x *= n;
  out.y *= n;
  out.z *= n;
  out.w *= n;
  return out;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Piecewise linear lookup in a table of [x, y] rows sorted by x; clamps at the ends. */
export function lookup(table: readonly (readonly [number, number])[], x: number): number {
  const n = table.length;
  const first = table[0]!;
  if (x <= first[0]) return first[1];
  for (let i = 1; i < n; i++) {
    const b = table[i]!;
    if (x <= b[0]) {
      const a = table[i - 1]!;
      return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
    }
  }
  return table[n - 1]![1];
}

export const DEG = Math.PI / 180;
export const KT = 1852 / 3600;
export const FT = 0.3048;
