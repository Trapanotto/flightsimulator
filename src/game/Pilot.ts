import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type PerspectiveCamera,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';

/** What the pilot needs from the world. */
export interface PilotEnv {
  heightAboveGround(p: Vector3): number | undefined;
  upAt(p: Vector3, out: Vector3): Vector3;
}

/** Keys and mouse, read every frame. */
export interface PilotInput {
  held(code: string): boolean;
}

export type PilotState = 'walk' | 'freefall' | 'canopy';
export type PilotView = 'first' | 'third';
/** Things the game reacts to (messages, sounds). */
export type PilotEvent = 'opened' | 'landed' | 'hardLanding' | 'fatal';

const G = 9.81;
/** Belly-to-earth terminal velocity ~55 m/s: k = g / v². */
const DRAG_FREEFALL = G / (55 * 55);
const WALK = 1.6;
const RUN = 5.5;
/** Ram-air canopy (~170 sq ft sport canopy): forward speed and sink, full flight / brakes. */
const CANOPY_FWD = [11, 5.5];
const CANOPY_SINK = [5, 3.4];
/** The canopy opens by itself at this height above ground (automatic activation device). */
const AUTO_OPEN = 300;
const EYE = 1.68;

const tmpV = new Vector3();
const tmpQ = new Quaternion();
const tmpM = new Matrix4();
const right = new Vector3();

interface Body {
  group: Group;
  hipL: Group;
  hipR: Group;
  shoulderL: Group;
  shoulderR: Group;
}

/** A person in a flight suit (1.8 m), feet at the origin, facing +Z. */
function makePerson(): Body {
  const suit = new MeshStandardMaterial({ color: 0x3d63a8, roughness: 0.75 });
  const dark = new MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
  const skin = new MeshStandardMaterial({ color: 0xd8a888, roughness: 0.7 });
  const helmet = new MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.35 });
  const red = new MeshStandardMaterial({ color: 0xd52b1e, roughness: 0.6 });
  const group = new Group();
  const torso = new Mesh(new CapsuleGeometry(0.19, 0.42, 4, 10), suit);
  torso.position.y = 1.2;
  torso.scale.set(1.05, 1, 0.7);
  const head = new Mesh(new SphereGeometry(0.11, 14, 10), skin);
  head.position.y = 1.64;
  const lid = new Mesh(new SphereGeometry(0.125, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), helmet);
  lid.position.set(0, 1.655, -0.01);
  // Harness / container on the back, a red Swiss patch on the chest.
  const pack = new Mesh(new BoxGeometry(0.34, 0.46, 0.14), dark);
  pack.position.set(0, 1.2, -0.17);
  const patch = new Mesh(new BoxGeometry(0.07, 0.07, 0.01), red);
  patch.position.set(0.09, 1.35, 0.135);
  group.add(torso, head, lid, pack, patch);
  const limb = (
    x: number,
    y: number,
    r: number,
    len: number,
    mat: MeshStandardMaterial,
    end?: Mesh,
  ) => {
    const pivot = new Group();
    pivot.position.set(x, y, 0);
    const m = new Mesh(new CapsuleGeometry(r, len, 4, 8), mat);
    m.position.y = -len / 2 - r;
    pivot.add(m);
    if (end) {
      end.position.y = -len - r * 2;
      pivot.add(end);
    }
    group.add(pivot);
    return pivot;
  };
  const boot = () => {
    const b = new Mesh(new BoxGeometry(0.11, 0.08, 0.26), dark);
    b.geometry.translate(0, 0, 0.05);
    return b;
  };
  const hand = () => new Mesh(new SphereGeometry(0.045, 8, 6), skin);
  const hipL = limb(0.1, 0.92, 0.075, 0.74, suit, boot());
  const hipR = limb(-0.1, 0.92, 0.075, 0.74, suit, boot());
  const shoulderL = limb(0.25, 1.45, 0.055, 0.5, suit, hand());
  const shoulderR = limb(-0.25, 1.45, 0.055, 0.5, suit, hand());
  for (const m of group.children) m.castShadow = true;
  group.traverse((o) => {
    if (o instanceof Mesh) o.castShadow = true;
  });
  return { group, hipL, hipR, shoulderL, shoulderR };
}

/**
 * Ram-air canopy: 9 cells along an arc, red and white, with suspension lines to the harness.
 * Origin at the harness (shoulders), canopy ~4.5 m above, span along X.
 */
