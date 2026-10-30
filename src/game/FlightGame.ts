import { Quaternion, type Texture, Vector3 } from 'three';
import { makeSkyEnvironment, softenReflections } from '../render/skyEnvironment';
import { FlightAudio } from '../audio/FlightAudio';
import { Aircraft } from '../aircraft/Aircraft';
import { Pilot } from './Pilot';
import { Wreck } from './Wreck';
import type { CockpitData } from '../aircraft/CockpitDisplays';
import { WingTrails } from '../aircraft/WingTrails';
import { CameraRig } from '../camera/CameraRig';
import type { Quality } from '../core/settings';
import { type AircraftType, aircraftById, loadAircraftChoice } from '../aircraft/types';
import { FlightControls } from '../input/FlightControls';
import { MouseAim } from '../input/MouseAim';
import { type FlightEnv, type FlightEvent, FlightModel, stallSpeed } from '../physics/FlightModel';
import type { World } from '../world/World';
import { type Runway, alongRunway, bearingDeg } from './airports';
import { type ChallengeEvent, ChallengeRun } from './ChallengeRun';
import { type Course, startHeading } from './challenges';
import { RingLayer } from './RingLayer';

export type StartPlace =
  | { kind: 'runway'; runway: Runway }
  | {
      kind: 'air';
      name: string;
      lon: number;
      lat: number;
      h: number;
      heading: number;
      /** Use `h` as is (challenges); otherwise keep at least 300 m above the ground. */
      exact?: boolean;
    };

export interface GameMessage {
  text: string;
  kind: 'info' | 'good' | 'bad';
  until: number;
}

const STEP = 1 / 120;
/** Long enough to watch the aircraft break up and burn. */
const RESPAWN_DELAY = 6;
const DEG = Math.PI / 180;

/**
 * Flying an aircraft of the fleet in the streamed world: physics at a fixed 120 Hz, controls,
 * cameras, start places, landing ratings and crash handling.
 */
export class FlightGame {
  readonly fm: FlightModel;
  readonly controls = new FlightControls();
  readonly aim: MouseAim;
  readonly rig: CameraRig;
  aircraft?: Aircraft;
  readonly trails = new WingTrails();
  readonly audio = new FlightAudio();
  /** Sound setting; the O key toggles `muted` on top of it. */
  sound = { enabled: true, volume: 0.7 };
  muted = false;
  paused = false;
  /** Waiting for terrain under the start place. */
  waitingForTerrain = true;
  message: GameMessage | null = null;
  /** Set by the view: toggles the large map (key M). */
  onToggleMap?: () => void;
  readonly env: FlightEnv;
  private acc = 0;
  private time = 0;
  private place?: StartPlace;
  private crashTime = -1;
  private waitStarted = 0;
  private readonly events: FlightEvent[] = [];
  private readonly tmp = new Vector3();
  /**
   * Physics runs at a fixed 120 Hz, the screen at its own rate: the aircraft is drawn between
   * the last two physics states (otherwise it judders back and forth as 0, 1 or 2 steps fall
   * into a frame).
   */
  private readonly prevPos = new Vector3();
  private readonly prevQuat = new Quaternion();
  readonly renderPos = new Vector3();
  readonly renderQuat = new Quaternion();
  private readonly renderForward = new Vector3();
  private readonly renderUp = new Vector3();
  private renderValid = false;
  private servoUntil = 0;
  private lastCamDist = -1;
  private approach = 0;
  private envMap?: Texture;
  /** The running ring challenge, if any. */
  challenge?: ChallengeRun;
  private rings?: RingLayer;
  /** Aircraft position at the previous frame, for the ring checks. */
  private readonly lastPos = new Vector3();
  /** Set by the view: ring passed, missed, finished. */
  onChallengeEvent?: (e: ChallengeEvent) => void;
  /** The pilot outside the aircraft (walking, falling, under the canopy). */
  pilot?: Pilot;
  /** The burning wreck of the last crash. */
  wreck?: Wreck;
  /** Inputs of the aircraft while nobody flies it: hands off, throttle where it was. */
  private readonly unmanned = {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0,
    boost: false,
    brake: false,
    trim: 0,
  };

  type: AircraftType;

