/**
 * How a crashed aircraft breaks apart, as plain functions (tested in Node): how bad the impact
 * was, which part of the airframe each triangle belongs to, and which piece it flies off with.
 *
 * The models merge most of the fixed airframe into one mesh (fewer draw calls), so names alone
 * cannot say what breaks off: named parts that survive (gear legs, the propeller, control
 * surfaces) go by name, everything else by where its triangles lie in the model frame
 * (x left, y up, z forward): the fuselage tube, the left and right wing, the tail.
 */
import type { AircraftInfo, Telemetry } from '@sim';

const DEG = Math.PI / 180;

/**
 * Delay between the impact (the aircraft breaking up) and the fuel exploding, s. The crash
 * sound in the audio package uses the same value (a test keeps them equal).
 */
export const EXPLOSION_DELAY = 0.45;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** How the aircraft hit the ground. */
export interface Impact {
  /** What the simulation reported (`telemetry.crashed`): 'ground', 'wing', 'gear', … */
  reason: string;
  /** Speed (m/s), sink rate (m/s, positive down) and bank (rad, positive = right wing down). */
  speed: number;
  sink: number;
  bank: number;
  /** Stall speed of the type (m/s): what counts as a landing-like touchdown. */
  vStall: number;
}

/** Severity: 1 gear and propeller off, airframe whole; 2 a wing or the tail off; 3 destroyed. */
export type Severity = 1 | 2 | 3;

/**
 * Judged by the physics of the impact, not only by the part that touched first (a belly
 * landing with the nose a little low still reports a nose or ground contact). The thresholds
 * are the old game's (v0.11.0).
 */
export function severityOf(i: Impact): Severity {
  // Broke up in the air: whatever hits the ground afterwards is in pieces.
  if (i.reason === 'overstress') return 3;
  const path = Math.asin(Math.min(1, i.sink / Math.max(i.speed, 1)));
  if (i.sink > 15 || i.speed > 2.2 * i.vStall || path > 25 * DEG) return 3;
  const wingDown = Math.abs(i.bank) > 25 * DEG || i.reason === 'wing';
  if (!wingDown && i.sink < 8 && i.speed < 1.7 * i.vStall) return 1;
  return 2;
}

/** What `impactOf` reads from the telemetry. */
export type ImpactTelemetry = Pick<Telemetry, 'groundSpeed' | 'verticalSpeed' | 'bank'>;

/**
 * The impact from the telemetry of the last step BEFORE the crash: in the crash step the
 * simulation stops the aircraft, so its speeds already read zero.
 */
export function impactOf(
  before: ImpactTelemetry,
  reason: string,
  info: Pick<AircraftInfo, 'vs'>,
): Impact {
  const sink = Math.max(0, -before.verticalSpeed);
  return {
    reason,
    speed: Math.hypot(before.groundSpeed, before.verticalSpeed),
    sink,
    bank: before.bank,
    vStall: info.vs,
  };
}

/**
 * Keeps the last telemetry before a crash (the crash step zeroes the speeds) and hands out the
 * impact once, in the frame the crash is reported. Call `observe` every frame (or step).
 */
export class ImpactWatch {
  private last: ImpactTelemetry = { groundSpeed: 0, verticalSpeed: 0, bank: 0 };
  private reported = false;

  observe(t: Telemetry, info: Pick<AircraftInfo, 'vs'>): Impact | undefined {
    if (!t.crashed) {
      this.last = { groundSpeed: t.groundSpeed, verticalSpeed: t.verticalSpeed, bank: t.bank };
      this.reported = false;
      return undefined;
    }
    if (this.reported) return undefined;
    this.reported = true;
    return impactOf(this.last, t.crashed, info);
  }

  /** A new flight. */
  reset() {
    this.reported = false;
    this.last = { groundSpeed: 0, verticalSpeed: 0, bank: 0 };
  }
}

// -------------------------------------------------------------------------------------------
// Where the parts are

/** Model-frame outline of an airframe, enough to tell fuselage, wings and tail apart. */
export interface Layout {
  /** Half width of the fuselage, m: triangles further out belong to a wing. */
  halfWidth: number;
  /** Behind this z (m) the tail begins … */
  tailZ: number;
  /** … where everything above finY or further out than tailHalfWidth is fin or stabiliser. */
  finY: number;
  tailHalfWidth: number;
  /** Tail and nose end of the fuselage (z, m): where the slabs of a broken fuselage lie. */
  zTail: number;
  zNose: number;
  /** Half span, m. */
  semiSpan: number;
}

/**
 * Per model (by its root name, ModelConfig.name), measured from the .glb files: the fuselage
 * widths and the start of the tail are design figures no heuristic finds reliably in a merged
 * airframe (the F/A-18's blended body, the A320's belly fairing).
 */