function makeCanopy(): Group {
  const g = new Group();
  const cells = 9;
  const span = 7.6;
  const chord = 2.7;
  const arc = 0.55; // radians from the centre to the tip
  const radius = span / 2 / Math.sin(arc);
  const height = 4.6;
  const red = new MeshStandardMaterial({ color: 0xd52b1e, roughness: 0.75 });
  const white = new MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.75 });
  const anchors: Vector3[] = [];
  for (let i = 0; i < cells; i++) {
    const a = -arc + (2 * arc * (i + 0.5)) / cells;
    const w = (2 * arc * radius) / cells;
    // Airfoil-ish cell: thicker at the front.
    const cell = new Mesh(new BoxGeometry(w * 1.02, 0.42, chord), i % 2 ? white : red);
    const pos = cell.geometry.attributes.position!;
    for (let v = 0; v < pos.count; v++) {
      const z = pos.getZ(v);
      const t = Math.min(1, Math.max(0, z / chord + 0.5)); // 0 tail .. 1 nose
      pos.setY(
        v,
        pos.getY(v) * (0.25 + 0.75 * Math.max(0, Math.sin(Math.PI * Math.min(1, t * 1.15))) ** 0.6),
      );
    }
    cell.geometry.computeVertexNormals();
    const x = Math.sin(a) * radius;
    const y = height - (radius - Math.cos(a) * radius);
    cell.position.set(x, y, 0);
    cell.rotation.z = -a;
    cell.castShadow = true;
    g.add(cell);
    for (const z of [-chord * 0.3, chord * 0.2]) anchors.push(new Vector3(x, y - 0.2, z));
  }
  // Lines from the bottom skin to the two risers at the shoulders.
  const pts: number[] = [];
  for (const p of anchors) {
    const riser = p.x > 0 ? 0.22 : -0.22;
    pts.push(p.x, p.y, p.z, riser, 0.25, 0);
  }
  const lines = new BufferGeometry();
  lines.setAttribute('position', new Float32BufferAttribute(pts, 3));
  g.add(
    new LineSegments(
      lines,
      new LineBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.6 }),
    ),
  );
  return g;
}

/**
 * The pilot outside the aircraft: walking (first or third person), free fall and flying a
 * parachute. Movement in the local frame of the curved earth (up from the world).
 */
export class Pilot {
  readonly group = new Group();
  state: PilotState;
  view: PilotView = 'third';
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  /** Horizontal facing direction. */
  readonly forward = new Vector3();
  readonly up = new Vector3();
  private readonly body = makePerson();
  private readonly canopy = makeCanopy();
  private readonly orient = new Group();
  /** Camera pitch (rad), mouse / arrow keys. */
  private pitch = -0.15;
  private phase = 0;
  private canopyOpen = 0;
  private canopyTime = 0;
  private bank = 0;
  private flare = 0;
  private airTime = 0;
  private landedAt = -1;
  private time = 0;
  private verticalSpeed = 0;
  /** Seconds after which the canopy opens by itself (ejection seat), or -1. */
  private openAfter = -1;
  private readonly events: PilotEvent[] = [];
  private readonly look = { dx: 0, dy: 0 };

  constructor(
    private readonly env: PilotEnv,
    private readonly canvas: HTMLElement,
    position: Vector3,
    forward: Vector3,
    velocity: Vector3,
    airborne: boolean,
  ) {
    this.group.name = 'Pilot';
    this.orient.add(this.body.group);
    this.group.add(this.orient, this.canopy);
    this.canopy.visible = false;
    this.position.copy(position);
    this.velocity.copy(velocity);
    env.upAt(position, this.up);
    this.forward.copy(forward).addScaledVector(this.up, -forward.dot(this.up)).normalize();
    this.state = airborne ? 'freefall' : 'walk';
    canvas.addEventListener('pointermove', this.onMove);
  }

  /** Ejection seat: the chute opens on its own after `seconds`. */
  autoOpen(seconds: number) {
    this.openAfter = seconds;
  }

  takeEvents(): PilotEvent[] {
    return this.events.splice(0);
  }

  toggleView() {
    this.view = this.view === 'first' ? 'third' : 'first';
  }

  /** J or Space in free fall: pull. */
  openCanopy() {
    if (this.state !== 'freefall') return;
    this.state = 'canopy';
    this.canopyTime = 0;
    this.canopy.visible = true;
    this.events.push('opened');
  }