  constructor(
    private readonly world: World,
    type: AircraftType = loadAircraftChoice(),
  ) {
    this.env = {
      up: (p, out) => world.upAt(p, out),
      heightAboveGround: (p) => world.heightAboveGround(p),
      altitude: (p) => world.toGeo(p)[2],
    };
    this.type = type;
    this.fm = new FlightModel(this.env, type.physics);
    this.aim = new MouseAim(world.canvas);
    this.rig = new CameraRig(world.camera, world.canvas, (p) => world.heightAboveGround(p));
    this.rig.setType(type);
    this.audio.setEngine(type.engine);
  }

  async load() {
    // Only the aircraft gets the sky reflection. Not via scene.environment: since three r17x
    // that also lights Lambert materials (terrain, houses) and washes the world out.
    this.envMap ??= makeSkyEnvironment(this.world.renderer, this.world.sky);
    const type = this.type;
    const a = await Aircraft.load(type, this.envMap);
    if (type !== this.type) return; // another aircraft was chosen meanwhile
    softenReflections(a.root);
    if (this.aircraft) this.world.scene.remove(this.aircraft.root);
    this.aircraft = a;
    this.world.scene.add(a.root, this.trails.group);
    this.applyQuality(this.world.quality);
    this.syncModel();
  }

  /** Switches the aircraft type and restarts at the current start place (ends a challenge). */
  async setAircraft(type: AircraftType) {
    if (type === this.type) return;
    this.applyType(type);
    this.endChallenge();
    if (this.place) this.start(this.place);
    await this.load();
  }

  private applyType(type: AircraftType) {
    this.type = type;
    this.fm.setPhysics(type.physics);
    this.rig.setType(type);
    this.audio.setEngine(type.engine);
  }

  /** Gear down if the type cannot retract it. */
  private gearFor(down: boolean) {
    return down || this.type.physics.fixedGear;
  }

  /** Shadows and trails follow the graphics preset. */
  applyQuality(q: Quality) {
    this.trails.enabled = q.trails;
    this.aircraft?.root.traverse((o) => {
      const m = (o as { material?: { name?: string } }).material;
      const glass = m?.name === 'Glass' || m?.name === 'PropDisc';
      o.castShadow = q.shadowMap > 0 && !glass;
      o.receiveShadow = q.shadowMap > 0 && !glass;
    });
  }

  dispose() {
    this.controls.dispose();
    this.aim.dispose();
    this.rig.dispose();
    this.audio.dispose();
    if (this.aircraft) this.world.scene.remove(this.aircraft.root, this.trails.group);
    this.endChallenge();
    this.clearOutside();
    this.envMap?.dispose();
  }

  /** Starts (or restarts) a ring challenge: air start in front of the first ring. */
  startChallenge(course: Course) {
    this.endChallenge();
    // Each course is flown with its own aircraft.
    const type = aircraftById(course.aircraft);
    if (type !== this.type) {
      this.applyType(type);
      void this.load();
    }
    const s = course.start;
    // Create the run before start(): moving the camera rebases, and the run must follow.
    this.challenge = new ChallengeRun(course, (lon, lat, h) => this.world.fromGeo(lon, lat, h));
    this.rings = new RingLayer(this.challenge);
    this.world.scene.add(this.rings.group);
    this.start(
      {
        kind: 'air',
        name: course.id,
        lon: s.lon,
        lat: s.lat,
        h: s.alt,
        heading: startHeading(course),
        exact: true,
      },
      true,
    );
  }

  endChallenge() {
    this.rings?.dispose();
    this.rings = undefined;
    this.challenge = undefined;
  }

  /** Free flight from a start place; ends a running challenge unless `keepChallenge`. */
  start(place: StartPlace, keepChallenge = false) {
    if (!keepChallenge) this.endChallenge();
    this.clearOutside();
    this.place = place;
    this.crashTime = -1;
    this.message = null;
    const { lon, lat, h, heading, exact } = this.placePose(place);
    // Put the camera there first so the terrain under it streams in: already where it will be
    // once the aircraft stands there, looking the same way (no jump when loading ends).
    const onGround = place.kind === 'runway';
    this.world.moveCameraTo(lon, lat, onGround ? h + 40 : h, this.loadingView(heading));
    // The aircraft (hidden while loading) waits at the place too: map and heading are right.
    const pos = this.world.fromGeo(lon, lat, h);
    const b = this.world.basisAt(pos);
    const fwd = b.north
      .clone()
      .multiplyScalar(Math.cos(heading * DEG))
      .addScaledVector(b.east, Math.sin(heading * DEG));
    this.fm.reset(pos, fwd, 0, onGround);
    this.renderValid = false;
    this.waitingForTerrain = true;
    this.waitStarted = this.time;
    this.pendingPose = { lon, lat, h, heading, onGround: place.kind === 'runway', exact };
  }