export const LAYOUTS: Readonly<Record<string, Layout>> = {
  C172: {
    halfWidth: 0.6,
    tailZ: -4.4,
    finY: 0.62,
    tailHalfWidth: 0.6,
    zTail: -6.2,
    zNose: 2.1,
    semiSpan: 5.5,
  },
  PC12: {
    halfWidth: 0.92,
    tailZ: -5.6,
    finY: 1.05,
    tailHalfWidth: 0.92,
    zTail: -8.45,
    zNose: 5.95,
    semiSpan: 8.2,
  },
  A320: {
    halfWidth: 2.15,
    tailZ: -13.5,
    finY: 2.9,
    tailHalfWidth: 2.15,
    zTail: -21,
    zNose: 16.2,
    semiSpan: 17,
  },
  FA18: {
    halfWidth: 1.45,
    tailZ: -3.6,
    finY: 0.75,
    tailHalfWidth: 1.5,
    zTail: -8.4,
    zNose: 8.7,
    semiSpan: 5.7,
  },
};

/** A layout for an unknown model, from its bounding box (span along x, length along z). */
export function layoutFromBounds(min: Vec3Like, max: Vec3Like): Layout {
  const semi = Math.max(Math.abs(min.x), Math.abs(max.x));
  const len = max.z - min.z;
  const halfWidth = Math.max(0.5, 0.055 * len);
  return {
    halfWidth,
    tailZ: min.z + 0.25 * len,
    finY: max.y - 0.6 * (max.y - min.y),
    tailHalfWidth: halfWidth,
    zTail: min.z,
    zNose: max.z,
    semiSpan: semi,
  };
}

export type Region = 'body' | 'wingL' | 'wingR' | 'tail';

/** Which part of the airframe a point (model frame) belongs to. Left wing: x > 0. */
export function regionOf(p: Vec3Like, l: Layout): Region {
  const ax = Math.abs(p.x);
  if (p.z < l.tailZ && (ax > l.tailHalfWidth || p.y > l.finY)) return 'tail';
  if (ax > l.halfWidth) return p.x > 0 ? 'wingL' : 'wingR';
  return 'body';
}

// -------------------------------------------------------------------------------------------
// Named parts

/** What a part does in a crash, by name: does not become debris, gear, propeller, or by place. */
export type Role = 'skip' | 'gear' | 'prop' | 'free';

/**
 * Glass shatters, lamps and light glows, the cockpit interior, the pilot, the propeller disc,
 * flames and vapour do not fly about as debris; antennas and fittings are too small to see.
 */
const SKIP =
  /^(Cockpit|Cabin|Glass|Canopy_?Glass|CanopyGlass|Lamp_|Lens|Glow_|Eye|Hit_|Disp_|Face_|PropDisc|FanDisc|Antennas|Fittings|Wicks|Labels|Flame|Vapour|Pilot|HudCombiner)/;
/** Materials that never become debris, whatever part carries them. */
const SKIP_MATERIAL = /^(Glass|GaugeGlass|LightLens|PropDisc|Flame|VapourLex|Lamp_)/;
const GEAR =
  /^(Gear|MainGear|NoseGear|NoseSteer|Wheel|WheelFairing|MainDoor|NoseDoor|MainLeg|NoseLeg|LaunchBar|Hook)/;
const PROP = /^(Prop|Spinner)/;

/** A part's name without the level-of-detail suffix. */
export function baseName(name: string): string {
  return name.replace(/_lod\d$/, '').replace(/_geo$/, '');
}

export function roleOf(name: string, material = ''): Role {
  const n = baseName(name);
  if (SKIP.test(n) || SKIP_MATERIAL.test(material)) return 'skip';
  if (GEAR.test(n)) return 'gear';
  if (PROP.test(n)) return 'prop';
  return 'free';
}

// -------------------------------------------------------------------------------------------
// Which piece

/** Decided once per crash, from the impact and a seeded random generator. */
export interface BreakPlan {
  severity: Severity;
  /** The wing that hit (the low one when banked). */
  side: 'L' | 'R';
  tailOff: boolean;
  /** A destroyed fuselage breaks into this many slabs (2 behind the wing, 3 also at the nose). */
  slabs: number;
  /** A destroyed wing of a large aircraft breaks once more, mid-span. */
  splitWings: boolean;
}

