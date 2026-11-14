/**
 * Air traffic control: scripted flights as sequences of situations, with the phraseology
 * pinned so a later edit cannot change it unnoticed.
 */
import { describe, expect, it } from 'vitest';
import { offsetPoint } from '../src/geo';
import { WEATHER_PRESETS } from '../src/sky';
import {
  AtcController,
  type AtcConfig,
  type AtcEvent,
  type AtcRunway,
  type AtcSituation,
  type AtcWeather,
  BUILTIN_ATC_WORLD,
  atcConfigFromPlan,
  atcWeatherFromSky,
  runwayInUse,
} from '../src/app/procedures';
import {
  angleDiff,
  approachFrame,
  fromApproachFrame,
  fromLocalNm,
  localNm,
} from '../src/app/procedures/geometry';
import {
  altitude,
  callsign,
  feet,
  frequency,
  heading,
  miles,
  qnh,
  squawk,
  wind,
} from '../src/app/procedures/phraseology';
import { atisMessage } from '../src/app/procedures/weather';
import { INTERCEPT_NM, interceptAltitude } from '../src/app/procedures/vectors';

// ---------------------------------------------------------------- a scripted pilot

const WEATHER: AtcWeather = {
  windFromDeg: 160,
  windKt: 8,
  visibilityM: 30_000,
  clouds: [{ cover: 'FEW', baseFt: 6500 }],
  temperatureC: 20,
  precipitation: 'none',
  qnh: 1018,
};

function runwayOf(icao: string, ident: string): AtcRunway {
  const r = BUILTIN_ATC_WORLD.airport(icao)!.runways.find((x) => x.ident === ident);
  if (!r) throw new Error(`${icao} ${ident}`);
  return r;
}

/** A point in the frame of an approach (NM out, NM right of the final course). */
const onApproach = (rwy: AtcRunway, x: number, y: number) => fromApproachFrame(rwy, x, y);

/** The holding point: short of the runway start, off to the side. */
function holdingPoint(rwy: AtcRunway) {
  const back = offsetPoint(rwy.start, rwy.course + 180, 60);
  return offsetPoint(back, rwy.course - 90, 45);
}

/** Lined up on the runway, 40 m in. */
const linedUp = (rwy: AtcRunway) => offsetPoint(rwy.start, rwy.course, 40);

/** On the apron: beside the middle of the runway, well clear of it. */
function apron(rwy: AtcRunway) {
  const mid = offsetPoint(rwy.start, rwy.course, rwy.length / 2);
  return offsetPoint(mid, rwy.course + 90, 250);
}

class Pilot {
  atc: AtcController;
  s: AtcSituation;
  events: AtcEvent[] = [];

  constructor(
    readonly config: AtcConfig,
    start: Partial<AtcSituation>,
  ) {
    this.atc = new AtcController(config);
    this.s = {
      time: 0,
      lon: 0,
      lat: 0,
      altitudeFt: 1700,
      heightFt: 0,
      headingDeg: 0,
      trackDeg: 0,
      groundSpeedKt: 0,
      verticalSpeedFpm: 0,
      onGround: true,
      engineRunning: false,
      com1: 121_500,
      com1Works: true,
      squawk: 7000,
      transponder: 'alt',
      ...start,
    };
    if (start.headingDeg !== undefined && start.trackDeg === undefined)
      this.s.trackDeg = start.headingDeg;
    this.events.push(...this.atc.update(this.s));
  }

  /** Changes the situation and lets the controller see it at once. */
  set(p: Partial<AtcSituation>) {
    Object.assign(this.s, p);
    if (p.headingDeg !== undefined && p.trackDeg === undefined) this.s.trackDeg = p.headingDeg;
    this.events.push(...this.atc.update(this.s));
    return this;
  }

  run(seconds: number, step = 0.5) {
    for (let t = 0; t < seconds - 1e-9; t += step) {
      this.s.time += step;
      this.events.push(...this.atc.update(this.s));
    }
    return this;
  }

  options() {
    return this.atc.view().options;
  }

  /** Says the option with this id (or the first whose text matches), returns its text. */
  say(which: string | RegExp): string {
    const opts = this.options();
    const o = opts.find((x) => (typeof which === 'string' ? x.id === which : which.test(x.text)));
    if (!o)
      throw new Error(
        `No option ${String(which)} in ${JSON.stringify(opts)} (stage ${this.atc.stage})`,
      );
    this.events.push(...this.atc.reply(o.id));
    return o.text;
  }

