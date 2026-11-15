/**
 * The flight school: the runner's logic on made-up telemetry, the curriculum checked against
 * the airports, the aircraft and their cockpits, and two lessons flown by a scripted pilot
 * through the real flight model until the runner says 'passed'.
 */
import { describe, expect, it } from 'vitest';
import {
  AIRPORTS,
  findAirport,
  findRunwayEnd,
  findStation,
  ilsFor,
  navDatabase,
  offsetPoint,
  runwayStart,
  thresholdOf,
  bearingDeg,
} from '../src/geo';
import {
  AIRCRAFT,
  SIM_DT,
  TestEnvironment,
  createAircraft,
  ecefToGeodetic,
  geodeticToEcef,
  type SimAircraft,
  type Telemetry,
} from '../src/sim';
import type { AirportOption, LessonInfo, LessonView } from '../src/ui/api';
import { validatePlan } from '../src/ui/plan';
import {
  LESSONS,
  LessonRunner,
  RunwayGeometry,
  SchoolProgress,
  controlsIn,
  controlsOf,
  findLesson,
  formatMeasure,
  lessonInfos,
  lessonPlan,
  type Cond,
  type LessonDef,
  type Place,
  type StorageLike,
} from '../src/app/school';
import { AttitudePilot, DEG, FT, KT, Pid, clamp, headingError } from './sim/harness';

// ---- synthetic telemetry ------------------------------------------------------------

/** A real telemetry object of a Cessna in the air, to change field by field. */
function cessnaTelemetry(): Telemetry {
  const env = new TestEnvironment();
  const ac = createAircraft('c172');
  ac.reset({ position: env.position(1000), headingDeg: 0, speed: 50, onGround: false }, env);
  return structuredClone(ac.telemetry);
}

const KTS = 1 / 1.943844;

const TEST_LESSON: LessonDef = {
  id: 'test',
  title: { de: 'Test', en: 'Test' },
  summary: { de: 'Test', en: 'Test' },
  aircraft: 'c172',
  minutes: 1,
  plan: {
    aircraft: 'c172',
    start: { kind: 'air', lon: 7.4, lat: 47, altitude: 1500, headingDeg: 0 },
    time: 12,
    weather: 'clear',
  },
  steps: [
    { id: 'fast', say: { de: 'Schnell', en: 'Fast' }, done: { value: 'iasKt', min: 50 } },
    {
      id: 'climb',
      say: { de: 'Steigen', en: 'Climb' },
      done: { value: 'altitudeFt', min: 100, rel: 'step' },
      hold: 4,
      hints: [{ when: { value: 'iasKt', max: 40 }, say: { de: 'Langsam', en: 'Slow' } }],
      fail: [{ when: { value: 'iasKt', max: 20 }, say: { de: 'Stall', en: 'Stall' }, after: 2 }],
    },
    { id: 'flaps', say: { de: 'Klappen', en: 'Flaps' }, done: { control: 'flaps', is: '30' } },
  ],
  debrief: [
    {
      kind: 'range',
      label: { de: 'Fahrt', en: 'Speed' },
      value: 'iasKt',
      steps: ['climb'],
      report: 'maxAbs',
      target: 60,
      unit: 'kt',
      ok: { max: 10 },
    },
    {
      kind: 'touchdown',
      label: { de: 'Sinkrate', en: 'Sink' },
      field: 'sinkFpm',
      unit: 'ft/min',
      ok: { max: 400 },
    },
  ],
};

/** Runs the runner `seconds` at 60 frames a second, changing the telemetry before each. */
function run(
  r: LessonRunner,
  t: Telemetry,
  cockpit: Record<string, number>,
  seconds: number,
  change: (t: Telemetry) => void = () => {},
) {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    change(t);
    t.time += 1 / 60;
    r.update(1 / 60, t, cockpit);
  }
}

