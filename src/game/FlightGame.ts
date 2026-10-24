import { PMREMGenerator, Scene, Vector3 } from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Aircraft } from '../aircraft/Aircraft';
import { WingTrails } from '../aircraft/WingTrails';
import { CameraRig } from '../camera/CameraRig';
import type { Quality } from '../core/settings';
import { AIRCRAFT_URL } from '../hangar/Hangar';
import { FlightControls } from '../input/FlightControls';
import { MouseAim } from '../input/MouseAim';
import { type FlightEnv, type FlightEvent, FlightModel } from '../physics/FlightModel';
import type { World } from '../world/World';
import { type Runway, alongRunway, bearingDeg } from './airports';

export type StartPlace =
  | { kind: 'runway'; runway: Runway }
  | { kind: 'air'; name: string; lon: number; lat: number; h: number; heading: number };

export interface GameMessage {
  text: string;
  kind: 'info' | 'good' | 'bad';
  until: number;
}

const STEP = 1 / 120;
const RESPAWN_DELAY = 3;
const DEG = Math.PI / 180;

/**
 * Flying the TR-1 in the streamed world: physics at a fixed 120 Hz, controls, cameras,
 * start places, landing ratings and crash handling.
 */
export class FlightGame {
  readonly fm: FlightModel;
  readonly controls = new FlightControls();
  readonly aim: MouseAim;
  readonly rig: CameraRig;
  aircraft?: Aircraft;
  readonly trails = new WingTrails();
  paused = false;
  /** Waiting for terrain under the start place. */
  waitingForTerrain = true;
  message: GameMessage | null = null;
  readonly env: FlightEnv;
  private acc = 0;
  private time = 0;
  private place?: StartPlace;
  private crashTime = -1;
  private waitStarted = 0;
  private readonly events: FlightEvent[] = [];
  private readonly tmp = new Vector3();

  constructor(private readonly world: World) {
    this.env = {
      up: (p, out) => world.upAt(p, out),
      heightAboveGround: (p) => world.heightAboveGround(p),
    };
    this.fm = new FlightModel(this.env);
    this.aim = new MouseAim(world.canvas);
    this.rig = new CameraRig(world.camera, world.canvas, (p) => world.heightAboveGround(p));
  }

  async load() {
    const env = this.makeEnvironment();
    this.world.scene.environment = env;
    this.aircraft = await Aircraft.load(AIRCRAFT_URL, env);
    this.aircraft.root.traverse((o) => {
      // The sky is very bright; full-strength reflections wash the white paint out.
      const m = (o as { material?: { envMapIntensity?: number; name?: string } }).material;
      if (m && m.envMapIntensity !== undefined && m.name !== 'Glass') m.envMapIntensity = 0.45;
    });
    this.world.scene.add(this.aircraft.root, this.trails.group);
    this.applyQuality(this.world.quality);
    this.syncModel();
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
    if (this.aircraft) this.world.scene.remove(this.aircraft.root, this.trails.group);
    this.world.scene.environment = null;
  }

  /** Reflections for the aircraft: a pre-filtered copy of the sky. */
  private makeEnvironment() {
    const sky = new Sky();
    sky.scale.setScalar(1000);
    const src = this.world.sky.material.uniforms;
    const dst = sky.material.uniforms;
    for (const k of Object.keys(src)) {
      const v = src[k]!.value;
      dst[k]!.value = v?.clone ? v.clone() : v;
    }
    const scene = new Scene();
    scene.add(sky);
    const pmrem = new PMREMGenerator(this.world.renderer);
    const tex = pmrem.fromScene(scene, 0, 1, 2000).texture;
    pmrem.dispose();
    return tex;
  }

  start(place: StartPlace) {
    this.place = place;
    this.crashTime = -1;
    this.message = null;
    const { lon, lat, h, heading } = this.placePose(place);
    // Put the camera there first so the terrain under it streams in.
    this.world.moveCameraTo(lon, lat, h + 40);
    this.waitingForTerrain = true;
    this.waitStarted = this.time;
    this.pendingPose = { lon, lat, h, heading, onGround: place.kind === 'runway' };
  }

  private pendingPose?: { lon: number; lat: number; h: number; heading: number; onGround: boolean };

  private placePose(place: StartPlace) {
    if (place.kind === 'runway') {
      const r = place.runway;
      const p = alongRunway(r, 120);
      return { lon: p.lon, lat: p.lat, h: 0, heading: bearingDeg(r.from, r.to) };
    }
    return { lon: place.lon, lat: place.lat, h: place.h, heading: place.heading };
  }

