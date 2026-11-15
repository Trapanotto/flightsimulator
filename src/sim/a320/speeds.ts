/**
 * What the A320's computers know about the aircraft: its configurations, the maximum lift
 * of each, the protection angles of attack and the characteristic speeds that follow from
 * the mass. The flight control computers and the flight guidance both use these, as the
 * real ones share their aerodynamic data.
 *
 * The maximum lift coefficients are those of this simulation's airframe (measured by the
 * calibration in tests/sim/a320.performance.test.ts, which keeps them in step); the speed
 * rules are the FCOM's (DSC-22_20, reconstructed from memory where marked).
 */
import { DEG, KT, clamp } from '../math';

export type A320Config = '0' | '1' | '1+F' | '2' | '3' | 'FULL';
export const CONFIGS: readonly A320Config[] = ['0', '1', '1+F', '2', '3', 'FULL'];

/** Slats and flaps of each configuration, degrees (FCOM, from memory). */
export const SLATS_FLAPS: Record<A320Config, readonly [number, number]> = {
  '0': [0, 0],
  '1': [18, 0],
  '1+F': [18, 10],
  '2': [22, 15],
  '3': [22, 20],
  FULL: [27, 35],
};

/** VFE of each configuration, knots (FCOM limitations). */
export const VFE: Record<A320Config, number> = {
  '0': 350,
  '1': 230,
  '1+F': 215,
  '2': 200,
  '3': 185,
  FULL: 177,
};
export const VMO = 350;
export const MMO = 0.82;
export const VLE = 280;

/** Maximum lift coefficient (on 122.6 m²) at low Mach of each configuration, gear up. */
export const CL_MAX: Record<A320Config, number> = {
  '0': 1.235,
  '1': 1.55,
  '1+F': 1.85,
  '2': 2.02,
  '3': 2.2,
  FULL: 2.71,
};

/**
 * Angles of attack (body, rad) of the protections: alpha prot near 87 % of the maximum
 * lift, alpha floor a little above, alpha max at 95 %, all clear of the stall.
 */
export const ALPHA_PROT: Record<A320Config, number> = {
  '0': 10.4 * DEG,
  '1': 11 * DEG,
  '1+F': 11.4 * DEG,
  '2': 10.4 * DEG,
  '3': 9.8 * DEG,
  FULL: 8.2 * DEG,
};
export const ALPHA_FLOOR: Record<A320Config, number> = {
  '0': 11.0 * DEG,
  '1': 12 * DEG,
  '1+F': 12.4 * DEG,
  '2': 11.4 * DEG,
  '3': 10.8 * DEG,
  FULL: 9.4 * DEG,
};
export const ALPHA_MAX: Record<A320Config, number> = {
  '0': 12.0 * DEG,
  '1': 13.5 * DEG,
  '1+F': 14.5 * DEG,
  '2': 12.9 * DEG,
  '3': 12.1 * DEG,
  FULL: 10.7 * DEG,
};
/** Share of the maximum lift at alpha prot and alpha max (what the speeds below use). */
const CL_PROT = 0.87;
const CL_AMAX = 0.95;

export const WING_AREA = 122.6;
const G = 9.80665;
const RHO0 = 1.225;

/** Load factor limits of the normal law: +2.5 / -1 g clean, +2 / 0 g with slats or flaps. */
export function loadFactorLimits(config: A320Config): [number, number] {
  return config === '0' ? [-1, 2.5] : [0, 2];
}

/** Sidestick (or autopilot) pitch input -1..1 to the load factor increment the law flies. */
export function stickToDeltaN(stick: number, config: A320Config): number {
  const [lo, hi] = loadFactorLimits(config);
  return stick >= 0 ? stick * (hi - 1) : -stick * (lo - 1);
}

/** And back: the stick that asks for a load factor increment. */
export function deltaNToStick(dn: number, config: A320Config): number {
  const [lo, hi] = loadFactorLimits(config);
  return clamp(dn >= 0 ? dn / (hi - 1) : dn / (1 - lo), -1, 1);
}

/** 1 g stall speed, knots CAS, at a mass (kg). */
export function vs1g(mass: number, config: A320Config): number {
  return Math.sqrt((2 * mass * G) / (RHO0 * WING_AREA * CL_MAX[config])) / KT;
}

export interface CharacteristicSpeeds {
  vls: number;
  vsw: number;
  alphaProt: number;
  alphaMax: number;
  f: number;
  s: number;
  greenDot: number;
  vapp: number;
  v1: number;
  vr: number;
  v2: number;
  vmax: number;
  vfeNext: number;
}

/**
 * The speed tape's speeds for a mass, configuration and altitude (FCOM DSC-22_20):
 * VLS 1.23 VS1g (1.13 in the take-off configurations until the slats retract); F 1.22 VS1g
 * of CONF 2 and S 1.23 VS1g clean (reconstructed); green dot by the rule of thumb 2 kt per
 * tonne plus 85 kt, one more per 1000 ft above FL 200; VAPP = VLS of CONF FULL + 5 kt; V2 at
 * 1.13 VS1g of CONF 1+F, VR 6 kt below, V1 3 kt below VR (a balanced field, reconstructed).
 */
export function characteristicSpeeds(
  mass: number,
  config: A320Config,
  altitudeFt: number,
  takeoff: boolean,
  gearDown: boolean,
  mach: number,
  ias: number,
  out: CharacteristicSpeeds,
): CharacteristicSpeeds {
  const vs = vs1g(mass, config);
  const toConfig = takeoff && config !== '0' && config !== 'FULL';
  out.vls = vs * (toConfig ? 1.13 : 1.23);
  out.vsw = vs * 1.03;
  out.alphaProt = vs / Math.sqrt(CL_PROT);
  out.alphaMax = vs / Math.sqrt(CL_AMAX);
  out.f = 1.22 * vs1g(mass, '2');
  out.s = 1.23 * vs1g(mass, '0');
  out.greenDot = 2 * (mass / 1000) + 85 + Math.max(0, (altitudeFt - 20_000) / 1000);
  out.vapp = 1.23 * vs1g(mass, 'FULL') + 5;
  out.v2 = 1.13 * vs1g(mass, '1+F');
  out.vr = out.v2 - 6;
  out.v1 = out.vr - 3;
  // VMAX: VMO, or the speed at MMO here, VFE, VLE.
  const mmoSpeed = mach > 0.05 ? (ias * MMO) / mach : VMO;
  out.vmax = Math.min(VMO, mmoSpeed, VFE[config], gearDown ? VLE : Infinity);
  const i = CONFIGS.indexOf(config);
  // The lever's next position: 1 goes to CONF 1 in flight.
  out.vfeNext = i < CONFIGS.length - 1 ? VFE[CONFIGS[i === 1 ? 3 : i + 1]!] : NaN;
  return out;
}

export const newSpeeds = (): CharacteristicSpeeds => ({
  vls: 0,
  vsw: 0,
  alphaProt: 0,
  alphaMax: 0,
  f: 0,
  s: 0,
  greenDot: 0,
  vapp: 0,
  v1: 0,
  vr: 0,
  v2: 0,
  vmax: 0,
  vfeNext: 0,
});