  private pendingPose?: {
    lon: number;
    lat: number;
    h: number;
    heading: number;
    onGround: boolean;
    exact?: boolean;
  };

  private placePose(place: StartPlace) {
    if (place.kind === 'runway') {
      const r = place.runway;
      const p = alongRunway(r, 120);
      return { lon: p.lon, lat: p.lat, h: 0, heading: bearingDeg(r.from, r.to) };
    }
    return {
      lon: place.lon,
      lat: place.lat,
      h: place.h,
      heading: place.heading,
      exact: place.exact,
    };
  }

  /** Camera while a start place loads: the pose the current camera mode will have there. */
  private loadingView(heading: number) {
    const t = this.type;
    if (this.rig.mode === 'cockpit') return { heading, back: -t.eye[2], up: t.eye[1] };
    return { heading, back: t.chaseDistance, up: t.chaseHeight };
  }

  /** Tries to finish a pending start once the terrain height is known. */
  private trySpawn() {
    const pose = this.pendingPose;
    if (!pose) return;
    const ground = this.world.groundAt(pose.lon, pose.lat);
    const waited = this.time - this.waitStarted;
    // On a runway we need detailed terrain (zoom >= 14) so the aircraft sits on the real surface.
    // Challenges too: coarse tiles fill narrow valleys and would crash the aircraft at once.
    // The time limit only guards against tiles that never arrive (no network).
    const detailed = this.world.terrainDetailAt(pose.lon, pose.lat) >= 14 || waited > 45;
    if (ground === undefined || ((pose.onGround || pose.exact) && !detailed)) {
      const h = pose.onGround
        ? (ground ?? pose.h) + (ground === undefined ? 40 : this.type.physics.gearHeight)
        : Math.max(pose.h, (ground ?? 0) + (pose.exact ? 40 : 300));
      this.world.moveCameraTo(pose.lon, pose.lat, h, this.loadingView(pose.heading));
      return;
    }
    const h = pose.onGround
      ? ground + this.type.physics.gearHeight
      : Math.max(pose.h, ground + (pose.exact ? 40 : 300));
    const pos = this.world.fromGeo(pose.lon, pose.lat, h);
    const basis = this.world.basisAt(pos);
    const fwd = basis.north
      .clone()
      .multiplyScalar(Math.cos(pose.heading * DEG))
      .addScaledVector(basis.east, Math.sin(pose.heading * DEG));
    this.fm.gearDown = this.gearFor(pose.onGround);
    this.fm.flaps = 0;
    this.fm.reset(pos, fwd, pose.onGround ? 0 : this.airStartSpeed, pose.onGround);

    this.renderValid = false;
    this.fm.gearDown = this.gearFor(pose.onGround);
    this.controls.input.throttle = pose.onGround ? 0 : this.fm.throttle;
    this.aim.reset(fwd);
    this.rig.snap();
    if (this.aircraft) this.aircraft.controls.gear = this.fm.gearDown ? 1 : 0;
    this.lastPos.copy(pos);
    this.pendingPose = undefined;
    this.waitingForTerrain = false;
    if (this.challenge) this.say('challenge.go', 'info', 3);
  }

  /** Floating origin moved. */
  rebase(delta: Vector3) {
    this.fm.position.sub(delta);
    this.pilot?.rebase(delta);
    this.wreck?.rebase(delta);
    this.crashCam?.centre.sub(delta);
    this.prevPos.sub(delta);
    this.renderPos.sub(delta);
    this.lastPos.sub(delta);
    this.challenge?.rebase(delta);
    this.rig.rebase(delta);
    this.trails.rebase(delta);
  }

  /** The point the floating origin follows. */
  get anchor(): Vector3 {
    return this.fm.position;
  }

