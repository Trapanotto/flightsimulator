/**
 * Simulated air traffic control in Swiss practice, as a state machine: VFR flights with the
 * circuit, reporting points and FIS; IFR flights (the airliner by default, any type on
 * request) with clearance delivery, departure, area control ('Swiss Radar'), descent and a
 * vectored ILS; and for the fighter at its home base the overhead break and the low
 * approach. The aircraft's type, callsign and flight rules come from the config. The app passes the flight's situation a few times a second; the
 * controller answers with what the radio shows (`AtcView`) and with events (a message was
 * spoken, a squawk or QNH was given, an instruction the app can check, a deviation).
 *
 * Everything the controller knows lives in one plain object (`AtcState`): a flight can be
 * saved and restored, and the same situations always give the same dialogue. Time is the
 * simulated time passed in; there are no timers.
 */
import type { AircraftId } from '@sim';
import { ATC_AIRCRAFT, type AtcAircraft } from './fleet';
import {
  type AtcAirport,
  type AtcRunway,
  type AtcStation,
  type AtcWorld,
  BUILTIN_ATC_WORLD,
  SWISS_RADAR,
} from './world';
import { type AtcWeather, atisLetter, atisMessage, runwayInUse, towerWind } from './weather';
import {
  type Line,
  altitude as altitudeLine,
  callsign as callsignLine,
  capital,
  compassPoint,
  frequency as frequencyLine,
  frequencyText,
  heading as headingLine,
  join,
  knots,
  level as levelLine,
  line,
  miles,
  phonetic,
  phrase,
  qnh as qnhLine,
  runway as runwayLine,
  squawk as squawkLine,
  transitionLevel,
} from './phraseology';
import {
  angleDiff,
  approachFrame,
  bearingTo,
  distanceNm,
  metresFromStart,
  norm360,
  onRunway,
} from './geometry';
import {
  type VectorPlan,
  INTERCEPT_NM,
  fromTouchdown,
  interceptAltitude,
  interceptDistance,
  nearlyEstablished,
  nextVector,
  planScale,
  planVectors,
} from './vectors';

/** One line of radio traffic (the shape of `RadioMessage` in src/ui/api.ts). */
export interface RadioMessage {
  from: 'atc' | 'pilot';
  station: string;
  text: string;
  time: number;
}

/** The radio as the interface shows it (the shape of `AtcView` in src/ui/api.ts). */
export interface AtcView {
  station: string | null;
  frequency: number;
  log: RadioMessage[];
  options: { id: string; text: string }[];
  hint: string | null;
}

/** The flight as the controller sees it, a few times a second. */
export interface AtcSituation {
  /** Simulated seconds since the start of the flight. */
  time: number;
  lon: number;
  lat: number;
  /** Feet above sea level. */
  altitudeFt: number;
  /** Feet above the ground; undefined while the ground is not known. */
  heightFt?: number;
  /** Degrees true. */
  headingDeg: number;
  trackDeg: number;
  groundSpeedKt: number;
  verticalSpeedFpm: number;
  onGround: boolean;
  engineRunning: boolean;
  /** Active COM 1 frequency, kHz. */
  com1: number;
  /** COM 1 has power and has not failed. */
  com1Works: boolean;
  /** Transponder code (octal digits as a decimal number) and mode. */
  squawk: number;
  transponder: 'off' | 'standby' | 'on' | 'alt';
}

export type AtcInstruction =
  | { kind: 'altitude'; feet: number; mode: 'climb' | 'descend' | 'maintain' }
  /** Degrees magnetic. */
  | { kind: 'heading'; degrees: number; turn: 'left' | 'right' | 'fly' }
  | { kind: 'runway'; runway: string; clearance: 'lineUp' | 'takeoff' | 'land' | 'lowApproach' }
  | { kind: 'holdShort'; runway: string }
  | {
      kind: 'approach';
      runway: string;
      approach: 'ils' | 'straightIn' | 'circuit' | 'overhead';
    }
  /** At most this indicated airspeed. */
  | { kind: 'speed'; knots: number }
  /** Own navigation direct to an airport (ICAO code). */
  | { kind: 'direct'; to: string };

export type DeviationKind =
  'altitude' | 'takeoffWithoutClearance' | 'landingWithoutClearance' | 'controlZone' | 'holdShort';

export type AtcEvent =
  /** A transmission was heard: show it, speak `spoken` in the voice of `message.from`. */
  | { type: 'message'; message: RadioMessage; spoken: string }
  | { type: 'squawk'; code: number }
  | { type: 'qnh'; hPa: number; airport: string }
  /** The controller sent the pilot to another frequency (the app may preset COM 1 standby). */
  | { type: 'frequency'; khz: number; station: string }
  | { type: 'instruction'; instruction: AtcInstruction }
  /** The controller noticed something; the call itself comes as a message. */
  | { type: 'deviation'; kind: DeviationKind };

export interface AtcConfig {
  /** Defaults to the built-in table (Bern, Zürich, Langenthal). */
  world?: AtcWorld;
  /**
   * A registration ('HB-TFS', abbreviated to 'HFS' once the station does), or an airline's
   * or military callsign with a number ('Alpine 482', 'Hornet 11'), never abbreviated.
   */
  callsign: string;
  /** The type flown: its name on the radio, category and wake. Default 'c172'. */
  aircraft?: AircraftId;
  /** Type as said on the radio (default: the aircraft's). */
  aircraftType?: Line;
  /** Default: IFR for the airliner, VFR for the others. */
  flightRules?: 'VFR' | 'IFR';
  /** IFR: the requested cruise level (flight level); default by distance and type. */
  cruiseLevel?: number;
  /** The fighter's base, where it may ask for an overhead break (default: the departure). */
  homeBase?: string;
  departure: { airport: string; runway?: string };
  /** Defaults to the departure airport (a local flight). */
  destination?: { airport: string; runway?: string };
  weather: AtcWeather;
  /** Magnetic declination, degrees east (Switzerland 2026: about 3). */
  declinationDeg?: number;
}

type Stage =
  | 'init'
  | 'parked'
  | 'startedUp'
  | 'taxi'
  | 'onRunway'
  | 'lineUp'
  | 'takeoff'
  | 'departing'
  | 'uncDeparture'
  | 'enroute'
  | 'arrToPoint'
  | 'arrDownwind'
  | 'arrFinal'
  | 'arrLanding'
  | 'arrBreak'
  | 'arrLowApproach'
  | 'ifrDeparture'
  | 'ifrClimb'
  | 'ifrCruise'
  | 'ifrArrival'
  | 'ilsSquawk'
  | 'ilsVectors'
  | 'ilsCleared'
  | 'ilsHandoff'
  | 'uncArrival'
  | 'landed'
  | 'vacating'
  | 'taxiIn'
  | 'done';

interface Readback {
  station: string;
  correct: Line;
  wrong: Line | null;
  /** What the controller says after a wrong readback (after 'negative'). */
  correction: Line;
  /** The instruction, for 'I say again'. */
  repeat: Line;
  at: number;
  repeats: number;
  /** A frequency change: offered, but nobody insists. */
  soft: boolean;
}

interface Queued {
  due: number;
  station: string;
  text: string;
  spoken: string;
  events: AtcEvent[];
  readback: Readback | null;
}

/** Everything the controller knows: plain data, JSON-safe. */
export interface AtcState {
  version: 1;
  stage: Stage;
  time: number;
  seq: number;
  sit: AtcSituation | null;
  log: RadioMessage[];
  queue: Queued[];
  readback: Readback | null;
  lastAtc: { station: string; text: string; spoken: string; time: number } | null;
  /** Stations that have answered once. */
  answered: string[];
  /** Stations that have used the abbreviated callsign: the pilot may use it with them too. */
  known: string[];
  /** The station that gave the last instruction and expects the pilot to stay with it. */
  inCharge: string | null;
  atisIndex: Record<string, number>;
  atisHeard: Record<string, number>;
  atisNext: number;
  atisStation: string | null;
  depRunway: string | null;
  arrRunway: string | null;
  arrPoint: string | null;
  clearance: { takeoff: boolean; landing: boolean; lineUp: boolean; holdShort: string | null };
  /** Control zones the pilot may be in. */
  zones: string[];
  zoneSince: Record<string, number>;
  zoneWarned: string[];
  assignedAltitude: number | null;
  altitudeReached: boolean;
  altitudeWarned: boolean;
  assignedHeading: number | null;
  squawk: number | null;
  squawkAt: number;
  squawkReminded: boolean;
  vectors: VectorPlan | null;
  fis: 'none' | 'called' | 'done' | 'left';
  airborne: boolean;
  lowOnApproach: boolean;
  lineUpAt: number;
  takeoffSent: boolean;
  takeoffWarned: boolean;
  landingWarned: boolean;
  holdShortWarned: boolean;
  blind: string[];
  touchedDown: boolean;
  /** Every station the flight has talked to, by id (also ones the world names elsewhere). */
  stations: Record<string, AtcStation>;
  weatherKey: string;
  /** The assigned altitude is a flight level (compared with the pressure altitude). */
  assignedStd?: boolean;
  /** IFR flights only; missing in states saved before there was IFR. */
  ifr?: IfrState;
}

interface IfrState {
  /** The IFR clearance has been given. */
  cleared: boolean;
  /** Feet: the altitude of the standard departure, and the cruise level's. */
  initialFt: number;
  cruiseFt: number;
  /** Who works the flight in the climb and the cruise. */
  departureId: string | null;
  handedToDeparture: boolean;
  handedToRadar: boolean;
  descentGiven: boolean;
  handedToArrival: boolean;
}

interface Call {
  id: string;
  station: AtcStation;
  /** What the pilot says after the address ('request start-up'). */
  body: Line;
  run(): void;
}

const READBACK_REPEAT_S = 15;
const ZONE_GRACE_S = 20;
const WORD_S = 0.33;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

export class AtcController {
  private readonly world: AtcWorld;
  private readonly decl: number;
  private readonly dep: AtcAirport;
  private readonly arr: AtcAirport;
  private weather: AtcWeather;
  private s: AtcState;
  private out: AtcEvent[] = [];

  constructor(
    private readonly config: AtcConfig,
    state?: AtcState,
  ) {
    this.world = config.world ?? BUILTIN_ATC_WORLD;
    this.decl = config.declinationDeg ?? 3;
    this.weather = config.weather;
    const dep = this.world.airport(config.departure.airport);
    if (!dep) throw new Error(`No ATC data for ${config.departure.airport}`);
    this.dep = dep;
    this.arr = (config.destination && this.world.airport(config.destination.airport)) || dep;
    this.s = state ? (JSON.parse(JSON.stringify(state)) as AtcState) : this.fresh();
  }

  private fresh(): AtcState {
    const atisIndex: Record<string, number> = {};
    for (const ap of [this.dep, this.arr])
      atisIndex[ap.icao] = [...ap.icao].reduce((a, c) => a + c.charCodeAt(0), 0) % 26;
    return {
      version: 1,
      stage: 'init',
      time: 0,
      seq: 0,
      sit: null,
      log: [],
      queue: [],
      readback: null,
      lastAtc: null,
      answered: [],
      known: [],
      inCharge: null,
      atisIndex,
      atisHeard: {},
      atisNext: 0,
      atisStation: null,
      depRunway: null,
      arrRunway: null,
      arrPoint: null,
      clearance: { takeoff: false, landing: false, lineUp: false, holdShort: null },
      zones: [],
      zoneSince: {},
      zoneWarned: [],
      assignedAltitude: null,
      altitudeReached: false,
      altitudeWarned: false,
      assignedHeading: null,
      squawk: null,
      squawkAt: 0,
      squawkReminded: false,
      vectors: null,
      fis: 'none',
      airborne: false,
      lowOnApproach: false,
      lineUpAt: 0,
      takeoffSent: false,
      takeoffWarned: false,
      landingWarned: false,
      holdShortWarned: false,
      blind: [],
      touchedDown: false,
      stations: {},
      weatherKey: weatherKey(this.weather),
    };
  }

