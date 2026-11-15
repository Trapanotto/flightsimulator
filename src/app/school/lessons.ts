/**
 * The curriculum of the flight school, in teaching order: from the first take-off in the
 * Cessna at Bern to an ILS in low stratus, then one conversion lesson for each other type.
 * Speeds come from the types' own data (`AIRCRAFT`: rotation, approach and stall speeds,
 * which the handbook tests check); the others are handbook figures named where they are used.
 *
 * The instructor speaks calmly and briefly; German is written the Swiss way (ss, never the
 * sharp s). Altitudes held after an air start are relative to where the lesson began: the
 * plan starts there, so "hold 5000 ft" and the condition agree whatever the altimeter says.
 */
import { AIRCRAFT, type AircraftId } from '@sim';
import type { Bilingual, Cond, HintDef, LessonDef, MeasureDef, Reference, ValueKey } from './types';

const KT = 1.943844;
const FT = 0.3048;

const t = (de: string, en: string): Bilingual => ({ de, en });

/** A speed of a type's data, knots, rounded as a pilot says it. */
function knots(id: AircraftId, field: 'vRotate' | 'vApproach' | 'vs' | 'vs0'): number {
  const info = AIRCRAFT.find((a) => a.id === id);
  const v = info?.[field];
  if (v === undefined) throw new Error(`lessons: ${id} has no ${field}`);
  return Math.round(v * KT);
}

// ---- condition builders ----------------------------------------------------------------

type Opt = { rel?: Reference; abs?: boolean };
const band = (value: ValueKey, min: number, max: number, o: Opt = {}): Cond => ({
  value,
  min,
  max,
  ...o,
});
const atLeast = (value: ValueKey, min: number, o: Opt = {}): Cond => ({ value, min, ...o });
const atMost = (value: ValueKey, max: number, o: Opt = {}): Cond => ({ value, max, ...o });
const all = (...c: Cond[]): Cond => ({ all: c });
const any = (...c: Cond[]): Cond => ({ any: c });
const not = (c: Cond): Cond => ({ not: c });
const control = (id: string, is: number | string | readonly string[]): Cond => ({
  control: id,
  is,
});
const lever = (id: string, min?: number, max?: number): Cond =>
  min === undefined
    ? { control: id, max }
    : max === undefined
      ? { control: id, min }
      : { control: id, min, max };

const airborne = atMost('onGround', 0);
const onGround = atLeast('onGround', 1);
const wingsLevel = atMost('bankDeg', 5, { abs: true });
const levelFlight = atMost('verticalSpeedFpm', 200, { abs: true });
/** Within `ft` of the lesson's starting altitude plus `offset`. */
const altitude = (offset: number, ft: number): Cond =>
  band('altitudeFt', offset - ft, offset + ft, { rel: 'lesson' });
/** Heading `deg` from the heading the lesson began with (a runway's, an air start's). */
const turned = (deg: number, within: number): Cond => ({ heading: deg, within, rel: 'lesson' });
const hint = (when: Cond, say: Bilingual, after?: number): HintDef =>
  after === undefined ? { when, say } : { when, say, after };

// ---- texts and hints used in several lessons ------------------------------------------

const STALL_WARNING = hint(
  atLeast('stallWarning', 1),
  t(
    'Überziehwarnung: Nase etwas senken, Gas geben.',
    'Stall warning: lower the nose a little, add power.',
  ),
  0.3,
);
const STOP: Bilingual = t(
  'Bremsen und auf der Mittellinie anhalten.',
  'Brake and come to a stop on the centre line.',
);
const stopped = all(onGround, atMost('groundSpeedKt', 3));

const offCentre = (metres: number): HintDef[] => [
  hint(
    atLeast('centrelineM', metres),
    t(
      'Du bist rechts der Pistenachse: nach links korrigieren.',
      'You are right of the centre line: correct to the left.',
    ),
  ),
  hint(
    atMost('centrelineM', -metres),
    t(
      'Du bist links der Pistenachse: nach rechts korrigieren.',
      'You are left of the centre line: correct to the right.',
    ),
  ),
];

const speedHints = (target: number, below: number, above: number): HintDef[] => [
  hint(
    atMost('iasKt', target - below),
    t(
      `Zu langsam: Nase etwas senken, ${target} Knoten.`,
      `Too slow: lower the nose a little, ${target} knots.`,
    ),
  ),
  hint(
    atLeast('iasKt', target + above),
    t(
      `Zu schnell: Nase etwas anheben, ${target} Knoten.`,
      `Too fast: raise the nose a little, ${target} knots.`,
    ),
  ),
];

/** On an approach the speed is held with power and the path with the nose. */
const approachSpeedHints = (target: number): HintDef[] => [
  hint(
    atMost('iasKt', target - 5),
    t(
      `Zu langsam: etwas mehr Gas, ${target} Knoten.`,
      `Too slow: a little more power, ${target} knots.`,
    ),
  ),
  hint(
    atLeast('iasKt', target + 8),
    t(
      `Zu schnell: Gas etwas zurück, ${target} Knoten.`,
      `Too fast: a little less power, ${target} knots.`,
    ),
  ),
];

const pathHints: HintDef[] = [
  hint(
    atMost('pathFt', -80),
    t(
      'Unter dem Gleitweg: weniger sinken, etwas Gas dazu.',
      'Below the glide path: sink less, add a little power.',
    ),
    2,
  ),
  hint(
    atLeast('pathFt', 120),
    t(
      'Über dem Gleitweg: Gas etwas zurück, mehr sinken.',
      'Above the glide path: a little less power, sink more.',
    ),
    2,
  ),
];

/** Hints off an altitude `offset` feet from the lesson's start, which is `altitudeFt`. */
const altitudeHints = (offset: number, ft: number, altitudeFt: number): HintDef[] => [
  hint(
    band('altitudeFt', offset + ft, offset + 5000, { rel: 'lesson' }),
    t(
      `Du steigst über ${altitudeFt} Fuss: Nase leicht senken.`,
      `You are climbing above ${altitudeFt} feet: lower the nose slightly.`,
    ),
  ),
  hint(
    band('altitudeFt', offset - 5000, offset - ft, { rel: 'lesson' }),
    t(
      `Du bist unter ${altitudeFt} Fuss: Nase leicht anheben.`,
      `You are below ${altitudeFt} feet: raise the nose slightly.`,
    ),
  ),
];

const touchdownSink = (maxFpm: number): MeasureDef => ({
  kind: 'touchdown',
  label: t('Sinkrate beim Aufsetzen', 'Sink rate at touchdown'),
  field: 'sinkFpm',
  unit: 'ft/min',
  ok: { max: maxFpm },
});
const touchdownCentre = (maxM: number): MeasureDef => ({
  kind: 'touchdown',
  label: t('Abstand zur Mittellinie beim Aufsetzen', 'Off the centre line at touchdown'),
  field: 'centrelineM',
  abs: true,
  unit: 'm',
  ok: { max: maxM },
});
const speedKept = (
  target: number,
  steps: string[],
  settle: number,
  label?: Bilingual,
): MeasureDef => ({
  kind: 'range',
  label: label ?? t(`${target} Knoten gehalten`, `${target} knots kept`),
  value: 'iasKt',
  steps,
  report: 'maxAbs',
  target,
  settle,
  unit: 'kt',
  ok: { max: 10 },
});
const altitudeKept = (
  offset: number,
  steps: string[],
  settle: number,
  label: Bilingual,
): MeasureDef => ({
  kind: 'range',
  label,
  value: 'altitudeFt',
  steps,
  report: 'maxAbs',
  target: offset,
  rel: 'lesson',
  settle,
  unit: 'ft',
  ok: { max: 100 },
});

// ---- the Cessna's figures ----------------------------------------------------------------

const C172_VR = knots('c172', 'vRotate');
const C172_VAPP = knots('c172', 'vApproach');
/** POH section 4: best rate of climb 74 KIAS at sea level, normal climb 75 to 85. */
const C172_VY = 74;
/** Slow flight a few knots above the flaps-up stall speed. */
const C172_SLOW = knots('c172', 'vs') + 7;

/**
 * Bern-Belp. Take-offs use runway 32: it climbs out over the low Aare valley towards the city
 * rather than at the Belpberg beyond the end of 14, and its right-hand circuit stays east of
 * the field, clear of the Gurten. Landings use 14 with its ILS (a steep 4 degrees).
 */
const BERN = 'LSZB';
const clearDay = { time: 10, weather: 'clear', season: 'summer', atc: false } as const;

// ---- 1 first take-off -------------------------------------------------------------------

