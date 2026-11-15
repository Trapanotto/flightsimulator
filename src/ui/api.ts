import { signal } from '@preact/signals';
import type { AircraftId, ControlSpec, FailureId, Telemetry } from '@sim';
import type { Weather } from '@sky';

/** Where a flight starts. */
export type StartPlace =
  | { kind: 'runway'; airport: string; runway: string }
  /**
   * `altitude` in metres above sea level; the interface puts it above the chosen airport.
   * `speed` (phase 4, added by the interface): indicated airspeed in m/s that suits the type
   * (100 kt for the Cessna, 250 kt for the A320). The app turns it into the true airspeed
   * of the start; without it the app picks its own speed as before.
   */
  | {
      kind: 'air';
      lon: number;
      lat: number;
      altitude: number;
      headingDeg: number;
      speed?: number;
    }
  /**
   * On final approach to a runway, `distanceNm` nautical miles out, at the height of a
   * 3 degree approach path, configured and at approach speed (phase 3).
   */
  | { kind: 'approach'; airport: string; runway: string; distanceNm: number };

/** The weather choices of the flight setup. */
export type WeatherChoice = 'live' | 'clear' | 'fair' | 'cloudy' | 'overcast' | 'lowStratus';

/** Something that breaks during the flight (phase 3). */
export interface PlannedFailure {
  id: FailureId;
  /** Seconds after the start of the flight, or 'random' for some time in the first 20 minutes. */
  after: number | 'random';
}

/** The season of the landscape: the calendar's, or a chosen one. */
export type SeasonChoice = 'now' | 'spring' | 'summer' | 'autumn' | 'winter';

/** What the pilot chose in the menu. */
export interface FlightPlan {
  aircraft: AircraftId;
  start: StartPlace;
  /** 'now' or a fixed local time of day in hours (0..24). */
  time: 'now' | number;
  /** 'live' for the real weather, or the name of a preset. */
  weather: WeatherChoice;
  /** Snow line, autumn colours, bare winter woods. Default 'now'. */
  season?: SeasonChoice;
  /**
   * The airport the flight belongs to (ICAO), also for an air start. Added in phase 1 so the
   * briefing and the app can name the place without searching by coordinates. Optional for
   * plans built elsewhere.
   */
  airport?: string;
  /** Phase 3: where the flight is going; fills the GPS flight plan and the radio calls. */
  destination?: { airport: string; runway?: string };
  /** Phase 3: waypoints between departure and destination, in order. */
  route?: { ident: string; lon: number; lat: number }[];
  /** Phase 3: start with a cold, parked aircraft (the pilot starts the engine). Default false. */
  coldStart?: boolean;
  /** Phase 3: simulated air traffic control talks to the pilot. Default true. */
  atc?: boolean;
  /** Phase 3: things that break. */
  failures?: PlannedFailure[];
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
  /**
   * Phase 4 (added by the interface): the runways as strips with their length and surface,
   * so the setup can refuse an airport that is too short for the chosen type (an A320 needs
   * 1800 m of hard runway). The app fills it from the geo package's `AirportInfo.runways`;
   * without it the interface looks the airport up in the geo package by ICAO itself.
   */
  strips?: RunwayStrip[];
  /** Phase 4 (added by the interface): a military field (a fighter may use any hard runway). */
  military?: boolean;
}

/** One runway strip of an airport (phase 4). */
export interface RunwayStrip {
  /** Its two ends by designator, e.g. ['14', '32'] (one entry for a one-way strip). */
  ends: string[];
  /** Metres, end to end. */
  length: number;
  /** Asphalt or concrete. */
  paved: boolean;
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
  /**
   * Phase 4: the hangar shows a type: the app puts it into the menu's flight (null goes back
   * to the default). The interface only calls this for types in `AIRCRAFT`.
   */
  showAircraft?(id: AircraftId | null): void;
  /** Phase 3: operates a cockpit control by name (see `game.controls`). */
  setControl?(id: string, value: number): void;
  /** Phase 3: the pilot picks one of the radio replies on offer (`game.atc.options`). */
  atcReply?(optionId: string): void;
  /** Phase 3: opens a checklist by id, or closes the open one with null. */
  openChecklist?(id: string | null): void;
  /** Phase 3: ticks the current checklist item by hand (items the app can see tick themselves). */
  checkItem?(): void;
  /**
   * Phase 3 (added by the interface): fails or repairs something now, for practice (the pause
   * menu's "trigger a failure"). The app passes it to the aircraft's `Failures.set` and keeps
   * `game.failures` up to date. Without it the pause menu offers no failures.
   */
  setFailure?(id: FailureId, failed: boolean): void;