  /** A copy of the state for saving a flight; `new AtcController(config, state)` restores it. */
  save(): AtcState {
    return JSON.parse(JSON.stringify(this.s)) as AtcState;
  }

  /** A new weather report: the ATIS letters move on when it changed. */
  setWeather(w: AtcWeather) {
    this.weather = w;
    const key = weatherKey(w);
    if (key === this.s.weatherKey) return;
    this.s.weatherKey = key;
    for (const k of Object.keys(this.s.atisIndex)) this.s.atisIndex[k] = this.s.atisIndex[k]! + 1;
  }

  // ---------------------------------------------------------------- per update

  update(sit: AtcSituation): AtcEvent[] {
    this.s.time = sit.time;
    this.s.sit = { ...sit };
    if (this.s.stage === 'init') this.begin(sit);
    if (!sit.onGround && (sit.heightFt ?? 100) > 30) this.s.airborne = true;
    this.atis(sit);
    this.deliver(sit);
    this.remind(sit);
    this.monitor(sit);
    this.advance(sit);
    return this.flush();
  }

  /** The pilot picks one of `view().options`. */
  reply(optionId: string): AtcEvent[] {
    const sit = this.s.sit;
    if (!sit) return [];
    const opt = this.offered(sit).find((o) => o.id === optionId);
    if (opt) opt.run();
    return this.flush();
  }

  view(): AtcView {
    const sit = this.s.sit;
    const tuned = sit && sit.com1Works ? this.tuned(sit) : undefined;
    return {
      station: tuned?.name ?? null,
      frequency: sit?.com1 ?? 0,
      log: this.s.log.slice(-20),
      options: sit ? this.offered(sit).map((o) => ({ id: o.id, text: o.text })) : [],
      hint: sit ? this.hint(sit) : null,
    };
  }

  /** The stage of the flight, for tests and the debug overlay. */
  get stage(): string {
    return this.s.stage;
  }

  private flush() {
    const e = this.out;
    this.out = [];
    return e;
  }

  // ---------------------------------------------------------------- helpers

  private station(ap: AtcAirport, role: AtcStation['role']): AtcStation | undefined {
    return ap.stations.find((s) => s.role === role);
  }
  private ground(ap: AtcAirport) {
    return this.station(ap, 'ground') ?? this.station(ap, 'tower')!;
  }
  private tower(ap: AtcAirport) {
    return this.station(ap, 'tower')!;
  }
  private byId(id: string): AtcStation | undefined {
    for (const ap of [this.dep, this.arr]) {
      const s = ap.stations.find((x) => x.id === id);
      if (s) return s;
    }
    return this.s.stations[id];
  }
  private tuned(sit: AtcSituation) {
    const st = this.world.stationOn(sit.com1, sit.lon, sit.lat);
    if (st) return st;
    // Area control the world does not list (the stand-in) is still heard on its frequency.
    const radar = this.radar(sit);
    return this.isIfr && Math.round(sit.com1) === radar.frequency ? radar : undefined;
  }
  private hears(sit: AtcSituation, st: AtcStation | undefined) {
    return !!st && sit.com1Works && Math.round(sit.com1) === st.frequency;
  }
  private runway(ap: AtcAirport, ident: string | null): AtcRunway {
    return ap.runways.find((r) => r.ident === ident) ?? ap.runways[0]!;
  }
  private inUse(ap: AtcAirport): AtcRunway {
    const pref = ap === this.dep ? this.config.departure.runway : this.config.destination?.runway;
    return runwayInUse(ap, this.weather, pref);
  }
  private depRwy() {
    return this.runway(this.dep, this.s.depRunway);
  }
  private arrRwy() {
    return this.runway(this.arr, this.s.arrRunway);
  }
  private get local() {
    return this.arr === this.dep;
  }
  private cs(st: AtcStation | null): Line {
    return callsignLine(this.config.callsign, !!st && this.s.known.includes(st.id));
  }
  private type(): Line {
    return this.config.aircraftType ?? this.info.type;
  }
  private get info(): AtcAircraft {
    return ATC_AIRCRAFT[this.config.aircraft ?? 'c172'] ?? ATC_AIRCRAFT.c172;
  }
  private get isIfr() {
    return (this.config.flightRules ?? this.info.flightRules) === 'IFR';
  }
  private get isJet() {
    return this.info.category === 'airliner' || this.info.category === 'fighter';
  }
  /** The fighter arriving at its own base: the overhead break and the low approach. */
  private get atHome() {
    return (
      this.info.category === 'fighter' &&
      this.arr.icao === (this.config.homeBase ?? this.dep.icao).toUpperCase()
    );
  }
  private ifr(): IfrState {
    if (!this.s.ifr) this.s.ifr = this.freshIfr();
    return this.s.ifr;
  }
  private freshIfr(): IfrState {
    const elev = this.dep.elevationFt;
    return {
      cleared: false,
      // 'Climb 5000 ft' out of the Swiss Plateau; 3000 ft above higher fields.
      initialFt: Math.max(5000, Math.ceil((elev + 3000) / 1000) * 1000),
      cruiseFt: this.cruiseFt(),
      departureId: null,
      handedToDeparture: false,
      handedToRadar: false,
      descentGiven: false,
      handedToArrival: false,
    };
  }
  /**
   * The cruise level: the requested one, or as high as climb (about 2 NM per 1000 ft) and
   * descent (3 NM per 1000 ft) allow over the distance, within the type's ceiling, on the
   * semicircular rule (odd thousands eastbound, even westbound, by magnetic track).
   */
  private cruiseFt(): number {
    const tl = transitionLevel(this.weather.qnh);
    const want =
      this.config.cruiseLevel ??
      Math.min(this.info.ceilingFl, Math.floor((distanceNm(this.dep, this.arr) / 5) * 10));
    const east = this.local || norm360(bearingTo(this.dep, this.arr) - this.decl) < 180;
    let fl = Math.max(tl + 10, Math.floor(want / 10) * 10);
    if (this.config.cruiseLevel === undefined && (fl / 10) % 2 !== (east ? 1 : 0)) fl -= 10;
    return Math.max(fl, tl) * 100;
  }
  /** Altitude by the standard setting, as a flight level counts it. */
  private pressureFt(sit: AtcSituation) {
    return sit.altitudeFt + (1013.25 - this.weather.qnh) * 27.3;
  }
  private lvl(ft: number) {
    return levelLine(ft, this.weather.qnh);
  }
  private isLevel(ft: number) {
    return Math.round(ft / 100) >= transitionLevel(this.weather.qnh);
  }
  /** The present level, rounded to hundreds, as reported. */
  private levelNow(sit: AtcSituation) {
    const std = this.pressureFt(sit);
    return this.isLevel(std)
      ? this.lvl(Math.round(std / 100) * 100)
      : this.lvl(Math.round(sit.altitudeFt / 100) * 100);
  }
  private delivery(ap: AtcAirport) {
    return this.station(ap, 'delivery') ?? this.ground(ap);
  }
  private departureStation(ap: AtcAirport) {
    return this.station(ap, 'departure') ?? this.station(ap, 'arrival');
  }
  private radar(sit: AtcSituation | null): AtcStation {
    return (sit && this.world.area?.(sit.lon, sit.lat, sit.altitudeFt)) || SWISS_RADAR;
  }
  /** The destination has radar vectors to an ILS on the runway in use. */
  private ilsAvailable() {
    return !!this.station(this.arr, 'arrival') && this.inUse(this.arr).ils;
  }
  private assign(ft: number) {
    this.s.assignedAltitude = ft;
    this.s.assignedStd = this.isLevel(ft);
    this.s.altitudeReached = false;
    this.s.altitudeWarned = false;
  }
  private height(sit: AtcSituation, ap: AtcAirport) {
    return sit.heightFt ?? sit.altitudeFt - ap.elevationFt;
  }
  private qnhEvent(ap: AtcAirport): AtcEvent {
    return { type: 'qnh', hPa: Math.round(this.weather.qnh), airport: ap.icao };
  }
  private atisInfo(ap: AtcAirport): Line | null {
    const heard = this.s.atisHeard[ap.icao];
    if (heard === undefined || heard !== this.s.atisIndex[ap.icao]) return null;
    return line(`information ${phonetic(atisLetter(heard))}`);
  }
  /** 'information Delta is current' when the pilot did not report the current one. */
  private atisReminder(ap: AtcAirport, reported: boolean): Line | null {
    if (reported || !this.station(ap, 'atis')) return null;
    return line(`information ${phonetic(atisLetter(this.s.atisIndex[ap.icao] ?? 0))} is current`);
  }

  /** Where the aircraft is, for a position report: '12 NM north of Bern'. */
  private position(sit: AtcSituation): Line {
    const ref =
      distanceNm(this.arr, sit) < 40 || distanceNm(this.dep, sit) >= 40 ? this.arr : this.dep;
    const d = distanceNm(ref, sit);
    if (d < 1.5) return line(`overhead ${ref.name}`);
    const m = miles(d);
    const dir = compassPoint(bearingTo(ref, sit));
    return line(`${m.text} ${dir} of ${ref.name}`, `${m.spoken} ${dir} of ${ref.name}`);
  }
  private altitudeNow(sit: AtcSituation) {
    return altitudeLine(Math.round(sit.altitudeFt / 100) * 100);
  }

  // ---------------------------------------------------------------- transmissions

  private pause() {
    return 1.2 + 0.4 * (this.s.seq % 3);
  }

  /**
   * The controller speaks after the channel is free and a short pause. `body` follows the
   * callsign (and the station's name on its first reply).
   */
  private atc(
    st: AtcStation,
    body: Line,
    opts: {
      events?: AtcEvent[];
      readback?: Omit<Readback, 'at' | 'repeats' | 'station'>;
      after?: number;
    } = {},
  ) {
    this.s.stations[st.id] = { ...st };
    // ICAO: the first answer gives the full callsign, from then on the station abbreviates
    // it, and only after that does the pilot.
    const first = !this.s.answered.includes(st.id);
    const head = first
      ? join(callsignLine(this.config.callsign, false), line(st.name, st.spoken))
      : callsignLine(this.config.callsign, true);
    if (first) this.s.answered.push(st.id);
    else if (!this.s.known.includes(st.id)) this.s.known.push(st.id);
    const msg = join(head, body);
    const last = this.s.queue[this.s.queue.length - 1];
    const start = Math.max(
      this.s.time + (opts.after ?? this.pause()),
      last ? last.due + words(last.spoken) * WORD_S + 0.8 : 0,
    );
    this.s.seq++;
    this.s.queue.push({
      due: start,
      station: st.id,
      text: msg.text,
      spoken: msg.spoken,
      events: opts.events ?? [],
      readback: opts.readback ? { ...opts.readback, station: st.id, at: 0, repeats: 0 } : null,
    });
  }

  /** The pilot transmits now; returns when the controller may answer. */
  private pilot(st: AtcStation, msg: Line) {
    const rb = this.s.readback;
    if (rb && rb.soft && rb.station !== st.id) this.s.readback = null;
    const m: RadioMessage = { from: 'pilot', station: st.name, text: msg.text, time: this.s.time };
    this.s.log.push(m);
    this.trimLog();
    this.out.push({ type: 'message', message: m, spoken: msg.spoken });
    this.s.seq++;
  }