  /** Waits for the controller's next transmission and returns its text. */
  listen(maxSeconds = 20): string {
    const n = this.messages('atc').length;
    for (let t = 0; t < maxSeconds; t += 0.5) {
      this.run(0.5);
      const m = this.messages('atc');
      if (m.length > n) return m[m.length - 1]!.message.text;
    }
    throw new Error(`Nothing heard (stage ${this.atc.stage})`);
  }

  messages(from?: 'atc' | 'pilot') {
    return this.events.filter(
      (e): e is Extract<AtcEvent, { type: 'message' }> =>
        e.type === 'message' && (!from || e.message.from === from),
    );
  }

  deviations() {
    return this.events.flatMap((e) => (e.type === 'deviation' ? [e.kind] : []));
  }
}

const BERN = BUILTIN_ATC_WORLD.airport('LSZB')!;
const ZURICH = BUILTIN_ATC_WORLD.airport('LSZH')!;
const LANGENTHAL = BUILTIN_ATC_WORLD.airport('LSPL')!;
const R14 = runwayOf('LSZB', '14');
const local: AtcConfig = { callsign: 'HB-TFS', departure: { airport: 'LSZB' }, weather: WEATHER };
const toBern: AtcConfig = {
  callsign: 'HB-TFS',
  departure: { airport: 'LSPL' },
  destination: { airport: 'LSZB' },
  weather: WEATHER,
};
const texts = (p: Pilot) => p.messages().map((m) => `${m.message.from}: ${m.message.text}`);
const atApron = () => new Pilot(local, { ...apron(R14), headingDeg: 50 });
const inbound = (com1: number) =>
  new Pilot(toBern, {
    ...fromLocalNm(BERN, 0, 10),
    onGround: false,
    heightFt: 2000,
    altitudeFt: 4000,
    headingDeg: 180,
    engineRunning: true,
    com1,
  });

// ---------------------------------------------------------------- tests

describe('phraseology', () => {
  it('speaks numbers the ICAO way', () => {
    expect(frequency(121_025)).toEqual({
      text: '121.025',
      spoken: 'one two one decimal zero two five',
    });
    expect(frequency(118_100).spoken).toBe('one one eight decimal one');
    expect(frequency(124_700).spoken).toBe('one two four decimal seven');
    expect(qnh(1018)).toEqual({ text: 'QNH 1018', spoken: 'QNH one zero one eight' });
    expect(feet(4500).spoken).toBe('four thousand five hundred feet');
    expect(altitude(3500)).toEqual({
      text: 'altitude 3500 ft',
      spoken: 'altitude three thousand five hundred feet',
    });
    expect(feet(12_000).spoken).toBe('one two thousand feet');
    expect(heading(80)).toEqual({ text: 'heading 080', spoken: 'heading zero eight zero' });
    expect(heading(360).text).toBe('heading 360');
    expect(heading(90).spoken).toBe('heading zero niner zero');
    expect(squawk(4621).spoken).toBe('squawk four six two one');
    expect(miles(12).spoken).toBe('one two miles');
    expect(wind(250, 5)).toEqual({
      text: 'wind 250 degrees 5 knots',
      spoken: 'wind two five zero degrees five knots',
    });
    expect(wind(0, 0.4).text).toBe('wind calm');
    expect(wind(93, 19, 31).text).toBe('wind 090 degrees 19 knots maximum 31 knots');
  });

  it('abbreviates a Swiss registration to its first and last two letters', () => {
    expect(callsign('HB-TFS', false)).toEqual({
      text: 'HB-TFS',
      spoken: 'Hotel Bravo Tango Foxtrot Sierra',
    });
    expect(callsign('HB-TFS', true)).toEqual({ text: 'HFS', spoken: 'Hotel Foxtrot Sierra' });
  });
});

