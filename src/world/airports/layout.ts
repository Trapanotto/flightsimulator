/**
 * Where the paint and the lights of a runway go, by ICAO Annex 14 (Aerodromes, Volume I,
 * chapter 5): pure numbers in the runway's own coordinates, no renderer, tested in Node.
 *
 * Runway coordinates: `s` metres along the runway from end A (its pavement end) towards end B,
 * `t` metres to the right of the centre line looking from A to B. Per-end figures use `a`,
 * metres from that end's landing threshold in its landing direction, and `x` metres to the
 * right in that direction.
 */
import { type RunwayEndInfo, type RunwayInfo, isPaved, oppositeIdent } from '@geo';

/** Threshold stripes in total by runway width (Annex 14, 5.2.4.5). */
const STRIPES_BY_WIDTH: Array<[number, number]> = [
  [60, 16],
  [45, 12],
  [30, 8],
  [23, 6],
  [18, 4],
];

/** Number of threshold stripes for a runway of `width` metres. */
export function thresholdStripes(width: number): number {
  for (const [w, n] of STRIPES_BY_WIDTH) if (width >= w - 0.5) return n;
  return 4;
}

/**
 * Stripe geometry across the runway: stripes and gaps of equal width, the gap at the centre
 * line twice as wide, the outermost stripe ending 3 m inside the edge or 27 m from the centre
 * line, whichever is nearer (Annex 14, 5.2.4.6). Returns stripes per side and the stripe width.
 */
export function stripeLayout(width: number): { perSide: number; unit: number } {
  const perSide = thresholdStripes(width) / 2;
  const reach = Math.min(width / 2 - 3, 27);
  // Per side: half the central gap, then perSide stripes with perSide - 1 gaps between them.
  return { perSide, unit: reach / (2 * perSide) };
}

/**
 * Aiming point by landing distance available (Annex 14, table 5-1): where it starts from the
 * threshold, how long and wide each of the two bars is, and the lateral spacing between their
 * inner sides. Undefined on runways too short to carry one.
 */
export function aimingPoint(
  lda: number,
): { start: number; length: number; width: number; inner: number } | undefined {
  if (lda < 800) return undefined;
  if (lda < 1200) return { start: 250, length: 30, width: 1.8, inner: 9 };
  if (lda < 2400) return { start: 300, length: 45, width: 4, inner: 18 };
  return { start: 400, length: 45, width: 6, inner: 18 };
}

/** Pairs of touchdown zone markings by landing distance available (Annex 14, 5.2.6.3). */
export function touchdownPairs(lda: number): number {
  if (lda < 900) return 1;
  if (lda < 1200) return 2;
  if (lda < 1500) return 3;
  if (lda < 2400) return 4;
  return 6;
}

/** One touchdown zone marking: `count` stripes each side, starting `at` metres past the threshold. */
export interface TouchdownBar {
  at: number;
  count: number;
}

export const TDZ_SPACING = 150;
export const TDZ_LENGTH = 22.5;
export const TDZ_STRIPE = 1.8;
export const TDZ_GAP = 1.5;
/** Stripes per side of the basic pattern ("A"), at 150, 300, 450 ... m from the threshold. */
const TDZ_PATTERN = [3, 3, 2, 2, 1, 1];

/**
 * The touchdown zone markings of one end. The aiming point counts as one pair and takes the
 * place of the bar it would overlap; nothing is painted beyond the middle of the runway.
 */
export function touchdownBars(lda: number, aim: ReturnType<typeof aimingPoint>): TouchdownBar[] {
  const pairs = touchdownPairs(lda) - (aim ? 1 : 0);
  const bars: TouchdownBar[] = [];
  for (let k = 0; k < TDZ_PATTERN.length && bars.length < pairs; k++) {
    const at = (k + 1) * TDZ_SPACING;
    if (at + TDZ_LENGTH > lda / 2) break;
    if (aim && at < aim.start + aim.length + 10 && at + TDZ_LENGTH > aim.start - 10) continue;
    bars.push({ at, count: TDZ_PATTERN[k]! });
  }
  return bars;
}

