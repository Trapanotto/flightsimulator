/**
 * What a type is made of: lifting surfaces cut into strips, fuselage, propulsion, gear and
 * contact points, all in body coordinates (x forward, y right, z down) relative to the
 * centre of gravity. The flight model is generic; a type is only data.
 */
import type { AirfoilData } from './airfoil';
import type { PistonEngineData, PropellerData } from './engine';
import type { AircraftInfo, Vec3 } from './types';

/** A group of strips that shares one induced angle (one wing half, a tailplane, the fin). */
export interface SurfaceGroup {
  name: string;
  /** Aspect ratio and span efficiency of the whole surface the group belongs to. */
  aspectRatio: number;
  oswald: number;
  /** Span used for ground effect, m. */
  span: number;
  /**
   * Groups whose combined lift sets this group's induced angle (default: the group itself).
   * The wing centre section feels the whole wing; each wing half mostly its own lift, which
   * is what makes a rolling or aileron-deflected wing yaw adversely.
   */
  inducedFrom?: number[];
}

export type ControlKind = 'flap' | 'aileron' | 'elevator' | 'rudder';

export interface StripDef {
  name: string;
  group: number;
  /** Quarter-chord point, body frame, m. */
  position: Vec3;
  /** Unit vector along the chord towards the leading edge. */
  chordAxis: Vec3;
  /** Unit vector of positive lift at zero angle of attack. */
  liftAxis: Vec3;
  area: number;
  chord: number;
  foil: AirfoilData;
  /** Lift carried over a fuselage section is less than over a free wing. */
  liftFactor?: number;
  /** Dynamic pressure ratio from the fuselage wake (tail surfaces). */
  qFactor?: number;
  /**
   * Control surface on this strip: kind, effectiveness (change of zero-lift angle per angle
   * of deflection) and, for ailerons, the side (+1 right wing, -1 left wing).
   */
  control?: { kind: ControlKind; effectiveness: number; side?: number };
  /** The strip sits behind the wing and feels its downwash. */
  downwash?: boolean;
  /** How far the slipstream has developed where the strip sits (0 at the disk .. 1). */
  slipstreamDevelopment: number;
  /** Strip of a high wing next to the fuselage: crossflow around the cabin changes its angle. */
  wingRoot?: boolean;
}

export interface ContactPoint {
  name: string;
  position: Vec3;
  /** Impact speed along the ground normal (m/s) that destroys the aircraft. */
  crashSpeed: number;
  /** How deep the point may be pressed into the ground before the aircraft counts as wrecked (default 0.3 m). */
  maxDepth?: number;
  /** Reason code reported when it does. */
  reason: string;
}

export interface WheelDef {
  name: string;
  /** Bottom of the tyre with the strut fully extended, body frame. */
  position: Vec3;
  /** Strut travel, m; beyond it the strut bottoms out. */
  travel: number;
  /** Spring N/m and damper N s/m, tyre included. */
  spring: number;
  damper: number;
  /** Steering angle at full pedal, rad (nose wheel). */
  steering?: number;
  /** Wheel brake fed by the left or right pedal, maximum force N. */
  brake?: 'left' | 'right';
  brakeForce?: number;
  /** Strut force (N) that breaks the gear. */
  breakingForce: number;
}

export interface AircraftDefinition {
  info: AircraftInfo;
  /** Empty mass plus crew and baggage, kg; fuel is added. */
  mass: number;
  fuelCapacity: number;
  /** Principal moments of inertia, kg m^2. */
  inertia: Vec3;
  /** Reference wing area (m^2), span and mean chord (m). */
  wingArea: number;
  wingSpan: number;
  meanChord: number;
  groups: SurfaceGroup[];
  strips: StripDef[];
  /** Index of the wing groups whose lift makes the downwash at the tail. */
  wingGroups: number[];
  /** Downwash at the tail per unit wing lift coefficient relative to 2/(πA). */
  downwashFactor: number;
  /** Tail arm, m (sets the downwash lag). */
  tailArm: number;
  /** Strip whose local angle drives the stall warning, and the angle (rad) it sounds at. */
  stallWarning: { strip: number; alpha: number };
  /** High-wing crossflow around the cabin: strength and fuselage half-width, m. */
  wingRoot: { strength: number; radius: number };
  fuselage: {
    /** Parasite drag area of fuselage, gear, struts and cooling, m^2. */
    dragArea: number;
    dragPoint: Vec3;
    /** Side and plan areas for crossflow drag, split between a front and a rear station. */
    sideArea: number;
    planArea: number;
    crossflowCd: number;
    front: Vec3;
    rear: Vec3;
    frontShare: number;
    /** Munk moments of the body in pitch and yaw, per rad, on wing area and chord / span. */
    pitchMunk: number;
    yawMunk: number;
  };
  propeller: PropellerData & {
    /** Centre of the disk, body frame. */
    position: Vec3;
    /** Swirl recovered by the fuselage and fin is less than the free-stream value. */
    swirlFactor: number;
  };
  engine: PistonEngineData;
  controls: {
    /** Maximum deflections, rad: elevator up / down, aileron up / down, rudder. */
    elevatorUp: number;
    elevatorDown: number;
    aileronUp: number;
    aileronDown: number;
    rudder: number;
    /** Equivalent elevator deflection at full nose-up / nose-down trim, rad. */
    trimUp: number;
    trimDown: number;
    /** Flap detents, rad, and travel speed, rad/s. */
    flapDetents: number[];
    flapRate: number;
    /** Surface rate limit, 1/s of full travel. */
    surfaceRate: number;
    /** Dynamic pressure above which the pilot cannot hold full deflection, Pa. */
    holdLimitPressure: number;
    /** Fixed rigging tabs: aileron and rudder offsets that keep cruise hands-off, -1..1. */
    aileronRigging: number;
    rudderRigging: number;
    /** Separation shift by a control surface, as a fraction of its lift angle. */
    stallShift: number;
    /** Extra profile drag of a fully deflected flap on its strips. */
    flapDrag: number;
  };
  wheels: WheelDef[];
  contacts: ContactPoint[];
  /** Load factors beyond which the airframe fails. */
  ultimateLoad: { positive: number; negative: number };
  /** Airspeed calibration: KCAS to KIAS rows for each flap detent (index of flapDetents). */
  airspeedCalibration: (readonly (readonly [number, number])[])[];
}
