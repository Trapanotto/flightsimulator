/**
 * The F/A-18C front office at work: every control posed from the cockpit's values
 * (cockpitCore.ts does what all cockpits share; this adds the IFF code digits and the trim hat),
 * and the displays painted from the telemetry (fa18Displays.ts): the head-up display every frame
 * its picture changes, the DDIs, the MPCD and the panel's small windows when theirs does.
 *
 * What feeds the displays (for checking the real aircraft against the demo's fakes):
 * - head-up display: telemetry.avionics.fa18 (see Fa18AvionicsBlock) where present, else the
 *   plain telemetry: flight path from verticalSpeed and tas, drift from track minus heading,
 *   alpha, loadFactor (and its peak since the start), mach (or tas over the speed of sound),
 *   agl as radar altitude, avionics.gps for steering, avionics.nav1 for the ILS needles (with
 *   the cockpit's ilsOn); the cockpit's hudBrightness and hudAltitude
 * - engines: engines[i].n2 (or rpm), turbineTemperature (EGT), fuelFlow, nozzle, afterburner,
 *   oilPressure; fuel: telemetry.fuel and systems.fuelTanks (feed tanks), bingo from the block
 * - FCS page: fa18.surfaces and fa18.fcsFailed, else fa18Parts.surfacesFrom(telemetry)
 * - HSI and map: the cockpit's navSource, headingBug, obs1, mapRange, tacanChannel; avionics
 *   nav1, dme and gps
 */
import {
  AdditiveBlending,
  type CanvasTexture,
  Color,
  type Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  type Object3D,
} from 'three/webgpu';
import { float, texture, uniform, uv, vec3, vec4 } from 'three/tsl';
import {
  type AvionicsTelemetry,
  type Cockpit,
  type ControlInput,
  type ControlSpec,
  FA18_CONTROLS,
  type Telemetry,
} from '@sim';
import { avionicsFromCockpit } from './avionicsFormat';
import { CanvasAtlas } from './canvasAtlas';
import { CockpitCore, type CockpitHost, type Rig } from './cockpitCore';
import { SETTLE, XPDR_DIGIT_DEG, slideShare, xpdrDigits } from './controlPoses';
import {
  DDI_PAINTER,
  type DdiFrame,
  type DdiPage,
  type EngineRow,
  type Fa18AvionicsBlock,
  type Fa18Displays,
  type HudData,
  MPCD_PAINTER,
  type MpcdPage,
  PANEL_PAINTER,
  type PanelData,
  hudKey,
  paintHud,
} from './fa18Displays';
import {
  CABIN,
  HUD_GEOMETRY,
  type HudGeometry,
  OCCLUDERS,
  type PanelWindowId,
  afterburnerOf,
  gearLights,
  nozzleOpening,
  onSpeed,
  surfacesFrom,
} from './fa18Parts';
import { MS_TO_FPM, MS_TO_KT, M_TO_FT, RAD_TO_DEG, lag } from './instruments';
import { darkness } from './lights';
import { findMesh, mergeMeshes, remapUv } from './meshUtil';

const DEG = Math.PI / 180;
const KG_TO_LB = 2.20462;
const M_PER_HPA = 8.43;
const PAGES: readonly DdiPage[] = ['off', 'hsi', 'fcs', 'engine', 'adi', 'checklist', 'fuel'];
const MPCD_PAGES: readonly MpcdPage[] = ['off', 'hsi', 'fuel', 'engine'];
const MAP_RANGES = [10, 20, 40, 80, 160];
/** Default bingo, lb (a Swiss pilot's usual setting for the home base). */
const BINGO_LB = 2500;

/** The F/A-18 block of the avionics, when the simulation carries it. */
export function fa18Block(t: Telemetry): Fa18AvionicsBlock | undefined {
  const b = (t.avionics as { fa18?: unknown } | undefined)?.fa18;
  return b && typeof b === 'object' ? (b as Fa18AvionicsBlock) : undefined;
}

