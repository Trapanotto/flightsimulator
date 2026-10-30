import { Group, Matrix4, Quaternion, type Texture, Vector3 } from 'three';
import { Aircraft } from '../aircraft/Aircraft';
import { aircraftById } from '../aircraft/types';
import type { TrafficMode } from '../core/settings';
import type { World } from '../world/World';
import { SimTraffic, type TrafficTarget, liveTrafficUrl, parseReadsb } from './trafficSources';

const DEG = Math.PI / 180;
const FT = 3.28084;
/** Drawn within this distance, at most MAX_MODELS of them (nearest first). */
const DRAW_RANGE = 30_000;
const MAX_MODELS = 18;
/** Live data: poll interval and how far around the player (nautical miles). */
const POLL_MS = 6000;
const RADIUS_NM = 60;

interface Track {
  target: TrafficTarget;
  /** Live data: when the target was reported (ms), for dead reckoning. */
  reportedAt: number;
  /** Smoothed render state. */
  pos: Vector3;
  heading: number;
  bank: number;
  valid: boolean;
  model?: Aircraft;
  loading?: boolean;
  label?: HTMLDivElement;
  seen: number;
}

/** Nearby traffic for the navigation display (TCAS-style). */
export interface TrafficBlip {
  /** Bearing relative to the own heading (deg), distance (m), altitude relative (m). */
  bearing: number;
  dist: number;
  relAlt: number;
  vs: number;
}

/**
 * Other aircraft around the player: real ones from ADS-B (through a relay, see
 * tools/traffic-relay) or simulated ones (trafficSources.SimTraffic), drawn with the fleet
 * models, labelled with callsign, type and flight level (key T).
 */
export class Traffic {
  readonly group = new Group();
  mode: TrafficMode = 'auto';
  labels = true;
  private readonly tracks = new Map<string, Track>();
  private readonly sim: SimTraffic;
  private live: 'unknown' | 'ok' | 'failed' = 'unknown';
  private failures = 0;
  private lastPoll = -Infinity;
  private polling = false;
  private readonly overlay: HTMLDivElement;
  private readonly tmp = new Vector3();
  private readonly m4 = new Matrix4();

  constructor(
    private readonly world: World,
    private readonly envMap?: Texture,
  ) {
    this.group.name = 'Traffic';
    this.sim = new SimTraffic((lon, lat) => world.groundAt(lon, lat));
    this.overlay = document.createElement('div');
    this.overlay.className = 'traffic-labels';
    document.body.appendChild(this.overlay);
  }

  /** Real data is in use (else simulated or off). */
  get source(): 'live' | 'sim' | 'off' {
    if (this.mode === 'off') return 'off';
    return this.mode === 'auto' && this.live !== 'failed' && liveTrafficUrl(0, 0) ? 'live' : 'sim';
  }

  update(dt: number, own: Vector3) {
    const w = this.world;
    const [lon, lat] = w.toGeo(own);
    const now = performance.now();
    const src = this.source;
    if (src === 'off') {
      this.clear();
      return;
    }
    if (src === 'live') {
      if (!this.polling && now - this.lastPoll > POLL_MS) this.poll(lon, lat, now);
    } else {
      const targets = this.sim.update(dt, lon, lat, w.currentWeather().windFrom);
      this.ingest(targets, now, true);
    }
    this.place(dt, own, now);
  }