describe('the lesson runner', () => {
  it('goes through the steps in order and never back', () => {
    const t = cessnaTelemetry();
    const cockpit = { flaps: 3 };
    const r = new LessonRunner(TEST_LESSON);
    t.ias = 30 * KTS;
    // The last step's condition holds already: that does not skip anything.
    run(r, t, cockpit, 1);
    expect(r.step).toBe(0);
    t.ias = 60 * KTS;
    run(r, t, cockpit, 0.1);
    expect(r.step).toBe(1);
    // Slow again: the first step stays done.
    t.ias = 45 * KTS;
    run(r, t, cockpit, 0.5);
    expect(r.step).toBe(1);
    expect(r.view().instruction.en).toBe('Climb');
  });

  it('times a held step, starts it over when broken, shows its progress', () => {
    const t = cessnaTelemetry();
    const r = new LessonRunner(TEST_LESSON);
    t.ias = 60 * KTS;
    run(r, t, { flaps: 0 }, 0.1);
    expect(r.step).toBe(1);
    // Relative to where the step began.
    const start = t.instruments!.altitude;
    t.instruments!.altitude = start + 150 * FT;
    run(r, t, { flaps: 0 }, 2);
    expect(r.view().progress).toBeCloseTo(0.5, 1);
    t.instruments!.altitude = start + 50 * FT;
    run(r, t, { flaps: 0 }, 0.1);
    expect(r.progress).toBe(0);
    t.instruments!.altitude = start + 150 * FT;
    run(r, t, { flaps: 0 }, 4.1);
    expect(r.step).toBe(2);
    expect(r.view().progress).toBeUndefined();
    run(r, t, { flaps: 3 }, 0.1);
    expect(r.state).toBe('passed');
    const v = r.view();
    expect(v.state).toBe('passed');
    // Speed 60 throughout the climb step: deviation 0, ok; no touchdown: no value, not ok.
    expect(v.debrief).toEqual([
      { label: { de: 'Fahrt', en: 'Speed' }, value: '±0.0 kt', ok: true },
      { label: { de: 'Sinkrate', en: 'Sink' }, value: '–', ok: false },
    ]);
  });

  it('shows a hint only after its condition has held a moment, and fails after its time', () => {
    const t = cessnaTelemetry();
    const r = new LessonRunner(TEST_LESSON);
    t.ias = 60 * KTS;
    run(r, t, {}, 0.1);
    t.ias = 35 * KTS;
    run(r, t, {}, 0.5);
    expect(r.view().hint).toBeUndefined();
    run(r, t, {}, 0.6);
    expect(r.view().hint?.de).toBe('Langsam');
    t.ias = 15 * KTS;
    run(r, t, {}, 1.5);
    expect(r.state).toBe('running');
    run(r, t, {}, 0.6);
    expect(r.state).toBe('failed');
    const v = r.view();
    expect(v.instruction.en).toBe('Stall');
    expect(v.hint).toBeUndefined();
    expect(v.debrief).toHaveLength(2);
    // Over: further frames change nothing.
    t.ias = 60 * KTS;
    run(r, t, {}, 1);
    expect(r.state).toBe('failed');
  });

  it('fails on a crash and measures the touchdown from the last frame in the air', () => {
    const t = cessnaTelemetry();
    const r = new LessonRunner(TEST_LESSON);
    t.ias = 60 * KTS;
    t.verticalSpeed = -2;
    run(r, t, {}, 3);
    t.onGround = true;
    t.verticalSpeed = 0;
    t.crashed = 'gear';
    run(r, t, {}, 0.1);
    expect(r.state).toBe('failed');
    const sink = r.view().debrief![1]!;
    // 2 m/s = 394 ft/min.
    expect(sink.value).toBe('394 ft/min');
    expect(sink.ok).toBe(true);
  });

  it('builds views the interface takes', () => {
    const r = new LessonRunner(LESSONS[0]!);
    const view: LessonView = r.view();
    expect(view).toMatchObject({ id: 'first-takeoff', step: 0, state: 'running' });
    expect(view.steps).toBe(LESSONS[0]!.steps.length);
    const infos: LessonInfo[] = lessonInfos(['turns']);
    expect(infos.map((i) => i.id)).toEqual(LESSONS.map((l) => l.id));
    expect(infos.find((i) => i.id === 'turns')!.done).toBe(true);
    expect(infos.find((i) => i.id === 'first-takeoff')!.done).toBe(false);
    expect(formatMeasure(-0.04, 'm')).toBe('0.0 m');
    expect(formatMeasure(12.6, '°', true)).toBe('±13°');
  });
});

