/**
 * The cockpit as a list of controls: every switch, knob, lever and button the pilot can
 * operate, by name. The 3D cockpit (clicks), the interface (touch panels, checklists), the
 * procedures (what a checklist expects) and the systems all meet at these names, so none of
 * them needs to know the others.
 *
 * Values are plain numbers:
 * - toggle: 0 off, 1 on
 * - selector: index into `positions`
 * - lever and knob: a value between `min` and `max` (knobs move in `step`s)
 * - button: 1 while pressed, 0 otherwise (the systems act on the press)
 */
export type ControlKind = 'toggle' | 'selector' | 'lever' | 'knob' | 'button';

export interface ControlSpec {
  id: string;
  kind: ControlKind;
  /** Selector: the names of its positions, in order. */
  positions?: readonly string[];
  /** Lever and knob: range, and the smallest change of a knob. */
  min?: number;
  max?: number;
  step?: number;
  /** Knob: one step past `max` is `min` again (a heading bug 0..359, a frequency). */
  wraps?: boolean;
  /** Value after a reset to a parked, cold aircraft. */
  initial: number;
  /**
   * Value after a reset with the engine running (a start on the runway or in the air), if
   * different from `initial`.
   */
  running?: number;
}

export interface Cockpit {
  /** Every control of this aircraft. */
  readonly specs: readonly ControlSpec[];
  /** The value of a control; 0 for a name the aircraft does not have. */
  get(id: string): number;
  /** Sets a control, clamped (or wrapped) to its range. Unknown names are ignored. */
  set(id: string, value: number): void;
  has(id: string): boolean;
}

const lightSwitch = (id: string): ControlSpec => ({ id, kind: 'toggle', initial: 0 });
/** Frequencies are whole kHz: 118 000 to 136 975 for COM, 108 000 to 117 950 for NAV. */
const com = (id: string, initial: number): ControlSpec => ({
  id,
  kind: 'knob',
  min: 118_000,
  max: 136_975,
  step: 25,
  wraps: true,
  initial,
});
const nav = (id: string, initial: number): ControlSpec => ({
  id,
  kind: 'knob',
  min: 108_000,
  max: 117_950,
  step: 50,
  wraps: true,
  initial,
});
const course = (id: string): ControlSpec => ({
  id,
  kind: 'knob',
  min: 0,
  max: 359,
  step: 1,
  wraps: true,
  initial: 0,
});
const button = (id: string): ControlSpec => ({ id, kind: 'button', initial: 0 });

/**
 * The Cessna 172S with a classic panel: six round gauges, two NAV/COM radios with a VOR/ILS
 * and a VOR indicator, an ADF, a DME, a transponder, a single-axis-plus-altitude autopilot
 * (in the manner of the KAP 140) and a simple GPS that follows the flight plan.
 *
 * `throttle`, `mixture`, `flaps`, `trim` and `parkingBrake` are the same levers as the ones
 * in ControlInput: reading or setting them here reads or sets ControlInput.
 */
