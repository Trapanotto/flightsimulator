/**
 * The A320 flight deck at work: every control posed from the cockpit's values (cockpitCore.ts
 * does what all cockpits share; this adds the thrust levers on their arc with the reverse
 * range, the reverse latches, both pitch trim wheels and the transponder digits), and the
 * displays painted from the telemetry: both PFDs (one picture), both NDs, the E/WD, the SD,
 * the MCDUs (the flight plan), the standby instrument and the panel's windows and lit legends.
 *
 * What feeds the displays (for checking the real aircraft against the demo's fakes):
 * - PFD: telemetry.instruments when present, else the plain telemetry; the FMA from
 *   avionics.autopilot.airbus.fma (else built from avionics.autopilot); speeds from .speeds
 *   (else rules of thumb for the configuration); avionics.autopilot.flightDirector with the FD
 *   button; avionics.nav1 (the ILS) with the LS button; telemetry.agl as radio altitude; the
 *   FCU's values for the targets (avionics.autopilot.airbus.speeds.target, else
 *   autopilot.selectedSpeed)
 * - ND: avionics.gps (plan, position), nav1/nav2 and the DME, the EFIS mode and range
 * - E/WD: engines[i].n1, n2, turbineTemperature (EGT), fuelFlow, reversing, starting; the
 *   thrust levers; the Airbus block's controls (slats, flaps, config) and ecam (else
 *   derived from the switches); telemetry.fuel
 * - SD: systems (fuel tanks, hydraulics, cabin pressure) when they report it, else derived
 *   here from the switches and the engines; the page from `ecamPage`
 */
import {
  type CanvasTexture,
  type Mesh,
  MeshStandardNodeMaterial,
  type Object3D,
} from 'three/webgpu';
import { float, texture, uv, vec4 } from 'three/tsl';
import {
  A320_CONTROLS,
  type AvionicsTelemetry,
  type Cockpit,
  type ControlInput,
  type ControlSpec,
  type Telemetry,
} from '@sim';
import { mapOffsetNm } from './avionicsFormat';
import {
  type A320Avionics,
  ECAM_PAGES,
  FmaBoxes,
  ND_MODES,
  baroText,
  defaultSpeeds,
  fcuAltitudeText,
  fcuHeadingText,
  fcuSpeedText,
  fcuVsText,
  fmaLines,
  fobKg,
  freqText,
  fuelFlowKgh,
  leverAngle,
  leverN1,
  ndRangeNm,
  readA320,
  rudderTrimText,
  thrustLimit,
} from './a320Format';
import { type EwdData, type SdData, ewdKey, paintEwd, paintSd, sdKey } from './a320Ecam';
import {
  type IsisData,
  type KeyFace,
  type McduData,
  PANEL_PAINTER,
  type PanelData,
  type PanelId,
  isisKey,
  mcduKey,
  paintIsis,
  paintMcdu,
} from './a320Panel';
import {
  CABIN,
  DUAL_KNOBS,
  KEY_LEGENDS,
  type KeyLegend,
  OCCLUDERS,
  configLabel,
  gearLights,
  highLift,
} from './a320Parts';
import { AB } from './a320Paint';
import { type NdData, type PfdData, ndKey, paintNd, paintPfd, pfdKey } from './a320Pfd';
import { type AtlasPainter, CanvasAtlas } from './canvasAtlas';
import { CockpitCore, type CockpitHost, type Rig } from './cockpitCore';
import { SETTLE, XPDR_DIGIT_DEG, slideShare, xpdrDigits } from './controlPoses';
import { MS_TO_FPM, MS_TO_KT, M_TO_FT, RAD_TO_DEG, lag } from './instruments';
import { findMesh, mergeMeshes, remapUv } from './meshUtil';

const DEG = Math.PI / 180;
const M_PER_HPA = 8.43;

interface Frame {
  pfd: PfdData;
  nd: NdData;
  ewd: EwdData;
  sd: SdData;
  mcdu: McduData;
  isis: IsisData;
  panel: PanelData;
}

/** A canvas atlas with one window filling it. */
function single<D>(
  width: number,
  height: number,
  key: (d: D) => string,
  paint: (c: CanvasRenderingContext2D, w: number, h: number, d: D) => void,
  throttled: boolean,
): AtlasPainter<'all', D> {
  return {
    width,
    height,
    regions: { all: { x: 0, y: 0, w: width, h: height } },
    content: (_id, d) => key(d),
    paint: (c, _id, w, h, _k, d) => paint(c, w, h, d),
    throttled: throttled ? ['all'] : [],
    background: '#000',
  };
}

export class A320Cockpit extends CockpitCore {
  private readonly atlases: { atlas: CanvasAtlas<string, Frame>; tex: CanvasTexture }[] = [];
  private readonly panelAtlas: CanvasAtlas<PanelId, PanelData>;
  private readonly panelTex: CanvasTexture;
  private readonly pressed = new Map<string, boolean>();
  private readonly fmaBoxes = new FmaBoxes();
  private std = false;
  private mach = false;
  private reverse = false;
  private s = {
    first: true,
    ias: 0,
    trend: 0,
    vs: 0,
    apuN: 0,
    apuEgt: 15,
    apuStarting: false,
    brakes: [15, 15, 15, 15] as [number, number, number, number],
    cabinAlt: 0,
    lastCabin: 0,
    cabinRate: 0,
    fuelUsed: [0, 0],
  };

