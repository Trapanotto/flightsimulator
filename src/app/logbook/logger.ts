import { ellipsoidToSeaLevel } from '@geo';
import type { AircraftId, Telemetry } from '@sim';
import type { RunwayFinder } from './runways';
import { TrackRecorder, groundDistance } from './track';
import type { LandingRecord, LogEntry, LogOutcome } from './types';

/** Points of the ground track in a finished entry. */
export const TRACK_POINTS = 400;
/**
 * The sink rate is taken from the airborne frames this long before contact: in the contact
 * frame the gear has already absorbed part of it, and further back the flare still changes it.
 */
const SINK_WINDOW = 0.25;
/** Back in the air for less than this after a touchdown: a bounce of the same landing. */
const BOUNCE_TIME = 5;
/** The peak load factor of a touchdown is searched in this time after contact. */
const LOAD_WINDOW = 1;
/** Faster than this between two frames is a reposition (slew, reset), not flight. */
const MAX_SPEED = 1500;

export interface FlightLoggerOptions {
  aircraft: AircraftId;
  /** The real start of the flight (wall clock: the logbook shows when it was flown). */
  date: Date;
  /** The lesson being flown, an id of `game.lessons`. */
  lesson?: string;
  runways: RunwayFinder;
}

interface Contact {
  record: LandingRecord;
  airport: string | undefined;
}

/**
 * Records one flight for the logbook. Fed with every frame's telemetry; knows nothing about
 * the renderer or the interface.
 */
export class FlightLogger {
  private readonly track = new TrackRecorder();
  private time = 0;
  private airTime = 0;
  private distance = 0;
  private maxAltitude = -Infinity;
  private last: { lon: number; lat: number } | undefined;
  private wasOnGround: boolean | undefined;
  private startAirport: string | undefined;
  private from: string | undefined;
  /** When the aircraft last left the ground. */
  private liftTime: number | undefined;
  /** Recent airborne frames: time, sink rate (m/s down), indicated airspeed. */
  private readonly history: Array<{ time: number; sink: number; ias: number }> = [];
  private readonly contacts: Contact[] = [];
  private loadUntil = -Infinity;
  private frozen = false;

  constructor(private readonly options: FlightLoggerOptions) {}

  /**
   * After every simulation frame. `at` is where the aircraft is: Telemetry carries the altitude
   * but not the horizontal position.
   */
  sample(dt: number, t: Telemetry, at: { lon: number; lat: number }): void {
    if (this.frozen || !(dt > 0)) return;
    this.time += dt;
    const { lon, lat } = at;

    if (this.last) {
      const d = groundDistance([this.last.lon, this.last.lat], [lon, lat]);
      if (d <= MAX_SPEED * dt) this.distance += d;
    }
    this.last = { lon, lat };
    const altitude = ellipsoidToSeaLevel(lon, lat, t.altitude);
    if (altitude > this.maxAltitude) this.maxAltitude = altitude;
    this.track.add(lon, lat, Math.round(altitude));

    const onGround = t.onGround;
    if (this.wasOnGround === undefined) {
      this.wasOnGround = onGround;
      if (onGround) this.startAirport = this.options.runways.airportAt(lon, lat);
    }
    const heading = t.groundSpeed > 10 ? t.trackDeg : t.headingDeg;

    if (!onGround) {
      this.airTime += dt;
      if (this.wasOnGround) {
        this.liftTime = this.time;
        this.from ??=
          this.options.runways.runwayAt(lon, lat, heading)?.airport ??
          this.options.runways.airportAt(lon, lat);
      }
      this.history.push({ time: this.time, sink: -t.verticalSpeed, ias: t.ias });
      while (this.history[0]!.time < this.time - SINK_WINDOW) this.history.shift();
    } else if (this.wasOnGround === false) {
      this.touchdown(t, lon, lat, heading);
    }

    const current = this.contacts.at(-1);
    if (current && this.time <= this.loadUntil) {
      current.record.load = Math.max(current.record.load ?? 0, round(t.loadFactor, 2));
    }
    this.wasOnGround = onGround;
    // A wreck lies still; the rest of the frames would only add time on the ground.
    if (t.crashed) this.frozen = true;
  }

  private touchdown(t: Telemetry, lon: number, lat: number, heading: number): void {
    let sink = -t.verticalSpeed;
    let ias = t.ias;
    if (this.history.length > 0) {
      sink = Math.max(...this.history.map((h) => h.sink));
      ias = this.history.at(-1)!.ias;
    }
    this.history.length = 0;
    this.loadUntil = this.time + LOAD_WINDOW;

    const previous = this.contacts.at(-1);
    if (
      previous &&
      this.liftTime !== undefined &&
      this.liftTime > previous.record.time &&
      this.time - this.liftTime <= BOUNCE_TIME
    ) {
      // A bounce: the landing is judged by its worst contact, but stays where it first touched.
      previous.record.sinkRate = Math.max(previous.record.sinkRate, round(sink, 2));
      return;
    }

    const record: LandingRecord = {
      time: round(this.time, 1),
      sinkRate: round(sink, 2),
      speed: round(ias, 1),
      load: round(t.loadFactor, 2),
    };
    const hit = this.options.runways.runwayAt(lon, lat, heading);
    if (hit) {
      record.airport = hit.airport;
      record.runway = hit.runway;
      record.centreline = round(hit.centreline, 1);
      record.pastThreshold = Math.round(hit.pastThreshold);
    }
    this.contacts.push({
      record,
      airport: hit?.airport ?? this.options.runways.airportAt(lon, lat),
    });
  }

  /** The flight as a logbook entry. The logger can keep sampling; call it again later. */
  finish(outcome: LogOutcome, lessonPassed?: boolean): LogEntry {
    const { aircraft, date, lesson } = this.options;
    const entry: LogEntry = {
      id: `${date.getTime().toString(36)}-${aircraft}`,
      date: date.toISOString(),
      aircraft,
      duration: round(this.time, 1),
      airTime: round(this.airTime, 1),
      distance: Math.round(this.distance),
      maxAltitude: this.maxAltitude === -Infinity ? 0 : Math.round(this.maxAltitude),
      landings: this.contacts.map((c) => ({ ...c.record })),
      outcome,
      track: this.track
        .points(TRACK_POINTS)
        .map(([lon, lat, alt]) => [round(lon, 5), round(lat, 5), Math.round(alt)]),
    };
    const from = this.from ?? this.startAirport;
    const to = this.contacts.at(-1)?.airport;
    if (from) entry.from = from;
    if (to) entry.to = to;
    if (lesson !== undefined) {
      entry.lesson = lesson;
      if (lessonPassed !== undefined) entry.lessonPassed = lessonPassed;
    }
    return entry;
  }
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
