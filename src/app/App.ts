import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  RenderPipeline,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import type { Object3D } from 'three/webgpu';
import { SHOWCASE_SPEED, Showcase } from './Showcase';
import { headingAt } from './showcasePath';
import { pass } from 'three/tsl';
import { type AircraftVisual, createReferenceMarker, loadAircraftVisual } from '@aircraft';
import {
  AircraftSound,
  AudioEngine,
  CockpitSound,
  NavAudio,
  RadioSquelch,
  RadioVoice,
  browserSpeech,
} from '@audio';
import {
  AIRPORTS,
  LocalFrame,
  bearingDeg,
  ecefToGeodetic,
  ellipsoidToSeaLevel,
  findAirport,
  findRunwayEnd,
  geodeticToEcef,
  geoidUndulation,
  ilsFor,
  offsetPoint,
  runwayStart,
  thresholdOf,
  seaLevelToEllipsoid,
} from '@geo';
import {
  type AircraftId,
  type InitialCondition,
  SIM_HZ,
  type SimAircraft,
  type Telemetry,
  AIRCRAFT,
  createAircraft,
} from '@sim';
import { Sky, WEATHER_PRESETS, type Weather } from '@sky';
import { SNOW_LINE, nightFactor, seasonOf } from './season';
import { type FlightPlan, type UiActions, game, mountUi, settings, status, touchInput } from '@ui';
import { type Season, World } from '@world';
import { RudderAssist } from './assist';
import { CameraRig } from './camera';
import { attachCockpitPointer } from './cockpitPointer';
import { PROFILES, detectDevice } from './device';
import { WorldEnvironment } from './environment';
import { Flight } from './Flight';
import { FlightDeck, frequenciesFor } from './flightDeck';
import { fetchLiveWeather } from './liveWeather';
import { type InputEvents, KEYS, Keyboard, PilotInput, keyAuthorityAt, readGamepad } from './input';
import { dateAtSwissHour, swissOffsetMinutes } from './time';
import { FreeCamera } from './freeCamera';
import { FlightLogger, GeoRunwayFinder, Logbook, worthKeeping } from './logbook';
import { type RenderPose, stateToRenderPose } from './pose';
import { FlightRecording, ReplayPlayer, pictureName, savePicture } from './replay';
import { LessonRunner, SchoolProgress, findLesson, lessonInfos, lessonPlan } from './school';

/** Where the menu scene is set and where the first flight starts. */
const HOME = { icao: 'LSZB', runway: '32' };
/** The render origin follows the aircraft; it is moved when it is this far away (metres). */
const REBASE_DISTANCE = 3000;
const KT = 0.514444;
/**
 * Yoke travel the keys get. A key is all or nothing: on a light aircraft full travel is fine at
 * low speed; a heavier, faster one over-rotates into its stall warning with it, so it gets
 * less, measured from its landing stall speed (it takes off below the clean one).
 */
function keyAuthority(aircraft: SimAircraft): number {
  const { info, telemetry } = aircraft;
  if (!info.category || info.category === 'piston') return keyAuthorityAt(telemetry.ias, info.vs);
  // Fly-by-wire in the air: the stick asks for load factor and the computers protect the
  // aircraft, so the keys may have (nearly) all of it; cut down they fly like treacle.
  if (!telemetry.onGround && info.category === 'fighter') return 1;
  if (!telemetry.onGround && info.category === 'airliner') return 0.7;
  return 0.6 * keyAuthorityAt(telemetry.ias, info.vs0);
}

/**
 * Where the throttle falls into a detent: the A320's CLIMB and FLX/MCT gates (TOGA and idle
 * are the ends of the travel), the stop at military power before the F/A-18's afterburner.
 */
const THROTTLE_DETENTS: Partial<Record<AircraftId, readonly number[]>> = {
  a320: [0.62, 0.82],
  fa18: [0.75],
};

const UP = new Vector3(0, 1, 0);
/** Shaders built at the same time behind a loading screen. */
const COMPILE_LANES = 4;
/** Metres the stand-in aircraft of the loading screen sits above the ground (about its wheels). */
const STAND_IN_HEIGHT = 1.2;

/** What tests and the screenshot tool can reach from the page (`window.__app`). */
export interface AppDebug {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /** True once the menu scene is loaded and has been drawn. */
  ready: boolean;
  frames: number;
  backend: string;
  /** The aircraft being flown (or parked in the menu). */
  aircraft: () => SimAircraft | undefined;
  world: World;
  /** Smoothed frame time in ms and the worst frame of the last half second. */
  frameMs: number;
  worstMs: number;
  assist: RudderAssist;
  /** Loudness of the sound output right now (RMS). */
  audioLevel: () => number;
  /** For tests: starts a flight as the menu would, and operates a cockpit control. */
  startFlight: (plan: FlightPlan) => void;
  /** Everything the interface can ask for (replay, photo mode, pause …). */
  actions: UiActions;
  setControl: (id: string, value: number) => void;
  /** The interface's state (radio, checklist, cockpit values). */
  game: typeof game;
  visual: () => AircraftVisual;
  /** What the loading screen is waiting for. */
  loading: () => { compiling: number; calm: number; modelReady: boolean };
  /** Test switch: a fixed reach of the shadow map in metres instead of the adaptive one. */
  shadowReach?: number;
}

declare global {
  interface Window {
    __app?: AppDebug;
  }
}

/** A flight waiting for its terrain. */
interface Pending {
  plan: FlightPlan | null;
  lon: number;
  lat: number;
  /** Height above the ellipsoid for a start in the air. */
  altitude?: number;
  /** Rough height of the ground there above the ellipsoid, until the terrain knows better. */
  guess: number;
  /** Flap lever at the start, 0..1 (up if not given). */
  flaps?: number;
  start: Omit<InitialCondition, 'position'>;
  since: number;
}

/**
 * Builds the renderer, the scene and the interface and runs the game: a parked aircraft
 * behind the menu, then flights.
 *
 * URL switches for testing: `?device=mobile|desktop`, `?webgl=1` (force the fallback),
 * `?t=2026-06-21T10:00Z` (time), `?shot=1` (fixed time, no changing text).
 */