  private poll(lon: number, lat: number, now: number) {
    const url = liveTrafficUrl(lon, lat, RADIUS_NM);
    if (!url) return;
    this.polling = true;
    this.lastPoll = now;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json) => {
        this.live = 'ok';
        this.failures = 0;
        this.ingest(
          parseReadsb(json as Parameters<typeof parseReadsb>[0]),
          performance.now(),
          false,
        );
      })
      .catch((err) => {
        console.warn('live traffic', err);
        // No relay reachable: carry on with simulated traffic.
        if (++this.failures >= 2 && this.live !== 'ok') {
          this.live = 'failed';
          this.clear();
        }
      })
      .finally(() => {
        this.polling = false;
      });
  }

  /** New positions; `exact` = simulated (no smoothing needed). */
  private ingest(targets: TrafficTarget[], now: number, exact: boolean) {
    const seen = new Set<string>();
    for (const t of targets) {
      seen.add(t.id);
      let tr = this.tracks.get(t.id);
      if (!tr) {
        tr = {
          target: t,
          reportedAt: now,
          pos: new Vector3(),
          heading: t.heading,
          bank: 0,
          valid: false,
          seen: now,
        };
        this.tracks.set(t.id, tr);
      }
      tr.target = t;
      tr.reportedAt = now;
      tr.seen = now;
    }
    // Gone from the data (landed and parked, out of range, simulated flight over).
    for (const [id, tr] of this.tracks) {
      if (!seen.has(id) && (exact || now - tr.seen > 30_000)) this.remove(id, tr);
    }
  }

  private place(dt: number, own: Vector3, now: number) {
    const w = this.world;
    const cam = w.camera;
    // Nearest first get a model.
    const list = [...this.tracks.values()];
    const dist = new Map<Track, number>();
    for (const tr of list) {
      const p = this.predict(tr, now);
      dist.set(tr, p ? p.distanceTo(own) : Infinity);
    }
    // Airborne traffic first: parked aircraft at a big airport would take all the slots.
    const rank = (tr: Track) => dist.get(tr)! * (tr.target.onGround ? 4 : 1);
    list.sort((a, b) => rank(a) - rank(b));
    let models = 0;
    let labels = 0;
    for (const tr of list) {
      const d = dist.get(tr)!;
      const want = d < DRAW_RANGE && models < MAX_MODELS;
      if (want) models++;
      if (want && !tr.model && !tr.loading) this.loadModel(tr);
      if (!want && tr.model) {
        this.group.remove(tr.model.root);
        tr.model = undefined;
      }
      const target = this.predict(tr, now);
      if (!target) continue;
      // Smooth towards the prediction (live reports jump a little every few seconds).
      if (!tr.valid) tr.pos.copy(target);
      else tr.pos.lerp(target, 1 - Math.exp(-dt * 2.5));
      tr.valid = true;
      // Heading eases towards the reported track; the turn rate gives the bank (coordinated
      // turn: tan(bank) = v * rate / g).
      const dh = ((((tr.target.heading - tr.heading) % 360) + 540) % 360) - 180;
      const step = dh * Math.min(1, dt * 1.5);
      tr.heading = (tr.heading + step + 360) % 360;
      const rate = dt > 0 ? (step * DEG) / dt : 0;
      const bank = tr.target.onGround ? 0 : Math.atan((tr.target.gs * rate) / 9.81);
      tr.bank += (Math.max(-0.55, Math.min(0.55, bank)) - tr.bank) * Math.min(1, dt * 2);
      if (tr.model) this.pose(tr);
      // At most 10 labels; aircraft on the ground only close by.
      const labelled = this.labels && labels < 10 && d < (tr.target.onGround ? 2000 : 15_000);
      if (labelled) labels++;
      this.labelFor(tr, cam, d, labelled);
    }
  }

  /** Where the target is now (render space): last report moved on by its speed. */
  private predict(tr: Track, now: number): Vector3 | null {
    const t = tr.target;
    const w = this.world;
    const age = Math.min(20, (now - tr.reportedAt) / 1000);
    const h = t.heading * DEG;
    const kx = 111_320 * Math.cos(t.lat * DEG);
    const lon = t.lon + (Math.sin(h) * t.gs * age) / kx;
    const lat = t.lat + (Math.cos(h) * t.gs * age) / 110_540;
    const ground = w.groundAt(lon, lat);
    const type = aircraftById(t.typeId);
    const gearH = type.physics.gearHeight;
    let alt = t.onGround || Number.isNaN(t.alt) ? (ground ?? 0) + gearH : t.alt + t.vs * age;
    // Never below the terrain (reported altitudes are barometric, terrain can be coarse).
    if (ground !== undefined) alt = Math.max(alt, ground + gearH);
    return w.fromGeo(lon, lat, alt);
  }

  private loadModel(tr: Track) {
    tr.loading = true;
    void Aircraft.loadShared(aircraftById(tr.target.typeId), this.envMap).then(
      (a) => {
        tr.loading = false;
        if (!this.tracks.has(tr.target.id)) return;
        a.root.traverse((o) => {
          (o as { castShadow?: boolean }).castShadow = false;
        });
        tr.model = a;
        this.group.add(a.root);
        this.pose(tr);
      },
      () => {
        tr.loading = false;
      },
    );
  }

  private pose(tr: Track) {
    const a = tr.model!;
    const t = tr.target;
    const w = this.world;
    const b = w.basisAt(tr.pos);
    const h = tr.heading * DEG;
    const fwd = b.north.clone().multiplyScalar(Math.cos(h)).addScaledVector(b.east, Math.sin(h));
    // Nose up a little for the climb (plus the angle of attack), level on the ground.
    const pitch = t.onGround ? 0 : Math.atan2(t.vs, Math.max(t.gs, 20)) + 2.5 * DEG;
    fwd.multiplyScalar(Math.cos(pitch)).addScaledVector(b.up, Math.sin(pitch)).normalize();
    const left = new Vector3().crossVectors(b.up, fwd).normalize();
    const up = new Vector3().crossVectors(fwd, left).normalize();
    this.m4.makeBasis(left, up, fwd);
    a.root.position.copy(tr.pos);
    a.root.quaternion.setFromRotationMatrix(this.m4);
    // Turning right (positive rate) lowers the right wing: roll about the nose.
    a.root.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), tr.bank));
    const agl = w.heightAboveGround(tr.pos) ?? 1000;
    const c = a.controls;
    c.gear = t.onGround || agl < 700 ? 1 : 0;
    c.flaps = t.onGround ? (t.gs > 20 ? 0.5 : 0) : agl < 500 && t.vs < 0 ? 1 : agl < 900 ? 0.5 : 0;
    c.rpm = t.onGround && t.gs < 5 ? 0.3 : 0.8;
    c.throttle = 0.6;
    a.update(1 / 60);
  }

  private labelFor(tr: Track, cam: World['camera'], dist: number, show: boolean) {
    if (!show) {
      if (tr.label) tr.label.hidden = true;
      return;
    }
    const p = this.tmp.copy(tr.pos).project(cam);
    if (p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) {
      if (tr.label) tr.label.hidden = true;
      return;
    }
    if (!tr.label) {
      tr.label = document.createElement('div');
      tr.label.className = 'traffic-label';
      this.overlay.appendChild(tr.label);
    }
    const t = tr.target;
    const fl =
      t.onGround || Number.isNaN(t.alt)
        ? 'GND'
        : `FL${String(Math.round((t.alt * FT) / 100)).padStart(3, '0')}`;
    const km = dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(1)} km`;
    const text = `${t.callsign} · ${t.icaoType || t.typeId.toUpperCase()}\n${fl} · ${km}`;
    if (tr.label.textContent !== text) tr.label.textContent = text;
    tr.label.hidden = false;
    const x = (p.x * 0.5 + 0.5) * this.world.canvas.clientWidth;
    const y = (-p.y * 0.5 + 0.5) * this.world.canvas.clientHeight;
    tr.label.style.transform = `translate(${x.toFixed(0)}px, ${(y - 28).toFixed(0)}px) translate(-50%, -100%)`;
  }

  /** Traffic for the navigation display: within `range` metres of the own aircraft. */
  blips(own: Vector3, heading: number, range = 40_000): TrafficBlip[] {
    const w = this.world;
    const b = w.basisAt(own);
    const out: TrafficBlip[] = [];
    for (const tr of this.tracks.values()) {
      if (!tr.valid) continue;
      const d = this.tmp.copy(tr.pos).sub(own);
      const dist = d.length();
      if (dist > range) continue;
      const brg = Math.atan2(d.dot(b.east), d.dot(b.north)) / DEG;
      out.push({
        bearing: ((brg - heading + 540) % 360) - 180,
        dist,
        relAlt: d.dot(b.up),
        vs: tr.target.vs,
      });
    }
    return out;
  }

  rebase(delta: Vector3) {
    for (const tr of this.tracks.values()) tr.pos.sub(delta);
  }

  private remove(id: string, tr: Track) {
    if (tr.model) this.group.remove(tr.model.root);
    tr.label?.remove();
    this.tracks.delete(id);
  }

  clear() {
    for (const [id, tr] of this.tracks) this.remove(id, tr);
  }

  dispose() {
    this.clear();
    this.overlay.remove();
    this.group.removeFromParent();
  }
}
