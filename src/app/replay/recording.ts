import type {
  AircraftInfo,
  AircraftState,
  Cockpit,
  ControlInput,
  ControlSpec,
  Telemetry,
} from '@sim';
import { Tape } from './tape';

/** What a recording reads from an aircraft (a `SimAircraft` fits). */
export interface RecordSource {
  readonly info?: AircraftInfo;
  readonly state: AircraftState;
  readonly telemetry: Telemetry;
  readonly controls: ControlInput;
  readonly cockpit: Cockpit;
}

/**
 * One moment of a recorded flight, shaped like the live aircraft: `state` goes to
 * `stateToRenderPose`, the rest to `visual.update(dt, telemetry, controls, cockpit)`, the
 * HUD and the sound. The objects are reused from frame to frame; copy what must be kept.
 */
export interface ReplayFrame {
  /** Seconds of the flight (the `time` given to `record`). */
  time: number;
  state: AircraftState;
  telemetry: Telemetry;
  controls: ControlInput;
  /** The cockpit's switches and knobs as they stood; `set` does nothing. */
  cockpit: Cockpit;
}

export interface RecordingOptions {
  /** Frames kept per second (default 20). */
  rate?: number;
  /** Seconds kept before the oldest frames are overwritten (default 15 minutes). */
  seconds?: number;
}

/** Position, orientation, velocity, angular velocity. */
const STATE = 13;

/** A cockpit read from recorded values. */
class RecordedCockpit implements Cockpit {
  specs: readonly ControlSpec[] = [];
  values = new Float64Array(0);
  private index = new Map<string, number>();

  setSpecs(specs: readonly ControlSpec[]) {
    if (specs === this.specs) return;
    this.specs = specs;
    this.values = new Float64Array(specs.length);
    this.index = new Map(specs.map((s, i) => [s.id, i]));
  }

  get(id: string): number {
    const i = this.index.get(id);
    return i === undefined ? 0 : this.values[i]!;
  }

  set() {
    // A replay shows what the pilot did; it cannot be changed.
  }

  has(id: string): boolean {
    return this.index.has(id);
  }
}

/**
 * The last minutes of a flight, sampled at a fixed rate into a ring buffer: enough to show
 * the flight again (aircraft, moving parts, cockpit displays, HUD, sound) without running the
 * simulation. The app calls `record` every frame; it keeps a frame every 1/rate seconds of
 * flight time and overwrites the oldest once the buffer is full.
 *
 * Memory: the state as doubles (position needs them), the telemetry and the controls as one
 * float per leaf (see `Tape`), the cockpit's controls as floats.
 */
export class FlightRecording {
  readonly rate: number;
  readonly capacity: number;
  /** Aircraft type of the recorded flight. */
  info: AircraftInfo | undefined;
  private readonly times: Float64Array;
  private readonly states: Float64Array;
  private readonly tape: Tape;
  private cockpitValues = new Float32Array(0);
  private specs: readonly ControlSpec[] = [];
  private source: RecordSource | undefined;
  /** Index of the oldest frame and number of frames held. */
  private head = 0;
  private count = 0;
  private next = 0;
  private last = -Infinity;
  /** Reused by `write` so recording makes no garbage. */
  private readonly roots = { telemetry: undefined as unknown, controls: undefined as unknown };

  constructor(options: RecordingOptions = {}) {
    this.rate = options.rate ?? 20;
    this.capacity = Math.ceil((options.seconds ?? 15 * 60) * this.rate) + 1;
    this.times = new Float64Array(this.capacity);
    this.states = new Float64Array(this.capacity * STATE);
    this.tape = new Tape(this.capacity);
  }

  /** Frames held. */
  get length() {
    return this.count;
  }

  /** Time of the oldest and the newest frame held (0 when empty). */
  get start() {
    return this.count ? this.times[this.head]! : 0;
  }

  get end() {
    return this.count ? this.times[this.slot(this.count - 1)]! : 0;
  }

  get duration() {
    return this.end - this.start;
  }

  clear() {
    this.head = this.count = 0;
    this.next = 0;
    this.last = -Infinity;
    this.tape.clear();
    this.source = undefined;
    this.info = undefined;
  }

  /**
   * Call every frame with the flight's time (`Flight.time`: the time of `aircraft.state`).
   * Keeps a frame when the next sample is due and returns whether it did. Time going
   * backwards (a restarted flight) or another aircraft starts a new recording.
   */
  record(time: number, aircraft: RecordSource): boolean {
    if (aircraft !== this.source || time < this.last) {
      this.clear();
      this.source = aircraft;
      this.info = aircraft.info;
    }
    if (time + 1e-9 < this.next) return false;
    const interval = 1 / this.rate;
    // Stay on the sample grid; after a pause in recording, start a new one from here.
    this.next = Math.max(this.next + interval, time + interval * 0.5);
    this.last = time;
    this.write(time, aircraft);
    return true;
  }