  constructor(host: CockpitHost) {
    super(host, {
      controls: A320_CONTROLS,
      cabin: CABIN,
      occluders: OCCLUDERS,
      knobDeg: {
        fcuSpeed: 6,
        fcuHeading: 6,
        fcuAltitude: 10,
        fcuVerticalSpeed: 10,
        altimeterSetting: 8,
        trim: 1.5,
        rudderTrim: 8,
        lightPanel: 25,
        obs1: 4,
        obs2: 4,
      },
      dualKnobs: DUAL_KNOBS,
      detail:
        /^(Ctl_|Xpdr|Inst_|Labels|Displays|PanelWindows|RevLatch|TrimWheel|Cabin_steel|Cabin_chrome|Cabin_plastic_black|Cabin_korry|Cabin_screen|Cabin_knob_red|Cabin_placard|Cabin_gauge|Cabin_carpet|Cabin_panel_light)/,
      slideShare: (id: string, v: number, spec: ControlSpec) => slideShare(id, v, spec),
    });
    const cab = host.cockpit;
    for (let i = 0; i < 4; i++) {
      const n = cab.getObjectByName(`XpdrDigit_${i}`);
      if (n) this.addExtra(`xpdrDigit${i}`, 'xpdrCode', n);
    }
    const latch = cab.getObjectByName('RevLatch_2');
    if (latch) this.addExtra('revLatch2', 'reverse', latch);
    const wheel = cab.getObjectByName('TrimWheel_R');
    if (wheel) this.addExtra('trimWheel2', 'trim', wheel);
    const k = host.quality === 'low' ? 0.5 : 1;
    const add = <D>(
      painter: AtlasPainter<'all', D>,
      hz: number,
      pick: (f: Frame) => D,
      anis = 8,
    ) => {
      const atlas = new CanvasAtlas<'all', D>(painter, k, hz);
      const tex = host.canvasTexture(atlas.canvas, anis);
      this.ownTextures.push(tex);
      this.textureBytes += atlas.canvas.width * atlas.canvas.height * 4 * 1.33;
      const wrapped = {
        canvas: atlas.canvas,
        update: (dt: number, f: Frame) => atlas.update(dt, pick(f)),
      } as unknown as CanvasAtlas<string, Frame>;
      this.atlases.push({ atlas: wrapped, tex });
      return tex;
    };
    const pfdTex = add(single(768, 768, pfdKey, paintPfd, true), 15, (f) => f.pfd);
    const ndTex = add(single(768, 768, ndKey, paintNd, true), 8, (f) => f.nd);
    const ewdTex = add(single(768, 768, ewdKey, paintEwd, true), 10, (f) => f.ewd);
    const sdTex = add(single(768, 768, sdKey, paintSd, false), 5, (f) => f.sd);
    const mcduTex = add(single(512, 400, mcduKey, paintMcdu, false), 2, (f) => f.mcdu, 4);
    const isisTex = add(single(256, 256, isisKey, paintIsis, true), 10, (f) => f.isis, 4);
    this.panelAtlas = new CanvasAtlas(PANEL_PAINTER, k, 8);
    this.panelTex = host.canvasTexture(this.panelAtlas.canvas, 4);
    this.ownTextures.push(this.panelTex);
    this.textureBytes += this.panelAtlas.canvas.width * this.panelAtlas.canvas.height * 4 * 1.33;
    this.setupDisplays(cab, { pfdTex, ndTex, ewdTex, sdTex, mcduTex, isisTex });
    this.setupLabels(cab, host.quality === 'low' ? 96 : 256);
    this.finishSetup();
  }

  // ---------------------------------------------------------------------------------------
  // Setup

  /** A display: dark glass lit by its own backlight (the core's display gain). */
  private displayMaterial(tex: CanvasTexture, name: string) {
    const m = new MeshStandardNodeMaterial({ roughness: 0.22, metalness: 0 });
    m.name = name;
    const t = texture(tex, uv()).rgb;
    m.colorNode = vec4(t.mul(float(0.08)), 1);
    m.emissiveNode = t.mul(this.displayGain);
    this.host.track(m);
    return m;
  }