/** Threshold stripes start 6 m past the threshold and are 30 m long (Annex 14, 5.2.4.7). */
export const STRIPES_START = 6;
export const STRIPES_LENGTH = 30;
/** The designator starts 12 m beyond the stripes and is 9 m high (Annex 14, 5.2.2.5). */
export const DESIGNATOR_START = STRIPES_START + STRIPES_LENGTH + 12;
export const GLYPH_HEIGHT = 9;
export const GLYPH_WIDTH = 3;
/** Space between the two digits, and between the letter and the number. */
export const GLYPH_GAP = 1.5;
export const LETTER_GAP = 6;
/** Centre line: 30 m stripes with 20 m gaps (Annex 14, 5.2.3.5). */
export const CENTRE_STRIPE = 30;
export const CENTRE_PERIOD = 50;
/** Displaced threshold: the transverse bar is 1.8 m wide. */
export const THRESHOLD_BAR = 1.8;

/** Glyph atlas index of a designator character: digits 0..9, then L, R, C; -1 for none. */
export function glyphIndex(ch: string | undefined): number {
  if (ch === undefined || ch === '') return -1;
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  return { L: 10, R: 11, C: 12 }[ch] ?? -1;
}

/** Everything painted from one end. */
export interface EndMarkings {
  /** Landing threshold, metres from this end's pavement end. */
  threshold: number;
  stripesPerSide: number;
  stripeUnit: number;
  aim: ReturnType<typeof aimingPoint>;
  tdz: TouchdownBar[];
  /** Atlas glyphs: tens, ones, letter (-1 for none). */
  glyphs: [number, number, number];
}

/** Paint of a whole runway. */
export interface RunwayMarkings {
  length: number;
  width: number;
  /** Centre line stripe width and side stripe width (Annex 14, 5.2.3.7 and 5.2.7.4). */
  centreWidth: number;
  edgeWidth: number;
  ends: [EndMarkings, EndMarkings];
}

/** Paint of a paved runway, or undefined for grass and other unpaved strips (no paint). */
export function runwayMarkings(r: RunwayInfo, length = r.length): RunwayMarkings | undefined {
  if (!isPaved(r.surface)) return undefined;
  const precision = r.ends.some((e) => e.approach === 'ils');
  const instrument = r.ends.some((e) => e.approach !== undefined);
  const w = r.width;
  const centreWidth = precision && w >= 45 ? 0.9 : instrument || w >= 30 ? 0.45 : 0.3;
  const edgeWidth = w >= 30 ? 0.9 : 0.45;
  const { perSide, unit } = stripeLayout(w);
  const end = (e: RunwayEndInfo): EndMarkings => {
    const threshold = e.displaced ?? 0;
    const lda = length - threshold;
    const aim = aimingPoint(lda);
    // Touchdown zone markings: precision runways, and long instrument runways.
    const tdz = e.approach === 'ils' || (e.approach && lda >= 1500) ? touchdownBars(lda, aim) : [];
    const digits = e.ident.slice(0, 2);
    const letter = e.ident.slice(2);
    return {
      threshold,
      stripesPerSide: perSide,
      stripeUnit: unit,
      aim,
      tdz,
      glyphs: [
        glyphIndex(digits[0]),
        glyphIndex(digits[1]),
        glyphIndex(letter === 'G' ? '' : letter),
      ],
    };
  };
  return {
    length,
    width: w,
    centreWidth,
    edgeWidth,
    ends: [end(r.ends[0]), end(r.ends[1])],
  };
}

/** Checks that the two ends are named as each other's opposite (32 <-> 14, 14L <-> 32R). */
export function endsMatch(r: RunwayInfo): boolean {
  return oppositeIdent(r.ends[0].ident) === r.ends[1].ident;
}

// ---------------------------------------------------------------------------------- lights

/** How a light shows itself to the viewer (the shader's light kinds). */
export const LightKind = {
  /** The same colour all around (taxiway edge lights). */
  Omni: 0,
  /** Colour A seen from ahead of its axis, colour B from behind; wide beams (edge lights). */
  Bidirectional: 1,
  /** Like Bidirectional with narrow beams aimed along the axis (approach, touchdown zone). */
  Unidirectional: 2,
  /** PAPI unit: white above its setting angle, red below; seen from the approach. */
  Papi: 3,
  /** Sequenced flasher of an approach light system ("rabbit"): `param` is its place 0..1. */
  Flasher: 4,
  /** Rotating aerodrome beacon: white and green beams. */
  Beacon: 5,
} as const;
export type LightKind = (typeof LightKind)[keyof typeof LightKind];

/** Linear RGB colours of aeronautical ground lights (Annex 14, appendix 1, as plain colours). */
export const LIGHT_COLOURS = {
  white: [1, 0.93, 0.8],
  yellow: [1, 0.72, 0.18],
  red: [1, 0.06, 0.02],
  green: [0.1, 1, 0.45],
  blue: [0.08, 0.2, 1],
  none: [0, 0, 0],
} as const;
export type LightColour = keyof typeof LIGHT_COLOURS;