describe('weather and runway', () => {
  it('broadcasts the ATIS with its letter', () => {
    expect(atisMessage(BERN, WEATHER, 3, '14', 3)).toEqual({
      text:
        'Bern information Delta. Runway in use 14. Wind 160 degrees 8 knots. Visibility 10 km or more. ' +
        'Few 4800 ft. Temperature 17, dew point 5. QNH 1018. Advise on initial contact you have information Delta.',
      spoken:
        'Bern information Delta. Runway in use one four. Wind one six zero degrees eight knots. ' +
        'Visibility one zero kilometres or more. Few four thousand eight hundred feet. Temperature one seven, ' +
        'dew point five. QNH one zero one eight. Advise on initial contact you have information Delta.',
    });
    const cavok = { ...WEATHER, clouds: [] };
    expect(atisMessage(BERN, cavok, 0, '32', 3).text).toContain('Wind 160 degrees 8 knots. CAVOK.');
  });

  it('puts the runway in use into the wind', () => {
    const w = (windFromDeg: number, windKt: number) => ({ ...WEATHER, windFromDeg, windKt });
    expect(runwayInUse(BERN, w(320, 12)).ident).toBe('32');
    expect(runwayInUse(BERN, w(140, 12)).ident).toBe('14');
    // Calm or a light tailwind: the preferred runway stays in use.
    expect(runwayInUse(BERN, w(0, 0)).ident).toBe('14');
    expect(runwayInUse(BERN, w(320, 4)).ident).toBe('14');
    expect(runwayInUse(BERN, w(320, 4), '32').ident).toBe('32');
    expect(runwayInUse(ZURICH, w(270, 15)).ident).toBe('28');
  });

  it('moves the ATIS letter on when the weather changes', () => {
    const p = atApron();
    p.set({ com1: 125_125 });
    p.atc.setWeather({ ...WEATHER, windFromDeg: 320, windKt: 14 });
    p.set({ com1: 121_700 }).set({ com1: 125_125 });
    const last = texts(p).at(-1)!;
    expect(last).toContain('Bern information Echo. Runway in use 32. Wind 320 degrees 14 knots.');
  });

  it("reads the sky package's weather", () => {
    const w = atcWeatherFromSky(WEATHER_PRESETS.fair, 1021);
    expect(w.qnh).toBe(1021);
    expect(w.clouds.length).toBe(1);
    expect(w.windKt).toBeCloseTo(WEATHER_PRESETS.fair.windSpeed * 1.943844, 5);
    const fog = atcWeatherFromSky(WEATHER_PRESETS.lowStratus);
    expect(fog.clouds[0]!.cover).toBe('OVC');
    expect(fog.lowVisibility).toBeDefined();
  });

  it("builds its configuration from the menu's flight plan", () => {
    const cfg = atcConfigFromPlan(
      {
        aircraft: 'c172',
        start: { kind: 'runway', airport: 'LSZB', runway: '14' },
        time: 12,
        weather: 'fair',
        destination: { airport: 'LSPL' },
      },
      WEATHER,
    );
    expect(cfg).toMatchObject({
      callsign: 'HB-TFS',
      departure: { airport: 'LSZB', runway: '14' },
      destination: { airport: 'LSPL' },
    });
  });
});

/** From the apron at Bern round the circuit and back, as a pilot who does it all right. */
function bernCircuit(p: Pilot, upTo: 'done' | 'downwind' | 'cleared' = 'done') {
  p.set({ com1: 125_125 }).run(2);
  p.set({ com1: 121_700 });
  p.say('startup');
  p.listen();
  p.say('readbackWrong');
  p.listen();
  p.say('readback');
  p.set({ engineRunning: true }).run(1);
  p.say('taxi');
  p.listen();
  p.say('readback');
  p.set({ ...holdingPoint(R14), groundSpeedKt: 0 }).run(1);
  p.set({ com1: 121_025 }).run(1);
  p.say('ready');
  p.listen();
  p.say('readback');
  p.set({ ...linedUp(R14), headingDeg: R14.course });
  p.listen(40);
  p.say('readback');
  p.set({ onGround: false, heightFt: 500, altitudeFt: 2200, groundSpeedKt: 70 }).run(5);
  p.set({
    ...onApproach(R14, 0, -1),
    headingDeg: R14.course + 180,
    heightFt: 1000,
    altitudeFt: 2700,
  });
  p.run(1);
  p.say('downwind');
  p.listen();
  p.say('readback');
  if (upTo === 'downwind') return;
  p.set({ ...onApproach(R14, 2, 0), headingDeg: R14.course, heightFt: 600 }).run(1);
  p.say('final');
  p.listen();
  p.say('readback');
  if (upTo === 'cleared') return;
  p.set({ ...onApproach(R14, -0.2, 0), onGround: true, heightFt: 0, groundSpeedKt: 50 }).run(2);
  p.set({ groundSpeedKt: 20 });
  p.listen();
  p.say('readback');
  p.set({ com1: 121_700, ...apron(R14), groundSpeedKt: 10 }).run(1);
  p.say('vacated');
  p.listen();
  p.say('readback');
  p.set({ groundSpeedKt: 0 }).run(1);
  p.say('parked');
  p.listen();
}