  // ---- phase 5 ----
  /** Starts a lesson of the flight school (an id of `game.lessons`). */
  startLesson?(id: string): void;
  /** Removes one flight from the logbook, or all of them. */
  deleteLogEntry?(id: string): void;
  clearLogbook?(): void;
  /** From the pause menu or the end of a flight: watch the recorded flight. `screen` becomes 'replay'. */
  openReplay?(): void;
  /** Back to where the replay was opened from (the pause menu). */
  closeReplay?(): void;
  /** Jump to a time of the recording, seconds (within `game.replay.start..end`). */
  replaySeek?(time: number): void;
  replayPlay?(playing: boolean): void;
  /** Playback speed: 0.25, 0.5, 1, 2, 4 or 8. */
  replaySpeed?(speed: number): void;
  /** From the pause menu or the replay: the photo mode. `screen` becomes 'photo'. */
  openPhoto?(): void;
  /** Back to where the photo mode was opened from. */
  closePhoto?(): void;
  /** Changes photo settings (only the given fields). */
  photoSet?(patch: Partial<PhotoSettings>): void;
  /** Saves the picture as it is on the screen, without the interface, as a PNG download. */
  photoSave?(): void;
}

/** A text in both languages; the interface shows the one of the current language. */
export interface Bilingual {
  de: string;
  en: string;
}

/** One touchdown of a flight (phase 5, logbook). */
export interface LandingRecord {
  /** Seconds since the start of the flight. */
  time: number;
  /** ICAO and runway designator when it was on a runway. */
  airport?: string;
  runway?: string;
  /** Sink rate at touchdown, m/s, positive down. */
  sinkRate: number;
  /** Indicated airspeed at touchdown, m/s. */
  speed: number;
  /** Metres right (+) or left (-) of the runway centre line; undefined off a runway. */
  centreline?: number;
  /** Metres past the threshold; undefined off a runway. */
  pastThreshold?: number;
  /** Peak load factor of the touchdown, g. */
  load?: number;
}

/** One flight in the logbook (phase 5). */
export interface LogEntry {
  id: string;
  /** Start of the flight in real time, ISO 8601. */
  date: string;
  aircraft: AircraftId;
  /** ICAO of where it took off and where it last landed, when known. */
  from?: string;
  to?: string;
  /** Seconds from the start of the flight to its end, and of those in the air. */
  duration: number;
  airTime: number;
  /** Metres over the ground. */
  distance: number;
  /** Highest altitude, metres above sea level. */
  maxAltitude: number;
  landings: LandingRecord[];
  /** How it ended. */
  outcome: 'landed' | 'crashed' | 'ended';
  /** The lesson flown, if it was one (an id of `game.lessons`), and whether it was passed. */
  lesson?: string;
  lessonPassed?: boolean;
  /** The ground track, thinned to a few hundred points: [lon, lat, altitude m]. */
  track: [number, number, number][];
}

/** A lesson of the flight school as the list shows it (phase 5). */
export interface LessonInfo {
  id: string;
  title: Bilingual;
  /** One or two sentences: what is learnt. */
  summary: Bilingual;
  aircraft: AircraftId;
  /** Rough length in minutes. */
  minutes: number;
  /** Passed at least once (kept in the browser). */
  done: boolean;
}

/** The lesson being flown (phase 5): what the instructor says now. */
export interface LessonView {
  id: string;
  title: Bilingual;
  /** The current step, 0-based, of `steps`. */
  step: number;
  steps: number;
  /** What to do now, one or two short sentences. */
  instruction: Bilingual;
  /** A correction while the pilot is off (too fast, too low, ...), or undefined. */
  hint?: Bilingual;
  /** 0..1 for a step that needs holding something for a while; undefined otherwise. */
  progress?: number;
  state: 'running' | 'passed' | 'failed';
  /** At the end: what went how (touchdown sink rate, centre line, speed held, ...). */
  debrief?: { label: Bilingual; value: string; ok: boolean }[];
}

/** The replay as the bar shows it (phase 5). Times in seconds of the flight. */
export interface ReplayView {
  time: number;
  start: number;
  end: number;
  playing: boolean;
  speed: number;
}

/** The photo mode's settings (phase 5). */
export interface PhotoSettings {
  /** Vertical field of view, degrees (10..100). */
  fov: number;
  /** Camera roll, degrees (-45..45). */
  roll: number;
  /** Local time of day in hours, 0..24: the light can be chosen for the picture. */
  time: number;
  /** Show the aircraft. */
  aircraft: boolean;
}

/** One line of radio traffic. */
export interface RadioMessage {
  from: 'atc' | 'pilot';
  /** The station speaking or spoken to, e.g. 'Bern Tower'. */
  station: string;
  text: string;
  /** Seconds since the start of the flight. */
  time: number;
}

