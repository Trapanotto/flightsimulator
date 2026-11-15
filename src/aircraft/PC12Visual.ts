/**
 * Pilatus PC-12 NG on screen: loads public/assets/aircraft/pc12.glb (built by
 * tools/aircraft/build_pc12.py) and moves its parts from the telemetry; model.ts does what
 * every type shares, pc12Cockpit.ts the glass cockpit.
 *
 * What drives what (for checking the real aircraft against the demo's fakes):
 * - control surfaces: telemetry.aileron, elevator, rudder; the trimmable stabiliser:
 *   ControlInput.pitchTrim (or the cockpit's `trim`)
 * - flaps: telemetry.flaps (0..1 = 0..40 degrees, aft on the tracks first)
 * - gear: telemetry.gear (0 up .. 1 down) through gearSequence (pc12Parts.ts); strut
 *   compression from telemetry.onGround; wheels from telemetry.groundSpeed
 * - propeller: engines[0].propRpm (or rpm) turns it; the blade angle comes from running,
 *   starting, reversing, torque and telemetry.tas (bladeAngle in pc12Parts.ts)
 * - lights: telemetry.systems.lights, the cockpit's lightRecognition and lightIce, else the
 *   pilot's habits (autoLights); landing and taxi lights sit on the legs and are dark unless
 *   the gear is down
 *
 * Model frame: x left, y up, z forward, metres; origin = the centre of gravity (FS 5.95 m
 * behind the spinner tip, 1.78 m above the ground on the gear).
 */
import type { Object3D } from 'three/webgpu';
import type { Cockpit, ControlInput, Telemetry } from '@sim';
import type { AircraftVisual, AircraftVisualOptions } from './AircraftVisual';
import { lag } from './instruments';
import type { AircraftLights } from './lights';
import {
  AircraftModel,
  type LightLevels,
  type LightState,
  type ModelConfig,
  loadModelScene,
} from './model';
import { PC12Cockpit } from './pc12Cockpit';
import { BLADE, bladeAngle, gearLights, gearSequence } from './pc12Parts';

const DEG = Math.PI / 180;

const CONFIG: ModelConfig = {
  name: 'PC12',
  lodDistances: [0, 70, 260],
  chaseDistance: 27,
  chaseHeight: 5.5,
  wheels: ['Wheel_N', 'Wheel_L', 'Wheel_R'],
  lamps: {
    Lamp_NavRed: 0xff1a0d,
    Lamp_NavGreen: 0x19ff6a,
    Lamp_NavWhite: 0xffffff,
    Lamp_Beacon: 0xff2208,
    Lamp_Strobe: 0xeef4ff,
    Lamp_Landing: 0xfff3dd,
    Lamp_Taxi: 0xfff3dd,
    Lamp_Recog: 0xf4f6ff,
    Lamp_Ice: 0xf4f6ff,
  },
  glows: {
    Nav_L: {
      color: 0xff2010,
      dir: [Math.sin(55 * DEG), 0, Math.cos(55 * DEG)],
      cone: [Math.cos(70 * DEG), Math.cos(52 * DEG)],
      screen: 0.045,
    },
    Nav_R: {
      color: 0x20ff70,
      dir: [-Math.sin(55 * DEG), 0, Math.cos(55 * DEG)],
      cone: [Math.cos(70 * DEG), Math.cos(52 * DEG)],
      screen: 0.045,
    },
    Tail: {
      color: 0xffffff,
      dir: [0, 0, -1],
      cone: [Math.cos(80 * DEG), Math.cos(66 * DEG)],
      screen: 0.04,
    },
    Beacon: { color: 0xff2a10, screen: 0.07 },
    Strobe_L: { color: 0xe8f0ff, screen: 0.12 },
    Strobe_R: { color: 0xe8f0ff, screen: 0.12 },
    Recog_L: {
      color: 0xf4f6ff,
      dir: [0, 0, 1],
      cone: [Math.cos(40 * DEG), Math.cos(15 * DEG)],
      screen: 0.07,
    },
    Recog_R: {
      color: 0xf4f6ff,
      dir: [0, 0, 1],
      cone: [Math.cos(40 * DEG), Math.cos(15 * DEG)],
      screen: 0.07,
    },
    Landing_L: {
      color: 0xfff1d8,
      dir: [0, -0.05, 1],
      cone: [Math.cos(35 * DEG), Math.cos(12 * DEG)],
      screen: 0.12,
      follow: true,
    },
    Landing_R: {
      color: 0xfff1d8,
      dir: [0, -0.05, 1],
      cone: [Math.cos(35 * DEG), Math.cos(12 * DEG)],
      screen: 0.12,
      follow: true,
    },
    Taxi: {
      color: 0xfff1d8,
      dir: [0, -0.12, 1],
      cone: [Math.cos(45 * DEG), Math.cos(20 * DEG)],
      screen: 0.1,
      follow: true,
    },
    Ice: {
      color: 0xf4f6ff,
      dir: [0.85, -0.2, -0.45],
      cone: [Math.cos(50 * DEG), Math.cos(25 * DEG)],
      screen: 0.05,
    },
  },
  blades: [0, 1, 2, 3, 4].flatMap((i) => [`PropBlades_${i}`, `PropBlades_${i}_lod1`]),
  disc: { tip: 0.95, hub: 0.19 },
  landingLight: [2.06, -0.8, -0.1],
  lowNearest: true,
  lowTextureMax: { map: 1024, other: 512 },
  noShadow: /Glass|PropDisc|Lens|Lamp|GaugeGlass|Display|Labels/,
  noReceive: /PropDisc|Lamp/,
};