  private write(time: number, a: RecordSource) {
    let slot: number;
    if (this.count < this.capacity) slot = this.slot(this.count++);
    else {
      slot = this.head;
      this.head = (this.head + 1) % this.capacity;
    }
    this.times[slot] = time;
    const s = a.state;
    const st = this.states;
    let o = slot * STATE;
    st[o++] = s.position.x;
    st[o++] = s.position.y;
    st[o++] = s.position.z;
    st[o++] = s.orientation.x;
    st[o++] = s.orientation.y;
    st[o++] = s.orientation.z;
    st[o++] = s.orientation.w;
    st[o++] = s.velocity.x;
    st[o++] = s.velocity.y;
    st[o++] = s.velocity.z;
    st[o++] = s.angularVelocity.x;
    st[o++] = s.angularVelocity.y;
    st[o] = s.angularVelocity.z;

    const specs = a.cockpit.specs;
    if (specs !== this.specs) {
      // The same aircraft never changes its controls; a new list means a new flight.
      this.specs = specs;
      this.cockpitValues = new Float32Array(this.capacity * specs.length);
    }
    const cv = this.cockpitValues;
    const n = specs.length;
    for (let i = 0; i < n; i++) cv[slot * n + i] = a.cockpit.get(specs[i]!.id);

    this.roots.telemetry = a.telemetry;
    this.roots.controls = a.controls;
    this.tape.write(slot, this.roots);
  }

  /** Ring slot of the i-th frame held (0 = oldest). */
  private slot(i: number) {
    return (this.head + i) % this.capacity;
  }

  /** A frame object to pass to `sample`. */
  createFrame(): ReplayFrame {
    return {
      time: 0,
      state: {
        position: { x: 0, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
        velocity: { x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
      },
      telemetry: {} as Telemetry,
      controls: {} as ControlInput,
      cockpit: new RecordedCockpit(),
    };
  }

  /**
   * The flight at `time` (clamped to the frames held), blended between the two frames around
   * it, into `out` (from `createFrame`). Nothing happens while the recording is empty.
   */
  sample(time: number, out: ReplayFrame): ReplayFrame {
    if (this.count === 0) return out;
    const t = Math.min(Math.max(time, this.start), this.end);
    // The last frame at or before t.
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[this.slot(mid)]! <= t) lo = mid;
      else hi = mid - 1;
    }
    const a = this.slot(lo);
    const b = this.slot(Math.min(lo + 1, this.count - 1));
    const ta = this.times[a]!;
    const span = this.times[b]! - ta;
    const alpha = span > 0 ? Math.min(Math.max((t - ta) / span, 0), 1) : 0;
    out.time = t;
    this.blendState(a, b, alpha, span, out.state);

    const cockpit = out.cockpit as RecordedCockpit;
    cockpit.setSpecs(this.specs);
    const n = this.specs.length;
    const cv = this.cockpitValues;
    for (let i = 0; i < n; i++) {
      const x = cv[a * n + i]!;
      const y = cv[b * n + i]!;
      // Switches and detents click over; levers and knobs move.
      cockpit.values[i] =
        Number.isInteger(x) && Number.isInteger(y) && Math.abs(y - x) >= 1
          ? x
          : x + (y - x) * alpha;
    }

    this.roots.telemetry = out.telemetry;
    this.roots.controls = out.controls;
    this.tape.read(a, b, alpha, this.roots);
    out.telemetry = this.roots.telemetry as Telemetry;
    out.controls = this.roots.controls as ControlInput;
    this.roots.telemetry = this.roots.controls = undefined;
    return out;
  }

  /**
   * Position along a cubic through both frames with their velocities (at 20 Hz a straight
   * line would cut the corners of a tight turn), orientation by slerp, rates linearly.
   */
  private blendState(a: number, b: number, u: number, span: number, out: AircraftState) {
    const s = this.states;
    const A = a * STATE;
    const B = b * STATE;
    const h00 = 2 * u * u * u - 3 * u * u + 1;
    const h10 = (u * u * u - 2 * u * u + u) * span;
    const h01 = -2 * u * u * u + 3 * u * u;
    const h11 = (u * u * u - u * u) * span;
    const hermite = (i: number) =>
      h00 * s[A + i]! + h10 * s[A + 7 + i]! + h01 * s[B + i]! + h11 * s[B + 7 + i]!;
    out.position.x = hermite(0);
    out.position.y = hermite(1);
    out.position.z = hermite(2);
    const lerp = (i: number) => s[A + i]! + (s[B + i]! - s[A + i]!) * u;
    out.velocity.x = lerp(7);
    out.velocity.y = lerp(8);
    out.velocity.z = lerp(9);
    out.angularVelocity.x = lerp(10);
    out.angularVelocity.y = lerp(11);
    out.angularVelocity.z = lerp(12);
    slerp(s, A + 3, B + 3, u, out.orientation);
  }

  /** Bytes held by the buffers (typed arrays, and 8 per reference). */
  memoryBytes(): number {
    return (
      this.times.byteLength +
      this.states.byteLength +
      this.cockpitValues.byteLength +
      this.tape.bytes()
    );
  }
}

/** Spherical interpolation of the quaternions at s[i..i+3] and s[j..j+3], short arc. */
function slerp(
  s: Float64Array,
  i: number,
  j: number,
  u: number,
  out: { x: number; y: number; z: number; w: number },
) {
  const ax = s[i]!, ay = s[i + 1]!, az = s[i + 2]!, aw = s[i + 3]!; // prettier-ignore
  let bx = s[j]!, by = s[j + 1]!, bz = s[j + 2]!, bw = s[j + 3]!; // prettier-ignore
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    // q and -q are the same rotation; take the one on the short way round.
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let ka: number;
  let kb: number;
  if (cos > 0.9995) {
    ka = 1 - u;
    kb = u;
  } else {
    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    ka = Math.sin((1 - u) * angle) / sin;
    kb = Math.sin(u * angle) / sin;
  }
  const x = ka * ax + kb * bx;
  const y = ka * ay + kb * by;
  const z = ka * az + kb * bz;
  const w = ka * aw + kb * bw;
  const n = Math.hypot(x, y, z, w) || 1;
  out.x = x / n;
  out.y = y / n;
  out.z = z / n;
  out.w = w / n;
}
