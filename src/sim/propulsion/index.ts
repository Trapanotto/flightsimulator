import { PistonPowerplant, type PistonDef } from './piston';
import type { Powerplant } from './powerplant';
import { TurbofanPowerplant, type TurbofanDef } from './turbofan';
import { TurbopropPowerplant, type TurbopropDef } from './turboprop';

export type { PistonDef, PropellerMount } from './piston';
export type { TurbopropDef, TurbopropData } from './turboprop';
export type { TurbofanDef, TurbofanData } from './turbofan';
export * from './powerplant';
export * from './propeller';
export { PistonPowerplant, TurbofanPowerplant, TurbopropPowerplant };

/** One engine of a type, as its definition lists it. */
export type EngineDef = PistonDef | TurbopropDef | TurbofanDef;

export function createPowerplant(def: EngineDef): Powerplant {
  switch (def.kind) {
    case 'piston':
      return new PistonPowerplant(def);
    case 'turboprop':
      return new TurbopropPowerplant(def);
    case 'turbofan':
    case 'afterburning':
      return new TurbofanPowerplant(def);
  }
}