  update(dt: number) {
    this.time += dt;
    const c = this.controls;
    c.update(dt);
    for (const a of c.takeActions()) this.onAction(a);

    if (this.waitingForTerrain) this.trySpawn();
    if (this.message && this.time > this.message.until) this.message = null;

    // Mouse flight: aim follows the mouse, the autopilot turns towards it.
    this.aim.update(this.fm.worldUp);
    c.aim.active = this.aim.active;
    if (this.aim.active) {
      Object.assign(
        c.aim,
        this.aim.steer(this.fm.forward, this.fm.up, this.fm.right, this.fm.worldUp),
      );
      // Real aircraft overshoot without damping: pitch and roll rate feedback.
      const w = this.fm.omega;
      c.aim.pitch = Math.max(-1, Math.min(1, c.aim.pitch + w.x * 1.2));
      c.aim.roll = Math.max(-1, Math.min(1, c.aim.roll - w.z * 0.6));
    }
    this.rig.aim = this.aim.active && this.rig.mode === 'chase' ? this.aim.direction : null;

    if (!this.paused && !this.waitingForTerrain) {
      this.acc = Math.min(this.acc + dt, 0.25);
      const input = this.pilot ? this.unmannedInput() : c.input;
      while (this.acc >= STEP) {
        this.prevPos.copy(this.fm.position);
        this.prevQuat.copy(this.fm.quaternion);
        this.fm.step(STEP, input, this.events);
        this.acc -= STEP;
      }
      for (const e of this.events.splice(0)) this.onEvent(e);
      const run = this.challenge;
      if (run && !this.fm.crashed) {
        for (const e of run.update(dt, this.lastPos, this.fm.position)) this.onChallenge(e);
      } else if (run && !run.finished) {
        run.time += dt; // the clock keeps running while the wreck burns
      }
      this.lastPos.copy(this.fm.position);
      if (this.fm.crashed && this.crashTime > 0 && this.time - this.crashTime > RESPAWN_DELAY)
        this.respawn();
      this.updatePilot(dt);
    }
    this.updateWreck(dt);

    this.updateRenderPose();
    this.syncModel(dt);
    this.rings?.update(dt);
    this.updateAudio(dt);
    // While the start place loads, the camera stays where start() put it (that is what streams
    // the terrain in); the chase camera takes over once the aircraft is placed.
    if (this.waitingForTerrain) return;
    if (this.pilot) {
      this.pilot.updateCamera(this.world.camera);
      return;
    }
    if (this.crashCam && this.fm.crashed) {
      this.updateCrashCam(dt);
      return;
    }
    this.rig.update(dt, {
      position: this.renderPos,
      quaternion: this.renderQuat,
      forward: this.renderForward,
      up: this.renderUp,
      velocity: this.fm.velocity,
      speed: this.fm.speed,
      worldUp: this.fm.worldUp,
    });
  }

  setSound(enabled: boolean, volume: number) {
    this.sound = { enabled, volume };
    this.audio.setVolume(enabled && !this.muted, volume);
  }

  private updateAudio(dt: number) {
    const f = this.fm;
    // Doppler: how fast the camera and the aircraft close in (orbit/chase views move little).
    const dist = this.world.camera.position.distanceTo(f.position);
    if (dt > 0 && this.lastCamDist >= 0) {
      const rate = (this.lastCamDist - dist) / dt;
      this.approach += (rate - this.approach) * Math.min(1, dt * 6);
    }
    this.lastCamDist = dist;
    const inside = this.rig.mode === 'cockpit' && !this.pilot;
    this.aircraft?.setCockpitView(inside);
    this.audio.update(dt, {
      throttle: f.throttle,
      rpm: this.aircraft?.controls.rpm ?? 0,
      speed: f.speed,
      boost: f.boosting,
      inside,
      approach: inside || this.pilot ? 0 : this.approach,
      pullUp: this.pullUp && !f.crashed,
      stall: f.stalled && !f.onGround && !f.crashed,
      servo: this.time < this.servoUntil,
      onGround: f.onGround,
      // Outside the aircraft its engine is far away (or the aircraft is gone).
      paused: this.paused || this.waitingForTerrain || this.pilotFar,
    });
  }