  /**
   * A request: 'Bern Ground, HB-TFS, <body>' to call a station, 'HB-TFS, <body>' once it has
   * answered, 'HFS, <body>' once it abbreviates.
   */
  private request(st: AtcStation, body: Line) {
    const msg = this.requestLine(st, body);
    this.pilot(st, msg);
    return words(msg.spoken) * WORD_S;
  }

  private requestLine(st: AtcStation, body: Line): Line {
    if (this.s.answered.includes(st.id)) return join(this.cs(st), body);
    return join(line(st.name, st.spoken), callsignLine(this.config.callsign, false), body);
  }

  private trimLog() {
    if (this.s.log.length > 60) this.s.log.splice(0, this.s.log.length - 60);
  }

  private deliver(sit: AtcSituation) {
    while (this.s.queue.length && this.s.queue[0]!.due <= sit.time) {
      const q = this.s.queue.shift()!;
      const st = this.byId(q.station);
      if (!st || !this.hears(sit, st)) continue;
      const m: RadioMessage = { from: 'atc', station: st.name, text: q.text, time: sit.time };
      this.s.log.push(m);
      this.trimLog();
      this.out.push({ type: 'message', message: m, spoken: q.spoken }, ...q.events);
      this.s.lastAtc = { station: st.id, text: q.text, spoken: q.spoken, time: sit.time };
      if (q.readback) this.s.readback = { ...q.readback, at: sit.time };
    }
  }

  /** A readback that does not come: the controller says it again, once. */
  private remind(sit: AtcSituation) {
    const rb = this.s.readback;
    if (!rb || rb.soft || rb.repeats > 0 || this.s.queue.length) return;
    if (sit.time - rb.at < READBACK_REPEAT_S) return;
    const st = this.byId(rb.station);
    if (!st) return;
    rb.repeats = 1;
    this.atc(st, join(line('I say again'), rb.repeat), { after: 0.5 });
  }

  private atis(sit: AtcSituation) {
    const st = this.tuned(sit);
    if (!sit.com1Works || !st || st.role !== 'atis' || !st.airport) {
      this.s.atisStation = null;
      return;
    }
    const ap =
      st.airport === this.dep.icao ? this.dep : st.airport === this.arr.icao ? this.arr : undefined;
    if (!ap) return;
    if (this.s.atisStation === st.id && sit.time < this.s.atisNext) return;
    this.s.atisStation = st.id;
    const index = this.s.atisIndex[ap.icao] ?? 0;
    const msg = atisMessage(ap, this.weather, index, this.inUse(ap).ident, this.decl);
    const m: RadioMessage = { from: 'atc', station: st.name, text: msg.text, time: sit.time };
    this.s.log.push(m);
    this.trimLog();
    this.out.push({ type: 'message', message: m, spoken: msg.spoken });
    this.s.atisHeard[ap.icao] = index;
    // The broadcast loops: it starts again when it has been said.
    this.s.atisNext = sit.time + words(msg.spoken) * WORD_S + 5;
  }

  // ---------------------------------------------------------------- options

  private offered(sit: AtcSituation): { id: string; text: string; run(): void }[] {
    if (!sit.com1Works || this.s.queue.length) return [];
    const tuned = this.tuned(sit);
    if (!tuned || tuned.role === 'atis') return [];
    const rb = this.s.readback;
    if (rb) {
      if (rb.station !== tuned.id) return rb.soft ? this.callOptions(sit, tuned) : [];
      return this.readbackOptions(rb, tuned);
    }
    return this.callOptions(sit, tuned);
  }

  private readbackOptions(rb: Readback, st: AtcStation) {
    const said = (l: Line) => {
      const m = join(l, this.cs(st));
      return line(capital(m.text), capital(m.spoken));
    };
    const opts = [
      {
        id: 'readback',
        text: said(rb.correct).text,
        run: () => {
          this.pilot(st, said(rb.correct));
          this.s.readback = null;
        },
      },
    ];
    if (rb.wrong) {
      const wrong = rb.wrong;
      opts.push({
        id: 'readbackWrong',
        text: said(wrong).text,
        run: () => {
          this.pilot(st, said(wrong));
          rb.repeats = 0;
          rb.at = this.s.time;
          this.atc(st, join(line('negative'), rb.correction));
        },
      });
      // Which of the two comes first changes from one instruction to the next.
      if (this.s.seq % 2 === 1) opts.reverse();
    }
    opts.push(this.sayAgain(st));
    return opts;
  }

  private sayAgain(st: AtcStation) {
    const msg = join(line('say again'), this.cs(st));
    return {
      id: 'sayAgain',
      text: capital(msg.text),
      run: () => {
        this.pilot(st, line(capital(msg.text), capital(msg.spoken)));
        const last = this.s.lastAtc;
        if (!last) return;
        const m = { text: last.text, spoken: last.spoken };
        this.s.seq++;
        this.s.queue.push({
          due: this.s.time + this.pause() + 1,
          station: st.id,
          ...m,
          events: [],
          readback: null,
        });
      },
    };
  }

  private callOptions(sit: AtcSituation, tuned: AtcStation) {
    const calls = this.calls(sit);
    const mine = calls.filter((c) => c.station.id === tuned.id);
    const toOption = (c: Call) => {
      const blind = c.station.role === 'aerodrome';
      const preview = blind
        ? this.blindLine(c.station, c.body)
        : this.requestLine(c.station, c.body);
      return { id: c.id, text: capital(preview.text), run: () => c.run() };
    };
    const opts = mine.map(toOption);
    const last = this.s.lastAtc;
    if (opts.length === 0 && tuned.role !== 'aerodrome') {
      // Calling the wrong station: the call can be made, and the controller sends the pilot on.
      const target = calls.find((c) => c.station.role !== 'aerodrome' && c.station.id !== tuned.id);
      if (target)
        opts.push(
          toOption({
            id: `wrong.${target.id}`,
            station: tuned,
            body: target.body,
            run: () => {
              const wait = this.request(tuned, target.body);
              this.redirect(tuned, target.station, wait);
            },
          }),
        );
    }
    if (last && last.station === tuned.id && sit.time - last.time < 60)
      opts.push(this.sayAgain(tuned));
    return opts;
  }

  /** 'contact Bern Tower 121.025': a frequency change with its readback. */
  private redirect(from: AtcStation, to: AtcStation, wait: number, prefix?: Line) {
    const f = frequencyLine(to.frequency);
    const name = line(to.name, to.spoken);
    const wrongF = frequencyLine(to.frequency + (to.frequency % 1000 >= 800 ? -200 : 200));
    this.atc(from, join(prefix, phrase(line('contact'), name, f)), {
      after: wait + this.pause(),
      events: [{ type: 'frequency', khz: to.frequency, station: to.name }],
      readback: {
        correct: phrase(name, f),
        wrong: phrase(name, wrongF),
        correction: phrase(name, f),
        repeat: phrase(line('contact'), name, f),
        soft: true,
      },
    });
    this.s.inCharge = to.id;
  }

  private blindLine(st: AtcStation, body: Line): Line {
    const ap = st.airport ? this.world.airport(st.airport) : undefined;
    return join(
      line(st.name, st.spoken),
      callsignLine(this.config.callsign, false),
      body,
      ap && line(ap.name),
    );
  }

  private hint(sit: AtcSituation): string | null {
    if (!sit.com1Works) return null;
    const tuned = this.tuned(sit);
    const fmt = (st: AtcStation) => `${st.name} ${frequencyText(st.frequency)}`;
    const rb = this.s.readback;
    if (rb && !rb.soft) {
      const st = this.byId(rb.station);
      return st && st.id !== tuned?.id ? fmt(st) : null;
    }
    const calls = this.calls(sit);
    if (calls.length && !calls.some((c) => c.station.id === tuned?.id)) {
      // Listen to the ATIS before the first call to an airport that has one.
      const first = calls[0]!.station;
      const ap = first.airport ? this.world.airport(first.airport) : undefined;
      const atis = ap && this.station(ap, 'atis');
      if (ap && atis && this.atisInfo(ap) === null && first.role !== 'information')
        return fmt(atis);
      return fmt(first);
    }
    const inCharge = this.s.inCharge ? this.byId(this.s.inCharge) : undefined;
    if (inCharge && inCharge.id !== tuned?.id && this.s.stage !== 'done') return fmt(inCharge);
    return null;
  }

  // ---------------------------------------------------------------- the flight

  private begin(sit: AtcSituation) {
    const nearDep = distanceNm(this.dep, sit) < 3;
    if (sit.onGround && nearDep) {
      const rwy = this.inUse(this.dep);
      this.s.depRunway = rwy.ident;
      if (!this.dep.controlled) this.s.stage = 'uncDeparture';
      else {
        const on = this.dep.runways.find(
          (r) => onRunway(r, sit) && Math.abs(angleDiff(sit.headingDeg, r.course)) < 30,
        );
        if (on && sit.engineRunning) {
          this.s.depRunway = on.ident;
          this.s.stage = 'onRunway';
        } else this.s.stage = sit.engineRunning ? 'startedUp' : 'parked';
      }
      return;
    }
    this.s.stage = sit.onGround ? 'done' : 'enroute';
    // A flight that starts in the air inside a zone was handed over with its clearance.
    const z = this.world.controlZone(sit.lon, sit.lat, sit.altitudeFt);
    if (!sit.onGround && z) this.s.zones.push(z);
  }