const firstTakeoff: LessonDef = {
  id: 'first-takeoff',
  title: t('Der erste Start', 'The first take-off'),
  summary: t(
    'Gas geben, auf der Mittellinie bleiben, rotieren und mit der richtigen Fahrt steigen. In der Cessna auf der Piste 32 in Bern-Belp.',
    'Open the throttle, stay on the centre line, rotate and climb at the right speed. In the Cessna on runway 32 at Bern-Belp.',
  ),
  aircraft: 'c172',
  minutes: 4,
  plan: {
    aircraft: 'c172',
    start: { kind: 'runway', airport: BERN, runway: '32' },
    airport: BERN,
    ...clearDay,
  },
  steps: [
    {
      id: 'power',
      say: t(
        'Wir stehen auf der Piste 32 in Bern. Schieb den Gashebel ruhig ganz nach vorne: Vollgas.',
        'We are lined up on runway 32 at Bern. Push the throttle smoothly all the way in: full power.',
      ),
      done: lever('throttle', 0.95),
    },
    {
      id: 'roll',
      say: t(
        `Halte die Mittellinie mit den Pedalen. Bei ${C172_VR} Knoten ziehst du sanft am Steuer.`,
        `Keep the centre line with the pedals. At ${C172_VR} knots ease the yoke back.`,
      ),
      done: all(airborne, atLeast('aglFt', 10)),
      hints: [
        hint(
          all(onGround, atLeast('iasKt', C172_VR + 8)),
          t('Jetzt rotieren: sanft ziehen.', 'Rotate now: ease the yoke back.'),
          0.5,
        ),
        hint(
          lever('throttle', 0, 0.9),
          t('Vollgas bleibt drin bis zur Reiseflughöhe.', 'Keep full power in for the climb.'),
        ),
        ...offCentre(6),
      ],
      fail: [
        {
          when: all(onGround, atLeast('centrelineM', 18, { abs: true })),
          say: t(
            'Wir sind neben der Piste. Noch einmal, mit mehr Pedal.',
            'We left the runway. Again, with more pedal.',
          ),
          after: 0.5,
        },
      ],
    },
    {
      id: 'climb',
      say: t(
        `Steige mit ${C172_VY} Knoten, der Fahrt für das beste Steigen. Flügel waagrecht.`,
        `Climb at ${C172_VY} knots, the speed for the best rate of climb. Wings level.`,
      ),
      done: atLeast('aglFt', 500),
      hints: [
        ...speedHints(C172_VY, 8, 10),
        hint(
          atLeast('bankDeg', 10, { abs: true }),
          t('Flügel waagrecht halten.', 'Keep the wings level.'),
        ),
      ],
    },
    {
      id: 'thousand',
      say: t(
        'So ist es gut. Weiter so bis 1000 Fuss über Grund.',
        'That is it. Carry on up to 1000 feet above the ground.',
      ),
      done: atLeast('aglFt', 1000),
      hints: [...speedHints(C172_VY, 8, 10)],
    },
  ],
  hints: [STALL_WARNING],
  debrief: [
    {
      kind: 'liftoff',
      label: t('Fahrt beim Abheben', 'Speed at lift-off'),
      field: 'iasKt',
      unit: 'kt',
      ok: { min: C172_VR - 7, max: C172_VR + 10 },
    },
    {
      kind: 'liftoff',
      label: t('Abstand zur Mittellinie beim Abheben', 'Off the centre line at lift-off'),
      field: 'centrelineM',
      abs: true,
      unit: 'm',
      ok: { max: 5 },
    },
    speedKept(
      C172_VY,
      ['climb', 'thousand'],
      12,
      t(`Steigfahrt ${C172_VY} Knoten gehalten`, `Climb speed ${C172_VY} knots kept`),
    ),
  ],
  closing: t(
    'Dein erster Start. Gut gemacht! Als Nächstes lernen wir geradeaus und waagrecht zu fliegen.',
    'Your first take-off. Well done! Next we learn to fly straight and level.',
  ),
};

// ---- 2 straight and level, climbs, descents ---------------------------------------------

/** Over the Mittelland north-west of Bern, flying west: nothing high ahead. */
const MITTELLAND = { lon: 7.42, lat: 46.99 };

const straightLevel: LessonDef = {
  id: 'straight-level',
  title: t('Geradeaus, Steigen, Sinken', 'Straight and level, climbs, descents'),
  summary: t(
    'Höhe und Kurs halten, mit der Trimmung entlasten, auf eine neue Höhe steigen und wieder sinken.',
    'Hold altitude and heading, trim the pressure off, climb to a new altitude and descend again.',
  ),
  aircraft: 'c172',
  minutes: 8,
  plan: {
    aircraft: 'c172',
    start: { kind: 'air', ...MITTELLAND, altitude: 5000 * FT, headingDeg: 270, speed: 100 / KT },
    airport: BERN,
    ...clearDay,
  },
  steps: [
    {
      id: 'level',
      say: t(
        'Wir fliegen auf 5000 Fuss. Flügel waagrecht, Höhe halten. Mit der Trimmung nimmst du den Druck vom Steuer.',
        'We are at 5000 feet. Wings level, hold the altitude. Trim the pressure off the yoke.',
      ),
      done: all(wingsLevel, altitude(0, 100), levelFlight),
      hold: 20,
      hints: [...altitudeHints(0, 100, 5000)],
    },
    {
      id: 'climb',
      say: t(
        `Steigflug auf 6000 Fuss: Vollgas, Nase anheben, bis die Fahrt bei ${C172_VY} Knoten steht.`,
        `Climb to 6000 feet: full power, raise the nose until the speed settles at ${C172_VY} knots.`,
      ),
      done: altitude(1000, 60),
      hints: [
        hint(lever('throttle', 0, 0.85), t('Zum Steigen Vollgas.', 'Full power for the climb.'), 3),
        ...speedHints(C172_VY, 8, 10),
      ],
    },
    {
      id: 'levelHigh',
      say: t(
        'Auf 6000 Fuss ausleveln: Nase senken, Fahrt aufholen lassen, Gas auf 2300 Umdrehungen. Dann trimmen.',
        'Level off at 6000 feet: lower the nose, let the speed build, power to 2300 rpm. Then trim.',
      ),
      done: all(altitude(1000, 100), levelFlight, wingsLevel),
      hold: 15,
      hints: [...altitudeHints(1000, 100, 6000)],
    },
    {
      id: 'descent',
      say: t(
        'Sinkflug zurück auf 5000 Fuss: Gas auf etwa 1800 Umdrehungen, mit 500 Fuss pro Minute sinken.',
        'Descend back to 5000 feet: power to about 1800 rpm, down at 500 feet per minute.',
      ),
      done: altitude(0, 60),
      hints: [
        hint(
          atMost('verticalSpeedFpm', -1000),
          t('Zu steil: etwa 500 Fuss pro Minute.', 'Too steep: about 500 feet per minute.'),
        ),
        hint(
          atLeast('iasKt', 125),
          t(
            'Zu schnell: Nase etwas anheben, Gas zurück.',
            'Too fast: raise the nose a little, less power.',
          ),
        ),
        hint(
          all(atLeast('verticalSpeedFpm', -150), atLeast('stepTime', 15)),
          t(
            'Wir sinken noch nicht: Gas zurück, Nase leicht senken.',
            'We are not descending yet: less power, lower the nose slightly.',
          ),
        ),
      ],
    },
    {
      id: 'levelLow',
      say: t('Auf 5000 Fuss ausleveln und trimmen.', 'Level off at 5000 feet and trim.'),
      done: all(altitude(0, 100), levelFlight, wingsLevel),
      hold: 15,
      hints: [...altitudeHints(0, 100, 5000)],
    },
  ],
  hints: [STALL_WARNING],
  fail: [
    {
      when: atLeast('altitudeFt', 1000, { rel: 'lesson', abs: true }),
      say: t(
        'Zu weit von der Höhe weg. Wir fangen neu an.',
        'Too far from the altitude. Let us start over.',
      ),
      after: 2,
    },
  ],
  debrief: [
    altitudeKept(0, ['level'], 0, t('5000 Fuss gehalten', '5000 feet kept')),
    altitudeKept(1000, ['levelHigh'], 15, t('6000 Fuss gehalten', '6000 feet kept')),
    speedKept(
      C172_VY,
      ['climb'],
      20,
      t(`Steigfahrt ${C172_VY} Knoten gehalten`, `Climb speed ${C172_VY} knots kept`),
    ),
    altitudeKept(0, ['levelLow'], 15, t('Zurück auf 5000 Fuss gehalten', 'Back at 5000 feet kept')),
  ],
};

// ---- 3 turns ---------------------------------------------------------------------------

