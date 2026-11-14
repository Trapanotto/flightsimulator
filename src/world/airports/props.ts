/**
 * Small things standing at an airport: windsocks, and the edge markers of grass runways.
 *
 * One draw per kind and airport, and one shader for all airports: the instances are plain
 * per-instance attributes of an InstancedBufferGeometry (place, turn, colour), never an
 * InstancedMesh, whose matrices become a uniform array sized by the instance count, a new
 * shader for every airport with a different number of markers. Each instance stands on the
 * terrain at its own lon/lat, re-seated with the rest.
 *
 * Windsocks turn and fill in the vertex stage from the world's wind (uniforms), like a real
 * one: limp in calm air, horizontal from 15 knots, a band of five per 3 knots in between.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  type Node,
  Vector4,
} from 'three/webgpu';
import {
  Fn,
  attribute,
  clamp,
  cos,
  float,
  floor,
  max,
  mix,
  normalize,
  pow,
  select,
  sin,
  transformNormalToView,
  uniform,
  varying,
  vec3,
} from 'three/tsl';
import { type AirportInfo, LocalFrame, isPaved } from '@geo';
import type { WorldConditions } from '../layers';
import type { AirportDetail } from './detail';
import { runwayAxes, runwayPoint } from './geometry';

export interface PropPlace {
  lon: number;
  lat: number;
  /** Rotation about the vertical, radians (0: the model's +x points east). */
  heading: number;
  /** Orange or white, for markers. */
  orange?: boolean;
}

export interface PropPlaces {
  windsocks: PropPlace[];
  markers: PropPlace[];
}

/** Metres between grass runway edge markers. */
const MARKER_SPACING = 60;

/**
 * Where the windsocks stand (from the map, or one beside the main runway) and the markers of
 * the grass runways.
 */
export function propPlaces(
  frame: LocalFrame,
  airport: AirportInfo,
  detail: AirportDetail | undefined,
): PropPlaces {
  const main = airport.runways[0]!;
  const axes = runwayAxes(frame, main);
  const p = { x: 0, y: 0, z: 0 };
  const geo = (x: number, z: number) => {
    p.x = x;
    p.y = 0;
    p.z = z;
    return frame.toGeodetic(p);
  };
  // Windsocks turn with the wind in the shader; their heading here is unused.
  let windsocks: PropPlace[] = (detail?.windsocks ?? []).map(([lon, lat]) => ({
    lon,
    lat,
    heading: 0,
  }));
  if (windsocks.length === 0) {
    // Beside the middle of the main runway, outside its strip, on the left of end A.
    const [x, z] = runwayPoint(axes, axes.length * 0.35, -(main.width / 2 + 45));
    const g = geo(x, z);
    windsocks = [{ lon: g.lon, lat: g.lat, heading: 0 }];
  }
  const markers: PropPlace[] = [];
  for (const r of airport.runways) {
    if (isPaved(r.surface)) continue;
    const a = runwayAxes(frame, r);
    const heading = Math.atan2(-a.dz, a.dx);
    const n = Math.max(1, Math.round(a.length / MARKER_SPACING));
    for (let i = 0; i <= n; i++) {
      const s = (i / n) * a.length;
      for (const side of [-1, 1]) {
        const [x, z] = runwayPoint(a, s, side * (r.width / 2 + 0.5));
        const g = geo(x, z);
        markers.push({ lon: g.lon, lat: g.lat, heading, orange: i === 0 || i === n });
      }
    }
  }
  return { windsocks, markers };
}

// ---- the windsock and the wind ----

export const KNOT = 1852 / 3600;
/** A standard sock is fully extended at 15 knots... */
export const WINDSOCK_FULL_KT = 15;
/** ... and has five bands, each about 3 knots of wind. */
export const WINDSOCK_BANDS = 5;

/** How far the sock is filled, 0 (limp) .. 1 (horizontal), for a wind of `speed` m/s. */
export function windsockExtension(speed: number): number {
  return Math.min(1, Math.max(0, speed / (WINDSOCK_FULL_KT * KNOT)));
}

/** How many of the five bands stand out (the pilot's reading of the sock). */
export function windsockBands(speed: number): number {
  return windsockExtension(speed) * WINDSOCK_BANDS;
}

/**
 * Angle of the sock below the horizontal, degrees, measured at its middle: 90 hanging straight
 * down in calm air, 0 at 15 knots, 18 degrees per 3 knot band in between.
 */
