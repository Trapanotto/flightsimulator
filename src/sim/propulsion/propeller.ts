/**
 * Propellers. A fixed-pitch propeller is two coefficient tables over advance ratio (the
 * Cessna's McCauley); a variable-pitch one is a blade element at three-quarter radius over the
 * full circle of angle of attack with momentum-theory inflow, so one model covers the take-off
 * roll, the cruise, beta and reverse on the ground, windmilling and the feathered blade.
 */
import {
  sectionCoefficients,
  staticSeparation,
  type AirfoilData,
  type SectionCoefficients,
} from '../airfoil';
import { lookup } from '../math';

export interface FixedPitchPropellerData {
  kind?: 'fixed';
  diameter: number;
  /** Thrust and power coefficients over advance ratio J = V / (n D). */
  ct: readonly (readonly [number, number])[];
  cp: readonly (readonly [number, number])[];
}

export interface VariablePitchPropellerData {
  kind: 'variable';
  diameter: number;
  blades: number;
  /** Mean chord of a blade, m. */
  chord: number;
  /** Share of the radius taken by the hub and spinner, where the blade does no work. */
  hubRatio: number;
  /** Blade section at three-quarter radius, over the full circle (it runs reversed and feathered). */
  foil: AirfoilData;
  /** Share of the three-quarter-radius loading the real blade delivers (tip and root losses). */
  efficiency: number;
  /**
   * Induced velocity over the ideal momentum value (tip losses, the uneven loading over the
   * disk, swirl): what brings the static figure of merit down to a real propeller's.
   */
  inducedFactor: number;
  /** Helical Mach number at three-quarter radius where the section's drag starts to rise. */
  criticalMach: number;
  /** Blade angles at three-quarter radius, rad: full reverse, ground fine (beta), flight fine stop, feather. */
  reverse: number;
  ground: number;
  fine: number;
  feather: number;
  /** Fastest pitch change, rad/s. */
  pitchRate: number;
}

export type PropellerData = FixedPitchPropellerData | VariablePitchPropellerData;

/** Thrust (N) and torque absorbed (N m). */
export interface PropellerOutput {
  thrust: number;
  torque: number;
}

const J_TABLE_END = 3;

/**
 * Thrust and torque of a fixed-pitch disk turning at n rev/s with axial inflow v (m/s). For
 * large advance ratios (stopped or barely turning propeller) the coefficients are carried on
 * as ~J², which is the same as a drag and a windmilling torque proportional to v².
 */
export function propellerForces(
  prop: FixedPitchPropellerData,
  n: number,
  v: number,
  density: number,
  out: PropellerOutput,
): PropellerOutput {
  const D = prop.diameter;
  const vAxial = Math.max(v, 0);
  if (n * J_TABLE_END * D > vAxial && n > 1e-3) {
    const J = vAxial / (n * D);
    out.thrust = lookup(prop.ct, J) * density * n * n * D ** 4;
    out.torque = (lookup(prop.cp, J) * density * n * n * D ** 5) / (2 * Math.PI);
  } else {
    // n D = v / J_TABLE_END scaled form: coefficient(J) * n² = coefficient(J_end) * (v / (J_end D))²
    const ctEnd = lookup(prop.ct, J_TABLE_END);
    const cpEnd = lookup(prop.cp, J_TABLE_END);
    const nEq = vAxial / (J_TABLE_END * D);
    out.thrust = ctEnd * density * nEq * nEq * D ** 4;
    out.torque = (cpEnd * density * nEq * nEq * D ** 5) / (2 * Math.PI);
  }
  return out;
}

const coeff: SectionCoefficients = { cl: 0, cd: 0, cm: 0 };

/**
 * Thrust and torque of a variable-pitch disk (or a share of it: `share` of the disk area,
 * e.g. a quarter for one quadrant) at n rev/s, axial inflow v, blade angle beta (rad).
 * `inflow` carries the induced velocity between calls, so the momentum balance converges over
 * the steps instead of being iterated to the end every time.
 */
export function bladeForces(
  prop: VariablePitchPropellerData,
  n: number,
  v: number,
  density: number,
  beta: number,
  soundSpeed: number,
  share: number,
  inflow: { vi: number },
  out: PropellerOutput,
): PropellerOutput {
  const R = prop.diameter / 2;
  const r = 0.75 * R;
  const span = R * (1 - prop.hubRatio);
  const U = 2 * Math.PI * Math.max(n, 0) * r;
  const area = Math.PI * R * R * share;
  const k = 0.5 * density * prop.blades * prop.chord * span * prop.efficiency * share;
  let vi = inflow.vi;
  let thrust = 0;
  let torque = 0;
  for (let it = 0; it < 3; it++) {
    const va = v + vi;
    const w2 = va * va + U * U;
    const phi = Math.atan2(va, U);
    const alpha = beta - phi;
    sectionCoefficients(prop.foil, alpha, 0, staticSeparation(prop.foil, alpha), coeff);
    // The tips run near the speed of sound: the section's drag rises beyond its critical Mach.
    const m = Math.sqrt(w2) / soundSpeed - prop.criticalMach;
    const cd = coeff.cd + (m > 0 ? 8 * m * m : 0);
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const q = k * w2;
    thrust = q * (coeff.cl * cp - cd * sp);
    torque = q * r * (coeff.cl * sp + cd * cp);
    // Momentum theory: T = 2 rho A vi (v + vi), also for the flow a reversing blade pushes
    // forward (then vi is negative and the slipstream points ahead).
    const t2 = Math.abs(thrust) / (2 * density * area);
    const root = Math.sqrt((v * v) / 4 + t2);
    const target = (thrust >= 0 ? root - v / 2 : v / 2 - root) * prop.inducedFactor;
    vi += 0.6 * (target - vi);
  }
  inflow.vi = vi;
  out.thrust = thrust;
  out.torque = torque;
  return out;
}
