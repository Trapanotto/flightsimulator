import { Quaternion, Vector3, type Texture } from 'three';
import { Aircraft } from '../aircraft/Aircraft';
import { AIRCRAFT, type AircraftType } from '../aircraft/types';
import type { Quality } from '../core/settings';
import { quaternionFromBasis } from '../physics/FlightModel';
import { makeSkyEnvironment, softenReflections } from '../render/skyEnvironment';
import type { World } from '../world/World';
import { bankAt, LAT0, LON0, MX, MY, pointAt, ROUTE } from './showcasePath';

/**
 * Animated start screen: the fleet flies a smoothed loop through the Bernese Oberland
 * (showcasePath.ts) while a cinematic camera cuts between shots. The camera follows with a
 * spring so nothing shakes; attached shots (wing) stay rigid with the aircraft.
 */

const SHOT_SECONDS = 7;
const SHOTS_PER_AIRCRAFT = 3;

type Shot = 'chase' | 'side' | 'flyby' | 'orbit' | 'wing' | 'wide';
// Opens with the side view: the whole aircraft against the mountains.
const SHOTS: Shot[] = ['side', 'chase', 'flyby', 'wide', 'orbit', 'wing'];

const tmp = new Vector3();
const tmp2 = new Vector3();
const tmpQ = new Quaternion();

/** Cruise speed for the showcase, m/s (slower types fly slower). */
function speedOf(t: AircraftType) {
  return Math.min(110, Math.max(55, t.physics.vne * 0.55));
}

export class Showcase {
  /** World driver contract. */
  waitingForTerrain = false;
  readonly anchor = new Vector3();
  /**
   * Called once the scene is fully there: aircraft loaded, terrain at full detail under the
   * flight and no tiles left streaming (the start screen waits for this instead of a video).
   */
  onReady?: () => void;
  /** Loading progress 0..1 until ready. */
  onProgress?: (p: number) => void;
  /** Called right before a camera cut (the view fades). */
  onCut?: () => void;

  private aircraft?: Aircraft;
  private typeIndex = 0;
  private envMap?: Texture;
  private s = 0;
  private time = 0;
  private shotTime = 0;
  private shotIndex = 0;
  private shot: Shot = SHOTS[0]!;
  private shotsWithAircraft = 0;
  private ready = false;
  private readonly fixedCam = new Vector3();
  /** Smoothed camera and look-target offsets from the aircraft; snap after a cut. */
  private readonly camOff = new Vector3();
  private readonly lookOff = new Vector3();
  private snap = true;
  /** Smoothed lift that keeps the camera above the terrain. */
  private lift = 0;
  private bank = 0;
  private orbitAngle = 0;
  private readonly basis = { up: new Vector3(), fwd: new Vector3(), right: new Vector3() };
  private readonly next: { type?: AircraftType; promise?: Promise<Aircraft> } = {};
  private disposed = false;

  constructor(private readonly world: World) {
    // Start somewhere in the valley, with the PC-12 (built in Stans).
    this.typeIndex = Math.max(
      0,
      AIRCRAFT.findIndex((a) => a.id === 'pc12'),
    );
    this.s = 0;
    this.bank = bankAt(0, speedOf(this.type));
    this.world.moveCameraTo(ROUTE[0]![0], ROUTE[0]![1], ROUTE[0]![2] + 60);
    // Behind the loading screen: coarse terrain only, houses and water afterwards.
    world.setStartup(true);
    void this.show(AIRCRAFT[this.typeIndex]!);
  }

  get type(): AircraftType {
    return AIRCRAFT[this.typeIndex]!;
  }

  private async show(type: AircraftType) {
    this.envMap ??= makeSkyEnvironment(this.world.renderer, this.world.sky);
    const a = await this.loadType(type);
    if (this.disposed) return;
    if (this.aircraft) this.world.scene.remove(this.aircraft.root);
    this.aircraft = a;
    a.controls.gear = 0;
    a.controls.flaps = 0;
    a.controls.rpm = 0.85;
    this.world.scene.add(a.root);
    if (this.ready) this.prefetchNext();
  }

  /** Fetch the next aircraft in the background (after the loading screen). */
  private prefetchNext() {
    const n = AIRCRAFT[(this.typeIndex + 1) % AIRCRAFT.length]!;
    if (this.next.type === n) return;
    this.next.type = n;
    this.next.promise = this.loadType(n);
  }

  /** Full detail, houses and water once the menu shows (they sharpen in behind it). */
  private restoreBuildings() {
    this.world.setStartup(false);
  }

