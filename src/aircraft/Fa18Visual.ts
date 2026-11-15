/**
 * McDonnell Douglas F/A-18C Hornet (Swiss Air Force) on screen: loads
 * public/assets/aircraft/fa18.glb (built by tools/aircraft/build_fa18.py) and moves its parts
 * from the telemetry; model.ts does what every type shares, Fa18Cockpit.ts the front office.
 *
 * What drives what (for checking the real aircraft against the demo's fakes):
 * - flight controls: telemetry.avionics.fa18.surfaces (degrees) when present, else
 *   fa18Parts.surfacesFrom: leading-edge flaps from alpha and flaps, trailing-edge flaps from
 *   telemetry.flaps, ailerons from aileron with the droop, stabilators from elevator plus a
 *   share of aileron (differential), rudders from rudder; rudder toe-in only when the
 *   surfaces block reports the two rudders apart
 * - speed brake: telemetry.speedbrake (else ControlInput.speedbrake)
 * - gear: telemetry.gear through gearSequence; strut compression from telemetry.onGround;
 *   wheels from groundSpeed; nose wheel steering from ControlInput.yaw on the ground (the
 *   cockpit's nosewheelSteering button for the high gain)
 * - hook, launch bar, canopy: the cockpit's hook, launchBar (with the gear down), canopy
 * - nozzles: engines[i].nozzle (else nozzleOpening from n2 and afterburner); afterburner
 *   flames and their glow: engines[i].afterburner (else the power above 1)
 * - vapour: alpha, loadFactor and a humidity proxy (lower is moister)
 * - lights: telemetry.systems.lights, else the cockpit's lightNav, lightStrobe, lightLanding;
 *   formation strips from lightFormation; the landing/taxi light on the nose leg only with the
 *   gear down; cockpit flood and console lighting (NVIS green) from lightFlood, lightConsole
 *
 * Model frame: x left, y up, z forward, metres; origin = the centre of gravity (FS 8.70 m
 * behind the radome tip, 2.00 m above the ground on the gear).
 */
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  type Material,
  type Mesh,
  MeshBasicNodeMaterial,
  type MeshStandardMaterial,
  MeshStandardNodeMaterial,
  type Object3D,
} from 'three/webgpu';
import {
  abs,
  clamp,
  dot,
  float,
  mix,
  normalView,
  positionLocal,
  positionViewDirection,
  pow,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import type { Cockpit, ControlInput, Telemetry } from '@sim';
import type { AircraftVisual, AircraftVisualOptions } from './AircraftVisual';
import { Fa18Cockpit, fa18Block } from './Fa18Cockpit';
import {
  NOZZLE,
  afterburnerOf,
  gearLights,
  gearSequence,
  nozzleExitRadius,
  nozzleOpening,
  surfacesFrom,
  vapour,
} from './fa18Parts';
import { lag } from './instruments';
import { type AircraftLights, cabinGlow } from './lights';
import { toFloat } from './meshUtil';
import {
  AircraftModel,
  type LightLevels,
  type LightState,
  type ModelConfig,
  loadModelScene,
} from './model';

const DEG = Math.PI / 180;

const CONFIG: ModelConfig = {
  name: 'FA18',
  lodDistances: [0, 90, 320],
  chaseDistance: 30,
  chaseHeight: 6.5,
  wheels: ['Wheel_N', 'Wheel_L', 'Wheel_R'],
  lamps: {
    Lamp_NavRed: 0xff1a0d,
    Lamp_NavGreen: 0x19ff6a,
    Lamp_NavWhite: 0xffffff,
    Lamp_Strobe: 0xeef4ff,
    Lamp_Landing: 0xfff3dd,
    Lamp_Formation: 0xb8ff8a,
  },
  glows: {
    Nav_L: {
      color: 0xff2010,
      dir: [Math.sin(60 * DEG), 0, Math.cos(60 * DEG)],
      cone: [Math.cos(75 * DEG), Math.cos(55 * DEG)],
      screen: 0.045,
    },
    Nav_R: {
      color: 0x20ff70,
      dir: [-Math.sin(60 * DEG), 0, Math.cos(60 * DEG)],
      cone: [Math.cos(75 * DEG), Math.cos(55 * DEG)],
      screen: 0.045,
    },
    Tail_L: {
      color: 0xffffff,
      dir: [0, 0, -1],
      cone: [Math.cos(80 * DEG), Math.cos(60 * DEG)],
      screen: 0.035,
    },
    Tail_R: {
      color: 0xffffff,
      dir: [0, 0, -1],
      cone: [Math.cos(80 * DEG), Math.cos(60 * DEG)],
      screen: 0.035,
    },
    Strobe_L: { color: 0xe8f0ff, screen: 0.11 },
    Strobe_R: { color: 0xe8f0ff, screen: 0.11 },
    Landing: {
      color: 0xfff1d8,
      dir: [0, -0.08, 1],
      cone: [Math.cos(35 * DEG), Math.cos(12 * DEG)],
      screen: 0.12,
      follow: true,
    },
    AB_L: { color: 0xff7a2a, screen: 0.16 },
    AB_R: { color: 0xff7a2a, screen: 0.16 },
  },
  blades: [],
  disc: { tip: 0.95, hub: 0.2 },
  landingLight: [0, -0.9, 4.3],
  lowNearest: true,
  lowTextureMax: { map: 1024, other: 512 },
  noShadow: /Glass|Lens|Lamp|GaugeGlass|Display|Labels|Flame|Vapour|Hud|DDI|MPCD|PanelWindows/,
  noReceive: /Lamp|Flame|Vapour|Hud/,
};

export async function loadFa18(options: AircraftVisualOptions = {}): Promise<AircraftVisual> {
  const scene = await loadModelScene('fa18.glb', options.url);
  return new Fa18(scene, options.quality ?? 'high', options);
}

class Fa18 extends AircraftModel {
  protected readonly cockpit: Fa18Cockpit;
  private readonly cabinMaterials: MeshStandardMaterial[] = [];
  private readonly nozzleR = [uniform(NOZZLE.buildR), uniform(NOZZLE.buildR)];
  private readonly flameGain = [uniform(0), uniform(0)];
  private readonly vapourGain = { lex: uniform(0), tip: uniform(0) };
  private readonly pilot: Object3D[] = [];
  private s = {
    steer: 0,
    wheel: 0,
    wheelSpin: 0,
    arm: 0,
    hook: 0,
    bar: 0,
    canopy: 0,
    nozzle: [0.6, 0.6],
    ab: [0, 0],
    lex: 0,
    tip: 0,
  };

  constructor(scene: Object3D, quality: 'high' | 'low', options: AircraftVisualOptions) {
    super(scene, quality, options, CONFIG);
    this.object.updateMatrixWorld(true);
    this.bakeNozzles();
    this.wireMaterials((mesh, mat, owner) => this.special(mesh, mat, owner));
    // Flood and console lighting: the interior glows NVIS green at night (no new shader).
    const lit = /^(Interior|InteriorDark|Panel|Glareshield|AvionicsFace|Fabric|SeatFrame)$/;
    const nvis = new Color(0.45, 1.0, 0.55);
    for (const m of this.materials as Set<Material>) {
      const s = m as MeshStandardMaterial;
      if (!lit.test(m.name) || !s.isMeshStandardMaterial) continue;
      s.emissive = new Color()
        .copy(s.color)
        .multiplyScalar(0.5)
        .add(nvis.clone().multiplyScalar(0.1));
      s.emissiveIntensity = 0;
      this.cabinMaterials.push(s);
    }
    for (const n of ['Pilot', 'Pilot_lod1']) {
      const p = this.object.getObjectByName(n);
      if (p) this.pilot.push(p);
    }
    this.object.updateMatrixWorld(true);
    this.cockpit = new Fa18Cockpit(
      {
        root: this.object,
        cockpit: this.lod0.getObjectByName('Cockpit')!,
        panelLight: this.panelLight,
        quality,
        canvasTexture: (c, a) => this.canvasTexture(c, a),
        track: (m) => this.track(m),
      },
      this.view.eye,
    );
    this.finishSetup();
  }

  /** The cockpit's head-up display geometry and its last picture (tests, the demo). */
  get hud() {
    return { geometry: this.cockpit.hud, data: this.cockpit.lastHud };
  }

  /**
   * The nozzles are opened by moving their vertices in the material: their geometry is put
   * into the model frame first (the optimiser quantises it under a child transform).
   */
  private bakeNozzles() {
    const levels: Object3D[] = [];
    this.object.traverse((o) => {
      if (o.name === 'LOD0' || o.name === 'LOD1') levels.push(o);
    });
    for (const level of levels) {
      level.updateMatrixWorld(true);
      const inv = level.matrixWorld.clone().invert();
      const found: Mesh[] = [];
      level.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh && (m.material as Material).name === 'Nozzle') found.push(m);
      });
      for (const m of found) {
        const g = toFloat(m.geometry);
        g.applyMatrix4(m.matrixWorld.clone().premultiply(inv));
        g.computeVertexNormals();
        m.geometry.dispose();
        m.geometry = g;
        m.removeFromParent();
        m.position.set(0, 0, 0);
        m.quaternion.identity();
        m.scale.set(1, 1, 1);
        level.add(m);
      }
    }
  }

  private nozzleMaterial(src: Material): Material {
    const s = src as MeshStandardMaterial;
    const m = new MeshStandardNodeMaterial({
      color: s.color ?? new Color(0.33, 0.31, 0.29),
      roughness: 0.45,
      metalness: 0.85,
      side: DoubleSide,
    });
    m.name = 'Nozzle';
    const p = positionLocal;
    const left = step(0, p.x);
    const cx = mix(float(-NOZZLE.centreX), float(NOZZLE.centreX), left);
    const cy = float(NOZZLE.centreY);
    const t = clamp(float(NOZZLE.hingeZ).sub(p.z).div(NOZZLE.length), 0, 1);
    const target = mix(this.nozzleR[1]!, this.nozzleR[0]!, left);
    const built = float(NOZZLE.hingeR).add(float(NOZZLE.buildR - NOZZLE.hingeR).mul(t));
    const want = float(NOZZLE.hingeR).add(target.sub(NOZZLE.hingeR).mul(t));
    const k = want.div(built);
    m.positionNode = vec3(cx.add(p.x.sub(cx).mul(k)), cy.add(p.y.sub(cy).mul(k)), p.z);
    return this.track(m);
  }

  private flameMaterial(i: number): Material {
    const m = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    m.name = 'Flame';
    const u = uv().x;
    // Shock diamonds: bright bands along the plume, fading downstream.
    const diamonds = pow(abs(sin(u.mul(Math.PI * 5.5))), 6).mul(float(1).sub(u));
    const core = mix(vec3(1.0, 0.62, 0.3), vec3(0.95, 0.28, 0.08), smoothstep(0.0, 0.6, u));
    const thick = pow(abs(dot(normalView, positionViewDirection)), 1.4);
    const fade = pow(float(1).sub(u), 1.3).mul(smoothstep(0.0, 0.04, u).mul(0.6).add(0.4));
    const k = float(0.12).add(diamonds.mul(1.1)).mul(fade).mul(thick).mul(this.flameGain[i]!);
    m.colorNode = vec4(core.mul(k), 1);
    return this.track(m);
  }

  private vapourMaterial(gain: Fa18['vapourGain']['lex']): Material {
    const m = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    m.name = 'Vapour';
    const u = uv().x;
    const v = uv().y;
    const along = smoothstep(0.0, 0.18, u).mul(float(1).sub(smoothstep(0.55, 1.0, u)));
    const streak = sin(v.mul(Math.PI * 6).add(u.mul(9)))
      .mul(0.25)
      .add(0.75);
    const face = float(1).sub(abs(dot(normalView, positionViewDirection)).mul(0.6));
    const a = along.mul(streak).mul(face).mul(gain).mul(0.85);
    m.colorNode = vec4(0.92, 0.94, 0.97, a);
    return this.track(m);
  }

  private special(mesh: Mesh, mat: Material, owner: string): boolean {
    if (mat.name === 'Nozzle') {
      mesh.material = this.nozzleMaterial(mat);
      return true;
    }
    if (mat.name === 'Flame') {
      const i = owner.startsWith('Flame_R') ? 1 : 0;
      mesh.material = this.flameMaterial(i);
      mesh.renderOrder = 12;
      mesh.frustumCulled = false;
      return true;
    }
    if (mat.name === 'VapourLex' || mat.name === 'VapourTip') {
      mesh.material = this.vapourMaterial(
        mat.name === 'VapourLex' ? this.vapourGain.lex : this.vapourGain.tip,
      );
      mesh.renderOrder = 11;
      return true;
    }
    return false;
  }

  override setCockpitView(inside: boolean): void {
    super.setCockpitView(inside);
    // The pilot is seen from outside; from the seat he would fill the view.
    for (const p of this.pilot) p.visible = !inside;
  }

  /** The cockpit's switches when the systems do not report the lights. */
  protected override lightSwitches(t: Telemetry, cockpit?: Cockpit): AircraftLights {
    if (!t.systems && cockpit?.has('lightNav')) {
      const landing = Math.round(cockpit.get('lightLanding'));
      return {
        nav: cockpit.get('lightNav') >= 0.5,
        beacon: false,
        strobe: cockpit.get('lightStrobe') >= 0.5,
        landing: landing === 2,
        taxi: landing === 1,
        ...this.override(),
      };
    }
    return super.lightSwitches(t, cockpit);
  }

  private override(): Partial<AircraftLights> {
    return (this as unknown as { lightsOverride?: Partial<AircraftLights> }).lightsOverride ?? {};
  }

  private formation = 0;

  protected lightLevels(L: LightState, t: Telemetry): LightLevels {
    const nav = L.nav ? 1 : 0;
    const down = gearLights(t.gear).down ? 1 : 0;
    const landing = L.landing ? down : 0;
    const taxi = L.taxi ? down : 0;
    const ab = this.s.ab;
    return {
      lamps: {
        Lamp_NavRed: 6 * nav,
        Lamp_NavGreen: 6 * nav,
        Lamp_NavWhite: 6 * nav,
        Lamp_Strobe: 40 * L.strobeFlash,
        Lamp_Landing: 25 * Math.max(landing, taxi * 0.6),
        // Electroluminescent strips: dim, even light (they are for formation at night).
        Lamp_Formation: 1.6 * this.formation,
      },
      glows: {
        Nav_L: 1.5 * nav,
        Nav_R: 1.5 * nav,
        Tail_L: 1.1 * nav,
        Tail_R: 1.1 * nav,
        Strobe_L: 8 * L.strobeFlash,
        Strobe_R: 8 * L.strobeFlash,
        Landing: 4 * landing + 2.4 * taxi,
        AB_L: 5 * ab[0]!,
        AB_R: 5 * ab[1]!,
      },
      spot: landing ? 70000 : taxi ? 30000 : 0,
    };
  }

  private deg(name: string, key: string, fallback: number): number {
    return Number(this.pivots.get(name)?.props[key] ?? fallback) * DEG;
  }

  private rotateAll(name: string, angle: number) {
    this.rotate(name, angle);
    const p = this.pivots.get(`${name}_lod2`);
    if (p) p.node.quaternion.setFromAxisAngle(p.axis, angle);
  }

  protected animate(
    dt: number,
    t: Telemetry,
    c: ControlInput,
    cockpit: Cockpit | undefined,
    L: AircraftLights,
  ): void {
    const s = this.s;
    const k = (tau: number) => (this.first ? 0 : tau);
    const fb = fa18Block(t);
    const get = (id: string, fallback: number) => (cockpit?.has(id) ? cockpit.get(id) : fallback);
    const running = t.engines.some((e) => e.running);
    // --- flight controls ---------------------------------------------------------------
    const surf = { ...surfacesFrom(t), ...fb?.surfaces };
    if (fb?.leadingEdgeFlap !== undefined) surf.lef = fb.leadingEdgeFlap / DEG;
    if (fb?.trailingEdgeFlap !== undefined) surf.tef = fb.trailingEdgeFlap / DEG;
    for (const side of ['L', 'R'] as const) {
      this.rotate(`LEF_${side}`, surf.lef * DEG);
      this.rotate(`TEF_${side}`, surf.tef * DEG);
      this.rotate(`Aileron_${side}`, (side === 'L' ? surf.aileronL : surf.aileronR) * DEG);
      this.rotate(`Stabilator_${side}`, (side === 'L' ? surf.stabL : surf.stabR) * DEG);
      this.rotate(`Rudder_${side}`, (side === 'L' ? surf.rudderL : surf.rudderR) * DEG);
    }
    const sb = t.speedbrake ?? c.speedbrake ?? 0;
    this.rotate('Speedbrake', Math.min(Math.max(sb, 0), 1) * this.deg('Speedbrake', 'openDeg', 60));
    // --- canopy: OPEN raises it, CLOSE lowers it, HOLD stops it where it is -----------------
    const sel = Math.round(get('canopy', running ? 2 : 0));
    if (fb?.canopy !== undefined) s.canopy = fb.canopy;
    else if (this.first) s.canopy = sel === 0 ? 1 : 0;
    else if (sel !== 1)
      s.canopy = Math.min(1, Math.max(0, s.canopy + (sel === 0 ? 1 : -1) * (dt / 5)));
    this.rotateAll('Canopy', s.canopy * this.deg('Canopy', 'openDeg', 48));
    // --- gear --------------------------------------------------------------------------
    const g = gearSequence(t.gear);
    for (const side of ['L', 'R']) {
      this.rotateAll(
        `MainGear_${side}`,
        (1 - g.main) * this.deg(`MainGear_${side}`, 'retractDeg', 88),
      );
      this.rotate(`MainTwist_${side}`, g.twist * this.deg(`MainTwist_${side}`, 'twistDeg', 90));
      this.rotate(`MainDoor_${side}`, g.mainDoors * this.deg(`MainDoor_${side}`, 'openDeg', 95));
      this.rotate(`NoseDoor_${side}`, g.noseDoors * this.deg(`NoseDoor_${side}`, 'openDeg', 85));
    }
    this.rotateAll('NoseGear', (1 - g.nose) * this.deg('NoseGear', 'retractDeg', 92));
    s.arm = lag(s.arm, t.onGround ? 0 : 1, dt, k(0.15));
    this.slideBy('MainOleo_L', s.arm);
    this.slideBy('MainOleo_R', s.arm);
    this.slideBy('NoseOleo', s.arm);
    const highGain = fb?.nosewheelSteering
      ? fb.nosewheelSteering === 'high'
      : get('nosewheelSteering', 0) >= 0.5;
    const steerTarget = t.onGround
      ? Math.max(-1, Math.min(1, c.yaw)) * (highGain ? 60 : 16) * DEG
      : 0;
    s.steer = lag(s.steer, steerTarget, dt, k(0.2));
    this.rotate('NoseSteer', s.steer);
    if (t.onGround) s.wheelSpin = t.groundSpeed;
    else s.wheelSpin = lag(s.wheelSpin, 0, dt, t.gear < 0.98 ? 0.4 : 5);
    s.wheel = (s.wheel + (s.wheelSpin * dt) / 0.37) % (Math.PI * 2);
    this.rotate('Wheel_L', s.wheel);
    this.rotate('Wheel_R', s.wheel);
    this.rotate('Wheel_N', s.wheel * (0.37 / 0.27));
    // --- hook and launch bar -------------------------------------------------------------
    s.hook = fb?.hook ?? lag(s.hook, get('hook', 0) >= 0.5 ? 1 : 0, dt, k(0.6));
    this.rotateAll('Hook', s.hook * this.deg('Hook', 'downDeg', 62));
    const bar = get('launchBar', 0) >= 0.5 && g.nose > 0.99 ? 1 : 0;
    s.bar = lag(s.bar, bar, dt, k(0.5));
    this.rotate('LaunchBar', s.bar * this.deg('LaunchBar', 'downDeg', 100));
    // --- engines: nozzles and afterburner ---------------------------------------------------
    for (let i = 0; i < 2; i++) {
      const e = t.engines[i] ?? t.engines[0];
      s.nozzle[i] = lag(s.nozzle[i]!, nozzleOpening(e), dt, k(0.8));
      s.ab[i] = lag(s.ab[i]!, afterburnerOf(e), dt, k(0.25));
      this.nozzleR[i]!.value = nozzleExitRadius(s.nozzle[i]!);
      const ab = s.ab[i]!;
      this.flameGain[i]!.value = ab > 0.01 ? 0.5 + 1.3 * ab : 0;
      const side = i === 0 ? 'L' : 'R';
      const r = nozzleExitRadius(s.nozzle[i]!) / 0.3;
      for (const n of [`Flame_${side}`, `Flame_${side}_lod1`]) {
        const p = this.pivots.get(n);
        // Collapsed when unlit: nothing drawn, the mesh stays for the shader compile.
        if (p)
          p.node.scale.set(
            ab > 0.01 ? r : 1e-3,
            ab > 0.01 ? r : 1e-3,
            ab > 0.01 ? 0.45 + 0.65 * ab : 1e-3,
          );
      }
    }
    // --- vapour -----------------------------------------------------------------------------
    const humid = Math.min(Math.max(1.1 - t.altitude / 7000, 0.15), 1);
    const v = vapour(fb?.alpha ?? t.alpha, fb?.g ?? t.loadFactor, humid);
    s.lex = lag(s.lex, t.onGround ? 0 : v.lex, dt, k(0.3));
    s.tip = lag(s.tip, t.onGround ? 0 : v.tip, dt, k(0.3));
    this.vapourGain.lex.value = s.lex;
    this.vapourGain.tip.value = s.tip;
    // --- cockpit -----------------------------------------------------------------------------
    const stick = this.pivots.get('Stick');
    if (stick) stick.node.quaternion.setFromAxisAngle(stick.axis, -c.pitch * 0.28);
    const roll = this.pivots.get('StickRoll');
    if (roll) roll.node.quaternion.setFromAxisAngle(roll.axis, c.roll * 0.3);
    this.slideBy('Pedals_R', c.yaw);
    this.slideBy('Pedals_L', -c.yaw);
    const powered = t.systems ? t.systems.busVolts > 18 : true;
    const flood = powered ? get('lightFlood', 0) : 0;
    const console_ = powered ? get('lightConsole', 0) : 0;
    const glow = cabinGlow(this.exposure, Math.max(flood, console_ * 0.35));
    for (const m of this.cabinMaterials) m.emissiveIntensity = glow;
    this.formation = powered ? get('lightFormation', 0) : 0;
    this.cockpit.update(
      dt,
      t,
      c,
      cockpit,
      this.altOffset,
      powered ? Math.max(get('lightConsole', 0), get('lightPanel', 0)) : (L.nav ? 1 : 0) * 0,
    );
  }
}
