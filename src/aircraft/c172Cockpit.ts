/**
 * The Cessna 172S cockpit at work: every control posed from the cockpit's values (cockpitCore.ts
 * does what all cockpits share), the gauges from the instruments (or the plain telemetry), the
 * radio stack and annunciators painted from the avionics and systems.
 *
 * Draw calls: the fixed dial faces and the display windows are merged into one mesh each, on
 * top of what the core merges and instances.
 */
import {
  type CanvasTexture,
  type Material,
  type Mesh,
  MeshStandardNodeMaterial,
  type Object3D,
  type Vector3,
} from 'three/webgpu';
import { float, mix, step, texture, uv, vec4 } from 'three/tsl';
import { C172_CONTROLS, type Cockpit, type ControlInput, type Telemetry } from '@sim';
import { CABIN, DISPLAYS, DUAL_KNOBS, OCCLUDERS, TURNING_FACES } from './c172Parts';
import { CockpitCore, type CockpitHost, type FloatU, type Rig } from './cockpitCore';
import {
  DME_SOURCE_DEG,
  FUEL_SELECTOR_DEG,
  MAGNETO_DEG,
  SETTLE,
  TRIM_WHEEL_RAD,
  XPDR_DIGIT_DEG,
  XPDR_MODE_DEG,
  dimmerDeg,
  selectorDeg,
  slideShare,
  xpdrDigits,
} from './controlPoses';
import { ATLAS_H, ATLAS_W, DisplayAtlas, PASSIVE, REGIONS, avionicsFromCockpit } from './displays';
import {
  KG_PER_GAL_AVGAS,
  MS_TO_KT,
  M_TO_FT,
  MS_TO_FPM,
  RAD_TO_DEG,
  C172S_TANK_GAL,
  altimeterAngles,
  asiAngle,
  attitudeCardOffset,
  flapIndicatorAngle,
  fuelPerTankGal,
  headingDelta,
  lag,
  slipBallAngle,
  smallGaugeAngle,
  tachAngle,
  turnCoordinatorAngle,
  vsiAngle,
} from './instruments';
import { findMesh, remapUv } from './meshUtil';

const DEG = Math.PI / 180;
/** Metres of indicated altitude per hPa of altimeter setting near sea level. */
const M_PER_HPA = 8.43;

/** Things the Cessna's cockpit borrows from the aircraft it sits in. */
export interface C172CockpitHost extends CockpitHost {
  faceMaterial: Material;
  aiOffset: FloatU;
}

export class C172Cockpit extends CockpitCore {
  private readonly pivots = new Map<
    string,
    { node: Object3D; axis: Vector3; rest: Vector3; slide?: Vector3; now: number }
  >();
  private readonly atlas: DisplayAtlas;
  private readonly atlasTexture: CanvasTexture;
  private navSourcePulse = 0;
  private lastNavSource = -1;
  private s = {
    asi: 0,
    alt: 0,
    vsi: 0,
    tach: 0,
    tc: 0,
    ball: 0,
    yawRate: 0,
    rollRate: 0,
    heading: 0,
    bank: 0,
    compass: 0,
    oilT: 60,
    oilP: 0,
    egt: 0,
    vac: 0,
    amp: 0,
    ff: 0,
    cdi1: 0,
    gs1: 0,
    cdi2: 0,
    adf: 90,
    first: true,
  };