  private setupDisplays(cab: Object3D, t: Record<string, CanvasTexture>) {
    const mesh = (id: string) => {
      const node = cab.getObjectByName(`Disp_${id}`);
      return node ? findMesh(node) : undefined;
    };
    const both = (ids: string[], tex: CanvasTexture, name: string) => {
      const ms = ids.map(mesh).filter((m): m is Mesh => !!m);
      mergeMeshes(ms, this.displayMaterial(tex, name), `Displays_${name}`, cab);
    };
    // The two pilots' PFDs (and NDs, MCDUs) show the same picture: one texture, one draw.
    both(['PFD1', 'PFD2'], t.pfdTex!, 'PFD');
    both(['ND1', 'ND2'], t.ndTex!, 'ND');
    both(['EWD'], t.ewdTex!, 'EWD');
    both(['SD'], t.sdTex!, 'SD');
    both(['MCDU1', 'MCDU2'], t.mcduTex!, 'MCDU');
    both(['ISIS'], t.isisTex!, 'ISIS');
    const windows: Mesh[] = [];
    for (const id of Object.keys(PANEL_PAINTER.regions) as PanelId[]) {
      const m = mesh(id);
      if (!m) continue;
      remapUv(m, this.panelAtlas.uvRect(id));
      windows.push(m);
    }
    mergeMeshes(windows, this.displayMaterial(this.panelTex, 'PanelWindows'), 'PanelWindows', cab);
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
    const settle = (rig: Rig, target: number, tau: number) =>
      this.settle(rig, target, tau, dt, first);
    switch (id) {
      case 'throttle1':
      case 'throttle2': {
        // The levers swing on an arc: idle aft, TOGA forward; with the reverse latches up
        // their travel runs aft of idle into reverse.
        const u = r.node.userData as { idleDeg?: number; togaDeg?: number; revDeg?: number };
        const idle = u.idleDeg ?? -18;
        const toga = u.togaDeg ?? 30;
        const rev = u.revDeg ?? -36;
        const lv = Math.min(Math.max(v, 0), 1);
        const deg = this.reverse
          ? idle + (rev - idle) * (0.25 + 0.75 * lv)
          : idle + (toga - idle) * lv;
        this.turn(r, settle(r, deg * DEG, SETTLE.lever));
        return true;
      }
      case 'reverse': {
        const deg = v >= 0.5 ? -28 : 0;
        this.turn(r, settle(r, deg * DEG, SETTLE.toggle));
        const e = this.extra.get('revLatch2');
        if (e) this.turn(e, settle(e, deg * DEG, SETTLE.toggle));
        return true;
      }
      case 'trim': {
        const knob = this.turns.get('trim');
        if (!knob) return false;
        const a = -settle(r, knob.update(r.spec, v) * DEG, SETTLE.knob);
        this.turn(r, a);
        const e = this.extra.get('trimWheel2');
        if (e) this.turn(e, a);
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
    panelLight: number,
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
          return Math.round(c.flaps * 4);
        case 'gear':
          return c.gearDown ? 1 : 0;
        case 'speedbrake':
          return c.speedbrake ?? 0;
        case 'reverse':
          return c.reverse ? 1 : 0;
        case 'trim':
          return c.pitchTrim;
        case 'rudderTrim':
          return c.yawTrim ?? 0;
        case 'parkingBrake':
          return c.parkingBrake ? 1 : 0;
        case 'engineMaster1':
          return (c.condition?.[0] ?? 1) >= 0.5 ? 1 : 0;
        case 'engineMaster2':
          return (c.condition?.[1] ?? c.condition?.[0] ?? 1) >= 0.5 ? 1 : 0;
      }
      const spec = this.specs.get(id);
      if (!spec) return 0;
      const running = t.engines.some((e) => e.running);
      return running ? (spec.running ?? spec.initial) : spec.initial;
    };
    this.reverse = value('reverse') >= 0.5;
    if (this.press('baroStd', value('baroStd'))) this.std = !this.std;
    if (this.press('fcuMach', value('fcuMach'))) this.mach = !this.mach;
    this.poseControls(dt, value, first);
    if (this.inside) this.updateInstances();
    this.lighting(t.time, panelLight);
    const f = this.frame(dt, t, value, altOffset, first);
    for (const { atlas, tex } of this.atlases) if (atlas.update(dt, f)) tex.needsUpdate = true;
    if (this.panelAtlas.update(dt, f.panel)) this.panelTex.needsUpdate = true;
  }