describe('the progress of the school', () => {
  const memory = (initial?: string): StorageLike & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    if (initial !== undefined) data.set('tfs.school.v1', initial);
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
    };
  };

  it('keeps passed lessons under one key', () => {
    const store = memory();
    const p = new SchoolProgress(store);
    expect(p.markPassed('turns')).toBe(true);
    expect(p.markPassed('turns')).toBe(false);
    p.markPassed('landing');
    expect([...store.data.keys()]).toEqual(['tfs.school.v1']);
    const again = new SchoolProgress(store);
    expect(again.ids()).toEqual(['turns', 'landing']);
    expect(
      lessonInfos(again)
        .filter((l) => l.done)
        .map((l) => l.id),
    ).toEqual(['turns', 'landing']);
  });

  it('reads corrupt or foreign data as no progress', () => {
    for (const bad of ['{', 'null', '42', '{"passed":"turns"}', '[1,2]', '{"passed":[1,{}]}'])
      expect(new SchoolProgress(memory(bad)).ids(), bad).toEqual([]);
    expect(new SchoolProgress(memory('{"passed":["vor",3]}')).ids()).toEqual(['vor']);
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const p = new SchoolProgress(throwing);
    expect(p.markPassed('vor')).toBe(true);
    expect(p.isPassed('vor')).toBe(true);
  });
});

// ---- the curriculum -------------------------------------------------------------------

function conditionsOf(l: LessonDef): Cond[] {
  const out: Cond[] = [];
  for (const s of l.steps) {
    out.push(s.done);
    for (const h of [...(s.hints ?? []), ...(s.fail ?? [])]) out.push(h.when);
  }
  for (const h of [...(l.hints ?? []), ...(l.fail ?? [])]) out.push(h.when);
  for (const m of l.debrief) if (m.kind === 'afterTouchdown') out.push(m.until);
  return out;
}

/** Every control check of a condition, with what it asks. */
function controlChecks(c: Cond, out: { control: string; is?: unknown }[] = []) {
  if ('all' in c) c.all.forEach((x) => controlChecks(x, out));
  else if ('any' in c) c.any.forEach((x) => controlChecks(x, out));
  else if ('not' in c) controlChecks(c.not, out);
  else if ('control' in c) out.push(c);
  return out;
}

function textsOf(l: LessonDef) {
  const texts = [l.title, l.summary, ...(l.closing ? [l.closing] : [])];
  for (const s of l.steps) {
    texts.push(s.say);
    for (const h of [...(s.hints ?? []), ...(s.fail ?? [])]) texts.push(h.say);
  }
  for (const h of [...(l.hints ?? []), ...(l.fail ?? [])]) texts.push(h.say);
  for (const m of l.debrief) texts.push(m.label);
  return texts;
}