const turns: LessonDef = {
  id: 'turns',
  title: t('Kurven', 'Turns'),
  summary: t(
    'Mit 30 Grad Querlage auf einen neuen Kurs drehen und dabei die Höhe halten.',
    'Turn onto a new heading at 30 degrees of bank while holding the altitude.',
  ),
  aircraft: 'c172',
  minutes: 6,
  plan: {
    aircraft: 'c172',
    start: {
      kind: 'air',
      lon: 7.4,
      lat: 47.02,
      altitude: 5000 * FT,
      headingDeg: 0,
      speed: 100 / KT,
    },
    airport: BERN,
    ...clearDay,
  },
  steps: [
    {
      id: 'left',
      say: t(
        'Linkskurve mit 30 Grad Querlage: Steuer nach links, mit dem linken Pedal mitgehen, etwas ziehen, damit die Höhe bleibt.',
        'Left turn at 30 degrees of bank: yoke to the left, a little left pedal with it, a little back pressure to hold the altitude.',
      ),
      done: band('bankDeg', -35, -25),
      hold: 5,
      hints: [
        hint(
          atMost('bankDeg', -40),
          t('Zu steil: zurück auf 30 Grad.', 'Too steep: back to 30 degrees.'),
        ),
      ],
    },
    {
      id: 'outWest',
      say: t(
        'Ausleiten auf Westkurs, 270: etwa 15 Grad vorher die Flügel zurück auf waagrecht.',
        'Roll out heading west, 270: level the wings about 15 degrees before.',
      ),
      done: all(turned(-90, 10), wingsLevel),
      hints: [
        hint(
          all(turned(-115, 12), atMost('bankDeg', -10)),
          t('Über den Kurs hinaus: jetzt ausleiten.', 'Past the heading: roll out now.'),
          0.5,
        ),
      ],
    },
    {
      id: 'right',
      say: t(
        'Jetzt eine Rechtskurve mit 30 Grad, ganz herum auf Ostkurs, 090.',
        'Now a right turn at 30 degrees, all the way round to heading east, 090.',
      ),
      done: band('bankDeg', 25, 35),
      hold: 5,
      hints: [
        hint(
          atLeast('bankDeg', 40),
          t('Zu steil: zurück auf 30 Grad.', 'Too steep: back to 30 degrees.'),
        ),
      ],
    },
    {
      id: 'outEast',
      say: t(
        'Halte 30 Grad und die Höhe. Ausleiten auf 090.',
        'Hold 30 degrees and the altitude. Roll out on 090.',
      ),
      done: all(turned(90, 10), wingsLevel),
      hints: [
        hint(
          all(atMost('bankDeg', 20), not(turned(90, 20))),
          t('Mehr Querlage: 30 Grad.', 'More bank: 30 degrees.'),
          2,
        ),
      ],
    },
    {
      id: 'straight',
      say: t('Geradeaus auf 090, Höhe halten.', 'Straight ahead on 090, hold the altitude.'),
      done: all(wingsLevel, altitude(0, 100), turned(90, 10)),
      hold: 10,
    },
  ],
  hints: [STALL_WARNING, ...altitudeHints(0, 150, 5000)],
  fail: [
    {
      when: atLeast('altitudeFt', 600, { rel: 'lesson', abs: true }),
      say: t(
        'Mehr als 600 Fuss von der Höhe weg. Wir üben das noch einmal.',
        'More than 600 feet off the altitude. Let us practise it again.',
      ),
      after: 3,
    },
  ],
  debrief: [
    altitudeKept(
      0,
      ['left', 'outWest', 'right', 'outEast', 'straight'],
      0,
      t('Höhe in den Kurven gehalten', 'Altitude kept in the turns'),
    ),
    {
      kind: 'range',
      label: t('Grösste Querlage', 'Steepest bank'),
      value: 'bankDeg',
      steps: ['left', 'outWest', 'right', 'outEast'],
      report: 'maxAbs',
      unit: '°',
      ok: { min: 25, max: 38 },
    },
  ],
};

// ---- 4 slow flight and stall -------------------------------------------------------------

const slowFlight: LessonDef = {
  id: 'slow-flight',
  title: t('Langsamflug und Überziehen', 'Slow flight and stall recovery'),
  summary: t(
    'Knapp über der Überziehgeschwindigkeit fliegen, den Strömungsabriss erleben und sicher ausleiten.',
    'Fly just above the stall speed, feel the stall and recover safely.',
  ),
  aircraft: 'c172',
  minutes: 8,
  plan: {
    aircraft: 'c172',
    start: {
      kind: 'air',
      lon: 7.35,
      lat: 47.05,
      altitude: 6500 * FT,
      headingDeg: 70,
      speed: 100 / KT,
    },
    airport: BERN,
    ...clearDay,
  },
  steps: [
    {
      id: 'slowDown',
      say: t(
        `Gas zurück auf 1500 Umdrehungen und die Höhe halten: die Nase kommt langsam höher, die Fahrt geht auf ${C172_SLOW} Knoten zurück.`,
        `Power back to 1500 rpm and hold the altitude: the nose comes up slowly, the speed falls to ${C172_SLOW} knots.`,
      ),
      done: all(band('iasKt', C172_SLOW - 5, C172_SLOW + 5), altitude(0, 150)),
      hold: 3,
      hints: [...altitudeHints(0, 150, 6500)],
    },
    {
      id: 'slowFlight',
      say: t(
        `Langsamflug: ${C172_SLOW} Knoten mit der Nase, die Höhe mit dem Gas. Das Steuer ist weich, das ist normal.`,
        `Slow flight: ${C172_SLOW} knots with the nose, the altitude with power. The controls feel soft, that is normal.`,
      ),
      done: all(
        band('iasKt', C172_SLOW - 5, C172_SLOW + 5),
        altitude(0, 150),
        atMost('bankDeg', 10, { abs: true }),
      ),
      hold: 20,
      hints: [
        hint(
          atMost('iasKt', C172_SLOW - 5),
          t('Zu langsam: Nase etwas senken.', 'Too slow: lower the nose a little.'),
        ),
        hint(
          atLeast('iasKt', C172_SLOW + 5),
          t('Zu schnell: Nase etwas anheben.', 'Too fast: raise the nose a little.'),
        ),
        hint(
          band('altitudeFt', -5000, -150, { rel: 'lesson' }),
          t('Wir sinken: etwas mehr Gas.', 'We are sinking: a little more power.'),
        ),
        hint(
          band('altitudeFt', 150, 5000, { rel: 'lesson' }),
          t('Wir steigen: etwas weniger Gas.', 'We are climbing: a little less power.'),
        ),
      ],
    },
    {
      id: 'stall',
      say: t(
        'Jetzt Gas ganz zurück. Halte die Nase oben und zieh weiter sanft, bis die Überziehwarnung tönt und die Nase fällt.',
        'Now close the throttle. Keep the nose up and keep easing back until the stall warning sounds and the nose drops.',
      ),
      done: all(atLeast('stallWarning', 1), atMost('iasKt', knots('c172', 'vs') + 4)),
      hold: 1.5,
      hints: [
        hint(lever('throttle', 0.1), t('Gas ganz zurück.', 'Throttle fully closed.')),
        hint(
          all(atLeast('iasKt', C172_SLOW), atLeast('stepTime', 10)),
          t('Weiter ziehen, langsam.', 'Keep easing back, slowly.'),
        ),
      ],
    },
    {
      id: 'recover',
      say: t(
        'Ausleiten: Nase senken, Vollgas, Flügel mit dem Seitenruder waagrecht.',
        'Recover: lower the nose, full power, wings level with the rudder.',
      ),
      done: all(
        lever('throttle', 0.9),
        atLeast('iasKt', C172_VY - 12),
        atMost('bankDeg', 10, { abs: true }),
        atLeast('verticalSpeedFpm', 0),
      ),
      hints: [
        hint(lever('throttle', 0, 0.9), t('Vollgas!', 'Full power!'), 0.5),
        hint(atLeast('bankDeg', 15, { abs: true }), t('Flügel waagrecht.', 'Wings level.'), 0.5),
        hint(
          all(atMost('verticalSpeedFpm', -800), atLeast('iasKt', C172_VY)),
          t('Genug Fahrt: jetzt sanft abfangen.', 'Enough speed: now ease out of the dive.'),
        ),
      ],
    },
    {
      id: 'climb',
      say: t(`Gut. Steige mit ${C172_VY} Knoten.`, `Good. Climb at ${C172_VY} knots.`),
      done: all(atLeast('verticalSpeedFpm', 300), band('iasKt', C172_VY - 8, C172_VY + 10)),
      hold: 5,
      hints: [...speedHints(C172_VY, 8, 10)],
    },
  ],
  fail: [
    {
      when: atMost('altitudeFt', -1500, { rel: 'lesson' }),
      say: t(
        'Wir haben zu viel Höhe verloren. Noch einmal, früher ausleiten.',
        'We lost too much height. Again, and recover sooner.',
      ),
    },
  ],
  debrief: [
    {
      kind: 'range',
      label: t(`${C172_SLOW} Knoten im Langsamflug`, `${C172_SLOW} knots in slow flight`),
      value: 'iasKt',
      steps: ['slowFlight'],
      report: 'maxAbs',
      target: C172_SLOW,
      settle: 3,
      unit: 'kt',
      ok: { max: 5 },
    },
    {
      kind: 'range',
      label: t('Höhenverlust beim Überziehen', 'Height lost in the stall'),
      value: 'altitudeFt',
      steps: ['stall', 'recover'],
      report: 'min',
      rel: 'lesson',
      unit: 'ft',
      ok: { min: -400 },
    },
  ],
};