  private readonly cockpit: CockpitData = {
    ias: 0,
    alt: 0,
    vs: 0,
    heading: 0,
    pitch: 0,
    bank: 0,
    turnRate: 0,
    throttle: 0,
    engine: 0,
    engineDisplay: 'rpm',
    engineIdle: 0,
    engineMax: 1,
    flaps: 0,
    maxFlapDeg: 0,
    gearDown: true,
    fixedGear: true,
    gLoad: 1,
    aoa: 0,
    stalled: false,
    onGround: true,
    vne: 1,
    vstall: 1,
    trim: 0,
    lon: 0,
    lat: 0,
    time: 0,
    boosting: false,
    crashed: false,
  };

  /** What the cockpit instruments show. */
  private cockpitData(): CockpitData {
    const f = this.fm;
    const d = this.cockpit;
    const b = this.world.basisAt(f.position);
    const [lon, lat, alt] = this.world.toGeo(f.position);
    const e = this.type.engine;
    d.ias = f.speed;
    d.alt = alt;
    d.vs = f.verticalSpeed;
    d.heading =
      ((Math.atan2(f.forward.dot(b.east), f.forward.dot(b.north)) * 180) / Math.PI + 360) % 360;
    d.pitch = f.pitch;
    d.bank = f.bank;
    d.turnRate = -f.omega.dot(f.worldUp);
    d.throttle = f.throttle;
    d.engine = f.crashed ? 0 : e.idle + (e.max - e.idle) * f.throttle;
    d.engineDisplay = e.display;
    d.engineIdle = e.idle;
    d.engineMax = e.max;
    d.flaps = f.flaps;
    d.maxFlapDeg = f.p.maxFlapDeg;
    d.gearDown = f.gearDown;
    d.fixedGear = f.p.fixedGear;
    d.gLoad = f.gLoad;
    d.aoa = f.angleOfAttack;
    d.stalled = f.stalled;
    d.onGround = f.onGround;
    d.vne = f.p.vne;
    d.vstall = f.stallSpeed;
    d.trim = f.trim;
    d.lon = lon;
    d.lat = lat;
    d.time = this.time;
    d.boosting = f.boosting;
    d.crashed = f.crashed;
    return d;
  }

  /** Interpolated pose for drawing (see prevPos); snaps after jumps (reset, teleport). */
  private updateRenderPose() {
    const f = this.fm;
    const jumped = !this.renderValid || this.prevPos.distanceToSquared(f.position) > 60 * 60;
    if (jumped || this.paused || f.crashed) {
      this.prevPos.copy(f.position);
      this.prevQuat.copy(f.quaternion);
    }
    this.renderValid = true;
    const alpha = Math.min(1, this.acc / STEP);
    this.renderPos.lerpVectors(this.prevPos, f.position, alpha);
    this.renderQuat.slerpQuaternions(this.prevQuat, f.quaternion, alpha);
    this.renderForward.set(0, 0, 1).applyQuaternion(this.renderQuat);
    this.renderUp.set(0, 1, 0).applyQuaternion(this.renderQuat);
  }

  private syncModel(dt = 0) {
    const a = this.aircraft;
    if (!a) return;
    if (!this.renderValid) this.updateRenderPose();
    a.root.position.copy(this.renderPos);
    a.root.quaternion.copy(this.renderQuat);
    // After a crash the wreck takes the aircraft's place until the respawn.
    a.root.visible = !this.waitingForTerrain && !(this.fm.crashed && this.wreck);
    const i = this.controls.input;
    a.controls.aileron = i.roll;
    a.controls.elevator = i.pitch;
    a.controls.rudder = i.yaw;
    a.controls.flaps = this.fm.flaps;
    a.controls.gear = this.fm.gearDown ? 1 : 0;
    a.controls.rpm = this.fm.crashed ? 0 : 0.3 + 0.7 * this.fm.throttle;
    a.controls.throttle = this.fm.throttle;
    a.update(dt);
    if (this.rig.mode === 'cockpit' && a.displays) a.updateDisplays(dt, this.cockpitData());
    // Vortex trails at high load or high angle of attack while fast enough.
    const f = this.fm;
    const load = Math.max(0, (Math.abs(f.gLoad) - 2.2) / 2);
    const slowHigh = f.speed > 45 ? Math.max(0, (f.angleOfAttack - 0.12) / 0.1) : 0;
    if (dt > 0)
      this.trails.update(
        dt,
        this.renderPos,
        this.renderQuat,
        this.renderUp,
        f.crashed ? 0 : Math.min(1, load + slowHigh),
      );
  }

