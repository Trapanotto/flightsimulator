/**
 * The pilot outside the aircraft: which words the interface uses for getting out and what the
 * one-line hint says in each state. Pure functions, tested in Node.
 */
import type { PilotView } from './api';
import type { MessageKey } from './i18n';

/** How leaving reads: getting out on the ground, a jump in flight, the ejection seat. */
export function leaveKey(onGround: boolean, fighter: boolean): MessageKey {
  return onGround ? 'pilot.leave.ground' : fighter ? 'pilot.leave.eject' : 'pilot.leave.jump';
}

/**
 * Below this height above the ground (m) in free fall the hint turns urgent: nothing opens the
 * parachute but the pilot, also after an ejection.
 */
export const PULL_URGENT_AGL = 600;

/** Free fall close to the ground: the chute must be pulled now. */
export function pullUrgent(p: PilotView): boolean {
  return p.state === 'freefall' && p.agl < PULL_URGENT_AGL;
}

/** The hint under the jumper's readouts, for keys or for touch. */
export function pilotHint(p: PilotView, touch: boolean): MessageKey {
  if (pullUrgent(p)) return touch ? 'pilot.hint.freefall.low.touch' : 'pilot.hint.freefall.low';
  if (p.state === 'freefall') return touch ? 'pilot.hint.freefall.touch' : 'pilot.hint.freefall';
  if (p.state === 'canopy') return touch ? 'pilot.hint.canopy.touch' : 'pilot.hint.canopy';
  if (p.aircraftLost) return 'pilot.hint.lost';
  if (p.canEnter) return touch ? 'pilot.hint.enter.touch' : 'pilot.hint.enter';
  return touch ? 'pilot.hint.walk.touch' : 'pilot.hint.walk';
}

/** The big touch button of a state: pull the chute, flare, get in, or none. */
export function pilotAction(p: PilotView): 'pull' | 'flare' | 'enter' | null {
  if (p.state === 'freefall') return 'pull';
  if (p.state === 'canopy') return 'flare';
  return p.canEnter && !p.aircraftLost ? 'enter' : null;
}
