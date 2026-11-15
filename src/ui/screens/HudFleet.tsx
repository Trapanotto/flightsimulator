import { useComputed } from '@preact/signals';
import type { AircraftInfo } from '@sim';
import { game } from '../api';
import { overspeedLimit } from '../fleet';

/**
 * How the airspeed warns, for the type flown: amber near the stall or the limit (VNE, or at
 * height the airspeed of the maximum Mach number), red beyond the limit.
 */
export function useSpeedState(info: AircraftInfo | undefined) {
  return useComputed(() => {
    const tel = game.telemetry.value;
    if (!info || !tel || tel.crashed) return '';
    const limit = overspeedLimit(info, tel.ias, tel.mach);
    if (tel.ias > limit) return ' is-over';
    if (tel.ias > limit * 0.95) return ' is-near';
    const stall = tel.flaps > 0.5 ? info.vs0 : info.vs;
    if (!tel.onGround && tel.ias < stall * 1.1) return ' is-slow';
    return '';
  });
}
