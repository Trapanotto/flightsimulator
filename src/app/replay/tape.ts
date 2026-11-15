/**
 * A column store for plain data trees (the telemetry, the pilot's controls): every leaf of the
 * tree gets its own column over the ring buffer's slots. Numbers go into Float32Array columns,
 * so recording a frame writes into preallocated memory and makes no garbage; booleans,
 * `undefined` and enums live in a byte column beside them, and strings by reference.
 *
 * Why columns and not a copy of the object per frame: an A320's telemetry has hundreds of
 * leaves in dozens of nested objects, and ten minutes at 20 Hz are 12 000 frames. As objects
 * that is well over 100 MB; as columns it is a few bytes per leaf and frame. The layout is
 * discovered from the data and only grows: a value that appears later (a flight director
 * switched on, a third caution line) gets a column then, and older frames read it as absent.
 */

const NUM = 0;
const UNDEF = 1;
const TRUE = 2;
const FALSE = 3;
const REF = 4;
const NULL = 5;
const OBJ = 6;
const ARR = 7;

/**
 * Arrays recorded as one reference instead of element by element: they are replaced, never
 * changed in place (the GPS flight plan, `GpsTelemetry.plan`), and can be long.
 */
const BY_REFERENCE = new Set(['plan']);

interface Wrap {
  period: number;
  min: number;
}
const DEGREES: Wrap = { period: 360, min: 0 };
const RADIANS: Wrap = { period: 2 * Math.PI, min: -Math.PI };
/**
 * Leaves that are angles going round: blending 359° and 1° must give 0°, not 180°. Found by
 * name because the telemetry types use the same names for the same thing everywhere.
 */
const WRAPS: Record<string, Wrap> = {
  headingDeg: DEGREES,
  trackDeg: DEGREES,
  heading: DEGREES,
  compass: DEGREES,
  bearing: DEGREES,
  course: DEGREES,
  track: DEGREES,
  desiredTrack: DEGREES,
  relativeBearing: DEGREES,
  lateralTarget: DEGREES,
  // Rolling through inverted flight crosses ±π.
  bank: RADIANS,
};

class Track {
  num: Float32Array | null = null;
  /** Null while every value so far was a number. */
  tag: Uint8Array | null = null;
  ref: unknown[] | null = null;
  /** Object children, in the order they were first seen (for-in order is stable). */
  readonly keys: string[] = [];
  readonly children: Track[] = [];
  private readonly byKey = new Map<string, Track>();
  /** Array elements. */
  readonly items: Track[] = [];
  /** The record call that last wrote this track. */
  stamp = -1;

  constructor(
    private readonly tape: Tape,
    readonly wrap: Wrap | undefined,
  ) {
    // Created after frames were already kept: those frames did not have it.
    if (tape.written > 0) this.tag = new Uint8Array(tape.capacity).fill(UNDEF);
  }

  child(key: string, hint: number): Track {
    if (this.keys[hint] === key) return this.children[hint]!;
    let t = this.byKey.get(key);
    if (!t) {
      t = new Track(this.tape, WRAPS[key]);
      this.byKey.set(key, t);
      this.keys.push(key);
      this.children.push(t);
    }
    return t;
  }

  item(index: number): Track {
    while (this.items.length <= index) this.items.push(new Track(this.tape, undefined));
    return this.items[index]!;
  }

  setTag(slot: number, tag: number) {
    if (!this.tag) {
      if (tag === NUM) return;
      this.tag = new Uint8Array(this.tape.capacity);
    }
    this.tag[slot] = tag;
  }

  setNum(slot: number, v: number) {
    (this.num ??= new Float32Array(this.tape.capacity))[slot] = v;
  }

  tagAt(slot: number) {
    return this.tag ? this.tag[slot]! : NUM;
  }

  bytes(): number {
    let n = (this.num?.byteLength ?? 0) + (this.tag?.byteLength ?? 0) + (this.ref?.length ?? 0) * 8;
    for (const c of this.children) n += c.bytes();
    for (const c of this.items) n += c.bytes();
    return n;
  }
}

export class Tape {
  /** Frames written since the last clear (not wrapped). */
  written = 0;
  private stamp = 0;
  private root: Track;
  private readonly holder: Record<string, unknown> = { v: undefined };

  constructor(readonly capacity: number) {
    this.root = new Track(this, undefined);
  }

  clear() {
    this.written = 0;
    this.root = new Track(this, undefined);
  }

  /** Writes `value` (an object) into `slot`. */
  write(slot: number, value: object) {
    this.stamp++;
    this.put(this.root, slot, value, undefined);
    this.written++;
  }

