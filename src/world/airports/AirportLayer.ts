/**
 * The airports near the camera: runways with their markings, taxiways, aprons, lights,
 * windsocks. A world layer (layers.ts): streams by itself and stands on the terrain.
 *
 * Streaming: airports within the preset's range are built, one step per frame (runways, then
 * the ground detail file once it has arrived, then lights, then props), and dropped beyond the
 * drop range. Seating: every vertex, light and prop takes its height from the terrain, a few
 * thousand queries per frame, nearest airport first; when terrain tiles arrive, a handful of
 * probe points per airport tell whether its ground changed, and only then is it seated again.
 * An airport is shown once it has been seated completely.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  type Object3D,
  Vector3,
} from 'three/webgpu';
import { uniform } from 'three/tsl';
import {
  AIRPORTS,
  AIRPORT_ATTRIBUTION,
  type AirportInfo,
  LocalFrame,
  distanceM,
  seaLevelToEllipsoid,
} from '@geo';
import type { DeviceClass, LayerContext, WorldConditions, WorldLayer } from '../layers';
import { type AirportDetail, decodeDetail, detailUrl } from './detail';
import { type Draped, type Steps, groundSteps, runwaySteps } from './geometry';
import { createLightGeometry, createLightMaterial, lightUniforms } from './lightMaterial';
import { lightSteps } from './lights';
import { AIRPORT_PRESETS, type AirportPreset } from './presets';
import { PropKit, type PropMesh, nearestPlace, propPlaces, setWindsockConditions } from './props';
import {
  SurfaceTextures,
  createGroundMaterial,
  createLineMaterial,
  createRunwayMaterial,
} from './surfaceMaterial';

/**
 * How much of the airport lighting is on. Night for now; poor visibility (fog, low cloud)
 * should switch it on too once the conditions carry it: max(night, lowVisibility).
 */
export function lightsOnFor(c: WorldConditions): number {
  return Math.min(1, Math.max(0, c.night));
}

/** Seconds an airport may keep the loading screen up before it is shown as it is. */
const LOADING_TIMEOUT = 12;
/** Milliseconds per frame for building geometry (a big airport takes a few dozen frames). */
const BUILD_MS = 4;
/** Milliseconds per frame for seating on the terrain. */
const SEAT_MS = 3;
/** A probe whose ground moved more than this triggers a new seating pass. */
const PROBE_TOLERANCE = 0.01;
/**
 * Windsocks cast shadows only this close to the camera: the shadow map covers a few dozen metres
 * around the aircraft, and a sock further away only costs a shadow pass that draws nothing.
 */
export const WINDSOCK_SHADOW_RANGE = 100;

/** Something whose points take their heights from the terrain. */
interface Seatable {
  lon: Float64Array;
  lat: Float64Array;
  /** Metres above the ground, per point (default 0). */
  lift?: Float32Array;
  /** Output: local x, y, z of point i at out[i * stride + offset .. + 2]. */
  out: Float32Array;
  stride: number;
  /** Called when a full pass has been written. */
  done(): void;
}

interface Probe {
  lon: number;
  lat: number;
  h: number | undefined;
}

const AXES = [
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: 1 },
];
const va = { x: 0, y: 0, z: 0 };
const vb = { x: 0, y: 0, z: 0 };

/** Column-major matrix taking the airport frame into the render frame (double precision). */
function frameToRender(local: LocalFrame, render: LocalFrame, out: number[]) {
  AXES.forEach((axis, col) => {
    render.dirToLocal(local.dirToEcef(axis, va), vb);
    out[col * 4] = vb.x;
    out[col * 4 + 1] = vb.y;
    out[col * 4 + 2] = vb.z;
    out[col * 4 + 3] = 0;
  });
  render.toLocal(local.originEcef(va), vb);
  out[12] = vb.x;
  out[13] = vb.y;
  out[14] = vb.z;
  out[15] = 1;
}

type Stage = 'runways' | 'ground' | 'lights' | 'props' | 'done';