/** The radio as the interface shows it (phase 3). */
export interface AtcView {
  /** The station on the active COM 1 frequency, or null if nobody is listening there. */
  station: string | null;
  /** kHz */
  frequency: number;
  /** Newest last; the app keeps the last twenty or so. */
  log: RadioMessage[];
  /** What the pilot can say now. Empty while there is nothing to say. */
  options: { id: string; text: string }[];
  /** A hint when the next call needs another frequency, e.g. 'Bern Tower 121.025'. */
  hint: string | null;
}

/** A checklist being worked through (phase 3). */
export interface ChecklistView {
  id: string;
  title: string;
  items: {
    /** What to check and the expected state, e.g. 'Mixture' and 'RICH'. */
    label: string;
    expect: string;
    state: 'done' | 'current' | 'todo';
    /** The cockpit control the item is about, if any (highlighted in the 3D cockpit). */
    control?: string;
  }[];
}

/** Which screen is up. The app writes it; the interface renders it. */
/**
 * 'replay' and 'photo' (phase 5) are a flight that stands still: the app shows the recorded
 * flight or the frozen moment, the interface shows only the replay bar or the photo controls.
 */
export type Screen = 'loading' | 'menu' | 'briefing' | 'flight' | 'paused' | 'replay' | 'photo';

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
  /** Phase 4, on types that have them: speed brake 0..1, reverse selected. */
  speedbrake?: number;
  reverse?: boolean;
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
  /** Phase 3: the controls of the aircraft being flown (names, kinds, ranges). */
  controls: signal<readonly ControlSpec[]>([]),
  /** Phase 3: the value of every control by name, refreshed about ten times a second. */
  cockpit: signal<Readonly<Record<string, number>> | null>(null),
  /**
   * The control of the 3D cockpit under the pointer (or just touched), with the pointer's place
   * in CSS pixels: the interface names it there, since the placards are too small to read on
   * a screen. Null when the pointer is over none.
   */
  pointedControl: signal<{ id: string; x: number; y: number } | null>(null),
  /** Phase 3: the radio; null when the flight has no air traffic control. */
  atc: signal<AtcView | null>(null),
  /** Phase 3: the checklists on offer for the aircraft, and the open one. */
  checklists: signal<{ id: string; title: string }[]>([]),
  checklist: signal<ChecklistView | null>(null),
  /**
   * Phase 3 (added by the interface): the frequencies the coming flight will need, in the order
   * they are used (ATIS, ground, tower, approach, the ILS …), for the briefing. Frequencies in
   * kHz (a NAV or ADF frequency is fine too). Empty when the app has none: the briefing then
   * leaves the list out.
   */
  frequencies: signal<readonly FrequencyInfo[]>([]),
  /**
   * Phase 3 (added by the interface): the failures active right now, so the pause menu can
   * show which ones it has triggered. The app writes it whenever a failure starts or is
   * repaired (planned failures included); empty without failures.
   */
  failures: signal<readonly FailureId[]>([]),

  // ---- phase 5 ----
  /** The logbook, newest flight first. The app loads it at the start and writes it after each flight. */
  logbook: signal<readonly LogEntry[]>([]),
  /** The lessons of the flight school, in teaching order. */
  lessons: signal<readonly LessonInfo[]>([]),
  /** The lesson being flown, refreshed a few times a second; null on a free flight. */
  lesson: signal<LessonView | null>(null),
  /** The replay while `screen` is 'replay' (refreshed about 20 times a second), else null. */
  replay: signal<ReplayView | null>(null),
  /** Whether the flight in progress has a recording to replay (false in the first seconds). */
  canReplay: signal(false),
  /** The photo settings while `screen` is 'photo', else null. */
  photo: signal<PhotoSettings | null>(null),
};

/** A frequency to expect on the flight (phase 3, briefing). */
export interface FrequencyInfo {
  /** What it is, e.g. 'Zürich ATIS', 'Zürich Tower' or 'ILS 14 IZH'. Display text. */
  name: string;
  /** kHz */
  frequency: number;
}

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
  /** Phase 4: speed brake lever 0..1 (null = not touched), and reverse held. */
  speedbrake: signal<number | null>(null),
  reverse: signal(false),
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
  /** Phase 3: the navigation strip under the heading tape (NAV 1, needles, DME, autopilot). */
  navStrip: signal(true),
  /** Phase 3: a new radio message shows as a line of text when the radio panel is closed. */
  radioText: signal(true),
  /**
   * Phase 3: checklist hints: the current item shows on the HUD while the checklist panel is
   * closed. The app may read it too and highlight the item's control in the 3D cockpit only
   * while it is true.
   */
  checklistHints: signal(true),
};
