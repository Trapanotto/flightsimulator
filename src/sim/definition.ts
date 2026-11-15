/**
 * What a type is made of: lifting surfaces cut into strips, fuselage, engines, gear and
 * contact points, all in body coordinates (x forward, y right, z down) relative to the
 * centre of gravity, plus its systems, cockpit and avionics. The flight model is generic; a
 * type is this data and, where it needs one, a small module of its own (a control law, an
 * autopilot).
 */
import type { AirfoilData } from './airfoil';
import type { AvionicsConfig } from './avionics/config';
import type { ControlSpec } from './cockpit';
import type { ControlLaw } from './controlLaw';
import type { EngineDef } from './propulsion';
import type { SystemsData } from './systems/data';
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

/**
 * What moves on a strip. `flap`, `aileron`, `elevator` and `rudder` change its camber
 * (zero-lift angle); an all-moving tail is an `elevator` with effectiveness 1. `slat` (also a
 * fighter's leading-edge flap) delays the separation; `spoiler` dumps lift and adds drag.
 */
export type ControlKind = 'flap' | 'aileron' | 'elevator' | 'rudder' | 'slat' | 'spoiler';

export interface StripControl {
  kind: ControlKind;
  /** Change of zero-lift angle per angle of deflection (slat: separation delay per angle). */
  effectiveness: number;
  /** Ailerons, roll spoilers, a differential tail: +1 right wing, -1 left wing. */
  side?: number;
  /** Flap: chord extension of a Fowler flap at full travel, share of chord (adds area). */
  extension?: number;
  /** Spoiler: it also rolls (rises on the side the aileron command rolls down). Elevator: share of differential travel. */
  roll?: number;
}

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
  control?: StripControl;
  /** The strip sits behind the wing and feels its downwash. */
  downwash?: boolean;
  /** How far the slipstream has developed where the strip sits (0 at the disk .. 1). */
  slipstreamDevelopment: number;
  /** Strip of a high wing next to the fuselage: crossflow around the cabin changes its angle. */
  wingRoot?: boolean;
  /**
   * Quarter-chord sweep, rad (Phase 4). Simple-sweep theory: the section works on the flow
   * normal to its span, so the lift slope falls with cos Λ and the Mach effects come later.
   */
  sweep?: number;
  /** Leading-edge vortex lift (a fighter's strake), Polhamus' constant Kv. */
  vortexLift?: number;
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
  /**
   * A skid surface (the belly, the keel) that slides on a runway: wheels-up on a paved or
   * grass surface it scrapes along instead of wrecking at once; on water or rough terrain it
   * still does above a walking pace.
   */
  skid?: boolean;
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

/** A retractable gear (Phase 4). Without one the gear is fixed and always down. */
export interface GearDef {
  /** Seconds from up to down and from down to up. */
  extendTime: number;
  retractTime: number;
  /** What moves it: 'electric' (a motor on the main bus) or the id of a hydraulic system. */
  power: string;
  /** Drag area of the extended gear (m²) and where it acts. */
  dragArea: number;
  dragPoint: Vec3;
  /** Limit airspeeds (IAS, m/s) for operating it and flying with it extended. */
  vlo: number;
  vle: number;
}

/** Stick shaker and pusher (Phase 4): vane angles of attack (rad) per flap detent. */
export interface StallProtection {
  shaker: number[];
  pusher: number[];
  /** Elevator share of nose-down travel the pusher drives to. */
  push: number;
  /** It lets go once the vane angle is this much below the pusher angle, rad. */
  /** Seconds after lift-off before it is armed (it is always off on the ground). */
  inhibit: number;
  release: number;
}

/** Placard limits for the exceedance record (Phase 4); speeds IAS, m/s. */
export interface Limits {
  vmo: number;
  mmo?: number;
  /** Maximum flap-extended speed for each flap detent (the first is ignored). */
  vfe: number[];
  /** Torque, ITT (K), gas generator, propeller and fan limits, where the type has them. */
  torque?: number;
  itt?: number;
  ng?: number;
  propRpm?: number;
  egt?: number;
  n1?: number;
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
    /** Transonic drag rise of the body (Phase 4): drag area grows by `rise` from Mach `critical` to 1.05. */
    machDrag?: { critical: number; rise: number };
  };
  /** Every engine, in the order of ControlInput's per-engine arrays and the telemetry. */
  engines: EngineDef[];
  controls: {
    /** Maximum deflections, rad: elevator up / down, aileron up / down, rudder. */
    elevatorUp: number;
    elevatorDown: number;
    aileronUp: number;
    aileronDown: number;
    rudder: number;
    /**
     * Full nose-up / nose-down trim, rad: an equivalent elevator deflection for a tab, or the
     * stabiliser's own incidence change when `trim` is 'stabiliser'.
     */
    trimUp: number;
    trimDown: number;
    /** How pitch trim works: a tab on the elevator (default) or a movable stabiliser. */
    trim?: 'tab' | 'stabiliser';
    /** Aileron and rudder trim at full deflection of `rollTrim` / `yawTrim`, share of travel. */
    rollTrim?: number;
    yawTrim?: number;
    /** Flap detents, rad, and travel speed, rad/s. */
    flapDetents: number[];
    flapRate: number;
    /** Slat angle at each flap detent, rad, if the type has slats. */
    slatDetents?: number[];
    /** Surface rate limit, 1/s of full travel. */
    surfaceRate: number;
    /** Dynamic pressure above which the pilot cannot hold full deflection, Pa (Infinity: powered controls). */
    holdLimitPressure: number;
    /** Fixed rigging tabs: aileron and rudder offsets that keep cruise hands-off, -1..1. */
    aileronRigging: number;
    rudderRigging: number;
    /** Separation shift by a control surface, as a fraction of its lift angle. */
    stallShift: number;
    /** Extra profile drag of a fully deflected flap on its strips. */
    flapDrag: number;
    /** Extra profile drag of a fully raised spoiler on its strips (default 0.1). */
    spoilerDrag?: number;
    /** Spoiler and speed brake travel speed, 1/s of full travel (default 1). */
    spoilerRate?: number;
  };
  /** Retractable gear; without it the gear is fixed. */
  gear?: GearDef;
  /** A speed brake on the fuselage: drag area at full travel and where it acts. */
  speedbrake?: { dragArea: number; position: Vec3 };
  stallProtection?: StallProtection;
  /** Yaw damper servo: rudder share per rad/s of washed-out yaw rate, and the washout, s. */
  yawDamper?: { gain: number; washout: number };
  /** The step between the pilot's input and the surfaces; default the direct (mechanical) law. */
  controlLaw?: (def: AircraftDefinition) => ControlLaw;
  limits?: Limits;
  wheels: WheelDef[];
  contacts: ContactPoint[];
  /** Load factors beyond which the airframe fails. */
  ultimateLoad: { positive: number; negative: number };
  /** Airspeed calibration: KCAS to KIAS rows for each flap detent (index of flapDetents). */
  airspeedCalibration: (readonly (readonly [number, number])[])[];
  /** Electrical, fuel, engine management, vacuum, hydraulics, pressurisation and icing. */
  systems: SystemsData;
  /** Every control of the cockpit (default: the Cessna's). */
  cockpit?: readonly ControlSpec[];
  /** Which radios and autopilot the avionics unit has (default: the Cessna's stack). */
  avionics?: AvionicsConfig;
}