/** Shared GPU resources of all airports. */
class Kit {
  readonly textures = new SurfaceTextures();
  readonly runway = createRunwayMaterial(this.textures);
  readonly ground = createGroundMaterial(this.textures);
  readonly lines = createLineMaterial(this.textures);
  readonly props = new PropKit();
  /**
   * One light material for all airports (one shader); the camera in each airport's own frame
   * is a per-object uniform, read from the Lights mesh.
   */
  readonly lights = createLightMaterial(
    uniform(new Vector3()).onObjectUpdate(
      ({ object }) => (object as Object3D).userData.cameraLocal as Vector3,
    ),
  );

  dispose() {
    this.lights.dispose();
    this.textures.dispose();
    this.runway.dispose();
    this.ground.dispose();
    this.lines.dispose();
    this.props.dispose();
  }
}

/** One airport being shown. */
class Site {
  readonly group = new Group();
  readonly frame: LocalFrame;
  stage: Stage = 'runways';
  detail: AirportDetail | undefined;
  detailState: 'loading' | 'done' = 'done';
  private readonly abort = new AbortController();
  readonly seatables: Seatable[] = [];
  readonly probes: Probe[] = [];
  private readonly geometries: BufferGeometry[] = [];
  /** Seating cursor: item, point; undefined when no pass is running. */
  cursor: { item: number; point: number; missing: number } | undefined;
  /** Ground changed during a pass: another one follows. */
  dirty = false;
  seated = false;
  revision = -1;
  readonly since = performance.now();
  /** The camera in this airport's frame, for its lights (see lightMaterial.ts). */
  private readonly cameraLocal = new Vector3();
  private readonly props: PropMesh[] = [];
  private windsocks?: PropMesh;
  distance = 0;
  /** Counts for performance notes. */
  readonly stats = { vertices: 0, triangles: 0, lights: 0, draws: 0 };