describe('the curriculum', () => {
  const airports: AirportOption[] = AIRPORTS.map((a) => ({
    icao: a.icao,
    name: a.name,
    lon: a.lon,
    lat: a.lat,
    elevation: a.elevation,
    runways: a.runways.flatMap((r) => r.ends.map((e) => e.ident)),
  }));

  it('runs in teaching order with unique ids, the conversions last', () => {
    expect(LESSONS.map((l) => l.id)).toEqual([
      'first-takeoff',
      'straight-level',
      'turns',
      'slow-flight',
      'landing',
      'circuit',
      'vor',
      'ils',
      'pc12',
      'a320-takeoff',
      'a320-autoland',
      'fa18',
    ]);
    expect(new Set(LESSONS.map((l) => l.aircraft))).toEqual(
      new Set(['c172', 'pc12', 'a320', 'fa18']),
    );
    expect(findLesson('ils')!.plan.weather).toBe('lowStratus');
    expect(lessonPlan('nope')).toBeUndefined();
    // A copy: the app may change it.
    const plan = lessonPlan('landing')!;
    plan.time = 3;
    expect(findLesson('landing')!.plan.time).toBe(10);
  });

  for (const lesson of LESSONS)
    it(`${lesson.id}: a valid plan and steps that the type can fly`, () => {
      const plan = lesson.plan;
      expect(plan.aircraft).toBe(lesson.aircraft);
      expect(AIRCRAFT.some((a) => a.id === lesson.aircraft)).toBe(true);
      expect(validatePlan(plan, airports, AIRCRAFT)).toBeNull();
      expect(plan.atc).toBe(false);
      // The airport exists, and so does the runway the runway values refer to.
      const icao = plan.airport ?? (plan.start.kind === 'air' ? undefined : plan.start.airport);
      const airport = findAirport(icao!);
      expect(airport, icao).toBeDefined();
      if (plan.start.kind !== 'air') {
        expect(findRunwayEnd(airport!, plan.start.runway)).toBeDefined();
        expect(RunwayGeometry.of(airport!.icao, plan.start.runway)).toBeDefined();
      }

      const specs = controlsOf(lesson.aircraft);
      const conds = conditionsOf(lesson);
      const names = new Set<string>();
      for (const c of conds) controlsIn(c, names);
      for (const id of names)
        expect(
          specs.some((s) => s.id === id),
          `${id} on ${lesson.aircraft}`,
        ).toBe(true);
      for (const check of conds.flatMap((c) => controlChecks(c))) {
        if (typeof check.is !== 'string' && !Array.isArray(check.is)) continue;
        const positions = specs.find((s) => s.id === check.control)!.positions;
        for (const p of [check.is].flat() as string[])
          expect(positions, `${check.control} '${p}'`).toContain(p);
      }

      const stepIds = lesson.steps.map((s) => s.id);
      expect(new Set(stepIds).size).toBe(stepIds.length);
      for (const m of lesson.debrief)
        if (m.kind === 'range') for (const s of m.steps) expect(stepIds).toContain(s);
      expect(lesson.debrief.length).toBeGreaterThan(0);
      expect(lesson.minutes).toBeGreaterThan(0);

      for (const text of textsOf(lesson)) {
        expect(text.de.trim().length, JSON.stringify(text)).toBeGreaterThan(0);
        expect(text.en.trim().length, JSON.stringify(text)).toBeGreaterThan(0);
        // Swiss German writes ss.
        expect(text.de, text.de).not.toContain('ß');
        expect(text.en, text.en).not.toMatch(/[äöüÄÖÜß]/);
      }
    });

  it('takes its speeds from the types and its stations from the navigation data', () => {
    const say = (id: string, step: string) =>
      findLesson(id)!.steps.find((s) => s.id === step)!.say.en;
    const kt = (id: string, f: 'vRotate' | 'vApproach') =>
      Math.round(AIRCRAFT.find((a) => a.id === id)![f]! / KT);
    expect(say('first-takeoff', 'roll')).toContain(`${kt('c172', 'vRotate')} knots`);
    expect(say('landing', 'final')).toContain(`${kt('c172', 'vApproach')} knots`);
    expect(say('pc12', 'rotate')).toContain(`${kt('pc12', 'vRotate')} knots`);
    expect(say('a320-takeoff', 'rotate')).toContain(`${kt('a320', 'vRotate')} knots`);
    expect(say('fa18', 'rotate')).toContain(`${kt('fa18', 'vRotate')} knots`);
    // The C172S handbook: rotate 55, approach 65 with full flaps, best rate of climb 74 KIAS.
    expect(kt('c172', 'vRotate')).toBe(55);
    expect(kt('c172', 'vApproach')).toBe(65);
    expect(say('first-takeoff', 'climb')).toContain('74 knots');

    const fri = findStation('FRI', 'VOR-DME')!;
    expect(fri.frequency).toBe(110_850);
    expect(say('vor', 'tune')).toContain('110.85');
    // The ILS lessons fly approaches that have one.
    expect(ilsFor('LSZH', '14')?.glideSlope).toBeDefined();
    expect(ilsFor('LSZB', '14')?.glideSlope?.angleDeg).toBe(4);
  });
});