export function windsockDroopDeg(speed: number): number {
  return 90 * (1 - windsockExtension(speed));
}

/**
 * Turn of the sock model (its +x along the sock) about the vertical, radians, as in PropPlace:
 * 0 points east. The sock points where the wind blows to, the opposite of where it comes from.
 * In a frame with x east and z south, compass bearing b is the direction (sin b, 0, -cos b),
 * and a turn by a about y takes +x to (cos a, 0, -sin a): a = 90 degrees - b.
 */
export function windsockYaw(fromDeg: number): number {
  const toDeg = fromDeg + 180;
  const a = ((((90 - toDeg) % 360) + 540) % 360) - 180;
  return (a * Math.PI) / 180;
}

/** Spread of the droop between the mouth and the tail at half fill, radians. */
const CURL = 0.7;
/** Frequencies of the motion, rad/s: two slow swings of the heading, gusts, the cloth. */
const SWING_A = 2 * Math.PI * 0.19;
const SWING_B = 2 * Math.PI * 0.43;
const GUST = 2 * Math.PI * 0.11;
const FLUTTER = 2 * Math.PI * 2.6;
const TAU = 2 * Math.PI;

/** Geometry of the sock model (what the shader bends). */
export const SOCK = {
  /** Pivot at the top of the pole, metres. */
  pivotX: 0.05,
  pivotY: 6.3,
  length: 3.6,
  mouthRadius: 0.42,
  tailRadius: 0.18,
  poleHeight: 6.5,
};

/**
 * The axis of the sock at fraction f (0 mouth .. 1 tail) of its length, metres from the pivot
 * (x along the heading, y up), for extension e: the CPU twin of the vertex stage. The angle
 * below the horizontal runs linearly along the sock, from a little less than the mean at the
 * mouth to a little more at the tail (a half-filled sock sags towards its end).
 */
export function sockAxis(e: number, f: number): { x: number; y: number; angle: number } {
  const mid = (Math.PI / 2) * (1 - e);
  const b = Math.max(4 * e * (1 - e) * CURL, 1e-3);
  const a = mid - b / 2;
  const angle = a + b * f;
  return {
    x: (SOCK.length * (Math.sin(angle) - Math.sin(a))) / b,
    y: (SOCK.length * (Math.cos(angle) - Math.cos(a))) / b,
    angle,
  };
}

/** Per-frame values of the windsock shader, shared by every airport. */
export const windsockUniforms = {
  yaw: uniform(0),
  extension: uniform(0),
  /** Phases of SWING_A, SWING_B, GUST, FLUTTER (computed in double precision, mod 2 pi). */
  phase: uniform(new Vector4()),
};

/** Sets the windsock uniforms from the world's conditions. */
export function setWindsockConditions(c: WorldConditions) {
  const u = windsockUniforms;
  const speed = Number.isFinite(c.wind.speed) ? c.wind.speed : 0;
  u.yaw.value = windsockYaw(Number.isFinite(c.wind.fromDeg) ? c.wind.fromDeg : 0);
  u.extension.value = windsockExtension(speed);
  // Phases wrapped on the CPU: sin() of an hour of seconds times 16 rad/s in single precision
  // would step visibly.
  const t = c.time;
  u.phase.value.set(
    (SWING_A * t) % TAU,
    (SWING_B * t) % TAU,
    (GUST * t) % TAU,
    (FLUTTER * t) % TAU,
  );
}

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

/** Rotation of v about the vertical by angle a (as Object3D.rotation.y). */
function turnY(v: V3, a: F): V3 {
  const c = cos(a);
  const s = sin(a);
  return vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
}

function windsockMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: 0.8 });
  m.name = 'Windsock';
  const u = windsockUniforms;
  const place = attribute('iPlace', 'vec4') as unknown as V4;
  // -1 on the pole, 0 (mouth) .. 1 (tail) along the sock.
  const along = attribute('sockF', 'float') as unknown as F;
  const p = attribute('position', 'vec3') as unknown as V3;
  const n = attribute('normal', 'vec3') as unknown as V3;
  // A fixed phase per windsock from where it stands: socks of one airport do not swing as one.
  const own = place.w;
  const isSock = along.greaterThanEqual(0);
  const f = max(along, 0);

  // Gusts: the fill wavers a little, more in a stronger wind.
  const e0 = u.extension;
  const e = clamp(e0.add(sin(u.phase.z.add(own)).mul(0.07).mul(e0)), 0, 1);
  const mid = float(Math.PI / 2).mul(float(1).sub(e));
  const b = max(e.mul(float(1).sub(e)).mul(4 * CURL), 1e-3);
  const a = mid.sub(b.mul(0.5));
  const angle = a.add(b.mul(f));
  const axisX = sin(angle).sub(sin(a)).div(b).mul(SOCK.length);
  const axisY = cos(angle).sub(cos(a)).div(b).mul(SOCK.length);
  // Cross-section of the rest geometry (the sock lies along +x there).
  const ry = p.y.sub(SOCK.pivotY);
  const rz = p.z;
  // A limp sock collapses towards its tail; the cloth ripples as it fills.
  const ripple = sin(u.phase.w.add(own).sub(f.mul(9)))
    .mul(0.06)
    .mul(e);
  const r = mix(float(1), e.mul(0.55).add(0.45), f).mul(float(1).add(ripple.mul(f)));
  // Flutter: the tail whips sideways and up and down, a wave running down the sock.
  const wave = u.phase.w.add(own).sub(f.mul(6));
  const amp = pow(f, 1.5).mul(e.mul(0.16));
  const side = sin(wave).mul(amp);
  const lift = cos(wave.mul(1.3)).mul(amp.mul(0.5));
  // Frame along the axis: d forward-down, n1 across and up, n2 sideways.
  const ca = cos(angle);
  const sa = sin(angle);
  const sockPos = vec3(
    axisX.add(ry.mul(r).add(lift).mul(sa)).add(SOCK.pivotX),
    axisY.add(ry.mul(r).add(lift).mul(ca)).add(SOCK.pivotY),
    rz.mul(r).add(side),
  );
  const sockNormal = vec3(n.x.mul(ca).add(n.y.mul(sa)), n.x.mul(sa.negate()).add(n.y.mul(ca)), n.z);
  // The heading swings slowly about the mean wind, wider in a stronger wind.
  const swing = sin(u.phase.x.add(own))
    .mul(0.65)
    .add(sin(u.phase.y.add(own.mul(1.7))).mul(0.35))
    .mul(e0.mul(0.14));
  const yaw = u.yaw.add(swing);
  const local = select(isSock, sockPos, p) as unknown as V3;
  const normal = select(isSock, sockNormal, n) as unknown as V3;
  m.positionNode = Fn(() => turnY(local, yaw).add(place.xyz))();
  const vNormal = varying(turnY(normal, yaw), 'vSockNormal');
  m.normalNode = normalize(transformNormalToView(vNormal));
  // Bands from the mouth: orange, white, orange, white, orange. Per pixel, so the edges are
  // sharp (vertex colours would blend each band into the next).
  const vAlong = varying(along, 'vSockAlong');
  const band = floor(clamp(vAlong, 0, 0.999).mul(WINDSOCK_BANDS));
  const isOrange = band.mod(2).lessThan(0.5);
  const cloth = select(isOrange, vec3(0.75, 0.16, 0.02), vec3(0.75, 0.75, 0.72));
  m.colorNode = select(vAlong.lessThan(-0.5), vec3(0.55, 0.55, 0.55), cloth);
  return m;
}

function markerMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: 0.7 });
  m.name = 'Runway marker';
  const place = attribute('iPlace', 'vec4') as unknown as V4;
  const colour = attribute('iColour', 'vec3') as unknown as V3;
  const p = attribute('position', 'vec3') as unknown as V3;
  const n = attribute('normal', 'vec3') as unknown as V3;
  m.positionNode = Fn(() => turnY(p, place.w).add(place.xyz))();
  m.normalNode = normalize(transformNormalToView(varying(turnY(n, place.w), 'vMarkerNormal')));
  m.colorNode = varying(colour, 'vMarkerColour');
  return m;
}

/** Pole and sock in one geometry; the sock lies along +x (bent by the shader). */
function windsockGeometry(): BufferGeometry {
  const parts: Part[] = [];
  const pole = new CylinderGeometry(0.06, 0.08, SOCK.poleHeight, 8);
  pole.translate(0, SOCK.poleHeight / 2, 0);
  parts.push({ g: pole, along: () => -1 });
  const len = SOCK.length;
  // The cylinder's top ends up at +x, the tail: narrow there, wide at the mouth by the pole.
  const sock = new CylinderGeometry(SOCK.tailRadius, SOCK.mouthRadius, len, 12, 10, true);
  sock.rotateZ(-Math.PI / 2);
  sock.translate(len / 2 + SOCK.pivotX, SOCK.pivotY, 0);
  parts.push({ g: sock, along: (x) => Math.min(1, Math.max(0, (x - SOCK.pivotX) / len)) });
  return merge(parts);
}