  get onGround() {
    return this.state === 'walk' && this.airTime === 0;
  }

  get heightAboveGround() {
    return this.env.heightAboveGround(this.position) ?? 0;
  }

  private readonly onMove = (e: PointerEvent) => {
    if (document.pointerLockElement === this.canvas || e.buttons & 1) {
      this.look.dx += e.movementX;
      this.look.dy += e.movementY;
    }
  };

  update(dt: number, input: PilotInput) {
    this.time += dt;
    const k = (c: string) => input.held(c);
    this.env.upAt(this.position, this.up);
    const up = this.up;
    this.forward.addScaledVector(up, -this.forward.dot(up)).normalize();
    right.crossVectors(this.forward, up).normalize();

    // Looking around: the mouse turns the body (on the ground, in free fall) or the head.
    const turnKeys = (k('ArrowLeft') ? 1 : 0) - (k('ArrowRight') ? 1 : 0);
    const yaw = -this.look.dx * 0.003 + turnKeys * 1.8 * dt;
    this.pitch = Math.max(-1.3, Math.min(1.2, this.pitch - this.look.dy * 0.003));
    if (k('ArrowUp')) this.pitch = Math.min(1.2, this.pitch + dt);
    if (k('ArrowDown')) this.pitch = Math.max(-1.3, this.pitch - dt);
    this.look.dx = this.look.dy = 0;

    if (this.state === 'walk') this.walk(dt, k, yaw);
    else if (this.state === 'freefall') this.fall(dt, k, yaw);
    else this.fly(dt, k, yaw);
    this.pose(dt);
  }