export class Fa18Cockpit extends CockpitCore {
  private readonly ddi: CanvasAtlas<'DDI_L' | 'DDI_R', DdiFrame>;
  private readonly mpcd: CanvasAtlas<'MPCD', DdiFrame>;
  private readonly panelAtlas: CanvasAtlas<PanelWindowId, PanelData>;
  private readonly hudCanvas: HTMLCanvasElement;
  private readonly hudCtx: CanvasRenderingContext2D;
  private readonly tex: Record<'ddi' | 'mpcd' | 'panel' | 'hud', CanvasTexture>;
  private readonly hudGain = uniform(1);
  private hudKey = '';
  /** The HUD's plane as built (distance and offsets from the eye). */
  readonly hud: HudGeometry;
  private readonly pressed = new Map<string, boolean>();
  private s = { first: true, peakG: 1, vv: 0, hook: 0 };
  /** The cautions the master caution was last reset on: it lights again for a new one. */
  private mcSeen = '';

  constructor(host: CockpitHost, eye: { x: number; y: number; z: number }) {
    super(host, {
      controls: FA18_CONTROLS,
      cabin: CABIN,
      occluders: OCCLUDERS,
      knobDeg: { altimeterSetting: 10, minimums: 1, tacanChannel: 10, trim: 0.3, xpdrCode: 0 },
      detail:
        /^(Ctl_|Xpdr|Inst_|Labels|Displays|PanelWindows|Disp_HUD|HudPicture|Cabin_steel|Cabin_chrome|Cabin_plastic_black|Cabin_screen|Cabin_knob_red|Cabin_placard|Cabin_eject|StickDummies)/,
      slideShare: (id: string, v: number, spec: ControlSpec) => slideShare(id, v, spec),
    });
    const cab = host.cockpit;
    for (let i = 0; i < 4; i++) {
      const n = cab.getObjectByName(`XpdrDigit_${i}`);
      if (n) this.addExtra(`xpdrDigit${i}`, 'xpdrCode', n);
    }
    const k = host.quality === 'low' ? 0.5 : 1;
    this.ddi = new CanvasAtlas(DDI_PAINTER, k, 10);
    this.mpcd = new CanvasAtlas(MPCD_PAINTER, k, 10);
    this.panelAtlas = new CanvasAtlas(PANEL_PAINTER, k, 8);
    const hudPx = host.quality === 'low' ? 384 : 512;
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = this.hudCanvas.height = hudPx;
    this.hudCtx = this.hudCanvas.getContext('2d')!;
    this.tex = {
      ddi: host.canvasTexture(this.ddi.canvas, 8),
      mpcd: host.canvasTexture(this.mpcd.canvas, 8),
      panel: host.canvasTexture(this.panelAtlas.canvas, 4),
      hud: host.canvasTexture(this.hudCanvas, 4),
    };
    this.ownTextures.push(...Object.values(this.tex));
    for (const c of [this.ddi.canvas, this.mpcd.canvas, this.panelAtlas.canvas, this.hudCanvas])
      this.textureBytes += c.width * c.height * 4 * 1.33;
    this.hud = this.hudGeometry(cab, eye);
    this.setupDisplays(cab);
    this.setupLabels(cab, host.quality === 'low' ? 96 : 256);
    this.finishSetup();
  }

  // ---------------------------------------------------------------------------------------
  // Setup

