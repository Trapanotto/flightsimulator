/**
 * Leaving the aircraft and getting back in: where the door is on each type, how the pilot
 * gets out (step down on the ground, jump from the door in flight, or the fighter's ejection
 * seat), and the state the Parachutist starts from.
 */
import { rotate } from '../math';
import type { AircraftId, Environment, SimAircraft, Vec3 } from '../types';
import { HIP_HEIGHT, Parachutist } from './parachutist';

/** How the pilot leaves: on foot, by jumping, or by the ejection seat. */
export type ExitKind = 'step' | 'jump' | 'eject';

/**
 * Exits per type, body frame (x forward, y right, z down) from the reference point (centre
 * of gravity), read off the 3D models' eye points and doors: `door` is where a jumper leaves
 * in flight (just outside the left door, or above the canopy for a seat), `ground` the spot
 * beside the door where one stands after climbing down.
 */
export const EXITS: Record<AircraftId, { door: Vec3; ground: { x: number; y: number } }> = {
  // Pilot's door under the left wing, behind the strut.
  c172: { door: { x: 0, y: -1.15, z: 0.1 }, ground: { x: 0.35, y: -1.5 } },
  // The crew door forward on the left.
  pc12: { door: { x: 1.7, y: -1.1, z: 0.1 }, ground: { x: 1.7, y: -1.7 } },
  // The forward left passenger door (L1); on the ground at the foot of the stairs.
  a320: { door: { x: 10.2, y: -2.3, z: -0.4 }, ground: { x: 10.2, y: -3.4 } },
  // Ejection seat: above the canopy; on the ground down the boarding ladder on the left.
  fa18: { door: { x: 4.1, y: 0, z: -1.6 }, ground: { x: 3.6, y: -1.9 } },
};

/** Ejection seat: speed away from the aircraft along its vertical, m/s. */
export const EJECTION_SPEED = 30;
/** Ground speed below which an aircraft counts as stopped (getting out on foot, back in). */
export const STOPPED_SPEED = 1.5;
/** Standing this close to the door spot is close enough to climb back in, m. */
export const ENTER_REACH = 3.5;

/**
 * How the pilot of `aircraft` would leave now, or null if not at all: on the ground only
 * when stopped (the fighter's zero-zero seat fires at any speed), never from a wreck.
 */
export function exitKind(aircraft: SimAircraft): ExitKind | null {
  const t = aircraft.telemetry;
  if (t.crashed) return null;
  const fighter = aircraft.info.category === 'fighter';
  if (t.onGround) {
    if (t.groundSpeed <= STOPPED_SPEED) return 'step';
    return fighter ? 'eject' : null;
  }
  return fighter ? 'eject' : 'jump';
}

const tmp: Vec3 = { x: 0, y: 0, z: 0 };
const up: Vec3 = { x: 0, y: 0, z: 0 };

/** World position of a body-frame offset from the aircraft's reference point. */
function bodyToWorld(aircraft: SimAircraft, local: Vec3, out: Vec3): Vec3 {
  rotate(out, aircraft.state.orientation, local);
  out.x += aircraft.state.position.x;
  out.y += aircraft.state.position.y;
  out.z += aircraft.state.position.z;
  return out;
}

/**
 * Puts `pilot` outside `aircraft` (the kind from `exitKind` unless given) and returns the
 * kind used, or null when the pilot cannot leave now. The aircraft itself is not touched:
 * the app flies it on with the controls let go.
 */
export function leaveAircraft(
  pilot: Parachutist,
  aircraft: SimAircraft,
  env: Environment,
  kind: ExitKind | null = exitKind(aircraft),
): ExitKind | null {
  if (!kind) return null;
  const exit = EXITS[aircraft.info.id];
  const s = aircraft.state;
  const heading = aircraft.telemetry.headingDeg;
  const pos: Vec3 = { x: 0, y: 0, z: 0 };
  const vel: Vec3 = { x: s.velocity.x, y: s.velocity.y, z: s.velocity.z };
  if (kind === 'step') {
    bodyToWorld(aircraft, { x: exit.ground.x, y: exit.ground.y, z: 0 }, pos);
    env.up(pos, up);
    // Raised to standing height over the ground below; reset() settles it exactly.
    const g = env.ground(pos);
    if (g) {
      const dh = g.height + HIP_HEIGHT - env.altitude(pos);
      pos.x += up.x * dh;
      pos.y += up.y * dh;
      pos.z += up.z * dh;
    }
    vel.x = vel.y = vel.z = 0;
    // Facing the way the aircraft points, beside it.
    pilot.reset(pos, vel, heading, false, env);
    return kind;
  }
  bodyToWorld(aircraft, exit.door, pos);
  if (kind === 'jump') {
    // A push off the door sill: outwards (left) and a little down.
    rotate(tmp, s.orientation, { x: 0, y: -2, z: 0.5 });
    vel.x += tmp.x;
    vel.y += tmp.y;
    vel.z += tmp.z;
    pilot.reset(pos, vel, heading, true, env, 'ramAir');
    return kind;
  }
  // Ejection: along the aircraft's vertical (its body -z), whatever its attitude.
  rotate(tmp, s.orientation, { x: 0, y: 0, z: -EJECTION_SPEED });
  vel.x += tmp.x;
  vel.y += tmp.y;
  vel.z += tmp.z;
  pilot.reset(pos, vel, heading, true, env, 'round');
  return kind;
}

/**
 * The pilot stands close enough to the door of an intact, stopped aircraft to climb back
 * in. Distance in the horizontal: the door may be high above the ground (the airliner).
 */
export function canEnter(pilot: Parachutist, aircraft: SimAircraft, env: Environment): boolean {
  const t = aircraft.telemetry;
  if (pilot.mode !== 'walk' || !pilot.alive || pilot.swimming || t.crashed) return false;
  if (!t.onGround || t.groundSpeed > STOPPED_SPEED) return false;
  const exit = EXITS[aircraft.info.id];
  const spot = bodyToWorld(aircraft, { x: exit.ground.x, y: exit.ground.y, z: 0 }, tmp);
  const p = pilot.state.position;
  env.up(p, up);
  const dx = p.x - spot.x;
  const dy = p.y - spot.y;
  const dz = p.z - spot.z;
  const vertical = dx * up.x + dy * up.y + dz * up.z;
  const horizontal = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - vertical * vertical));
  return horizontal <= ENTER_REACH;
}