export function planBreak(impact: Impact, layout: Layout, rnd: () => number): BreakPlan {
  const severity = severityOf(impact);
  // Bank > 0 = right wing down (the simulation's convention).
  const side =
    Math.abs(impact.bank) > 8 * DEG ? (impact.bank > 0 ? 'R' : 'L') : rnd() < 0.5 ? 'L' : 'R';
  const tailOff = severity === 3 || (severity === 2 && (impact.sink > 9 || rnd() < 0.5));
  return {
    severity,
    side,
    tailOff,
    slabs: impact.speed > 80 || layout.zNose - layout.zTail > 20 ? 3 : 2,
    splitWings: layout.semiSpan > 6.5,
  };
}

/** The kind of a piece: the airframe that stays together, a torn-off section, or debris. */
export type PieceKind = 'hull' | 'section' | 'debris';

export function kindOf(key: string): PieceKind {
  if (key === 'hull') return 'hull';
  if (key.startsWith('section:')) return 'section';
  return 'debris';
}

/** A small irregularity of a cut, so the break lines are jagged rather than straight. */
export function wobble(a: number, b: number): number {
  return Math.sin(a * 9.1 + b * 7.3) * 0.04 + Math.sin(a * 23.7 - b * 17.9) * 0.015;
}

/**
 * The piece a triangle goes with, from its centroid `c` (model frame), the part that owns it
 * (`owner`, without suffix) and whether that part is a separately moving one (a pivot: control
 * surface, door, fan). Null: it does not become debris.
 */
export function pieceKey(
  owner: string,
  role: Role,
  pivot: boolean,
  c: Vec3Like,
  plan: BreakPlan,
  layout: Layout,
): string | null {
  if (role === 'skip') return null;
  if (role === 'gear') {
    // One mesh with both legs (the C172's spring gear) still breaks into two.
    const side = /_[LR]$/.test(owner) || Math.abs(c.x) < 0.3 ? '' : c.x > 0 ? ':L' : ':R';
    return `gear:${owner}${side}`;
  }
  if (role === 'prop') return 'prop';
  const region = regionOf(c, layout);
  const sev = plan.severity;
  if (sev === 1) return 'hull';
  if (sev === 2) {
    if (region === `wing${plan.side}`) return `section:${region}`;
    if (region === 'tail' && plan.tailOff) return 'section:tail';
    return 'hull';
  }
  // Destroyed: moving parts come off on their own, the rest breaks along its structure.
  if (pivot) return `part:${owner}`;
  if (region === 'body') {
    const span = layout.zNose - layout.zTail;
    const f = (c.z - layout.zTail) / span + wobble(c.x, c.y);
    const i = Math.min(plan.slabs - 1, Math.max(0, Math.floor(f * plan.slabs)));
    return `body:${i}`;
  }
  if (region === 'tail') return 'tail';
  if (!plan.splitWings) return region;
  const g =
    (Math.abs(c.x) - layout.halfWidth) / (layout.semiSpan - layout.halfWidth) + wobble(c.y, c.z);
  return `${region}:${g < 0.45 ? 0 : 1}`;
}

/**
 * Sorts the triangles of an indexed (or plain) mesh into pieces. `centroid(t, out)` writes the
 * model-frame centroid of triangle t; the result lists, per key, the vertex indices of its
 * triangles. Every triangle lands in exactly one list, or in none when its key is null.
 */
export function splitTriangles(
  index: ArrayLike<number> | null,
  vertexCount: number,
  centroid: (a: number, b: number, c: number, out: Vec3Like) => void,
  keyOf: (c: Vec3Like) => string | null,
): Map<string, number[]> {
  const tris = index ? Math.floor(index.length / 3) : Math.floor(vertexCount / 3);
  const out = new Map<string, number[]>();
  const c = { x: 0, y: 0, z: 0 };
  for (let t = 0; t < tris; t++) {
    const a = index ? index[t * 3]! : t * 3;
    const b = index ? index[t * 3 + 1]! : t * 3 + 1;
    const d = index ? index[t * 3 + 2]! : t * 3 + 2;
    centroid(a, b, d, c);
    const key = keyOf(c);
    if (key === null) continue;
    let list = out.get(key);
    if (!list) out.set(key, (list = []));
    list.push(a, b, d);
  }
  return out;
}

/** Size of an aircraft relative to a 10 m one: scales fire, smoke and debris speeds. */
export function sizeFactor(length: number): number {
  return Math.min(4, Math.max(0.8, length / 10));
}

/**
 * Fire and its light against the sky's exposure (about 4 at noon, up to 1e5 on a moonlit
 * night). A fire has a fixed brightness, so it would glare ever more as the eye adapts to the
 * dark; but the eye adapts to the fire it looks at too. So the gain rises only slowly and
 * stops early: the fire stays yellow-orange at night instead of burning out to white, and
 * still reads against a sunlit field by day.
 */
export function fireGain(exposure: number): number {
  return Math.min(1.3, Math.max(1, (exposure / 4.2) ** 0.2));
}
