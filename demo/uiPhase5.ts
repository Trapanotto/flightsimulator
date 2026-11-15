/**
 * Phase 5 fakes for the interface demo: lessons of the flight school, a logbook, a lesson
 * being flown, the replay and the photo mode, with fake actions that move `game.screen` the
 * way the app will.
 *
 * URL switches (with `p5`, or any of these screens):
 *   screen=school|logbook|replay|photo   lesson=running|hint|hold|passed|failed (on screen=flight)
 *   emptylog  no flights in the logbook     noreplay  no recording yet
 */
import {
  type FlightPlan,
  type LessonInfo,
  type LessonView,
  type LogEntry,
  type UiActions,
  game,
  nav,
} from '@ui';

const LESSONS: LessonInfo[] = [
  {
    id: 'straight',
    title: { de: 'Geradeaus und horizontal', en: 'Straight and level' },
    summary: {
      de: 'Das Flugzeug mit Blick auf den Horizont gerade halten und trimmen.',
      en: 'Hold the aircraft straight by looking at the horizon, and trim it.',
    },
    aircraft: 'c172',
    minutes: 5,
    done: true,
  },
  {
    id: 'turns',
    title: { de: 'Kurven', en: 'Turns' },
    summary: {
      de: 'Mit 30 Grad Querneigung kurven, ohne Höhe zu verlieren.',
      en: 'Turn at 30 degrees of bank without losing height.',
    },
    aircraft: 'c172',
    minutes: 6,
    done: true,
  },
  {
    id: 'takeoff',
    title: { de: 'Der erste Start', en: 'The first take-off' },
    summary: {
      de: 'Auf der Mittellinie beschleunigen, bei 55 Knoten rotieren und mit 75 Knoten steigen.',
      en: 'Accelerate on the centre line, rotate at 55 knots and climb at 75.',
    },
    aircraft: 'c172',
    minutes: 4,
    done: false,
  },
  {
    id: 'circuit',
    title: { de: 'Platzrunde in Bern', en: 'A circuit at Bern' },
    summary: {
      de: 'Start, Gegenanflug, Queranflug und Endanflug auf die Piste 14.',
      en: 'Take-off, downwind, base and final to runway 14.',
    },
    aircraft: 'c172',
    minutes: 12,
    done: false,
  },
  {
    id: 'landing',
    title: { de: 'Landen', en: 'Landing' },
    summary: {
      de: 'Vom Endanflug bis zum Stillstand: Geschwindigkeit halten, abfangen, ausschweben.',
      en: 'From final to a stop: hold the speed, flare, let it settle.',
    },
    aircraft: 'c172',
    minutes: 6,
    done: false,
  },
  {
    id: 'ils',
    title: { de: 'Instrumentenanflug Zürich 14', en: 'Instrument approach Zurich 14' },
    summary: {
      de: 'Im Hochnebel dem Landekurssender und dem Gleitweg folgen, bis die Piste erscheint.',
      en: 'Follow the localizer and the glide slope through low stratus until the runway shows.',
    },
    aircraft: 'pc12',
    minutes: 15,
    done: false,
  },
];

const STEPS: { de: string; en: string }[] = [
  {
    de: 'Parkbremse lösen und Vollgas geben.',
    en: 'Release the parking brake and apply full power.',
  },
  {
    de: 'Mit dem Seitenruder auf der Mittellinie bleiben.',
    en: 'Keep to the centre line with the rudder.',
  },
  {
    de: 'Bei 55 Knoten sanft ziehen, bis das Bugrad abhebt.',
    en: 'At 55 knots pull gently until the nose wheel lifts.',
  },
  {
    de: 'Mit 75 Knoten auf 1500 Fuss über Grund steigen.',
    en: 'Climb at 75 knots to 1500 feet above the ground.',
  },
  {
    de: 'Auf 1500 Fuss horizontal fliegen und die Leistung reduzieren.',
    en: 'Level off at 1500 feet and reduce power.',
  },
];

/** A ground track: a circuit around Bern-Belp, as [lon, lat, altitude]. */
function circuit(lon: number, lat: number, alt: number): [number, number, number][] {
  const pts: [number, number, number][] = [];
  const corners: [number, number][] = [
    [0, 0],
    [0.035, -0.03],
    [0.06, -0.045],
    [0.085, -0.02],
    [0.05, 0.03],
    [0.015, 0.05],
    [-0.015, 0.03],
    [0, 0],
  ];
  for (let i = 0; i < corners.length - 1; i++)
    for (let s = 0; s < 10; s++) {
      const f = s / 10;
      const a = corners[i]!;
      const b = corners[i + 1]!;
      pts.push([lon + a[0] + (b[0] - a[0]) * f, lat + a[1] + (b[1] - a[1]) * f, alt + 300]);
    }
  return pts;
}

/** A cross-country flight with a gentle wander, as [lon, lat, altitude]. */
function crossCountry(
  a: [number, number],
  b: [number, number],
  bends: [number, number][],
): [number, number, number][] {
  const way = [a, ...bends, b];
  const pts: [number, number, number][] = [];
  for (let i = 0; i < way.length - 1; i++)
    for (let s = 0; s < 20; s++) {
      const f = s / 20;
      const p = way[i]!;
      const q = way[i + 1]!;
      pts.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, 1800]);
    }
  pts.push([b[0], b[1], 450]);
  return pts;
}