  private loadType(type: AircraftType): Promise<Aircraft> {
    if (this.next.type === type && this.next.promise) return this.next.promise;
    return Aircraft.load(type, this.envMap).then((a) => {
      softenReflections(a.root);
      a.root.traverse((o) => {
        (o as { castShadow?: boolean }).castShadow = true;
      });
      return a;
    });
  }

  applyQuality(q: Quality) {
    void q;
    // Nothing to adapt: the aircraft casts shadows when the preset has a shadow map.
  }

  rebase(delta: Vector3) {
    this.fixedCam.sub(delta);
  }

  dispose() {
    this.disposed = true;
    this.restoreBuildings();
    if (this.aircraft) this.world.scene.remove(this.aircraft.root);
    this.aircraft = undefined;
    this.envMap?.dispose();
    this.world.camera.clearViewOffset();
  }

  /** Render-space position at distance s along the loop. */
  private renderAt(s: number, out: Vector3): Vector3 {
    pointAt(s, tmp);
    return out.copy(this.world.fromGeo(LON0 + tmp.x / MX, LAT0 + tmp.y / MY, tmp.z));
  }

  update(dt: number) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const type = this.type;
    const v = speedOf(type);
    // The flight starts once its first view is complete (no streaming along a moving path).
    if (this.ready) this.s += v * dt;

    // Pose: along the path tangent, banked for the turn (coordinated: tan(bank) = v²·κ/g),
    // the bank eased in so a new aircraft or speed never snaps the wings.
    const pos = this.renderAt(this.s, this.anchor);
    const ahead = this.renderAt(this.s + v * 0.5, tmp2.clone());
    const behind = this.renderAt(this.s - v * 0.5, new Vector3());
    const up = this.world.upAt(pos, this.basis.up);
    const fwd = this.basis.fwd.subVectors(ahead, behind).normalize();
    const target = bankAt(this.s, v);
    this.bank += (target - this.bank) * (1 - Math.exp(-dt / 0.6));
    const left = new Vector3().crossVectors(up, fwd).normalize();
    const upB = new Vector3().crossVectors(fwd, left).normalize();
    const q = quaternionFromBasis(left, upB, fwd);
    // Turning left (positive bank) puts the left wing down: roll about the nose by -bank.
    q.multiply(tmpQ.setFromAxisAngle(new Vector3(0, 0, 1), -this.bank));
    this.basis.right.copy(left).negate();

    const a = this.aircraft;
    if (a) {
      a.root.position.copy(pos);
      a.root.quaternion.copy(q);
      a.root.visible = true;
      a.update(dt);
    }

    if (!this.ready) this.checkReady(pos);