describe('a VFR circuit at Bern', () => {
  it('goes from start-up to parking in Swiss phraseology', () => {
    const p = atApron();
    bernCircuit(p);
    expect(texts(p)).toEqual([
      'atc: Bern information Delta. Runway in use 14. Wind 160 degrees 8 knots. Visibility 10 km or more. Few 4800 ft. Temperature 17, dew point 5. QNH 1018. Advise on initial contact you have information Delta.',
      'pilot: Bern Ground, HB-TFS, Cessna 172, at the apron, local flight, information Delta, request start-up',
      'atc: HB-TFS, Bern Ground, start-up approved, runway 14, QNH 1018',
      'pilot: Start-up approved, runway 14, QNH 1013, HB-TFS',
      'atc: HFS, negative, QNH 1018',
      'pilot: Start-up approved, runway 14, QNH 1018, HFS',
      'pilot: HFS, request taxi',
      'atc: HFS, taxi to holding point runway 14',
      'pilot: Taxi to holding point runway 14, HFS',
      'pilot: Bern Tower, HB-TFS, holding point runway 14, ready for departure',
      'atc: HB-TFS, Bern Tower, line up runway 14 and wait',
      'pilot: Line up runway 14 and wait, HB-TFS',
      'atc: HFS, left-hand circuit, report downwind, wind 160 degrees 8 knots, runway 14, cleared for take-off',
      'pilot: Left-hand circuit, runway 14, cleared for take-off, HFS',
      'pilot: HFS, downwind runway 14',
      'atc: HFS, number one, report final',
      'pilot: Number one, wilco, HFS',
      'pilot: HFS, final runway 14',
      'atc: HFS, wind 160 degrees 8 knots, runway 14, cleared to land',
      'pilot: Runway 14, cleared to land, HFS',
      'atc: HFS, vacate when able, contact Bern Ground 121.700',
      'pilot: Bern Ground 121.700, HFS',
      'pilot: HFS, runway 14 vacated, request taxi to the apron',
      'atc: HFS, taxi to the apron',
      'pilot: Taxi to the apron, HFS',
      'pilot: HFS, parked, goodbye',
      'atc: HFS, goodbye',
    ]);
    expect(p.atc.stage).toBe('done');
    expect(p.deviations()).toEqual([]);
    const instructions = p.events.flatMap((e) => (e.type === 'instruction' ? [e.instruction] : []));
    expect(instructions).toEqual([
      { kind: 'holdShort', runway: '14' },
      { kind: 'runway', runway: '14', clearance: 'lineUp' },
      { kind: 'runway', runway: '14', clearance: 'takeoff' },
      { kind: 'runway', runway: '14', clearance: 'land' },
    ]);
    expect(p.events.filter((e) => e.type === 'qnh')).toEqual([
      { type: 'qnh', hPa: 1018, airport: 'LSZB' },
    ]);
    expect(p.events.filter((e) => e.type === 'frequency')).toEqual([
      { type: 'frequency', khz: 121_700, station: 'Bern Ground' },
    ]);
  });

  it('speaks every message for the synthesiser', () => {
    const p = atApron();
    bernCircuit(p);
    const spoken = p.messages().map((m) => m.spoken);
    expect(spoken[2]).toBe(
      'Hotel Bravo Tango Foxtrot Sierra, Bern Ground, start-up approved, runway one four, QNH one zero one eight',
    );
    expect(spoken[12]).toBe(
      'Hotel Foxtrot Sierra, left-hand circuit, report downwind, wind one six zero degrees eight knots, runway one four, cleared for take-off',
    );
    expect(spoken[20]).toBe(
      'Hotel Foxtrot Sierra, vacate when able, contact Bern Ground one two one decimal seven',
    );
    for (const s of spoken) expect(s).not.toMatch(/\d/);
  });

  it('answers after a pause of a second or two, by the simulated time', () => {
    const p = atApron();
    p.set({ com1: 121_700 });
    p.say('startup');
    const said = p.s.time;
    const words = p.messages('pilot')[0]!.spoken.split(' ').length;
    p.listen();
    const pause = p.messages('atc').at(-1)!.message.time - said - words * 0.33;
    expect(pause).toBeGreaterThanOrEqual(1);
    expect(pause).toBeLessThanOrEqual(2.5);
    expect(p.options().map((o) => o.id)).toEqual(['readback', 'readbackWrong', 'sayAgain']);
  });

  it('handles a go-around, called or only flown', () => {
    const p = atApron();
    bernCircuit(p, 'cleared');
    p.say('goAround');
    expect(p.listen()).toBe('HFS, roger, join left-hand downwind runway 14, report downwind');
    p.say('readback');
    p.set({ ...onApproach(R14, 0, -1), headingDeg: R14.course + 180, heightFt: 1000 }).run(1);
    p.say('downwind');
    p.listen();
    p.say('readback');
    p.set({ ...onApproach(R14, 2, 0), headingDeg: R14.course, heightFt: 600 }).run(1);
    p.say('final');
    p.listen();
    p.say('readback');
    p.set({ ...onApproach(R14, 0.3, 0), heightFt: 150, verticalSpeedFpm: -500 }).run(2);
    p.set({ ...onApproach(R14, -0.5, 0), heightFt: 600, verticalSpeedFpm: 700 });
    expect(p.listen()).toBe(
      'HFS, I understand you are going around, join left-hand downwind runway 14, report downwind',
    );
    expect(p.deviations()).toEqual([]);
  });
});