// ---- flown through the flight model -------------------------------------------------

interface Flown {
  ac: SimAircraft;
  env: TestEnvironment;
  runner: LessonRunner;
  place: Place;
}

/** Puts a Cessna where a lesson's plan starts it, on a flat world at the airport's height. */
function start(lesson: LessonDef): Flown {
  const plan = lesson.plan;
  if (plan.start.kind === 'air') {
    // Flat ground 600 m above the sea, about the Mittelland's height.
    const s = plan.start;
    const env = new TestEnvironment({ latitude: s.lat, longitude: s.lon, elevation: 600 });
    const ac = createAircraft(plan.aircraft);
    ac.reset(
      {
        position: geodeticToEcef(s.lat, s.lon, s.altitude),
        headingDeg: s.headingDeg,
        speed: s.speed!,
        onGround: false,
      },
      env,
    );
    const runner = new LessonRunner(lesson, ac.cockpit.specs);
    return { ac, env, runner, place: { lon: 0, lat: 0, msl: 0 } };
  }
  const airport = findAirport(plan.start.airport)!;
  const { end, opposite } = findRunwayEnd(airport, plan.start.runway)!;
  const elevation = end.elevation ?? airport.elevation;
  const ac = createAircraft(plan.aircraft);
  let at: { lon: number; lat: number; height: number; heading: number };
  if (plan.start.kind === 'runway') {
    const s = runwayStart(airport, plan.start.runway)!;
    at = { lon: s.lon, lat: s.lat, height: elevation, heading: s.headingDeg };
  } else {
    // As the app places an approach start: on the extended centre line, 60 m under the path.
    const threshold = thresholdOf(end, opposite);
    const course = bearingDeg(end, opposite);
    const metres = plan.start.distanceNm * 1852;
    const p = offsetPoint(threshold, course + 180, metres);
    const angle = ilsFor(airport.icao, plan.start.runway)?.glideSlope?.angleDeg ?? 3;
    const height = elevation + 15 + metres * Math.tan(angle * DEG) - 60;
    at = { ...p, height, heading: course };
    ac.controls.flaps = 1 / 3;
  }
  const env = new TestEnvironment({ latitude: at.lat, longitude: at.lon, elevation });
  const air = plan.start.kind === 'approach';
  const info = AIRCRAFT.find((a) => a.id === plan.aircraft)!;
  ac.reset(
    {
      position: geodeticToEcef(at.lat, at.lon, at.height),
      headingDeg: at.heading,
      speed: air ? 1.2 * info.vApproach! : 0,
      onGround: !air,
      gearDown: true,
    },
    env,
  );
  return {
    ac,
    env,
    runner: new LessonRunner(lesson, ac.cockpit.specs),
    place: { lon: 0, lat: 0, msl: 0 },
  };
}

/** Flies up to `seconds`, the pilot before each step and the runner after it. */
function fly(f: Flown, seconds: number, pilot: (dt: number) => void) {
  for (let i = 0; i < seconds / SIM_DT && f.runner.state === 'running'; i++) {
    pilot(SIM_DT);
    f.ac.step(SIM_DT, f.env);
    const g = ecefToGeodetic(f.ac.state.position);
    // The test world has no geoid: height above the ellipsoid is height above the sea.
    f.place.lon = g.lon;
    f.place.lat = g.lat;
    f.place.msl = g.height;
    f.runner.update(SIM_DT, f.ac.telemetry, f.ac.cockpit, f.place);
  }
}

