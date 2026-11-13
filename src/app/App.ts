import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { type AircraftVisual, createReferenceMarker, loadAircraftVisual } from '@aircraft';
import { AudioEngine } from '@audio';
import {
  LocalFrame,
  ecefToGeodetic,
  ellipsoidToSeaLevel,
  geodeticToEcef,
  seaLevelToEllipsoid,
} from '@geo';
import {
  type AircraftId,
  type InitialCondition,
  SIM_HZ,
  type SimAircraft,
  type Telemetry,
  createAircraft,
} from '@sim';
import { Sky, type Weather } from '@sky';
import { type FlightPlan, game, mountUi, settings, status, touchInput } from '@ui';
import { World } from '@world';
import { AIRPORTS, findAirport, runwayStart } from './airports';
import { RudderAssist } from './assist';
import { CameraRig } from './camera';
import { PROFILES, detectDevice } from './device';
import { WorldEnvironment } from './environment';
import { Flight } from './Flight';
import { type InputEvents, KEYS, Keyboard, PilotInput, readGamepad } from './input';
import { dateAtSwissHour } from './time';

/** Where the menu scene is set and where the first flight starts. */
const HOME = { icao: 'LSZB', runway: '32' };
/** The render origin follows the aircraft; it is moved when it is this far away (metres). */
const REBASE_DISTANCE = 3000;
const KT = 0.514444;