describe('frequencies and readbacks', () => {
  it('gives no clearance on the wrong frequency', () => {
    const p = atApron();
    p.set({ com1: 121_025 });
    expect(p.options().map((o) => o.text)).toEqual([
      'Bern Tower, HB-TFS, Cessna 172, at the apron, local flight, request start-up',
    ]);
    p.say(/request start-up/);
    expect(p.listen()).toBe('HB-TFS, Bern Tower, contact Bern Ground 121.700');
    p.say('readback');
    expect(p.atc.stage).toBe('parked');
    expect(p.events.some((e) => e.type === 'qnh')).toBe(false);
  });

  it('offers nothing where nobody listens and hints at the right frequency', () => {
    const p = atApron();
    p.set({ com1: 130_000 });
    expect(p.options()).toEqual([]);
    expect(p.atc.view().station).toBeNull();
    // The ATIS first, then Ground.
    expect(p.atc.view().hint).toBe('Bern ATIS 125.125');
    p.set({ com1: 125_125 }).run(1);
    p.set({ com1: 130_000 });
    expect(p.atc.view().hint).toBe('Bern Ground 121.700');
    p.set({ com1: 121_700 });
    expect(p.atc.view().hint).toBeNull();
  });

  it('adds the current information when the pilot has not listened to the ATIS', () => {
    const p = atApron();
    p.set({ com1: 121_700 });
    p.say('startup');
    expect(p.listen()).toBe(
      'HB-TFS, Bern Ground, start-up approved, information Delta is current, runway 14, QNH 1018',
    );
  });

  it('hears nothing and offers nothing with COM 1 dead', () => {
    const p = atApron();
    p.set({ com1: 125_125, com1Works: false }).run(5);
    expect(p.options()).toEqual([]);
    expect(p.atc.view().station).toBeNull();
    expect(p.messages()).toEqual([]);
  });

  it('corrects a wrong readback of the take-off clearance', () => {
    const p = new Pilot(local, {
      ...linedUp(R14),
      headingDeg: R14.course,
      engineRunning: true,
      com1: 121_025,
    });
    p.say('ready');
    p.listen();
    const wrong = p.say('readbackWrong');
    expect(wrong).toBe('Left-hand circuit, runway 32, cleared for take-off, HB-TFS');
    expect(p.listen()).toBe('HFS, negative, runway 14, cleared for take-off');
    expect(p.say('readback')).toBe('Left-hand circuit, runway 14, cleared for take-off, HFS');
  });

  it('says it again when the readback does not come, and on request', () => {
    const p = atApron();
    p.set({ com1: 121_700 });
    p.say('startup');
    p.listen();
    expect(p.listen(30)).toBe('HFS, I say again, start-up approved, runway 14, QNH 1018');
    p.say('sayAgain');
    expect(p.listen()).toBe('HFS, I say again, start-up approved, runway 14, QNH 1018');
    p.say('readback');
    expect(p.options().map((o) => o.id)).toEqual(['sayAgain']);
  });

  it('is deterministic and can be saved and restored mid-flight', () => {
    const a = atApron();
    bernCircuit(a);
    const b = atApron();
    b.set({ com1: 125_125 }).run(2);
    b.set({ com1: 121_700 });
    b.say('startup');
    b.listen();
    // Restore into a new controller and carry on there.
    b.atc = new AtcController(local, JSON.parse(JSON.stringify(b.atc.save())));
    b.set({});
    b.say('readbackWrong');
    b.listen();
    b.say('readback');
    b.set({ engineRunning: true }).run(1);
    b.say('taxi');
    b.listen();
    const tb = texts(b);
    expect(tb.length).toBe(8);
    expect(tb).toEqual(texts(a).slice(0, tb.length));
  });
});