/** One light in runway coordinates (or airport-local metres for taxiway and beacon lights). */
export interface Light {
  s: number;
  t: number;
  /** Metres above the ground. */
  height: number;
  /** Seen by a viewer on the side the axis points to ('none': dark from there). */
  colourA: LightColour;
  /** Seen by a viewer on the other side. */
  colourB: LightColour;
  /** Peak intensity, candela. */
  intensity: number;
  kind: LightKind;
  /** Axis along the runway: +1 points from A towards B, -1 from B towards A. */
  axis: 1 | -1;
  /** PAPI setting angle (degrees) or flasher place in its sequence (0..1). */
  param: number;
}

/** Settings of the four PAPI units for a 3 degree approach, from the runway outwards. */
export const PAPI_ANGLES = [3.5, 10 / 3 - 1 / 6, 17 / 6, 2.5];
/** Colour a PAPI unit shows to an eye `elevation` degrees above its horizontal. */
export function papiColour(setting: number, elevation: number): 'red' | 'white' {
  return elevation < setting ? 'red' : 'white';
}
/** Units seen red from `elevation` degrees: 2 on the glide path, 4 too low, 0 too high. */
export function papiReds(elevation: number): number {
  return PAPI_ANGLES.filter((a) => papiColour(a, elevation) === 'red').length;
}

/** What the light layout depends on besides the runway. */
export interface LightOptions {
  /** Centre line light spacing (15 m on CAT II/III runways). */
  centreSpacing: number;
  /** Touchdown zone lights. */
  touchdownZone: boolean;
}

export const EDGE_SPACING = 60;
/** Edge lights stand this far outside the runway edge. */
export const EDGE_OFFSET = 1;
/** The last stretch of an instrument runway whose edge lights show yellow (Annex 14, 5.3.9.7). */
export const CAUTION_ZONE = 600;
export const PAPI_EDGE_DISTANCE = 15;
export const PAPI_UNIT_SPACING = 9;

/** PAPI distance from the threshold: about 15 m eye height over the threshold on 3 degrees. */
export function papiDistance(lda: number): number {
  return lda >= 1800 ? 300 : lda >= 1200 ? 250 : 180;
}

/**
 * All lights of a runway: edges, threshold and end, centre line, touchdown zone, approach
 * lighting, PAPI. Unlit runways get none.
 */