  private onAction(a: string) {
    switch (a) {
      case 'gear':
        if (!this.fm.onGround && !this.type.physics.fixedGear) {
          this.fm.gearDown = !this.fm.gearDown;
          this.servoUntil = this.time + 2.2;
          this.say(this.fm.gearDown ? 'gearDown' : 'gearUp', 'info');
        }
        break;
      case 'flaps':
        this.fm.flaps = this.fm.flaps >= 1 ? 0 : this.fm.flaps + 0.5;
        this.servoUntil = this.time + 1.4;
        break;
      case 'camera':
        if (this.pilot) this.pilot.toggleView();
        else this.rig.next();
        break;
      case 'exit':
        this.exitOrEnter();
        break;
      case 'jump':
        // Space pulls the parachute in free fall (in the aircraft it is the boost key).
        this.pilot?.openCanopy();
        break;
      case 'reset':
        if (this.challenge) this.startChallenge(this.challenge.course);
        else if (this.place) this.start(this.place);
        break;
      case 'pause':
        this.paused = !this.paused;
        break;
      case 'mute':
        this.muted = !this.muted;
        this.setSound(this.sound.enabled, this.sound.volume);
        this.say(this.muted ? 'sound.off' : 'sound.on', 'info', 2);
        break;
      case 'map':
        this.onToggleMap?.();
        break;
      case 'mouseAim':
        this.aim.enabled = !this.aim.enabled;
        if (!this.aim.enabled && document.pointerLockElement) document.exitPointerLock();
        break;
    }
  }

  private onEvent(e: FlightEvent) {
    if (e.type === 'touchdown') {
      this.say(`landing.${e.rating}|${e.sinkRate.toFixed(1)} m/s`, 'good');
      this.audio.impact('touchdown', Math.max(0.4, e.sinkRate / 2));
      if (this.challenge) {
        const [lon, lat] = this.world.toGeo(this.fm.position);
        for (const c of this.challenge.touchdown(lon, lat)) this.onChallenge(c);
      }
    } else if (e.type === 'crash') {
      this.breakUp();
      if (this.pilot) {
        // Nobody aboard: no respawn, the pilot carries on outside.
        this.say('pilot.aircraftLost', 'info', 5);
        return;
      }
      this.crashTime = this.time;
      this.say(`crash.${e.reason}`, 'bad', RESPAWN_DELAY);
      this.rig.shake = 1;
      this.audio.impact('crash');
      this.controls.rumble(1, 600);
    }
  }

  private onChallenge(e: ChallengeEvent) {
    const run = this.challenge!;
    if (e.type === 'gate') {
      // No text here: the HUD counter and the chime say it without covering the next ring.
      this.audio.chime(run.next === run.gates.length ? 'last' : 'gate');
    } else if (e.type === 'miss') {
      this.say('challenge.miss', 'bad', 2.5);
      this.audio.chime('miss');
    } else if (e.type === 'land') {
      this.say('challenge.landNow', 'info', 6);
    } else if (e.type === 'finish') {
      this.message = null;
      this.audio.chime('finish');
    }
    this.onChallengeEvent?.(e);
  }

  /** The aircraft breaks apart and explodes where it hit. */
  private breakUp() {
    const a = this.aircraft;
    if (!a) return;
    this.wreck?.dispose();
    // The model is drawn at the interpolated pose: put it at the impact first.
    a.root.position.copy(this.fm.position);
    a.root.quaternion.copy(this.fm.quaternion);
    this.wreck = new Wreck(a, this.lastVelocity, {
      heightAboveGround: (p) => this.world.heightAboveGround(p),
      upAt: (p, out) => this.world.upAt(p, out),
    });
    this.world.scene.add(this.wreck.group);
    a.root.visible = false;
    this.audio.impact('crash', 1.6);
    if (!this.pilot) {
      // Watch from a distance: back along the approach, above the crash site.
      const up = this.fm.worldUp.clone();
      const back = this.lastVelocity.clone().addScaledVector(up, -this.lastVelocity.dot(up));
      if (back.lengthSq() < 1)
        back.copy(this.fm.forward).addScaledVector(up, -this.fm.forward.dot(up));
      back.normalize().negate();
      this.crashCam = { centre: this.fm.position.clone(), back, angle: 0 };
    }
  }