  /** Every call the pilot could make now, to whichever station it goes to. */
  private calls(sit: AtcSituation): Call[] {
    const c: Call[] = [];
    const dep = this.dep;
    const arr = this.arr;
    const s = this.s;
    switch (s.stage) {
      case 'parked':
      case 'startedUp': {
        if (this.isIfr && dep.controlled) {
          this.ifrGroundCalls(sit, c);
          break;
        }
        const g = this.ground(dep);
        const info = this.atisInfo(dep);
        const dest = this.local ? line('local flight') : line(`VFR to ${arr.name}`);
        if (s.stage === 'parked' && !sit.engineRunning)
          c.push({
            id: 'startup',
            station: g,
            body: join(this.type(), line('at the apron'), dest, info, line('request start-up')),
            run: () =>
              this.startup(
                g,
                info !== null,
                this.request(
                  g,
                  join(this.type(), line('at the apron'), dest, info, line('request start-up')),
                ),
              ),
          });
        else if (sit.engineRunning) {
          const body =
            s.stage === 'parked'
              ? join(this.type(), line('at the apron'), dest, info, line('request taxi'))
              : line('request taxi');
          c.push({
            id: 'taxi',
            station: g,
            body,
            run: () =>
              this.taxi(g, info !== null || s.stage === 'startedUp', this.request(g, body)),
          });
        }
        break;
      }
      case 'taxi': {
        const rwy = this.depRwy();
        const t = this.tower(dep);
        const atHold = sit.onGround && sit.groundSpeedKt < 5 && metresFromStart(rwy, sit) < 450;
        if (atHold) {
          const b = join(
            phrase(line('holding point'), runwayLine(rwy.ident)),
            line('ready for departure'),
          );
          c.push({
            id: 'ready',
            station: t,
            body: b,
            run: () => this.lineUp(t, this.request(t, b)),
          });
        }
        break;
      }
      case 'onRunway': {
        const t = this.tower(dep);
        const rwy = this.depRwy();
        const rules = this.isIfr ? 'IFR' : 'VFR';
        const dest = this.local
          ? line(this.isIfr ? 'local IFR flight' : 'local flight')
          : line(`${rules} to ${arr.name}`);
        const b = join(
          phrase(line('lined up'), runwayLine(rwy.ident)),
          line('ready for departure'),
          dest,
        );
        c.push({
          id: 'ready',
          station: t,
          body: b,
          run: () => this.takeoffClearance(t, this.request(t, b)),
        });
        break;
      }
      case 'departing': {
        const t = this.tower(dep);
        const p = dep.reportingPoints.find((x) => x.name === s.arrPoint);
        const out = this.world.controlZone(sit.lon, sit.lat, sit.altitudeFt) !== dep.icao;
        if ((p && distanceNm(p, sit) < 2) || out) {
          const b = p
            ? join(line(p.spoken), line('leaving the control zone'))
            : line('leaving the control zone');
          c.push({
            id: 'leaving',
            station: t,
            body: b,
            run: () => {
              const wait = this.request(t, b);
              const info = this.world.information(sit.lon, sit.lat);
              s.stage = 'enroute';
              const code =
                s.squawk !== null ? line('squawk 7000', 'squawk seven thousand') : undefined;
              if (info) this.redirect(t, info, wait, code);
              else this.atc(t, line('frequency change approved'), { after: wait + this.pause() });
            },
          });
        }
        break;
      }
      case 'uncDeparture': {
        const ap = dep;
        const st = this.station(ap, 'aerodrome');
        if (!st) break;
        const rwy = this.depRwy();
        const where = this.local
          ? line('local flight')
          : line(`departing to the ${compassPoint(bearingTo(ap, arr))}`);
        if (sit.onGround && sit.engineRunning && !onRunway(rwy, sit) && !s.blind.includes('taxi'))
          c.push(this.blindCall(st, 'taxi', phrase(line('taxiing to'), runwayLine(rwy.ident))));
        if (sit.onGround && metresFromStart(rwy, sit) < 300 && !s.blind.includes('lineup'))
          c.push(
            this.blindCall(
              st,
              'lineup',
              join(phrase(line('lining up'), runwayLine(rwy.ident)), where),
            ),
          );
        break;
      }
      case 'enroute':
        this.enrouteCalls(sit, c);
        break;
      case 'arrToPoint': {
        const t = this.tower(arr);
        const p = arr.reportingPoints.find((x) => x.name === s.arrPoint);
        if (p && distanceNm(p, sit) < 2) {
          const b = join(line(p.spoken), this.altitudeNow(sit));
          c.push({
            id: 'point',
            station: t,
            body: b,
            run: () => this.join(t, sit, this.request(t, b), false),
          });
        }
        break;
      }
      case 'arrDownwind': {
        const t = this.tower(arr);
        if (!sit.onGround && distanceNm(arr, sit) < 5) {
          const b = phrase(line('downwind'), runwayLine(this.arrRwy().ident));
          c.push({
            id: 'downwind',
            station: t,
            body: b,
            run: () => {
              const wait = this.request(t, b);
              s.stage = 'arrFinal';
              this.atc(t, join(line('number one'), line('report final')), {
                after: wait + this.pause(),
                readback: {
                  correct: join(line('number one'), line('wilco')),
                  wrong: null,
                  correction: line('number one, report final'),
                  repeat: line('number one, report final'),
                  soft: false,
                },
              });
            },
          });
        }
        break;
      }
      case 'arrFinal': {
        const t = this.tower(arr);
        const rwy = this.arrRwy();
        const { x, y } = approachFrame(rwy, sit);
        if (
          !sit.onGround &&
          x > 0.2 &&
          x < 8 &&
          Math.abs(y) < 1.5 &&
          Math.abs(angleDiff(sit.headingDeg, rwy.course)) < 45
        ) {
          const b = phrase(line(x > 4 ? 'long final' : 'final'), runwayLine(rwy.ident));
          c.push({
            id: 'final',
            station: t,
            body: b,
            run: () => this.landingClearance(t, this.request(t, b)),
          });
          if (this.atHome) {
            const bl = join(b, line('request low approach'));
            c.push({
              id: 'lowApproach',
              station: t,
              body: bl,
              run: () => this.lowApproach(t, this.request(t, bl)),
            });
          }
        }
        break;
      }
      case 'arrLanding': {
        const t = this.tower(arr);
        if (!sit.onGround) {
          const b = line('going around');
          c.push({
            id: 'goAround',
            station: t,
            body: b,
            run: () => this.goAround(t, this.request(t, b), false),
          });
        }
        break;
      }
      case 'ilsCleared': {
        const a = this.station(arr, 'arrival');
        const rwy = this.arrRwy();
        if (a && this.established(sit, rwy)) {
          const b = phrase(line('established localizer'), runwayLine(rwy.ident));
          c.push({
            id: 'established',
            station: a,
            body: b,
            run: () => this.handoff(a, this.request(a, b)),
          });
        }
        break;
      }
      case 'ilsHandoff': {
        const t = this.tower(arr);
        const b = phrase(line('established ILS'), runwayLine(this.arrRwy().ident));
        c.push({
          id: 'towerIls',
          station: t,
          body: b,
          run: () => this.landingClearance(t, this.request(t, b)),
        });
        break;
      }
      case 'uncArrival':
        this.blindArrivalCalls(sit, c);
        break;
      case 'ifrDeparture': {
        const ifr = this.ifr();
        const d = ifr.departureId ? this.byId(ifr.departureId) : undefined;
        if (d && ifr.handedToDeparture && !sit.onGround) {
          const b = this.climbReport(sit);
          c.push({
            id: 'departure',
            station: d,
            body: b,
            run: () => this.departureContact(d, sit, this.request(d, b)),
          });
        }
        break;
      }
      case 'ifrClimb': {
        const ifr = this.ifr();
        if (!ifr.handedToRadar) break;
        const r = this.radar(sit);
        const b = this.climbReport(sit);
        c.push({
          id: 'radar',
          station: r,
          body: b,
          run: () => this.radarContact(r, this.request(r, b)),
        });
        break;
      }
      case 'ifrArrival': {
        const a = this.station(arr, 'arrival');
        if (!a) break;
        const info = this.atisInfo(arr);
        const b = join(this.climbReport(sit), info);
        c.push({
          id: 'arrivalIfr',
          station: a,
          body: b,
          run: () => {
            const wait = this.request(a, b);
            this.startVectors(sit, wait + this.pause(), info !== null);
          },
        });
        break;
      }
      case 'arrBreak': {
        const t = this.tower(arr);
        const rwy = this.arrRwy();
        const { x, y } = approachFrame(rwy, sit);
        const onInitial =
          !sit.onGround &&
          x > 1 &&
          x < 7 &&
          Math.abs(y) < 1 &&
          Math.abs(angleDiff(sit.headingDeg, rwy.course)) < 30;
        if (onInitial) {
          const b = phrase(line('initial'), runwayLine(rwy.ident));
          c.push({
            id: 'initial',
            station: t,
            body: b,
            run: () => {
              const wait = this.request(t, b);
              s.stage = 'arrFinal';
              const say = join(line('number one'), line('break approved'), line('report final'));
              this.atc(t, say, {
                after: wait + this.pause(),
                readback: {
                  correct: join(line('break approved'), line('wilco')),
                  wrong: null,
                  correction: say,
                  repeat: say,
                  soft: false,
                },
              });
            },
          });
        }
        break;
      }
      case 'vacating': {
        const st = this.byId(s.inCharge ?? '') ?? this.ground(arr);
        const off = sit.onGround && !arr.runways.some((r) => onRunway(r, sit, 10));
        if (off) {
          const b = join(
            phrase(runwayLine(this.arrRwy().ident), line('vacated')),
            line('request taxi to the apron'),
          );
          c.push({
            id: 'vacated',
            station: st,
            body: b,
            run: () => {
              const wait = this.request(st, b);
              s.stage = 'taxiIn';
              this.atc(st, line('taxi to the apron'), {
                after: wait + this.pause(),
                readback: {
                  correct: line('taxi to the apron'),
                  wrong: null,
                  correction: line('taxi to the apron'),
                  repeat: line('taxi to the apron'),
                  soft: false,
                },
              });
            },
          });
        }
        break;
      }
      case 'taxiIn': {
        const st = this.byId(s.inCharge ?? '') ?? this.ground(arr);
        if (sit.onGround && sit.groundSpeedKt < 1) {
          const b = line('parked, goodbye');
          c.push({
            id: 'parked',
            station: st,
            body: b,
            run: () => {
              const wait = this.request(st, b);
              s.stage = 'done';
              s.inCharge = null;
              this.atc(st, line('goodbye'), { after: wait + this.pause() });
            },
          });
        }
        break;
      }
      default:
        break;
    }
    return c;
  }

  private blindCall(st: AtcStation, id: string, body: Line): Call {
    return {
      id: `blind.${id}`,
      station: st,
      body,
      run: () => {
        this.pilot(st, this.blindLine(st, body));
        this.s.blind.push(id);
      },
    };
  }

  private enrouteCalls(sit: AtcSituation, c: Call[]) {
    const s = this.s;
    const arr = this.arr;
    const dist = distanceNm(arr, sit);
    // An IFR flight that starts in the air calls area control first.
    if (this.isIfr && !sit.onGround && !this.ifr().handedToArrival && dist > 30) {
      const r = this.radar(sit);
      const b = join(this.type(), this.levelNow(sit), line(`IFR to ${arr.name}`));
      c.push({
        id: 'radar',
        station: r,
        body: b,
        run: () => {
          const ifr = this.ifr();
          ifr.cleared = true;
          ifr.handedToRadar = true;
          ifr.cruiseFt = Math.max(Math.round(this.pressureFt(sit) / 1000) * 1000, 3000);
          this.radarContact(r, this.request(r, b));
        },
      });
    }
    if (arr.controlled && dist < 25 && this.atHome) {
      const t = this.tower(arr);
      const info = this.atisInfo(arr);
      const rwy = this.inUse(arr);
      const b = join(
        this.type(),
        this.position(sit),
        this.altitudeNow(sit),
        info,
        phrase(line('request overhead break'), runwayLine(rwy.ident)),
      );
      c.push({
        id: 'arrivalBreak',
        station: t,
        body: b,
        run: () => this.overhead(t, this.request(t, b), info !== null),
      });
    }
    if (arr.controlled && dist < 25) {
      const t = this.tower(arr);
      const info = this.atisInfo(arr);
      const b = join(
        this.type(),
        this.position(sit),
        this.altitudeNow(sit),
        info,
        line('for landing'),
      );
      c.push({
        id: 'arrival',
        station: t,
        body: b,
        run: () => this.join(t, sit, this.request(t, b), true, info !== null),
      });
      const a = this.station(arr, 'arrival');
      const rwy = this.inUse(arr);
      if (a && rwy.ils) {
        const bi = join(
          this.type(),
          this.position(sit),
          this.altitudeNow(sit),
          info,
          phrase(line('request ILS approach'), runwayLine(rwy.ident)),
        );
        c.push({
          id: 'arrivalIls',
          station: a,
          body: bi,
          run: () => this.ilsRequest(a, rwy, this.request(a, bi), info !== null),
        });
      }
    }
    const fis = this.world.information(sit.lon, sit.lat);
    if (fis && !sit.onGround) {
      if (s.fis === 'none')
        c.push({
          id: 'fis',
          station: fis,
          body: line(''),
          run: () => {
            const wait = this.request(fis, line(''));
            s.fis = 'called';
            this.atc(fis, line('pass your message'), { after: wait + this.pause() });
          },
        });
      else if (s.fis === 'called') {
        const from = this.local
          ? line(`VFR local flight from ${this.dep.name}`)
          : line(`VFR from ${this.dep.name} to ${arr.name}`);
        const b = join(
          this.type(),
          from,
          this.position(sit),
          this.altitudeNow(sit),
          line('request flight information service'),
        );
        c.push({
          id: 'fisDetails',
          station: fis,
          body: b,
          run: () => {
            const wait = this.request(fis, b);
            s.fis = 'done';
            s.inCharge = fis.id;
            this.atc(
              fis,
              join(line('roger'), qnhLine(this.weather.qnh), line('report leaving the frequency')),
              {
                after: wait + this.pause(),
                events: [this.qnhEvent(arr)],
                readback: {
                  correct: join(qnhLine(this.weather.qnh), line('wilco')),
                  wrong: join(qnhLine(wrongQnh(this.weather.qnh)), line('wilco')),
                  correction: qnhLine(this.weather.qnh),
                  repeat: qnhLine(this.weather.qnh),
                  soft: false,
                },
              },
            );
          },
        });
      } else if (s.fis === 'done' && dist < 30) {
        const next = arr.controlled ? this.tower(arr) : this.station(arr, 'aerodrome');
        const b = line(
          `leaving the frequency to ${next ? next.name : arr.name}`,
          `leaving the frequency to ${next ? next.spoken : arr.name}`,
        );
        c.push({
          id: 'fisLeave',
          station: fis,
          body: b,
          run: () => {
            const wait = this.request(fis, b);
            s.fis = 'left';
            s.inCharge = null;
            this.atc(fis, join(line('frequency change approved'), line('goodbye')), {
              after: wait + this.pause(),
            });
          },
        });
      }
    }
  }