  /** Tries to finish a pending start once the terrain height is known. */
  private trySpawn() {
    const pose = this.pendingPose;
    if (!pose) return;
    const ground = this.world.groundAt(pose.lon, pose.lat);
    const waited = this.time - this.waitStarted;
    // On a runway we need detailed terrain (zoom >= 14) so the aircraft sits on the real surface.
    // The time limit only guards against tiles that never arrive (no network).
    const detailed = this.world.terrainDetailAt(pose.lon, pose.lat) >= 14 || waited > 45;
    if (ground === undefined || (pose.onGround && !detailed)) {
      this.world.moveCameraTo(pose.lon, pose.lat, (ground ?? pose.h) + 40);
      return;
    }
    const h = pose.onGround ? ground + 1.53 : Math.max(pose.h, ground + 300);
    const pos = this.world.fromGeo(pose.lon, pose.lat, h);
    const basis = this.world.basisAt(pos);
    const fwd = basis.north
      .clone()
      .multiplyScalar(Math.cos(pose.heading * DEG))
      .addScaledVector(basis.east, Math.sin(pose.heading * DEG));
    this.fm.gearDown = pose.onGround;
    this.fm.flaps = 0;
    this.fm.reset(pos, fwd, pose.onGround ? 0 : 65, pose.onGround);
    this.fm.gearDown = pose.onGround;
    this.controls.input.throttle = pose.onGround ? 0 : 0.7;
    this.aim.reset(fwd);
    this.rig.snap();
    if (this.aircraft) this.aircraft.controls.gear = pose.onGround ? 1 : 0;
    this.pendingPose = undefined;
    this.waitingForTerrain = false;
  }

  /** Floating origin moved. */
  rebase(delta: Vector3) {
    this.fm.position.sub(delta);
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
    if (this.aim.active)
      Object.assign(c.aim, this.aim.steer(this.fm.forward, this.fm.up, this.fm.right));
    this.rig.aim = this.aim.active && this.rig.mode === 'chase' ? this.aim.direction : null;

    if (!this.paused && !this.waitingForTerrain) {
      this.acc = Math.min(this.acc + dt, 0.25);
      while (this.acc >= STEP) {
        this.fm.step(STEP, c.input, this.events);
        this.acc -= STEP;
      }
      for (const e of this.events.splice(0)) this.onEvent(e);
      if (this.fm.crashed && this.crashTime > 0 && this.time - this.crashTime > RESPAWN_DELAY)
        this.respawn();
    }

    this.syncModel(dt);
    // While the start place loads, the camera stays where start() put it (that is what streams
    // the terrain in); the chase camera takes over once the aircraft is placed.
    if (this.waitingForTerrain) return;
    this.rig.update(dt, {
      position: this.fm.position,
      quaternion: this.fm.quaternion,
      forward: this.fm.forward,
      up: this.fm.up,
      velocity: this.fm.velocity,
      speed: this.fm.speed,
      worldUp: this.fm.worldUp,
    });
  }

  private syncModel(dt = 0) {
    const a = this.aircraft;
    if (!a) return;
    a.root.position.copy(this.fm.position);
    a.root.quaternion.copy(this.fm.quaternion);
    a.root.visible = !this.waitingForTerrain;
    const i = this.controls.input;
    a.controls.aileron = i.roll;
    a.controls.elevator = i.pitch;
    a.controls.rudder = i.yaw;
    a.controls.flaps = this.fm.flaps;
    a.controls.gear = this.fm.gearDown ? 1 : 0;
    a.controls.rpm = this.fm.crashed ? 0 : 0.3 + 0.7 * this.fm.throttle;
    a.update(dt);
    // Vortex trails at high load or high angle of attack while fast enough.
    const f = this.fm;
    const load = Math.max(0, (Math.abs(f.gLoad) - 2.2) / 2);
    const slowHigh = f.speed > 45 ? Math.max(0, (f.angleOfAttack - 0.12) / 0.1) : 0;
    if (dt > 0)
      this.trails.update(
        dt,
        f.position,
        f.quaternion,
        f.up,
        f.crashed ? 0 : Math.min(1, load + slowHigh),
      );
  }

  private onAction(a: string) {
    switch (a) {
      case 'gear':
        if (!this.fm.onGround) {
          this.fm.gearDown = !this.fm.gearDown;
          this.say(this.fm.gearDown ? 'gearDown' : 'gearUp', 'info');
        }
        break;
      case 'flaps':
        this.fm.flaps = this.fm.flaps >= 1 ? 0 : this.fm.flaps + 0.5;
        break;
      case 'camera':
        this.rig.next();
        break;
      case 'reset':
        if (this.place) this.start(this.place);
        break;
      case 'pause':
        this.paused = !this.paused;
        break;
      case 'mouseAim':
        this.aim.enabled = !this.aim.enabled;
        if (!this.aim.enabled && document.pointerLockElement) document.exitPointerLock();
        break;
    }
  }

  private onEvent(e: FlightEvent) {
    if (e.type === 'touchdown') {
      this.say(`landing.${e.rating}|${e.sinkRate.toFixed(1)}`, 'good');
    } else if (e.type === 'crash') {
      this.crashTime = this.time;
      this.say(`crash.${e.reason}`, 'bad', RESPAWN_DELAY);
      this.rig.shake = 1;
      this.controls.rumble(1, 600);
    }
  }

  /** After a crash: continue in the air above the crash site, same heading. */
  private respawn() {
    const [lon, lat] = this.world.toGeo(this.fm.position);
    const ground = this.world.groundAt(lon, lat) ?? 0;
    const pos = this.world.fromGeo(lon, lat, ground + 500);
    const fwd = this.fm.forward.clone();
    this.fm.gearDown = false;
    this.fm.reset(pos, fwd, 65, false);
    this.fm.gearDown = false;
    this.controls.input.throttle = 0.7;
    this.aim.reset(this.fm.forward);
    this.rig.snap();
    this.crashTime = -1;
    this.message = null;
  }

  /** Message keys are translated by the view; "key|value" carries a number. */
  private say(text: string, kind: GameMessage['kind'], seconds = 4) {
    this.message = { text, kind, until: this.time + seconds };
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