  /** Camera after a crash: circles the burning wreck slowly. */
  private crashCam?: { centre: Vector3; back: Vector3; angle: number };

  private updateCrashCam(dt: number) {
    const c = this.crashCam!;
    const cam = this.world.camera;
    const up = this.world.upAt(c.centre, new Vector3());
    const k = Math.min(5, Math.max(1, this.type.length / 10));
    c.angle += dt * 0.12;
    const dir = c.back.clone().applyAxisAngle(up, c.angle);
    const dist = 45 * k;
    cam.position
      .copy(c.centre)
      .addScaledVector(dir, dist)
      .addScaledVector(up, dist * 0.42);
    const h = this.world.heightAboveGround(cam.position);
    if (h !== undefined && h < 8) cam.position.addScaledVector(up, 8 - h);
    cam.up.copy(up);
    cam.lookAt(c.centre.clone().addScaledVector(up, 4 * k));
    if (cam.near !== 0.5) {
      cam.near = 0.5;
      cam.fov = 60;
      cam.updateProjectionMatrix();
    }
  }

  private updateWreck(dt: number) {
    const w = this.wreck;
    if (!w) return;
    if (!this.paused) w.update(dt, this.world.camera.position);
    if (w.done) {
      w.dispose();
      this.wreck = undefined;
    }
  }

  /** Velocity just before the impact (the crash stops the flight model). */
  private readonly lastVelocity = new Vector3();

  private unmannedInput() {
    const u = this.unmanned;
    u.throttle = this.fm.throttle;
    u.brake = this.fm.onGround;
    return u;
  }

  /** The pilot is out and away from the engine noise. */
  private get pilotFar(): boolean {
    const p = this.pilot;
    return !!p && (this.fm.crashed || p.position.distanceTo(this.fm.position) > 40);
  }

  /** J: get out (standing on the ground), jump (in flight) or get back in (next to it). */
  private exitOrEnter() {
    const a = this.aircraft;
    if (!a || this.waitingForTerrain) return;
    const f = this.fm;
    if (this.pilot) {
      const p = this.pilot;
      if (p.state === 'freefall') {
        p.openCanopy();
        return;
      }
      if (p.state === 'canopy') return;
      const reach = Math.max(6, this.type.length * 0.4);
      if (p.state !== 'walk' || f.crashed || p.position.distanceTo(f.position) > reach) {
        this.say(f.crashed ? 'pilot.aircraftLost' : 'pilot.tooFar', 'info', 3);
        return;
      }
      p.dispose();
      this.pilot = undefined;
      // Running with Shift moved the throttle keys' value: back to the engine's setting.
      this.controls.input.throttle = this.fm.throttle;
      this.rig.snap();
      this.say('pilot.enter', 'info', 2);
      return;
    }
    if (f.crashed) return;
    const flying = !f.onGround;
    if (!flying && f.speed > 1.5) {
      this.say('pilot.stopFirst', 'info', 3);
      return;
    }
    // Out through the door on the left (+X), or the ejection seat straight up (F-35).
    const eject = flying && this.type.id === 'f35';
    const eye = this.type.eye;
    const side = eject ? 0 : eye[0] + 0.9 + 0.45 * Math.sqrt(this.type.length / 8);
    const local = new Vector3(side, eject ? eye[1] + 1 : flying ? eye[1] - 0.8 : 0, eye[2]);
    const pos = local.applyQuaternion(f.quaternion).add(f.position);
    const vel = f.velocity.clone();
    if (eject) vel.addScaledVector(f.up, 22);
    else if (flying) vel.addScaledVector(f.right, -2);
    const p = new Pilot(
      {
        heightAboveGround: (q) => this.world.heightAboveGround(q),
        upAt: (q, out) => this.world.upAt(q, out),
      },
      this.world.canvas,
      pos,
      f.forward,
      vel,
      flying,
    );
    if (eject) p.autoOpen(1.6);
    this.pilot = p;
    this.world.scene.add(p.group);
    if (document.pointerLockElement) document.exitPointerLock();
    this.say(eject ? 'pilot.eject' : flying ? 'pilot.jumped' : 'pilot.out', 'info', 6);
  }

