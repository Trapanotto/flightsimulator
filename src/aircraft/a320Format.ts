/**
 * What the A320's displays show, as plain numbers and strings: the FCU windows, the flight
 * mode annunciator's colours, speeds and limits of the tapes, the engine and fuel figures of
 * the E/WD. Plain TypeScript, tested in Node.
 *
 * The A320's flight guidance, flight control and system computers report through
 * `telemetry.avionics.autopilot.airbus` (AirbusTelemetry in src/sim/avionicsTypes.ts). The
 * displays read it defensively through `readA320`: only fields of the right type survive, NaN
 * means hidden, and a missing or partial block falls back to what the cockpit derives itself.
 */
import type { AvionicsTelemetry } from '@sim';

/** What the displays take from the Airbus block, flattened. Every field optional. */
export interface A320Avionics {
  /**
   * Flight mode annunciator: five columns (1 autothrust, 2 vertical, 3 lateral, 4 approach
   * capability and minimum, 5 engagement), up to three lines each; the armed modes in line 2.
   */
  fma?: readonly (readonly string[])[];
  /** LAND, FLARE and ROLL OUT span columns 2 and 3. */
  fmaCombined?: boolean;
  /** A mode has just changed in a column (the white box). */
  fmaChanged?: readonly boolean[];
  /** Column 5's A/THR is armed (blue) rather than active (white). */
  athrArmed?: boolean;
  /** Characteristic speeds, knots indicated (absent = hidden). */
  speeds?: {
    f?: number;
    s?: number;
    greenDot?: number;
    vls?: number;
    vapp?: number;
    vAlphaProt?: number;
    vAlphaMax?: number;
    vmax?: number;
    v1?: number;
    vr?: number;
    vfeNext?: number;
  };
  /** The speed target (kt, or Mach when `mach`), managed or selected, and the 10 s trend (kt). */
  target?: { speed: number; managed: boolean; mach: boolean; trend?: number };
  /** The FCU's windows: undefined values show dashes. */
  fcu?: {
    speed?: number;
    mach: boolean;
    heading?: number;
    altitude?: number;
    verticalSpeed?: number;
    speedDot: boolean;
    headingDot: boolean;
    altitudeDot: boolean;
  };
  law?: 'normal' | 'alternate' | 'direct' | 'mechanical';
  config?: string;
  autobrake?: { mode: 'off' | 'low' | 'medium' | 'max'; decel?: boolean };
  spoilersArmed?: boolean;
  groundSpoilers?: boolean;
  speedbrake?: number;
  /** Stabiliser, degrees (positive nose up). */
  stabiliser?: number;
  /** ECAM: red warnings, amber cautions, green memo lines; the master lights. */
  warnings?: readonly string[];
  cautions?: readonly string[];
  memo?: readonly string[];
  masterWarning?: boolean;
  masterCaution?: boolean;
  /** Slat and flap positions reached, degrees (slats 0..27, flaps 0..35). */
  slats?: number;
  flaps?: number;
  /** Engagement lights of the FCU. */
  ap1?: boolean;
  ap2?: boolean;
  athr?: 'off' | 'armed' | 'active';
  loc?: boolean;
  appr?: boolean;
  exped?: boolean;
  /** Thrust limit mode and its N1 (not reported yet: the cockpit derives it). */
  thrustLimit?: { mode: string; n1: number; flexTemp?: number };
  /** The flight guidance's altitude target (ft) and whether it is a constraint (magenta). */
  altitudeTarget?: { feet: number; constraint: boolean };
  /** System page values as the computers report them. */
  systems?: {
    apu?: {
      master?: boolean;
      n?: number;
      egt?: number;
      available?: boolean;
      bleed?: boolean;
      generator?: boolean;
    };
    hydraulics?: [number, number, number];
    fuel?: { tanks?: [number, number, number]; used?: number; crossfeed?: boolean };
    air?: { cabinAltitude?: number; cabinRate?: number; differential?: number };
    batteryVolts?: [number, number];
    grossMass?: number;
    brakesParking?: boolean;
  };
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : undefined;
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
const triple = (v: unknown): [number, number, number] | undefined =>
  Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => num(x) !== undefined)
    ? [v[0] as number, v[1] as number, v[2] as number]
    : undefined;