// ---- 5 approach and landing --------------------------------------------------------------

const landing: LessonDef = {
  id: 'landing',
  title: t('Anflug und Landung', 'Approach and landing'),
  summary: t(
    'Im Endanflug auf Bern 14: Klappen, Anfluggeschwindigkeit, Gleitweg, Abfangen und Aufsetzen.',
    'On final for Bern 14: flaps, approach speed, glide path, flare and touchdown.',
  ),
  aircraft: 'c172',
  minutes: 4,
  plan: {
    aircraft: 'c172',
    start: { kind: 'approach', airport: BERN, runway: '14', distanceNm: 4 },
    airport: BERN,
    ...clearDay,
  },
  steps: [
    {
      id: 'slow',
      say: t(
        'Wir sind 4 Meilen vor der Piste 14. Klappen 20, Gas etwas zurück: 70 Knoten. Der Gleitweg in Bern ist steil, 4 Grad.',
        'We are 4 miles out from runway 14. Flaps 20, a little less power: 70 knots. The glide path at Bern is steep, 4 degrees.',
      ),
      done: all(control('flaps', ['20', '30']), band('iasKt', C172_VAPP, C172_VAPP + 10)),
      hold: 2,
      hints: [...approachSpeedHints(70)],
    },
    {
      id: 'final',
      say: t(
        `Klappen 30, ${C172_VAPP} Knoten. Halte die Pistenschwelle im Blick: sie bleibt am gleichen Ort in der Scheibe.`,
        `Flaps 30, ${C172_VAPP} knots. Keep your eye on the threshold: it stays in the same place on the windscreen.`,
      ),
      done: all(control('flaps', '30'), band('iasKt', C172_VAPP - 5, C172_VAPP + 7)),
      hold: 3,
      hints: [...approachSpeedHints(C172_VAPP), ...pathHints, ...offCentre(25)],
    },
    {
      id: 'short',
      say: t(
        `Bleib auf ${C172_VAPP} Knoten und auf dem Gleitweg bis kurz über die Piste.`,
        `Stay at ${C172_VAPP} knots and on the glide path until just above the runway.`,
      ),
      done: atMost('aglFt', 40),
      hints: [...approachSpeedHints(C172_VAPP), ...pathHints, ...offCentre(15)],
      fail: [
        {
          when: all(atMost('aglFt', 150), atLeast('centrelineM', 80, { abs: true })),
          say: t(
            'Zu weit neben der Piste: durchstarten. Wir versuchen es noch einmal.',
            'Too far off the runway: go around. Let us try again.',
          ),
          after: 2,
        },
      ],
    },
    {
      id: 'flare',
      say: t(
        'Gas ganz raus. Den Blick ans Pistenende, die Nase langsam anheben und das Flugzeug sanft aufsetzen lassen.',
        'Throttle to idle. Look to the far end, raise the nose slowly and let it settle gently.',
      ),
      done: onGround,
      hints: [
        hint(
          all(atMost('aglFt', 20), atMost('verticalSpeedFpm', -500)),
          t('Abfangen: Nase anheben.', 'Flare: raise the nose.'),
          0.2,
        ),
        hint(lever('throttle', 0.15), t('Gas ganz raus.', 'Throttle to idle.'), 1),
      ],
    },
    { id: 'stop', say: STOP, done: stopped, hold: 1, hints: [...offCentre(8)] },
  ],
  hints: [STALL_WARNING],
  debrief: [
    touchdownSink(400),
    touchdownCentre(6),
    {
      kind: 'touchdown',
      label: t('Aufgesetzt nach der Schwelle', 'Touched down past the threshold'),
      field: 'pastThresholdM',
      unit: 'm',
      ok: { min: 0, max: 600 },
    },
    speedKept(
      C172_VAPP,
      ['short'],
      0,
      t(`Anflug mit ${C172_VAPP} Knoten`, `Approach at ${C172_VAPP} knots`),
    ),
  ],
};

// ---- 6 traffic pattern ----------------------------------------------------------------

const circuit: LessonDef = {
  id: 'circuit',
  title: t('Die Platzrunde', 'The traffic pattern'),
  summary: t(
    'Start, Platzrunde auf 1000 Fuss über Grund und Landung: alles aus den ersten Lektionen in einem Flug.',
    'Take-off, a circuit at 1000 feet above the ground and a landing: everything from the first lessons in one flight.',
  ),
  aircraft: 'c172',
  minutes: 10,
  plan: {
    aircraft: 'c172',
    start: { kind: 'runway', airport: BERN, runway: '32' },
    airport: BERN,
    ...clearDay,
  },
  steps: [
    {
      id: 'takeoff',
      say: t(
        `Eine Rechtsvolte auf der 32. Vollgas, rotieren bei ${C172_VR} Knoten, steigen mit ${C172_VY}.`,
        `A right-hand circuit on runway 32. Full power, rotate at ${C172_VR} knots, climb at ${C172_VY}.`,
      ),
      done: all(airborne, atLeast('aglFt', 300)),
      hints: [...offCentre(6), ...speedHints(C172_VY, 12, 12)],
    },
    {
      id: 'crosswind',
      say: t(
        'Auf 500 Fuss über Grund rechts in den Querabflug drehen, 90 Grad. Weiter steigen.',
        'At 500 feet above the ground turn right onto crosswind, 90 degrees. Keep climbing.',
      ),
      done: all(turned(90, 15), atLeast('aglFt', 400)),
      hints: [
        hint(
          all(atLeast('aglFt', 550), turned(0, 20)),
          t('Jetzt rechts drehen.', 'Turn right now.'),
        ),
        ...speedHints(C172_VY, 10, 12),
      ],
    },
    {
      id: 'downwind',
      say: t(
        'Auf 1000 Fuss über Grund ausleveln und rechts in den Gegenanflug drehen. Gas auf 2300 Umdrehungen.',
        'Level off at 1000 feet above the ground and turn right onto downwind. Power to 2300 rpm.',
      ),
      done: all(turned(180, 15), band('aglFt', 850, 1150)),
      hints: [
        hint(
          atLeast('aglFt', 1200),
          t(
            'Die Volte ist auf 1000 Fuss über Grund.',
            'The circuit is at 1000 feet above the ground.',
          ),
        ),
      ],
    },
    {
      id: 'abeam',
      say: t(
        'Im Gegenanflug 1000 Fuss halten. Querab der Pistenschwelle: Gas auf 1700 Umdrehungen, Klappen 10.',
        'Hold 1000 feet on downwind. Abeam the threshold: power to 1700 rpm, flaps 10.',
      ),
      done: all(control('flaps', ['10', '20', '30']), atMost('alongM', 0)),
      hints: [
        hint(
          all(atMost('alongM', -300), control('flaps', '0')),
          t('Querab der Schwelle: Klappen 10.', 'Abeam the threshold: flaps 10.'),
        ),
        hint(atLeast('aglFt', 1150), t('Zu hoch: 1000 Fuss.', 'Too high: 1000 feet.'), 2),
        hint(atMost('aglFt', 850), t('Zu tief: 1000 Fuss.', 'Too low: 1000 feet.'), 2),
      ],
    },
    {
      id: 'base',
      say: t(
        'Wenn die Schwelle schräg hinter dir liegt: rechts in den Queranflug, Klappen 20, 70 Knoten, sinken.',
        'With the threshold behind you at 45 degrees: turn right onto base, flaps 20, 70 knots, descend.',
      ),
      done: all(turned(-90, 25), control('flaps', ['20', '30'])),
      hints: [
        hint(
          all(atMost('alongM', -2600), turned(180, 25)),
          t('Jetzt in den Queranflug drehen.', 'Turn onto base now.'),
        ),
      ],
    },
    {
      id: 'final',
      say: t(
        `Rechts in den Endanflug, auf die Pistenachse. Klappen 30, ${C172_VAPP} Knoten.`,
        `Turn right onto final, onto the centre line. Flaps 30, ${C172_VAPP} knots.`,
      ),
      done: all(turned(0, 15), atMost('centrelineM', 50, { abs: true }), control('flaps', '30')),
      hold: 3,
      hints: [...approachSpeedHints(C172_VAPP), ...offCentre(50)],
    },
    {
      id: 'touchdown',
      say: t(
        'Über der Schwelle Gas raus, abfangen und sanft aufsetzen.',
        'Over the threshold close the throttle, flare and touch down gently.',
      ),
      done: onGround,
      hints: [...offCentre(15), ...pathHints],
    },
    { id: 'stop', say: STOP, done: stopped, hold: 1 },
  ],
  hints: [STALL_WARNING],
  debrief: [
    {
      kind: 'range',
      label: t('Volten-Höhe 1000 Fuss gehalten', 'Circuit height of 1000 feet kept'),
      value: 'aglFt',
      steps: ['abeam'],
      report: 'maxAbs',
      target: 1000,
      settle: 10,
      unit: 'ft',
      ok: { max: 150 },
    },
    touchdownSink(400),
    touchdownCentre(6),
  ],
};

