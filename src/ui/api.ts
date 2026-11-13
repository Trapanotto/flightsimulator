import { signal } from '@preact/signals';
import type { AircraftId, Telemetry } from '@sim';

/** Where a flight starts. */
export type StartPlace =
  | { kind: 'runway'; airport: string; runway: string }
  | { kind: 'air'; lon: number; lat: number; altitude: number; headingDeg: number };

/** What the pilot chose in the menu. */
export interface FlightPlan {
  aircraft: AircraftId;
  start: StartPlace;
  /** 'now' or a fixed local time of day in hours (0..24). */
  time: 'now' | number;
  /** 'live' for the real weather, or the name of a preset. */
  weather: 'live' | 'clear' | 'fair' | 'cloudy' | 'overcast';
}

/** A place a flight can start from, offered by the app to the menu. */
export interface AirportOption {
  icao: string;
  name: string;
  lon: number;
  lat: number;
  /** Elevation in metres above sea level. */
  elevation: number;
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
}

/** Which screen is up. The app writes it; the interface renders it. */
export type Screen = 'loading' | 'menu' | 'briefing' | 'flight' | 'paused';

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
  /** A short message for the pilot (stall, gear, crash), or null. */
  message: signal<string | null>(null),
  view: signal<'outside' | 'cockpit'>('outside'),
};

/**
 * Input from on-screen controls (touch). The interface writes, the app reads every frame and
 * mixes it with keyboard and gamepad. Axes -1..1, levers 0..1; null = no touch input active.
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