  /** Everything the displays show this frame. */
  private frame(
    dt: number,
    t: Telemetry,
    value: (id: string) => number,
    altOffset: number,
    first: boolean,
  ): Frame {
    const s = this.s;
    const ins = t.instruments;
    const sys = t.systems;
    const av: AvionicsTelemetry | undefined = t.avionics;
    const a3: A320Avionics = readA320(av);
    const on = (id: string) => value(id) >= 0.5;
    const running = [0, 1].map((i) => !!t.engines[i]?.running) as [boolean, boolean];
    // --- electrical power and the APU (derived until the systems report them) ---
    const extAvail = t.onGround && t.groundSpeed < 1;
    const apuMaster = on('apuMaster');
    if (apuMaster && this.press('apuStart', value('apuStart'))) s.apuStarting = true;
    else this.press('apuStart', value('apuStart'));
    if (!apuMaster) s.apuStarting = false;
    const apuTarget = apuMaster && (s.apuStarting || s.apuN > 95) ? 100 : 0;
    s.apuN = first
      ? apuMaster && apuTarget
        ? 100
        : 0
      : s.apuN + Math.sign(apuTarget - s.apuN) * Math.min(Math.abs(apuTarget - s.apuN), dt * 2.6);
    const apuSys = a3.systems?.apu;
    if (apuSys?.n !== undefined) s.apuN = apuSys.n;
    if (apuSys?.egt !== undefined) s.apuEgt = apuSys.egt;
    const apuAvail = apuSys?.available ?? s.apuN > 95;
    s.apuEgt = lag(
      s.apuEgt,
      s.apuN > 5 ? (s.apuN < 60 ? 600 + s.apuN * 2 : 420) : 15,
      dt,
      first ? 0 : 4,
    );
    const genOn = [on('generator1') && running[0], on('generator2') && running[1]];
    const busOn = sys
      ? sys.busVolts > 20
      : on('battery') ||
        on('battery2') ||
        genOn[0]! ||
        genOn[1]! ||
        (on('externalPower') && extAvail) ||
        (on('apuGenerator') && apuAvail);
    const acOn =
      genOn[0]! ||
      genOn[1]! ||
      (on('externalPower') && extAvail) ||
      (on('apuGenerator') && apuAvail);
    const powered = sys ? sys.busVolts > 20 : busOn;
    const dispOn = powered && (acOn || on('battery'));
    // --- air data and attitude ---
    const ias = (ins ? ins.airspeed : t.ias) * MS_TO_KT;
    if (!first && dt > 0) s.trend = lag(s.trend, ((ias - s.ias) / dt) * 10, dt, 0.8);
    s.ias = ias;
    const setting = this.std ? 1013.25 : value('altimeterSetting');
    const alt =
      (ins ? ins.altitude : t.altitude + altOffset + (setting - 1013.25) * M_PER_HPA) * M_TO_FT;
    s.vs = lag(s.vs, (ins ? ins.verticalSpeed : t.verticalSpeed) * MS_TO_FPM, dt, first ? 0 : 0.5);
    const pitch = (ins ? ins.pitch : t.pitch) * RAD_TO_DEG;
    const bank = (ins ? ins.bank : t.bank) * RAD_TO_DEG;
    const heading = ins ? ins.heading : t.headingDeg;
    const tas = t.tas * MS_TO_KT;
    const mach = t.mach ?? tas / (661.47 * Math.sqrt(Math.max(1 - 6.8756e-6 * alt, 0.5)));
    const ap = av?.autopilot;
    const lift =
      a3.slats !== undefined && a3.flaps !== undefined
        ? { slats: a3.slats, flaps: a3.flaps, label: a3.config ?? configLabel(a3.slats, a3.flaps) }
        : highLift(value('flaps'), t.flaps, ias);
    const confIdx = Math.round(Math.min(Math.max(value('flaps'), 0), 4));
    // With the flight guidance's speeds, a missing one is hidden; without them, rules of thumb.
    const own = defaultSpeeds(confIdx);
    const sp = a3.speeds ? { ...own, ...a3.speeds } : own;
    const fma = fmaLines(a3.fma ?? fallbackFma(av, value, alt));
    const mine = this.fmaBoxes.update(fma, t.time);
    const boxes = a3.fmaChanged ? fma.map((_c, i) => !!a3.fmaChanged![i]) : mine;
    const dhMatch = fma[3]?.join(' ').match(/DH (\d+)/);
    const ils = av?.nav1;
    const ilsValid = !!ils?.valid && ils.localizer;
    const radioAlt = t.agl === undefined ? undefined : t.agl * M_TO_FT;
    const speedManaged = a3.target?.managed ?? on('fcuSpeedManaged');
    const selSpeed = this.mach ? value('fcuSpeed') / 100 : value('fcuSpeed');
    // The tape shows knots: a Mach target sits where that Mach is at the present ratio.
    const speedTarget = a3.target
      ? a3.target.mach
        ? a3.target.speed * (ias / Math.max(mach, 0.1))
        : a3.target.speed
      : speedManaged
        ? ap?.selectedSpeed
        : this.mach
          ? undefined
          : selSpeed;
    if (a3.target?.trend !== undefined) s.trend = a3.target.trend - ias;
    const pfd: PfdData = {
      on: dispOn,
      pitch,
      bank,
      slip: ins ? ins.slip : Math.max(-1, Math.min(1, -t.beta * RAD_TO_DEG * 0.15)),
      ias,
      trend: s.trend,
      mach,
      alt,
      baro: setting,
      std: this.std,
      vs: s.vs,
      heading,
      track: t.trackDeg,
      speedTarget: speedTarget !== undefined && speedTarget < 5 ? undefined : speedTarget,
      speedManaged,
      selAlt: value('fcuAltitude'),
      altManaged: on('fcuAltitudeManaged'),
      selHeading: on('fcuHeadingManaged') ? undefined : value('fcuHeading'),
      fd:
        on('flightDirector') && ap?.flightDirector
          ? {
              pitch: ap.flightDirector.pitch * RAD_TO_DEG,
              bank: ap.flightDirector.bank * RAD_TO_DEG,
            }
          : undefined,
      ls: on('ls'),
      loc: ilsValid ? ils!.deviation : undefined,
      gs: ilsValid ? ils!.glideSlope : undefined,
      ilsIdent: ilsValid ? ils!.ident : '',
      ilsFreq: ils ? freqText(ils.frequency).slice(0, 6) : '',
      ilsCourse: ilsValid ? ils!.course : undefined,
      dme: ilsValid && av?.dme.source === 'nav1' ? av.dme.distanceNm : undefined,
      radioAlt: radioAlt !== undefined && radioAlt < 2500 ? radioAlt : undefined,
      dh: dhMatch ? Number(dhMatch[1]) : undefined,
      fma,
      boxes,
      fmaCombined: !!a3.fmaCombined,
      athrArmed: !!a3.athrArmed,
      vls: sp.vls,
      vAlphaProt: sp.vAlphaProt,
      vAlphaMax: sp.vAlphaMax,
      vmax: sp.vmax,
      f: a3.speeds ? a3.speeds.f : confIdx >= 1 && confIdx <= 2 ? sp.f : undefined,
      s: a3.speeds ? a3.speeds.s : confIdx === 1 ? sp.s : undefined,
      greenDot: a3.speeds ? a3.speeds.greenDot : confIdx === 0 ? sp.greenDot : undefined,
      v1: a3.speeds?.v1,
      vr: a3.speeds?.vr,
      onGround: t.onGround,
      law: a3.law ?? 'normal',
      time: t.time,
    };
    // --- navigation display ---
    const g = av?.gps;
    const gs = g?.groundSpeedKt ?? t.groundSpeed * MS_TO_KT;
    const navaids: NdData['navaids'] = [];
    if (av)
      for (const [n, key] of [
        [av.nav1, 'nav1'],
        [av.nav2, 'nav2'],
      ] as const)
        if (
          n.valid &&
          n.bearing !== undefined &&
          av.dme.source === key &&
          av.dme.distanceNm !== undefined
        ) {
          const b = (n.bearing * Math.PI) / 180;
          navaids.push({
            ident: n.ident,
            east: Math.sin(b) * av.dme.distanceNm,
            north: Math.cos(b) * av.dme.distanceNm,
          });
        }
    const vor =
      av?.nav1.valid && !av.nav1.localizer ? av.nav1 : av?.nav2.valid ? av.nav2 : undefined;
    const wind = windFrom(tas, heading, gs, t.trackDeg);
    const nd: NdData = {
      on: dispOn,
      mode: ND_MODES[Math.round(value('ndMode'))] ?? 'arc',
      range: ndRangeNm(value('ndRange')),
      heading,
      track: g?.track ?? t.trackDeg,
      gs,
      tas,
      wind,
      lon: g?.lon ?? 0,
      lat: g?.lat ?? 0,
      plan: g?.plan ?? [],
      active: g?.active ?? -1,
      distance: g?.distanceNm,
      declination: 0,
      selHeading: on('fcuHeadingManaged') ? undefined : value('fcuHeading'),
      ils: ilsValid
        ? {
            course: ils!.course,
            deviation: ils!.deviation,
            gs: ils!.glideSlope,
            ident: ils!.ident,
            freq: freqText(ils!.frequency),
          }
        : undefined,
      vor: vor
        ? {
            course: vor.course,
            deviation: vor.deviation,
            ident: vor.ident,
            freq: freqText(vor.frequency),
            bearing: vor.bearing,
            toFrom: vor.toFrom,
          }
        : undefined,
      navaids,
      time: t.time,
    };
    // --- engines ---
    const lever = [value('throttle1'), value('throttle2')];
    const athrActive = a3.athr ? a3.athr === 'active' : !!ap?.autothrottle?.engaged;
    const limit = a3.thrustLimit ?? thrustLimit(Math.max(lever[0]!, lever[1]!), t.onGround);
    const engines = [0, 1].map((i) => {
      const e = t.engines[i];
      const run = !!e?.running;
      const n1 = e?.n1 ?? (run ? 19.5 + 76 * (e?.power ?? 0) : 0);
      const angle = leverAngle(lever[i]!, this.reverse);
      return {
        n1,
        n1Cmd:
          run && (!athrActive || angle > 0.5)
            ? leverN1(angle, 19.5, limit.mode === 'TOGA' ? limit.n1 : 95.6)
            : undefined,
        egt: e?.turbineTemperature ?? (run ? 400 + 450 * (e?.power ?? 0) : 15),
        n2: e?.n2 ?? (run ? 58 + 40 * (e?.power ?? 0) : 0),
        ff: fuelFlowKgh(e?.fuelFlow ?? 0),
        running: run,
        starting: !!e?.starting,
        reverse: !!e?.reversing,
      };
    }) as EwdData['engines'];
    for (let i = 0; i < 2; i++) s.fuelUsed[i]! += (t.engines[i]?.fuelFlow ?? 0) * dt;
    const memo = a3.memo ?? derivedMemo(value, t, apuAvail);
    const ewd: EwdData = {
      on: dispOn,
      engines,
      thrustMode: limit.mode,
      thrustN1: limit.n1,
      flexTemp: (a3.thrustLimit as { flexTemp?: number } | undefined)?.flexTemp,
      fob: fobKg(t.fuel),
      slats: lift.slats,
      flaps: lift.flaps,
      config: lift.label,
      warnings: a3.warnings ?? (a3.cautions ? [] : derivedWarnings(t, value)),
      cautions: a3.cautions ?? [],
      memo,
      time: t.time,
    };
    // --- system display ---
    const sy = a3.systems;
    const tanks = sy?.fuel?.tanks ?? sys?.fuelTanks;
    const fuel: [number, number, number] =
      tanks && tanks.length >= 3
        ? [tanks[0]!, tanks[1]!, tanks[2]!]
        : [Math.min(t.fuel / 2, 5440), Math.max(0, t.fuel - 10880), Math.min(t.fuel / 2, 5440)];
    const hydPsi = sy?.hydraulics ?? sys?.hydraulics;
    const psi = (i: number, src: boolean) =>
      hydPsi?.[i] !== undefined ? hydPsi[i]! : src ? 3000 : 0;
    const gl = gearLights(t.gear);
    // Brakes warm with every stop and cool slowly.
    for (let i = 0; i < 4; i++) {
      const heat = t.onGround && t.groundSpeed > 5 && on('parkingBrake') ? 30 : 0;
      s.brakes[i] = lag(s.brakes[i]!, 15 + heat + (i % 2) * 5, dt, first ? 0 : 120);
    }
    const ambientPsi = 14.696 * Math.pow(Math.max(1 - 6.8756e-6 * alt, 0.05), 5.2559);
    const packsOn = on('pack1') || on('pack2');
    const cabTarget =
      sy?.air?.cabinAltitude !== undefined
        ? sy.air.cabinAltitude
        : sys?.cabinAltitude !== undefined
          ? sys.cabinAltitude * M_TO_FT
          : packsOn
            ? Math.min(alt, Math.max(alt * 0.2, Math.min(8000, alt - 30000)))
            : alt;
    s.cabinAlt = first ? cabTarget : lag(s.cabinAlt, cabTarget, dt, 30);
    if (!first && dt > 0)
      s.cabinRate = lag(s.cabinRate, ((s.cabinAlt - s.lastCabin) / dt) * 60, dt, 2);
    s.lastCabin = s.cabinAlt;
    const cabinPsi = 14.696 * Math.pow(Math.max(1 - 6.8756e-6 * s.cabinAlt, 0.05), 5.2559);
    const ab =
      a3.autobrake?.mode ??
      (['off', 'low', 'medium', 'max'] as const)[Math.round(value('autobrake'))] ??
      'off';
    const sd: SdData = {
      on: dispOn,
      page: ECAM_PAGES[Math.round(value('ecamPage'))] ?? 'engine',
      engines: [0, 1].map((i) => ({
        running: running[i]!,
        oilQt: 15.5 - i * 0.4,
        oilPsi: running[i] ? 35 + 30 * (t.engines[i]?.power ?? 0) : 0,
        oilT: running[i] ? 85 + 20 * (t.engines[i]?.power ?? 0) : 15,
        vibN1: running[i] ? 0.6 : 0,
        vibN2: running[i] ? 0.8 : 0,
        used: s.fuelUsed[i]!,
      })) as SdData['engines'],
      apu: {
        master: apuMaster,
        avail: apuAvail,
        n: s.apuN,
        egt: s.apuEgt,
        bleed: apuSys?.bleed ?? on('apuBleed'),
        gen: apuSys?.generator ?? on('apuGenerator'),
      },
      elec: {
        bat: sy?.batteryVolts ?? [on('battery') ? 28.1 : 25.6, on('battery2') ? 28.2 : 25.6],
        batOn: [on('battery'), on('battery2')],
        gen: [on('generator1'), on('generator2')],
        ext: extAvail,
        extOn: on('externalPower') && extAvail,
      },
      bleed: {
        eng: [on('bleed1'), on('bleed2')],
        packs: [on('pack1'), on('pack2')],
        xbleed: on('crossbleed'),
      },
      hyd: {
        psi: [
          psi(0, on('hydGreen') && running[0]),
          psi(1, on('hydBlue') && (running[0] || running[1])),
          psi(2, (on('hydYellow') && running[1]) || on('hydYellowElectric')),
        ],
        pumps: [on('hydGreen'), on('hydBlue'), on('hydYellow')],
        yellowElec: on('hydYellowElectric'),
      },
      fuel: {
        tanks: fuel,
        pumps: [on('fuelPumpsLeft'), on('fuelPumpsCenter'), on('fuelPumpsRight')],
        xfeed: sy?.fuel?.crossfeed ?? on('fuelCrossfeed'),
        used: sy?.fuel?.used ?? s.fuelUsed[0]! + s.fuelUsed[1]!,
      },
      press: {
        cabinAlt: s.cabinAlt,
        diff: sy?.air?.differential ?? Math.max(-0.5, cabinPsi - ambientPsi),
        rate: sy?.air?.cabinRate ?? s.cabinRate,
      },
      wheel: {
        gear: t.gear,
        down: gl.down,
        transit: gl.transit,
        brakes: s.brakes,
        autobrake: ab === 'off' ? '' : ab === 'low' ? 'LO' : ab === 'medium' ? 'MED' : 'MAX',
        parking: sy?.brakesParking ?? on('parkingBrake'),
      },
      fctl: {
        aileronL: t.aileron,
        aileronR: -t.aileron,
        elevator: t.elevator,
        rudder: t.rudder,
        spoilers: spoilerFlags(t),
        trim: a3.stabiliser ?? (t.stabiliser ?? value('trim') * 0.1) * RAD_TO_DEG,
        law: a3.law ?? 'normal',
      },
      status:
        a3.law && a3.law !== 'normal'
          ? [`${a3.law.toUpperCase()} LAW`, 'PROT LOST', 'MAX SPEED 320/.77']
          : [],
      tat: 15 - alt * 0.00198 + (tas * tas) / 7592,
      sat: 15 - alt * 0.00198,
      gw: sy?.grossMass ?? 52000 + t.fuel,
      time: t.time,
    };
    // --- MCDU ---
    const plan = g?.plan ?? [];
    const dist: number[] = [];
    let acc = 0;
    let prev = g ? { lon: g.lon, lat: g.lat } : undefined;
    plan.forEach((wp, i) => {
      if (i < (g?.active ?? 0) || !prev) {
        dist.push(0);
        return;
      }
      const o = mapOffsetNm(prev.lon, prev.lat, wp.lon, wp.lat);
      acc += Math.hypot(o.east, o.north);
      dist.push(acc);
      prev = wp;
    });
    const mcdu: McduData = {
      on: dispOn,
      plan,
      active: g?.active ?? -1,
      dist,
      gs,
      time: t.time,
      cruiseFl: 350,
    };
    const isis: IsisData = { on: powered, pitch, bank, ias, alt, baro: setting, heading };
    // --- panel windows and the lit legends ---
    const vsEngaged = /^V\/S/.test(fma[1]?.[0] ?? '') || value('fcuVsPull') >= 0.5;
    const keys = keyFaces(value, {
      running,
      apuAvail,
      apuStarting: s.apuStarting && !apuAvail,
      extAvail,
      ac: acOn,
      a3,
      av,
      fma,
      ab,
      warn: a3.masterWarning ?? ewd.warnings.length > 0,
      caution: a3.masterCaution ?? ewd.cautions.length > 0,
      time: t.time,
    });
    const xm = ['OFF', 'STBY', 'ON', 'ALT'][Math.round(value('xpdrMode'))] ?? 'STBY';
    // The FCU's windows: what the flight guidance shows (NaN = dashes), else the knobs.
    const fcu = a3.fcu;
    const spdMach = fcu ? fcu.mach : this.mach;
    const panel: PanelData = {
      powered: busOn,
      spd: fcu
        ? {
            text: fcuSpeedText(
              fcu.speed === undefined ? 0 : spdMach && fcu.speed < 1 ? fcu.speed * 100 : fcu.speed,
              spdMach,
              fcu.speed === undefined,
            ),
            mach: spdMach,
            managed: fcu.speedDot,
          }
        : {
            text: fcuSpeedText(value('fcuSpeed'), this.mach, speedManaged),
            mach: this.mach,
            managed: speedManaged,
          },
      hdg: fcu
        ? {
            text: fcuHeadingText(fcu.heading ?? 0, fcu.heading === undefined),
            managed: fcu.headingDot,
          }
        : {
            text: fcuHeadingText(value('fcuHeading'), on('fcuHeadingManaged')),
            managed: on('fcuHeadingManaged'),
          },
      alt: fcu
        ? { text: fcuAltitudeText(fcu.altitude ?? value('fcuAltitude')), managed: fcu.altitudeDot }
        : { text: fcuAltitudeText(value('fcuAltitude')), managed: on('fcuAltitudeManaged') },
      vs: fcu
        ? { text: fcuVsText(fcu.verticalSpeed ?? 0, fcu.verticalSpeed !== undefined) }
        : { text: fcuVsText(ap?.selectedVerticalSpeed ?? value('fcuVerticalSpeed'), vsEngaged) },
      baro: { text: baroText(setting, this.std), std: this.std },
      rmp: {
        com1: [freqText(value('com1Active')), freqText(value('com1Standby'))],
        nav1: [
          freqText(value('nav1Active')).slice(0, 6),
          freqText(value('nav1Standby')).slice(0, 6),
        ],
        com2: [freqText(value('com2Active')), freqText(value('com2Standby'))],
        nav2: [
          freqText(value('nav2Active')).slice(0, 6),
          freqText(value('nav2Standby')).slice(0, 6),
        ],
      },
      adf: String(Math.round(value('adfFrequency'))),
      atc: {
        code: String(Math.round(value('xpdrCode'))).padStart(4, '0'),
        mode: xm,
        ident: !!av?.transponder.ident,
      },
      rudderTrim: rudderTrimText(value('rudderTrim')),
      gear: { down: gl.down, transit: gl.transit },
      ecp: Math.round(value('ecamPage')),
      keys,
    };
    return { pfd, nd, ewd, sd, mcdu, isis, panel };
  }
}