export function runwayLights(r: RunwayInfo, options: LightOptions, length = r.length): Light[] {
  if (!r.lighted) return [];
  const L = length;
  const W = r.width;
  const out: Light[] = [];
  const instrument = r.ends.map((e) => e.approach !== undefined);
  const thr = r.ends.map((e) => e.displaced ?? 0);
  const push = (l: Partial<Light> & Pick<Light, 's' | 't' | 'colourA' | 'colourB'>) =>
    out.push({
      height: 0.35,
      intensity: 10000,
      kind: LightKind.Bidirectional,
      axis: 1,
      param: 0,
      ...l,
    });

  // Edge lights, both sides, the whole length; yellow towards the far end of instrument runways
  // (seen by an aircraft landing in that direction), white otherwise.
  const n = Math.max(2, Math.round(L / EDGE_SPACING));
  const intensity = instrument.some(Boolean) ? 10000 : 1500;
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * L;
    // Landing towards B looks at the light from the A side: colour B of an A->B axis.
    const fromA = instrument[0] && L - s < Math.min(CAUTION_ZONE, L / 3) ? 'yellow' : 'white';
    const fromB = instrument[1] && s < Math.min(CAUTION_ZONE, L / 3) ? 'yellow' : 'white';
    for (const side of [-1, 1])
      push({ s, t: side * (W / 2 + EDGE_OFFSET), colourA: fromB, colourB: fromA, intensity });
  }

  for (let e = 0; e < 2; e++) {
    const end = r.ends[e]!;
    const dir = e === 0 ? 1 : -1; // landing direction in s
    const sOf = (a: number) => (e === 0 ? a : L - a);
    const lda = L - thr[e]!;
    // Threshold lights (green towards the approach) and runway end lights (red towards the
    // runway) across the pavement end; one bidirectional fixture where they coincide.
    const precision = end.approach === 'ils';
    const count = precision
      ? Math.max(6, Math.floor(W / 3) + 1)
      : Math.max(6, Math.floor(W / 6) + 1);
    for (let k = 0; k < count; k++) {
      const t = -W / 2 + (k / (count - 1)) * W;
      // Axis points down the landing direction: colour B is what the approach sees.
      const axis = dir as 1 | -1;
      if (thr[e]! < 1)
        push({ s: sOf(0), t, colourA: 'red', colourB: 'green', axis, intensity: 10000 });
      else {
        push({
          s: sOf(thr[e]!),
          t,
          colourA: 'none',
          colourB: 'green',
          axis,
          kind: LightKind.Unidirectional,
          intensity: 10000,
        });
        push({ s: sOf(0), t, colourA: 'red', colourB: 'none', axis, intensity: 2500 });
      }
    }
    if (end.papi) {
      const at = thr[e]! + papiDistance(lda);
      const side = end.papi === 'left' ? -1 : 1;
      PAPI_ANGLES.forEach((angle, k) => {
        const x = side * (W / 2 + PAPI_EDGE_DISTANCE + k * PAPI_UNIT_SPACING);
        // x is to the right of the landing direction; t is to the right of A->B.
        push({
          s: sOf(at),
          t: e === 0 ? x : -x,
          height: 0.8,
          colourA: 'white',
          colourB: 'none',
          axis: dir === 1 ? -1 : 1,
          kind: LightKind.Papi,
          param: angle,
          intensity: 15000,
        });
      });
    }
    if (end.als)
      approachLights(end.als, (a, x, l) =>
        push({ ...l, s: sOf(thr[e]! + a), t: e === 0 ? x : -x, axis: dir === 1 ? -1 : 1 }),
      );
    if (options.touchdownZone && precision && r.centerLights) {
      for (let a = 60; a <= Math.min(900, lda / 2); a += 60)
        for (const side of [-1, 1])
          for (const off of [9, 10.5, 12])
            push({
              s: sOf(thr[e]! + a),
              t: side * off,
              colourA: 'white',
              colourB: 'none',
              axis: dir === 1 ? -1 : 1,
              kind: LightKind.Unidirectional,
              intensity: 5000,
              height: 0.05,
            });
    }
  }

  // Centre line: white, then alternating red and white from 900 m before the end, red in the
  // last 300 m (Annex 14, 5.3.12.7), seen by each landing direction.
  if (r.centerLights) {
    const colourTowards = (remaining: number, k: number): LightColour =>
      remaining < 300 ? 'red' : remaining < 900 ? (k % 2 === 0 ? 'red' : 'white') : 'white';
    const sp = options.centreSpacing;
    const m = Math.floor((L - 2 * thr[0]! - 2 * thr[1]!) / sp);
    for (let k = 0; k <= m; k++) {
      const s = thr[0]! + (k / Math.max(1, m)) * (L - thr[0]! - thr[1]!);
      push({
        s,
        t: 0,
        height: 0.05,
        intensity: 5000,
        colourA: colourTowards(s, k),
        colourB: colourTowards(L - s, k),
      });
    }
  }
  return out;
}

/**
 * Approach lights in front of a threshold: `place(a, x, light)` with `a` metres before the
 * threshold (negative) and `x` metres right of the extended centre line.
 */
export function approachLights(
  kind: 'precision' | 'simple',
  place: (a: number, x: number, light: Omit<Light, 's' | 't' | 'axis'>) => void,
) {
  const base = {
    height: 1,
    colourA: 'white',
    colourB: 'none',
    kind: LightKind.Unidirectional,
    intensity: 20000,
    param: 0,
  } as const;
  const reach = kind === 'precision' ? 900 : 420;
  const step = kind === 'precision' ? 30 : 60;
  const barrette = kind === 'precision' ? [-2.1, -1.05, 0, 1.05, 2.1] : [-1.05, 0, 1.05];
  for (let d = step; d <= reach; d += step) for (const x of barrette) place(-d, x, base);
  // Crossbar 300 m out, 30 m wide in all.
  for (let x = 3; x <= 15; x += 1.5) for (const side of [-1, 1]) place(-300, side * x, base);
  if (kind === 'precision') {
    // Sequenced flashers from the outer end to 300 m: the rabbit runs towards the runway.
    const flashers: number[] = [];
    for (let d = reach; d > 300; d -= step) flashers.push(d);
    flashers.forEach((d, k) =>
      place(-d, 0, {
        ...base,
        height: 1.6,
        kind: LightKind.Flasher,
        intensity: 60000,
        param: k / flashers.length,
      }),
    );
  }
}
