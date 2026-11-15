/**
 * What the A320's displays show, as plain numbers and strings: the FCU windows, the flight
 * mode annunciator's colours, speeds and limits of the tapes, the engine and fuel figures of
 * the E/WD. Plain TypeScript, tested in Node.
 *
 * The A320's flight guidance reports through an optional block of the avionics telemetry,
 * `telemetry.avionics.a320` (being added to src/sim/avionicsTypes.ts at the same time). Until
 * it exists the shape is defined here and read defensively; `readA320` keeps only what has the
 * right type, so a missing or partial block falls back to what the cockpit derives itself.
 */
import type { AvionicsTelemetry } from '@sim';

/** The A320 block of the avionics telemetry, as the displays read it. Every field optional. */
export interface A320Avionics {
  /**
   * Flight mode annunciator: five columns (1 autothrust, 2 vertical, 3 lateral, 4 approach
   * capability and minimums, 5 engagement), up to three lines each. Columns 2 and 3 put the
   * engaged mode in line 1 and the armed one in line 2 (drawn blue); column 1 green, except
   * thrust lever messages ('MAN TOGA', 'LVR CLB', ...) which are white; column 5 white.
   * Common texts: ['SPEED'|'MACH'|'THR CLB'|'THR IDLE'|'MAN TOGA'|'MAN FLX 68', ...],
   * ['SRS'|'CLB'|'OP CLB'|'ALT*'|'ALT'|'ALT CST'|'V/S +1200'|'DES'|'G/S*'|'G/S'|'LAND'|'FLARE'|
   * 'ROLL OUT', 'ALT'|'G/S'|'CLB'], ['RWY'|'NAV'|'HDG'|'LOC*'|'LOC', 'NAV'|'LOC'],
   * ['CAT 3', 'DUAL', 'DH 100'], ['AP1+2', '1 FD 2', 'A/THR'].
   */
  fma?: readonly (readonly string[])[];
  /** Characteristic speeds, knots indicated. */
  speeds?: {
    /** Minimum flap and slat retraction speeds, green dot (best lift to drag clean). */
    f?: number;
    s?: number;
    greenDot?: number;
    /** Lowest selectable speed, approach speed, the alpha protection and alpha max speeds. */
    vls?: number;
    vapp?: number;
    vAlphaProt?: number;
    vAlphaMax?: number;
    /** VMO or VFE of the configuration (the red and black strip). */
    vmax?: number;
    /** Take-off speeds while on the ground. */
    v1?: number;
    vr?: number;
  };
  /** The flight control law in force. */
  law?: 'normal' | 'alternate' | 'direct' | 'mechanical';
  /** Autobrake mode armed, and DECEL (the deceleration is reached). */
  autobrake?: { mode: 'off' | 'low' | 'medium' | 'max'; decel?: boolean };
  /** The ground spoilers are armed. */
  spoilersArmed?: boolean;
  /** ECAM: red warnings, amber cautions (first line the title), green memo lines. */
  warnings?: readonly string[];
  cautions?: readonly string[];
  memo?: readonly string[];
  /** Slat and flap positions reached, degrees (slats 0..27, flaps 0..40). */
  slats?: number;
  flaps?: number;
  /** Engagement, when the FMA does not say it: autopilots, autothrust, armed approach modes. */
  ap1?: boolean;
  ap2?: boolean;
  athr?: 'off' | 'armed' | 'active';
  loc?: boolean;
  appr?: boolean;
  exped?: boolean;
  /** Thrust limit mode and its N1 (per cent): 'TOGA' | 'FLX' | 'MCT' | 'CLB' | 'IDLE'. */
  thrustLimit?: { mode: string; n1: number; flexTemp?: number };
  /** The managed targets: speed (kt or Mach below 1), and the FMS's next altitude constraint (ft). */
  managedSpeed?: number;
  constraintAltitude?: number;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const strings = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : undefined;

/** The A320 block, or an empty object: only fields of the right type survive. */
export function readA320(av: AvionicsTelemetry | undefined): A320Avionics {
  const raw = (av as unknown as { a320?: Record<string, unknown> } | undefined)?.a320;
  if (!raw || typeof raw !== 'object') return {};
  const out: A320Avionics = {};
  const fma = raw.fma;
  if (Array.isArray(fma)) out.fma = fma.map((c) => strings(c) ?? []);
  const sp = raw.speeds as Record<string, unknown> | undefined;
  if (sp && typeof sp === 'object') {
    out.speeds = {};
    for (const k of [
      'f',
      's',
      'greenDot',
      'vls',
      'vapp',
      'vAlphaProt',
      'vAlphaMax',
      'vmax',
      'v1',
      'vr',
    ] as const) {
      const v = num(sp[k]);
      if (v !== undefined) out.speeds[k] = v;
    }
  }
  if (typeof raw.law === 'string') out.law = raw.law as A320Avionics['law'];
  const ab = raw.autobrake as { mode?: unknown; decel?: unknown } | undefined;
  if (ab && typeof ab.mode === 'string')
    out.autobrake = { mode: ab.mode as 'off', decel: bool(ab.decel) ?? false };
  for (const k of ['spoilersArmed', 'ap1', 'ap2', 'loc', 'appr', 'exped'] as const) {
    const v = bool(raw[k]);
    if (v !== undefined) out[k] = v;
  }
  if (typeof raw.athr === 'string') out.athr = raw.athr as A320Avionics['athr'];
  for (const k of ['warnings', 'cautions', 'memo'] as const) {
    const v = strings(raw[k]);
    if (v) out[k] = v;
  }
  for (const k of ['slats', 'flaps', 'managedSpeed', 'constraintAltitude'] as const) {
    const v = num(raw[k]);
    if (v !== undefined) out[k] = v;
  }
  const tl = raw.thrustLimit as { mode?: unknown; n1?: unknown; flexTemp?: unknown } | undefined;
  if (tl && typeof tl.mode === 'string' && num(tl.n1) !== undefined)
    out.thrustLimit = { mode: tl.mode, n1: num(tl.n1)!, flexTemp: num(tl.flexTemp) };
  return out;
}

// ---- FCU ---------------------------------------------------------------------------------------

/** The speed window: knots ('250'), Mach ('.78'), or dashes with the dot while managed. */
export function fcuSpeedText(value: number, mach: boolean, managed: boolean): string {
  if (managed) return '---';
  if (mach) return `.${String(Math.round(value) % 100).padStart(2, '0')}`;
  return String(Math.round(value)).padStart(3, '0');
}

export function fcuHeadingText(value: number, managed: boolean): string {
  if (managed) return '---';
  return String(((Math.round(value) % 360) + 360) % 360).padStart(3, '0');
}

/** The altitude window always shows the selected altitude, five digits. */
export function fcuAltitudeText(feet: number): string {
  return String(Math.max(0, Math.round(feet / 100) * 100)).padStart(5, '0');
}

/**
 * The V/S window: dashes unless V/S is engaged; then '+12oo' (hundreds in large digits, the
 * last two as small circles on the real unit).
 */
export function fcuVsText(fpm: number, engaged: boolean): string {
  if (!engaged) return '-----';
  const v = Math.round(fpm / 100);
  const sign = v < 0 ? '-' : '+';
  return `${sign}${String(Math.abs(v)).padStart(2, '0')}oo`;
}

// ---- FMA ---------------------------------------------------------------------------------------

export type FmaColor = 'green' | 'blue' | 'white' | 'magenta' | 'amber';

/** The colour of a line of the FMA by the Airbus conventions (FCOM 1.22.30). */
export function fmaColor(column: number, line: number, text: string): FmaColor {
  if (/(THR LK|A\.FLOOR|TOGA LK)/.test(text)) return 'amber';
  if (/^(MAN|LVR)/.test(text)) return 'white';
  if (column === 4) return 'white';
  if (column === 3) return line === 2 || /^(DH|MDA)/.test(text) ? 'blue' : 'white';
  if (line === 0) return 'green';
  return 'blue';
}

/** The text of each FMA column, padded to three lines (missing columns are empty). */
export function fmaLines(fma: readonly (readonly string[])[] | undefined): string[][] {
  const out: string[][] = [];
  for (let c = 0; c < 5; c++) {
    const col = fma?.[c] ?? [];
    out.push([col[0] ?? '', col[1] ?? '', col[2] ?? '']);
  }
  return out;
}

/**
 * The FMA's change boxes: a white box round a newly engaged mode for ten seconds. Fed the
 * texts every frame, it returns which column's first line is boxed.
 */
export class FmaBoxes {
  private last: string[] = [];
  private since: number[] = [];