/** Wind (from, kt) out of the air and ground vectors. */
function windFrom(
  tas: number,
  heading: number,
  gs: number,
  track: number,
): { dir: number; speed: number } | undefined {
  if (tas < 60) return undefined;
  const r = Math.PI / 180;
  const e = gs * Math.sin(track * r) - tas * Math.sin(heading * r);
  const n = gs * Math.cos(track * r) - tas * Math.cos(heading * r);
  const speed = Math.hypot(e, n);
  // The wind blows towards (e, n): it comes from the opposite direction.
  return { dir: (((Math.atan2(-e, -n) / r) % 360) + 360) % 360, speed };
}

/** Spoiler panels up or not, left wing 1-5 then right wing 1-5 (for the F/CTL page). */
function spoilerFlags(t: Telemetry): number[] {
  const sb = t.speedbrake ?? 0;
  const out: number[] = [];
  for (const side of [-1, 1])
    for (let i = 0; i < 5; i++) {
      const ground = t.onGround && sb > 0.5;
      const brake = sb > 0.05 && i >= 1 && i <= 3;
      const roll = i >= 1 && Math.sign(t.aileron) === side && Math.abs(t.aileron) > 0.1;
      out.push(ground || brake || roll ? 30 : 0);
    }
  return out;
}

/** The FMA built from the generic autopilot telemetry when the A320 block is absent. */
function fallbackFma(
  av: AvionicsTelemetry | undefined,
  value: (id: string) => number,
  alt: number,
): string[][] {
  const ap = av?.autopilot;
  if (!ap || !av?.powered) return [[], [], [], [], []];
  const at = ap.autothrottle;
  const col1 = at?.engaged
    ? [at.mode === 'thrust' ? 'THR CLB' : at.mode === 'idle' ? 'THR IDLE' : 'SPEED']
    : [];
  const vert: Record<string, string> = {
    pitch: '',
    vs: `V/S ${ap.selectedVerticalSpeed >= 0 ? '+' : ''}${Math.round(ap.selectedVerticalSpeed)}`,
    alt: Math.abs(alt - ap.selectedAltitude) < 60 ? 'ALT' : 'ALT*',
    gs: 'G/S',
    flc: ap.selectedAltitude > alt ? 'OP CLB' : 'OP DES',
  };
  const lat: Record<string, string> = { roll: '', hdg: 'HDG', nav: 'NAV', apr: 'LOC' };
  const col2 = [
    vert[ap.vertical] ?? '',
    ap.verticalArmed === 'gs' ? 'G/S' : ap.verticalArmed === 'alt' ? 'ALT' : '',
  ];
  const col3 = [
    lat[ap.lateral] ?? '',
    ap.lateralArmed === 'apr' ? 'LOC' : ap.lateralArmed === 'nav' ? 'NAV' : '',
  ];
  const fd = value('flightDirector') >= 0.5;
  const col5 = [ap.engaged ? 'AP1' : '', fd ? '1 FD 2' : '', at ? (at.engaged ? 'A/THR' : '') : ''];
  return [col1, col2, col3, [], col5];
}

