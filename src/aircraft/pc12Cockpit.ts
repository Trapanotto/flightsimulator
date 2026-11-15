/**
 * The PC-12 flight deck at work: every control posed from the cockpit's values (cockpitCore.ts
 * does what all cockpits share; this adds the power lever with its reverse range, the
 * transponder digits and the pitch wheel), and the displays painted from the telemetry: the
 * PFD (both pilots' displays show the same picture), the engine and map display, the systems
 * and alerting display, and the panel's small windows.
 *
 * What feeds the displays (for checking the real aircraft against the demo's fakes):
 * - PFD: telemetry.instruments when present (attitude, airspeed, altitude, heading, slip),
 *   else the plain telemetry; avionics.autopilot (modes, flight director, selected values),
 *   avionics.nav1/nav2/gps by the cockpit's navSource, avionics.markers, avionics.dme;
 *   telemetry.agl as radar altitude; the cockpit's minimums, headingBug, obs1, apAltitude
 * - engine: engines[0].torque (share of 44.34 psi), turbineTemperature (ITT), n2 (Ng),
 *   propRpm (Np), fuelFlow; systems.oilPressure and oilTemperature; systems.fuelLeft/Right
 * - synopsis: systems (bus volts, amps), the cockpit's switches, telemetry.gear and flaps; the
 *   cabin altitude is derived here from the ECS switches and the selected cabin altitude
 *   until the systems report it
 */
import {
  type CanvasTexture,
  type Mesh,
  MeshStandardNodeMaterial,
  type Object3D,
} from 'three/webgpu';
import { float, texture, uv, vec4 } from 'three/tsl';
import {
  type AvionicsTelemetry,
  type Cockpit,
  type ControlInput,
  type ControlSpec,
  PC12_CONTROLS,
  type Telemetry,
} from '@sim';
import { avionicsFromCockpit } from './avionicsFormat';
import { type AtlasPainter, CanvasAtlas } from './canvasAtlas';
import { CockpitCore, type CockpitHost, type Rig } from './cockpitCore';
import { SETTLE, XPDR_DIGIT_DEG, slideShare, xpdrDigits } from './controlPoses';
import { MS_TO_FPM, MS_TO_KT, M_TO_FT, RAD_TO_DEG, lag } from './instruments';
import { findMesh, mergeMeshes, remapUv } from './meshUtil';
import {
  KG_TO_LB,
  TORQUE_MAX_PSI,
  crewAlerts,
  fuelFlowLbh,
  mapRangeNm,
  modeAnnunciation,
  stationOffset,
} from './pc12Avionics';
import {
  type EngineData,
  type MapData,
  PANEL_PAINTER,
  type PanelWindowData,
  type PanelWindowId,
  type PfdData,
  type SynopticData,
  casKey,
  engineKey,
  mapKey,
  paintCas,
  paintEngine,
  paintMap,
  paintPfd,
  paintSynoptic,
  pfdKey,
  synopticKey,
} from './pc12Displays';
import { CABIN, DUAL_KNOBS, OCCLUDERS, gearLights } from './pc12Parts';

const DEG = Math.PI / 180;
/** Metres of indicated altitude per hPa of altimeter setting near sea level. */
const M_PER_HPA = 8.43;
/** Maximum cabin differential pressure of the PC-12, psi. */
const MAX_DIFF_PSI = 5.75;

interface Frame {
  pfd: PfdData;
  engine: EngineData;
  map: MapData;
  synoptic: SynopticData;
  panel: PanelWindowData;
  time: number;
}

/** ISA pressure (psi) at a pressure altitude in feet. */
function isaPsi(ft: number): number {
  return 14.696 * Math.pow(1 - 6.8756e-6 * ft, 5.2559);
}

/** Pressure altitude (ft) of an ISA pressure in psi. */
function isaAltitude(psi: number): number {
  return (1 - Math.pow(psi / 14.696, 1 / 5.2559)) / 6.8756e-6;
}