// ---- 7 radio navigation ---------------------------------------------------------------

/** Fribourg VOR-DME (FRI, 110.85), south-west of Bern. */
const FRI_KHZ = 110_850;

const vor: LessonDef = {
  id: 'vor',
  title: t('Funknavigation: zum VOR', 'Radio navigation: to a VOR'),
  summary: t(
    'Das VOR Fribourg einstellen, identifizieren, den Kurs zur Station finden und ihm bis über die Station folgen.',
    'Tune and identify the Fribourg VOR, find the course to the station and track it to overhead.',
  ),
  aircraft: 'c172',
  minutes: 12,
  plan: {
    aircraft: 'c172',
    start: {
      kind: 'air',
      lon: 7.5,
      lat: 46.95,
      altitude: 6000 * FT,
      headingDeg: 230,
      speed: 100 / KT,
    },
    airport: BERN,
    ...clearDay,
  },
  steps: [
    {
      id: 'tune',
      say: t(
        'Wir fliegen nach Fribourg. Stell NAV 1 auf das VOR Fribourg, FRI, 110.85.',
        'We fly to Fribourg. Set NAV 1 to the Fribourg VOR, FRI, 110.85.',
      ),
      done: lever('nav1Active', FRI_KHZ, FRI_KHZ),
      hints: [
        hint(
          lever('nav1Standby', FRI_KHZ, FRI_KHZ),
          t(
            'Die Frequenz steht bereit: mit der Wechseltaste aktivieren.',
            'The frequency is on standby: swap it to active.',
          ),
        ),
      ],
    },
    {
      id: 'ident',
      say: t(
        'Hör auf die Kennung: F R I im Morsecode. Erst dann trauen wir der Anzeige.',
        'Listen for the identifier: F R I in Morse code. Only then do we trust the indication.',
      ),
      done: { mode: 'nav1Ident', is: 'FRI' },
      hold: 2,
    },
    {
      id: 'centre',
      say: t(
        'Dreh am Kursknopf (OBS), bis die Nadel in der Mitte steht und TO zeigt. Das ist der Kurs zur Station.',
        'Turn the course knob (OBS) until the needle centres with TO showing. That is the course to the station.',
      ),
      done: all(atLeast('nav1ToFrom', 1), atMost('nav1Deviation', 0.1, { abs: true })),
      hold: 2,
      hints: [
        hint(
          atMost('nav1ToFrom', -1),
          t(
            'FROM: der Kurs zeigt weg von der Station. 180 Grad weiter drehen.',
            'FROM: that course leads away from the station. Turn the knob 180 degrees.',
          ),
        ),
      ],
    },
    {
      id: 'track',
      say: t(
        'Dreh auf diesen Kurs und halte die Nadel in der Mitte: kleine Korrekturen, immer zur Nadel hin.',
        'Turn onto that course and keep the needle centred: small corrections, always towards the needle.',
      ),
      done: all(atLeast('nav1ToFrom', 1), atMost('nav1Deviation', 0.3, { abs: true })),
      hold: 60,
      hints: [
        hint(
          atLeast('nav1Deviation', 0.3),
          t(
            'Nadel rechts: etwas nach rechts korrigieren.',
            'Needle right: correct a little to the right.',
          ),
        ),
        hint(
          atMost('nav1Deviation', -0.3),
          t(
            'Nadel links: etwas nach links korrigieren.',
            'Needle left: correct a little to the left.',
          ),
        ),
      ],
    },
    {
      id: 'overhead',
      say: t(
        'Bleib auf dem Kurs bis über die Station: dann springt die Anzeige auf FROM.',
        'Stay on the course until overhead the station: then the indicator flips to FROM.',
      ),
      done: all(atMost('nav1ToFrom', -1), atMost('dmeNm', 3)),
      hints: [
        hint(
          all(atLeast('nav1Deviation', 0.5), atLeast('dmeNm', 3)),
          t('Nadel rechts: nach rechts korrigieren.', 'Needle right: correct to the right.'),
        ),
        hint(
          all(atMost('nav1Deviation', -0.5), atLeast('dmeNm', 3)),
          t('Nadel links: nach links korrigieren.', 'Needle left: correct to the left.'),
        ),
      ],
      fail: [
        {
          when: all(atMost('nav1ToFrom', -1), atLeast('dmeNm', 4)),
          say: t(
            'Wir sind neben der Station vorbeigeflogen. Noch einmal, näher an der Nadel.',
            'We passed beside the station. Again, closer to the needle.',
          ),
          after: 2,
        },
      ],
    },
  ],
  hints: [STALL_WARNING, ...altitudeHints(0, 200, 6000)],
  debrief: [
    {
      kind: 'range',
      label: t(
        'Grösste Nadelablage (Vollausschlag = 100 %)',
        'Largest needle deflection (full scale = 100 %)',
      ),
      value: 'nav1Deviation',
      steps: ['track'],
      report: 'maxAbs',
      scale: 100,
      unit: '%',
      ok: { max: 50 },
    },
    {
      ...altitudeKept(0, ['track', 'overhead'], 0, t('6000 Fuss gehalten', '6000 feet kept')),
      ok: { max: 200 },
    },
  ],
};

// ---- 8 instrument approach ------------------------------------------------------------

const ZURICH = 'LSZH';