const WEATHER: Record<Exclude<FlightPlan['weather'], 'live'>, Weather> = {
  clear: {
    cloudCover: 0,
    cloudBase: 2600,
    cloudTop: 3400,
    visibility: 80_000,
    windFromDeg: 250,
    windSpeed: 2,
    precipitation: 0,
    temperature: 15,
  },
  fair: {
    cloudCover: 0.3,
    cloudBase: 2200,
    cloudTop: 3400,
    visibility: 50_000,
    windFromDeg: 250,
    windSpeed: 4,
    precipitation: 0,
    temperature: 15,
  },
  cloudy: {
    cloudCover: 0.6,
    cloudBase: 1800,
    cloudTop: 3400,
    visibility: 30_000,
    windFromDeg: 240,
    windSpeed: 6,
    precipitation: 0,
    temperature: 13,
  },
  overcast: {
    cloudCover: 0.95,
    cloudBase: 1500,
    cloudTop: 2600,
    visibility: 15_000,
    windFromDeg: 230,
    windSpeed: 5,
    precipitation: 0,
    temperature: 11,
  },
};

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
    antialias: profile.antialias,
    powerPreference: 'high-performance',
    forceWebGL: query.has('webgl'),
  });
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'WebGPU'
    : 'WebGL 2';
  status.renderer.value = backend;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = profile.shadowMapSize > 0;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  const camera = new PerspectiveCamera(55, 1, 0.5, profile.world.viewDistance * 1.5);

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
  const sky = new Sky(startDate, homeStart.lon, homeStart.lat);
  const world = new World(frame, profile.world);
  const env = new WorldEnvironment(world, () => frame);
  scene.add(sky.object, world.object);

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
  const useVisual = async (id: AircraftId) => {
    if (visualId === id) return;
    visualId = id;
    try {
      const next = await loadAircraftVisual(id);
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
  rig.attach(canvas);
  const local = new Vector3();
  rig.groundY = (x, z) => {
    const g = frame.toGeodetic(local.set(x, 0, z));
    const h = world.groundHeight(g.lon, g.lat);
    return h === undefined ? undefined : frame.fromGeodetic(g.lon, g.lat, h, local).y;
  };
  const input = new PilotInput();
  const assist = new RudderAssist();
  const keyboard = new Keyboard();
  const events: InputEvents = { flapsDown: 0, flapsUp: 0, gearToggle: 0 };
  let flight: Flight | undefined;
  let pending: Pending | undefined;
  /** The terrain under the aircraft last frame: its level of detail and height. */
  let groundZoom = 0;
  let groundHeight = 0;
  let plan: FlightPlan | null = null;

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

  /**
   * Prepares a flight (a plan) or the parked aircraft of the menu (null). The aircraft
   * appears once the terrain under it is loaded.
   */
  const prepare = (p: FlightPlan | null) => {
    flight = undefined;
    visual.object.visible = false;
    game.telemetry.value = null;
    game.levers.value = null;
    plan = p;
    const icao = p?.airport ?? (p?.start.kind === 'runway' ? p.start.airport : undefined);
    const airport = (icao && findAirport(icao)) || homeAirport;
    const since = performance.now();
    if (p && p.start.kind === 'air') {
      const s = p.start;
      pending = {
        plan: p,
        lon: s.lon,
        lat: s.lat,
        altitude: seaLevelToEllipsoid(s.lon, s.lat, s.altitude),
        start: { headingDeg: s.headingDeg, speed: 100 * KT, onGround: false },
        since,
      };
    } else {
      const ident = p && p.start.kind === 'runway' ? p.start.runway : HOME.runway;
      const at =
        runwayStart(airport, ident) ?? runwayStart(airport, airport.runways[0]!.ends[0].ident)!;
      pending = {
        plan: p,
        lon: at.lon,
        lat: at.lat,
        // The aircraft of the menu is parked with its engine off.
        start: { headingDeg: at.headingDeg, speed: 0, onGround: true, enginesRunning: p !== null },
        since,
      };
    }
    rebase(pending.lon, pending.lat);
    if (!timeIsFixed) {
      const time = p?.time;
      sky.setTime(typeof time === 'number' ? dateAtSwissHour(new Date(), time) : new Date());
    }
    // Live weather follows with the sky package; until then it is a fair day.
    const weather = WEATHER[p && p.weather !== 'live' ? p.weather : 'fair'];
    sky.setWeather(weather);
    game.weather.value = weather;
    env.air_ = {
      windFromDeg: weather.windFromDeg,
      windSpeed: weather.windSpeed,
      isaDeviation: weather.temperature - 15,
      wetness: weather.precipitation,
    };
  };

  /** Places the pending flight if its terrain has arrived. */
  const tryBegin = () => {
    if (!pending) return;
    const under = world.ground(pending.lon, pending.lat);
    const waited = (performance.now() - pending.since) / 1000;
    // Wait for the fine terrain under the wheels (coarse tiles are metres off) and for the
    // view to fill in, but not forever.
    if (!under) return;
    const fine = under.zoom >= profile.world.maxZoom - 1;
    // The menu shows up as soon as the aircraft can stand; a flight also waits for the view.
    if (!fine && waited < 20) return;
    if (pending.plan && world.loading && waited < 10) return;
    const ground = under.height;
    env.heightOffset = 0;
    groundZoom = under.zoom;
    groundHeight = ground;
    const p = pending;
    pending = undefined;
    const id: AircraftId = p.plan?.aircraft ?? 'c172';
    let aircraft: SimAircraft;
    try {
      aircraft = createAircraft(id);
    } catch (err) {
      console.error(err);
      game.screen.value = 'menu';
      return;
    }
    const position = geodeticToEcef(p.lon, p.lat, p.altitude ?? ground, { x: 0, y: 0, z: 0 });
    aircraft.controls.flaps = 0;
    flight = new Flight(aircraft, env, { ...p.start, position });
    aircraft.controls.parkingBrake = p.plan === null;
    // The reset trims the aircraft: take the throttle it chose.
    input.reset(aircraft.controls.throttle[0] ?? 0, aircraft.controls.flaps, true);
    assist.reset();
    visual.object.visible = true;
    void useVisual(id);
    if (p.plan) {
      setView('outside');
      game.loadProgress.value = 1;
      game.screen.value = 'flight';
    } else {
      rig.setMode('menu');
      visual.setCockpitView(false);
      game.screen.value = 'menu';
    }
  };

  // ---- interface ----
  game.airports.value = AIRPORTS.map((a) => {
    const ends = a.runways[0]!.ends;
    return {
      icao: a.icao,
      name: a.name,
      lon: (ends[0].lon + ends[1].lon) / 2,
      lat: (ends[0].lat + ends[1].lat) / 2,
      elevation: a.elevation,
      runways: a.runways.flatMap((r) => r.ends.map((e) => e.ident)),
    };
  });
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
  mountUi(uiRoot, {
    startFlight(p) {
      game.plan.value = p;
      game.loadProgress.value = 0;
      game.screen.value = 'briefing';
      prepare(p);
    },
    pause: togglePause,
    resume: togglePause,
    restart() {
      if (!flight) return;
      flight.restart();
      flight.paused = false;
      input.reset(flight.aircraft.controls.throttle[0] ?? 0, 0, true);
      assist.reset();
      env.heightOffset = 0;
      game.screen.value = 'flight';
    },
    exitToMenu() {
      game.plan.value = null;
      prepare(null);
    },
    toggleView,
  });
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
  const unlock = () => void audio.resume();
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
  };
  window.__app = debug;
  (debug as unknown as { assist: RudderAssist }).assist = assist;
  (debug as unknown as { probe: () => object }).probe = () => ({
    zoom: groundZoom,
    gh: +groundHeight.toFixed(2),
    off: +env.heightOffset.toFixed(3),
    loading: world.loading,
  });

  prepare(null);

  // ---- loop ----
  const noTouch = { pitch: null, roll: null, yaw: null, throttle: null, brake: false };
  const geo = { lon: 0, lat: 0, h: 0 };
  let last = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;
  let worst = 0;
  let hudTime = 0;

  renderer.setAnimationLoop((now: number) => {
    const frameMs = now - last;
    const dt = Math.min(frameMs / 1000, 0.25);
    last = now;

    tryBegin();
    if (pending && pending.plan)
      game.loadProgress.value = Math.max(game.loadProgress.value, world.progress * 0.98);

    if (flight) {
      const aircraft = flight.aircraft;
      const flying = plan !== null && game.screen.value === 'flight';
      readTouchButtons();
      const pad = flying ? readGamepad() : null;
      const touch = flying
        ? {
            pitch: touchInput.pitch.value,
            roll: touchInput.roll.value,
            yaw: touchInput.yaw.value,
            throttle: touchInput.throttle.value,
            brake: touchInput.brake.value,
          }
        : noTouch;
      const options = { invertPitch: settings.invertPitch.value };
      const alpha = flight.advance(dt, (stepDt) => {
        // Finer (or coarser) terrain arrived under the aircraft: its height changed without
        // the aircraft moving. Take the step out before the wheels feel it and let it fade.
        ecefToGeodetic(aircraft.state.position, geo);
        const under = world.ground(geo.lon, geo.lat);
        env.heightOffset *= Math.exp(-stepDt / 0.8);
        if (under) {
          if (under.zoom !== groundZoom) env.heightOffset += groundHeight - under.height;
          groundZoom = under.zoom;
          groundHeight = under.height;
        }
        // The parked aircraft of the menu is not flown, and a wreck takes no input.
        if (!flying || aircraft.telemetry.crashed) return;
        input.update(stepDt, keyboard.down, pad, touch, events, options, aircraft.controls);
        events.flapsDown = events.flapsUp = events.gearToggle = 0;
        assist.apply(stepDt, aircraft.telemetry, aircraft.controls);
      });
      flight.place(visual.object, frame, alpha);

      // Keep the render origin near the aircraft: single precision is exact to millimetres
      // only within a few kilometres.
      const p = visual.object.position;
      if (p.x * p.x + p.z * p.z > REBASE_DISTANCE * REBASE_DISTANCE) {
        ecefToGeodetic(aircraft.state.position, geo);
        rebase(geo.lon, geo.lat);
        flight.place(visual.object, frame, alpha);
      }
      visual.update(dt, aircraft.telemetry, aircraft.controls);
      rig.update(dt, camera, visual.object, visual.view, flying && !aircraft.telemetry.onGround);

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
        };
      }
    }

    world.update(camera);
    sky.update(camera);
    // The shadow map covers the aircraft and the ground around it.
    sky.sun.target.position.copy(visual.object.position);
    sky.sun.position.copy(visual.object.position).addScaledVector(sky.state.sunDirection, 200);

    renderer.render(scene, camera);

    debug.frames++;
    if (!debug.ready && flight && debug.frames > 5) debug.ready = true;
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