/** The Airbus block flattened for the displays, or an empty object without one. */
export function readA320(av: AvionicsTelemetry | undefined): A320Avionics {
  const raw = obj((av?.autopilot as unknown as { airbus?: unknown } | undefined)?.airbus);
  if (!raw) return {};
  const out: A320Avionics = {};
  const fma = obj(raw.fma);
  if (fma) {
    const cap = str(fma.capability);
    // 'CAT 3 DUAL' reads 'CAT 3' over 'DUAL' on the display.
    const capLines = /^CAT 3 /.test(cap) ? ['CAT 3', cap.slice(6)] : [cap];
    const athr = str(fma.autothrust);
    out.fma = [
      [str(fma.thrust), str(fma.thrustCaution)],
      [str(fma.vertical), str(fma.verticalArmed)],
      [str(fma.lateral), str(fma.lateralArmed)],
      [...capLines, str(fma.minimum)].filter((s, i) => s !== '' || i === 0),
      [
        str(fma.autopilot),
        str(fma.flightDirectors),
        athr === 'active' || athr === 'armed' ? 'A/THR' : '',
      ],
    ];
    out.fmaCombined = bool(fma.combined) ?? false;
    const ch = fma.changed;
    if (Array.isArray(ch)) out.fmaChanged = ch.map((b) => b === true);
    out.athrArmed = athr === 'armed';
    out.athr = athr === 'active' || athr === 'armed' ? athr : 'off';
    out.ap1 = /AP1/.test(str(fma.autopilot));
    out.ap2 = /AP2|AP1\+2/.test(str(fma.autopilot));
  }
  const sp = obj(raw.speeds);
  if (sp) {
    out.speeds = {};
    const map = [
      ['f', 'f'],
      ['s', 's'],
      ['greenDot', 'greenDot'],
      ['vls', 'vls'],
      ['vapp', 'vapp'],
      ['vAlphaProt', 'alphaProt'],
      ['vAlphaMax', 'alphaMax'],
      ['vmax', 'vmax'],
      ['v1', 'v1'],
      ['vr', 'vr'],
      ['vfeNext', 'vfeNext'],
    ] as const;
    for (const [k, from] of map) {
      const v = num(sp[from]);
      if (v !== undefined) out.speeds[k] = v;
    }
    const mach = bool(sp.mach) ?? false;
    const target = num(mach ? sp.targetMach : sp.target);
    if (target !== undefined)
      out.target = {
        speed: target,
        managed: bool(sp.managed) ?? false,
        mach,
        trend: num(sp.trend),
      };
  }
  const fcu = obj(raw.fcu);
  if (fcu) {
    out.fcu = {
      speed: num(fcu.speed),
      mach: bool(fcu.mach) ?? false,
      heading: num(fcu.heading),
      altitude: num(fcu.altitude),
      verticalSpeed: num(fcu.verticalSpeed),
      speedDot: bool(fcu.speedDot) ?? false,
      headingDot: bool(fcu.headingDot) ?? false,
      altitudeDot: bool(fcu.altitudeDot) ?? false,
    };
    for (const k of ['loc', 'appr', 'exped', 'ap1', 'ap2'] as const) {
      const v = bool(fcu[k]);
      if (v !== undefined) out[k] = v;
    }
  }
  const g = obj(raw.guidance);
  const alt = num(g?.altitudeTarget);
  if (alt !== undefined)
    out.altitudeTarget = { feet: alt, constraint: bool(g?.altitudeConstraint) ?? false };
  const fc = obj(raw.controls);
  if (fc) {
    const law = str(fc.law);
    if (law) out.law = law as A320Avionics['law'];
    if (str(fc.config) || typeof fc.config === 'string') out.config = str(fc.config);
    out.slats = num(fc.slats);
    out.flaps = num(fc.flaps);
    out.stabiliser = num(fc.stabiliser);
    out.spoilersArmed = bool(fc.spoilersArmed);
    out.groundSpoilers = bool(fc.groundSpoilers);
    out.speedbrake = num(fc.speedbrake);
    const ab = str(fc.autobrake);
    if (ab) out.autobrake = { mode: ab as 'off', decel: bool(fc.autobrakeDecel) ?? false };
    if (out.slats === undefined) delete out.slats;
    if (out.flaps === undefined) delete out.flaps;
  }
  const ec = obj(raw.ecam);
  if (ec) {
    const w = strings(ec.warnings);
    const master = bool(ec.masterWarning) ?? false;
    // One list, red warnings first: with the master warning on they are red, else amber.
    if (w) {
      if (master) out.warnings = w;
      else out.cautions = w;
    }
    const m = strings(ec.memo);
    if (m) out.memo = m;
    out.masterWarning = master;
    out.masterCaution = bool(ec.masterCaution) ?? false;
  }
  const sy = obj(raw.systems);
  if (sy) {
    const apu = obj(sy.apu);
    const hyd = obj(sy.hydraulics);
    const fuel = obj(sy.fuel);
    const air = obj(sy.air);
    const el = obj(sy.electrical);
    const bv = el?.batteryVolts;
    out.systems = {
      apu: apu
        ? {
            master: bool(apu.master),
            n: num(apu.n),
            egt: num(apu.egt),
            available: bool(apu.available),
            bleed: bool(apu.bleed),
            generator: bool(apu.generator),
          }
        : undefined,
      hydraulics: hyd ? triple([hyd.green, hyd.blue, hyd.yellow]) : undefined,
      fuel: fuel
        ? { tanks: triple(fuel.tanks), used: num(fuel.used), crossfeed: bool(fuel.crossfeed) }
        : undefined,
      air: air
        ? {
            cabinAltitude: num(air.cabinAltitude),
            cabinRate: num(air.cabinRate),
            differential: num(air.differential),
          }
        : undefined,
      batteryVolts:
        Array.isArray(bv) && num(bv[0]) !== undefined && num(bv[1]) !== undefined
          ? [bv[0] as number, bv[1] as number]
          : undefined,
      grossMass: num(sy.grossMass),
      brakesParking: bool(obj(sy.brakes)?.parking),
    };
  }
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