const ils: LessonDef = {
  id: 'ils',
  title: t('ILS-Anflug im Hochnebel', 'ILS approach in low stratus'),
  summary: t(
    'Der ILS-Anflug auf Zürich 14 im Hochnebel: erst mit dem Autopiloten, dann von Hand bis zum Minimum und zur Landung.',
    'The ILS approach to Zurich 14 in low stratus: first with the autopilot, then by hand to the minimum and the landing.',
  ),
  aircraft: 'c172',
  minutes: 12,
  plan: {
    aircraft: 'c172',
    start: { kind: 'approach', airport: ZURICH, runway: '14', distanceNm: 10 },
    airport: ZURICH,
    time: 9,
    weather: 'lowStratus',
    season: 'autumn',
    atc: false,
  },
  steps: [
    {
      id: 'check',
      say: t(
        'Wir sind 10 Meilen vor Zürich 14, über dem Hochnebel. NAV 1 ist auf dem ILS: prüf, dass die Kennung kommt und die Nadeln leben.',
        'We are 10 miles out from Zurich 14, above the stratus. NAV 1 is on the ILS: check the identifier and that the needles are alive.',
      ),
      done: atLeast('nav1Localizer', 1),
      hold: 3,
    },
    {
      id: 'coupled',
      say: t(
        'Autopilot ein (AP), dann APR: er fängt den Landekurs und danach den Gleitweg.',
        'Autopilot on (AP), then APR: it captures the localizer and then the glide slope.',
      ),
      done: all(
        atLeast('apEngaged', 1),
        any({ mode: 'apLateral', is: 'apr' }, { mode: 'apLateralArmed', is: 'apr' }),
      ),
    },
    {
      id: 'glideslope',
      say: t(
        'Der Autopilot fliegt den Kurs. Die Fahrt machst du mit dem Gas: 80 Knoten, bis er den Gleitweg fängt.',
        'The autopilot flies the course. You fly the speed with power: 80 knots until it captures the glide slope.',
      ),
      done: { mode: 'apVertical', is: 'gs' },
      hints: [...approachSpeedHints(80)],
    },
    {
      id: 'descend',
      say: t(
        'Gleitweg gefangen. Gas etwas zurück, 80 Knoten. Bei 1000 Fuss über Grund schaltest du den Autopiloten aus und fliegst von Hand.',
        'Glide slope captured. A little less power, 80 knots. At 1000 feet above the ground switch the autopilot off and fly by hand.',
      ),
      done: all(atMost('aglFt', 1050), atMost('apEngaged', 0)),
      hints: [
        hint(
          all(atMost('aglFt', 950), atLeast('apEngaged', 1)),
          t('Jetzt Autopilot aus: du fliegst.', 'Autopilot off now: you have control.'),
          0.5,
        ),
        ...approachSpeedHints(80),
      ],
    },
    {
      id: 'minimum',
      say: t(
        'Von Hand bis zum Minimum, 200 Fuss über Grund: beide Nadeln in der Mitte halten, kleine Korrekturen.',
        'By hand down to the minimum, 200 feet above the ground: keep both needles centred, small corrections.',
      ),
      done: atMost('aglFt', 250),
      hints: [
        hint(
          atLeast('nav1Deviation', 0.3),
          t('Landekurs rechts: etwas nach rechts.', 'Localizer right: a little to the right.'),
        ),
        hint(
          atMost('nav1Deviation', -0.3),
          t('Landekurs links: etwas nach links.', 'Localizer left: a little to the left.'),
        ),
        hint(
          atLeast('nav1GlideSlope', 0.3),
          t(
            'Gleitweg oben: du bist zu tief, weniger sinken.',
            'Glide slope above: you are low, sink less.',
          ),
        ),
        hint(
          atMost('nav1GlideSlope', -0.3),
          t(
            'Gleitweg unten: du bist zu hoch, mehr sinken.',
            'Glide slope below: you are high, sink more.',
          ),
        ),
        ...approachSpeedHints(80),
      ],
      fail: [
        {
          when: all(
            atMost('aglFt', 700),
            any(
              atLeast('nav1Deviation', 0.9, { abs: true }),
              atLeast('nav1GlideSlope', 0.9, { abs: true }),
            ),
          ),
          say: t(
            'Vollausschlag unter 700 Fuss: da wird durchgestartet. Wir üben das noch einmal.',
            'Full deflection below 700 feet: that is a go-around. Let us practise it again.',
          ),
          after: 3,
        },
      ],
    },
    {
      id: 'land',
      say: t(
        `Minimum. Piste in Sicht: Klappen 30, ${C172_VAPP} Knoten, über der Schwelle Gas raus und landen.`,
        `Minimum. Runway in sight: flaps 30, ${C172_VAPP} knots, close the throttle over the threshold and land.`,
      ),
      done: onGround,
      hints: [...offCentre(15)],
    },
    { id: 'stop', say: STOP, done: stopped, hold: 1 },
  ],
  hints: [STALL_WARNING],
  debrief: [
    {
      kind: 'range',
      label: t(
        'Landekurs: grösste Ablage (Vollausschlag = 100 %)',
        'Localizer: largest deflection (full scale = 100 %)',
      ),
      value: 'nav1Deviation',
      steps: ['minimum'],
      report: 'maxAbs',
      scale: 100,
      unit: '%',
      ok: { max: 50 },
    },
    {
      kind: 'range',
      label: t(
        'Gleitweg: grösste Ablage (Vollausschlag = 100 %)',
        'Glide slope: largest deflection (full scale = 100 %)',
      ),
      value: 'nav1GlideSlope',
      steps: ['minimum'],
      report: 'maxAbs',
      scale: 100,
      unit: '%',
      ok: { max: 50 },
    },
    touchdownSink(400),
    touchdownCentre(10),
  ],
};

// ---- 9 conversions: PC-12 --------------------------------------------------------------

const PC12_VR = knots('pc12', 'vRotate');
/** PC-12 POH: climb at 130 KIAS (best rate about 120); flaps up from 110 KIAS. */
const PC12_CLIMB = 130;
const BUOCHS = 'LSZC';

const pc12: LessonDef = {
  id: 'pc12',
  title: t('Umschulung: Pilatus PC-12', 'Type conversion: Pilatus PC-12'),
  summary: t(
    'Turboprop-Start in Buochs mit Klappen 15: Leistung nach Drehmoment, Fahrwerk und Klappen einfahren, steigen.',
    'A turboprop take-off at Buochs with flaps 15: power by torque, gear and flaps up, climb.',
  ),
  aircraft: 'pc12',
  minutes: 5,
  plan: {
    aircraft: 'pc12',
    start: { kind: 'runway', airport: BUOCHS, runway: '06' },
    airport: BUOCHS,
    ...clearDay,
  },
  steps: [
    {
      id: 'flaps',
      say: t(
        'Willkommen im PC-12. Für den Start: Klappen 15.',
        'Welcome to the PC-12. For take-off: flaps 15.',
      ),
      done: control('flaps', '15'),
    },
    {
      id: 'power',
      say: t(
        'Leistungshebel ruhig nach vorne, bis das Drehmoment fast an der Grenze steht. Der Propeller zieht nach links: rechtes Pedal.',
        'Power lever smoothly forward until the torque is nearly at its limit. The propeller pulls left: right pedal.',
      ),
      done: any(atLeast('torque', 0.85), lever('throttle', 0.9)),
      hints: [
        hint(
          atLeast('torque', 1.02),
          t(
            'Drehmoment über der Grenze: Hebel etwas zurück.',
            'Torque over the limit: lever back a little.',
          ),
          0.5,
        ),
      ],
    },
    {
      id: 'rotate',
      say: t(
        `Bei ${PC12_VR} Knoten rotieren, etwa 10 Grad Nase hoch.`,
        `Rotate at ${PC12_VR} knots, about 10 degrees nose up.`,
      ),
      done: all(airborne, atLeast('aglFt', 20)),
      hints: [
        hint(
          all(onGround, atLeast('iasKt', PC12_VR + 10)),
          t('Jetzt rotieren.', 'Rotate now.'),
          0.5,
        ),
        hint(
          atLeast('torque', 1.02),
          t(
            'Drehmoment über der Grenze: Hebel etwas zurück.',
            'Torque over the limit: lever back a little.',
          ),
          0.5,
        ),
        ...offCentre(6),
      ],
    },
    {
      id: 'gear',
      say: t('Positive Steigrate: Fahrwerk ein.', 'Positive rate of climb: gear up.'),
      done: all(control('gear', 0), atMost('gear', 0.02)),
      hints: [hint(atLeast('iasKt', 150), t('Fahrwerk ein!', 'Gear up!'), 0.5)],
    },
    {
      id: 'flapsUp',
      say: t('Ab 110 Knoten Klappen ein.', 'From 110 knots: flaps up.'),
      done: all(control('flaps', '0'), atMost('flaps', 0.02)),
      hints: [
        hint(
          all(control('flaps', '0'), atMost('iasKt', 100)),
          t(
            'Noch zu langsam für Klappen 0: Nase etwas senken.',
            'Too slow for flaps up yet: lower the nose a little.',
          ),
        ),
      ],
    },
    {
      id: 'climb',
      say: t(
        `Steige mit ${PC12_CLIMB} Knoten auf 2000 Fuss über dem Platz.`,
        `Climb at ${PC12_CLIMB} knots to 2000 feet above the field.`,
      ),
      done: atLeast('altitudeFt', 2000, { rel: 'lesson' }),
      hints: [...speedHints(PC12_CLIMB, 10, 15)],
    },
    {
      id: 'turn',
      say: t(
        'Links drehen auf Kurs 300, über den See Richtung Luzern, und weiter steigen.',
        'Turn left onto heading 300, over the lake towards Lucerne, and keep climbing.',
      ),
      done: all({ heading: 300, within: 15 }, atMost('bankDeg', 10, { abs: true })),
      hints: [...speedHints(PC12_CLIMB, 10, 15)],
    },
  ],
  hints: [
    STALL_WARNING,
    hint(
      all(atLeast('iasKt', 165), atLeast('gear', 0.1)),
      t('Zu schnell mit Fahrwerk draussen.', 'Too fast with the gear down.'),
      0.5,
    ),
  ],
  debrief: [
    {
      kind: 'liftoff',
      label: t('Fahrt beim Abheben', 'Speed at lift-off'),
      field: 'iasKt',
      unit: 'kt',
      ok: { min: PC12_VR - 8, max: PC12_VR + 15 },
    },
    speedKept(
      PC12_CLIMB,
      ['climb'],
      15,
      t(`Steigfahrt ${PC12_CLIMB} Knoten gehalten`, `Climb speed ${PC12_CLIMB} knots kept`),
    ),
    {
      kind: 'range',
      label: t('Grösstes Drehmoment (Grenze 100 %)', 'Highest torque (limit 100 %)'),
      value: 'torque',
      steps: ['power', 'rotate', 'gear', 'flapsUp', 'climb'],
      report: 'max',
      scale: 100,
      unit: '%',
      ok: { max: 102 },
    },
  ],
};