  constructor(private readonly c172: C172CockpitHost) {
    super(c172, {
      controls: C172_CONTROLS,
      cabin: CABIN,
      occluders: OCCLUDERS,
      knobDeg: { altimeterSetting: 10 },
      dualKnobs: Object.fromEntries(
        DUAL_KNOBS.map((id) => [
          id,
          {
            coarse: id === 'adfFrequency' ? 100 : 1000,
            radio: id.startsWith('com') || id.startsWith('nav'),
          },
        ]),
      ),
      detail:
        /^(Ctl_|Needle_|CDI|HI_|AI_Flag|TC_|Xpdr|TrimInd|Inst_|Labels|Displays|Cabin_needle|Cabin_gauge_glass|Cabin_steel|Cabin_chrome)/,
      slideShare,
    });
    const cab = c172.cockpit;
    for (let i = 0; i < 4; i++) {
      const n = cab.getObjectByName(`XpdrDigit_${i}`);
      if (n) this.addExtra(`xpdrDigit${i}`, 'xpdrCode', n);
    }
    const names = [
      'Needle_ASI',
      'Needle_ALT100',
      'Needle_ALT1000',
      'Needle_ALT10000',
      'Needle_VSI',
      'Needle_TACH',
      'Needle_FUELL',
      'Needle_FUELR',
      'Needle_OILT',
      'Needle_OILP',
      'Needle_EGT',
      'Needle_VAC',
      'Needle_AMP',
      'Needle_FF',
      'Needle_FLAPS',
      'Needle_ADF',
      'AI_Roll',
      'HI_Card',
      'HI_Bug',
      'TC_Plane',
      'TC_Ball',
      'Compass_Card',
      'CDI1_Card',
      'CDI1_Needle',
      'CDI1_GS',
      'CDI1_ToFrom',
      'CDI2_Card',
      'CDI2_Needle',
      'CDI2_ToFrom',
      'AI_Flag',
      'HI_Flag',
      'TC_Flag',
      'CDI1_NavFlag',
      'CDI1_GsFlag',
      'CDI2_NavFlag',
      'TrimInd',
    ];
    for (const n of names) {
      const o = cab.getObjectByName(n);
      if (o) this.pivots.set(n, this.pivot(o));
    }
    // Displays and placards.
    const scale = c172.quality === 'low' ? 0.5 : 1;
    this.atlas = new DisplayAtlas(scale);
    this.atlasTexture = c172.canvasTexture(this.atlas.canvas, 4);
    this.ownTextures.push(this.atlasTexture);
    this.textureBytes += this.atlas.canvas.width * this.atlas.canvas.height * 4 * 1.33;
    this.setupDisplays(cab);
    this.setupLabels(cab, c172.quality === 'low' ? 96 : 256);
    this.mergeFaces(cab);
    this.finishSetup();
  }

  // ---------------------------------------------------------------------------------------
  // Setup

  private setupDisplays(cab: Object3D) {
    const tex = this.atlasTexture;
    const m = new MeshStandardNodeMaterial({ roughness: 0.25, metalness: 0 });
    m.name = 'Display';
    // Passive windows (the altimeter's drum) look painted and take the panel light; the rest
    // are dark glass that glows with its own backlight.
    const k = PASSIVE.map((id) => {
      const r = REGIONS[id];
      const u0 = r.x / ATLAS_W;
      const u1 = (r.x + r.w) / ATLAS_W;
      const v0 = r.y / ATLAS_H;
      const v1 = (r.y + r.h) / ATLAS_H;
      return step(u0, uv().x).mul(step(uv().x, u1)).mul(step(v0, uv().y)).mul(step(uv().y, v1));
    }).reduce((a, b) => a.add(b));
    const t = texture(tex, uv()).rgb;
    m.colorNode = vec4(t.mul(mix(float(0.12), float(1), k)), 1);
    m.emissiveNode = t.mul(mix(this.displayGain, this.labelGain, k));
    this.host.track(m);
    const meshes: Mesh[] = [];
    for (const id of DISPLAYS) {
      const node = cab.getObjectByName(`Disp_${id}`);
      const mesh = node && findMesh(node);
      if (!mesh) continue;
      remapUv(mesh, this.atlas.uvRect(id));
      meshes.push(mesh);
    }
    this.merge(meshes, m, 'Displays', cab);
  }