  /** The symbol plane's place relative to the eye, read off the model (falls back to the build's). */
  private hudGeometry(cab: Object3D, eye: { x: number; y: number; z: number }): HudGeometry {
    const node = cab.getObjectByName('Disp_HUD');
    if (!node) return HUD_GEOMETRY;
    const p = node.getWorldPosition(node.position.clone());
    const inv = this.host.root.matrixWorld.clone().invert();
    p.applyMatrix4(inv);
    const size = node.userData.size as number[] | undefined;
    return {
      distance: p.z - eye.z,
      // Model x is to the left: the pilot's right is -x.
      offsetX: -(p.x - eye.x),
      offsetY: p.y - eye.y,
      width: size?.[0] ?? HUD_GEOMETRY.width,
      height: size?.[1] ?? HUD_GEOMETRY.height,
    };
  }

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
    const ddis: Mesh[] = [];
    for (const id of ['DDI_L', 'DDI_R'] as const) {
      const m = mesh(id);
      if (!m) continue;
      remapUv(m, this.ddi.uvRect(id));
      ddis.push(m);
    }
    mergeMeshes(ddis, this.displayMaterial(this.tex.ddi, 'DDI'), 'Displays_DDI', cab);
    const mp = mesh('MPCD');
    if (mp) mp.material = this.displayMaterial(this.tex.mpcd, 'MPCD');
    const windows: Mesh[] = [];
    for (const id of Object.keys(PANEL_PAINTER.regions) as PanelWindowId[]) {
      const m = mesh(id);
      if (!m) continue;
      remapUv(m, this.panelAtlas.uvRect(id));
      windows.push(m);
    }
    mergeMeshes(windows, this.displayMaterial(this.tex.panel, 'PanelWindows'), 'PanelWindows', cab);
    // The head-up display: light added to what is behind the combiner, never darkening it.
    const hud = mesh('HUD');
    if (hud) {
      const m = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      m.name = 'HudSymbols';
      const green = new Color(0.32, 1.0, 0.42);
      m.colorNode = vec4(
        vec3(green.r, green.g, green.b).mul(texture(this.tex.hud, uv()).r).mul(this.hudGain),
        1,
      );
      this.host.track(m);
      hud.material = m;
      hud.renderOrder = 30;
      hud.frustumCulled = false;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Poses

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
    if (id === 'xpdrCode') {
      const d = xpdrDigits(v);
      for (let i = 0; i < 4; i++) {
        const e = this.extra.get(`xpdrDigit${i}`);
        if (e) this.turn(e, -this.settle(e, d[i]! * XPDR_DIGIT_DEG * DEG, SETTLE.knob, dt, first));
      }
      return true;
    }
    if (id === 'trim') {
      // The trim hat rocks forward or aft while the trim runs, and centres when it stops.
      const was = (r as Rig & { last?: number }).last ?? v;
      (r as Rig & { last?: number }).last = v;
      const target = v > was + 1e-6 ? -14 * DEG : v < was - 1e-6 ? 14 * DEG : 0;
      this.turn(r, this.settle(r, target, 0.08, dt, first));
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------
  // Per frame

  update(
    dt: number,
    t: Telemetry,
    c: ControlInput,
    cockpit: Cockpit | undefined,
    altOffset: number,
    consoleLight: number,
  ) {
    const first = this.s.first;
    this.s.first = false;
    const value = (id: string): number => {
      if (cockpit?.has(id)) return cockpit.get(id);
      switch (id) {
        case 'throttle1':
          return c.throttle[0] ?? 0;
        case 'throttle2':
          return c.throttle[1] ?? c.throttle[0] ?? 0;
        case 'flaps':
          return c.flaps < 0.25 ? 0 : c.flaps < 0.75 ? 1 : 2;
        case 'gear':
          return c.gearDown ? 1 : 0;
        case 'speedbrake':
          return (c.speedbrake ?? 0) >= 0.5 ? 1 : 0;
        case 'trim':
          return c.pitchTrim;
        case 'parkingBrake':
          return c.parkingBrake ? 1 : 0;
      }
      const spec = this.specs.get(id);
      if (!spec) return 0;
      const running = t.engines.some((e) => e.running);
      return running ? (spec.running ?? spec.initial) : spec.initial;
    };
    this.poseControls(dt, value, first);
    if (this.inside) this.updateInstances();
    this.lighting(t.time, consoleLight);
    const f = this.frame(dt, t, value, cockpit, altOffset, first);
    if (this.ddi.update(dt, f.ddi)) this.tex.ddi.needsUpdate = true;
    if (this.mpcd.update(dt, f.ddi)) this.tex.mpcd.needsUpdate = true;
    if (this.panelAtlas.update(dt, f.panel)) this.tex.panel.needsUpdate = true;
    // The HUD moves smoothly: it is redrawn whenever its picture changes, in the cockpit view.
    const brightness = f.hud.on ? value('hudBrightness') : 0;
    this.hudGain.value = brightness * (0.4 + 1.5 * (1 - darkness(this.exposure)));
    if (this.inside) {
      const key = hudKey(f.hud);
      if (key !== this.hudKey) {
        this.hudKey = key;
        paintHud(this.hudCtx, this.hudCanvas.width, this.hudCanvas.height, f.hud, this.hud);
        this.tex.hud.needsUpdate = true;
      }
    }
  }

  /** The HUD's data alone (tests and the demo use it). */
  lastHud: HudData | undefined;

  private frame(
    dt: number,
    t: Telemetry,
    value: (id: string) => number,
    cockpit: Cockpit | undefined,
    altOffset: number,
    first: boolean,
  ): { hud: HudData; ddi: DdiFrame; panel: PanelData } {
    const s = this.s;
    const fb = fa18Block(t);
    const sys = t.systems;
    const ins = t.instruments;
    const av: AvionicsTelemetry | undefined = t.avionics ?? avionicsFromCockpit(cockpit);
    const bus = sys ? sys.busVolts : value('battery') >= 0.5 ? 25 : 0;
    const on =
      bus > 18 && (!t.systems || t.engines.some((e) => e.running) || value('battery') >= 0.5);
    const avOn = !!av?.powered || (on && !t.avionics);
    // --- air data ---
    const ias = (ins ? ins.airspeed : t.ias) * MS_TO_KT;
    const setting = value('altimeterSetting');
    const baroFt =
      (ins ? ins.altitude : t.altitude + altOffset + (setting - 1013.25) * M_PER_HPA) * M_TO_FT;
    const pitch = fb?.pitch ?? (ins ? ins.pitch : t.pitch) * RAD_TO_DEG;
    const bank = fb?.bank ?? (ins ? ins.bank : t.bank) * RAD_TO_DEG;
    const heading = fb?.heading ?? (ins ? ins.heading : t.headingDeg);
    const tas = t.tas * MS_TO_KT;
    const mach =
      fb?.mach ?? t.mach ?? tas / (661.47 * Math.sqrt(Math.max(1 - 6.8756e-6 * baroFt, 0.5)));
    const vsMs = fb?.verticalVelocity ?? t.verticalSpeed;
    s.vv = lag(s.vv, vsMs * MS_TO_FPM, dt, first ? 0 : 0.3);
    const g = fb?.g ?? t.loadFactor;
    s.peakG = first ? Math.max(g, 1) : Math.max(s.peakG, g);
    const peakG = fb?.peakG ?? s.peakG;
    const alpha = (fb?.alpha ?? t.alpha) * RAD_TO_DEG;
    const speed = Math.max(t.tas, 1);
    const fpa =
      fb?.flightPath !== undefined
        ? fb.flightPath * RAD_TO_DEG
        : Math.asin(Math.max(-1, Math.min(1, t.verticalSpeed / speed))) * RAD_TO_DEG;
    const drift =
      fb?.drift !== undefined
        ? fb.drift * RAD_TO_DEG
        : t.groundSpeed > 5
          ? ((((t.trackDeg - t.headingDeg) % 360) + 540) % 360) - 180
          : 0;
    const radarM = fb?.radarAltitude ?? t.agl;
    const radarFt = radarM === undefined || radarM * M_TO_FT > 5000 ? undefined : radarM * M_TO_FT;
    const useRadar =
      radarFt !== undefined && (fb?.radarAltitudeShown ?? value('hudAltitude') >= 0.5);
    const landing = fb?.gear ? fb.gear !== 'up' : t.gear > 0.5;
    // --- navigation ---
    const srcIdx = Math.round(value('navSource'));
    const source = srcIdx === 0 ? 'NAV' : srcIdx === 2 ? 'TCN' : 'GPS';
    const gps = av?.gps;
    const wp = gps && gps.active >= 0 ? gps.plan[gps.active] : undefined;
    const fs = fb?.steering;
    const steering =
      (fs && fs.valid
        ? {
            ident:
              fs.source === 'wypt' ? (wp?.ident ?? 'WYPT') : fs.source === 'tacan' ? 'TCN' : 'ILS',
            bearing: fs.bearing,
            rangeNm: fs.rangeNm,
            timeToGo: fs.minutes !== undefined ? fs.minutes * 60 : undefined,
          }
        : undefined) ??
      (avOn && wp && gps?.bearing !== undefined && gps.distanceNm !== undefined
        ? {
            ident: wp.ident,
            bearing: gps.bearing,
            rangeNm: gps.distanceNm,
            timeToGo:
              gps.groundSpeedKt > 30 ? (gps.distanceNm / gps.groundSpeedKt) * 3600 : undefined,
          }
        : undefined);
    const nav1 = av?.nav1;
    const ils =
      fb?.ils ??
      ((fb?.ilsOn ?? value('ilsOn') >= 0.5) && avOn && nav1?.valid && nav1.localizer
        ? { localizer: nav1.deviation, glideSlope: nav1.glideSlope }
        : undefined);
    // --- engines and fuel ---
    const engines = [0, 1].map((i): EngineRow => {
      const e = t.engines[i] ?? t.engines[0];
      const running = !!e?.running;
      const ab = afterburnerOf(e);
      return {
        running,
        rpm: e?.n2 ?? e?.n1 ?? (running ? 62 + 38 * Math.min(e?.power ?? 0, 1) : 0),
        egt: e?.turbineTemperature ?? (running ? 380 + 420 * Math.min(e?.power ?? 0, 1) : 15),
        ff: (e?.fuelFlow ?? 0) * 3600 * KG_TO_LB,
        noz: Math.round(nozzleOpening(e) * 100),
        oil: e?.oilPressure ?? (running ? 45 + 30 * Math.min(e?.power ?? 0, 1) : 0),
        ab,
      };
    }) as [EngineRow, EngineRow];
    const totalLb = t.fuel * KG_TO_LB;
    const tanks = sys?.fuelTanks;
    const bingoKg = fb?.bingoSetting ?? (cockpit?.has('bingo') ? cockpit.get('bingo') : undefined);
    const bingo = bingoKg !== undefined ? bingoKg * KG_TO_LB : BINGO_LB;
    const fuel = {
      total: totalLb,
      left: tanks && tanks.length >= 2 ? tanks[0]! * KG_TO_LB : Math.min(totalLb / 2, 1300),
      right: tanks && tanks.length >= 2 ? tanks[1]! * KG_TO_LB : Math.min(totalLb / 2, 1300),
      bingo,
      flow: engines[0].ff + engines[1].ff,
    };
    // --- surfaces and cautions ---
    const surf = { ...surfacesFrom(t), ...fb?.surfaces };
    if (fb?.leadingEdgeFlap !== undefined) surf.lef = fb.leadingEdgeFlap * RAD_TO_DEG;
    if (fb?.trailingEdgeFlap !== undefined) surf.tef = fb.trailingEdgeFlap * RAD_TO_DEG;
    const flapsSel = Math.round(value('flaps'));
    const flaps = fb?.flapMode ?? (flapsSel === 0 ? 'auto' : flapsSel === 1 ? 'half' : 'full');
    const gl = gearLights(t.gear);
    const cautions: string[] = [...(fb?.cautions ?? [])];
    if (!fb?.cautions) {
      if (on && value('seatArmed') < 0.5 && !t.onGround) cautions.push('CK SEAT');
      if ((t.speedbrake ?? 0) > 0.05 && landing) cautions.push('SPD BRK');
      if (totalLb < 800) cautions.push('FUEL LO');
      if (value('generatorLeft') < 0.5 && t.engines[0]?.running) cautions.push('L GEN');
      if (value('generatorRight') < 0.5 && t.engines[1]?.running) cautions.push('R GEN');
      if (value('launchBar') >= 0.5 && !t.onGround) cautions.push('L BAR');
    }
    const hud: HudData = {
      on: on && value('hudBrightness') > 0.02,
      pitch,
      bank,
      heading,
      ias,
      mach,
      g,
      peakG,
      alpha,
      alt: useRadar ? radarFt! : baroFt,
      radar: useRadar,
      vv: s.vv,
      fpa,
      drift,
      landing,
      steering: source === 'GPS' || !ils ? steering : undefined,
      ils: landing ? ils : undefined,
      hdgBug: value('headingBug'),
      cautions: [...cautions, ...(fb?.advisories ?? [])],
      bingo: fb?.bingo ?? totalLb < bingo,
    };
    this.lastHud = hud;
    let course = value('obs1');
    let deviation: number | undefined;
    let ident = '';
    let bearing: number | undefined;
    let distance: number | undefined;
    if (avOn && av) {
      if (source === 'GPS' && gps && gps.active >= 0) {
        course = gps.desiredTrack ?? course;
        deviation = gps.crossTrackNm !== undefined ? -gps.crossTrackNm / 2 : undefined;
        ident = wp?.ident ?? '';
        bearing = gps.bearing;
        distance = gps.distanceNm;
      } else if (nav1?.valid) {
        course = nav1.localizer ? nav1.course : course;
        deviation = nav1.deviation;
        ident = nav1.ident;
        bearing = nav1.bearing;
        distance = av.dme.distanceNm;
      }
    }
    const d: Fa18Displays = {
      on: avOn,
      pitch,
      bank,
      heading,
      track: gps?.track ?? t.trackDeg,
      ias,
      alt: baroFt,
      vv: s.vv,
      alpha,
      mach,
      g,
      engines,
      fuel,
      surfaces: surf,
      fcsFailed: fb?.fcsFailed ?? [],
      gear: t.gear,
      flaps,
      speedbrake: t.speedbrake ?? 0,
      nav: {
        source,
        course,
        hdgBug: value('headingBug'),
        deviation,
        ident,
        bearing,
        distance,
        plan: gps?.plan ?? [],
        active: gps?.active ?? -1,
        lon: gps?.lon ?? 0,
        lat: gps?.lat ?? 0,
        range: MAP_RANGES[Math.round(value('mapRange'))] ?? 40,
        tacan: Math.round(value('tacanChannel')),
      },
      cautions,
      advisories: fb?.advisories ?? [],
      time: t.time,
    };
    const ddi: DdiFrame = {
      d,
      left: PAGES[Math.round(value('ddiLeftPage'))] ?? 'off',
      right: PAGES[Math.round(value('ddiRightPage'))] ?? 'off',
      mpcd: MPCD_PAGES[Math.round(value('mpcdPage'))] ?? 'off',
    };
    const ap = av?.autopilot;
    const options = [
      { text: 'ATTH', on: !!ap?.engaged && ap.lateral === 'roll' && ap.vertical === 'pitch' },
      { text: 'HSEL', on: !!ap?.engaged && ap.lateral === 'hdg' },
      { text: 'BALT', on: !!ap?.engaged && ap.vertical === 'alt' },
      { text: 'RALT', on: !!ap?.engaged && ap.vertical === 'vs' },
      { text: 'CPL', on: !!ap?.engaged && (ap.lateral === 'nav' || ap.lateral === 'apr') },
    ];
    const xmode = Math.round(value('xpdrMode'));
    const cautionKey = cautions.join(',');
    if (this.press('masterCaution', value('masterCaution'))) this.mcSeen = cautionKey;
    if (!cautionKey) this.mcSeen = '';
    const cautionLit = !!cautionKey && cautionKey !== this.mcSeen;
    s.hook = first ? value('hook') : lag(s.hook, value('hook'), dt, 0.8);
    const aoaState = landing && !t.onGround ? (fb?.onSpeed ?? onSpeed(alpha)) : 'off';
    const panel: PanelData = {
      on: avOn,
      scratchpad: ap?.engaged
        ? `A/P ${options.find((o) => o.on)?.text ?? ''}`
        : `TCN ${Math.round(value('tacanChannel'))}X`,
      options,
      com1: av?.com1.active ?? value('com1Active'),
      com2: av?.com2.active ?? value('com2Active'),
      nav1: av?.nav1.frequency ?? value('nav1Active'),
      nav1Standby: av?.nav1.standby ?? value('nav1Standby'),
      xpdr: { code: value('xpdrCode'), mode: ['off', 'stby', 'norm', 'alt'][xmode] ?? 'off' },
      ifei: { engines, fuel, time: t.time },
      stby: {
        ias,
        alt: baroFt,
        baro: setting,
        pitch,
        bank,
        vs: s.vv,
      },
      radalt: { ft: radarFt, minimums: value('minimums') },
      cautions,
      aoa: aoaState,
      masterCaution: cautionLit,
      gear: gl,
      hook: { down: value('hook') >= 0.5, transit: Math.abs(s.hook - value('hook')) > 0.05 },
      time: t.time,
    };
    return { hud, ddi, panel };
  }
}