  private blindArrivalCalls(sit: AtcSituation, c: Call[]) {
    const ap = this.arr;
    const st = this.station(ap, 'aerodrome');
    if (!st) return;
    const rwy = this.arrRwy();
    const { x, y } = approachFrame(rwy, sit);
    const side = rwy.circuit === 'left' ? -1 : 1;
    const hdg = sit.headingDeg;
    const air = !sit.onGround;
    const order = ['approach', 'downwind', 'base', 'final', 'vacated'];
    const done = Math.max(-1, ...this.s.blind.map((b) => order.indexOf(b)));
    const want = (id: string, ok: boolean, body: Line) => {
      if (ok && order.indexOf(id) > done) c.push(this.blindCall(st, id, body));
    };
    const rw = runwayLine(rwy.ident);
    want(
      'approach',
      air && distanceNm(ap, sit) < 10,
      join(this.position(sit), this.altitudeNow(sit), phrase(line('for landing'), rw)),
    );
    want(
      'downwind',
      air &&
        y * side > 0.3 &&
        y * side < 2.5 &&
        x > -2.5 &&
        x < 2.5 &&
        Math.abs(angleDiff(hdg, rwy.course + 180)) < 50,
      phrase(line('downwind'), rw),
    );
    want(
      'base',
      air &&
        x > 0.5 &&
        x < 4 &&
        y * side > 0.2 &&
        y * side < 2.5 &&
        Math.abs(angleDiff(hdg, rwy.course - 90 * side)) < 50,
      phrase(line('base'), rw),
    );
    want(
      'final',
      air && x > 0.2 && x < 5 && Math.abs(y) < 0.6 && Math.abs(angleDiff(hdg, rwy.course)) < 30,
      phrase(line('final'), rw),
    );
    want(
      'vacated',
      sit.onGround && this.s.touchedDown && !ap.runways.some((r) => onRunway(r, sit, 10)),
      phrase(rw, line('vacated')),
    );
  }

  // ---------------------------------------------------------------- IFR

  /** At the stand: the IFR clearance from delivery, then start-up and taxi from ground. */
  private ifrGroundCalls(sit: AtcSituation, c: Call[]) {
    const s = this.s;
    const dep = this.dep;
    const ifr = this.ifr();
    const info = this.atisInfo(dep);
    if (!ifr.cleared) {
      const d = this.delivery(dep);
      const b = join(
        this.type(),
        info,
        line(
          this.local ? 'request local IFR clearance' : `request IFR clearance to ${this.arr.name}`,
        ),
      );
      c.push({
        id: 'clearance',
        station: d,
        body: b,
        run: () => this.ifrClearance(d, this.request(d, b), info !== null),
      });
      return;
    }
    const g = this.ground(dep);
    if (s.stage === 'parked' && !sit.engineRunning) {
      // Only the airliner is pushed back from its stand; the others taxi out.
      const pushback = this.info.category === 'airliner';
      const b = join(info, line(pushback ? 'request start-up and push-back' : 'request start-up'));
      c.push({
        id: 'startup',
        station: g,
        body: b,
        run: () => {
          const wait = this.request(g, b);
          s.stage = 'startedUp';
          s.inCharge = g.id;
          const ok = line(pushback ? 'start-up and push-back approved' : 'start-up approved');
          const q = this.weather.qnh;
          this.atc(g, join(ok, qnhLine(q)), {
            after: wait + this.pause(),
            events: [this.qnhEvent(dep)],
            readback: {
              correct: join(ok, qnhLine(q)),
              wrong: join(ok, qnhLine(wrongQnh(q))),
              correction: qnhLine(q),
              repeat: join(ok, qnhLine(q)),
              soft: false,
            },
          });
        },
      });
    } else if (sit.engineRunning) {
      const b = line('request taxi');
      c.push({
        id: 'taxi',
        station: g,
        body: b,
        run: () => this.taxi(g, true, this.request(g, b)),
      });
    }
  }

  /** 'Cleared to Bern, runway 14, after departure runway heading, climb ..., squawk ...'. */
  private ifrClearanceLines(rwy: AtcRunway) {
    const s = this.s;
    const ifr = this.ifr();
    const code =
      1000 + ((s.seq * 3 + 2) % 7) * 100 + ((s.seq * 5 + 1) % 8) * 10 + ((s.seq * 7 + 3) % 8);
    s.squawk = code;
    const wrongCode =
      1000 +
      (code % 10) * 100 +
      Math.floor((code % 100) / 10) * 10 +
      Math.floor((code % 1000) / 100);
    const to = line(this.local ? 'cleared local IFR flight' : `cleared to ${this.arr.name}`);
    const climb = phrase(line('climb to'), this.lvl(ifr.initialFt));
    const rw = runwayLine(rwy.ident);
    const sid = line('after departure runway heading');
    return {
      code,
      atc: join(to, rw, sid, climb, squawkLine(code)),
      correct: join(to, rw, line('runway heading'), climb, squawkLine(code)),
      wrong: join(
        to,
        rw,
        line('runway heading'),
        climb,
        squawkLine(wrongCode === code ? code + 1 : wrongCode),
      ),
      correction: squawkLine(code),
      events: [
        { type: 'squawk', code } as AtcEvent,
        {
          type: 'instruction',
          instruction: { kind: 'altitude', feet: ifr.initialFt, mode: 'climb' },
        } as AtcEvent,
        {
          type: 'instruction',
          instruction: { kind: 'heading', degrees: this.magnetic(rwy.course, 1), turn: 'fly' },
        } as AtcEvent,
      ],
    };
  }

  private magnetic(trueDeg: number, step = 10) {
    return norm360(Math.round((trueDeg - this.decl) / step) * step) || 360;
  }

  private ifrClearance(d: AtcStation, wait: number, reported: boolean) {
    const s = this.s;
    const rwy = this.inUse(this.dep);
    s.depRunway = rwy.ident;
    s.inCharge = d.id;
    this.ifr().cleared = true;
    const cl = this.ifrClearanceLines(rwy);
    this.atc(d, join(cl.atc, this.atisReminder(this.dep, reported)), {
      after: wait + this.pause(),
      events: cl.events,
      readback: {
        correct: cl.correct,
        wrong: cl.wrong,
        correction: cl.correction,
        repeat: cl.atc,
        soft: false,
      },
    });
  }

  /** 'passing altitude 2600 ft, climbing to altitude 5000 ft', or the level when there. */
  private climbReport(sit: AtcSituation): Line {
    const a = this.s.assignedAltitude;
    const here = this.levelNow(sit);
    if (a === null) return here;
    const now = this.s.assignedStd ? this.pressureFt(sit) : sit.altitudeFt;
    if (Math.abs(now - a) < 200) return this.lvl(a);
    const verb = now < a ? 'climbing to' : 'descending to';
    return join(phrase(line('passing'), here), phrase(line(verb), this.lvl(a)));
  }

  /** The departure controller: on course for the destination, or round to the ILS. */
  private departureContact(d: AtcStation, sit: AtcSituation, wait: number) {
    const s = this.s;
    const ifr = this.ifr();
    s.inCharge = d.id;
    if (this.local) {
      const a = this.station(this.arr, 'arrival');
      if (a && this.ilsAvailable()) {
        if (a.id === d.id) this.startVectors(sit, wait + this.pause(), true);
        else {
          s.stage = 'ifrArrival';
          ifr.handedToArrival = true;
          this.redirect(d, a, wait, line('identified'));
        }
        return;
      }
      s.stage = 'enroute';
      ifr.handedToArrival = true;
      this.redirect(d, this.tower(this.arr), wait, line('identified'));
      return;
    }
    s.stage = 'ifrClimb';
    const mag = this.magnetic(bearingTo(sit, this.arr));
    s.assignedHeading = mag;
    const diff = angleDiff(mag + this.decl, sit.headingDeg);
    const turn: 'left' | 'right' | 'fly' = diff > 5 ? 'right' : diff < -5 ? 'left' : 'fly';
    const hdg = phrase(line(turn === 'fly' ? 'fly' : `turn ${turn}`), headingLine(mag));
    const wrongHdg = phrase(
      line(turn === 'fly' ? 'fly' : `turn ${turn}`),
      headingLine(norm360(mag + 20) || 360),
    );
    // Departure climbs the flight to FL 100 at most; area control gives the rest.
    const to = Math.min(ifr.cruiseFt, 10_000);
    this.assign(to);
    const climb = phrase(line('climb to'), this.lvl(to));
    this.atc(d, join(line('identified'), hdg, climb), {
      after: wait + this.pause(),
      events: [
        { type: 'instruction', instruction: { kind: 'heading', degrees: mag, turn } },
        { type: 'instruction', instruction: { kind: 'altitude', feet: to, mode: 'climb' } },
      ],
      readback: {
        correct: join(hdg, climb),
        wrong: join(wrongHdg, climb),
        correction: hdg,
        repeat: join(hdg, climb),
        soft: false,
      },
    });
  }

  private radarContact(r: AtcStation, wait: number) {
    const s = this.s;
    const ifr = this.ifr();
    s.stage = 'ifrCruise';
    s.inCharge = r.id;
    s.assignedHeading = null;
    const higher = s.assignedAltitude === null || ifr.cruiseFt > s.assignedAltitude + 50;
    if (higher) this.assign(ifr.cruiseFt);
    const climb = higher
      ? phrase(line(s.assignedAltitude !== null ? 'climb to' : 'maintain'), this.lvl(ifr.cruiseFt))
      : null;
    const direct = line(`proceed direct ${this.arr.name}`);
    const events: AtcEvent[] = [
      { type: 'instruction', instruction: { kind: 'direct', to: this.arr.icao } },
    ];
    if (climb)
      events.push({
        type: 'instruction',
        instruction: { kind: 'altitude', feet: ifr.cruiseFt, mode: 'climb' },
      });
    this.atc(r, join(line('identified'), climb, direct), {
      after: wait + this.pause(),
      events,
      readback: {
        correct: join(climb, direct),
        wrong: climb ? join(phrase(line('climb to'), this.lvl(ifr.cruiseFt + 1000)), direct) : null,
        correction: climb ?? direct,
        repeat: join(climb, direct),
        soft: false,
      },
    });
  }

