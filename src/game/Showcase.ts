import { Quaternion, Vector3, type Texture } from 'three';
import { Aircraft } from '../aircraft/Aircraft';
import { AIRCRAFT, type AircraftType } from '../aircraft/types';
import type { Quality } from '../core/settings';
import { quaternionFromBasis } from '../physics/FlightModel';
import { makeSkyEnvironment, softenReflections } from '../render/skyEnvironment';
import type { World } from '../world/World';

/**
 * Animated start screen: the fleet flies a loop through the Bernese Oberland (up the
 * Lauterbrunnen valley, over Kleine Scheidegg past the Eiger north face to Grindelwald and back
 * down the Lütschine) while a cinematic camera cuts between shots. The route was checked
 * against the swisstopo elevation model: at least 130 m above the terrain everywhere.
 */

/** lon, lat, altitude (m above sea level) */
const ROUTE: Array<[number, number, number]> = [
  [7.903, 46.628, 1350],
  [7.905, 46.6, 1400],
  [7.93, 46.565, 2300],
  [7.965, 46.585, 2450],
  [8.0, 46.598, 2350],
  [8.04, 46.622, 1650],
  [7.99, 46.632, 1450],
  [7.94, 46.64, 1300],
];
const LON0 = 7.96;
const LAT0 = 46.61;
const MX = Math.cos((LAT0 * Math.PI) / 180) * 111_320;
const MY = 110_540;
const SHOT_SECONDS = 7;
const SHOTS_PER_AIRCRAFT = 3;
const G = 9.81;

type Shot = 'chase' | 'side' | 'flyby' | 'orbit' | 'wing' | 'wide';
const SHOTS: Shot[] = ['chase', 'side', 'flyby', 'wide', 'orbit', 'wing'];

interface Sample {
  /** Local metres east, north, altitude. */
  p: Vector3;
  /** Distance from the start, m. */
  d: number;
}

/** Closed Catmull-Rom spline through the route, resampled by arc length. */
function buildPath(): { samples: Sample[]; length: number } {
  const pts = ROUTE.map(([lon, lat, h]) => new Vector3((lon - LON0) * MX, (lat - LAT0) * MY, h));
  const n = pts.length;
  const raw: Vector3[] = [];
  const per = 200;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      raw.push(
        new Vector3()
          .addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t)
          .addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1)
          .addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t)
          .addScaledVector(p3, 0.5 * t3 - 0.5 * t2),
      );
    }
  }
  const samples: Sample[] = [];
  let d = 0;
  for (let i = 0; i < raw.length; i++) {
    if (i > 0) d += raw[i]!.distanceTo(raw[i - 1]!);
    samples.push({ p: raw[i]!, d });
  }
  return { samples, length: d + raw[0]!.distanceTo(raw[raw.length - 1]!) };
}

const PATH = buildPath();