const LOGBOOK: LogEntry[] = [
  {
    id: 'f4',
    date: '2026-11-14T15:32:00Z',
    aircraft: 'c172',
    from: 'LSZB',
    to: 'LSZB',
    duration: 14 * 60 + 20,
    airTime: 11 * 60 + 5,
    distance: 21_400,
    maxAltitude: 850,
    landings: [
      {
        time: 12 * 60 + 40,
        airport: 'LSZB',
        runway: '14',
        sinkRate: 0.45,
        speed: 31,
        centreline: 1.8,
        pastThreshold: 312,
        load: 1.15,
      },
    ],
    outcome: 'landed',
    lesson: 'circuit',
    lessonPassed: true,
    track: circuit(7.4971, 46.9141, 510),
  },
  {
    id: 'f3',
    date: '2026-11-12T09:05:00Z',
    aircraft: 'pc12',
    from: 'LSGG',
    to: 'LSGS',
    duration: 41 * 60,
    airTime: 36 * 60 + 30,
    distance: 151_000,
    maxAltitude: 4300,
    landings: [
      {
        time: 38 * 60,
        airport: 'LSGS',
        runway: '25',
        sinkRate: 1.9,
        speed: 46,
        centreline: -4.2,
        pastThreshold: 540,
        load: 1.4,
      },
      {
        time: 40 * 60,
        airport: 'LSGS',
        runway: '25',
        sinkRate: 3.4,
        speed: 38,
        centreline: -0.2,
        pastThreshold: 610,
      },
    ],
    outcome: 'landed',
    track: crossCountry(
      [6.109, 46.2381],
      [7.3267, 46.2196],
      [
        [6.5, 46.42],
        [6.92, 46.37],
        [7.05, 46.18],
      ],
    ),
  },
  {
    id: 'f2',
    date: '2026-11-08T13:47:00Z',
    aircraft: 'c172',
    from: 'LSZB',
    to: 'LSZH',
    duration: 58 * 60 + 10,
    airTime: 52 * 60,
    distance: 118_500,
    maxAltitude: 1680,
    landings: [
      {
        time: 56 * 60,
        airport: 'LSZH',
        runway: '14',
        sinkRate: 1.1,
        speed: 33,
        centreline: 0.3,
        pastThreshold: 410,
      },
    ],
    outcome: 'landed',
    track: crossCountry(
      [7.4971, 46.9141],
      [8.5492, 47.4647],
      [
        [7.8, 47.15],
        [8.25, 47.3],
      ],
    ),
  },
  {
    id: 'f1',
    date: '2026-11-02T10:12:00Z',
    aircraft: 'c172',
    from: 'LSZB',
    duration: 4 * 60 + 50,
    airTime: 2 * 60 + 10,
    distance: 6_100,
    maxAltitude: 640,
    landings: [],
    outcome: 'crashed',
    lesson: 'takeoff',
    lessonPassed: false,
    track: circuit(7.4971, 46.9141, 510).slice(0, 22),
  },
];

let lessonTimer = 0;
let replayTimer = 0;
/** Where the replay and the photo mode return to. */
let replayFrom: 'paused' | 'flight' = 'paused';
let photoFrom: 'paused' | 'flight' | 'replay' = 'paused';

function lessonView(id: string, step: number, extra: Partial<LessonView> = {}): LessonView {
  const info = LESSONS.find((l) => l.id === id) ?? LESSONS[2]!;
  return {
    id: info.id,
    title: info.title,
    step,
    steps: STEPS.length,
    instruction: STEPS[Math.min(step, STEPS.length - 1)]!,
    state: 'running',
    ...extra,
  };
}

const DEBRIEF_PASSED: LessonView['debrief'] = [
  { label: { de: 'Mittellinie gehalten', en: 'Centre line held' }, value: '± 2 m', ok: true },
  { label: { de: 'Rotation', en: 'Rotation' }, value: '56 kt', ok: true },
  { label: { de: 'Steiggeschwindigkeit', en: 'Climb speed' }, value: '74–78 kt', ok: true },
  { label: { de: 'Höhe gehalten', en: 'Height held' }, value: '± 60 ft', ok: true },
];

const DEBRIEF_FAILED: LessonView['debrief'] = [
  { label: { de: 'Mittellinie gehalten', en: 'Centre line held' }, value: '± 3 m', ok: true },
  { label: { de: 'Rotation', en: 'Rotation' }, value: '42 kt', ok: false },
  { label: { de: 'Steiggeschwindigkeit', en: 'Climb speed' }, value: '51 kt', ok: false },
];