  /** Feet above the destination's runway to start down from, so as to be at 4000 ft 12 NM out. */
  private descentNm(sit: AtcSituation) {
    const gate = this.ilsAvailable()
      ? interceptAltitude(this.inUse(this.arr), interceptDistance(sit.groundSpeedKt))
      : this.arr.circuitAltitudeFt + 1000;
    // 3 NM per 1000 ft, to the gate about 12 NM out, and a few miles to slow down.
    return (Math.max(0, sit.altitudeFt - gate) / 1000) * 3 + 12 + 5;
  }

  /** The level area control hands the flight down to: well above the intercept altitude. */
  private entryFt() {
    const ifr = this.ifr();
    const gate = this.ilsAvailable()
      ? interceptAltitude(this.inUse(this.arr), interceptDistance(this.isJet ? 210 : 100))
      : this.arr.circuitAltitudeFt + 1000;
    return Math.min(ifr.cruiseFt, Math.ceil((gate + 3000) / 1000) * 1000);
  }

  private descent(r: AtcStation) {
    const ifr = this.ifr();
    ifr.descentGiven = true;
    const to = this.entryFt();
    if (this.s.assignedAltitude !== null && to >= this.s.assignedAltitude - 50) return;
    this.assign(to);
    const q = this.weather.qnh;
    const qn = this.isLevel(to) ? null : qnhLine(q);
    // 250 kt below FL 100 is said to the jets; the others are slower anyway.
    const sp =
      this.isJet && to < 10_000 ? phrase(line('speed'), knots(250), line('or less')) : null;
    const down = phrase(line('descend to'), this.lvl(to));
    const events: AtcEvent[] = [
      { type: 'instruction', instruction: { kind: 'altitude', feet: to, mode: 'descend' } },
    ];
    if (qn) events.push(this.qnhEvent(this.arr));
    if (sp) events.push({ type: 'instruction', instruction: { kind: 'speed', knots: 250 } });
    this.atc(r, join(down, qn, sp), {
      events,
      readback: {
        correct: join(down, qn, sp),
        wrong: qn
          ? join(down, qnhLine(wrongQnh(q)), sp)
          : join(phrase(line('descend to'), this.lvl(to + 1000)), sp),
        correction: qn ? qnhLine(q) : down,
        repeat: join(down, qn, sp),
        soft: false,
      },
    });
  }

  /** Area control lets the flight go: to arrival, to the tower, or out of radar service. */
  private handOver(r: AtcStation) {
    const s = this.s;
    const ifr = this.ifr();
    ifr.handedToArrival = true;
    const a = this.station(this.arr, 'arrival');
    if (a && this.ilsAvailable()) {
      s.stage = 'ifrArrival';
      this.redirect(r, a, 0);
    } else if (this.arr.controlled) {
      s.stage = 'enroute';
      this.redirect(r, this.tower(this.arr), 0);
    } else {
      s.stage = 'enroute';
      s.inCharge = null;
      s.squawk = null;
      this.atc(
        r,
        join(
          line('radar service terminated'),
          line('squawk 7000', 'squawk seven thousand'),
          line('frequency change approved'),
        ),
        { events: [{ type: 'squawk', code: 7000 }] },
      );
    }
  }

  /** Radar identification is done: vectors begin with the next transmission. */
  private startVectors(sit: AtcSituation, after: number, reported: boolean) {
    const s = this.s;
    const rwy = this.inUse(this.arr);
    s.arrRunway = rwy.ident;
    s.inCharge = this.station(this.arr, 'arrival')?.id ?? s.inCharge;
    if (!s.zones.includes(this.arr.icao)) s.zones.push(this.arr.icao);
    s.vectors = planVectors(rwy, sit, sit.time, sit.groundSpeedKt);
    s.stage = 'ilsVectors';
    const lead = this.atisReminder(this.arr, reported);
    if (nearlyEstablished(rwy, sit, sit.headingDeg, s.vectors.interceptNm)) {
      s.vectors.next = s.vectors.points.length;
      this.vector(sit, sit.headingDeg, true, true, after, lead);
    } else {
      const v = nextVector(s.vectors, rwy, sit, sit.headingDeg, sit.groundSpeedKt, sit.time);
      if (v) this.vector(sit, v.headingTrue, v.kind === 'intercept', true, after, lead);
    }
  }

  // ---------------------------------------------------------------- military

  private overhead(t: AtcStation, wait: number, reported: boolean) {
    const s = this.s;
    const ap = this.arr;
    const rwy = this.inUse(ap);
    s.arrRunway = rwy.ident;
    s.inCharge = t.id;
    s.stage = 'arrBreak';
    if (!s.zones.includes(ap.icao)) s.zones.push(ap.icao);
    const q = this.weather.qnh;
    const ini = phrase(line('join initial'), runwayLine(rwy.ident));
    const brk = line(`${rwy.circuit}-hand break`);
    this.atc(
      t,
      join(ini, brk, qnhLine(q), this.atisReminder(ap, reported), line('report initial')),
      {
        after: wait + this.pause(),
        events: [
          this.qnhEvent(ap),
          {
            type: 'instruction',
            instruction: { kind: 'approach', runway: rwy.ident, approach: 'overhead' },
          },
        ],
        readback: {
          correct: join(ini, brk, qnhLine(q), line('wilco')),
          wrong: join(ini, brk, qnhLine(wrongQnh(q)), line('wilco')),
          correction: qnhLine(q),
          repeat: join(ini, brk, qnhLine(q)),
          soft: false,
        },
      },
    );
  }

  private lowApproach(t: AtcStation, wait: number) {
    const s = this.s;
    const rwy = this.arrRwy();
    s.stage = 'arrLowApproach';
    s.inCharge = t.id;
    s.clearance.landing = false;
    const cleared = join(runwayLine(rwy.ident), line('cleared low approach'));
    this.atc(t, join(towerWind(this.weather, this.decl), cleared), {
      after: wait + this.pause(),
      events: [
        {
          type: 'instruction',
          instruction: { kind: 'runway', runway: rwy.ident, clearance: 'lowApproach' },
        },
      ],
      readback: {
        correct: cleared,
        wrong: join(runwayLine(oppositeIdent(rwy.ident)), line('cleared low approach')),
        correction: cleared,
        repeat: cleared,
        soft: false,
      },
    });
  }

  // ---------------------------------------------------------------- controller replies

  private startup(g: AtcStation, reported: boolean, wait: number) {
    const rwy = this.inUse(this.dep);
    this.s.depRunway = rwy.ident;
    this.s.stage = 'startedUp';
    this.s.inCharge = g.id;
    const q = this.weather.qnh;
    this.atc(
      g,
      join(
        line('start-up approved'),
        this.atisReminder(this.dep, reported),
        runwayLine(rwy.ident),
        qnhLine(q),
      ),
      {
        after: wait + this.pause(),
        events: [this.qnhEvent(this.dep)],
        readback: {
          correct: join(line('start-up approved'), runwayLine(rwy.ident), qnhLine(q)),
          wrong: join(line('start-up approved'), runwayLine(rwy.ident), qnhLine(wrongQnh(q))),
          correction: qnhLine(q),
          repeat: join(line('start-up approved'), runwayLine(rwy.ident), qnhLine(q)),
          soft: false,
        },
      },
    );
  }

  private taxi(g: AtcStation, reported: boolean, wait: number) {
    const rwy = this.inUse(this.dep);
    const first = this.s.stage === 'parked';
    this.s.depRunway = rwy.ident;
    this.s.stage = 'taxi';
    this.s.inCharge = g.id;
    this.s.clearance.holdShort = rwy.ident;
    const q = this.weather.qnh;
    const hp = phrase(line('taxi to holding point'), runwayLine(rwy.ident));
    const wrongHp = phrase(line('taxi to holding point'), runwayLine(oppositeIdent(rwy.ident)));
    const qn = first ? qnhLine(q) : null;
    this.atc(g, join(hp, this.atisReminder(this.dep, reported), qn), {
      after: wait + this.pause(),
      events: [
        ...(first ? [this.qnhEvent(this.dep)] : []),
        { type: 'instruction', instruction: { kind: 'holdShort', runway: rwy.ident } },
      ],
      readback: {
        correct: join(hp, qn),
        wrong: join(wrongHp, qn),
        correction: hp,
        repeat: join(hp, qn),
        soft: false,
      },
    });
  }

  private lineUp(t: AtcStation, wait: number) {
    const rwy = this.depRwy();
    this.s.stage = 'lineUp';
    this.s.inCharge = t.id;
    this.s.clearance.holdShort = null;
    this.s.clearance.lineUp = true;
    this.s.lineUpAt = this.s.time + wait + 4;
    const lu = phrase(line('line up'), runwayLine(rwy.ident), line('and wait'));
    this.atc(t, lu, {
      after: wait + this.pause(),
      events: [
        {
          type: 'instruction',
          instruction: { kind: 'runway', runway: rwy.ident, clearance: 'lineUp' },
        },
      ],
      readback: {
        correct: lu,
        wrong: phrase(line('line up'), runwayLine(oppositeIdent(rwy.ident)), line('and wait')),
        correction: lu,
        repeat: lu,
        soft: false,
      },
    });
  }

  /** After departure: a circuit, a reporting point toward the destination, or straight out. */
  private departureRoute(): { atc: Line; readback: Line; point: string | null } {
    const dep = this.dep;
    const rwy = this.depRwy();
    // IFR: the clearance has the departure already.
    if (this.isIfr && dep.controlled) return { atc: line(''), readback: line(''), point: null };
    if (this.local) {
      const side = `${rwy.circuit}-hand circuit`;
      return { atc: join(line(side), line('report downwind')), readback: line(side), point: null };
    }
    const toDest = bearingTo(dep, this.arr);
    let best: { name: string; spoken: string } | null = null;
    let bestDiff = 1e9;
    for (const p of dep.reportingPoints) {
      const d = Math.abs(angleDiff(bearingTo(dep, p), toDest));
      if (d < bestDiff) {
        bestDiff = d;
        best = p;
      }
    }
    if (best)
      return {
        atc: join(line(`leave the control zone via ${best.spoken}`), line(`report ${best.spoken}`)),
        readback: line(`leaving via ${best.spoken}`),
        point: best.name,
      };
    return {
      atc: join(line('after departure straight out'), line('report leaving the control zone')),
      readback: line('straight out'),
      point: null,
    };
  }

  private takeoffClearance(t: AtcStation, wait: number) {
    const rwy = this.depRwy();
    const route = this.departureRoute();
    const s = this.s;
    s.stage = 'takeoff';
    s.inCharge = t.id;
    s.takeoffSent = true;
    s.clearance.takeoff = true;
    s.clearance.holdShort = null;
    s.arrPoint = route.point;
    if (!s.zones.includes(this.dep.icao)) s.zones.push(this.dep.icao);
    const cleared = join(runwayLine(rwy.ident), line('cleared for take-off'));
    const wrong = join(runwayLine(oppositeIdent(rwy.ident)), line('cleared for take-off'));
    const events: AtcEvent[] = [
      {
        type: 'instruction',
        instruction: { kind: 'runway', runway: rwy.ident, clearance: 'takeoff' },
      },
    ];
    // Lined up without an IFR clearance yet: the tower gives it with the take-off.
    let atc = route.atc;
    let rb = route.readback;
    if (this.isIfr && this.dep.controlled && !this.ifr().cleared) {
      this.ifr().cleared = true;
      const cl = this.ifrClearanceLines(rwy);
      atc = cl.atc;
      rb = cl.correct;
      events.unshift(...cl.events);
    }
    this.atc(t, join(atc, towerWind(this.weather, this.decl), cleared), {
      after: wait + this.pause(),
      events,
      readback: {
        correct: join(rb, cleared),
        wrong: join(rb, wrong),
        correction: join(cleared),
        repeat: join(atc, cleared),
        soft: false,
      },
    });
  }