  private put(t: Track, slot: number, v: unknown, key: string | undefined) {
    t.stamp = this.stamp;
    switch (typeof v) {
      case 'number':
        t.setTag(slot, NUM);
        t.setNum(slot, v);
        return;
      case 'boolean':
        t.setTag(slot, v ? TRUE : FALSE);
        return;
      case 'undefined':
        t.setTag(slot, UNDEF);
        return;
      case 'object':
        if (v === null) {
          t.setTag(slot, NULL);
          return;
        }
        if (Array.isArray(v) && !(key !== undefined && BY_REFERENCE.has(key))) {
          t.setTag(slot, ARR);
          t.setNum(slot, v.length);
          for (let i = 0; i < v.length; i++) this.put(t.item(i), slot, v[i], undefined);
          // Elements beyond the end must not read as the stale values of an older frame.
          for (let i = v.length; i < t.items.length; i++) t.items[i]!.setTag(slot, UNDEF);
          return;
        }
        if (!Array.isArray(v)) {
          t.setTag(slot, OBJ);
          const o = v as Record<string, unknown>;
          let hint = 0;
          for (const k in o) this.put(t.child(k, hint++), slot, o[k], k);
          // Keys that went away this frame.
          for (const c of t.children) if (c.stamp !== this.stamp) c.setTag(slot, UNDEF);
          return;
        }
        // An array kept by reference.
        this.putRef(t, slot, v);
        return;
      default:
        this.putRef(t, slot, v);
    }
  }

  private putRef(t: Track, slot: number, v: unknown) {
    t.setTag(slot, REF);
    (t.ref ??= new Array<unknown>(this.capacity).fill(undefined))[slot] = v;
  }

  /**
   * Rebuilds the value of `slot` into `out`, blended towards slot `next` by `alpha` (numbers
   * only; everything else is taken from `slot`). Objects and arrays already in `out` are
   * reused, so reading the same tape again and again makes no garbage.
   */
  read(slot: number, next: number, alpha: number, out: object) {
    this.holder.v = out;
    this.get(this.root, slot, next, alpha, this.holder, 'v');
  }

  private get(
    t: Track,
    slot: number,
    next: number,
    alpha: number,
    parent: Record<string | number, unknown>,
    key: string | number,
  ) {
    switch (t.tagAt(slot)) {
      case NUM: {
        let v = t.num![slot]!;
        if (alpha > 0 && t.tagAt(next) === NUM) v = blend(v, t.num![next]!, alpha, t.wrap);
        parent[key] = v;
        return;
      }
      case UNDEF:
        parent[key] = undefined;
        return;
      case TRUE:
        parent[key] = true;
        return;
      case FALSE:
        parent[key] = false;
        return;
      case NULL:
        parent[key] = null;
        return;
      case REF:
        parent[key] = t.ref![slot];
        return;
      case OBJ: {
        let o = parent[key];
        if (typeof o !== 'object' || o === null || Array.isArray(o)) o = parent[key] = {};
        const obj = o as Record<string, unknown>;
        for (let i = 0; i < t.children.length; i++)
          this.get(t.children[i]!, slot, next, alpha, obj, t.keys[i]!);
        return;
      }
      case ARR: {
        let a = parent[key];
        if (!Array.isArray(a)) a = parent[key] = [];
        const arr = a as unknown[];
        const n = t.num![slot]!;
        arr.length = n;
        for (let i = 0; i < n; i++)
          this.get(t.items[i]!, slot, next, alpha, arr as unknown as Record<number, unknown>, i);
        return;
      }
    }
  }

  bytes(): number {
    return this.root.bytes();
  }
}

/**
 * Blends two recorded numbers. Two whole numbers a step of one or more apart are a switch,
 * a selector or a frequency that clicked over between samples, not a motion: they keep the
 * earlier value instead of passing through numbers nobody set (a COM at 118 012.5 kHz).
 */
function blend(a: number, b: number, alpha: number, wrap: Wrap | undefined): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a;
  const step = Number.isInteger(a) && Number.isInteger(b);
  if (!wrap) return step && Math.abs(b - a) >= 1 ? a : a + (b - a) * alpha;
  const p = wrap.period;
  let d = (b - a) % p;
  if (d > p / 2) d -= p;
  else if (d < -p / 2) d += p;
  if (step && Math.abs(d) >= 1) return a;
  const v = a + d * alpha;
  return v - p * Math.floor((v - wrap.min) / p);
}