/** Green memo lines from the switches (FCOM 1.31.40: the T.O and LDG memos left out). */
function derivedMemo(value: (id: string) => number, t: Telemetry, apuAvail: boolean): string[] {
  const on = (id: string) => value(id) >= 0.5;
  const out: string[] = [];
  if (on('seatBelts') || value('seatBelts') >= 1) out.push('SEAT BELTS');
  if (on('spoilersArmed')) out.push('GND SPLRS ARMED');
  if ((t.speedbrake ?? value('speedbrake')) > 0.05 && !t.onGround) out.push('SPEED BRK');
  if (on('parkingBrake') && t.onGround) out.push('PARK BRK');
  if (apuAvail) out.push('APU AVAIL');
  if (on('apuBleed') && apuAvail) out.push('APU BLEED');
  if (on('lightLanding')) out.push('LDG LT');
  if (!t.onGround && value('lightStrobe') < 1) out.push('STROBE LT OFF');
  if (on('wingAntiIce')) out.push('WING A.ICE');
  if (on('engineAntiIce1') || on('engineAntiIce2')) out.push('ENG A.ICE');
  if (on('hydYellowElectric')) out.push('HYD PTU');
  return out.slice(0, 6);
}

/** Red warnings the telemetry implies (the flight warning computer's few obvious ones). */
function derivedWarnings(t: Telemetry, value: (id: string) => number): string[] {
  const out: string[] = [];
  const ex = t.exceedances ?? [];
  if (ex.includes('overspeed') || ex.includes('mach')) out.push('OVERSPEED');
  if (!t.onGround && t.gear < 0.99 && value('flaps') >= 3 && (t.agl ?? 9999) < 230)
    out.push('L/G GEAR NOT DOWN');
  if (t.stallWarning) out.push('STALL');
  return out;
}