    if (this.ready) this.shotTime += dt;
    if (this.shotTime > SHOT_SECONDS) this.cut();
    this.placeCamera(dt, pos, q, fwd, up, v);
  }

  private calm = 0;
  private readonly startedAt = performance.now();

  /** Most terrain work seen at once while loading (scales the progress bar). */
  private peakBusy = 1;

  /**
   * Ready once the aircraft is there and the terrain of the (still) first view has finished
   * loading: nothing left in the queues for a moment.
   */
  private checkReady(pos: Vector3) {
    void pos;
    const t = this.world.terrain;
    const loading = t ? t.inFlight + t.queued : 99;
    const uploads = t ? t.pendingUploads : 99;
    const busy = loading + uploads / 4;
    this.peakBusy = Math.max(this.peakBusy, busy);
    const calm = loading <= 2 && uploads <= 8 && !!this.aircraft;
    this.calm = calm ? this.calm + 1 : 0;
    const p =
      (this.aircraft ? 0.1 : 0) + 0.9 * Math.min(1, this.time / 3) * (1 - busy / this.peakBusy);
    this.onProgress?.(Math.min(0.99, Math.max(this.progress, p)));
    this.progress = Math.max(this.progress, p);
    // Safety net (wall clock, also when frames are slow): never wait longer than 30 s.
    const waited = (performance.now() - this.startedAt) / 1000;
    if ((this.calm > 20 && this.time > 2) || waited > 30) {
      this.ready = true;
      // The first shot runs its full length after the loading screen.
      this.shotTime = 0;
      this.restoreBuildings();
      this.prefetchNext();
      this.onProgress?.(1);
      this.onReady?.();
    }
  }

  private progress = 0;

  private cut() {
    this.onCut?.();
    this.shotTime = 0;
    this.shotIndex = (this.shotIndex + 1) % SHOTS.length;
    this.shot = SHOTS[this.shotIndex]!;
    this.shotsWithAircraft++;
    if (this.shotsWithAircraft >= SHOTS_PER_AIRCRAFT) {
      this.shotsWithAircraft = 0;
      this.typeIndex = (this.typeIndex + 1) % AIRCRAFT.length;
      void this.show(this.type);
    }
    const len = Math.max(this.type.length, this.type.span);
    if (this.shot === 'flyby') {
      // A fixed camera a few seconds ahead on the route, off to the side and a bit higher.
      const v = speedOf(this.type);
      const p = this.renderAt(this.s + v * 3.8, new Vector3());
      const ahead = this.renderAt(this.s + v * 3.8 + 50, new Vector3());
      const up = this.world.upAt(p, new Vector3());
      const side = new Vector3().subVectors(ahead, p).cross(up).normalize();
      // About a second of flight away: a sweeping pan, not a whip.
      this.fixedCam
        .copy(p)
        .addScaledVector(side, Math.max(len * 3, v * 1.1))
        .addScaledVector(up, len * 0.6);
    }
    if (this.shot === 'orbit') this.orbitAngle = Math.random() * Math.PI * 2;
    this.snap = true;
  }

  private placeCamera(
    dt: number,
    pos: Vector3,
    q: Quaternion,
    fwd: Vector3,
    up: Vector3,
    v: number,
  ) {
    const cam = this.world.camera;
    const t = this.type;
    const len = Math.max(t.length, t.span);
    let fov = 55;
    const look = new Vector3().copy(pos);
    switch (this.shot) {
      case 'chase':
        cam.position
          .copy(pos)
          .addScaledVector(fwd, -len * 1.4)
          .addScaledVector(up, len * 0.32);
        look.addScaledVector(fwd, len * 2);
        break;
      case 'side': {
        const side = this.basis.right;
        cam.position
          .copy(pos)
          .addScaledVector(side, len * 1.3)
          .addScaledVector(fwd, len * 0.25)
          .addScaledVector(up, len * 0.12);
        fov = 45;
        break;
      }
      case 'flyby':
        cam.position.copy(this.fixedCam);
        fov = 40;
        break;
      case 'orbit': {
        this.orbitAngle += dt * 0.18;
        const side = this.basis.right;
        cam.position
          .copy(pos)
          .addScaledVector(fwd, Math.cos(this.orbitAngle) * len * 1.5)
          .addScaledVector(side, Math.sin(this.orbitAngle) * len * 1.5)
          .addScaledVector(up, len * 0.45);
        break;
      }
      case 'wing':
        cam.position
          .copy(new Vector3(...t.wingCam))
          .applyQuaternion(q)
          .add(pos);
        look.copy(cam.position).addScaledVector(fwd, 100).addScaledVector(up, -8);
        fov = 70;
        break;
      case 'wide':
        cam.position
          .copy(pos)
          .addScaledVector(fwd, -len * 6 - v * 1.5)
          .addScaledVector(up, len * 2.2);
        fov = 50;
        break;
    }
    // Follow with a spring on the offsets from the aircraft (the aircraft itself never lags out
    // of the frame); attached and fixed cameras stay exact.
    const rigid = this.shot === 'wing';
    const off = cam.position.clone().sub(pos);
    const lookOff = look.clone().sub(pos);
    if (this.snap || rigid) {
      this.camOff.copy(off);
      this.lookOff.copy(lookOff);
      this.snap = false;
    } else {
      const k = 1 - Math.exp(-dt / 0.6);
      if (this.shot === 'flyby') this.camOff.copy(off);
      else this.camOff.lerp(off, k);
      this.lookOff.lerp(lookOff, k);
    }
    cam.position.copy(pos).add(this.camOff);
    const lookAt = look.copy(pos).add(this.lookOff);
    // Never inside the terrain; the lift eases in and out.
    const h = this.world.heightAboveGround(cam.position);
    const need = h === undefined ? this.lift : Math.max(0, 12 - h);
    this.lift += (need - this.lift) * (1 - Math.exp(-dt / 0.3));
    if (!rigid) cam.position.addScaledVector(up, this.lift);
    cam.up.copy(up);
    cam.lookAt(lookAt);
    // On wide screens the menu sits on the left: frame the aircraft in the right part.
    const el = this.world.renderer.domElement;
    const W = el.clientWidth;
    const H = el.clientHeight;
    const shift = W > H * 1.3 ? -Math.round(W * 0.14) : 0;
    const view = cam.view?.enabled ? cam.view : undefined;
    const stale = shift
      ? !view || view.offsetX !== shift || view.fullWidth !== W || view.fullHeight !== H
      : !!view;
    if (Math.abs(cam.fov - fov) > 0.01 || cam.near !== 0.5 || stale) {
      cam.fov = fov;
      cam.near = 0.5;
      // setViewOffset also sets the aspect from the full size.
      if (shift) cam.setViewOffset(W, H, shift, 0, W, H);
      else cam.clearViewOffset();
      cam.updateProjectionMatrix();
    }
  }
}
