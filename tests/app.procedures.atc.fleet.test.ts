/**
 * Air traffic control for every type: callsigns and types in the phraseology, an IFR flight
 * of the airliner from clearance to landing, the fighter's overhead break and low approach,
 * and radar vectors that scale with the speed of the aircraft.
 */
import { describe, expect, it } from 'vitest';
import { offsetPoint } from '../src/geo';
import {
  AtcController,
  type AtcConfig,
  type AtcEvent,
  type AtcRunway,
  type AtcSituation,
  type AtcWeather,
  BUILTIN_ATC_WORLD,
  atcConfigFromPlan,
} from '../src/app/procedures';
import {
  angleDiff,
  approachFrame,
  bearingTo,
  fromApproachFrame,
  fromLocalNm,
  localNm,
} from '../src/app/procedures/geometry';
import { callsign, level, transitionLevel } from '../src/app/procedures/phraseology';
import { interceptDistance, turnRate } from '../src/app/procedures/vectors';

const WEATHER: AtcWeather = {
  windFromDeg: 160,
  windKt: 8,
  visibilityM: 30_000,
  clouds: [{ cover: 'FEW', baseFt: 6500 }],
  temperatureC: 20,
  precipitation: 'none',
  qnh: 1018,
};

const BERN = BUILTIN_ATC_WORLD.airport('LSZB')!;
const ZURICH = BUILTIN_ATC_WORLD.airport('LSZH')!;
const rwyOf = (icao: string, ident: string): AtcRunway =>
  BUILTIN_ATC_WORLD.airport(icao)!.runways.find((r) => r.ident === ident)!;
const B14 = rwyOf('LSZB', '14');
const Z14 = rwyOf('LSZH', '14');

const linedUp = (rwy: AtcRunway) => offsetPoint(rwy.start, rwy.course, 40);
function holdingPoint(rwy: AtcRunway) {
  const back = offsetPoint(rwy.start, rwy.course + 180, 60);
  return offsetPoint(back, rwy.course - 90, 45);
}
function apron(rwy: AtcRunway) {
  const mid = offsetPoint(rwy.start, rwy.course, rwy.length / 2);
  return offsetPoint(mid, rwy.course + 90, 250);
}