// ---- 10 and 11 conversions: A320 --------------------------------------------------------

const A320_VR = knots('a320', 'vRotate');
/** Thrust lever detents on the 0..1 travel (src/sim/cockpitA320.ts): CL 0.62, FLX/MCT 0.82. */
const levers = (min: number, max: number) =>
  all(lever('throttle1', min, max), lever('throttle2', min, max));
/**
 * The ground spoilers deploy, and with them the autobrake, only with both levers at idle (the
 * flight controls take 0.04 of travel as idle) or reverse selected.
 */
const leversIdle = any(levers(0, 0.04), control('reverse', 1));

const a320Takeoff: LessonDef = {
  id: 'a320-takeoff',
  title: t('Umschulung A320: Start', 'A320 conversion: take-off'),
  summary: t(
    'Start in Zürich auf der 16: Startkonfiguration, Schubhebel in die FLX-Raste, rotieren, Schub auf CL, Autopilot.',
    'Take-off from Zurich runway 16: take-off configuration, thrust levers to the FLX detent, rotate, thrust to CL, autopilot.',
  ),
  aircraft: 'a320',
  minutes: 6,
  plan: {
    aircraft: 'a320',
    start: { kind: 'runway', airport: ZURICH, runway: '16' },
    airport: ZURICH,
    ...clearDay,
  },
  steps: [
    {
      id: 'config',
      say: t(
        'Startkonfiguration: Klappen 1, Bodenspoiler armieren, Autobremse MAX.',
        'Take-off configuration: flaps 1, arm the ground spoilers, autobrake MAX.',
      ),
      done: all(control('flaps', '1'), control('spoilersArmed', 1), control('autobrake', 'max')),
    },
    {
      id: 'thrust',
      say: t(
        'Beide Schubhebel in die FLX/MCT-Raste. Das FMA zeigt MAN FLX, der Schub kommt.',
        'Both thrust levers into the FLX/MCT detent. The FMA shows MAN FLX, the thrust comes up.',
      ),
      done: levers(0.78, 1),
      hold: 1,
    },
    {
      id: 'rotate',
      say: t(
        `Mittellinie mit den Pedalen halten. Bei VR, ${A320_VR} Knoten, den Sidestick ruhig ziehen bis 15 Grad.`,
        `Keep the centre line with the pedals. At VR, ${A320_VR} knots, pull the sidestick smoothly to 15 degrees.`,
      ),
      done: all(airborne, atLeast('aglFt', 35)),
      hints: [
        hint(
          all(onGround, atLeast('pitchDeg', 9)),
          t('Vorsicht, das Heck: langsamer rotieren.', 'Careful, the tail: rotate more slowly.'),
          0.2,
        ),
        hint(all(onGround, atLeast('iasKt', A320_VR + 10)), t('Rotieren.', 'Rotate.'), 0.5),
        ...offCentre(6),
      ],
    },
    {
      id: 'gear',
      say: t('Positive Steigrate: Fahrwerk ein.', 'Positive climb: gear up.'),
      done: control('gear', 0),
      hints: [
        hint(atLeast('pitchDeg', 20), t('Nase zu hoch: 15 Grad.', 'Nose too high: 15 degrees.')),
      ],
    },
    {
      id: 'climbGate',
      say: t(
        'Auf 1500 Fuss über der Piste blinkt LVR CLB: beide Schubhebel zurück in die CL-Raste.',
        'At 1500 feet above the runway LVR CLB flashes: both thrust levers back into the CL detent.',
      ),
      done: all(levers(0.55, 0.7), atLeast('aglFt', 1000)),
      hints: [
        hint(
          all(atLeast('aglFt', 1700), lever('throttle1', 0.75)),
          t('Schubhebel in CL.', 'Thrust levers to CL.'),
        ),
        hint(
          all(atMost('aglFt', 1000), lever('throttle1', 0, 0.75)),
          t('Noch nicht: erst auf 1500 Fuss.', 'Not yet: only at 1500 feet.'),
          0.5,
        ),
      ],
    },
    {
      id: 'autopilot',
      say: t('Autopilot 1 ein: AP1 auf dem FCU.', 'Autopilot 1 on: AP1 on the FCU.'),
      done: atLeast('fcuAp1', 1),
    },
    {
      id: 'clean',
      say: t(
        'Mit steigender Fahrt bei F Klappen 1, bei S Klappen 0. Der Autopilot steigt im verwalteten Modus.',
        'As the speed grows, flaps 1 at F and flaps 0 at S. The autopilot climbs in managed mode.',
      ),
      done: all(control('flaps', '0'), atMost('flaps', 0.02)),
    },
  ],
  debrief: [
    {
      kind: 'liftoff',
      label: t(
        'Nase beim Abheben (Heck berührt ab 11.7°)',
        'Pitch at lift-off (tail strike from 11.7°)',
      ),
      field: 'pitchDeg',
      unit: '°',
      ok: { max: 11 },
    },
    {
      kind: 'liftoff',
      label: t('Abstand zur Mittellinie beim Abheben', 'Off the centre line at lift-off'),
      field: 'centrelineM',
      abs: true,
      unit: 'm',
      ok: { max: 5 },
    },
  ],
};

const a320Autoland: LessonDef = {
  id: 'a320-autoland',
  title: t('Umschulung A320: automatische Landung', 'A320 conversion: automatic landing'),
  summary: t(
    'ILS Zürich 14 im Hochnebel mit beiden Autopiloten bis zum Stillstand. Bei RETARD gehören die Schubhebel auf Leerlauf.',
    'ILS Zurich 14 in low stratus with both autopilots down to a stop. At RETARD the thrust levers go to idle.',
  ),
  aircraft: 'a320',
  minutes: 7,
  plan: {
    aircraft: 'a320',
    start: { kind: 'approach', airport: ZURICH, runway: '14', distanceNm: 10 },
    airport: ZURICH,
    time: 8,
    weather: 'lowStratus',
    season: 'autumn',
    atc: false,
  },
  steps: [
    {
      id: 'appr',
      say: t(
        'Wir sind 10 Meilen vor Zürich 14, der Schub ist automatisch. Drück APPR: Landekurs und Gleitweg werden armiert.',
        'We are 10 miles out from Zurich 14, autothrust is on. Press APPR: localizer and glide slope arm.',
      ),
      done: atLeast('fcuAppr', 1),
    },
    {
      id: 'autopilots',
      say: t(
        'Für die automatische Landung beide Autopiloten: AP1 und AP2.',
        'For the automatic landing both autopilots: AP1 and AP2.',
      ),
      done: all(atLeast('fcuAp1', 1), atLeast('fcuAp2', 1)),
    },
    {
      id: 'config',
      say: t(
        'Landekonfiguration: Klappen schrittweise bis FULL, Autobremse LO, Bodenspoiler armieren.',
        'Landing configuration: flaps step by step to FULL, autobrake LO, arm the ground spoilers.',
      ),
      done: all(
        control('flaps', 'full'),
        control('autobrake', ['low', 'medium']),
        control('spoilersArmed', 1),
        control('gear', 1),
      ),
    },
    {
      id: 'land',
      say: t(
        'Der Autopilot fliegt. Unter 400 Fuss zeigt das FMA LAND. Hand an die Schubhebel und zuhören.',
        'The autopilot flies. Below 400 feet the FMA shows LAND. Hand on the thrust levers and listen.',
      ),
      done: { mode: 'fmaVertical', is: ['LAND', 'FLARE', 'ROLL OUT'] },
      fail: [
        {
          when: all(atMost('aglFt', 300), atMost('fcuAp1', 0), atMost('fcuAp2', 0)),
          say: t(
            'Der Autopilot ist aus: diesmal keine automatische Landung.',
            'The autopilot is off: no automatic landing this time.',
          ),
          after: 2,
        },
      ],
    },
    {
      id: 'retard',
      say: t(
        'Bei RETARD beide Schubhebel ganz zurück auf Leerlauf.',
        'At RETARD pull both thrust levers all the way back to idle.',
      ),
      done: leversIdle,
      hints: [
        hint(
          { mode: 'callout', is: 'RETARD' },
          t('RETARD: Schubhebel auf Leerlauf!', 'RETARD: thrust levers to idle!'),
          0,
        ),
        hint(onGround, t('Schubhebel auf Leerlauf!', 'Thrust levers to idle!'), 0),
      ],
      fail: [
        {
          when: all(onGround, not(leversIdle)),
          say: t(
            'Die Schubhebel standen nicht auf Leerlauf: Bodenspoiler und Autobremse blieben drin. Bei RETARD gehören sie ganz zurück.',
            'The thrust levers were not at idle: ground spoilers and autobrake stayed in. At RETARD they go all the way back.',
          ),
          after: 6,
        },
      ],
    },
    {
      id: 'rollout',
      say: t(
        'Bodenspoiler und Autobremse arbeiten, der Autopilot hält die Mittellinie. Schubhebel bleiben auf Leerlauf.',
        'Ground spoilers and autobrake work, the autopilot holds the centre line. Thrust levers stay at idle.',
      ),
      done: all(onGround, atMost('groundSpeedKt', 30)),
      fail: [
        {
          when: all(onGround, not(leversIdle)),
          say: t(
            'Schub wieder gesetzt: die Bodenspoiler gingen ein. Auf der Piste bleiben die Hebel auf Leerlauf.',
            'Thrust set again: the ground spoilers retracted. On the runway the levers stay at idle.',
          ),
          after: 3,
        },
      ],
    },
  ],
  debrief: [
    {
      kind: 'afterTouchdown',
      label: t(
        'Schubhebel auf Leerlauf nach dem Aufsetzen',
        'Thrust levers at idle after touchdown',
      ),
      until: leversIdle,
      unit: 's',
      ok: { max: 1 },
    },
    touchdownSink(360),
    // CS-AWO asks an automatic landing to touch down within 27 ft (8.2 m) of the centre line.
    touchdownCentre(8.2),
  ],
  closing: t(
    'Automatische Landung im Hochnebel. Sauber gemacht! Autopilot aus, und dann rollen wir zum Standplatz.',
    'An automatic landing in low stratus. Neatly done! Autopilot off, and then we taxi to the gate.',
  ),
};