interface Part {
  g: BufferGeometry;
  along: (x: number) => number;
}

function merge(parts: Part[]): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const alo: number[] = [];
  const idx: number[] = [];
  for (const { g, along } of parts) {
    const base = pos.length / 3;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      alo.push(along(p.getX(i)));
    }
    const index = g.getIndex()!;
    for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  out.setAttribute('sockF', new BufferAttribute(new Float32Array(alo), 1));
  out.setIndex(idx);
  return out;
}

/** A small deterministic number in [0, 2 pi) from a place, for the phase of its motion. */
function phaseOf(p: PropPlace): number {
  const h = Math.sin(p.lon * 12.9898 + p.lat * 78.233) * 43758.5453;
  return (h - Math.floor(h)) * TAU;
}

/** Distance from `c` to the nearest of the first n places (x, y, z, _ per place). */
export function nearestPlace(
  place: Float32Array,
  n: number,
  c: { x: number; y: number; z: number },
): number {
  let near = Infinity;
  for (let i = 0; i < n; i++)
    near = Math.min(
      near,
      Math.hypot(place[i * 4]! - c.x, place[i * 4 + 1]! - c.y, place[i * 4 + 2]! - c.z),
    );
  return near;
}

/** One airport's props of one kind: the mesh, and where its seated positions go. */
export interface PropMesh {
  mesh: Mesh;
  places: PropPlace[];
  /** x, y, z (filled when seated, in the airport frame) and a fourth value per instance. */
  place: Float32Array;
  /** Mark the seated positions for upload. */
  placed(): void;
  dispose(): void;
}

/** Shared geometries and materials of the props (one set for all airports). */
export class PropKit {
  readonly windsock = windsockGeometry();
  readonly marker = new BoxGeometry(2, 0.35, 0.4).translate(0, 0.175, 0);
  readonly windsockMaterial = windsockMaterial();
  readonly markerMaterial = markerMaterial();

  /** Meshes for one airport's places (positions set when seated). */
  create(places: PropPlaces): PropMesh[] {
    const out: PropMesh[] = [];
    if (places.windsocks.length) {
      const list = places.windsocks;
      const m = this.mesh(this.windsock, this.windsockMaterial, list, phaseOf, 'Windsocks');
      // Close by, the sock's shadow is part of the picture; the app turns this on near it.
      m.mesh.castShadow = false;
      out.push(m);
    }
    if (places.markers.length) {
      const list = places.markers;
      const m = this.mesh(
        this.marker,
        this.markerMaterial,
        list,
        (p) => p.heading,
        'Runway markers',
      );
      const colours = new Float32Array(list.length * 3);
      const white = new Color(0.8, 0.8, 0.78);
      const orange = new Color(0.8, 0.25, 0.03);
      list.forEach((p, i) => (p.orange ? orange : white).toArray(colours, i * 3));
      m.mesh.geometry.setAttribute('iColour', new InstancedBufferAttribute(colours, 3));
      // A 35 cm block's shadow is lost in the grass; its shadow pass would cost more than it shows.
      m.mesh.castShadow = false;
      out.push(m);
    }
    return out;
  }

  private mesh(
    base: BufferGeometry,
    material: MeshStandardNodeMaterial,
    list: PropPlace[],
    fourth: (p: PropPlace) => number,
    name: string,
  ): PropMesh {
    // Own copies of the (small) base attributes: disposing one airport's geometry frees its
    // buffers on the GPU, which must not take the other airports' with it.
    const g = new InstancedBufferGeometry();
    for (const [key, attr] of Object.entries(base.attributes))
      g.setAttribute(key, (attr as BufferAttribute).clone());
    g.setIndex(base.getIndex()!.clone());
    const place = new Float32Array(list.length * 4);
    list.forEach((p, i) => (place[i * 4 + 3] = fourth(p)));
    const attr = new InstancedBufferAttribute(place, 4);
    g.setAttribute('iPlace', attr);
    g.instanceCount = list.length;
    const mesh = new Mesh(g, material);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return {
      mesh,
      places: list,
      place,
      placed: () => (attr.needsUpdate = true),
      dispose: () => g.dispose(),
    };
  }

  dispose() {
    this.windsock.dispose();
    this.marker.dispose();
    this.windsockMaterial.dispose();
    this.markerMaterial.dispose();
  }
}