/** Walks through the steps of a lesson, a few seconds each, then passes it. */
function runLesson(id: string) {
  clearInterval(lessonTimer);
  let step = 0;
  let hold = 0;
  game.lesson.value = lessonView(id, 0);
  lessonTimer = window.setInterval(() => {
    if (game.screen.value !== 'flight') return;
    hold += 0.1;
    if (hold >= 1) {
      hold = 0;
      step++;
    }
    if (step >= STEPS.length) {
      clearInterval(lessonTimer);
      game.lesson.value = {
        ...lessonView(id, STEPS.length - 1),
        state: 'passed',
        debrief: DEBRIEF_PASSED,
      };
      const l = LESSONS.find((x) => x.id === id);
      if (l) l.done = true;
      game.lessons.value = [...LESSONS];
      return;
    }
    game.lesson.value = lessonView(id, step, {
      progress: step === 3 ? hold : undefined,
      hint:
        step === 1 && hold > 0.4
          ? { de: 'Zu weit links: rechtes Seitenruder.', en: 'Too far left: right rudder.' }
          : undefined,
    });
  }, 600);
}

function startReplayClock() {
  clearInterval(replayTimer);
  replayTimer = window.setInterval(() => {
    const r = game.replay.value;
    if (!r || !r.playing) return;
    const time = Math.min(r.end, r.time + 0.1 * r.speed);
    game.replay.value = { ...r, time, playing: time < r.end };
  }, 100);
}

/** Adds the phase 5 actions to the demo's fake app and fills the phase 5 signals. */
export function installPhase5(
  actions: UiActions,
  q: URLSearchParams,
  startPlan: (plan: FlightPlan) => void,
) {
  game.lessons.value = [...LESSONS];
  game.logbook.value = q.has('emptylog') ? [] : [...LOGBOOK];
  game.canReplay.value = !q.has('noreplay');

  actions.startLesson = (id) => {
    console.info('startLesson', id);
    const l = LESSONS.find((x) => x.id === id);
    startPlan({
      aircraft: l?.aircraft ?? 'c172',
      start: { kind: 'runway', airport: 'LSZB', runway: '14' },
      time: 10,
      weather: 'clear',
      airport: 'LSZB',
    });
    runLesson(id);
  };
  const exit = actions.exitToMenu;
  actions.exitToMenu = () => {
    clearInterval(lessonTimer);
    game.lesson.value = null;
    exit();
  };
  actions.deleteLogEntry = (id) => {
    game.logbook.value = game.logbook.value.filter((e) => e.id !== id);
  };
  actions.clearLogbook = () => {
    game.logbook.value = [];
  };
  actions.openReplay = () => {
    replayFrom = game.screen.value === 'flight' ? 'flight' : 'paused';
    game.replay.value = { time: 120, start: 0, end: 754, playing: true, speed: 1 };
    game.screen.value = 'replay';
    startReplayClock();
  };
  actions.closeReplay = () => {
    clearInterval(replayTimer);
    game.replay.value = null;
    game.screen.value = replayFrom;
  };
  actions.replaySeek = (time) => {
    const r = game.replay.value;
    if (r) game.replay.value = { ...r, time };
  };
  actions.replayPlay = (playing) => {
    const r = game.replay.value;
    if (r)
      game.replay.value = { ...r, playing, time: playing && r.time >= r.end ? r.start : r.time };
  };
  actions.replaySpeed = (speed) => {
    const r = game.replay.value;
    if (r) game.replay.value = { ...r, speed };
  };
  actions.openPhoto = () => {
    const s = game.screen.value;
    photoFrom = s === 'replay' ? 'replay' : s === 'flight' ? 'flight' : 'paused';
    const r = game.replay.value;
    if (r) game.replay.value = { ...r, playing: false };
    game.photo.value = { fov: 50, roll: 0, time: 15.5, aircraft: true };
    game.screen.value = 'photo';
  };
  actions.closePhoto = () => {
    game.photo.value = null;
    game.screen.value = photoFrom;
  };
  actions.photoSet = (patch) => {
    const p = game.photo.value;
    if (p) game.photo.value = { ...p, ...patch };
  };
  actions.photoSave = () => console.info('photoSave');
}

/** Opens the phase 5 screen the URL asks for, after the demo's own screens are set up. */
export function openPhase5Screen(q: URLSearchParams, actions: UiActions) {
  const screen = q.get('screen');
  if (screen === 'school' || screen === 'logbook') {
    game.screen.value = 'menu';
    nav.page.value = screen;
  }
  if (screen === 'replay') actions.openReplay?.();
  if (screen === 'photo') actions.openPhoto?.();
  const lesson = q.get('lesson');
  if (lesson && game.screen.value === 'flight') {
    clearInterval(lessonTimer);
    if (lesson === 'passed')
      game.lesson.value = { ...lessonView('takeoff', 4), state: 'passed', debrief: DEBRIEF_PASSED };
    else if (lesson === 'failed')
      game.lesson.value = { ...lessonView('takeoff', 2), state: 'failed', debrief: DEBRIEF_FAILED };
    else if (lesson === 'hint')
      game.lesson.value = lessonView('takeoff', 1, {
        hint: { de: 'Zu weit links: rechtes Seitenruder.', en: 'Too far left: right rudder.' },
      });
    else if (lesson === 'hold') game.lesson.value = lessonView('takeoff', 3, { progress: 0.62 });
    else runLesson('takeoff');
  }
}