// ---- 12 conversion: F/A-18 ---------------------------------------------------------------

const FA18_VR = knots('fa18', 'vRotate');
/** NATOPS: on-speed approach angle of attack 8.1°; gear limit 250 KCAS. */
const ON_SPEED = 8.1;
const FA18_GEAR_LIMIT = 250;
const PAYERNE = 'LSMP';

const fa18: LessonDef = {
  id: 'fa18',
  title: t('Umschulung: F/A-18 Hornet', 'Type conversion: F/A-18 Hornet'),
  summary: t(
    'Start mit Nachbrenner in Payerne, Fahrwerk vor 250 Knoten ein, Steigflug, dann in Landekonfiguration nach Anstellwinkel fliegen.',
    'An afterburner take-off at Payerne, gear up before 250 knots, climb, then fly the landing configuration by angle of attack.',
  ),
  aircraft: 'fa18',
  minutes: 8,
  plan: {
    aircraft: 'fa18',
    start: { kind: 'runway', airport: PAYERNE, runway: '23' },
    airport: PAYERNE,
    ...clearDay,
  },
  steps: [
    {
      id: 'afterburner',
      say: t(
        'Willkommen in der Hornet. Beide Leistungshebel nach vorne auf MIL, dann über die Raste in den Nachbrenner.',
        'Welcome to the Hornet. Both throttles forward to MIL, then over the detent into afterburner.',
      ),
      done: all(lever('throttle1', 0.85), lever('throttle2', 0.85)),
      hold: 1,
    },
    {
      id: 'rotate',
      say: t(
        `Bei ${FA18_VR} Knoten den Stick zurück, etwa 10 Grad Nase hoch.`,
        `At ${FA18_VR} knots stick back, about 10 degrees nose up.`,
      ),
      done: all(airborne, atLeast('aglFt', 30)),
      hints: [
        hint(all(onGround, atLeast('iasKt', FA18_VR + 15)), t('Rotieren.', 'Rotate.'), 0.5),
        ...offCentre(8),
      ],
    },
    {
      id: 'gear',
      say: t(
        `Fahrwerk sofort ein: es hält nur ${FA18_GEAR_LIMIT} Knoten aus.`,
        `Gear up at once: it is good for ${FA18_GEAR_LIMIT} knots only.`,
      ),
      done: all(control('gear', 0), atMost('gear', 0.02)),
      hints: [
        hint(
          atLeast('iasKt', FA18_GEAR_LIMIT - 30),
          t('Fahrwerk! Gleich 250 Knoten.', 'Gear! Nearly 250 knots.'),
          0,
        ),
      ],
    },
    {
      id: 'climb',
      say: t(
        'Raus aus dem Nachbrenner, Hebel auf MIL. Steige mit etwa 350 Knoten 8000 Fuss höher.',
        'Out of afterburner, throttles to MIL. Climb at about 350 knots, 8000 feet higher.',
      ),
      done: atLeast('altitudeFt', 8000, { rel: 'lesson' }),
      hints: [
        hint(
          lever('throttle1', 0.8),
          t('Noch im Nachbrenner: Hebel auf MIL.', 'Still in afterburner: throttles to MIL.'),
          3,
        ),
        hint(atLeast('iasKt', 420), t('Zu schnell: Nase höher.', 'Too fast: nose higher.'), 2),
        hint(
          atMost('iasKt', 280),
          t('Zu langsam: Nase etwas senken.', 'Too slow: lower the nose a little.'),
          2,
        ),
      ],
    },
    {
      id: 'slow',
      say: t(
        'Ausleveln. Leistung zurück, Speedbrake raus, unter 200 Knoten verlangsamen.',
        'Level off. Throttles back, speed brake out, slow down below 200 knots.',
      ),
      done: atMost('iasKt', 200),
    },
    {
      id: 'config',
      say: t(
        'Speedbrake ein, Fahrwerk aus, Klappen FULL.',
        'Speed brake in, gear down, flaps FULL.',
      ),
      done: all(control('gear', 1), control('flaps', 'full'), control('speedbrake', 0)),
      hints: [
        hint(
          all(control('gear', 1), atLeast('iasKt', FA18_GEAR_LIMIT)),
          t(
            'Zu schnell für das Fahrwerk: Leistung zurück.',
            'Too fast for the gear: throttles back.',
          ),
          0,
        ),
      ],
    },
    {
      id: 'onSpeed',
      say: t(
        `Jetzt nach Anstellwinkel fliegen: ${ON_SPEED} Grad, der Kreis im HUD steht in der Mitte. Die Leistung regelt das Sinken.`,
        `Now fly angle of attack: ${ON_SPEED} degrees, the circle in the HUD centred. Power controls the sink.`,
      ),
      done: band('alphaDeg', ON_SPEED - 1, ON_SPEED + 1),
      hold: 10,
      hints: [
        hint(
          atLeast('alphaDeg', ON_SPEED + 1),
          t(
            'Anstellwinkel zu gross, du bist langsam: Nase etwas senken, mehr Leistung.',
            'Angle of attack too high, you are slow: nose down a little, more power.',
          ),
        ),
        hint(
          atMost('alphaDeg', ON_SPEED - 1),
          t(
            'Anstellwinkel zu klein, du bist schnell: Nase etwas heben, weniger Leistung.',
            'Angle of attack too low, you are fast: nose up a little, less power.',
          ),
        ),
      ],
    },
  ],
  hints: [
    hint(
      all(atLeast('gear', 0.1), atLeast('iasKt', FA18_GEAR_LIMIT)),
      t('Über 250 Knoten mit Fahrwerk!', 'Over 250 knots with the gear down!'),
      0,
    ),
  ],
  fail: [
    {
      when: all(atLeast('gear', 0.1), atLeast('iasKt', FA18_GEAR_LIMIT + 40)),
      say: t(
        'Weit über der Fahrwerksgrenze. Noch einmal, Fahrwerk früher ein.',
        'Far beyond the gear limit. Again, gear up sooner.',
      ),
      after: 2,
    },
  ],
  debrief: [
    {
      kind: 'range',
      label: t('Höchste Fahrt mit Fahrwerk draussen', 'Highest speed with the gear down'),
      value: 'iasKt',
      steps: ['rotate', 'gear'],
      report: 'max',
      unit: 'kt',
      ok: { max: FA18_GEAR_LIMIT },
    },
    {
      kind: 'range',
      label: t(`Anstellwinkel ${ON_SPEED}° gehalten`, `Angle of attack ${ON_SPEED}° kept`),
      value: 'alphaDeg',
      steps: ['onSpeed'],
      report: 'maxAbs',
      target: ON_SPEED,
      unit: '°',
      ok: { max: 1 },
    },
  ],
};

/** The lessons in teaching order. */
export const LESSONS: readonly LessonDef[] = [
  firstTakeoff,
  straightLevel,
  turns,
  slowFlight,
  landing,
  circuit,
  vor,
  ils,
  pc12,
  a320Takeoff,
  a320Autoland,
  fa18,
];