export class PC12Cockpit extends CockpitCore {
  private readonly pfd: CanvasAtlas<'PFD', Frame>;
  private readonly mfd1: CanvasAtlas<'ENG' | 'MAP', Frame>;
  private readonly mfd2: CanvasAtlas<'SYN' | 'CAS', Frame>;
  private readonly panelAtlas: CanvasAtlas<PanelWindowId, PanelWindowData>;
  private readonly tex: Record<'pfd' | 'mfd1' | 'mfd2' | 'panel', CanvasTexture>;
  private readonly pressed = new Map<string, boolean>();
  private std = false;
  private pitchWheel = 0;
  private s = {
    first: true,
    ias: 0,
    trend: 0,
    vs: 0,
    cabinAlt: 0,
    cabinRate: 0,
    lastCabin: 0,
  };

  constructor(host: CockpitHost) {
    super(host, {
      controls: PC12_CONTROLS,
      cabin: CABIN,
      occluders: OCCLUDERS,
      knobDeg: { altimeterSetting: 10, cabinAltitude: 15, mapRange: 4 },
      dualKnobs: DUAL_KNOBS,
      detail:
        /^(Ctl_|Xpdr|Inst_|Labels|Displays|PanelWindows|Cabin_steel|Cabin_chrome|Cabin_plastic_black|Cabin_screen|Cabin_knob_red|Cabin_placard)/,
      slideShare: (id: string, v: number, spec: ControlSpec) =>
        id === 'condition' ? Math.min(Math.max(v, 0), 2) / 2 : slideShare(id, v, spec),
    });
    const cab = host.cockpit;
    for (let i = 0; i < 4; i++) {
      const n = cab.getObjectByName(`XpdrDigit_${i}`);
      if (n) this.addExtra(`xpdrDigit${i}`, 'xpdrCode', n);
    }
    const k = host.quality === 'low' ? 0.5 : 1;
    const one = <Id extends string>(
      width: number,
      height: number,
      regions: Record<Id, { x: number; y: number; w: number; h: number }>,
      content: (id: Id, f: Frame) => string,
      paint: (c: CanvasRenderingContext2D, id: Id, w: number, h: number, f: Frame) => void,
      throttled: Id[],
    ): AtlasPainter<Id, Frame> => ({
      width,
      height,
      regions,
      content,
      paint: (c, id, w, h, _key, f) => paint(c, id, w, h, f),
      throttled,
      background: '#000',
    });
    this.pfd = new CanvasAtlas(
      one<'PFD'>(
        1024,
        768,
        { PFD: { x: 0, y: 0, w: 1024, h: 768 } },
        (_i, f) => pfdKey(f.pfd),
        (c, _i, w, h, f) => paintPfd(c, w, h, f.pfd),
        ['PFD'],
      ),
      k,
      15,
    );
    this.mfd1 = new CanvasAtlas(
      one<'ENG' | 'MAP'>(
        1024,
        768,
        { ENG: { x: 0, y: 0, w: 300, h: 768 }, MAP: { x: 300, y: 0, w: 724, h: 768 } },
        (id, f) => (id === 'ENG' ? engineKey(f.engine) : mapKey(f.map)),
        (c, id, w, h, f) =>
          id === 'ENG' ? paintEngine(c, w, h, f.engine) : paintMap(c, w, h, f.map),
        ['MAP'],
      ),
      k,
      8,
    );
    this.mfd2 = new CanvasAtlas(
      one<'SYN' | 'CAS'>(
        1024,
        768,
        { SYN: { x: 0, y: 0, w: 700, h: 768 }, CAS: { x: 700, y: 0, w: 324, h: 768 } },
        (id, f) => (id === 'SYN' ? synopticKey(f.synoptic) : casKey(f.synoptic.cas, f.synoptic.on)),
        (c, id, w, h, f) =>
          id === 'SYN'
            ? paintSynoptic(c, w, h, f.synoptic)
            : paintCas(c, w, h, f.synoptic.cas, f.synoptic.on),
        [],
      ),
      k,
      5,
    );
    this.panelAtlas = new CanvasAtlas(PANEL_PAINTER, k, 6);
    this.tex = {
      pfd: host.canvasTexture(this.pfd.canvas, 8),
      mfd1: host.canvasTexture(this.mfd1.canvas, 8),
      mfd2: host.canvasTexture(this.mfd2.canvas, 8),
      panel: host.canvasTexture(this.panelAtlas.canvas, 4),
    };
    this.ownTextures.push(...Object.values(this.tex));
    for (const a of [this.pfd, this.mfd1, this.mfd2, this.panelAtlas])
      this.textureBytes += a.canvas.width * a.canvas.height * 4 * 1.33;
    this.setupDisplays(cab);
    this.setupLabels(cab, host.quality === 'low' ? 64 : 128);
    this.finishSetup();
  }

