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
  /**
   * Compressibility, for sections that fly fast enough to need it (Phase 4). Without it the
   * section is incompressible: the slow types' data are calibrated against flight tests that
   * already contain the little Mach effect they have.
   */
  mach?: MachData;
}

/** How a section behaves at speed. */
export interface MachData {
  /** Drag-divergence Mach number of the section (normal to the sweep), at its design lift. */
  divergence: number;
  /** Thickness ratio (sets the supersonic wave drag and the transonic drag peak). */
  thickness: number;
}

/** What compressibility does to a section at one Mach number (normal to the sweep). */
export interface MachEffects {
  /** Factor on the lift slope (Prandtl-Glauert below, Ackeret above the speed of sound). */
  lift: number;
  /** Extra drag: Lock's fourth-power drag rise, then the supersonic wave drag. */
  drag: number;
  /** Rearward shift of the centre of pressure, as a share of chord (0 at low speed, 0.25 supersonic). */
  cpShift: number;
  /** Factor on what a trailing-edge control surface does (shock-induced separation behind it). */
  control: number;
}

/**
 * Compressibility of a section at Mach `m`. Subsonic: Prandtl-Glauert, 1/√(1-M²). Supersonic
 * thin-airfoil theory (Ackeret): lift slope 4/√(M²-1) and wave drag 4(t/c)²/√(M²-1). Between
 * them a blend through the transonic range. The drag rise below M = 1 follows Lock's empirical
 * law, Δcd = 20 (M - Mcr)⁴ with Mcr = Mdd - (0.1/80)^(1/3) (as used in W. H. Mason,
 * Configuration Aerodynamics, ch. 7), capped at the transonic peak.
 */
export function machEffects(
  data: MachData,
  liftSlope: number,
  m: number,
  out: MachEffects,
): MachEffects {
  const critical = data.divergence - 0.108;
  const sub = 1 / Math.sqrt(1 - Math.min(m, 0.85) ** 2);
  const sup = 4 / liftSlope / Math.sqrt(Math.max(m, 1.15) ** 2 - 1);
  if (m <= 0.85) out.lift = sub;
  else if (m >= 1.15) out.lift = sup;
  else out.lift = sub + (sup - sub) * smoothstep(0.85, 1.15, m);
  const t2 = data.thickness * data.thickness;
  const peak = (4 * t2) / Math.sqrt(1.1 * 1.1 - 1);
  const x = Math.max(0, m - critical);
  out.drag = m <= 1.1 ? Math.min(peak, 20 * x * x * x * x) : (4 * t2) / Math.sqrt(m * m - 1);
  // Above the critical Mach the shock walks aft and takes the lift with it.
  out.cpShift = 0.25 * smoothstep(critical, 1.1, m);
  out.control = 1 - 0.5 * smoothstep(critical, data.divergence + 0.1, m);
  return out;
}

/** Leading-edge vortex lift (Polhamus' suction analogy): extra lift coefficient at angle a. */
export function vortexLift(kv: number, a: number): number {
  const s = Math.sin(a);
  // The vortex bursts over the wing at high angles and its lift goes with it.
  const burst = 1 - smoothstep(28 * DEG, 45 * DEG, Math.abs(a));
  return kv * s * Math.abs(s) * Math.cos(a) * burst;
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
    // The margin grows with the depth of the stall: light trailing-edge separation comes and
    // goes with the angle, a fully broken-down flow needs the angle well back to reattach.
    const margin = foil.reattachMargin * (1 - f) * (1 - f);
    goal = staticSeparation(foil, a + (a >= 0 ? margin : -margin));
    lag *= 2;
    if (goal <= f) return f;
  }
  const tau = (lag * chord) / Math.max(speed, 3);
  return f + (goal - f) * (1 - Math.exp(-dt / tau));
}