export async function startApp(canvas: HTMLCanvasElement, uiRoot: HTMLElement): Promise<void> {
  const query = new URLSearchParams(location.search);
  const shot = query.has('shot');
  const profile = PROFILES[detectDevice()];
  status.device.value = profile.device;
  status.version.value = __APP_VERSION__;
  status.simHz.value = SIM_HZ;
  if (shot) document.body.classList.add('shots');

  // ---- renderer ----
  const renderer = new WebGPURenderer({
    canvas,
    // The scene is drawn into the post-processing chain; multisampling there would give
    // silhouette pixels the wrong haze.
    antialias: false,
    powerPreference: 'high-performance',
    forceWebGL: query.has('webgl'),
    // The view reaches from the instrument panel (0.1 m) to the Alps (200 km): only a
    // reversed depth buffer keeps that precise.
    reversedDepthBuffer: true,
  });
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'WebGPU'
    : 'WebGL 2';
  status.renderer.value = backend;
  renderer.toneMapping = ACESFilmicToneMapping;
  // The sky bakes its exposure into everything it lights; this stays a brightness setting.
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = profile.shadowMapSize > 0;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  const camera = new PerspectiveCamera(55, 1, 0.1, profile.world.viewDistance * 1.5);

  // ---- world, sky, simulation environment ----
  const homeAirport = findAirport(HOME.icao)!;
  const homeStart = runwayStart(homeAirport, HOME.runway)!;
  let frame = new LocalFrame(homeStart.lon, homeStart.lat, 0);
  const fixedTime = query.get('t');
  const startDate = shot
    ? new Date('2026-06-21T09:30:00Z')
    : fixedTime && !Number.isNaN(new Date(fixedTime).getTime())
      ? new Date(fixedTime)
      : new Date();
  const timeIsFixed = shot || !!fixedTime;
  const sky = new Sky(startDate, homeStart.lon, homeStart.lat, profile.sky);
  /** A fixed frame: the clouds are anchored to it, so they stay over the land. */
  const anchor = new LocalFrame(homeStart.lon, homeStart.lat, 0);
  const world = new World(frame, profile.world);
  // The terrain's description is fetched while the renderer is still setting up.
  world.init().catch(() => undefined);
  const env = new WorldEnvironment(world, () => frame);
  scene.add(sky.object, world.object);
  scene.environment = sky.environment;

  // Scene, then the air and the clouds in front of it; tone mapping comes last.
  const scenePass = pass(scene, camera);
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputNode = sky.post(
    scenePass.getTextureNode('output'),
    scenePass.getTextureNode('depth'),
    camera,
  );

  // ---- shaders ----
  // Drawing an object for the first time builds its shader, one after the other, and the
  // browser shows no frame until the graphics card is done: seconds for a fresh scene. Behind
  // a loading screen the scene is not drawn; every new object is handed to the renderer for
  // building in the background instead, all at once, while the tiles are still on their way.
  const precompiled = new WeakSet<Object3D>();
  const toCompile: Object3D[] = [];
  /** Objects waiting or being built. */
  let compiling = 0;
  let lanes = 0;
  /**
   * Builds the waiting objects, a few at a time. Each one costs milliseconds of script; a
   * real pause between two lets the tile workers' messages through, which would otherwise
   * wait until every shader is done.
   */
  const compileLane = async () => {
    lanes++;
    for (let o = toCompile.shift(); o; o = toCompile.shift()) {
      const target = renderer.getRenderTarget();
      const mrt = renderer.getMRT();
      // The same target the scene pass draws into: a pipeline is only reused for the same one.
      renderer.setRenderTarget(scenePass.renderTarget);
      renderer.setMRT(null);
      const done = renderer.compileAsync(o, camera, scene);
      renderer.setRenderTarget(target);
      renderer.setMRT(mrt);
      await done.catch((err: unknown) => console.warn(err));
      compiling--;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    lanes--;
  };
  const precompile = () => {
    // Nothing is drawn meanwhile, so nothing else brings the placements up to date; an object
    // at a stale place is taken to be out of view and skipped.
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    scene.traverseVisible((o) => {
      const drawn = o as Object3D & { isMesh?: boolean; isPoints?: boolean; isLine?: boolean };
      if (!(drawn.isMesh || drawn.isPoints || drawn.isLine) || precompiled.has(o)) return;
      precompiled.add(o);
      compiling++;
      toCompile.push(o);
    });
    while (lanes < COMPILE_LANES && toCompile.length > lanes) void compileLane();
  };
  /** The sky and the post-processing chain have been drawn once (their shaders exist). */
  let drawnOnce = false;

  if (profile.shadowMapSize > 0) {
    const s = sky.sun.shadow;
    sky.sun.castShadow = true;
    s.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
    s.camera.left = s.camera.bottom = -16;
    s.camera.right = s.camera.top = 16;
    s.camera.near = 1;
    s.camera.far = 400;
    s.bias = -0.0005;
    s.normalBias = 0.03;
  }

  // ---- aircraft on screen ----
  let visual: AircraftVisual = createReferenceMarker();
  let visualId: AircraftId | 'marker' = 'marker';
  visual.object.visible = false;
  scene.add(visual.object);
  let visualLoad: Promise<void> = Promise.resolve();
  const useVisual = (id: AircraftId): Promise<void> => {
    // A second request for the same model waits for the first.
    if (visualId !== id) {
      visualId = id;
      visualLoad = loadVisual(id);
    }
    return visualLoad;
  };
  const loadVisual = async (id: AircraftId) => {
    try {
      const next = await loadAircraftVisual(id, {
        quality: profile.device === 'mobile' ? 'low' : 'high',
      });
      // The altimeter shows height above sea level; the simulation works above the ellipsoid.
      next.setAltimeterOffset(-geoidUndulation(frame.origin.lon, frame.origin.lat));
      next.object.visible = visual.object.visible;
      scene.remove(visual.object);
      visual.dispose();
      visual = next;
      scene.add(visual.object);
      visual.setCockpitView(game.view.value === 'cockpit' && game.screen.value !== 'menu');
    } catch (err) {
      // The model is missing: keep flying with the stand-in.
      console.warn(err);
    }
  };

  // ---- state ----
  const rig = new CameraRig();
  /** Field of view in the cockpit, degrees: the wheel zooms in on the panel. */
  let cockpitFov = 55;
  // Before the rig's own listeners: a press on a switch must not also turn the head.
  attachCockpitPointer(canvas, {
    camera,
    visual: () => visual,
    active: () =>
      game.view.value === 'cockpit' && game.screen.value === 'flight' && plan !== null && !!deck,
    spec: (id) => flight?.aircraft.cockpit.specs.find((s) => s.id === id),
    get: (id) => flight?.aircraft.cockpit.get(id) ?? 0,
    set: (id, value, held) => setControl(id, value, held),
    zoom: (factor) => (cockpitFov = Math.min(Math.max(cockpitFov * factor, 22), 70)),
    point: (id, x, y) => {
      const now = game.pointedControl.value;
      if (id === null ? now !== null : now?.id !== id || now.x !== x || now.y !== y)
        game.pointedControl.value = id === null ? null : { id, x, y };
    },
  });
  rig.attach(canvas);
  rig.autoOrbit = !shot;
  const local = new Vector3();
  rig.groundY = (x, z) => {
    const g = frame.toGeodetic(local.set(x, 0, z));
    const h = world.groundHeight(g.lon, g.lat);
    return h === undefined ? undefined : frame.fromGeodetic(g.lon, g.lat, h, local).y;
  };
  const showcase = new Showcase();
  /** Height of the menu's aircraft above the terrain, m. */
  let showcaseAgl = 500;
  const flyShowcase = (dt: number) => {
    showcase.update(
      dt,
      frame,
      visual.object,
      camera,
      // About the wingspan.
      visual.view.chaseDistance * 0.65,
      rig.groundY!,
      { width: canvas.clientWidth, height: canvas.clientHeight },
    );
    const at = visual.object.position;
    const ground = rig.groundY!(at.x, at.z);
    if (ground !== undefined) showcaseAgl = Math.max(0, at.y - ground);
  };
  const input = new PilotInput();
  const assist = new RudderAssist();
  const keyboard = new Keyboard();
  const events: InputEvents = { flapsDown: 0, flapsUp: 0, gearToggle: 0 };
  let flight: Flight | undefined;
  let pending: Pending | undefined;
  /** Seconds the world has had nothing left to load. */
  let calm = 0;
  let modelReady = false;
  /** The screen to show once the scene has been drawn a few times. */
  let reveal: { screen: 'menu' | 'flight'; frames: number } | undefined;
  let tilesLoaded = 0;
  /** The terrain under the aircraft last frame: its level of detail and height. */
  let groundZoom = 0;
  let groundHeight = 0;
  let plan: FlightPlan | null = null;
  /** The season the landscape is shown in: the calendar's, until a flight chooses one. */
  let season: Season = seasonOf(startDate);

  const say = (key: string) => {
    // Setting null first lets the same notice show again.
    game.message.value = null;
    game.message.value = key;
  };

  const setView = (view: 'outside' | 'cockpit') => {
    game.view.value = view;
    rig.setMode(view);
    visual.setCockpitView(view === 'cockpit');
  };

  /** Moves the render origin to lon/lat; everything is re-placed from world coordinates. */
  const rebase = (lon: number, lat: number) => {
    frame = new LocalFrame(lon, lat, 0);
    world.setFrame(frame);
    sky.setLocation(lon, lat);
  };

  let weatherRequest: AbortController | undefined;
  /** The wind as the things on the ground show it (windsocks). */
  const worldWind = { fromDeg: 250, speed: 0 };
  let currentWeather: Weather = WEATHER_PRESETS.fair;
  const applyWeather = (weather: Weather) => {
    worldWind.fromDeg = weather.windFromDeg;
    worldWind.speed = weather.windSpeed;
    sky.setWeather(weather);
    game.weather.value = weather;
    currentWeather = weather;
    env.air_ = {
      windFromDeg: weather.windFromDeg,
      windSpeed: weather.windSpeed,
      isaDeviation: weather.temperature - 15,
      wetness: weather.precipitation,
      cloudCover: weather.cloudCover,
      cloudBase: weather.cloudBase,
      cloudTop: weather.cloudTop,
      stratus: weather.stratus,
      precipitation: weather.precipitation,
      temperature: weather.temperature,
      sunElevationDeg: sky.state.sunElevation,
      sunAzimuthDeg: sky.state.sunAzimuth,
    };
  };

  /** The type the menu's flight shows (the hangar changes it). */
  let menuAircraft: AircraftId = 'c172';
  // ---- logbook, replay and photo mode ----
  const storage = (() => {
    try {
      return window.localStorage;
    } catch {
      // Storage can be blocked: the logbook then lives for this visit only.
      return undefined;
    }
  })();
  const logbook = new Logbook();
  game.logbook.value = logbook.load(storage);
  const runways = new GeoRunwayFinder();
  let logger: FlightLogger | undefined;
  /** The flight in progress has been off the ground. */
  let flew = false;
  /** Set by the flight school when a lesson ends. */
  let lessonPassed: boolean | undefined;
  let lessonId: string | undefined;
  const recording = new FlightRecording();
  let player: ReplayPlayer | undefined;
  const freeCam = new FreeCamera();
  const replayPose: RenderPose = {
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
  };
  /** The photo mode was opened from the replay (else from the pause menu). */
  let photoFromReplay = false;
  /** The replay was opened from a running flight (the debrief of a lesson), not the pause menu. */
  let replayFromFlight = false;
  /** The sky's time before the photo mode changed it. */
  let photoDate: Date | undefined;
  let saveNext = false;
  let replayTime = 0;
  /** Closes the logbook entry of the flight in progress. */
  const closeLog = () => {
    if (!logger || !flight) return;
    const t = flight.aircraft.telemetry;
    const entry = logger.finish(
      t.crashed ? 'crashed' : t.onGround && flew ? 'landed' : 'ended',
      lessonPassed,
    );
    logger = undefined;
    if (worthKeeping(entry)) game.logbook.value = logbook.add(entry);
  };
  const openLog = (aircraft: AircraftId) => {
    flew = false;
    lessonPassed = undefined;
    logger = new FlightLogger({ aircraft, date: new Date(), lesson: lessonId, runways });
  };
  /** Leaves replay and photo mode (the camera goes back to the rig). */
  const leaveStill = () => {
    freeCam.detach();
    player = undefined;
    game.replay.value = null;
    game.photo.value = null;
    if (photoDate) sky.setTime(photoDate);
    photoDate = undefined;
    visual.object.visible = true;
  };
  // ---- flight school ----
  const school = new SchoolProgress(storage ?? null);
  game.lessons.value = lessonInfos(school);
  let lesson: LessonRunner | undefined;
  let lessonTime = 0;
  const openLesson = (aircraft: SimAircraft) => {
    const def = lessonId ? findLesson(lessonId) : undefined;
    lesson = def ? new LessonRunner(def, aircraft.cockpit.specs) : undefined;
    game.lesson.value = lesson ? lesson.view() : null;
  };
  // A closed tab is the end of the flight too.
  window.addEventListener('pagehide', closeLog);

  /** The radio, checklists and switches of the flight in progress. */
  let deck: FlightDeck | undefined;
  const openDeck = () => {
    deck?.dispose();
    deck = undefined;
    if (flight && plan)
      deck = new FlightDeck(flight.aircraft, plan, currentWeather, {
        cockpit: cockpitSound,
        radio,
      });
  };
  /** Operates a cockpit control; the keys' throttle and flap lever follow. */
  const setControl = (id: string, value: number, held = false) => {
    if (!deck || !flight) return;
    deck.setControl(id, value, held);
    if (id.startsWith('throttle') || id === 'flaps' || id === 'gear' || id === 'speedbrake')
      input.adopt(flight.aircraft.controls);
  };

  /**
   * Prepares a flight (a plan) or the parked aircraft of the menu (null). The aircraft
   * appears once the terrain under it is loaded.
   */
  const prepare = (p: FlightPlan | null) => {
    closeLog();
    leaveStill();
    recording.clear();
    game.canReplay.value = false;
    lesson = undefined;
    game.lesson.value = null;
    flight = undefined;
    visual.object.visible = false;
    game.telemetry.value = null;
    game.levers.value = null;
    game.loadProgress.value = 0;
    // The menu is there at once, over a plain backdrop; its scene (the flight through the
    // Oberland) fades in behind it when it has loaded. Nobody waits for scenery to press a button.
    if (!p) game.screen.value = 'menu';
    document.documentElement.dataset.scene = 'loading';
    plan = p;
    deck?.dispose();
    deck = undefined;
    game.frequencies.value = p ? frequenciesFor(p) : [];
    const type = AIRCRAFT.find((a) => a.id === (p?.aircraft ?? menuAircraft)) ?? AIRCRAFT[0]!;
    // The briefing reads the type's controls (its flap settings) before the flight exists.
    if (p) {
      try {
        game.controls.value = createAircraft(type.id).cockpit.specs;
      } catch (err) {
        console.warn(err);
      }
    }
    // Screenshot tests must not change with the calendar.
    season = shot ? 'summer' : !p?.season || p.season === 'now' ? seasonOf(new Date()) : p.season;
    const icao = p?.airport ?? (p?.start.kind === 'runway' ? p.start.airport : undefined);
    const airport = (icao && findAirport(icao)) || homeAirport;
    const since = performance.now();
    if (!p) {
      // The menu: a flight on rails through the Bernese Oberland.
      showcase.reset();
      pending = {
        plan: null,
        lon: showcase.geo.lon,
        lat: showcase.geo.lat,
        altitude: showcase.geo.h,
        guess: 0,
        start: { headingDeg: headingAt(0), speed: SHOWCASE_SPEED, onGround: false },
        since,
      };
    } else if (p.start.kind === 'air') {
      const s = p.start;
      pending = {
        plan: p,
        lon: s.lon,
        lat: s.lat,
        altitude: seaLevelToEllipsoid(s.lon, s.lat, s.altitude),
        guess: 0,
        // Faster types start faster: a jet cannot fly at a Cessna's cruise speed.
        start: {
          headingDeg: s.headingDeg,
          speed: s.speed ?? Math.max(100 * KT, 1.6 * type.vs),
          onGround: false,
        },
        since,
      };
    } else if (p.start.kind === 'approach' && findRunwayEnd(airport, p.start.runway)) {
      // On final: on the extended centre line, on the glide path of the runway's ILS (or a
      // 3 degree one), a little above approach speed with the first stage of flaps.
      const s = p.start;
      const { end, opposite } = findRunwayEnd(airport, s.runway)!;
      const threshold = thresholdOf(end, opposite);
      const course = bearingDeg(end, opposite);
      const metres = s.distanceNm * 1852;
      const at = offsetPoint(threshold, course + 180, metres);
      const angle = ilsFor(airport.icao, s.runway)?.glideSlope?.angleDeg ?? 3;
      // Level a little below the glide path, as an approach is flown: the path comes down
      // to the aircraft (an autopilot only captures it from below).
      const height =
        (end.elevation ?? airport.elevation) + 15 + metres * Math.tan((angle * Math.PI) / 180) - 60;
      pending = {
        plan: p,
        lon: at.lon,
        lat: at.lat,
        altitude: seaLevelToEllipsoid(at.lon, at.lat, height),
        guess: 0,
        // A little above the approach speed, gear down, with an early stage of flaps.
        start: {
          headingDeg: course,
          speed: 1.2 * (type.vApproach ?? 1.3 * type.vs0),
          onGround: false,
          gearDown: true,
        },
        flaps: 1 / 3,
        since,
      };
    } else {
      const ident = p.start.runway;
      const at =
        runwayStart(airport, ident) ?? runwayStart(airport, airport.runways[0]!.ends[0].ident)!;
      pending = {
        plan: p,
        lon: at.lon,
        lat: at.lat,
        guess: seaLevelToEllipsoid(at.lon, at.lat, airport.elevation),
        start: {
          headingDeg: at.headingDeg,
          speed: 0,
          onGround: true,
          enginesRunning: !p.coldStart,
        },
        since,
      };
    }
    rebase(pending.lon, pending.lat);
    // The camera takes its final place now: the terrain that loads is the terrain of that view.
    if (p) {
      showcase.release(camera);
      canvas.style.opacity = '';
      resize();
      setView('outside');
    } else visual.setCockpitView(false);
    calm = 0;
    tilesLoaded = 0;
    reveal = undefined;
    modelReady = false;
    void useVisual(type.id).then(() => (modelReady = true));
    if (!timeIsFixed) {
      const time = p?.time;
      sky.setTime(typeof time === 'number' ? dateAtSwissHour(new Date(), time) : new Date());
    }
    // Screenshot tests need a sky that looks the same every time: no drifting clouds.
    const choice = shot ? 'clear' : (p?.weather ?? 'menu');
    // Live weather arrives a moment later; until then (or without a connection) a fair day.
    // The menu flies among the peaks: a fair day whose clouds stay above the route.
    applyWeather(
      choice === 'menu'
        ? { ...WEATHER_PRESETS.fair, cloudCover: 0.25, cloudBase: 3700, cloudTop: 4700 }
        : WEATHER_PRESETS[choice === 'live' ? 'fair' : choice],
    );
    weatherRequest?.abort();
    if (choice === 'live') {
      weatherRequest = new AbortController();
      fetchLiveWeather(pending.lon, pending.lat, airport.elevation, weatherRequest.signal).then(
        applyWeather,
        (err: unknown) => {
          if ((err as Error).name !== 'AbortError') console.warn(err);
        },
      );
    }
  };

  /** Places the pending flight if its terrain has arrived. */
  const tryBegin = (dt: number) => {
    if (!pending) return;
    // The world counts as loaded once nothing has been outstanding for a moment (between
    // two batches of tiles it is briefly idle too).
    calm = world.loading ? 0 : calm + dt;
    const under = world.ground(pending.lon, pending.lat);
    const waited = (performance.now() - pending.since) / 1000;
    if (!under) return;
    // Everything in view is loaded before anything is shown: the aircraft stands on the
    // final terrain (coarse tiles are metres off) and nothing sharpens while one watches.
    // Not forever, though: a slow connection still gets to fly.
    // An aircraft in the air stands on nothing: the terrain far below it never gets that fine.
    const fine = !pending.start.onGround || under.zoom >= profile.world.maxZoom - 1;
    if (!(fine && calm > 0.3) && waited < 30) return;
    if (!modelReady && waited < 20) return;
    if (compiling > 0 && waited < 30) return;
    const ground = under.height;
    env.heightOffset = 0;
    groundZoom = under.zoom;
    groundHeight = ground;
    const p = pending;
    pending = undefined;
    const id: AircraftId = p.plan?.aircraft ?? menuAircraft;
    let aircraft: SimAircraft;
    try {
      aircraft = createAircraft(id);
    } catch (err) {
      console.error(err);
      game.screen.value = 'menu';
      return;
    }
    const position = geodeticToEcef(p.lon, p.lat, p.altitude ?? ground, { x: 0, y: 0, z: 0 });
    // The reset trims the aircraft for the flaps as they are set here.
    aircraft.controls.flaps = p.flaps ?? 0;
    flight = new Flight(aircraft, env, { ...p.start, position });
    openDeck();
    sound.setAircraft(aircraft.info);
    cockpitSound.setAircraft(aircraft.info);
    // Jets coordinate their turns themselves and answer the rudder strongly on the ground:
    // the helper only keeps them on the centre line, gently.
    const jet = aircraft.info.category === 'airliner' || aircraft.info.category === 'fighter';
    assist.coordinate = !jet;
    assist.groundGain = jet ? 0.15 : 1;
    input.detents = THROTTLE_DETENTS[aircraft.info.id] ?? [];
    input.setFlapNotches(
      aircraft.cockpit.specs.find((s) => s.id === 'flaps')?.positions?.length ?? 4,
    );
    // The reset trims the aircraft: take the throttle it chose.
    input.reset(
      aircraft.controls.throttle[0] ?? 0,
      aircraft.controls.flaps,
      aircraft.controls.gearDown,
    );
    assist.reset();
    visual.object.visible = true;
    if (p.plan) {
      openLog(aircraft.info.id);
      openLesson(aircraft);
    }
    // A few frames behind the loading screen: the aircraft settles on its wheels.
    reveal = { screen: p.plan ? 'flight' : 'menu', frames: 10 };
  };

  // ---- interface ----
  game.airports.value = AIRPORTS.map((a) => ({
    icao: a.icao,
    name: a.name,
    lon: a.lon,
    lat: a.lat,
    elevation: a.elevation,
    runways: a.runways.flatMap((r) => r.ends.map((e) => e.ident)),
  }));
  const togglePause = () => {
    if (!flight || !plan) return;
    if (game.screen.value === 'flight') {
      flight.paused = true;
      game.screen.value = 'paused';
    } else if (game.screen.value === 'paused') {
      flight.paused = false;
      game.screen.value = 'flight';
    }
  };
  const toggleView = () => {
    if (game.screen.value !== 'flight') return;
    setView(game.view.value === 'outside' ? 'cockpit' : 'outside');
    say(game.view.value === 'cockpit' ? 'msg.viewCockpit' : 'msg.viewOutside');
  };
  const actions: UiActions = {
    startFlight(p) {
      lessonId = undefined;
      game.plan.value = p;
      prepare(p);
      game.screen.value = 'briefing';
    },
    startLesson(id) {
      const p = lessonPlan(id);
      if (!p) return;
      lessonId = id;
      game.plan.value = p;
      prepare(p);
      game.screen.value = 'briefing';
    },
    pause: togglePause,
    resume: togglePause,
    restart() {
      if (!flight) return;
      closeLog();
      leaveStill();
      flight.restart();
      recording.clear();
      openLog(flight.aircraft.info.id);
      openLesson(flight.aircraft);
      flight.paused = false;
      openDeck();
      input.reset(
        flight.aircraft.controls.throttle[0] ?? 0,
        flight.aircraft.controls.flaps,
        flight.aircraft.controls.gearDown,
      );
      assist.reset();
      env.heightOffset = 0;
      game.screen.value = 'flight';
    },
    exitToMenu() {
      lessonId = undefined;
      game.plan.value = null;
      prepare(null);
    },
    toggleView,
    setControl: (id, value) => setControl(id, value),
    atcReply: (id) => deck?.reply(id),
    openChecklist: (id) => deck?.openChecklist(id),
    checkItem: () => deck?.checkItem(),
    setFailure: (id, failed) => deck?.setFailure(id, failed),
    deleteLogEntry: (id) => (game.logbook.value = logbook.remove(id)),
    clearLogbook: () => (game.logbook.value = logbook.clear()),
    openReplay() {
      if (!flight || !plan || recording.duration < 2) return;
      if (game.screen.value !== 'paused' && game.screen.value !== 'flight') return;
      replayFromFlight = game.screen.value === 'flight';
      flight.paused = true;
      player = new ReplayPlayer(recording);
      // The last minute is what one wants to see again; the rest is a drag of the bar away.
      player.seek(Math.max(player.start, player.end - 60));
      player.play(true);
      // From outside: the cockpit view hides most of the aircraft.
      visual.setCockpitView(false);
      freeCam.groundY = rig.groundY;
      freeCam.begin(camera, visual.object.position);
      freeCam.follow(visual.object.position);
      freeCam.attach(canvas);
      game.replay.value = player.view();
      game.screen.value = 'replay';
    },
    closeReplay() {
      if (game.screen.value !== 'replay') return;
      leaveStill();
      visual.setCockpitView(game.view.value === 'cockpit');
      if (replayFromFlight && flight) flight.paused = false;
      game.screen.value = replayFromFlight ? 'flight' : 'paused';
    },
    replaySeek: (time) => player?.seek(time),
    replayPlay: (playing) => player?.play(playing),
    replaySpeed: (speed) => player?.setSpeed(speed),
    openPhoto() {
      if (!flight || !plan) return;
      const from = game.screen.value;
      if (from !== 'paused' && from !== 'replay' && from !== 'flight') return;
      photoFromReplay = from === 'replay';
      flight.paused = true;
      if (player) player.play(false);
      else {
        freeCam.groundY = rig.groundY;
        freeCam.begin(camera, visual.object.position);
        freeCam.follow(visual.object.position);
        freeCam.attach(canvas);
      }
      freeCam.set({ fov: camera.fov, roll: 0 });
      photoDate = new Date(sky.state.date);
      const minutes =
        photoDate.getUTCHours() * 60 + photoDate.getUTCMinutes() + swissOffsetMinutes(photoDate);
      game.photo.value = {
        fov: Math.round(freeCam.fov),
        roll: 0,
        time: (((minutes / 60) % 24) + 24) % 24,
        aircraft: true,
      };
      game.screen.value = 'photo';
    },
    closePhoto() {
      if (game.screen.value !== 'photo') return;
      game.photo.value = null;
      if (photoDate) sky.setTime(photoDate);
      photoDate = undefined;
      visual.object.visible = true;
      freeCam.set({ roll: 0 });
      if (photoFromReplay && player) {
        game.screen.value = 'replay';
        return;
      }
      leaveStill();
      game.screen.value = 'paused';
    },
    photoSet(patch) {
      const now = game.photo.value;
      if (!now) return;
      const next = { ...now, ...patch };
      freeCam.set({ fov: next.fov, roll: next.roll });
      next.fov = freeCam.fov;
      next.roll = freeCam.roll;
      if (patch.time !== undefined && photoDate) sky.setTime(dateAtSwissHour(photoDate, next.time));
      visual.object.visible = next.aircraft;
      game.photo.value = next;
    },
    photoSave: () => void (saveNext = true),
    showAircraft(id) {
      showcase.sideShift = id ? 0.03 : 0.14;
      const next = id ?? 'c172';
      if (next === menuAircraft) return;
      menuAircraft = next;
      // Still loading the menu's scene: load it with this type instead.
      if (plan === null && !flight) prepare(null);
      // Only the aircraft changes: the menu's flight goes on where it is.
      if (plan !== null || !flight) return;
      const at = flight.aircraft.state.position;
      void useVisual(next).then(() => {
        if (plan !== null || menuAircraft !== next) return;
        try {
          const aircraft = createAircraft(next);
          flight = new Flight(aircraft, env, {
            position: { x: at.x, y: at.y, z: at.z },
            headingDeg: headingAt(showcase.s),
            speed: SHOWCASE_SPEED,
            onGround: false,
          });
          sound.setAircraft(aircraft.info);
          visual.object.visible = true;
          visual.setCockpitView(false);
        } catch (err) {
          console.warn(err);
        }
      });
    },
  };
  mountUi(uiRoot, actions);
  keyboard.onPress = (code) => {
    const is = (keys: readonly string[]) => keys.includes(code);
    if (is(KEYS.pause)) togglePause();
    if (game.screen.value !== 'flight') return;
    if (is(KEYS.view)) toggleView();
    if (is(KEYS.flapsDown)) {
      events.flapsDown++;
      say('msg.flapsDown');
    }
    if (is(KEYS.flapsUp)) {
      events.flapsUp++;
      say('msg.flapsUp');
    }
    if (is(KEYS.gear)) {
      if (flight?.aircraft.info.retractableGear) events.gearToggle++;
      else say('msg.gearFixed');
    }
    if (flight?.aircraft.controls.speedbrake !== undefined) {
      if (is(KEYS.speedbrakeOut)) events.speedbrake = (events.speedbrake ?? 0) + 1;
      if (is(KEYS.speedbrakeIn)) events.speedbrake = (events.speedbrake ?? 0) - 1;
    }
  };
  // Taps on the on-screen buttons arrive as counters.
  const seen = {
    up: touchInput.flapsUp.value,
    down: touchInput.flapsDown.value,
    gear: touchInput.gearToggle.value,
  };
  const readTouchButtons = () => {
    events.flapsUp += touchInput.flapsUp.value - seen.up;
    events.flapsDown += touchInput.flapsDown.value - seen.down;
    const gear = touchInput.gearToggle.value - seen.gear;
    if (gear) {
      if (flight?.aircraft.info.retractableGear) events.gearToggle += gear;
      else say('msg.gearFixed');
    }
    seen.up = touchInput.flapsUp.value;
    seen.down = touchInput.flapsDown.value;
    seen.gear = touchInput.gearToggle.value;
  };

  // Browsers start audio only after a gesture.
  const audio = new AudioEngine();
  const sound = new AircraftSound(audio);
  const cockpitSound = new CockpitSound(audio);
  const navAudio = new NavAudio(audio);
  const squelch = new RadioSquelch(audio);
  const radio = new RadioVoice(browserSpeech(), squelch);
  audio.onVolumeChange((volume, muted) => radio.setVolume(volume, muted));
  const unlock = () => {
    // Speech must be woken inside the gesture itself (iOS), not after the context resumed.
    radio.unlock();
    void audio.resume().then(() => {
      sound.start();
      cockpitSound.start();
      navAudio.start();
      squelch.start();
    });
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  const resize = () => {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, profile.maxPixelRatio));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Portrait screens: keep the horizontal view from getting too narrow.
    camera.fov = w < h ? 70 : 55;
    camera.updateProjectionMatrix();
    const size = renderer.getDrawingBufferSize(new Vector2());
    world.setViewport(size.x, size.y);
    status.resolution.value = [Math.round(size.x), Math.round(size.y)];
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const debug: AppDebug = {
    renderer,
    scene,
    camera,
    ready: false,
    frames: 0,
    backend,
    aircraft: () => flight?.aircraft,
    world,
    frameMs: 0,
    worstMs: 0,
    assist,
    audioLevel: () => audio.level(),
    loading: () => ({ compiling, calm, modelReady }),
    startFlight: (p) => actions.startFlight(p),
    actions,
    setControl: (id, value) => setControl(id, value),
    visual: () => visual,
    game,
  };
  window.__app = debug;

  prepare(null);

  // ---- loop ----
  const noTouch = { pitch: null, roll: null, yaw: null, throttle: null, brake: false };
  const deckPosition = { lon: 0, lat: 0, msl: 0 };
  /** The control the 3D cockpit marks (the open checklist's next item). */
  let highlighted: string | null = null;
  const geo = { lon: 0, lat: 0, h: 0 };
  let last = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;
  let worst = 0;
  let hudTime = 0;
  let appTime = 0;

  let worldAt = 0;
  const updateWorld = () => {
    worldAt = performance.now();
    world.hurry = pending !== undefined || reveal !== undefined;
    world.update(camera);
  };
  // While the graphics card builds shaders the browser draws no frame for seconds at a time,
  // and in a background tab none at all. The world keeps streaming behind the loading screen.
  setInterval(() => {
    if (pending && performance.now() - worldAt > 100) updateWorld();
  }, 50);

  renderer.setAnimationLoop((now: number) => {
    const frameMs = now - last;
    const dt = Math.min(frameMs / 1000, 0.25);
    last = now;

    tryBegin(dt);
    if (pending) {
      // Mostly terrain; the share only ever grows, although the view asks for more tiles
      // as it sharpens.
      tilesLoaded = Math.max(tilesLoaded, world.progress);
      const progress = 0.04 + 0.82 * tilesLoaded + (modelReady ? 0.08 : 0);
      game.loadProgress.value = Math.max(game.loadProgress.value, Math.min(progress, 0.95));
    } else if (reveal) {
      game.loadProgress.value = Math.max(game.loadProgress.value, 1 - reveal.frames / 500);
      if (--reveal.frames <= 0) {
        game.loadProgress.value = 1;
        game.screen.value = reveal.screen;
        delete document.documentElement.dataset.scene;
        reveal = undefined;
      }
    }

    if (flight) {
      const aircraft = flight.aircraft;
      const flying = plan !== null && game.screen.value === 'flight';
      if (plan === null) flight.paused = true;
      readTouchButtons();
      const pad = flying ? readGamepad() : null;
      const touch = flying
        ? {
            pitch: touchInput.pitch.value,
            roll: touchInput.roll.value,
            yaw: touchInput.yaw.value,
            throttle: touchInput.throttle.value,
            brake: touchInput.brake.value,
            speedbrake: touchInput.speedbrake.value,
            reverse: touchInput.reverse.value,
          }
        : noTouch;
      const options = {
        invertPitch: settings.invertPitch.value,
        keyAuthority: keyAuthority(aircraft),
      };
      const alpha = flight.advance(dt, (stepDt) => {
        // Finer (or coarser) terrain arrived under the aircraft: its height changed without
        // the aircraft moving. Take the step out before the wheels feel it and let it fade.
        ecefToGeodetic(aircraft.state.position, geo);
        const under = world.ground(geo.lon, geo.lat);
        env.time = aircraft.telemetry.time;
        env.heightOffset *= Math.exp(-stepDt / 0.8);
        if (under) {
          if (under.zoom !== groundZoom) {
            env.heightOffset += groundHeight - under.height;
            env.terrainChanged();
          }
          groundZoom = under.zoom;
          groundHeight = under.height;
        }
        // The parked aircraft of the menu is not flown, and a wreck takes no input.
        if (!flying || aircraft.telemetry.crashed) return;
        input.update(stepDt, keyboard.down, pad, touch, events, options, aircraft.controls);
        events.flapsDown = events.flapsUp = events.gearToggle = events.speedbrake = 0;
        assist.apply(stepDt, aircraft.telemetry, aircraft.controls);
      });
      // The menu's aircraft is not simulated: it follows its loop, and so does the camera.
      const tour = plan === null;
      // Replay and photo mode: the flight stands still and the free camera looks at it.
      const still = !tour && (game.screen.value === 'replay' || game.screen.value === 'photo');
      const shown = still && player ? player : undefined;
      const replayDt = shown ? shown.advance(dt) : 0;
      const tape = shown?.frame();
      const placeAircraft = () => {
        if (!tape) return flight!.place(visual.object, frame, alpha);
        stateToRenderPose(tape.state, frame, replayPose);
        const { position: at, quaternion: q } = replayPose;
        visual.object.position.set(at.x, at.y, at.z);
        visual.object.quaternion.set(q.x, q.y, q.z, q.w);
        return tape.state;
      };
      if (flying) {
        if (!aircraft.telemetry.onGround) flew = true;
        ecefToGeodetic(aircraft.state.position, geo);
        logger?.sample(dt, aircraft.telemetry, geo);
        recording.record(flight.time, aircraft);
        const can = recording.duration > 2;
        if (game.canReplay.value !== can) game.canReplay.value = can;
      }
      if (tour) flyShowcase(shot ? 0 : dt);
      else placeAircraft();

      // Keep the render origin near the aircraft: single precision is exact to millimetres
      // only within a few kilometres.
      const p = visual.object.position;
      if (p.x * p.x + p.z * p.z > REBASE_DISTANCE * REBASE_DISTANCE) {
        if (tour) {
          rebase(showcase.geo.lon, showcase.geo.lat);
          flyShowcase(0);
        } else {
          ecefToGeodetic((tape?.state ?? aircraft.state).position, geo);
          rebase(geo.lon, geo.lat);
          placeAircraft();
        }
      }
      if (deck && flying) {
        ecefToGeodetic(aircraft.state.position, geo);
        deckPosition.lon = geo.lon;
        deckPosition.lat = geo.lat;
        deckPosition.msl = ellipsoidToSeaLevel(geo.lon, geo.lat, geo.h);
        deck.update(dt, deckPosition);
        const mark = deck.highlighted;
        if (mark !== highlighted) visual.highlightControl((highlighted = mark));
      }
      if (lesson && flying) {
        ecefToGeodetic(aircraft.state.position, geo);
        deckPosition.lon = geo.lon;
        deckPosition.lat = geo.lat;
        deckPosition.msl = ellipsoidToSeaLevel(geo.lon, geo.lat, geo.h);
        const before = lesson.state;
        lesson.update(dt, aircraft.telemetry, aircraft.cockpit, deckPosition);
        lessonTime += dt;
        const ended = before === 'running' && lesson.state !== 'running';
        if (ended) {
          lessonPassed = lesson.state === 'passed';
          if (lessonPassed && lessonId && school.markPassed(lessonId))
            game.lessons.value = lessonInfos(school);
        }
        if (ended || lessonTime >= 0.25) {
          lessonTime = 0;
          game.lesson.value = lesson.view();
        }
      }
      if (!tour && !still) {
        // Zoomed in on the panel in the cockpit, the usual angle outside.
        const base = canvas.clientWidth < canvas.clientHeight ? 70 : 55;
        const fov = game.view.value === 'cockpit' ? cockpitFov * (base / 55) : base;
        if (Math.abs(camera.fov - fov) > 0.01) {
          camera.fov = fov;
          camera.updateProjectionMatrix();
        }
      }
      visual.setExposure(sky.state.exposure);
      if (tape) visual.update(replayDt, tape.telemetry, tape.controls, tape.cockpit);
      else
        visual.update(
          still ? 0 : dt,
          aircraft.telemetry,
          aircraft.controls,
          tour ? undefined : aircraft.cockpit,
        );
      if (still) {
        freeCam.update(dt, camera);
        replayTime += dt;
        if (shown && replayTime >= 0.05) {
          replayTime = 0;
          game.replay.value = shown.view();
        }
      } else if (!tour)
        rig.update(dt, camera, visual.object, visual.view, flying && !aircraft.telemetry.onGround);
      // The picture dips to black around the menu's camera cuts.
      const opacity = tour && game.screen.value === 'menu' ? showcase.fade.toFixed(2) : '';
      if (canvas.style.opacity !== opacity) canvas.style.opacity = opacity;

      hudTime += dt;
      if (plan && hudTime >= 0.05) {
        hudTime = 0;
        ecefToGeodetic(aircraft.state.position, geo);
        // Pilots read altitude above sea level; the simulation works above the ellipsoid.
        const t: Telemetry = { ...aircraft.telemetry };
        t.altitude = ellipsoidToSeaLevel(geo.lon, geo.lat, t.altitude);
        game.telemetry.value = t;
        const c = aircraft.controls;
        game.levers.value = {
          throttle: c.throttle[0] ?? 0,
          flaps: c.flaps,
          gearDown: c.gearDown,
          brake: c.brakeLeft > 0.5 || c.brakeRight > 0.5,
          parkingBrake: c.parkingBrake,
          speedbrake: c.speedbrake,
          reverse: c.reverse,
        };
      }
    }

    if (pending && !flight) {
      // The aircraft stands where it will start and the camera looks at it as it will: exactly
      // the terrain of the first view loads, and the aircraft's shaders are built while the
      // tiles are on their way instead of afterwards.
      if (!pending.plan) flyShowcase(0);
      else {
        const h =
          pending.altitude ??
          (world.groundHeight(pending.lon, pending.lat) ?? pending.guess) + STAND_IN_HEIGHT;
        frame.fromGeodetic(pending.lon, pending.lat, h, visual.object.position);
        // A model looks along its +z; heading 0 is north, render -z.
        visual.object.quaternion.setFromAxisAngle(
          UP,
          Math.PI - (pending.start.headingDeg * Math.PI) / 180,
        );
        rig.update(0, camera, visual.object, visual.view, false);
      }
      visual.object.visible = true;
    }

    audio.setVolume(settings.volume.value);
    audio.setMuted(settings.muted.value);
    {
      const flown = plan && flight ? flight.aircraft : undefined;
      const inside = game.view.value === 'cockpit';
      const active = game.screen.value === 'flight';
      const c = flown?.controls;
      sound.update(
        flown?.telemetry,
        inside,
        active,
        flown && c
          ? {
              starter: c.starter?.[0] || flown.cockpit.get('magnetos') === 4,
              surface: env.ground(flown.state.position)?.surface,
              brake: Math.max(c.brakeLeft, c.brakeRight),
            }
          : undefined,
      );
      cockpitSound.update(flown?.telemetry, {
        inside,
        active: active && !!flown,
        precipitation: currentWeather.precipitation,
        cockpit: flown?.cockpit,
      });
      navAudio.update(flown?.telemetry.avionics, { markers: true, active: active && !!flown });
    }

    appTime += dt;
    world.setConditions({
      night: nightFactor(sky.state.sunElevation),
      exposure: sky.state.exposure,
      season,
      snowLine: SNOW_LINE[season],
      lightDirection: sky.state.lightDirection,
      time: appTime,
      wind: worldWind,
    });
    updateWorld();
    const camGeo = frame.toGeodetic(camera.position, geo);
    anchor.fromGeodetic(frame.origin.lon, frame.origin.lat, 0, local);
    sky.update(camera, {
      dt,
      altitude: ellipsoidToSeaLevel(camGeo.lon, camGeo.lat, camGeo.h),
      origin: { x: local.x, z: local.z },
    });
    // The shadow map covers the aircraft and the ground around it (the moon lights at night).
    sky.sun.target.position.copy(visual.object.position);
    sky.sun.position.copy(visual.object.position).addScaledVector(sky.state.lightDirection, 200);
    if (sky.sun.castShadow) {
      // The shadow map must reach the ground below the aircraft. Ground beyond its far plane
      // counts as shadowed, and the map's whole footprint shows as a dark square from high up.
      const shadow = sky.sun.shadow;
      const agl = plan === null ? showcaseAgl : (flight?.aircraft.telemetry.agl ?? 0);
      const reach = 250 + (agl + 80) / Math.max(sky.state.lightDirection.y, 0.12);
      const far = debug.shadowReach ?? Math.min(Math.max(reach, 400), 30_000);
      if (Math.abs(far - shadow.camera.far) > 0.02 * far) {
        shadow.camera.far = far;
        shadow.camera.updateProjectionMatrix();
        // The bias is a share of the depth range: keep it at the same 20 cm.
        shadow.bias = -0.2 / far;
      }
    }

    if (pending && drawnOnce) precompile();
    else {
      pipeline.render();
      drawnOnce = true;
      // The canvas can only be read in the frame that drew it.
      if (saveNext) {
        saveNext = false;
        const name = flight?.aircraft.info.name ?? 'flight';
        savePicture(canvas, pictureName(name, new Date())).catch((err: unknown) =>
          console.warn(err),
        );
      }
    }

    debug.frames++;
    if (!debug.ready && flight && game.screen.value === 'menu') debug.ready = true;
    fpsFrames++;
    fpsTime += dt;
    worst = Math.max(worst, frameMs);
    debug.frameMs += (frameMs - debug.frameMs) * 0.05;
    if (fpsTime >= 0.5) {
      status.fps.value = fpsFrames / fpsTime;
      debug.worstMs = worst;
      worst = 0;
      fpsFrames = 0;
      fpsTime = 0;
    }
  });
}