describe('a flight from Bern to Langenthal (uncontrolled)', () => {
  it('leaves the zone via Echo, talks to Information and makes blind calls', () => {
    const p = new Pilot(
      {
        callsign: 'HB-TFS',
        departure: { airport: 'LSZB', runway: '14' },
        destination: { airport: 'LSPL' },
        weather: WEATHER,
      },
      { ...linedUp(R14), headingDeg: R14.course, engineRunning: true, com1: 121_025 },
    );
    p.say('ready');
    p.listen();
    p.say('readback');
    p.set({ onGround: false, heightFt: 800, groundSpeedKt: 80 }).run(5);
    const echo = BERN.reportingPoints.find((x) => x.name === 'E')!;
    p.set({ lon: echo.lon, lat: echo.lat, altitudeFt: 4500 });
    p.say('leaving');
    p.listen();
    p.say('readback');
    p.set({ com1: 124_700 });
    p.say('fis');
    p.listen();
    p.say('fisDetails');
    p.listen();
    p.say('readback');
    p.say('fisLeave');
    p.listen();
    const r23 = runwayOf('LSPL', '23');
    p.set({ ...fromLocalNm(LANGENTHAL, 0, -8), com1: 123_250, headingDeg: 0, altitudeFt: 2600 });
    expect(p.atc.view().station).toBe('Langenthal Traffic');
    p.say('blind.approach');
    p.set({ ...onApproach(r23, 0, -1), headingDeg: r23.course + 180 });
    p.say('blind.downwind');
    p.set({ ...onApproach(r23, 1.5, -0.8), headingDeg: r23.course + 90 });
    p.say('blind.base');
    p.set({ ...onApproach(r23, 1.5, 0), headingDeg: r23.course });
    p.say('blind.final');
    p.set({
      ...onApproach(r23, -0.05, 0),
      onGround: true,
      heightFt: 0,
      groundSpeedKt: 40,
      altitudeFt: 1575,
    }).run(5);
    expect(p.options()).toEqual([]);
    p.set({ ...apron(r23), groundSpeedKt: 5 });
    p.say('blind.vacated');
    p.run(10);
    expect(texts(p)).toEqual([
      'pilot: Bern Tower, HB-TFS, lined up runway 14, ready for departure, VFR to Langenthal',
      'atc: HB-TFS, Bern Tower, leave the control zone via Echo, report Echo, wind 160 degrees 8 knots, runway 14, cleared for take-off',
      'pilot: Leaving via Echo, runway 14, cleared for take-off, HB-TFS',
      'pilot: HB-TFS, Echo, leaving the control zone',
      'atc: HFS, contact Zürich Information 124.700',
      'pilot: Zürich Information 124.700, HFS',
      'pilot: Zürich Information, HB-TFS',
      'atc: HB-TFS, Zürich Information, pass your message',
      'pilot: HB-TFS, Cessna 172, VFR from Bern to Langenthal, 16 NM south of Langenthal, altitude 4500 ft, request flight information service',
      'atc: HFS, roger, QNH 1018, report leaving the frequency',
      'pilot: QNH 1018, wilco, HFS',
      'pilot: HFS, leaving the frequency to Langenthal Traffic',
      'atc: HFS, frequency change approved, goodbye',
      'pilot: Langenthal Traffic, HB-TFS, 8 NM south of Langenthal, altitude 2600 ft, for landing runway 23, Langenthal',
      'pilot: Langenthal Traffic, HB-TFS, downwind runway 23, Langenthal',
      'pilot: Langenthal Traffic, HB-TFS, base runway 23, Langenthal',
      'pilot: Langenthal Traffic, HB-TFS, final runway 23, Langenthal',
      'pilot: Langenthal Traffic, HB-TFS, runway 23 vacated, Langenthal',
    ]);
    expect(p.atc.stage).toBe('done');
    expect(p.deviations()).toEqual([]);
  });

  it('makes blind calls when leaving an uncontrolled field', () => {
    const r23 = runwayOf('LSPL', '23');
    const p = new Pilot(
      {
        callsign: 'HB-TFS',
        departure: { airport: 'LSPL' },
        destination: { airport: 'LSZB' },
        weather: WEATHER,
      },
      { ...apron(r23), engineRunning: true, com1: 123_250, altitudeFt: 1575 },
    );
    p.say('blind.taxi');
    p.set({ ...linedUp(r23), headingDeg: r23.course });
    p.say('blind.lineup');
    expect(texts(p)).toEqual([
      'pilot: Langenthal Traffic, HB-TFS, taxiing to runway 23, Langenthal',
      'pilot: Langenthal Traffic, HB-TFS, lining up runway 23, departing to the south-west, Langenthal',
    ]);
  });
});

/**
 * A point-mass aircraft at 100 knots that does what the controller says: standard-rate turns
 * to the assigned heading, 500 ft/min to the assigned altitude, and once cleared for the ILS
 * it turns onto the localizer when it gets there.
 */