interface KeyContext {
  running: [boolean, boolean];
  apuAvail: boolean;
  apuStarting: boolean;
  extAvail: boolean;
  ac: boolean;
  a3: A320Avionics;
  av: AvionicsTelemetry | undefined;
  fma: string[][];
  ab: string;
  warn: boolean;
  caution: boolean;
  time: number;
}

const FAULT = (lit: boolean) => ({ text: 'FAULT', color: AB.amber, lit });
const OFF = (lit: boolean) => ({ text: 'OFF', color: AB.white, lit });
const ONB = (lit: boolean) => ({ text: 'ON', color: AB.blue, lit });

/** Every lit push button's legend for the switch positions and what they control. */
export function keyFaces(value: (id: string) => number, k: KeyContext): Record<KeyLegend, KeyFace> {
  const on = (id: string) => value(id) >= 0.5;
  const korry = (upper: KeyFace & { kind: 'korry' }) => upper;
  const off = (id: string, fault = false): KeyFace =>
    korry({ kind: 'korry', upper: FAULT(fault), lower: OFF(!on(id)) });
  const onKey = (id: string, fault = false): KeyFace =>
    korry({ kind: 'korry', upper: FAULT(fault), lower: ONB(on(id)) });
  const col5 = k.fma[4]?.join(' ') ?? '';
  const ap = k.av?.autopilot;
  const col2 = k.fma[1]?.join(' ') ?? '';
  const col3 = k.fma[2]?.join(' ') ?? '';
  const bars = (text: string, lit: boolean): KeyFace => ({ kind: 'bars', text, lit });
  const anyEngine = k.running[0] || k.running[1];
  const out = {} as Record<KeyLegend, KeyFace>;
  for (const id of KEY_LEGENDS) {
    switch (id) {
      case 'battery':
      case 'battery2':
      case 'bleed1':
      case 'bleed2':
        out[id] = off(id);
        break;
      case 'pack1':
      case 'pack2':
        out[id] = off(id, on(id) && !anyEngine && !(on('apuBleed') && k.apuAvail));
        break;
      case 'generator1':
        out[id] = off(id, on(id) && !k.running[0]);
        break;
      case 'generator2':
        out[id] = off(id, on(id) && !k.running[1]);
        break;
      case 'apuGenerator':
        out[id] = off(id, on(id) && on('apuMaster') && !k.apuAvail && !k.apuStarting);
        break;
      case 'externalPower':
        out[id] = {
          kind: 'korry',
          upper: { text: 'AVAIL', color: AB.green, lit: k.extAvail && !on(id) },
          lower: ONB(on(id) && k.extAvail),
        };
        break;
      case 'apuMaster':
      case 'apuBleed':
      case 'wingAntiIce':
      case 'engineAntiIce1':
      case 'engineAntiIce2':
      case 'probeHeat':
      case 'hydYellowElectric':
        out[id] = onKey(id);
        break;
      case 'apuStart':
        out[id] = {
          kind: 'korry',
          upper: { text: 'AVAIL', color: AB.green, lit: k.apuAvail },
          lower: ONB(k.apuStarting),
        };
        break;
      case 'fuelPumpsLeft':
      case 'fuelPumpsCenter':
      case 'fuelPumpsRight':
        out[id] = off(id, on(id) && !k.ac);
        break;
      case 'fuelCrossfeed':
      case 'crossbleed':
        out[id] = {
          kind: 'korry',
          upper: { text: 'OPEN', color: AB.green, lit: on(id) },
          lower: ONB(on(id)),
        };
        break;
      case 'hydGreen':
        out[id] = off(id, on(id) && !k.running[0]);
        break;
      case 'hydYellow':
        out[id] = off(id, on(id) && !k.running[1]);
        break;
      case 'hydBlue':
        out[id] = off(id, on(id) && !anyEngine);
        break;
      case 'ap1':
        out[id] = bars(
          'AP1',
          k.a3.ap1 ?? (/AP ?1/.test(col5) || (!!ap?.engaged && !/AP ?2/.test(col5))),
        );
        break;
      case 'ap2':
        out[id] = bars('AP2', k.a3.ap2 ?? /AP1\+2|AP ?2/.test(col5));
        break;
      case 'athr':
        out[id] = bars(
          'A/THR',
          k.a3.athr ? k.a3.athr !== 'off' : /A\/THR/.test(col5) || !!ap?.autothrottle?.engaged,
        );
        break;
      case 'fcuLoc':
        out[id] = bars('LOC', k.a3.loc ?? (/LOC/.test(col3) && !/G\/S/.test(col2)));
        break;
      case 'fcuAppr':
        out[id] = bars('APPR', k.a3.appr ?? /G\/S|LAND|FLARE/.test(col2));
        break;
      case 'fcuExped':
        out[id] = bars('EXPED', k.a3.exped ?? /EXP/.test(col2));
        break;
      case 'flightDirector':
        out[id] = bars('FD', on('flightDirector'));
        break;
      case 'ls':
        out[id] = bars('LS', on('ls'));
        break;
      case 'masterWarning':
        out[id] = {
          kind: 'master',
          text: ['MASTER', 'WARN'],
          color: AB.red,
          lit: k.warn && Math.floor(k.time * 2) % 2 === 0,
        };
        break;
      case 'masterCaution':
        out[id] = { kind: 'master', text: ['MASTER', 'CAUT'], color: AB.amber, lit: k.caution };
        break;
      case 'abLo':
      case 'abMed':
      case 'abMax': {
        const mode = id === 'abLo' ? 'low' : id === 'abMed' ? 'medium' : 'max';
        const sel = k.ab === mode;
        out[id] = {
          kind: 'korry',
          upper: { text: 'DECEL', color: AB.green, lit: sel && !!k.a3.autobrake?.decel },
          lower: ONB(sel),
        };
        break;
      }
    }
  }
  return out;
}