export const C172_CONTROLS: readonly ControlSpec[] = [
  // ---- electrical ----
  { id: 'battery', kind: 'toggle', initial: 0, running: 1 },
  { id: 'alternator', kind: 'toggle', initial: 0, running: 1 },
  { id: 'avionics', kind: 'toggle', initial: 0, running: 1 },
  // ---- engine ----
  {
    id: 'magnetos',
    kind: 'selector',
    // START springs back to BOTH when released.
    positions: ['off', 'right', 'left', 'both', 'start'],
    initial: 0,
    running: 3,
  },
  { id: 'fuelSelector', kind: 'selector', positions: ['left', 'both', 'right'], initial: 1 },
  /** Fuel shutoff valve: 1 = open (pushed in). */
  { id: 'fuelShutoff', kind: 'toggle', initial: 1 },
  { id: 'fuelPump', kind: 'toggle', initial: 0 },
  { id: 'throttle', kind: 'lever', min: 0, max: 1, initial: 0 },
  { id: 'mixture', kind: 'lever', min: 0, max: 1, initial: 0, running: 1 },
  { id: 'carbHeat', kind: 'lever', min: 0, max: 1, initial: 0 },
  // ---- flight controls ----
  { id: 'flaps', kind: 'selector', positions: ['0', '10', '20', '30'], initial: 0 },
  { id: 'trim', kind: 'knob', min: -1, max: 1, step: 0.02, initial: 0 },
  { id: 'parkingBrake', kind: 'toggle', initial: 1, running: 0 },
  // ---- lights and heat ----
  lightSwitch('lightBeacon'),
  lightSwitch('lightLanding'),
  lightSwitch('lightTaxi'),
  lightSwitch('lightNav'),
  lightSwitch('lightStrobe'),
  { id: 'lightPanel', kind: 'knob', min: 0, max: 1, step: 0.1, initial: 0 },
  { id: 'pitotHeat', kind: 'toggle', initial: 0 },
  // ---- instruments ----
  /** Altimeter setting, hPa. */
  { id: 'altimeterSetting', kind: 'knob', min: 950, max: 1050, step: 1, initial: 1013 },
  course('headingBug'),
  /** Aligns the directional gyro with the compass: degrees added to the gyro's heading. */
  { id: 'gyroAdjust', kind: 'knob', min: -180, max: 179, step: 1, wraps: true, initial: 0 },
  course('obs1'),
  course('obs2'),
  // ---- radios (frequencies in kHz) ----
  com('com1Active', 118_100),
  com('com1Standby', 121_500),
  button('com1Swap'),
  com('com2Active', 121_500),
  com('com2Standby', 121_500),
  button('com2Swap'),
  nav('nav1Active', 110_000),
  nav('nav1Standby', 110_000),
  button('nav1Swap'),
  nav('nav2Active', 110_000),
  nav('nav2Standby', 110_000),
  button('nav2Swap'),
  /** The DME listens to NAV 1 or NAV 2. */
  { id: 'dmeSource', kind: 'selector', positions: ['nav1', 'nav2'], initial: 0 },
  { id: 'adfFrequency', kind: 'knob', min: 190, max: 1750, step: 1, initial: 300 },
  /** Transponder code as its four octal digits read as a decimal number, e.g. 7000. */
  { id: 'xpdrCode', kind: 'knob', min: 0, max: 7777, step: 1, initial: 7000 },
  {
    id: 'xpdrMode',
    kind: 'selector',
    positions: ['off', 'standby', 'on', 'alt'],
    initial: 0,
    running: 3,
  },
  button('xpdrIdent'),
  // ---- autopilot ----
  button('apEngage'),
  button('apHdg'),
  button('apNav'),
  button('apApr'),
  button('apAlt'),
  button('apVsUp'),
  button('apVsDown'),
  /** Selected altitude, feet. */
  { id: 'apAltitude', kind: 'knob', min: 0, max: 20_000, step: 100, initial: 3000 },
  /** What the VOR/ILS indicator 1 and the autopilot's NAV mode follow. */
  { id: 'navSource', kind: 'selector', positions: ['nav1', 'gps'], initial: 0 },
];

/**
 * A cockpit over a table of values. Controls that mirror something else (the levers of
 * ControlInput) are bound with `bind`; everything else is stored here.
 */
export class CockpitPanel implements Cockpit {
  readonly specs: readonly ControlSpec[];
  private readonly byId = new Map<string, ControlSpec>();
  private readonly values = new Map<string, number>();
  private readonly bound = new Map<string, { get(): number; set(v: number): void }>();

  constructor(specs: readonly ControlSpec[]) {
    this.specs = specs;
    for (const s of specs) {
      this.byId.set(s.id, s);
      this.values.set(s.id, s.initial);
    }
  }

  /** Makes a control read and write something outside the panel. */
  bind(id: string, get: () => number, set: (v: number) => void) {
    this.bound.set(id, { get, set });
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): number {
    const b = this.bound.get(id);
    return b ? b.get() : (this.values.get(id) ?? 0);
  }

  set(id: string, value: number) {
    const s = this.byId.get(id);
    if (!s || !Number.isFinite(value)) return;
    const v = limit(s, value);
    const b = this.bound.get(id);
    if (b) b.set(v);
    else this.values.set(id, v);
  }

  /** Every control back to its parked value, or to its value with the engine running. */
  reset(running: boolean) {
    for (const s of this.specs) this.set(s.id, running ? (s.running ?? s.initial) : s.initial);
  }
}

/** A value brought into a control's range. */
export function limit(s: ControlSpec, value: number): number {
  if (s.kind === 'toggle' || s.kind === 'button') return value >= 0.5 ? 1 : 0;
  if (s.kind === 'selector') {
    const last = (s.positions?.length ?? 1) - 1;
    return Math.min(Math.max(Math.round(value), 0), last);
  }
  const min = s.min ?? 0;
  const max = s.max ?? 1;
  let v = value;
  if (s.step) v = min + Math.round((v - min) / s.step) * s.step;
  if (s.wraps) {
    // One step past max is min again.
    const span = max - min + (s.step ?? 0);
    v = min + ((((v - min) % span) + span) % span);
  }
  return Math.min(Math.max(v, min), max);
}