  /** The joining instruction from where the aircraft is: straight-in or downwind. */
  private joinLeg(sit: AtcSituation): { atc: Line; readback: Line; final: boolean } {
    const rwy = this.inUse(this.arr);
    const { x, y } = approachFrame(rwy, sit);
    const rw = runwayLine(rwy.ident);
    const straight =
      x > 1.5 &&
      Math.abs(y) < Math.max(0.7, x * Math.tan((25 * Math.PI) / 180)) &&
      Math.abs(angleDiff(sit.headingDeg, rwy.course)) < 60;
    if (straight) {
      const a = phrase(line('straight-in approach'), rw);
      return { atc: join(a, line('report final')), readback: a, final: true };
    }
    const dw = phrase(line(`join ${rwy.circuit}-hand downwind`), rw);
    return { atc: join(dw, line('report downwind')), readback: dw, final: false };
  }

  /** The tower's answer to the initial call (or to the report over a reporting point). */
  private join(t: AtcStation, sit: AtcSituation, wait: number, initial: boolean, reported = false) {
    const s = this.s;
    const ap = this.arr;
    const rwy = this.inUse(ap);
    s.arrRunway = rwy.ident;
    s.inCharge = t.id;
    if (!s.zones.includes(ap.icao)) s.zones.push(ap.icao);
    const inZone = this.world.controlZone(sit.lon, sit.lat, sit.altitudeFt) === ap.icao;
    const q = this.weather.qnh;
    const qn = initial ? qnhLine(q) : null;
    let nearest: (typeof ap.reportingPoints)[number] | undefined;
    for (const p of ap.reportingPoints)
      if (!nearest || distanceNm(p, sit) < distanceNm(nearest, sit)) nearest = p;
    if (initial && !inZone && nearest && distanceNm(nearest, sit) > 1.5) {
      s.stage = 'arrToPoint';
      s.arrPoint = nearest.name;
      const via = line(`enter the control zone via ${nearest.spoken}`);
      const rw = runwayLine(rwy.ident);
      this.atc(
        t,
        join(via, rw, qn, this.atisReminder(ap, reported), line(`report ${nearest.spoken}`)),
        {
          after: wait + this.pause(),
          events: [this.qnhEvent(ap)],
          readback: {
            correct: join(line(`via ${nearest.spoken}`), rw, qn, line('wilco')),
            wrong: join(
              line(`via ${nearest.spoken}`),
              runwayLine(oppositeIdent(rwy.ident)),
              qn,
              line('wilco'),
            ),
            correction: rw,
            repeat: join(via, rw, qn),
            soft: false,
          },
        },
      );
      return;
    }
    const leg = this.joinLeg(sit);
    s.stage = leg.final ? 'arrFinal' : 'arrDownwind';
    const wrongLeg = line(
      leg.readback.text.replace(rwy.ident, oppositeIdent(rwy.ident)),
      leg.readback.spoken.replace(
        runwayLine(rwy.ident).spoken,
        runwayLine(oppositeIdent(rwy.ident)).spoken,
      ),
    );
    this.atc(t, join(leg.atc, qn, initial ? this.atisReminder(ap, reported) : null), {
      after: wait + this.pause(),
      events: [
        ...(initial ? [this.qnhEvent(ap)] : []),
        {
          type: 'instruction',
          instruction: {
            kind: 'approach',
            runway: rwy.ident,
            approach: leg.final ? 'straightIn' : 'circuit',
          },
        },
      ],
      readback: {
        correct: join(leg.readback, qn, line('wilco')),
        wrong: join(wrongLeg, qn, line('wilco')),
        correction: leg.readback,
        repeat: join(leg.atc, qn),
        soft: false,
      },
    });
  }

  private landingClearance(t: AtcStation, wait: number) {
    const s = this.s;
    const rwy = this.arrRwy();
    s.stage = 'arrLanding';
    s.inCharge = t.id;
    s.clearance.landing = true;
    s.lowOnApproach = false;
    if (!s.zones.includes(this.arr.icao)) s.zones.push(this.arr.icao);
    const cleared = join(runwayLine(rwy.ident), line('cleared to land'));
    const wrong = join(runwayLine(oppositeIdent(rwy.ident)), line('cleared to land'));
    this.atc(t, join(towerWind(this.weather, this.decl), cleared), {
      after: wait + this.pause(),
      events: [
        {
          type: 'instruction',
          instruction: { kind: 'runway', runway: rwy.ident, clearance: 'land' },
        },
      ],
      readback: { correct: cleared, wrong, correction: cleared, repeat: cleared, soft: false },
    });
  }

  private goAround(t: AtcStation, wait: number, noticed: boolean) {
    const s = this.s;
    const rwy = this.arrRwy();
    s.stage = 'arrDownwind';
    s.clearance.landing = false;
    s.lowOnApproach = false;
    const dw = phrase(line(`join ${rwy.circuit}-hand downwind`), runwayLine(rwy.ident));
    this.atc(
      t,
      join(
        line(noticed ? 'I understand you are going around' : 'roger'),
        dw,
        line('report downwind'),
      ),
      {
        after: wait + this.pause(),
        events: [
          {
            type: 'instruction',
            instruction: { kind: 'approach', runway: rwy.ident, approach: 'circuit' },
          },
        ],
        readback: {
          correct: join(dw, line('wilco')),
          wrong: null,
          correction: dw,
          repeat: dw,
          soft: false,
        },
      },
    );
  }

  private ilsRequest(a: AtcStation, rwy: AtcRunway, wait: number, reported: boolean) {
    const s = this.s;
    s.arrRunway = rwy.ident;
    s.stage = 'ilsSquawk';
    s.inCharge = a.id;
    const code = 4600 + ((s.seq * 3 + 2) % 8) * 10 + ((s.seq * 5 + 1) % 8);
    s.squawk = code;
    s.squawkAt = s.time + wait + 10;
    const wrongCode = 4600 + (code % 10) * 10 + Math.floor((code % 100) / 10);
    this.atc(a, join(squawkLine(code), this.atisReminder(this.arr, reported)), {
      after: wait + this.pause(),
      events: [{ type: 'squawk', code }],
      readback: {
        correct: squawkLine(code),
        wrong: squawkLine(wrongCode === code ? code + 1 : wrongCode),
        correction: squawkLine(code),
        repeat: squawkLine(code),
        soft: false,
      },
    });
  }

  private established(sit: AtcSituation, rwy: AtcRunway) {
    const { x, y } = approachFrame(rwy, sit);
    const out = this.s.vectors?.interceptNm ?? INTERCEPT_NM;
    return (
      !sit.onGround &&
      x > 2 &&
      x < out + 7 &&
      Math.abs(y) < 0.25 &&
      Math.abs(angleDiff(sit.trackDeg, rwy.course)) < 15
    );
  }

  private handoff(a: AtcStation, wait: number) {
    const s = this.s;
    s.stage = 'ilsHandoff';
    s.assignedAltitude = null;
    s.assignedHeading = null;
    this.redirect(a, this.tower(this.arr), wait);
  }

  /** A heading (and on the first vector the altitude and QNH) as one instruction. */
  private vector(
    sit: AtcSituation,
    headingTrue: number,
    intercept: boolean,
    first: boolean,
    after?: number,
    extra?: Line | null,
  ) {
    const s = this.s;
    const a = this.station(this.arr, 'arrival')!;
    const rwy = this.arrRwy();
    const plan = s.vectors!;
    const step = intercept ? 5 : 10;
    const mag = norm360(Math.round((headingTrue - this.decl) / step) * step) || 360;
    plan.lastHeading = mag + this.decl;
    plan.lastAt = sit.time;
    plan.issuedFor = plan.next;
    s.assignedHeading = mag;
    const diff = angleDiff(mag + this.decl, sit.headingDeg);
    const turn: 'left' | 'right' | 'fly' = diff > 5 ? 'right' : diff < -5 ? 'left' : 'fly';
    const hdg = phrase(line(turn === 'fly' ? 'fly' : `turn ${turn}`), headingLine(mag));
    const wrongMag = norm360(mag + (turn === 'left' ? -20 : 20)) || 360;
    const wrongHdg = phrase(line(turn === 'fly' ? 'fly' : `turn ${turn}`), headingLine(wrongMag));
    const events: AtcEvent[] = [
      { type: 'instruction', instruction: { kind: 'heading', degrees: mag, turn } },
    ];
    let alt: Line | null = null;
    let lead: Line | null = null;
    let qn: Line | null = null;
    if (first) {
      const target = plan.altitudeFt;
      const mode =
        sit.altitudeFt > target + 200
          ? 'descend'
          : sit.altitudeFt < target - 200
            ? 'climb'
            : 'maintain';
      const al = altitudeLine(target);
      alt = mode === 'maintain' ? phrase(line('maintain'), al) : phrase(line(`${mode} to`), al);
      s.assignedAltitude = target;
      s.assignedStd = false;
      s.altitudeReached = mode === 'maintain';
      s.altitudeWarned = false;
      qn = qnhLine(this.weather.qnh);
      lead = join(
        line('identified'),
        this.position(sit),
        extra,
        qn,
        phrase(line('vectors for ILS approach'), runwayLine(rwy.ident)),
      );
      events.push(
        { type: 'instruction', instruction: { kind: 'altitude', feet: target, mode } },
        this.qnhEvent(this.arr),
      );
    }
    let clr: Line | null = null;
    if (intercept) {
      const d = miles(fromTouchdown(rwy, sit));
      lead = join(lead, line(`${d.text} from touchdown`, `${d.spoken} from touchdown`));
      clr = phrase(line('cleared ILS approach'), runwayLine(rwy.ident));
      events.push({
        type: 'instruction',
        instruction: { kind: 'approach', runway: rwy.ident, approach: 'ils' },
      });
      s.stage = 'ilsCleared';
    }
    const body = join(lead, hdg, alt, clr, intercept ? line('report established') : null);
    const wrongClr = intercept
      ? phrase(line('cleared ILS approach'), runwayLine(oppositeIdent(rwy.ident)))
      : null;
    this.atc(a, body, {
      events,
      ...(after !== undefined ? { after } : {}),
      readback: {
        correct: join(hdg, alt, qn, clr),
        wrong: intercept ? join(hdg, alt, qn, wrongClr) : join(wrongHdg, alt, qn),
        correction: intercept ? join(hdg, clr) : hdg,
        repeat: join(hdg, alt, clr),
        soft: false,
      },
    });
  }

  // ---------------------------------------------------------------- watching the flight

  private deviation(kind: DeviationKind, st: AtcStation | undefined, body: Line) {
    this.out.push({ type: 'deviation', kind });
    if (st) this.atc(st, body, { after: 1 });
  }