  private updatePilot(dt: number) {
    if (!this.fm.crashed) this.lastVelocity.copy(this.fm.velocity);
    const p = this.pilot;
    if (!p) return;
    p.update(dt, this.controls);
    for (const e of p.takeEvents()) {
      if (e === 'opened') this.say('pilot.opened', 'info', 6);
      else if (e === 'landed') this.say('pilot.landed', 'good', 4);
      else if (e === 'hardLanding') this.say('pilot.hardLanding', 'bad', 4);
      else if (e === 'fatal') {
        this.say('pilot.fatal', 'bad', 5);
        this.audio.impact('crash', 0.6);
        // Back to the start place after a moment.
        setTimeout(() => {
          if (this.pilot === p && this.place) this.start(this.place);
        }, 3500);
      }
    }
  }

  /** Pilot and wreck go away (new start, other aircraft). */
  private clearOutside() {
    this.crashCam = undefined;
    this.pilot?.dispose();
    this.pilot = undefined;
    this.wreck?.dispose();
    this.wreck = undefined;
    if (this.aircraft) this.aircraft.root.visible = true;
  }

  /** After a crash: continue in the air above the crash site, same heading. */
  private respawn() {
    this.crashCam = undefined;
    if (this.challenge && !this.challenge.finished) {
      // Challenge: back at the last ring passed, pointing at the next one.
      const { position, forward } = this.challenge.respawnPose();
      // Only the landing is left: continue on final, configured for landing.
      const landing = this.challenge.awaitingLanding;
      const p = this.type.physics;
      const speed = landing ? stallSpeed(p, 1) * 1.3 : this.airStartSpeed;
      this.fm.gearDown = this.gearFor(landing);
      this.fm.flaps = landing ? 1 : 0;
      this.fm.reset(position, forward, speed, false);

      this.renderValid = false;
      this.fm.gearDown = this.gearFor(landing);
      if (this.aircraft) this.aircraft.controls.gear = this.fm.gearDown ? 1 : 0;
      // reset() set the throttle for level flight in this configuration.
      this.controls.input.throttle = this.fm.throttle;
      this.aim.reset(forward);
      this.rig.snap();
      this.lastPos.copy(position);
      this.crashTime = -1;
      this.message = null;
      return;
    }
    const [lon, lat] = this.world.toGeo(this.fm.position);
    const ground = this.world.groundAt(lon, lat) ?? 0;
    const pos = this.world.fromGeo(lon, lat, ground + 500);
    const fwd = this.fm.forward.clone();
    this.fm.gearDown = this.gearFor(false);
    this.fm.reset(pos, fwd, this.airStartSpeed, false);

    this.renderValid = false;
    this.fm.gearDown = this.gearFor(false);
    this.controls.input.throttle = this.fm.throttle;
    this.aim.reset(this.fm.forward);
    this.rig.snap();
    this.lastPos.copy(pos);
    this.crashTime = -1;
    this.message = null;
  }

  /** Message keys are translated by the view; "key|value" carries a number. */
  private say(text: string, kind: GameMessage['kind'], seconds = 4) {
    this.message = { text, kind, until: this.time + seconds };
  }

  /** Speed for air starts and respawns: comfortably above the stall speed. */
  private get airStartSpeed() {
    // Comfortably above the stall, well below the maximum speed.
    const p = this.type.physics;
    return Math.min(p.vne * 0.8, stallSpeed(p) * 1.6);
  }

  /** Terrain warning: less than ~6 s to impact at the current sink rate. */
  get pullUp(): boolean {
    const vs = this.fm.verticalSpeed;
    const hag = this.world.heightAboveGround(this.fm.position);
    if (hag === undefined || this.fm.onGround || vs > -3) return false;
    const landingConfig = this.fm.gearDown && this.fm.speed < 60 && vs > -6;
    return !landingConfig && hag / -vs < 6;
  }

  /** Screen-space direction helpers for the HUD reticles (world points far along each). */
  aimPoint(out: Vector3) {
    return out.copy(this.fm.position).addScaledVector(this.aim.direction, 800);
  }

  nosePoint(out: Vector3) {
    return out.copy(this.fm.position).addScaledVector(this.fm.forward, 800);
  }

  get heightAboveGround(): number | undefined {
    return this.world.heightAboveGround(this.tmp.copy(this.fm.position));
  }
}
