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
import { pass } from 'three/tsl';
import { type AircraftVisual, createReferenceMarker, loadAircraftVisual } from '@aircraft';
import { AircraftSound, AudioEngine } from '@audio';
import {
  LocalFrame,
  ecefToGeodetic,
  ellipsoidToSeaLevel,
  geodeticToEcef,
  geoidUndulation,
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
import { Sky, WEATHER_PRESETS, type Weather } from '@sky';
import { type FlightPlan, game, mountUi, settings, status, touchInput } from '@ui';
import { World } from '@world';
import { AIRPORTS, findAirport, runwayStart } from './airports';
import { RudderAssist } from './assist';
import { CameraRig } from './camera';
import { PROFILES, detectDevice } from './device';
import { WorldEnvironment } from './environment';
import { Flight } from './Flight';
import { fetchLiveWeather } from './liveWeather';
import { type InputEvents, KEYS, Keyboard, PilotInput, keyAuthorityAt, readGamepad } from './input';
import { dateAtSwissHour } from './time';

/** Where the menu scene is set and where the first flight starts. */
const HOME = { icao: 'LSZB', runway: '32' };
/** The render origin follows the aircraft; it is moved when it is this far away (metres). */
const REBASE_DISTANCE = 3000;
const KT = 0.514444;

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
  rig.attach(canvas);
  rig.autoOrbit = !shot;
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
  const applyWeather = (weather: Weather) => {
    sky.setWeather(weather);
    game.weather.value = weather;
    env.air_ = {
      windFromDeg: weather.windFromDeg,
      windSpeed: weather.windSpeed,
      isaDeviation: weather.temperature - 15,
      wetness: weather.precipitation,
    };
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
    game.loadProgress.value = 0;
    // Back to the menu: the loading screen covers the change of place.
    if (!p) game.screen.value = 'loading';
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
    calm = 0;
    tilesLoaded = 0;
    reveal = undefined;
    modelReady = false;
    void useVisual(p?.aircraft ?? 'c172').then(() => (modelReady = true));
    if (!timeIsFixed) {
      const time = p?.time;
      sky.setTime(typeof time === 'number' ? dateAtSwissHour(new Date(), time) : new Date());
    }
    // Screenshot tests need a sky that looks the same every time: no drifting clouds.
    const choice = shot ? 'clear' : (p?.weather ?? 'live');
    // Live weather arrives a moment later; until then (or without a connection) a fair day.
    applyWeather(WEATHER_PRESETS[choice === 'live' ? 'fair' : choice]);
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
    const fine = under.zoom >= profile.world.maxZoom - 1;
    if (!(fine && calm > 0.5) && waited < 30) return;
    if (!modelReady && waited < 20) return;
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
    if (p.plan) setView('outside');
    else {
      rig.setMode('menu');
      visual.setCockpitView(false);
    }
    // The first frames with the aircraft compile its shaders and stall; they are drawn
    // behind the loading screen, which comes down a moment later.
    reveal = { screen: p.plan ? 'flight' : 'menu', frames: 24 };
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
      prepare(p);
      game.screen.value = 'briefing';
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
  const sound = new AircraftSound(audio);
  const unlock = () => void audio.resume().then(() => sound.start());
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
  };
  window.__app = debug;

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
        reveal = undefined;
      }
    }

    if (flight) {
      const aircraft = flight.aircraft;
      const flying = plan !== null && game.screen.value === 'flight';
      // The aircraft of the menu settles on its wheels and then stands still for good.
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
          }
        : noTouch;
      const options = {
        invertPitch: settings.invertPitch.value,
        keyAuthority: keyAuthorityAt(aircraft.telemetry.ias, aircraft.info.vs),
      };
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

    if (pending && !flight) {
      // Nothing to look at yet: wait at the start point, so its terrain loads in full detail.
      const h = (world.groundHeight(pending.lon, pending.lat) ?? 600) + (pending.altitude ? 0 : 6);
      frame.fromGeodetic(pending.lon, pending.lat, pending.altitude ?? h, camera.position);
      const b = (pending.start.headingDeg * Math.PI) / 180;
      local.copy(camera.position);
      local.x += Math.sin(b) * 100;
      local.z -= Math.cos(b) * 100;
      camera.lookAt(local);
    }

    audio.setVolume(settings.volume.value);
    audio.setMuted(settings.muted.value);
    sound.update(
      plan && flight ? flight.aircraft.telemetry : undefined,
      game.view.value === 'cockpit',
      game.screen.value === 'flight',
    );

    world.update(camera);
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

    pipeline.render();

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