class Pilot {
  atc: AtcController;
  s: AtcSituation;
  events: AtcEvent[] = [];
  constructor(config: AtcConfig, start: Partial<AtcSituation>) {
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
    this.s.trackDeg = this.s.headingDeg;
    this.events.push(...this.atc.update(this.s));
  }
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
  has(id: string) {
    return this.options().some((o) => o.id === id);
  }
  say(id: string): string {
    const o = this.options().find((x) => x.id === id);
    if (!o)
      throw new Error(`No option ${id} in ${JSON.stringify(this.options())} (${this.atc.stage})`);
    this.events.push(...this.atc.reply(o.id));
    return o.text;
  }
  listen(maxSeconds = 30): string {
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
const texts = (p: Pilot) => p.messages().map((m) => `${m.message.from}: ${m.message.text}`);

/**
 * A point-mass aircraft that does what it is told: turns to headings (at the rate its speed
 * allows) or flies direct, climbs and descends to its clearances, captures the localizer
 * once cleared, tunes the frequencies it is given, reads everything back and makes the IFR
 * calls when they are offered. Steps of half a second.
 */
function autopilot(
  p: Pilot,
  o: {
    speedKt: number;
    until: () => boolean;
    rwy: AtcRunway;
    climbFpm?: number;
    calls?: string[];
    maxSteps?: number;
    onStep?: () => void;
  },
) {
  const calls = o.calls ?? ['departure', 'radar', 'arrivalIfr', 'established', 'towerIls'];
  let target = p.s.headingDeg;
  let targetAlt = p.s.altitudeFt;
  let direct: { lon: number; lat: number } | null = null;
  let cleared = false;
  let seen = 0;
  let capture: { x: number; altitudeFt: number; angle: number } | null = null;
  let lastHeading = target;
  const ref = o.rwy.threshold;
  for (let i = 0; i < (o.maxSteps ?? 12_000) && !o.until(); i++) {
    for (; seen < p.events.length; seen++) {
      const e = p.events[seen]!;
      if (e.type === 'frequency') p.s.com1 = e.khz;
      if (e.type === 'squawk') p.s.squawk = e.code;
      if (e.type !== 'instruction') continue;
      const ins = e.instruction;
      if (ins.kind === 'heading') {
        target = lastHeading = ins.degrees + 3;
        direct = null;
      }
      if (ins.kind === 'direct') direct = BUILTIN_ATC_WORLD.airport(ins.to)!;
      if (ins.kind === 'altitude') targetAlt = ins.feet;
      if (ins.kind === 'approach' && ins.approach === 'ils') cleared = true;
    }
    if (p.has('readback')) p.say('readback');
    for (const c of calls) if (p.has(c)) p.say(c);
    if (direct) target = bearingTo(p.s, direct);
    const f = approachFrame(o.rwy, p.s);
    if (cleared && Math.abs(f.y) < 0.15 * (o.speedKt / 100 + 0.5)) {
      capture ??= {
        x: f.x,
        altitudeFt: p.s.altitudeFt,
        angle: Math.abs(angleDiff(lastHeading, o.rwy.course)),
      };
      target = o.rwy.course - Math.max(-30, Math.min(30, f.y * 60));
    }
    const rate = turnRate(o.speedKt) * 0.5;
    const hdg = p.s.headingDeg + Math.max(-rate, Math.min(rate, angleDiff(target, p.s.headingDeg)));
    const vs = o.climbFpm ?? 1500;
    const dAlt = Math.max((-vs / 60) * 0.5, Math.min((vs / 60) * 0.5, targetAlt - p.s.altitudeFt));
    const l = localNm(ref, p.s);
    const d = (o.speedKt / 3600) * 0.5;
    const r = (hdg * Math.PI) / 180;
    const next = fromLocalNm(ref, l.e + Math.sin(r) * d, l.n + Math.cos(r) * d);
    p.s.lon = next.lon;
    p.s.lat = next.lat;
    p.s.headingDeg = p.s.trackDeg = ((hdg % 360) + 360) % 360;
    p.s.altitudeFt += dAlt;
    p.s.heightFt = p.s.altitudeFt - o.rwy.elevationFt;
    p.s.verticalSpeedFpm = dAlt * 120;
    p.s.groundSpeedKt = o.speedKt;
    o.onStep?.();
    p.run(0.5);
  }
  return capture;
}

// ---------------------------------------------------------------- callsigns and types

describe('callsigns and types by aircraft', () => {
  const plan = (aircraft: 'c172' | 'pc12' | 'a320' | 'fa18') =>
    atcConfigFromPlan(
      {
        aircraft,
        start: { kind: 'runway', airport: 'LSZB', runway: '14' },
        time: 12,
        weather: 'fair',
      },
      WEATHER,
    )!;

  it('takes callsign and flight rules from the type', () => {
    expect(
      [plan('c172'), plan('pc12'), plan('a320'), plan('fa18')].map((c) => [
        c.callsign,
        c.flightRules,
      ]),
    ).toEqual([
      ['HB-TFS', 'VFR'],
      ['HB-FTS', 'VFR'],
      ['Alpine 482', 'IFR'],
      ['Hornet 11', 'VFR'],
    ]);
  });

  it('speaks airline and military callsigns by their digits and never abbreviates them', () => {
    expect(callsign('Alpine 482', false)).toEqual({
      text: 'Alpine 482',
      spoken: 'Alpine four eight two',
    });
    expect(callsign('Hornet 11', true)).toEqual({ text: 'Hornet 11', spoken: 'Hornet one one' });
    expect(callsign('HB-FTS', true).text).toBe('HTS');
  });

  it('names the PC-12 and the fighter in a VFR call', () => {
    const at = (aircraft: 'pc12' | 'fa18') => {
      const cfg = { ...plan(aircraft), departure: { airport: 'LSZB' } };
      const p = new Pilot(cfg, { ...apron(B14), com1: 121_700 });
      return p.options().map((o) => o.text)[0];
    };
    expect(at('pc12')).toBe(
      'Bern Ground, HB-FTS, Pilatus PC-12, at the apron, local flight, request start-up',
    );
    expect(at('fa18')).toBe(
      'Bern Ground, Hornet 11, F/A-18, at the apron, local flight, request start-up',
    );
  });

  it('puts levels above the transition altitude of 7000 ft', () => {
    expect(transitionLevel(1013)).toBe(80);
    expect(transitionLevel(990)).toBe(90);
    expect(level(5000, 1018).text).toBe('altitude 5000 ft');
    expect(level(9000, 1018)).toEqual({ text: 'FL 90', spoken: 'flight level niner zero' });
  });
});

// ---------------------------------------------------------------- the airliner, IFR

const alpine: AtcConfig = {
  callsign: 'Alpine 482',
  aircraft: 'a320',
  departure: { airport: 'LSZB', runway: '14' },
  destination: { airport: 'LSZH' },
  weather: WEATHER,
};

/** From the stand at Bern to the holding point of runway 14, everything right. */
function bernToRunway(p: Pilot) {
  p.set({ com1: 125_125 }).run(2);
  p.set({ com1: 121_700 });
  p.say('clearance');
  p.listen();
  p.say('readback');
  p.run(1);
  p.say('startup');
  p.listen();
  p.say('readback');
  p.set({ engineRunning: true }).run(1);
  p.say('taxi');
  p.listen();
  p.say('readback');
  p.set({ ...holdingPoint(B14), groundSpeedKt: 0 }).run(1);
  p.set({ com1: 121_025 }).run(1);
  p.say('ready');
  p.listen();
  p.say('readback');
  p.set({ ...linedUp(B14), headingDeg: B14.course });
  p.listen(40);
  p.say('readback');
}

describe('an IFR flight of the A320 from Bern to Zürich', () => {
  function flight() {
    const p = new Pilot(alpine, { ...apron(B14), headingDeg: 50 });
    bernToRunway(p);
    p.set({ onGround: false, heightFt: 400, altitudeFt: 2100, groundSpeedKt: 160 });
    autopilot(p, {
      speedKt: 220,
      climbFpm: 2500,
      rwy: Z14,
      until: () => p.atc.stage === 'ilsHandoff',
    });
    return p;
  }

  it('goes from clearance delivery to the ILS in jet phraseology', () => {
    const p = flight();
    expect(p.atc.stage).toBe('ilsHandoff');
    p.run(5);
    p.say('readback');
    p.set({ com1: 118_100 });
    p.say('towerIls');
    p.listen();
    p.say('readback');
    const t = texts(p);
    // Callsign never abbreviated, no digits spoken, and the stations in their order.
    expect(t.filter((x) => x.includes('Alpine 482')).length).toBe(t.length - 1);
    for (const m of p.messages()) expect(m.spoken).not.toMatch(/\d/);
    const stations = [...new Set(p.messages('atc').map((m) => m.message.station))];
    expect(stations).toEqual([
      'Bern ATIS',
      'Bern Ground',
      'Bern Tower',
      'Bern Arrival',
      'Swiss Radar',
      'Zürich Arrival',
      'Zürich Tower',
    ]);
    expect(t.slice(1, 4)).toEqual([
      'pilot: Bern Ground, Alpine 482, Airbus A320, information Delta, request IFR clearance to Zurich',
      'atc: Alpine 482, Bern Ground, cleared to Zurich, runway 14, after departure runway heading, climb to altitude 5000 ft, squawk 1562',
      'pilot: Cleared to Zurich, runway 14, runway heading, climb to altitude 5000 ft, squawk 1562, Alpine 482',
    ]);
    expect(t).toContain('pilot: Alpine 482, information Delta, request start-up and push-back');
    expect(t).toContain(
      'atc: Alpine 482, wind 160 degrees 8 knots, runway 14, cleared for take-off',
    );
    expect(t).toContain('atc: Alpine 482, contact Bern Arrival 127.325');
    expect(t).toContain(
      'atc: Alpine 482, Bern Arrival, identified, turn left heading 050, climb to FL 90',
    );
    expect(t).toContain('atc: Alpine 482, contact Swiss Radar 128.050');
    expect(t).toContain('pilot: Swiss Radar, Alpine 482, FL 90');
    expect(t).toContain('atc: Alpine 482, Swiss Radar, identified, proceed direct Zurich');
    expect(t).toContain(
      'atc: Alpine 482, descend to altitude 7000 ft, QNH 1018, speed 250 knots or less',
    );
    expect(t).toContain('atc: Alpine 482, contact Zürich Arrival 118.000');
    expect(t.at(-2)).toBe(
      'atc: Alpine 482, Zürich Tower, wind 160 degrees 8 knots, runway 14, cleared to land',
    );
    expect(p.deviations()).toEqual([]);
    // Westbound would be even: Bern to Zürich is eastbound, an odd level.
    const levels = p.events.flatMap((e) =>
      e.type === 'instruction' && e.instruction.kind === 'altitude' ? [e.instruction.feet] : [],
    );
    expect(levels).toEqual([5000, 9000, 7000, 4000]);
  });

  it('plans the descent so that the jet is at 4000 ft about 12 NM out', () => {
    const p = new Pilot(alpine, { ...apron(B14), headingDeg: 50 });
    bernToRunway(p);
    p.set({ onGround: false, heightFt: 400, altitudeFt: 2100, groundSpeedKt: 160 });
    let at12: number | null = null;
    autopilot(p, {
      speedKt: 210,
      climbFpm: 2500,
      rwy: Z14,
      until: () => p.atc.stage === 'ilsHandoff',
      onStep: () => {
        const f = approachFrame(Z14, p.s);
        if (at12 === null && p.atc.stage === 'ilsCleared' && Math.abs(f.y) < 0.3 && f.x < 12.5)
          at12 = p.s.altitudeFt;
      },
    });
    expect(interceptDistance(210)).toBeCloseTo(11.6, 1);
    expect(at12).not.toBeNull();
    expect(Math.abs(at12! - 4000)).toBeLessThan(150);
  });

  it('is deterministic and can be saved and restored mid-flight', () => {
    const a = flight();
    const b = new Pilot(alpine, { ...apron(B14), headingDeg: 50 });
    b.set({ com1: 125_125 }).run(2);
    b.set({ com1: 121_700 });
    b.say('clearance');
    b.listen();
    b.atc = new AtcController(alpine, JSON.parse(JSON.stringify(b.atc.save())));
    b.set({});
    b.say('readback');
    b.run(1);
    b.say('startup');
    b.listen();
    const tb = texts(b);
    expect(tb).toEqual(texts(a).slice(0, tb.length));
  });

  it('gives the IFR clearance with the take-off when the flight starts lined up', () => {
    const p = new Pilot(alpine, {
      ...linedUp(B14),
      headingDeg: B14.course,
      engineRunning: true,
      com1: 121_025,
    });
    expect(p.say('ready')).toBe(
      'Bern Tower, Alpine 482, lined up runway 14, ready for departure, IFR to Zurich',
    );
    expect(p.listen()).toMatch(
      /^Alpine 482, Bern Tower, cleared to Zurich, runway 14, after departure runway heading, climb to altitude 5000 ft, squawk \d{4}, wind 160 degrees 8 knots, runway 14, cleared for take-off$/,
    );
    expect(p.events.some((e) => e.type === 'squawk')).toBe(true);
  });
});

// ---------------------------------------------------------------- the fighter

describe('the fighter at its home base', () => {
  const hornet: AtcConfig = {
    callsign: 'Hornet 11',
    aircraft: 'fa18',
    departure: { airport: 'LSZB' },
    weather: WEATHER,
  };

  it('flies an overhead break and a low approach', () => {
    const p = new Pilot(hornet, {
      ...fromLocalNm(BERN, 0, 12),
      onGround: false,
      heightFt: 2500,
      altitudeFt: 4200,
      headingDeg: 180,
      groundSpeedKt: 300,
      engineRunning: true,
      com1: 121_025,
    });
    p.say('arrivalBreak');
    expect(p.listen()).toBe(
      'Hornet 11, Bern Tower, join initial runway 14, left-hand break, QNH 1018, information Delta is current, report initial',
    );
    p.say('readback');
    p.set({ ...fromApproachFrame(B14, 4, 0), headingDeg: B14.course, altitudeFt: 3200 }).run(1);
    p.say('initial');
    expect(p.listen()).toBe('Hornet 11, number one, break approved, report final');
    p.say('readback');
    p.set({ ...fromApproachFrame(B14, 2, 0), headingDeg: B14.course, heightFt: 600 }).run(1);
    expect(p.options().map((o) => o.id)).toEqual(['final', 'lowApproach', 'sayAgain']);
    p.say('lowApproach');
    expect(p.listen()).toBe('Hornet 11, wind 160 degrees 8 knots, runway 14, cleared low approach');
    p.say('readback');
    p.set({ ...fromApproachFrame(B14, -0.5, 0), heightFt: 500, verticalSpeedFpm: 2000 });
    expect(p.listen()).toBe('Hornet 11, join left-hand downwind runway 14, report downwind');
    expect(p.deviations()).toEqual([]);
    for (const m of p.messages()) expect(m.spoken).not.toMatch(/\d/);
  });

  it('offers neither away from home', () => {
    const p = new Pilot(
      { ...hornet, homeBase: 'LSMP', destination: { airport: 'LSZB' } },
      {
        ...fromLocalNm(BERN, 0, 12),
        onGround: false,
        heightFt: 2500,
        altitudeFt: 4200,
        headingDeg: 180,
        engineRunning: true,
        com1: 121_025,
      },
    );
    expect(p.options().map((o) => o.id)).toEqual(['arrival']);
  });
});

// ---------------------------------------------------------------- vectors by speed

describe('radar vectors scale with the speed', () => {
  const starts = [
    { e: -20, n: 0, heading: 90 },
    { e: 14, n: 12, heading: 225 },
    { e: 5, n: -18, heading: 0 },
    { e: -14, n: 16, heading: 135 },
  ];
  const cases = [90, 160, 220].flatMap((speedKt) => starts.map((s) => ({ speedKt, ...s })));
  it.each(cases)('at $speedKt kt from ($e, $n) heading $heading', ({ speedKt, e, n, heading }) => {
    const aircraft = speedKt < 100 ? 'c172' : speedKt < 200 ? 'pc12' : 'a320';
    const p = new Pilot(
      {
        callsign: aircraft === 'a320' ? 'Alpine 482' : 'HB-TFS',
        aircraft,
        flightRules: 'VFR',
        departure: { airport: 'LSZB' },
        destination: { airport: 'LSZH' },
        weather: WEATHER,
      },
      {
        ...fromLocalNm(ZURICH, e, n),
        onGround: false,
        heightFt: 4500,
        altitudeFt: 6000,
        headingDeg: heading,
        groundSpeedKt: speedKt,
        engineRunning: true,
        com1: 118_000,
      },
    );
    const capture = autopilot(p, {
      speedKt,
      rwy: Z14,
      calls: ['arrivalIls', 'established'],
      until: () => p.atc.stage === 'ilsHandoff',
    });
    expect(p.atc.stage).toBe('ilsHandoff');
    expect(capture).not.toBeNull();
    const want = interceptDistance(speedKt);
    // Within 2 NM of where the plan meets the localizer.
    expect(capture!.x).toBeGreaterThan(want - 2);
    expect(capture!.x).toBeLessThan(want + 2);
    expect(capture!.angle).toBeGreaterThan(25);
    expect(capture!.angle).toBeLessThan(35);
    const glideSlopeFt = Z14.elevationFt + capture!.x * 6076.12 * Math.tan((3 * Math.PI) / 180);
    expect(capture!.altitudeFt).toBeLessThan(glideSlopeFt);
    expect(p.deviations()).toEqual([]);
    const f = approachFrame(Z14, p.s);
    expect(Math.abs(f.y)).toBeLessThan(0.25);
    expect(Math.abs(angleDiff(p.s.trackDeg, Z14.course))).toBeLessThan(15);
  });

  it('clears a jet already on the extended centre line straight in', () => {
    const p = new Pilot(
      {
        callsign: 'Alpine 482',
        aircraft: 'a320',
        flightRules: 'VFR',
        departure: { airport: 'LSZB' },
        destination: { airport: 'LSZH' },
        weather: WEATHER,
      },
      {
        ...fromApproachFrame(Z14, 17, 0.3),
        onGround: false,
        heightFt: 4500,
        altitudeFt: 6000,
        headingDeg: Z14.course,
        groundSpeedKt: 220,
        engineRunning: true,
        com1: 118_000,
      },
    );
    p.say('arrivalIls');
    p.listen();
    p.say('readback');
    p.set({ squawk: p.events.flatMap((e) => (e.type === 'squawk' ? [e.code] : []))[0]! });
    expect(p.listen()).toMatch(/17 NM from touchdown, .*cleared ILS approach runway 14/);
  });

  it('joins a jet further out than a light aircraft', () => {
    expect(interceptDistance(90)).toBe(8);
    expect(interceptDistance(100)).toBe(8);
    expect(interceptDistance(160)).toBeCloseTo(9.8, 1);
    expect(interceptDistance(220)).toBeCloseTo(12, 5);
    expect(turnRate(90)).toBe(3);
    expect(turnRate(220)).toBeLessThan(2.5);
  });
});