  private walk(dt: number, k: (c: string) => boolean, yaw: number) {
    const up = this.up;
    this.forward.applyQuaternion(tmpQ.setFromAxisAngle(up, yaw));
    right.crossVectors(this.forward, up).normalize();
    const speed = k('ShiftLeft') || k('ShiftRight') ? RUN : WALK;
    const f = (k('KeyW') ? 1 : 0) - (k('KeyS') ? 1 : 0);
    const s = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0);
    const want = tmpV.copy(this.forward).multiplyScalar(f).addScaledVector(right, s);
    if (want.lengthSq() > 1) want.normalize();
    want.multiplyScalar(speed * (f < 0 ? 0.6 : 1));
    // Horizontal velocity eases towards the wish, the vertical one is gravity.
    const vUp = this.velocity.dot(up);
    const horiz = this.velocity.clone().addScaledVector(up, -vUp);
    horiz.lerp(want, 1 - Math.exp(-dt * 8));
    let vy = vUp - G * dt;
    const h = this.env.heightAboveGround(this.position);
    const grounded = h !== undefined && h <= 0.05;
    if (grounded && k('Space') && this.airTime === 0) vy = 3.6;
    this.velocity.copy(horiz).addScaledVector(up, vy);
    this.position.addScaledVector(this.velocity, dt);
    const h2 = this.env.heightAboveGround(this.position);
    if (h2 !== undefined && h2 < 0) {
      this.position.addScaledVector(up, -h2);
      if (this.velocity.dot(up) < 0) this.velocity.addScaledVector(up, -this.velocity.dot(up));
      this.airTime = 0;
    } else if (h2 !== undefined && h2 < 0.35 && vy <= 0) {
      // Walking down a slope: stay on the ground.
      this.position.addScaledVector(up, -h2);
      this.velocity.addScaledVector(up, -this.velocity.dot(up));
      this.airTime = 0;
    } else {
      this.airTime += dt;
    }
    this.phase += horiz.length() * dt * 2.6;
  }

  private fall(dt: number, k: (c: string) => boolean, yaw: number) {
    const up = this.up;
    this.airTime += dt;
    this.forward.applyQuaternion(
      tmpQ.setFromAxisAngle(up, yaw + ((k('KeyA') ? 1 : 0) - (k('KeyD') ? 1 : 0)) * 1.2 * dt),
    );
    const v = this.velocity.length();
    this.velocity.addScaledVector(this.velocity, -DRAG_FREEFALL * v * dt);
    this.velocity.addScaledVector(up, -G * dt);
    // Tracking: arms back, legs stretched, the body glides forward.
    if (k('KeyW')) this.velocity.addScaledVector(this.forward, 4 * dt);
    this.position.addScaledVector(this.velocity, dt);
    if (this.openAfter >= 0 && this.airTime > this.openAfter) this.openCanopy();
    const h = this.env.heightAboveGround(this.position);
    if (h !== undefined && h < AUTO_OPEN && this.velocity.dot(up) < -10) this.openCanopy();
    this.land(h);
  }

  private fly(dt: number, k: (c: string) => boolean, yaw: number) {
    const up = this.up;
    this.canopyTime += dt;
    this.airTime += dt;
    // Opening: snatch, slider down, the canopy inflates over ~3 s and slows the fall.
    this.canopyOpen = Math.min(1, this.canopyTime / 2.8);
    const brakes = k('KeyS') ? 1 : 0;
    const turn = (k('KeyA') ? 1 : 0) - (k('KeyD') ? 1 : 0);
    // Toggles turn the canopy; the mouse only turns the head.
    this.forward.applyQuaternion(tmpQ.setFromAxisAngle(up, turn * 0.75 * dt * this.canopyOpen));
    void yaw;
    if (k('Space') && this.flare <= 0) this.flare = 1.6;
    this.flare = Math.max(0, this.flare - dt);
    const flaring = this.flare > 0 ? Math.sin((this.flare / 1.6) * Math.PI) : 0;
    const fwd =
      CANOPY_FWD[0]! + (CANOPY_FWD[1]! - CANOPY_FWD[0]!) * Math.max(brakes, flaring * 0.8);
    let sink =
      CANOPY_SINK[0]! + (CANOPY_SINK[1]! - CANOPY_SINK[0]!) * brakes + Math.abs(turn) * 2.2;
    // A flare turns forward speed into lift for a moment: the descent nearly stops.
    sink *= 1 - 0.8 * flaring;
    const target = tmpV.copy(this.forward).multiplyScalar(fwd).addScaledVector(up, -sink);
    const tau = this.canopyOpen < 1 ? 0.6 : 0.9;
    const a = 1 - Math.exp(-dt / tau);
    // Until fully open the canopy only partly brakes.
    this.velocity.lerp(target, a * (0.25 + 0.75 * this.canopyOpen));
    if (this.canopyOpen < 1) this.velocity.addScaledVector(up, -G * dt * (1 - this.canopyOpen));
    this.bank += (turn * 0.5 - this.bank) * (1 - Math.exp(-dt * 2));
    this.position.addScaledVector(this.velocity, dt);
    // The position is the harness; the feet hang 1.45 m below it.
    const h = this.env.heightAboveGround(this.position);
    if (h !== undefined && h <= 1.45) this.land(h - 1.45, 1.45);
  }

  /** h = height of the feet above the ground; `hang` = feet below the position. */
  private land(h: number | undefined, hang = 0) {
    if (h === undefined || h > 0) return;
    const up = this.up;
    this.position.addScaledVector(up, -h - hang);
    const vs = -this.velocity.dot(up);
    this.verticalSpeed = vs;
    if (this.state === 'freefall' && vs > 20) this.events.push('fatal');
    else this.events.push(vs > 6.5 ? 'hardLanding' : 'landed');
    this.state = 'walk';
    this.landedAt = this.time;
    this.velocity.multiplyScalar(0.2).addScaledVector(up, -this.velocity.dot(up));
    this.airTime = 0;
    this.pitch = -0.15;
  }

  /** Body and canopy follow the state. */
  private pose(dt: number) {
    const up = this.up;
    right.crossVectors(this.forward, up).normalize();
    // Base frame: +Z forward, +Y up, +X left.
    const left = tmpV.copy(right).negate();
    tmpM.makeBasis(left, up, this.forward);
    this.group.position.copy(this.position);
    this.group.quaternion.setFromRotationMatrix(tmpM);
    const b = this.body;
    const o = this.orient;
    const s = Math.sin(this.phase);
    if (this.state === 'walk') {
      const moving = Math.min(1, this.velocity.length() / WALK);
      o.rotation.set(0, 0, 0);
      o.position.set(0, 0, 0);
      b.hipL.rotation.x = s * 0.55 * moving;
      b.hipR.rotation.x = -s * 0.55 * moving;
      b.shoulderL.rotation.set(-s * 0.4 * moving, 0, 0.08);
      b.shoulderR.rotation.set(s * 0.4 * moving, 0, -0.08);
    } else if (this.state === 'freefall') {
      // Belly to earth, arched, arms and legs spread.
      o.rotation.set(Math.PI / 2 - 0.15, 0, 0);
      o.position.set(0, 1.0, -0.9);
      const wob = Math.sin(this.time * 7) * 0.05;
      b.hipL.rotation.set(-0.35, 0, 0.35 + wob);
      b.hipR.rotation.set(-0.35, 0, -0.35 - wob);
      b.shoulderL.rotation.set(-0.6, 0, 1.9);
      b.shoulderR.rotation.set(-0.6, 0, -1.9);
    } else {
      // Hanging in the harness, hands on the toggles, swinging with the turns.
      o.rotation.set(0.1, 0, this.bank * 0.6);
      o.position.set(0, -1.45, 0);
      const dangle = Math.sin(this.time * 1.7) * 0.06;
      b.hipL.rotation.set(-0.15 + dangle, 0, 0.05);
      b.hipR.rotation.set(-0.15 - dangle, 0, -0.05);
      b.shoulderL.rotation.set(Math.PI - 0.25, 0, 0.15);
      b.shoulderR.rotation.set(Math.PI - 0.25, 0, -0.15);
    }
    // Canopy: inflates while opening, banks into turns; collapses after landing.
    if (this.state === 'canopy') {
      const c = this.canopyOpen;
      this.canopy.scale.set(0.15 + 0.85 * c, 0.5 + 0.5 * c, 0.3 + 0.7 * c);
      this.canopy.rotation.set(-0.12, 0, this.bank);
      this.canopy.position.set(0, 0, 0);
    } else if (this.canopy.visible && this.landedAt >= 0) {
      const t = (this.time - this.landedAt) / 1.8;
      if (t >= 1) this.canopy.visible = false;
      else {
        // Falls forward, away from the jumper, and deflates (lines included).
        const s = Math.max(0.05, 1 - t);
        this.canopy.rotation.x = -0.12 + t * 1.4;
        this.canopy.scale.set(0.4 + 0.6 * s, s, 0.4 + 0.6 * s);
        this.canopy.position.set(0, -1.4 * t, 2.5 * t);
      }
    }
    // First person: the own body is not drawn (the canopy is).
    this.body.group.visible = this.view === 'third';
    void dt;
  }

  /** Places the camera: eye height (first person) or behind and above (third person). */
  updateCamera(cam: PerspectiveCamera) {
    const up = this.up;
    right.crossVectors(this.forward, up).normalize();
    const look = this.forward.clone().applyAxisAngle(right, -this.pitch);
    let near = 0.05;
    if (this.view === 'first') {
      if (this.state === 'freefall') {
        cam.position.copy(this.position).addScaledVector(up, 0.3);
        look.copy(this.forward).applyAxisAngle(right, -(this.pitch - 0.9));
      } else if (this.state === 'canopy') {
        cam.position.copy(this.position).addScaledVector(up, -1.45 + EYE);
      } else {
        cam.position
          .copy(this.position)
          .addScaledVector(up, EYE)
          .addScaledVector(this.forward, 0.12);
      }
      cam.up.copy(up);
      cam.lookAt(tmpV.copy(cam.position).add(look));
    } else {
      const [dist, height, aim] =
        this.state === 'walk'
          ? [4.2, 1.2, 1.3]
          : this.state === 'freefall'
            ? [7, 2.5, 0]
            : [11, 1.5, 1.5];
      const back = look.clone().multiplyScalar(-dist);
      cam.position.copy(this.position).add(back).addScaledVector(up, height);
      // Never below the ground.
      const h = this.env.heightAboveGround(cam.position);
      if (h !== undefined && h < 0.4) cam.position.addScaledVector(up, 0.4 - h);
      cam.up.copy(up);
      cam.lookAt(tmpV.copy(this.position).addScaledVector(up, aim));
      near = 0.2;
    }
    if (cam.near !== near || Math.abs(cam.fov - 70) > 0.01) {
      cam.near = near;
      cam.fov = 70;
      cam.updateProjectionMatrix();
    }
  }

  rebase(delta: Vector3) {
    this.position.sub(delta);
  }

  dispose() {
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof Mesh || o instanceof LineSegments) o.geometry.dispose();
    });
  }

  /** Vertical speed at the last landing (m/s), for the message. */
  get landingSpeed() {
    return this.verticalSpeed;
  }
}