  // ---------------------------------------------------------------------------------------
  // Setup

  /** A display material: dark glass lit by its own backlight (the core's display gain). */
  private displayMaterial(tex: CanvasTexture, name: string) {
    const m = new MeshStandardNodeMaterial({ roughness: 0.22, metalness: 0 });
    m.name = name;
    const t = texture(tex, uv()).rgb;
    m.colorNode = vec4(t.mul(float(0.1)), 1);
    m.emissiveNode = t.mul(this.displayGain);
    this.host.track(m);
    return m;
  }

  private setupDisplays(cab: Object3D) {
    const mesh = (id: string) => {
      const node = cab.getObjectByName(`Disp_${id}`);
      return node ? findMesh(node) : undefined;
    };
    // Both pilots' PFDs show the same picture: one texture, one draw.
    const pfds = ['PFD1', 'PFD2'].map(mesh).filter((m): m is Mesh => !!m);
    mergeMeshes(pfds, this.displayMaterial(this.tex.pfd, 'PFD'), 'Displays_PFD', cab);
    const m1 = mesh('MFD1');
    if (m1) m1.material = this.displayMaterial(this.tex.mfd1, 'MFD1');
    const m2 = mesh('MFD2');
    if (m2) m2.material = this.displayMaterial(this.tex.mfd2, 'MFD2');
    const windows: Mesh[] = [];
    for (const id of Object.keys(PANEL_PAINTER.regions) as PanelWindowId[]) {
      const m = mesh(id);
      if (!m) continue;
      remapUv(m, this.panelAtlas.uvRect(id));
      windows.push(m);
    }
    mergeMeshes(windows, this.displayMaterial(this.tex.panel, 'PanelWindows'), 'PanelWindows', cab);
  }

  // ---------------------------------------------------------------------------------------
  // Poses

  /** A button's press (rising edge). */
  private press(id: string, v: number): boolean {
    const now = v >= 0.5;
    const was = this.pressed.get(id) ?? false;
    this.pressed.set(id, now);
    return now && !was;
  }

  protected override poseSpecial(
    id: string,
    r: Rig,
    v: number,
    dt: number,
    first: boolean,
  ): boolean {
    const settle = (rig: Rig, target: number, tau: number) =>
      this.settle(rig, target, tau, dt, first);
    switch (id) {
      case 'throttle': {
        // Over the gate the lever travels behind idle into beta and reverse.
        const rev = this.reverse;
        const back = Number(r.node.userData.reverseShare ?? 0.35);
        const share = rev ? -back * (0.3 + 0.7 * Math.min(Math.max(v, 0), 1)) : v;
        this.slide(r, settle(r, share, SETTLE.lever));
        return true;
      }
      case 'xpdrCode': {
        const d = xpdrDigits(v);
        for (let i = 0; i < 4; i++) {
          const e = this.extra.get(`xpdrDigit${i}`);
          if (e) this.turn(e, -settle(e, d[i]! * XPDR_DIGIT_DEG * DEG, SETTLE.knob));
        }
        return true;
      }
      case 'apVsUp':
      case 'apVsDown': {
        // The pitch wheel turns a detent for every press of either half.
        if (this.press(id, v)) this.pitchWheel += id === 'apVsUp' ? -18 : 18;
        if (id === 'apVsUp') this.turn(r, settle(r, this.pitchWheel * DEG, SETTLE.knob));
        return true;
      }
    }
    return false;
  }