export async function loadPC12(options: AircraftVisualOptions = {}): Promise<AircraftVisual> {
  const scene = await loadModelScene('pc12.glb', options.url);
  return new PC12(scene, options.quality ?? 'high', options);
}

class PC12 extends AircraftModel {
  protected readonly cockpit: PC12Cockpit;
  private s = {
    steer: 0,
    wheel: 0,
    wheelSpin: 0,
    blade: BLADE.feather as number,
    arm: 0,
    oleo: 0,
  };

  constructor(scene: Object3D, quality: 'high' | 'low', options: AircraftVisualOptions) {
    super(scene, quality, options, CONFIG);
    this.wireMaterials();
    this.object.updateMatrixWorld(true);
    this.cockpit = new PC12Cockpit({
      root: this.object,
      cockpit: this.lod0.getObjectByName('Cockpit')!,
      panelLight: this.panelLight,
      quality,
      canvasTexture: (c, a) => this.canvasTexture(c, a),
      track: (m) => this.track(m),
    });
    this.finishSetup();
  }

  /** Recognition and ice lights are switched in the cockpit; the systems do not report them yet. */
  protected override lightSwitches(t: Telemetry, cockpit?: Cockpit): AircraftLights {
    const L = super.lightSwitches(t, cockpit);
    const powered = !t.systems || t.systems.busVolts > 18;
    if (cockpit?.has('lightRecognition'))
      L.recognition ??= powered && cockpit.get('lightRecognition') >= 0.5;
    if (cockpit?.has('lightIce')) L.ice ??= powered && cockpit.get('lightIce') >= 0.5;
    L.recognition ??= L.landing;
    return L;
  }

  protected lightLevels(L: LightState, t: Telemetry): LightLevels {
    const nav = L.nav ? 1 : 0;
    // The lamps on the legs only shine with the gear down (they face into the well when up).
    const down = gearLights(t.gear).down ? 1 : 0;
    const landing = L.landing ? down : 0;
    const taxi = L.taxi ? down : 0;
    const recog = L.recognition ? 1 : 0;
    const ice = L.ice ? 1 : 0;
    return {
      lamps: {
        Lamp_NavRed: 6 * nav,
        Lamp_NavGreen: 6 * nav,
        Lamp_NavWhite: 6 * nav,
        Lamp_Beacon: 12 * L.beaconFlash,
        Lamp_Strobe: 40 * L.strobeFlash,
        Lamp_Landing: 25 * landing,
        Lamp_Taxi: 25 * taxi,
        Lamp_Recog: 20 * recog,
        Lamp_Ice: 15 * ice,
      },
      glows: {
        Nav_L: 1.6 * nav,
        Nav_R: 1.6 * nav,
        Tail: 1.2 * nav,
        Beacon: 3 * L.beaconFlash,
        Strobe_L: 8 * L.strobeFlash,
        Strobe_R: 8 * L.strobeFlash,
        Recog_L: 2.5 * recog,
        Recog_R: 2.5 * recog,
        Landing_L: 4 * landing,
        Landing_R: 4 * landing,
        Taxi: 3 * taxi,
        Ice: 1.5 * ice,
      },
      spot: landing ? 70000 : taxi ? 28000 : 0,
    };
  }