  update(lines: string[][], time: number): boolean[] {
    return lines.map((col, i) => {
      const t = col[0] ?? '';
      if (t !== this.last[i]) {
        this.last[i] = t;
        this.since[i] = this.since[i] === undefined ? -100 : time;
      }
      return t !== '' && time - (this.since[i] ?? -100) < 10;
    });
  }
}

// ---- engines and fuel ----------------------------------------------------------------------------

/** CFM56-5B4 limits (type certificate E37NE): N1 104 %, N2 105 %, EGT 950 degrees take-off. */
export const CFM56_LIMITS = { n1: 104, n2: 105, egt: 950, egtStart: 725 } as const;

/** kg/s -> kg/h, rounded to 20 as the E/WD shows it. */
export function fuelFlowKgh(kgs: number): number {
  return Math.round((kgs * 3600) / 20) * 20;
}

/** Fuel on board as the E/WD shows it: kg rounded to 20. */
export function fobKg(kg: number): number {
  return Math.round(kg / 20) * 20;
}

/**
 * The thrust limit mode for the thrust levers (detents: idle 0, CLIMB 0.62, FLX/MCT 0.82,
 * TOGA 1) and its N1, when the flight guidance does not report it.
 */
export function thrustLimit(lever: number, onGround: boolean): { mode: string; n1: number } {
  if (lever > 0.9) return { mode: 'TOGA', n1: 95.6 };
  if (lever > 0.7) return onGround ? { mode: 'FLX', n1: 88.4 } : { mode: 'MCT', n1: 91.2 };
  return { mode: 'CLB', n1: 89.2 };
}

/** The thrust lever angle (degrees) of a lever position, for the N1 gauge's white donut. */
export function leverAngle(lever: number, reverse: boolean): number {
  if (reverse) return -20 * Math.min(Math.max(lever, 0), 1);
  // Detents at 0, 25 (CL), 35 (FLX/MCT), 45 (TOGA) degrees.
  const pts: [number, number][] = [
    [0, 0],
    [0.62, 25],
    [0.82, 35],
    [1, 45],
  ];
  const v = Math.min(Math.max(lever, 0), 1);
  for (let i = 1; i < pts.length; i++) {
    const [a, da] = pts[i - 1]!;
    const [b, db] = pts[i]!;
    if (v <= b) return da + ((v - a) / (b - a)) * (db - da);
  }
  return 45;
}

/** The N1 that a lever angle commands with autothrust off (for the gauge's donut). */
export function leverN1(angle: number, idle = 19.5, toga = 95.6): number {
  if (angle <= 0) return idle;
  return idle + ((toga - idle) * Math.min(angle, 45)) / 45;
}

// ---- tapes ---------------------------------------------------------------------------------------

/**
 * The speed tape's characteristic speeds when the flight guidance does not report them: from
 * the weight-free rules of thumb of the A320 at a typical landing mass (64 t): VLS 1.23 VS1g,
 * green dot about 2 x mass(t) + 85, S 1.23 VS1g clean-slat, F 1.18 VS1g conf 1+F.
 */
export function defaultSpeeds(
  config: number,
  massT = 64,
): Required<
  Pick<
    NonNullable<A320Avionics['speeds']>,
    'f' | 's' | 'greenDot' | 'vls' | 'vAlphaProt' | 'vAlphaMax' | 'vmax'
  >
> {
  const vs1g = [0, 1, 2, 3, 4].map((c) => [148, 120, 112, 109, 104][c]! * Math.sqrt(massT / 64));
  const c = Math.min(Math.max(Math.round(config), 0), 4);
  const vs = vs1g[c]!;
  const vfe = [350, 230, 200, 185, 177][c]!;
  return {
    f: Math.round(vs1g[2]! * 1.22),
    s: Math.round(vs1g[1]! * 1.22),
    greenDot: Math.round(2 * massT + 85),
    vls: Math.round(vs * 1.23),
    vAlphaProt: Math.round(vs * 1.1),
    vAlphaMax: Math.round(vs * 1.03),
    vmax: vfe,
  };
}

/** ND range of the range selector position (NM). */
export function ndRangeNm(index: number): number {
  return [10, 20, 40, 80, 160, 320][Math.min(Math.max(Math.round(index), 0), 5)]!;
}

export const ND_MODES = ['ils', 'vor', 'nav', 'arc', 'plan'] as const;
export type NdMode = (typeof ND_MODES)[number];

export const ECAM_PAGES = [
  'engine',
  'bleed',
  'press',
  'elec',
  'hyd',
  'fuel',
  'apu',
  'wheel',
  'fctl',
  'status',
] as const;
export type EcamPage = (typeof ECAM_PAGES)[number];

/** The baro window: 'QNH' over '1013', or 'Std'. */
export function baroText(hpa: number, std: boolean): string {
  return std ? 'Std' : String(Math.round(hpa)).padStart(4, '0');
}

/** RMP and radio windows: '118.100' (kHz in). */
export function freqText(khz: number): string {
  return (khz / 1000).toFixed(3);
}

/** Rudder trim window: 'L 2.3', 'R 0.5', '0.0'. */
export function rudderTrimText(trim: number): string {
  const deg = Math.round(Math.abs(trim) * 20 * 10) / 10;
  if (deg === 0) return '0.0';
  return `${trim < 0 ? 'L' : 'R'} ${deg.toFixed(1)}`;
}