function flyIls(start: { e: number; n: number; heading: number }, onStep?: (p: Pilot) => void) {
  const rwy = runwayOf('LSZH', '14');
  const p = new Pilot(
    {
      callsign: 'HB-TFS',
      departure: { airport: 'LSZB' },
      destination: { airport: 'LSZH' },
      weather: WEATHER,
    },
    {
      ...fromLocalNm(ZURICH, start.e, start.n),
      onGround: false,
      heightFt: 3000,
      altitudeFt: 5000,
      headingDeg: start.heading,
      groundSpeedKt: 100,
      engineRunning: true,
      com1: 118_000,
    },
  );
  p.say('arrivalIls');
  p.listen();
  p.say('readback');
  const code = p.events.flatMap((e) => (e.type === 'squawk' ? [e.code] : []))[0]!;
  p.set({ squawk: code });
  let hdg = p.s.headingDeg;
  let alt = p.s.altitudeFt;
  let target = hdg;
  let targetAlt = alt;
  let cleared = false;
  let interceptHeading = 0;
  let capture: { x: number; altitudeFt: number; angle: number } | null = null;
  let seen = 0;
  for (let i = 0; i < 6000 && p.atc.stage !== 'ilsHandoff'; i++) {
    for (; seen < p.events.length; seen++) {
      const e = p.events[seen]!;
      if (e.type !== 'instruction') continue;
      const ins = e.instruction;
      // Headings are magnetic; the declination in Switzerland is 3 degrees east.
      if (ins.kind === 'heading') target = interceptHeading = ins.degrees + 3;
      if (ins.kind === 'altitude') targetAlt = ins.feet;
      if (ins.kind === 'approach') cleared = true;
    }
    if (p.options().some((o) => o.id === 'readback')) p.say('readback');
    if (p.options().some((o) => o.id === 'established')) p.say('established');
    const f = approachFrame(rwy, p.s);
    if (cleared && Math.abs(f.y) < 0.15) {
      capture ??= {
        x: f.x,
        altitudeFt: alt,
        angle: Math.abs(angleDiff(interceptHeading, rwy.course)),
      };
      target = rwy.course - Math.max(-30, Math.min(30, f.y * 60));
    }
    hdg += Math.max(-1.5, Math.min(1.5, angleDiff(target, hdg)));
    alt += Math.max(-250 / 60, Math.min(250 / 60, targetAlt - alt));
    const l = localNm(ZURICH, p.s);
    const d = (100 / 3600) * 0.5;
    const r = (hdg * Math.PI) / 180;
    p.s.lon = fromLocalNm(ZURICH, l.e + Math.sin(r) * d, l.n + Math.cos(r) * d).lon;
    p.s.lat = fromLocalNm(ZURICH, l.e + Math.sin(r) * d, l.n + Math.cos(r) * d).lat;
    p.s.headingDeg = p.s.trackDeg = hdg;
    p.s.altitudeFt = alt;
    onStep?.(p);
    p.run(0.5);
  }
  return { p, capture, rwy };
}

describe('a vectored ILS approach into Zürich 14', () => {
  const starts = [
    { e: -20, n: 0, heading: 90 },
    { e: 12, n: 10, heading: 225 },
    { e: 5, n: -15, heading: 0 },
    { e: -10, n: 12, heading: 135 },
  ];
  it.each(starts)('leads to an intercept 8 NM out at 30 degrees, from %o', (start) => {
    const { p, capture, rwy } = flyIls(start);
    expect(p.atc.stage).toBe('ilsHandoff');
    expect(capture).not.toBeNull();
    expect(capture!.x).toBeGreaterThan(INTERCEPT_NM - 1.5);
    expect(capture!.x).toBeLessThan(INTERCEPT_NM + 1.5);
    expect(capture!.angle).toBeGreaterThan(25);
    expect(capture!.angle).toBeLessThan(35);
    // Below the glide slope: it is captured from below.
    const glideSlopeFt = rwy.elevationFt + capture!.x * 6076.12 * Math.tan((3 * Math.PI) / 180);
    expect(capture!.altitudeFt).toBeLessThan(glideSlopeFt);
    expect(p.deviations()).toEqual([]);
    const f = approachFrame(rwy, p.s);
    expect(Math.abs(f.y)).toBeLessThan(0.25);
    expect(Math.abs(angleDiff(p.s.trackDeg, rwy.course))).toBeLessThan(15);
  });

  it('speaks the approach as a controller would', () => {
    const { p } = flyIls(starts[3]!);
    p.run(5);
    p.say('readback');
    p.set({ com1: 118_100 });
    p.say('towerIls');
    p.listen();
    p.say('readback');
    expect(texts(p)).toEqual([
      'pilot: Zürich Arrival, HB-TFS, Cessna 172, 16 NM north-west of Zurich, altitude 5000 ft, request ILS approach runway 14',
      'atc: HB-TFS, Zürich Arrival, squawk 4656, information Juliett is current',
      'pilot: Squawk 4656, HB-TFS',
      'atc: HFS, identified, 16 NM north-west of Zurich, QNH 1018, vectors for ILS approach runway 14, turn right heading 160, descend to altitude 3500 ft',
      'pilot: Turn right heading 160, descend to altitude 3500 ft, QNH 1018, HFS',
      'atc: HFS, 11 NM from touchdown, turn left heading 105, cleared ILS approach runway 14, report established',
      'pilot: Turn left heading 105, cleared ILS approach runway 14, HFS',
      'pilot: HFS, established localizer runway 14',
      'atc: HFS, contact Zürich Tower 118.100',
      'pilot: Zürich Tower 118.100, HFS',
      'pilot: Zürich Tower, HB-TFS, established ILS runway 14',
      'atc: HB-TFS, Zürich Tower, wind 160 degrees 8 knots, runway 14, cleared to land',
      'pilot: Runway 14, cleared to land, HB-TFS',
    ]);
    expect(interceptAltitude(runwayOf('LSZH', '14'))).toBe(3500);
    expect(p.events.filter((e) => e.type === 'squawk')).toEqual([{ type: 'squawk', code: 4656 }]);
  });
});