  constructor(
    readonly airport: AirportInfo,
    private readonly preset: AirportPreset,
    private readonly kit: Kit,
    render: LocalFrame,
  ) {
    this.frame = new LocalFrame(
      airport.lon,
      airport.lat,
      seaLevelToEllipsoid(airport.lon, airport.lat, airport.elevation),
    );
    this.group.name = `Airport ${airport.icao}`;
    this.group.matrixAutoUpdate = false;
    this.group.userData.site = this;
    this.group.visible = false;
    this.setFrame(render);
    if (airport.detail && preset.ground) {
      this.detailState = 'loading';
      fetch(detailUrl(airport.icao), { signal: this.abort.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((json) => (this.detail = decodeDetail(json)))
        .catch((err: unknown) => {
          if ((err as Error).name !== 'AbortError')
            console.warn(`airport ${airport.icao}: no ground detail`, err);
        })
        .finally(() => (this.detailState = 'done'));
    }
  }

  setFrame(render: LocalFrame) {
    frameToRender(this.frame, render, this.group.matrix.elements);
    this.group.matrixWorldNeedsUpdate = true;
  }

  /** The camera, given in ECEF, in this airport's frame. */
  setCamera(ecef: { x: number; y: number; z: number }) {
    this.frame.toLocal(ecef, this.cameraLocal);
    const w = this.windsocks;
    if (w && this.seated)
      w.mesh.castShadow =
        nearestPlace(w.place, w.places.length, this.cameraLocal) < WINDSOCK_SHADOW_RANGE;
  }

  /** True while this airport still has something to build or seat for the first time. */
  get busy(): boolean {
    if ((performance.now() - this.since) / 1000 > LOADING_TIMEOUT) return false;
    return this.stage !== 'done' || !this.seated || this.cursor !== undefined;
  }

  /** One build step; false if waiting (for the detail file). */
  /** The build in progress and when this frame's share of time is up. */
  private steps?: Steps<unknown>;

  /** Advances the stage's build until `deadline`; its result once it has finished. */
  private advance<T>(make: () => Steps<T>, deadline: number): T | undefined {
    const steps = (this.steps ??= make()) as Steps<T>;
    for (;;) {
      const r = steps.next();
      if (r.done) {
        this.steps = undefined;
        return r.value;
      }
      if (performance.now() >= deadline) return undefined;
    }
  }

  /** Builds for at most `budgetMs`; false if waiting (for the detail file). */
  step(budgetMs: number): boolean {
    const deadline = performance.now() + budgetMs;
    const opt = { step: this.preset.step, across: this.preset.across };
    switch (this.stage) {
      case 'runways': {
        const d = this.advance(() => runwaySteps(this.frame, this.airport, opt), deadline);
        if (!d) return true;
        if (d.index.length) this.addDraped(d, [this.kit.runway], 3);
        this.stage = 'ground';
        return true;
      }
      case 'ground': {
        if (this.detailState === 'loading') return false;
        const d = this.advance(
          () => groundSteps(this.frame, this.airport, this.detail, opt),
          deadline,
        );
        if (!d) return true;
        if (d.index.length) this.addDraped(d, [this.kit.ground, this.kit.lines], 1);
        this.stage = 'lights';
        return true;
      }
      case 'lights': {
        const b = this.advance(
          () =>
            lightSteps(this.frame, this.airport, this.detail, {
              centreSpacing: this.preset.centreSpacing,
              touchdownZone: this.preset.touchdownZone,
              taxiSpacing: this.preset.taxiSpacing,
            }),
          deadline,
        );
        if (!b) return true;
        if (b.count > 0) {
          const positions = new Float32Array(b.count * 4);
          for (let i = 0; i < b.count; i++) positions[i * 4 + 3] = b.size[i]!;
          const geometry = createLightGeometry(b, positions);
          const mesh = new Mesh(geometry, this.kit.lights);
          mesh.name = 'Lights';
          mesh.userData.cameraLocal = this.cameraLocal;
          mesh.frustumCulled = false;
          mesh.renderOrder = 5;
          this.group.add(mesh);
          this.geometries.push(geometry);
          this.stats.lights = b.count;
          this.stats.draws++;
          const attr = geometry.getAttribute('iPos') as BufferAttribute;
          this.addSeatable({
            lon: b.lon,
            lat: b.lat,
            lift: b.height,
            out: positions,
            stride: 4,
            done: () => (attr.needsUpdate = true),
          });
        }
        this.stage = 'props';
        return true;
      }
      case 'props': {
        const places = propPlaces(this.frame, this.airport, this.detail);
        for (const prop of this.kit.props.create(places)) {
          this.group.add(prop.mesh);
          this.props.push(prop);
          if (prop.mesh.name === 'Windsocks') this.windsocks = prop;
          this.stats.draws++;
          this.addSeatable({
            lon: Float64Array.from(prop.places, (p) => p.lon),
            lat: Float64Array.from(prop.places, (p) => p.lat),
            out: prop.place,
            stride: 4,
            done: prop.placed,
          });
        }
        this.stage = 'done';
        return true;
      }
      default:
        return false;
    }
  }

  private addDraped(d: Draped, materials: Array<Mesh['material']>, order: number) {
    const geometry = new BufferGeometry();
    const positions = new Float32Array(d.lon.length * 3);
    const position = new BufferAttribute(positions, 3);
    geometry.setAttribute('position', position);
    // Normals straight up: airports are flat to a few per cent, and recomputing normals of a
    // 60 000 vertex mesh after every re-seat would cost a frame's worth of time.
    const normals = new Float32Array(d.lon.length * 3);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    // All other attributes interleaved in one buffer: WebGPU allows only 8 vertex buffers, and
    // a runway has 30 floats of parameters per vertex.
    const entries = Object.entries(d.attributes);
    const stride = entries.reduce((n, [, a]) => n + a.size, 0);
    const packed = new Float32Array(d.lon.length * stride);
    let offset = 0;
    for (const [, a] of entries) {
      for (let i = 0; i < d.lon.length; i++)
        for (let k = 0; k < a.size; k++) packed[i * stride + offset + k] = a.array[i * a.size + k]!;
      offset += a.size;
    }
    const interleaved = new InterleavedBuffer(packed, stride);
    offset = 0;
    for (const [name, a] of entries) {
      geometry.setAttribute(name, new InterleavedBufferAttribute(interleaved, a.size, offset));
      offset += a.size;
    }
    geometry.setIndex(new BufferAttribute(d.index, 1));
    this.geometries.push(geometry);
    materials.forEach((material, k) => {
      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.renderOrder = order + k;
      this.group.add(mesh);
      this.stats.draws++;
    });
    this.stats.vertices += d.lon.length;
    this.stats.triangles += d.index.length / 3;
    this.addSeatable({
      lon: d.lon,
      lat: d.lat,
      out: positions,
      stride: 3,
      done: () => {
        position.needsUpdate = true;
      },
    });
  }

  private addSeatable(s: Seatable) {
    this.seatables.push(s);
    // Probes: a sparse sample of the points, enough to notice finer terrain anywhere.
    const every = Math.max(1, Math.floor(s.lon.length / 40));
    for (let i = 0; i < s.lon.length; i += every)
      this.probes.push({ lon: s.lon[i]!, lat: s.lat[i]!, h: undefined });
    // A new piece: seat everything again (cheap compared with building it).
    this.dirty = true;
  }

  /** Has the ground under the probes changed since the last pass? */
  checkProbes(ground: LayerContext['groundHeight']): boolean {
    let changed = false;
    for (const p of this.probes) {
      const h = ground(p.lon, p.lat);
      if (
        h === undefined
          ? p.h !== undefined
          : p.h === undefined || Math.abs(h - p.h) > PROBE_TOLERANCE
      )
        changed = true;
    }
    return changed;
  }

  /** Seats up to `budget` points; returns how many it used. */
  seat(ground: LayerContext['groundHeight'], budget: number): number {
    const t0 = performance.now();
    if (!this.cursor) {
      if (!this.dirty) return 0;
      this.dirty = false;
      this.cursor = { item: 0, point: 0, missing: 0 };
      for (const p of this.probes) p.h = ground(p.lon, p.lat);
    }
    const c = this.cursor;
    const fallback = this.frame.origin.h;
    const tmp = { x: 0, y: 0, z: 0 };
    let used = 0;
    while (used < budget && c.item < this.seatables.length) {
      const s = this.seatables[c.item]!;
      const n = s.lon.length;
      while (used < budget && c.point < n) {
        // Never more than a few milliseconds, however slow the height queries are here.
        if ((used & 255) === 255 && performance.now() - t0 > SEAT_MS) {
          budget = used;
          break;
        }
        const i = c.point++;
        let h = ground(s.lon[i]!, s.lat[i]!);
        if (h === undefined) {
          h = fallback;
          c.missing++;
        }
        this.frame.fromGeodetic(s.lon[i]!, s.lat[i]!, h + (s.lift?.[i] ?? 0), tmp);
        const o = i * s.stride;
        s.out[o] = tmp.x;
        s.out[o + 1] = tmp.y;
        s.out[o + 2] = tmp.z;
        used++;
      }
      if (c.point >= n) {
        c.item++;
        c.point = 0;
      }
    }
    if (c.item >= this.seatables.length) {
      for (const s of this.seatables) s.done();
      this.cursor = undefined;
      // Shown once the terrain under all of it has been there; or after the timeout anyway.
      if (c.missing === 0 || (performance.now() - this.since) / 1000 > LOADING_TIMEOUT) {
        this.seated = true;
        this.group.visible = true;
      } else this.dirty = true;
    }
    return used;
  }

  dispose() {
    this.abort.abort();
    for (const g of this.geometries) g.dispose();
    for (const p of this.props) p.dispose();
    this.group.removeFromParent();
  }
}

export class AirportLayer implements WorldLayer {
  readonly object = new Group();
  readonly attribution = AIRPORT_ATTRIBUTION;
  private readonly preset: AirportPreset;
  private kit?: Kit;
  private readonly sites = new Map<string, Site>();
  private frame: LocalFrame;
  private nextRangeCheck = 0;
  private readonly camera = new Vector3();
  private readonly ecef = { x: 0, y: 0, z: 0 };

  constructor(frame: LocalFrame, device: DeviceClass) {
    this.object.name = 'Airports';
    // Demo pages and tests find the layer (and its stats) through the scene graph.
    this.object.userData.layer = this;
    this.frame = frame;
    this.preset = AIRPORT_PRESETS[device];
  }

  get loading(): boolean {
    for (const s of this.sites.values()) if (s.distance < this.preset.range && s.busy) return true;
    return false;
  }

  /** Numbers for the demo page and performance notes. */
  stats() {
    const out = {
      airports: 0,
      shown: 0,
      vertices: 0,
      triangles: 0,
      lights: 0,
      draws: 0,
      worstUpdateMs: this.worstMs,
    };
    for (const s of this.sites.values()) {
      out.airports++;
      if (s.group.visible) out.shown++;
      out.vertices += s.stats.vertices;
      out.triangles += s.stats.triangles;
      out.lights += s.stats.lights;
      out.draws += s.stats.draws;
    }
    return out;
  }

  /** The sites being shown (for tests and the demo). */
  get icaos(): string[] {
    return [...this.sites.keys()];
  }

  /** Worst and latest CPU time of update(), ms (for the demo page). */
  private worstMs = 0;
  private frames = 0;

  update(ctx: LayerContext) {
    const t0 = performance.now();
    this.updateInner(ctx);
    // The first frames create the kit and its textures: not a hitch in flight.
    if (++this.frames > 30) this.worstMs = Math.max(this.worstMs, performance.now() - t0);
  }

  private updateInner(ctx: LayerContext) {
    const u = lightUniforms;
    const cam = ctx.camera as LayerContext['camera'] & { fov?: number };
    u.screenHeight.value = ctx.screenHeight;
    u.tanHalfFov.value = Math.tan(((cam.fov ?? 55) * Math.PI) / 360);
    u.exposure.value = ctx.conditions.exposure;
    u.on.value = lightsOnFor(ctx.conditions);
    u.time.value = ctx.conditions.time;
    setWindsockConditions(ctx.conditions);
    // Sprite limits are in pixels of a 1080 pixel high screen.
    const scale = Math.max(0.6, ctx.screenHeight / 1080);
    u.minPx.value = this.preset.minPx * Math.max(1, scale * 0.8);
    u.maxPx.value = this.preset.maxPx * scale;

    const now = performance.now();
    if (now >= this.nextRangeCheck) {
      this.nextRangeCheck = now + 400;
      this.updateRange(ctx.view.lon, ctx.view.lat);
    }

    const sites = [...this.sites.values()].sort((a, b) => a.distance - b.distance);
    ctx.camera.getWorldPosition(this.camera);
    ctx.frame.toEcef(this.camera, this.ecef);
    for (const s of sites) s.setCamera(this.ecef);
    // One build step per frame, nearest airport first.
    for (const s of sites) if (s.stage !== 'done' && s.step(BUILD_MS)) break;

    const revisionChanged = sites.some((s) => s.revision !== ctx.groundRevision);
    if (revisionChanged)
      for (const s of sites) {
        if (s.revision === ctx.groundRevision) continue;
        s.revision = ctx.groundRevision;
        if (s.cursor) s.dirty = true;
        else if (s.checkProbes(ctx.groundHeight)) s.dirty = true;
      }

    let budget = this.preset.seatPerFrame;
    for (const s of sites) {
      if (budget <= 0) break;
      budget -= s.seat(ctx.groundHeight, budget);
    }
  }

  private updateRange(lon: number, lat: number) {
    const here = { lon, lat };
    for (const a of AIRPORTS) {
      const d = distanceM(here, a);
      let site = this.sites.get(a.icao);
      if (!site && d < this.preset.range) {
        this.kit ??= new Kit();
        site = new Site(a, this.preset, this.kit, this.frame);
        this.sites.set(a.icao, site);
        this.object.add(site.group);
      } else if (site && d > this.preset.dropRange) {
        site.dispose();
        this.sites.delete(a.icao);
        continue;
      }
      if (site) site.distance = d;
    }
  }

  setFrame(frame: LocalFrame) {
    this.frame = frame;
    for (const s of this.sites.values()) s.setFrame(frame);
  }

  dispose() {
    for (const s of this.sites.values()) s.dispose();
    this.sites.clear();
    this.kit?.dispose();
    this.kit = undefined;
  }
}
