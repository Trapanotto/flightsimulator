/**
 * What the avionics unit of a type has (Phase 4): the radio stack is common, the autopilot
 * is the type's. An autopilot is an `AutopilotComputer`: the stack hands it the aircraft
 * state, the cockpit, the button presses of this step and the course and glide slope of the
 * selected navigation source; it fills its telemetry and, while it flies, a command.
 *
 * The Cessna has the KAP 140 (autopilot.ts), the PC-12 a two-axis autopilot with flight
 * director and yaw damper (flightDirector.ts). An airliner's or a fighter's flight guidance,
 * with autothrottle, plugs in through `autopilot` as a factory.
 */
import type { AutopilotCommand, AutopilotTelemetry, AvionicsInput } from '../avionicsTypes';
import type { Cockpit } from '../cockpit';
import type { AutopilotConfig, LateralGuidance, VerticalGuidance } from './autopilot';
import type { FlightDirectorConfig } from './flightDirector';

/** Where the course indicator and the autopilot take their guidance from. */
export type NavSource = 'nav1' | 'gps' | 'nav2';

/** What an autopilot computer is given each step. */
export interface AutopilotContext {
  readonly input: AvionicsInput;
  readonly cockpit: Cockpit;
  /** A button of the cockpit was pressed this step (its value rose past 0.5). */
  pressed(id: string): boolean;
  /** Guidance of the selected source. */
  readonly lateral: LateralGuidance;
  readonly vertical: VerticalGuidance;
  readonly source: NavSource;
}

export interface AutopilotComputer {
  readonly telemetry: AutopilotTelemetry;
  /** What it flies with while engaged; undefined otherwise. */
  readonly command: AutopilotCommand | undefined;
  reset(): void;
  step(dt: number, ctx: AutopilotContext): void;
}

export interface AvionicsConfig {
  /**
   * The autopilot: 'kap140' (the Cessna's), 'flightDirector' (the PC-12's), or a factory for
   * a type's own flight guidance.
   */
  autopilot: 'kap140' | 'flightDirector' | (() => AutopilotComputer);
  /** Tuning of the KAP 140 or of the flight director autopilot for this type. */
  kap140?: Partial<AutopilotConfig>;
  flightDirector?: Partial<FlightDirectorConfig>;
  /** The positions of the `navSource` selector, in order. */
  navSources: readonly NavSource[];
  /**
   * NAV 2 tuned by something other than its own knobs (the F/A-18's TACAN channel and the
   * HSI course); the DME then follows NAV 2 whenever it is the selected source.
   */
  nav2Tuning?: (cockpit: Cockpit) => { frequency: number; course: number };
}

export const C172_AVIONICS: AvionicsConfig = { autopilot: 'kap140', navSources: ['nav1', 'gps'] };
