/**
 * Section aerodynamics over the full 360 degrees of angle of attack.
 *
 * Below the stall the section follows Kirchhoff's flow model: lift is the linear lift times a
 * factor of the trailing-edge separation point f (1 attached .. 0 fully separated). Far beyond
 * the stall it becomes a flat plate. f is a state with a lag of a few chord lengths of travel,
 * and the flow has to come further back before it reattaches than where it separated: that is
 * the stall hysteresis, and it is what lets a stalled wing stay stalled while the nose drops.
 */
import { DEG, smoothstep } from './math';

export interface AirfoilData {
  /** Section lift slope, 1/rad. */
  liftSlope: number;
  /** Angle of zero lift, rad. */
  alpha0: number;
  /** Angle (rad) at which half the chord has separated, for positive and negative angles. */
  separationPos: number;
  separationNeg: number;
  /** Sharpness of the separation; higher = more abrupt stall. */
  separationExponent: number;
  /** How much further back (rad) the angle has to come before the flow reattaches. */
  reattachMargin: number;
  /** Separation lag in chord lengths of travel. */
  lagChords: number;
  /** Zero-lift profile drag and its growth with lift. */
  cd0: number;
  cdLift: number;
  /** Pitching moment about the quarter chord with attached flow. */
  cm0: number;
  /** Flat-plate lift and drag amplitude (cl = a sin 2α, cd = b sin²α). */
  plateLift: number;
  plateDrag: number;
}

export interface SectionCoefficients {
  cl: number;
  cd: number;
  cm: number;
}

const BLEND_START = 22 * DEG;
const BLEND_END = 40 * DEG;

/** Wraps an angle into -π..π. */
export function wrapAngle(a: number): number {
  if (a > Math.PI) return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
  if (a < -Math.PI) return a + 2 * Math.PI * Math.floor((Math.PI - a) / (2 * Math.PI));
  return a;
}

/** Separation point the flow settles to at a steady angle of attack. */
export function staticSeparation(foil: AirfoilData, alpha: number): number {
  const a = wrapAngle(alpha);
  if (Math.abs(a) > Math.PI / 2) return 0;
  const ref = a >= 0 ? foil.separationPos : foil.separationNeg;
  const r = Math.abs(a) / ref;
  return 1 / (1 + r ** foil.separationExponent);
}

/**
 * Coefficients at angle `alpha` (rad, relative to the chord, already corrected for the
 * induced angle), with `controlAlpha` the extra lift of a deflected flap or control surface
 * expressed as an angle, and `f` the current separation state.
 */
export function sectionCoefficients(
  foil: AirfoilData,
  alpha: number,
  controlAlpha: number,
  f: number,
  out: SectionCoefficients,
): SectionCoefficients {
  const a = wrapAngle(alpha);
  const absA = Math.abs(a);
  const sin2 = Math.sin(2 * a);
  const sinA = Math.sin(a);
  const plateCl = foil.plateLift * sin2;
  const plateCd = foil.cd0 + foil.plateDrag * sinA * sinA;
  // Beyond the blend (and in reversed flow) the section is a flat plate.
  const w = absA > Math.PI / 2 ? 0 : 1 - smoothstep(BLEND_START, BLEND_END, absA);
  if (w <= 0) {
    out.cl = plateCl;
    out.cd = plateCd;
    // Centre of pressure near mid-chord for a plate: a nose-down moment about c/4.
    out.cm = -0.25 * (plateCl * Math.cos(a) + plateCd * sinA) * (0.4 + 0.6 * Math.abs(sinA));
    return out;
  }
  const sf = Math.sqrt(Math.max(0, Math.min(1, f)));
  const kirchhoff = ((1 + sf) / 2) ** 2;
  const linear = foil.liftSlope * (a - foil.alpha0 + controlAlpha);
  const cl = linear * kirchhoff;
  const separated = 1 - f;
  const cd = foil.cd0 + foil.cdLift * cl * cl + separated * foil.plateDrag * sinA * sinA;
  // As the flow separates the centre of pressure moves aft of the quarter chord.
  const cn = cl * Math.cos(a) + cd * sinA;
  // A deflected flap or control surface cambers the section: nose-down moment about c/4
  // in proportion to its extra lift (thin-airfoil theory gives about a quarter).
  const cm =
    (foil.cm0 - 0.22 * foil.liftSlope * controlAlpha * kirchhoff) * f - separated * 0.12 * cn;
  out.cl = w * cl + (1 - w) * plateCl;
  out.cd = w * cd + (1 - w) * plateCd;
  out.cm =
    w * cm +
    (1 - w) * (-0.25 * (plateCl * Math.cos(a) + plateCd * sinA) * (0.4 + 0.6 * Math.abs(sinA)));
  return out;
}

/**
 * Moves the separation state towards its steady value. Separation follows within a few
 * chords; reattachment needs the angle to drop by `reattachMargin` and takes twice as long.
 */
export function updateSeparation(
  foil: AirfoilData,
  f: number,
  alphaSeparation: number,
  speed: number,
  chord: number,
  dt: number,
): number {
  const target = staticSeparation(foil, alphaSeparation);
  let goal = target;
  let lag = foil.lagChords;
  if (target > f) {
    const a = wrapAngle(alphaSeparation);
    goal = staticSeparation(foil, a + (a >= 0 ? foil.reattachMargin : -foil.reattachMargin));
    lag *= 2;
    if (goal <= f) return f;
  }
  const tau = (lag * chord) / Math.max(speed, 3);
  return f + (goal - f) * (1 - Math.exp(-dt / tau));
}
