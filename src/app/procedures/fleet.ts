/**
 * What the procedures know per aircraft type: its checklists, and how air traffic control
 * names it. The cockpit's control specs come from the aircraft itself (`cockpit.specs`):
 * the sim package exports only some of the control tables by name.
 */
import type { AircraftId } from '@sim';
import { C172_CHECKLISTS, type ChecklistDef } from './checklists';
import { A320_CHECKLISTS } from './checklistsA320';
import { FA18_CHECKLISTS } from './checklistsFa18';
import { PC12_CHECKLISTS } from './checklistsPc12';
import { type Line, line } from './phraseology';

const CHECKLISTS: Record<AircraftId, readonly ChecklistDef[]> = {
  c172: C172_CHECKLISTS,
  pc12: PC12_CHECKLISTS,
  a320: A320_CHECKLISTS,
  fa18: FA18_CHECKLISTS,
};

/** The checklists of a type (the Cessna's for an unknown one). */
export function checklistsFor(id: AircraftId): readonly ChecklistDef[] {
  return CHECKLISTS[id] ?? C172_CHECKLISTS;
}

export type Category = 'piston' | 'turboprop' | 'airliner' | 'fighter';

/** A type as air traffic control sees it. */
export interface AtcAircraft {
  /** As said in a call ('Cessna 172'); spoken without digits. */
  type: Line;
  /** ICAO Doc 8643 type designator, for the flight plan. */
  designator: string;
  /** ICAO wake turbulence category: 'HEAVY' is said after the callsign, the others not. */
  wake: 'L' | 'M' | 'H';
  category: Category;
  /** The callsign the app flies it under, unless the plan says otherwise. */
  callsign: string;
  /** IFR is the default for the airliner, VFR for the others. */
  flightRules: 'VFR' | 'IFR';
  /** Highest flight level it is cleared to (its ceiling, for a cruise level). */
  ceilingFl: number;
}

export const ATC_AIRCRAFT: Record<AircraftId, AtcAircraft> = {
  c172: {
    type: line('Cessna 172', 'Cessna one seven two'),
    designator: 'C172',
    wake: 'L',
    category: 'piston',
    callsign: 'HB-TFS',
    flightRules: 'VFR',
    ceilingFl: 120,
  },
  pc12: {
    type: line('Pilatus PC-12', 'Pilatus P C twelve'),
    designator: 'PC12',
    wake: 'L',
    category: 'turboprop',
    callsign: 'HB-FTS',
    flightRules: 'VFR',
    ceilingFl: 300,
  },
  a320: {
    type: line('Airbus A320', 'Airbus A three twenty'),
    designator: 'A320',
    wake: 'M',
    category: 'airliner',
    // An invented airline: no real operator flies under this name.
    callsign: 'Alpine 482',
    flightRules: 'IFR',
    ceilingFl: 390,
  },
  fa18: {
    type: line('F/A-18', 'F A eighteen'),
    // Doc 8643 lists the legacy Hornet as F18H (the Super Hornet is F18S).
    designator: 'F18H',
    wake: 'M',
    category: 'fighter',
    callsign: 'Hornet 11',
    flightRules: 'VFR',
    ceilingFl: 450,
  },
};