  private reverse = false;

  // ---------------------------------------------------------------------------------------
  // Per frame

  update(
    dt: number,
    t: Telemetry,
    c: ControlInput,
    cockpit: Cockpit | undefined,
    altOffset: number,
    panelLight: number,
  ) {
    const first = this.s.first;
    this.s.first = false;
    const value = (id: string): number => {
      if (cockpit?.has(id)) return cockpit.get(id);
      const spec = this.specs.get(id);
      switch (id) {
        case 'throttle':
          return c.throttle[0] ?? 0;
        case 'flaps':
          return Math.round(c.flaps * 3);
        case 'gear':
          return c.gearDown ? 1 : 0;
        case 'trim':
          return c.pitchTrim;
        case 'aileronTrim':
          return c.rollTrim ?? 0;
        case 'rudderTrim':
          return c.yawTrim ?? 0;
        case 'parkingBrake':
          return c.parkingBrake ? 1 : 0;
        case 'reverse':
          return c.reverse ? 1 : 0;
        case 'condition':
          return Math.round((c.condition?.[0] ?? 1) * 2);
      }
      if (!spec) return 0;
      const running = t.engines.some((e) => e.running);
      return running ? (spec.running ?? spec.initial) : spec.initial;
    };
    this.reverse = value('reverse') >= 0.5;
    if (this.press('baroStd', value('baroStd'))) this.std = !this.std;
    this.poseControls(dt, value, first);
    if (this.inside) this.updateInstances();
    this.lighting(t.time, panelLight);
    const f = this.frame(dt, t, value, cockpit, altOffset, first);
    if (this.pfd.update(dt, f)) this.tex.pfd.needsUpdate = true;
    if (this.mfd1.update(dt, f)) this.tex.mfd1.needsUpdate = true;
    if (this.mfd2.update(dt, f)) this.tex.mfd2.needsUpdate = true;
    if (this.panelAtlas.update(dt, f.panel)) this.tex.panel.needsUpdate = true;
  }