  private deg(name: string, key: string, fallback: number): number {
    return Number(this.pivots.get(name)?.props[key] ?? fallback) * DEG;
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
    // --- flight controls ---------------------------------------------------------------
    const a = t.aileron;
    const up = this.deg('Aileron_L', 'upDeg', 22);
    const down = this.deg('Aileron_L', 'downDeg', 16);
    this.rotate('Aileron_L', a > 0 ? a * down : a * up);
    this.rotate('Aileron_R', a > 0 ? -a * up : -a * down);
    const e = t.elevator;
    this.rotate(
      'Elevator',
      e > 0 ? e * this.deg('Elevator', 'upDeg', 25) : e * this.deg('Elevator', 'downDeg', 18),
    );
    const trim = cockpit?.has('trim') ? cockpit.get('trim') : c.pitchTrim;
    this.rotate(
      'Stabilizer',
      trim > 0
        ? trim * this.deg('Stabilizer', 'downDeg', 6)
        : trim * this.deg('Stabilizer', 'upDeg', 2),
    );
    this.rotate('Rudder', t.rudder * this.deg('Rudder', 'rightDeg', 25));
    // Fowler flaps: mostly aft on the tracks first, then they turn down.
    const f = Math.min(Math.max(t.flaps, 0), 1);
    for (const side of ['L', 'R']) {
      this.rotate(`Flap_${side}`, f * this.deg(`Flap_${side}`, 'maxDeg', 40));
      this.slideBy(`Flap_${side}`, Math.min(1, f * 1.5));
    }
    // --- gear ----------------------------------------------------------------------------
    const g = gearSequence(t.gear);
    for (const side of ['L', 'R']) {
      const name = `MainGear_${side}`;
      const angle = (1 - g.main) * this.deg(name, 'retractDeg', 90);
      this.rotate(name, angle);
      this.rotateLod2(name, angle);
      this.rotate(`MainDoor_${side}`, g.mainDoors * this.deg(`MainDoor_${side}`, 'openDeg', 88));
      this.rotate(`NoseDoor_${side}`, g.noseDoors * this.deg(`NoseDoor_${side}`, 'openDeg', 85));
    }
    const noseAngle = (1 - g.nose) * this.deg('NoseGear', 'retractDeg', 92);
    this.rotate('NoseGear', noseAngle);
    this.rotateLod2('NoseGear', noseAngle);
    // Struts: compressed standing on the wheels, hanging free in the air.
    s.arm = lag(s.arm, t.onGround ? 0 : 1, dt, k(0.12));
    for (const side of ['L', 'R'])
      this.rotate(`MainArm_${side}`, -s.arm * this.deg(`MainArm_${side}`, 'strokeDeg', 12));
    this.slideBy('NoseOleo', s.arm);
    const steerTarget = t.onGround ? Math.max(-1, Math.min(1, c.yaw)) * 14 * DEG : 0;
    s.steer = lag(s.steer, steerTarget, dt, k(0.15));
    this.rotate('NoseSteer', s.steer);
    // Wheels roll on the ground, spin down in the air, and stop once the gear moves (brakes).
    if (t.onGround) s.wheelSpin = t.groundSpeed;
    else s.wheelSpin = lag(s.wheelSpin, 0, dt, t.gear < 0.98 ? 0.4 : 5);
    s.wheel = (s.wheel + (s.wheelSpin * dt) / 0.3) % (Math.PI * 2);
    this.rotate('Wheel_L', s.wheel * (0.3 / 0.325));
    this.rotate('Wheel_R', s.wheel * (0.3 / 0.325));
    this.rotate('Wheel_N', s.wheel * (0.3 / 0.225));
    // --- propeller -------------------------------------------------------------------------
    const eng = t.engines[0];
    const rpm = eng?.propRpm ?? eng?.rpm ?? 0;
    this.spinPropeller(dt, rpm, ['Prop', 'Prop_lod1', 'Prop_lod2'], {
      from: 300,
      span: 700,
      bladesBelow: 520,
    });
    const target = bladeAngle(eng, t.tas);
    // Feathering and unfeathering take seconds; the governor's changes are quicker.
    const tau = Math.abs(target - s.blade) > 30 ? 2.2 : 0.5;
    s.blade = lag(s.blade, target, dt, k(tau));
    for (let i = 0; i < 5; i++) {
      const name = `Blade_${i}`;
      this.rotate(name, (s.blade - Number(this.pivots.get(name)?.props.buildDeg ?? 20)) * DEG);
    }
    // --- cockpit -----------------------------------------------------------------------------
    for (const side of ['L', 'R']) {
      this.slideBy(`Yoke_${side}`, c.pitch);
      const p = this.pivots.get(`YokeRoll_${side}`);
      if (p) p.node.quaternion.setFromAxisAngle(p.axis, c.roll * 40 * DEG);
    }
    this.slideBy('Pedals_R', c.yaw);
    this.slideBy('Pedals_L', -c.yaw);
    this.cockpit.update(
      dt,
      t,
      c,
      cockpit,
      this.altOffset,
      t.systems?.panelLight ?? (L.nav ? 1 : 0),
    );
  }

  /** The gear legs of the farthest level move too (they are kept as their own nodes). */
  private rotateLod2(name: string, angle: number) {
    const p = this.pivots.get(`${name}_lod2`);
    if (p) p.node.quaternion.setFromAxisAngle(p.axis, angle);
  }
}
