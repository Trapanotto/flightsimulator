import { signal } from '@preact/signals';
import type { AircraftId, Telemetry } from '@sim';
import type { Weather } from '@sky';

/** Where a flight starts. */
export type StartPlace =
  | { kind: 'runway'; airport: string; runway: string }
  /** `altitude` in metres above sea level; the interface puts it above the chosen airport. */
  | { kind: 'air'; lon: number; lat: number; altitude: number; headingDeg: number };

/** The weather choices of the flight setup. */
export type WeatherChoice = 'live' | 'clear' | 'fair' | 'cloudy' | 'overcast';

/** What the pilot chose in the menu. */
export interface FlightPlan {
  aircraft: AircraftId;
  start: StartPlace;
  /** 'now' or a fixed local time of day in hours (0..24). */
  time: 'now' | number;
  /** 'live' for the real weather, or the name of a preset. */
  weather: WeatherChoice;
  /**
   * The airport the flight belongs to (ICAO), also for an air start. Added in phase 1 so the
   * briefing and the app can name the place without searching by coordinates. Optional for
   * plans built elsewhere.
   */
  airport?: string;
}

/** A place a flight can start from, offered by the app to the menu. */
export interface AirportOption {
  icao: string;
  name: string;
  lon: number;
  lat: number;
  /** Elevation in metres above sea level. */
  elevation: number;
  /** Runway ends by designator, e.g. ['14', '32']. The first is the default. */
  runways: string[];
}

/** What the interface asks the app to do. The app passes these to mountUi(). */
export interface UiActions {
  startFlight(plan: FlightPlan): void;
  pause(): void;
  resume(): void;
  /** Start the same flight again from the beginning. */
  restart(): void;
  exitToMenu(): void;
  /** Outside view / cockpit view. */
  toggleView(): void;
  /**
   * Optional: the selection in the flight setup changed (debounced). The app may show it in
   * the menu scene (time of day, weather, place). Never starts a flight.
   */
  preview?(plan: FlightPlan): void;
}

/** Which screen is up. The app writes it; the interface renders it. */
export type Screen = 'loading' | 'menu' | 'briefing' | 'flight' | 'paused';

/** Positions of the pilot's levers (what is commanded, not what the aircraft has reached). */
export interface Levers {
  /** 0..1 */
  throttle: number;
  /** Flap lever 0..1 (0 = up). */
  flaps: number;
  gearDown: boolean;
  /** Wheel brakes applied (any amount). */
  brake: boolean;
  parkingBrake: boolean;
}

/** The weather of a flight as the briefing shows it (the sky package's own type). */
export type WeatherReport = Weather;

/**
 * The state of the game as the interface sees it. Signals: the app writes, components read.
 */
export const game = {
  screen: signal<Screen>('loading'),
  /** 0..1 while `screen` is 'loading' or 'briefing' (the world streams in). */
  loadProgress: signal(0),
  airports: signal<AirportOption[]>([]),
  /** The flight in progress: refreshed about 20 times a second, null in the menu. */
  telemetry: signal<Telemetry | null>(null),
  /**
   * A short message for the pilot (stall, gear, crash), or null. Either display text or a
   * message key of `src/ui/i18n.ts` starting with 'msg.' (translated by the interface). Shown
   * for a few seconds; set null and then the text again to repeat the same message.
   */
  message: signal<string | null>(null),
  view: signal<'outside' | 'cockpit'>('outside'),
  /** Lever positions, written by the app with the telemetry; null in the menu. */
  levers: signal<Levers | null>(null),
  /** The weather of the coming flight once known (live weather), for the briefing; or null. */
  weather: signal<WeatherReport | null>(null),
  /**
   * The flight being prepared or flown. The interface sets it right before startFlight(); the
   * app may set it too (for a flight started another way).
   */
  plan: signal<FlightPlan | null>(null),
};

/**
 * Input from on-screen controls (touch). The interface writes, the app reads every frame and
 * mixes it with keyboard and gamepad. Axes -1..1, levers 0..1; null = no touch input active.
 *
 * `pitch` is already corrected for `settings.invertPitch` (positive = nose up). `throttle` is
 * an absolute lever position: when it changes, the app sets its throttle to it (keyboard steps
 * then continue from there); the interface shows `game.levers.throttle` while not dragging.
 */
export const touchInput = {
  pitch: signal<number | null>(null),
  roll: signal<number | null>(null),
  yaw: signal<number | null>(null),
  throttle: signal<number | null>(null),
  brake: signal(false),
  /** Counters: the app acts when a value changes (a tap on the button). */
  flapsUp: signal(0),
  flapsDown: signal(0),
  gearToggle: signal(0),
  /** True while the on-screen flight controls are shown (touch device or a touch seen). */
  active: signal(false),
};

/** Settings the player can change; kept in localStorage by the interface. */
export const settings = {
  quality: signal<'auto' | 'low' | 'medium' | 'high'>('auto'),
  /** 0..1 */
  volume: signal(0.7),
  muted: signal(false),
  invertPitch: signal(false),
  /** Steer by tilting the device (mobile). */
  tiltSteering: signal(false),
  units: signal<'metric' | 'aviation'>('aviation'),
};
