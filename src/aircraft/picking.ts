/**
 * Which cockpit control a ray hits, in the model's own frame (x left, y up, z forward): a
 * few dozen boxes against one ray, no raycast against the model. Plain TypeScript, tested in
 * Node. Hit boxes come from the model (Hit_<id> nodes, a little larger than the controls so
 * a finger finds them); occluders are coarse boxes for the seats and the glareshield.
 */

export type V3 = readonly [number, number, number];

export interface HitBox {
  control: string;
  center: V3;
  half: V3;
  /** Axis that splits the box into a lower (-1) and an upper (+1) half; zero without sides. */
  side: V3;
  /** What one click changes instead of the control's own step (a coarse ring, a code digit). */
  step?: number;
  /** A lever with detents: the side is where the click is relative to the handle. */
  lever?: boolean;
}

/** Entry and exit distance of a ray through an axis-aligned box, or null. */
export function rayBox(o: V3, d: V3, c: V3, h: V3): [number, number] | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const lo = c[i]! - h[i]! - o[i]!;
    const hi = c[i]! + h[i]! - o[i]!;
    if (Math.abs(d[i]!) < 1e-12) {
      if (lo > 0 || hi < 0) return null;
      continue;
    }
    let a = lo / d[i]!;
    let b = hi / d[i]!;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return null;
  }
  if (t1 < 0) return null;
  return [Math.max(t0, 0), t1];
}

export function inBox(p: V3, c: V3, h: V3): boolean {
  return (
    Math.abs(p[0] - c[0]) <= h[0] && Math.abs(p[1] - c[1]) <= h[1] && Math.abs(p[2] - c[2]) <= h[2]
  );
}

export interface Pick {
  box: HitBox;
  distance: number;
  /**
   * Where the ray passes closest to the box's centre, model frame: for a ray that comes in at
   * a slant (the right edge of the radio stack seen from the left seat) it still tells the
   * halves apart as the pilot sees them.
   */
  point: [number, number, number];
}

/** Two boxes whose entries are this close (m) count as the same depth: the better-centred wins. */
const SAME_DEPTH = 0.012;

/**
 * The nearest control along the ray, if no occluder comes first. `d` must be a unit vector.
 * Among boxes entered at about the same depth (they overlap a little, being padded), the one
 * whose centre the ray passes closest to, relative to its size, wins.
 */
export function pickBox(
  o: V3,
  d: V3,
  boxes: readonly HitBox[],
  occluders: readonly { center: V3; half: V3 }[],
): Pick | null {
  let nearest = Infinity;
  const hits: { box: HitBox; t0: number; t1: number }[] = [];
  for (const b of boxes) {
    const r = rayBox(o, d, b.center, b.half);
    if (!r) continue;
    hits.push({ box: b, t0: r[0], t1: r[1] });
    if (r[0] < nearest) nearest = r[0];
  }
  if (!hits.length) return null;
  for (const oc of occluders) {
    const r = rayBox(o, d, oc.center, oc.half);
    if (r && r[0] < nearest) return null;
  }
  let best: (typeof hits)[number] | undefined;
  let bestScore = Infinity;
  for (const h of hits) {
    if (h.t0 > nearest + SAME_DEPTH) continue;
    const t = 0.5 * (h.t0 + h.t1);
    let score = 0;
    for (let i = 0; i < 3; i++) {
      const p = o[i]! + d[i]! * t;
      score = Math.max(score, Math.abs(p - h.box.center[i]!) / h.box.half[i]!);
    }
    // Prefer the nearer box a little when both are equally central.
    score += (h.t0 - nearest) * 10;
    if (score < bestScore) {
      bestScore = score;
      best = h;
    }
  }
  const b = best!.box;
  const t = (b.center[0] - o[0]) * d[0] + (b.center[1] - o[1]) * d[1] + (b.center[2] - o[2]) * d[2];
  return {
    box: best!.box,
    distance: best!.t0,
    point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t],
  };
}

/** -1 for the lower or left half, 1 for the upper or right one, 0 without sides. */
export function sideOf(point: V3, center: V3, axis: V3): -1 | 0 | 1 {
  if (!axis[0] && !axis[1] && !axis[2]) return 0;
  const s =
    (point[0] - center[0]) * axis[0] +
    (point[1] - center[1]) * axis[1] +
    (point[2] - center[2]) * axis[2];
  return s < 0 ? -1 : 1;
}

/**
 * Reference point of the design frame in the model frame: model = (BL, WL - 1.22, 1.041 - FS)
 * (tools/aircraft/c172/dims.py).
 */
function design(bl: number, fs: number, wl: number): [number, number, number] {
  return [bl, wl - 1.22, 1.041 - fs];
}

function boxFromDesign(
  lo: [number, number, number],
  hi: [number, number, number],
): { center: V3; half: V3 } {
  const a = design(...lo);
  const b = design(...hi);
  return {
    center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    half: [Math.abs(a[0] - b[0]) / 2, Math.abs(a[1] - b[1]) / 2, Math.abs(a[2] - b[2]) / 2],
  };
}

/** Where a camera counts as sitting in the cabin (front and rear seats), model frame. */
export const CABIN = boxFromDesign([-0.62, 0.3, 0.82], [0.62, 2.6, 1.98]);

/** Seats (cushions and backs) and the glareshield: nothing is reached through them. */
export const OCCLUDERS: readonly { center: V3; half: V3 }[] = [
  ...[0.27, -0.27].flatMap((bl) => [
    // Inset by the cushions' rounded edges.
    boxFromDesign([bl - 0.2, 0.89, 0.97], [bl + 0.2, 1.34, 1.08]),
    boxFromDesign([bl - 0.23, 1.34, 1.1], [bl + 0.23, 1.52, 1.76]),
  ]),
  boxFromDesign([-0.6, 0.0, 1.508], [0.6, 0.39, 1.6]),
];