  /** Everything the displays show this frame. */
  private frame(
    dt: number,
    t: Telemetry,
    value: (id: string) => number,
    cockpit: Cockpit | undefined,
    altOffset: number,
    first: boolean,
  ): Frame {
    const s = this.s;
    const ins = t.instruments;
    const sys = t.systems;
    const av: AvionicsTelemetry | undefined = t.avionics ?? avionicsFromCockpit(cockpit);
    const on = !!av?.powered;
    const bus = sys ? sys.busVolts : value('battery') >= 0.5 ? 25 : 0;
    const stbyOn = bus > 18 || value('eps') >= 0.5;
    // --- air data and attitude ---
    const ias = (ins ? ins.airspeed : t.ias) * MS_TO_KT;
    if (!first && dt > 0) s.trend = lag(s.trend, ((ias - s.ias) / dt) * 6, dt, 0.6);
    s.ias = ias;
    const setting = this.std ? 1013.25 : value('altimeterSetting');
    const alt =
      (ins ? ins.altitude : t.altitude + altOffset + (setting - 1013.25) * M_PER_HPA) * M_TO_FT;
    s.vs = lag(s.vs, (ins ? ins.verticalSpeed : t.verticalSpeed) * MS_TO_FPM, dt, first ? 0 : 0.6);
    const pitch = (ins ? ins.pitch : t.pitch) * RAD_TO_DEG;
    const bank = (ins ? ins.bank : t.bank) * RAD_TO_DEG;
    const heading = ins ? ins.heading : t.headingDeg;
    const tas = t.tas * MS_TO_KT;
    const sound = 661.47 * Math.sqrt(Math.max(1 - 6.8756e-6 * alt, 0.5));
    const mach = t.mach ?? tas / sound;
    // --- navigation source ---
    const srcIdx = Math.round(value('navSource'));
    const src = srcIdx === 1 ? 'gps' : srcIdx === 2 ? 'nav2' : 'nav1';
    let course = value(src === 'nav2' ? 'obs2' : 'obs1');
    let deviation: number | undefined;
    let toFrom: PfdData['toFrom'] = 'off';
    let glide: number | undefined;
    let ident = '';
    let distance: number | undefined;
    if (on && av) {
      if (src === 'gps') {
        const g = av.gps;
        if (g.active >= 0 && g.desiredTrack !== undefined) {
          course = g.desiredTrack;
          // Full scale is 2 NM en route.
          deviation = -(g.crossTrackNm ?? 0) / 2;
          toFrom = 'to';
          ident = g.plan[g.active]?.ident ?? '';
          distance = g.distanceNm;
        }
      } else {
        const n = src === 'nav1' ? av.nav1 : av.nav2;
        course = n.course;
        if (n.valid) {
          deviation = n.deviation;
          toFrom = n.toFrom;
          glide = n.glideSlope;
          ident = n.ident;
          if (av.dme.source === src) distance = av.dme.distanceNm;
        }
      }
    }
    const ap = av?.autopilot;
    const modes = modeAnnunciation(av, src);
    const markers = av
      ? `${av.markers.outer ? 'O' : ''}${av.markers.middle ? 'M' : ''}${av.markers.inner ? 'I' : ''}`
      : '';
    const radioAlt = t.agl === undefined ? undefined : t.agl * M_TO_FT;
    const pfd: PfdData = {
      on,
      pitch,
      bank,
      slip: ins ? ins.slip : Math.max(-1, Math.min(1, -t.beta * RAD_TO_DEG * 0.12)),
      ias,
      trend: s.trend,
      tas,
      gs: t.groundSpeed * MS_TO_KT,
      mach,
      alt,
      baro: setting,
      std: this.std,
      vs: s.vs,
      heading,
      hdgBug: value('headingBug'),
      selAlt: ap?.selectedAltitude ?? value('apAltitude'),
      selVs: ap?.selectedVerticalSpeed ?? 0,
      selSpeed: ap?.vertical === 'flc' ? ap.selectedSpeed : undefined,
      source: src === 'gps' ? 'FMS' : src === 'nav1' ? 'NAV1' : 'NAV2',
      course,
      deviation,
      toFrom,
      glide,
      ident,
      distance,
      fd: ap?.flightDirector
        ? { pitch: ap.flightDirector.pitch * RAD_TO_DEG, bank: ap.flightDirector.bank * RAD_TO_DEG }
        : undefined,
      modes,
      markers,
      radioAlt: radioAlt !== undefined && radioAlt < 2500 ? radioAlt : undefined,
      minimums: value('minimums'),
      flaps: t.flaps,
      gear: t.gear,
      time: t.time,
    };
    // --- engine ---
    const e = t.engines[0];
    const running = !!e?.running;
    const torque = (e?.torque ?? (running ? (e?.power ?? 0) : 0)) * TORQUE_MAX_PSI;
    const engine: EngineData = {
      on,
      torque,
      itt: e?.turbineTemperature ?? (running ? 520 + 280 * (e?.power ?? 0) : 20),
      ng: e?.n2 ?? (running ? 64 + 36 * (e?.power ?? 0) : 0),
      np: e?.propRpm ?? e?.rpm ?? 0,
      oilP: sys?.oilPressure ?? (running ? 110 : 0),
      oilT: sys?.oilTemperature ?? (running ? 75 : 15),
      ff: fuelFlowLbh(e?.fuelFlow ?? 0),
      fuelL: (sys?.fuelLeft ?? t.fuel / 2) * KG_TO_LB,
      fuelR: (sys?.fuelRight ?? t.fuel / 2) * KG_TO_LB,
      starting: !!e?.starting,
    };
    // --- map ---
    const g = av?.gps;
    const stations: MapData['stations'] = [];
    if (on && av)
      for (const n of [av.nav1, av.nav2] as const) {
        const key = n === av.nav1 ? 'nav1' : 'nav2';
        if (
          n.valid &&
          n.bearing !== undefined &&
          av.dme.source === key &&
          av.dme.distanceNm !== undefined
        )
          stations.push({ ident: n.ident, ...stationOffset(n.bearing, av.dme.distanceNm) });
      }
    const map: MapData = {
      on,
      range: mapRangeNm(value('mapRange')),
      heading,
      track: g?.track ?? t.trackDeg,
      gs: g?.groundSpeedKt ?? t.groundSpeed * MS_TO_KT,
      lon: g?.lon ?? 0,
      lat: g?.lat ?? 0,
      plan: g?.plan ?? [],
      active: g?.active ?? -1,
      distance: g?.distanceNm,
      stations,
      hdgBug: value('headingBug'),
    };
    // --- cabin pressure (derived until the systems report it) ---
    const press = value('ecs') >= 0.5 && value('pressurisation') < 0.5 && running;
    const ambient = isaPsi(alt);
    const minCabin = isaAltitude(ambient + MAX_DIFF_PSI);
    const target = press ? Math.min(alt, Math.max(value('cabinAltitude'), minCabin)) : alt;
    s.cabinAlt = first ? target : lag(s.cabinAlt, target, dt, 25);
    if (!first && dt > 0)
      s.cabinRate = lag(s.cabinRate, ((s.cabinAlt - s.lastCabin) / dt) * 60, dt, 2);
    s.lastCabin = s.cabinAlt;
    const gl = gearLights(t.gear);
    const cas = crewAlerts({
      systems: sys,
      switch: value,
      onGround: t.onGround,
      engineRunning: running,
      gear: t.gear,
      flaps: t.flaps,
      ias,
      agl: radioAlt,
      cabinAltitude: s.cabinAlt,
      torquePsi: torque,
      itt: engine.itt,
      oilPressure: engine.oilP,
    });
    const synoptic: SynopticData = {
      on,
      busVolts: bus,
      amps: sys?.batteryAmps ?? 0,
      bat1: value('battery') >= 0.5,
      bat2: value('battery2') >= 0.5,
      gen1: value('generator1') >= 0.5 && running,
      gen2: value('generator2') >= 0.5 && running,
      avionics: value('avionics') >= 0.5,
      eps: value('eps'),
      fuelL: engine.fuelL,
      fuelR: engine.fuelR,
      pumpL: value('fuelPumpLeft') >= 0.5,
      pumpR: value('fuelPumpRight') >= 0.5,
      firewall: value('fuelShutoff') >= 0.5,
      ff: engine.ff,
      gear: t.gear,
      gearDown: gl.down,
      gearTransit: gl.transit,
      flaps: t.flaps,
      cabinAlt: s.cabinAlt,
      cabinRate: s.cabinRate,
      diff: Math.max(0, isaPsi(s.cabinAlt) - ambient),
      selCabin: value('cabinAltitude'),
      dump: value('pressurisation') >= 0.5,
      cas,
    };
    // --- panel windows ---
    const lat = ap?.lateral;
    const panel: PanelWindowData = {
      radio: {
        avionics: av,
        systems: sys,
        altimeterSetting: setting,
        gpsCdi: src === 'gps',
        time: t.time,
      },
      stby: { on: stbyOn, pitch, bank, ias, alt, baro: setting },
      gear: { ...gl, on: bus > 12 },
      fgp: {
        on,
        lamps: {
          apHdg: !!ap && lat === 'hdg',
          apNav: !!ap && (lat === 'nav' || ap.lateralArmed === 'nav'),
          apApr: !!ap && (lat === 'apr' || ap.lateralArmed === 'apr'),
          apEngage: !!ap?.engaged,
          yawDamper: !!ap?.yawDamper,
          flightDirector: !!ap?.flightDirector,
          apAlt: !!ap && (ap.vertical === 'alt' || ap.verticalArmed === 'alt'),
          apVs: ap?.vertical === 'vs',
          apFlc: ap?.vertical === 'flc',
        },
      },
      trim: {
        pitch: value('trim'),
        roll: value('aileronTrim'),
        yaw: value('rudderTrim'),
        on: bus > 12,
      },
      avionics: av,
      systems: sys,
    };
    return { pfd, engine, map, synoptic, panel, time: t.time };
  }
}