describe('lessons flown by a scripted pilot', () => {
  it('passes the first take-off at Bern', () => {
    const lesson = findLesson('first-takeoff')!;
    const f = start(lesson);
    const { ac } = f;
    const t = ac.telemetry;
    const c = ac.controls;
    const course = RunwayGeometry.of('LSZB', '32')!.course;
    const attitude = new AttitudePilot(ac);
    const climb = new Pid(0.03, 0.01, 0, 0.3);
    let airborne = false;
    fly(f, 240, (dt) => {
      c.throttle[0] = 1;
      const heading = headingError(course, t.headingDeg);
      if (!airborne) {
        c.yaw = clamp(0.15 * heading - 0.6 * ac.state.angularVelocity.z, -1, 1);
        attitude.bankTo(0, dt);
        if (t.ias / KT >= 55) attitude.pitchTo(10 * DEG, dt);
        else c.pitch = 0;
        airborne = (t.agl ?? 0) > 3;
      } else {
        attitude.pitchTo(8 * DEG + climb.update(t.ias / KT - 74, dt), dt);
        attitude.bankTo(clamp(0.03 * heading, -0.3, 0.3), dt);
        attitude.ball();
      }
    });
    const v = f.runner.view();
    expect(t.crashed).toBeUndefined();
    expect(v.state, JSON.stringify(v)).toBe('passed');
    expect(
      v.debrief!.every((d) => d.ok),
      JSON.stringify(v.debrief),
    ).toBe(true);
  }, 60_000);

  it('passes the approach and landing at Bern 14', () => {
    const lesson = findLesson('landing')!;
    const f = start(lesson);
    const { ac, runner } = f;
    const t = ac.telemetry;
    const c = ac.controls;
    const rw = RunwayGeometry.of('LSZB', '14')!;
    const pos = { centrelineM: 0, alongM: 0, pathFt: 0, runwayHeightFt: 0 };
    const tanPath = Math.tan(rw.pathAngleDeg * DEG);
    const attitude = new AttitudePilot(ac);
    const speed = new Pid(0.04, 0.01, 0, 1);
    const path = new Pid(0.02, 0.004, 0, 0.15);
    const flare = new Pid(0.25, 0.25, 0, 0.25);
    let phase: 'approach' | 'flare' | 'rollout' = 'approach';
    let flareTheta = 0;
    let rolled = 0;
    ac.cockpit.set('flaps', 2);
    fly(f, 300, (dt) => {
      rw.measure(f.place.lon, f.place.lat, f.place.msl, pos);
      const agl = t.agl ?? 100;
      // Flaps 30 and approach speed once the instructor asks for them.
      const target = runner.step >= 1 ? 65 : 70;
      if (runner.step >= 1) ac.cockpit.set('flaps', 3);
      // Back to the centre line through the heading, wings no more than 15 degrees.
      const wanted = rw.course - clamp(0.3 * pos.centrelineM, -15, 15);
      const heading = headingError(wanted, t.headingDeg);
      if (phase === 'approach') {
        // The path's sink rate, and a little more or less to get back onto it.
        const vsTarget = -t.groundSpeed * tanPath - clamp(0.05 * pos.pathFt * FT, -1.5, 1.5);
        attitude.pitchTo(-2 * DEG - path.update(t.verticalSpeed - vsTarget, dt), dt);
        c.throttle[0] = clamp(0.3 + speed.update(target - t.ias / KT, dt), 0, 1);
        attitude.bankTo(clamp(0.03 * heading, -0.25, 0.25), dt);
        attitude.ball();
        if (agl < 6) {
          phase = 'flare';
          flareTheta = t.pitch;
        }
      } else if (phase === 'flare') {
        c.throttle[0] = 0;
        const vsTarget = -0.25 - 0.4 * Math.max(agl - 0.3, 0);
        attitude.pitchTo(
          clamp(flareTheta + flare.update(vsTarget - t.verticalSpeed, dt), -2 * DEG, 10 * DEG),
          dt,
        );
        attitude.bankTo(0, dt);
        attitude.ball();
        if (t.onGround) phase = 'rollout';
      } else {
        rolled += dt;
        c.throttle[0] = 0;
        c.yaw = clamp(0.15 * heading - 0.6 * ac.state.angularVelocity.z, -1, 1);
        c.pitch = rolled < 1 ? -0.3 : 0.3;
        c.brakeLeft = c.brakeRight = rolled > 1 ? 1 : 0;
      }
    });
    const v = runner.view();
    expect(t.crashed).toBeUndefined();
    expect(v.state, JSON.stringify(v)).toBe('passed');
    expect(
      v.debrief!.every((d) => d.ok),
      JSON.stringify(v.debrief),
    ).toBe(true);
  }, 60_000);

  it('passes the turns: 30 degrees of bank onto headings, altitude held', () => {
    const lesson = findLesson('turns')!;
    const f = start(lesson);
    const { ac, runner } = f;
    const t = ac.telemetry;
    const attitude = new AttitudePilot(ac);
    const alt = new Pid(0.004, 0.0004, 0, 0.3);
    const h0 = t.altitude;
    const base = t.pitch;
    const north = t.headingDeg;
    const throttle = ac.controls.throttle[0]!;
    fly(f, 400, (dt) => {
      attitude.pitchTo(base + alt.update(h0 - t.altitude - 2 * t.verticalSpeed, dt), dt);
      // A little more power in the turn, as the instructor would have it.
      ac.controls.throttle[0] = Math.abs(t.bank) > 10 * DEG ? throttle + 0.08 : throttle;
      const steer = (heading: number) =>
        clamp(0.03 * headingError(heading, t.headingDeg), -30 * DEG, 30 * DEG);
      const bank = [-30 * DEG, steer(north - 90), 30 * DEG, steer(north + 90), steer(north + 90)][
        runner.step
      ]!;
      attitude.bankTo(bank, dt);
      attitude.ball();
    });
    const v = runner.view();
    expect(v.state, JSON.stringify(v)).toBe('passed');
    expect(
      v.debrief!.every((d) => d.ok),
      JSON.stringify(v.debrief),
    ).toBe(true);
  }, 60_000);

  /** The A320 on final for Zurich 14 as the app sets it up: ILS tuned, autothrust on. */
  function a320OnFinal(retard: boolean) {
    const f = start(findLesson('a320-autoland')!);
    const { ac, runner } = f;
    const c = ac.cockpit;
    const t = ac.telemetry;
    ac.avionics.setDatabase(navDatabase());
    c.set('nav1Active', ilsFor('LSZH', '14')!.frequency);
    c.set('throttle1', 0.62);
    c.set('throttle2', 0.62);
    // A button is pressed for one step and released the next, as a finger does.
    let held: string | undefined;
    const press = (id: string) => {
      c.set(id, 1);
      held = id;
    };
    // Autothrust on, as the app does for a start in the air.
    c.set('athr', 1);
    ac.step(SIM_DT, f.env);
    c.set('athr', 0);
    let callout = false;
    fly(f, 600, () => {
      const fcu = t.avionics!.autopilot.airbus!.fcu;
      if (held) {
        c.set(held, 0);
        held = undefined;
      } else if (runner.step === 0 && !fcu.appr) press('fcuAppr');
      else if (runner.step === 1) press(fcu.ap1 ? 'ap2' : 'ap1');
      if (runner.step === 2) {
        c.set('flaps', 4);
        c.set('autobrake', 1);
        c.set('spoilersArmed', 1);
      }
      callout ||= t.avionics!.autopilot.airbus!.guidance.callout === 'RETARD';
      if (retard && callout) {
        c.set('throttle1', 0);
        c.set('throttle2', 0);
      }
    });
    return f;
  }

  it('passes the A320 automatic landing at Zurich when the levers come back at RETARD', () => {
    const f = a320OnFinal(true);
    const v = f.runner.view();
    expect(f.ac.telemetry.crashed).toBeUndefined();
    expect(v.state, JSON.stringify(v)).toBe('passed');
    expect(
      v.debrief!.every((d) => d.ok),
      JSON.stringify(v.debrief),
    ).toBe(true);
    expect(f.ac.telemetry.avionics!.autopilot.airbus!.controls.groundSpoilers).toBe(true);
  }, 120_000);

  it('fails the automatic landing when the levers stay in the climb detent', () => {
    const f = a320OnFinal(false);
    const v = f.runner.view();
    expect(v.state).toBe('failed');
    expect(v.step).toBe(4);
    expect(v.instruction.en).toContain('ground spoilers and autobrake stayed in');
    // On the wheels with the levers forward: the spoilers never came out.
    expect(f.ac.telemetry.avionics!.autopilot.airbus!.controls.groundSpoilers).toBe(false);
  }, 120_000);
});