  /** The dials that never turn: one mesh. */
  private mergeFaces(cab: Object3D) {
    const meshes: Mesh[] = [];
    cab.traverse((o) => {
      if (!(o as Mesh).isMesh || (o as Mesh).material !== this.c172.faceMaterial) return;
      const name = o.name.endsWith('_geo') ? (o.parent?.name ?? '') : o.name;
      if (!name.startsWith('Face_') || TURNING_FACES.includes(name.slice(5) as never)) return;
      meshes.push(o as Mesh);
    });
    this.merge(meshes, this.c172.faceMaterial, 'Faces', cab);
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
      const spec = this.specs.get(id)!;
      switch (id) {
        case 'throttle':
          return c.throttle[0] ?? 0;
        case 'mixture':
          return c.mixture[0] ?? 1;
        case 'flaps':
          return c.flaps * 3;
        case 'trim':
          return c.pitchTrim;
        case 'parkingBrake':
          return c.parkingBrake ? 1 : 0;
      }
      const running = t.engines.some((e) => e.running);
      return running ? (spec.running ?? spec.initial) : spec.initial;
    };
    this.poseControls(dt, value, first);
    this.instruments(dt, t, c, cockpit, value, altOffset, first);
    if (this.inside) this.updateInstances();
    this.lighting(t.time, panelLight);
    // Displays.
    const avionics = t.avionics ?? avionicsFromCockpit(cockpit);
    if (
      this.atlas.update(dt, {
        avionics,
        systems: t.systems,
        altimeterSetting: value('altimeterSetting'),
        gpsCdi: value('navSource') >= 0.5,
        time: t.time,
      })
    )
      this.atlasTexture.needsUpdate = true;
  }

  /** The Cessna's selectors and dials with their own travel. */
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
      case 'magnetos':
        this.turn(r, -settle(r, selectorDeg(MAGNETO_DEG, v) * DEG, SETTLE.selector));
        return true;
      case 'fuelSelector':
        this.turn(r, settle(r, selectorDeg(FUEL_SELECTOR_DEG, v) * DEG, SETTLE.selector * 2));
        return true;
      case 'xpdrMode':
        this.turn(r, -settle(r, selectorDeg(XPDR_MODE_DEG, v) * DEG, SETTLE.selector));
        return true;
      case 'dmeSource':
        this.turn(r, settle(r, selectorDeg(DME_SOURCE_DEG, v) * DEG, SETTLE.toggle));
        return true;
      case 'trim': {
        this.turn(r, settle(r, v * TRIM_WHEEL_RAD, SETTLE.lever));
        const ind = this.pivots.get('TrimInd');
        if (ind?.slide)
          ind.node.position.copy(ind.rest).addScaledVector(ind.slide, r.now / TRIM_WHEEL_RAD);
        return true;
      }
      case 'lightPanel':
        this.turn(r, -settle(r, dimmerDeg(v) * DEG, SETTLE.knob));
        return true;
      case 'xpdrCode': {
        const d = xpdrDigits(v);
        for (let i = 0; i < 4; i++) {
          const e = this.extra.get(`xpdrDigit${i}`);
          if (e) this.turn(e, -settle(e, d[i]! * XPDR_DIGIT_DEG * DEG, SETTLE.knob));
        }
        return true;
      }
      case 'navSource': {
        // A key: it dips briefly when the source changes.
        if (this.lastNavSource >= 0 && v !== this.lastNavSource) this.navSourcePulse = 0.15;
        this.lastNavSource = v;
        this.navSourcePulse = Math.max(0, this.navSourcePulse - dt);
        this.slide(r, settle(r, this.navSourcePulse > 0 ? 1 : 0, SETTLE.button));
        return true;
      }
    }
    return false;
  }

  private needle(name: string, deg: number) {
    const p = this.pivots.get(name);
    if (p) p.node.quaternion.setFromAxisAngle(p.axis, -deg * DEG);
  }

  private spin(name: string, rad: number) {
    const p = this.pivots.get(name);
    if (p) p.node.quaternion.setFromAxisAngle(p.axis, rad);
  }

  /** Flags and the TO/FROM triangle: 1 = in view, 0 = slid away behind the bezel. */
  private flag(name: string, shown: boolean, dt: number, first: boolean) {
    const p = this.pivots.get(name);
    if (!p?.slide) return;
    p.now = first ? (shown ? 1 : 0) : lag(p.now, shown ? 1 : 0, dt, 0.12);
    p.node.position.copy(p.rest).addScaledVector(p.slide, 1 - p.now);
  }

  private instruments(
    dt: number,
    t: Telemetry,
    c: ControlInput,
    cockpit: Cockpit | undefined,
    value: (id: string) => number,
    altOffset: number,
    first: boolean,
  ) {
    const s = this.s;
    const k = (tau: number) => (first ? 0 : tau);
    const ins = t.instruments;
    const sys = t.systems;
    // --- flight instruments ---
    s.asi = lag(s.asi, (ins ? ins.airspeed : t.ias) * MS_TO_KT, dt, k(0.15));
    this.needle('Needle_ASI', asiAngle(s.asi));
    const setting = value('altimeterSetting');
    const altM = ins ? ins.altitude : t.altitude + altOffset + (setting - 1013.25) * M_PER_HPA;
    s.alt = lag(s.alt, altM * M_TO_FT, dt, k(0.15));
    const alt = altimeterAngles(s.alt);
    this.needle('Needle_ALT100', alt.p100);
    this.needle('Needle_ALT1000', alt.p1000);
    this.needle('Needle_ALT10000', alt.p10000);
    // The instruments' own VSI already lags; the plain telemetry gets the lag here.
    s.vsi = lag(
      s.vsi,
      (ins ? ins.verticalSpeed : t.verticalSpeed) * MS_TO_FPM,
      dt,
      k(ins ? 0.2 : 1.2),
    );
    this.needle('Needle_VSI', vsiAngle(s.vsi));
    const pitch = ins ? ins.pitch : t.pitch;
    const bank = ins ? ins.bank : t.bank;
    this.spin('AI_Roll', bank);
    this.c172.aiOffset.value = attitudeCardOffset(pitch * RAD_TO_DEG);
    const heading = ins ? ins.heading : t.headingDeg + value('gyroAdjust');
    this.spin('HI_Card', heading * DEG);
    this.needle('HI_Bug', headingDelta(heading, value('headingBug')));
    if (ins) s.compass = ins.compass;
    else
      s.compass =
        s.compass + headingDelta(s.compass, t.headingDeg) * (first ? 1 : 1 - Math.exp(-dt / 0.6));
    this.spin('Compass_Card', s.compass * DEG);
    if (!first && dt > 0) {
      s.yawRate = lag(s.yawRate, headingDelta(s.heading, t.headingDeg) / dt, dt, 0.3);
      s.rollRate = lag(s.rollRate, ((bank - s.bank) * RAD_TO_DEG) / dt, dt, 0.15);
    }
    s.heading = t.headingDeg;
    s.bank = bank;
    const turnRate = ins ? ins.turnRate : s.yawRate;
    const rollPart = ins?.turnFlag ? 0 : s.rollRate;
    s.tc = lag(s.tc, turnCoordinatorAngle(turnRate, rollPart), dt, k(0.25));
    this.needle('TC_Plane', s.tc);
    s.ball = lag(
      s.ball,
      ins ? Math.max(-1, Math.min(1, ins.slip)) * 10 : slipBallAngle(t.beta),
      dt,
      k(0.3),
    );
    // The ball pivot turns counter-clockwise to roll the ball to the pilot's right.
    this.spin('TC_Ball', s.ball * DEG);
    this.flag('AI_Flag', !!ins?.gyroFlag, dt, first);
    this.flag('HI_Flag', !!ins?.gyroFlag, dt, first);
    this.flag('TC_Flag', !!ins?.turnFlag, dt, first);
    // --- engine and systems ---
    const rpm = t.engines[0]?.rpm ?? 0;
    s.tach = lag(s.tach, rpm, dt, k(0.15));
    this.needle('Needle_TACH', tachAngle(s.tach));
    this.needle('Needle_FLAPS', flapIndicatorAngle(t.flaps));
    const gal = fuelPerTankGal(t.fuel);
    const fl = ins ? ins.fuelLeft * C172S_TANK_GAL : gal;
    const fr = ins ? ins.fuelRight * C172S_TANK_GAL : gal;
    this.needle('Needle_FUELL', smallGaugeAngle(fl, 0, C172S_TANK_GAL));
    this.needle('Needle_FUELR', smallGaugeAngle(fr, 0, C172S_TANK_GAL));
    const eng = t.engines[0];
    const running = !!eng?.running;
    const power = eng?.power ?? 0;
    if (sys) {
      s.oilT = lag(s.oilT, (sys.oilTemperature * 9) / 5 + 32, dt, k(0.5));
      s.oilP = lag(s.oilP, sys.oilPressure, dt, k(0.3));
      s.egt = lag(s.egt, sys.egt, dt, k(0.5));
      s.vac = lag(s.vac, sys.vacuum, dt, k(0.3));
      s.amp = lag(s.amp, sys.batteryAmps, dt, k(0.3));
    } else {
      s.oilT = lag(s.oilT, running ? 165 + 45 * power : 60, dt, first && running ? 0 : 60);
      s.oilP = lag(s.oilP, running ? 55 + 25 * Math.min(rpm / 2700, 1) : 0, dt, k(1));
      s.egt = lag(
        s.egt,
        running ? 0.35 + 0.5 * power * Math.min(1, c.mixture[0] ?? 1) : 0,
        dt,
        k(6),
      );
      s.vac = lag(s.vac, running ? 5 * Math.min(rpm / 900, 1) : 0, dt, k(0.6));
      s.amp = lag(s.amp, running ? 2 : 0, dt, k(0.5));
    }
    s.ff = lag(s.ff, ((eng?.fuelFlow ?? 0) * 3600) / KG_PER_GAL_AVGAS, dt, k(0.5));
    this.needle('Needle_OILT', smallGaugeAngle(s.oilT, 75, 250));
    this.needle('Needle_OILP', smallGaugeAngle(s.oilP, 0, 120));
    this.needle('Needle_EGT', smallGaugeAngle(s.egt, 0, 1));
    this.needle('Needle_VAC', smallGaugeAngle(s.vac, 3, 7));
    this.needle('Needle_AMP', smallGaugeAngle(s.amp, -60, 60));
    this.needle('Needle_FF', smallGaugeAngle(s.ff, 0, 20));
    // --- navigation ---
    const av = t.avionics ?? avionicsFromCockpit(cockpit);
    const on = !!av?.powered;
    const gps = value('navSource') >= 0.5;
    const nav1 = av?.nav1;
    const g = av?.gps;
    let dev1 = 0;
    let gs1: number | undefined;
    let tf1: 'to' | 'from' | 'off' = 'off';
    let valid1 = false;
    if (on && gps && g && g.active >= 0) {
      dev1 = -(g.crossTrackNm ?? 0) / 5;
      tf1 = 'to';
      valid1 = true;
    } else if (on && nav1?.valid) {
      dev1 = nav1.deviation;
      gs1 = nav1.glideSlope;
      tf1 = nav1.toFrom;
      valid1 = true;
    }
    this.courseIndicator(
      'CDI1',
      dt,
      first,
      nav1?.course ?? value('obs1'),
      dev1,
      tf1,
      valid1,
      gs1,
      true,
    );
    const nav2 = av?.nav2;
    const valid2 = on && !!nav2?.valid;
    this.courseIndicator(
      'CDI2',
      dt,
      first,
      nav2?.course ?? value('obs2'),
      valid2 ? nav2!.deviation : 0,
      valid2 ? nav2!.toFrom : 'off',
      valid2,
      undefined,
      false,
    );
    const adf = av?.adf;
    const rb = on && adf?.valid && adf.relativeBearing !== undefined ? adf.relativeBearing : 90;
    s.adf += headingDelta(s.adf, rb) * (first ? 1 : 1 - Math.exp(-dt / 0.4));
    this.needle('Needle_ADF', s.adf);
  }

  private courseIndicator(
    id: 'CDI1' | 'CDI2',
    dt: number,
    first: boolean,
    course: number,
    deviation: number,
    toFrom: 'to' | 'from' | 'off',
    valid: boolean,
    glide: number | undefined,
    hasGs: boolean,
  ) {
    const s = this.s;
    const card = this.pivots.get(`${id}_Card`);
    if (card) {
      card.now = first
        ? course
        : card.now + headingDelta(card.now, course) * (1 - Math.exp(-dt / 0.05));
      card.node.quaternion.setFromAxisAngle(card.axis, card.now * DEG);
    }
    const key = id === 'CDI1' ? 'cdi1' : 'cdi2';
    s[key] = lag(s[key], Math.max(-1, Math.min(1, deviation)), dt, first ? 0 : 0.25);
    // The needle hangs from a hinge 0.75 dial radii above the centre; full scale is half a radius.
    this.spin(`${id}_Needle`, Math.asin(s[key] * (0.5 / 0.75)));
    if (hasGs) {
      const target = glide === undefined ? -1.15 : Math.max(-1, Math.min(1, glide));
      s.gs1 = lag(s.gs1, target, dt, first ? 0 : 0.25);
      this.spin(`${id}_GS`, Math.asin(Math.max(-1, Math.min(1, s.gs1 * (0.5 / 0.75)))));
      this.flag(`${id}_GsFlag`, glide === undefined, dt, first);
    }
    this.flag(`${id}_NavFlag`, !valid, dt, first);
    const tf = this.pivots.get(`${id}_ToFrom`);
    if (tf) tf.node.quaternion.setFromAxisAngle(tf.axis, toFrom === 'from' ? Math.PI : 0);
    this.flag(`${id}_ToFrom`, toFrom !== 'off', dt, first);
  }
}