  private monitor(sit: AtcSituation) {
    const s = this.s;
    const dep = this.dep;
    const arr = this.arr;
    // Taking off without clearance.
    if (
      dep.controlled &&
      !s.clearance.takeoff &&
      !s.takeoffWarned &&
      s.airborne &&
      distanceNm(dep, sit) < 3 &&
      ['parked', 'startedUp', 'taxi', 'onRunway', 'lineUp'].includes(s.stage)
    ) {
      s.takeoffWarned = true;
      s.clearance.takeoff = true;
      if (!s.zones.includes(dep.icao)) s.zones.push(dep.icao);
      const route = this.departureRoute();
      s.arrPoint = route.point;
      s.stage = this.local ? 'arrDownwind' : 'departing';
      s.arrRunway = this.local ? s.depRunway : s.arrRunway;
      s.inCharge = this.tower(dep).id;
      this.deviation(
        'takeoffWithoutClearance',
        this.tower(dep),
        join(line('you are airborne without take-off clearance'), route.atc),
      );
    }
    // Entering the runway when told to hold short.
    if (s.clearance.holdShort && sit.onGround && !s.holdShortWarned) {
      const r = this.runway(dep, s.clearance.holdShort);
      if (onRunway(r, sit, 0)) {
        s.holdShortWarned = true;
        this.deviation(
          'holdShort',
          this.byId(s.inCharge ?? '') ?? this.ground(dep),
          join(
            line('stop immediately'),
            phrase(line('you were instructed to hold short of'), runwayLine(r.ident)),
          ),
        );
      }
    }
    // Landing without clearance.
    const arrivalStages = [
      'enroute',
      'arrToPoint',
      'arrDownwind',
      'arrFinal',
      'arrLanding',
      'ilsSquawk',
      'ilsVectors',
      'ilsCleared',
      'ilsHandoff',
      'uncArrival',
      'arrBreak',
      'arrLowApproach',
      'ifrCruise',
      'ifrArrival',
    ];
    if (s.airborne && sit.onGround && distanceNm(arr, sit) < 2 && arrivalStages.includes(s.stage)) {
      s.airborne = false;
      s.touchedDown = true;
      s.arrRunway = s.arrRunway ?? this.inUse(arr).ident;
      if (arr.controlled && !s.clearance.landing && !s.landingWarned) {
        s.landingWarned = true;
        this.deviation(
          'landingWithoutClearance',
          this.tower(arr),
          join(
            line('you landed without landing clearance'),
            line('vacate the runway and report on the ground'),
          ),
        );
      }
      s.stage = arr.controlled ? 'landed' : 'uncArrival';
      s.clearance.landing = false;
    }
    // The control zone. An IFR flight under control is cleared through any zone it crosses.
    const underIfr = this.isIfr && s.stage !== 'enroute';
    const z =
      sit.onGround || underIfr
        ? undefined
        : this.world.controlZone(sit.lon, sit.lat, sit.altitudeFt);
    for (const k of Object.keys(s.zoneSince)) if (k !== z) delete s.zoneSince[k];
    if (z && !s.zones.includes(z) && !s.zoneWarned.includes(z)) {
      s.zoneSince[z] ??= sit.time;
      if (sit.time - s.zoneSince[z]! > ZONE_GRACE_S) {
        s.zoneWarned.push(z);
        const ap = this.world.airport(z);
        const tw = ap && this.station(ap, 'tower');
        const tuned = this.tuned(sit);
        const zoneName = ap ? `the ${ap.name} control zone` : 'the control zone';
        if (tuned && tuned.role === 'information')
          this.deviation(
            'controlZone',
            tuned,
            join(
              line(`you are inside ${zoneName} without clearance`),
              tw
                ? phrase(
                    line('contact'),
                    line(tw.name, tw.spoken),
                    frequencyLine(tw.frequency),
                    line('immediately'),
                  )
                : null,
            ),
          );
        else
          this.deviation(
            'controlZone',
            tw,
            join(
              line(`you have entered ${zoneName} without clearance`),
              line('report your position and intentions'),
            ),
          );
      }
    }
    // Out in the open the clearances of earlier zones lapse: coming back needs a new call.
    if (s.stage === 'enroute' && !z) s.zones = [];
    // The cleared altitude.
    if (s.assignedAltitude !== null) {
      const now = s.assignedStd ? this.pressureFt(sit) : sit.altitudeFt;
      const d = Math.abs(now - s.assignedAltitude);
      if (d < 200) {
        s.altitudeReached = true;
        s.altitudeWarned = false;
      } else if (s.altitudeReached && d > 300 && !s.altitudeWarned) {
        s.altitudeWarned = true;
        const al = s.assignedStd ? this.lvl(s.assignedAltitude) : altitudeLine(s.assignedAltitude);
        this.deviation(
          'altitude',
          this.byId(s.inCharge ?? ''),
          join(
            line('check altitude'),
            phrase(line('cleared'), al),
            s.assignedStd ? null : qnhLine(this.weather.qnh),
          ),
        );
      }
    }
  }

  /** What the controller does by itself as the flight goes on. */
  private advance(sit: AtcSituation) {
    const s = this.s;
    const busy = s.queue.length > 0 || (s.readback !== null && !s.readback.soft);
    switch (s.stage) {
      case 'lineUp': {
        if (busy) break;
        const rwy = this.depRwy();
        const lined =
          onRunway(rwy, sit) &&
          Math.abs(angleDiff(sit.headingDeg, rwy.course)) < 25 &&
          sit.groundSpeedKt < 15;
        if (lined || sit.time - s.lineUpAt > 30) this.takeoffClearance(this.tower(this.dep), 0);
        break;
      }
      case 'takeoff':
        if (s.airborne && this.isIfr && this.dep.controlled) {
          s.stage = 'ifrDeparture';
          s.clearance.takeoff = false;
          const ifr = this.ifr();
          if (s.assignedAltitude === null) this.assign(ifr.initialFt);
          ifr.departureId = (this.departureStation(this.dep) ?? this.radar(sit)).id;
        } else if (s.airborne) {
          if (this.local) {
            s.stage = 'arrDownwind';
            s.arrRunway = s.depRunway;
          } else s.stage = 'departing';
          s.clearance.takeoff = false;
        }
        break;
      case 'departing': {
        const z = this.world.controlZone(sit.lon, sit.lat, sit.altitudeFt);
        if (z !== this.dep.icao && distanceNm(this.dep, sit) > 10) {
          s.stage = 'enroute';
          s.inCharge = null;
        }
        break;
      }
      case 'uncDeparture':
        if (s.airborne && distanceNm(this.dep, sit) > 2) s.stage = 'enroute';
        break;
      case 'ifrDeparture': {
        const ifr = this.ifr();
        if (busy || ifr.handedToDeparture || this.height(sit, this.dep) < 800) break;
        ifr.handedToDeparture = true;
        const d = this.byId(ifr.departureId ?? '') ?? this.departureStation(this.dep);
        const to = d ?? this.radar(sit);
        ifr.departureId = to.id;
        this.redirect(this.tower(this.dep), to, 0);
        break;
      }
      case 'ifrClimb': {
        const ifr = this.ifr();
        if (busy || ifr.handedToRadar) break;
        const d = this.byId(ifr.departureId ?? '');
        if (!d) break;
        if (distanceNm(this.dep, sit) > 15 || this.pressureFt(sit) > 9000) {
          ifr.handedToRadar = true;
          const r = this.radar(sit);
          if (r.id === d.id) this.radarContact(r, 0);
          else this.redirect(d, r, 0);
        }
        break;
      }
      case 'ifrCruise': {
        const ifr = this.ifr();
        if (busy) break;
        const r = this.radar(sit);
        const d = distanceNm(this.arr, sit);
        if (!ifr.descentGiven && d <= this.descentNm(sit)) this.descent(r);
        else if (ifr.descentGiven && !ifr.handedToArrival && d <= 35) this.handOver(r);
        break;
      }
      case 'arrLowApproach': {
        const rwy = this.arrRwy();
        const h = this.height(sit, this.arr);
        if (busy || sit.onGround || approachFrame(rwy, sit).x > -0.2 || h < 300) break;
        if (sit.verticalSpeedFpm < 300) break;
        s.stage = 'arrDownwind';
        const dw = phrase(line(`join ${rwy.circuit}-hand downwind`), runwayLine(rwy.ident));
        this.atc(this.tower(this.arr), join(dw, line('report downwind')), {
          events: [
            {
              type: 'instruction',
              instruction: { kind: 'approach', runway: rwy.ident, approach: 'circuit' },
            },
          ],
          readback: {
            correct: join(dw, line('wilco')),
            wrong: null,
            correction: dw,
            repeat: dw,
            soft: false,
          },
        });
        break;
      }
      case 'enroute':
        if (!this.arr.controlled && distanceNm(this.arr, sit) < 10 && !sit.onGround) {
          s.stage = 'uncArrival';
          s.arrRunway = this.inUse(this.arr).ident;
        }
        break;
      case 'uncArrival':
        if (s.blind.includes('vacated')) s.stage = 'done';
        break;
      case 'arrLanding': {
        const h = this.height(sit, this.arr);
        if (h < 300 && !sit.onGround) s.lowOnApproach = true;
        if (s.lowOnApproach && !sit.onGround && sit.verticalSpeedFpm > 300 && h > 500 && !busy)
          this.goAround(this.tower(this.arr), 0, true);
        break;
      }
      case 'ilsSquawk': {
        if (busy) break;
        const set =
          sit.squawk === s.squawk && (sit.transponder === 'alt' || sit.transponder === 'on');
        const a = this.station(this.arr, 'arrival')!;
        if (set) {
          const rwy = this.arrRwy();
          s.vectors = planVectors(rwy, sit, sit.time, sit.groundSpeedKt);
          if (!s.zones.includes(this.arr.icao)) s.zones.push(this.arr.icao);
          s.stage = 'ilsVectors';
          if (nearlyEstablished(rwy, sit, sit.headingDeg, s.vectors.interceptNm)) {
            s.vectors.next = s.vectors.points.length;
            this.vector(sit, sit.headingDeg, true, true);
          } else {
            const v = nextVector(s.vectors, rwy, sit, sit.headingDeg, sit.groundSpeedKt, sit.time);
            if (v) this.vector(sit, v.headingTrue, v.kind === 'intercept', true);
          }
        } else if (!s.squawkReminded && sit.time - s.squawkAt > 30) {
          s.squawkReminded = true;
          this.atc(a, phrase(line('check'), squawkLine(s.squawk ?? 7000)), { after: 0.5 });
        }
        break;
      }
      case 'ilsVectors': {
        if (busy || !s.vectors) break;
        const v = nextVector(
          s.vectors,
          this.arrRwy(),
          sit,
          sit.headingDeg,
          sit.groundSpeedKt,
          sit.time,
        );
        if (v) this.vector(sit, v.headingTrue, v.kind === 'intercept', false);
        break;
      }
      case 'ilsCleared': {
        const rwy = this.arrRwy();
        if (!busy && this.established(sit, rwy)) {
          s.assignedAltitude = null;
          // The tower gets the flight some miles inside the intercept: further out for a jet.
          const out = s.vectors ? INTERCEPT_NM * planScale(s.vectors) : INTERCEPT_NM;
          if (approachFrame(rwy, sit).x < out - 3)
            this.handoff(this.station(this.arr, 'arrival')!, 0);
        }
        break;
      }
      case 'landed': {
        if (busy || sit.groundSpeedKt > 30) break;
        const t = this.tower(this.arr);
        const g = this.ground(this.arr);
        s.stage = 'vacating';
        if (g.id !== t.id) this.redirect(t, g, 0, line('vacate when able'));
        else {
          s.inCharge = t.id;
          this.atc(t, join(line('vacate when able'), line('report runway vacated')));
        }
        break;
      }
      default:
        break;
    }
  }
}

function wrongQnh(q: number) {
  const r = Math.round(q);
  return r === 1013 ? 1018 : r > 1013 ? r - 5 : r + 5;
}

function oppositeIdent(ident: string): string {
  const m = /^(\d{1,2})([LRC]?)$/.exec(ident);
  if (!m) return ident;
  const n = ((Number(m[1]) + 17) % 36) + 1;
  const side = { L: 'R', R: 'L', C: 'C', '': '' }[m[2] as 'L' | 'R' | 'C' | ''];
  return String(n).padStart(2, '0') + side;
}

function weatherKey(w: AtcWeather) {
  return [
    Math.round(w.windFromDeg / 30),
    Math.round(w.windKt / 5),
    Math.round(w.qnh),
    w.clouds.length,
  ].join('/');
}
