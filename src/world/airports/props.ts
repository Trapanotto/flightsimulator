/**
 * Small things standing at an airport: windsocks, and the edge markers of grass runways.
 * Instanced (one draw per kind and airport); each instance stands on the terrain at its own
 * lon/lat, re-seated with the rest.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { type AirportInfo, LocalFrame, isPaved } from '@geo';
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
 * the grass runways. Without wind in the world's conditions, socks point down the main runway.
 */
export function propPlaces(
  frame: LocalFrame,
  airport: AirportInfo,
  detail: AirportDetail | undefined,
): PropPlaces {
  const main = airport.runways[0]!;
  const axes = runwayAxes(frame, main);
  const along = Math.atan2(-axes.dz, axes.dx);
  const p = { x: 0, y: 0, z: 0 };
  const geo = (x: number, z: number) => {
    p.x = x;
    p.y = 0;
    p.z = z;
    return frame.toGeodetic(p);
  };
  let windsocks: PropPlace[] = (detail?.windsocks ?? []).map(([lon, lat]) => ({
    lon,
    lat,
    heading: along,
  }));
  if (windsocks.length === 0) {
    // Beside the middle of the main runway, outside its strip, on the left of end A.
    const [x, z] = runwayPoint(axes, axes.length * 0.35, -(main.width / 2 + 45));
    const g = geo(x, z);
    windsocks = [{ lon: g.lon, lat: g.lat, heading: along }];
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

/** Pole and sock in one geometry with vertex colours; the sock points along +x. */
function windsockGeometry(): BufferGeometry {
  const parts: Array<{ g: BufferGeometry; colour: Color | ((y: number) => Color) }> = [];
  const pole = new CylinderGeometry(0.06, 0.08, 6.5, 8);
  pole.translate(0, 3.25, 0);
  parts.push({ g: pole, colour: new Color(0.55, 0.55, 0.55) });
  const len = 3.6;
  const sock = new CylinderGeometry(0.42, 0.18, len, 12, 5, true);
  // Along +x, hanging 20 degrees below the horizontal from the top of the pole.
  sock.rotateZ(-Math.PI / 2);
  sock.translate(len / 2, 0, 0);
  sock.rotateZ((-20 * Math.PI) / 180);
  sock.translate(0.05, 6.3, 0);
  const orange = new Color(0.75, 0.16, 0.02);
  const white = new Color(0.75, 0.75, 0.72);
  // Five bands along the sock: orange and white.
  parts.push({
    g: sock,
    colour: (x: number) =>
      Math.min(4, Math.floor(((x - 0.05) / (len * Math.cos(0.35))) * 5)) % 2 === 0 ? orange : white,
  });
  return merge(parts);
}

function merge(
  parts: Array<{ g: BufferGeometry; colour: Color | ((x: number) => Color) }>,
): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (const { g, colour } of parts) {
    const base = pos.length / 3;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      const c = typeof colour === 'function' ? colour(p.getX(i)) : colour;
      col.push(c.r, c.g, c.b);
    }
    const index = g.getIndex()!;
    for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  out.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  out.setIndex(idx);
  return out;
}

/** Shared geometries and materials of the props (one set for all airports). */
export class PropKit {
  readonly windsock = windsockGeometry();
  readonly marker = new BoxGeometry(2, 0.35, 0.4).translate(0, 0.175, 0);
  readonly windsockMaterial = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8 });
  readonly markerMaterial = new MeshStandardNodeMaterial({ roughness: 0.7 });

  /** Instanced meshes for one airport's places (matrices set by `seat`). */
  create(places: PropPlaces): InstancedMesh[] {
    const out: InstancedMesh[] = [];
    if (places.windsocks.length) {
      const m = new InstancedMesh(this.windsock, this.windsockMaterial, places.windsocks.length);
      m.name = 'Windsocks';
      out.push(m);
    }
    if (places.markers.length) {
      const m = new InstancedMesh(this.marker, this.markerMaterial, places.markers.length);
      m.name = 'Runway markers';
      const white = new Color(0.8, 0.8, 0.78);
      const orange = new Color(0.8, 0.25, 0.03);
      places.markers.forEach((p, i) => m.setColorAt(i, p.orange ? orange : white));
      out.push(m);
    }
    for (const m of out) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
    }
    return out;
  }

  dispose() {
    this.windsock.dispose();
    this.marker.dispose();
    this.windsockMaterial.dispose();
    this.markerMaterial.dispose();
  }
}

const m4 = new Matrix4();
const q = new Quaternion();
const yAxis = new Vector3(0, 1, 0);
const one = new Vector3(1, 1, 1);
const at = new Vector3();

/** Puts instance i of `mesh` at `place`, `height` metres above the ellipsoid. */
export function placeProp(
  frame: LocalFrame,
  mesh: InstancedMesh,
  i: number,
  place: PropPlace,
  height: number,
) {
  frame.fromGeodetic(place.lon, place.lat, height, at);
  q.setFromAxisAngle(yAxis, place.heading);
  mesh.setMatrixAt(i, m4.compose(at, q, one));
}