/** Local position at distance s along the loop (wraps around). */
function pointAt(s: number, out: Vector3): Vector3 {
  const L = PATH.length;
  const d = ((s % L) + L) % L;
  const S = PATH.samples;
  let lo = 0;
  let hi = S.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (S[mid]!.d <= d) lo = mid;
    else hi = mid - 1;
  }
  const a = S[lo]!;
  const b = S[(lo + 1) % S.length]!;
  const seg = (b.d > a.d ? b.d : L) - a.d;
  return out.copy(a.p).lerp(b.p, seg > 0 ? (d - a.d) / seg : 0);
}

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
  /** Called once the terrain under the start of the flight is detailed enough to show. */
  onReady?: () => void;
  /** Called right before a camera cut (the view fades). */
  onCut?: () => void;

  private aircraft?: Aircraft;
  private typeIndex = 0;
  private envMap?: Texture;
  private s = 0;
  private time = 0;
  private shotTime = 0;
  private shotIndex = 0;
  private shot: Shot = 'chase';
  private shotsWithAircraft = 0;
  private ready = false;
  private readonly fixedCam = new Vector3();
  private readonly camSmooth = new Vector3();
  private orbitAngle = 0;
  private readonly basis = { up: new Vector3(), fwd: new Vector3(), right: new Vector3() };
  private readonly next: { type?: AircraftType; promise?: Promise<Aircraft> } = {};
  private disposed = false;

  constructor(private readonly world: World) {
    // Start somewhere in the valley, with the PC-12 (built in Stans).
    this.typeIndex = Math.max(0, AIRCRAFT.findIndex((a) => a.id === 'pc12'));
    this.s = 0;
    this.world.moveCameraTo(ROUTE[0]![0], ROUTE[0]![1], ROUTE[0]![2] + 60);
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
    // Fetch the next aircraft in the background.
    const n = AIRCRAFT[(this.typeIndex + 1) % AIRCRAFT.length]!;
    this.next.type = n;
    this.next.promise = this.loadType(n);
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
    this.camSmooth.sub(delta);
  }

  dispose() {
    this.disposed = true;
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
    this.s += v * dt;

    // Pose: along the path tangent, banked for the turn (coordinated: tan(bank) = v·ω/g).
    const pos = this.renderAt(this.s, this.anchor);
    const ahead = this.renderAt(this.s + v * 0.5, tmp2.clone());
    const behind = this.renderAt(this.s - v * 0.5, new Vector3());
    const up = this.world.upAt(pos, this.basis.up);
    const fwd = this.basis.fwd.subVectors(ahead, behind).normalize();
    const flat1 = pos.clone().sub(behind).addScaledVector(up, -pos.clone().sub(behind).dot(up)).normalize();
    const flat2 = ahead.clone().sub(pos).addScaledVector(up, -ahead.clone().sub(pos).dot(up)).normalize();
    const turn = Math.atan2(flat1.clone().cross(flat2).dot(up), flat1.dot(flat2)) / 0.5; // rad/s
    const bank = Math.max(-0.9, Math.min(0.9, Math.atan((v * turn) / G)));
    const left = new Vector3().crossVectors(up, fwd).normalize();
    const upB = new Vector3().crossVectors(fwd, left).normalize();
    const q = quaternionFromBasis(left, upB, fwd);
    // Turning left (positive turn) banks the left wing down: roll about the nose by -bank.
    q.multiply(tmpQ.setFromAxisAngle(new Vector3(0, 0, 1), -bank));
    this.basis.right.copy(left).negate();

    const a = this.aircraft;
    if (a) {
      a.root.position.copy(pos);
      a.root.quaternion.copy(q);
      a.root.visible = true;
      a.update(dt);
    }

    if (!this.ready && this.time > 1.5) {
      const [lon, lat] = this.world.toGeo(pos);
      if (this.world.terrainDetailAt(lon, lat) >= 13 || this.time > 12) {
        this.ready = true;
        this.onReady?.();
      }
    }

    this.shotTime += dt;
    if (this.shotTime > SHOT_SECONDS) this.cut();
    this.placeCamera(dt, pos, q, fwd, up, v);
  }

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
      this.fixedCam.copy(p).addScaledVector(side, len * 1.6).addScaledVector(up, len * 0.35);
    }
    if (this.shot === 'orbit') this.orbitAngle = Math.random() * Math.PI * 2;
    this.camSmooth.set(0, 0, 0);
  }

  private placeCamera(dt: number, pos: Vector3, q: Quaternion, fwd: Vector3, up: Vector3, v: number) {
    const cam = this.world.camera;
    const t = this.type;
    const len = Math.max(t.length, t.span);
    let fov = 55;
    const look = new Vector3().copy(pos);
    switch (this.shot) {
      case 'chase':
        cam.position.copy(pos).addScaledVector(fwd, -len * 1.4).addScaledVector(up, len * 0.32);
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
        cam.position.copy(new Vector3(...t.wingCam)).applyQuaternion(q).add(pos);
        look.copy(cam.position).addScaledVector(fwd, 100).addScaledVector(up, -8);
        fov = 70;
        break;
      case 'wide':
        cam.position.copy(pos).addScaledVector(fwd, -len * 6 - v * 1.5).addScaledVector(up, len * 2.2);
        fov = 50;
        break;
    }
    // Never inside the terrain.
    const h = this.world.heightAboveGround(cam.position);
    if (h !== undefined && h < 12) cam.position.addScaledVector(up, 12 - h);
    cam.up.copy(up);
    cam.lookAt(look);
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