describe('deviations', () => {
  it('calls an altitude more than 300 ft off the cleared one', () => {
    let bumped = false;
    const { p } = flyIls({ e: -20, n: 0, heading: 90 }, (pilot) => {
      if (!bumped && pilot.s.time > 200 && Math.abs(pilot.s.altitudeFt - 3500) < 1) {
        bumped = true;
        pilot.s.altitudeFt = 3850;
      }
    });
    expect(bumped).toBe(true);
    expect(p.deviations()).toContain('altitude');
    expect(texts(p)).toContain('atc: HFS, check altitude, cleared altitude 3500 ft, QNH 1018');
  });

  it('calls a take-off without clearance', () => {
    const p = new Pilot(local, {
      ...linedUp(R14),
      headingDeg: R14.course,
      engineRunning: true,
      com1: 121_025,
    });
    p.set({ onGround: false, heightFt: 300, groundSpeedKt: 70 });
    expect(p.listen()).toBe(
      'HB-TFS, Bern Tower, you are airborne without take-off clearance, left-hand circuit, report downwind',
    );
    expect(p.deviations()).toEqual(['takeoffWithoutClearance']);
  });

  it('calls a landing without clearance', () => {
    const p = atApron();
    bernCircuit(p, 'downwind');
    p.set({
      ...onApproach(R14, -0.2, 0),
      onGround: true,
      heightFt: 0,
      groundSpeedKt: 50,
      headingDeg: R14.course,
    });
    expect(p.listen()).toBe(
      'HFS, you landed without landing clearance, vacate the runway and report on the ground',
    );
    expect(p.deviations()).toEqual(['landingWithoutClearance']);
  });

  it('calls an aircraft that enters a control zone without a call', () => {
    const p = inbound(124_700);
    p.run(30);
    expect(p.deviations()).toEqual([]);
    p.set({ ...fromLocalNm(BERN, 0, 4) }).run(25);
    expect(p.deviations()).toEqual(['controlZone']);
    expect(texts(p).at(-1)).toBe(
      'atc: HB-TFS, Zürich Information, you are inside the Bern control zone without clearance, contact Bern Tower 121.025 immediately',
    );
    // On the tower's frequency the tower itself says it.
    const q = inbound(121_025);
    q.set({ ...fromLocalNm(BERN, 0, 4) }).run(25);
    expect(texts(q).at(-1)).toBe(
      'atc: HB-TFS, Bern Tower, you have entered the Bern control zone without clearance, report your position and intentions',
    );
  });

  it('accepts the zone once the tower has been called', () => {
    const p = inbound(121_025);
    p.say('arrival');
    expect(p.listen()).toBe(
      'HB-TFS, Bern Tower, enter the control zone via November, runway 14, QNH 1018, information Delta is current, report November',
    );
    p.say('readback');
    p.set({ ...fromLocalNm(BERN, 0, 4) }).run(40);
    expect(p.deviations()).toEqual([]);
  });

  it('stops an aircraft that enters the runway when told to hold short', () => {
    const p = atApron();
    p.set({ com1: 121_700, engineRunning: true });
    p.say('taxi');
    p.listen();
    p.say('readback');
    p.set({ ...linedUp(R14), headingDeg: R14.course, groundSpeedKt: 5 });
    expect(p.listen()).toBe(
      'HFS, stop immediately, you were instructed to hold short of runway 14',
    );
    expect(p.deviations()).toEqual(['holdShort']);
  });
});
