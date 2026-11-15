/**
 * Airbus A320-214 on screen: loads public/assets/aircraft/a320.glb (built by
 * tools/aircraft/build_a320.py) and moves its parts from the telemetry; model.ts does what
 * every type shares, A320Cockpit.ts the flight deck.
 *
 * What drives what (for checking the real aircraft against the demo's fakes):
 * - ailerons, elevators, rudder: telemetry.aileron, elevator, rudder; the trimmable
 *   stabiliser: telemetry.stabiliser (else the cockpit's `trim`)
 * - slats and flaps: avionics.a320.slats/flaps when reported, else telemetry.flaps through
 *   highLift (a320Parts.ts); the flaps run aft on their tracks as they turn down
 * - spoilers: telemetry.speedbrake and telemetry.aileron through spoilerPose (ground
 *   spoilers on the ground, speed brake panels 2-4, roll spoilers 2-5)
 * - gear: telemetry.gear through gearSequence (doors open, legs move, doors close); oleos
 *   from telemetry.onGround; wheels from telemetry.groundSpeed; nose wheel steering from
 *   ControlInput.yaw on the ground (the tillers turn with it)
 * - fans: engines[i].n1 (else rpm); blades blur into a disc at speed; reverser doors open with
 *   engines[i].reversing
 * - lights: the overhead's switches (beacon, strobe OFF/AUTO/ON, nav and logo, landing, nose
 *   OFF/TAXI/T.O., runway turn-off, wing), else telemetry.systems.lights or the pilot's
 *   habits; the nose-gear lamps only shine with the gear down
 * - sidesticks: ControlInput.pitch and roll; pedals: yaw
 *
 * Model frame: x left, y up, z forward, metres; origin = the centre of gravity at 25 % MAC
 * (FS 16.17 m behind the nose, 3.20 m above the ground on the gear).
 */
import { type Object3D } from 'three/webgpu';
import type { Cockpit, ControlInput, Telemetry } from '@sim';
import type { AircraftVisual, AircraftVisualOptions } from './AircraftVisual';
import { A320Cockpit } from './A320Cockpit';
import { readA320 } from './a320Format';
import { fanBlur, fanRpm, gearLights, gearSequence, highLift, spoilerPose } from './a320Parts';
import { lag } from './instruments';
import { type AircraftLights } from './lights';
import {
  AircraftModel,
  type LightLevels,
  type LightState,
  type ModelConfig,
  loadModelScene,
} from './model';

const DEG = Math.PI / 180;
const cone = (outer: number, inner: number): [number, number] => [
  Math.cos(outer * DEG),
  Math.cos(inner * DEG),
];

const CONFIG: ModelConfig = {
  name: 'A320',
  lodDistances: [0, 150, 520],
  chaseDistance: 62,
  chaseHeight: 13,
  wheels: ['Wheel_N', 'Wheel_L', 'Wheel_R'],
  lamps: {
    Lamp_NavRed: 0xff1a0d,
    Lamp_NavGreen: 0x19ff6a,
    Lamp_NavWhite: 0xffffff,
    Lamp_Beacon: 0xff2208,
    Lamp_Strobe: 0xeef4ff,
    Lamp_Landing: 0xfff3dd,
    Lamp_Taxi: 0xfff3dd,
    Lamp_Takeoff: 0xfff3dd,
    Lamp_Turnoff: 0xfff3dd,
    Lamp_Wing: 0xf4f6ff,
    Lamp_Logo: 0xf4f6ff,
  },
  glows: {
    Nav_L: {
      color: 0xff2010,
      dir: [Math.sin(55 * DEG), 0, Math.cos(55 * DEG)],
      cone: cone(72, 52),
      screen: 0.035,
    },
    Nav_R: {
      color: 0x20ff70,
      dir: [-Math.sin(55 * DEG), 0, Math.cos(55 * DEG)],
      cone: cone(72, 52),
      screen: 0.035,
    },
    Tail: { color: 0xffffff, dir: [0, 0, -1], cone: cone(80, 66), screen: 0.03 },
    Strobe_L: { color: 0xe8f0ff, screen: 0.1 },
    Strobe_R: { color: 0xe8f0ff, screen: 0.1 },
    Strobe_Tail: { color: 0xe8f0ff, screen: 0.08 },
    Beacon_Top: { color: 0xff2a10, screen: 0.06 },
    Beacon_Bottom: { color: 0xff2a10, screen: 0.06 },
    Landing_L: { color: 0xfff1d8, dir: [0, -0.1, 1], cone: cone(35, 12), screen: 0.1 },
    Landing_R: { color: 0xfff1d8, dir: [0, -0.1, 1], cone: cone(35, 12), screen: 0.1 },
    Wing_L: { color: 0xf4f6ff, dir: [0.85, -0.25, -0.45], cone: cone(50, 25), screen: 0.04 },
    Wing_R: { color: 0xf4f6ff, dir: [-0.85, -0.25, -0.45], cone: cone(50, 25), screen: 0.04 },
    Logo_L: { color: 0xf4f6ff, dir: [-0.6, 0.6, -0.5], cone: cone(70, 40), screen: 0.04 },
    Logo_R: { color: 0xf4f6ff, dir: [0.6, 0.6, -0.5], cone: cone(70, 40), screen: 0.04 },
    Taxi: { color: 0xfff1d8, dir: [0, -0.12, 1], cone: cone(45, 20), screen: 0.08, follow: true },
    Takeoff: {
      color: 0xfff1d8,
      dir: [0, -0.05, 1],
      cone: cone(35, 12),
      screen: 0.09,
      follow: true,
    },
    Turnoff_L: {
      color: 0xfff1d8,
      dir: [0.7, -0.1, 0.7],
      cone: cone(45, 20),
      screen: 0.06,
      follow: true,
    },
    Turnoff_R: {
      color: 0xfff1d8,
      dir: [-0.7, -0.1, 0.7],
      cone: cone(45, 20),
      screen: 0.06,
      follow: true,
    },
  },
  blades: [],
  disc: { tip: 0.97, hub: 0.36 },
  landingLight: [3.4, -0.9, 2.0],
  lowNearest: true,
  lowTextureMax: { map: 1024, other: 512 },
  noShadow: /Glass|PropDisc|Lens|Lamp|Display|Labels|PanelWindows/,
  noReceive: /PropDisc|Lamp/,
};

export async function loadA320(options: AircraftVisualOptions = {}): Promise<AircraftVisual> {
  const scene = await loadModelScene('a320.glb', options.url);
  return new A320(scene, options.quality ?? 'high', options);
}

/** The lights the A320 has beyond the shared set, from the overhead's switches. */
interface ExtraLights {
  takeoff: boolean;
  turnoff: boolean;
  wing: boolean;
  logo: boolean;
}

class A320 extends AircraftModel {
  protected readonly cockpit: A320Cockpit;
  private xl: ExtraLights = { takeoff: false, turnoff: false, wing: false, logo: false };
  private readonly fanBlades: Object3D[][] = [[], []];
  private s = {
    steer: 0,
    wheel: 0,
    wheelSpin: 0,
    arm: 0,
    fan: [0, 0],
    rev: [0, 0],
    slats: 0,
    flaps: 0,
    spoilers: [0, 0, 0, 0, 0, 0],
  };

  constructor(scene: Object3D, quality: 'high' | 'low', options: AircraftVisualOptions) {
    super(scene, quality, options, CONFIG);
    this.wireMaterials();
    this.object.updateMatrixWorld(true);
    this.cockpit = new A320Cockpit({
      root: this.object,
      cockpit: this.lod0.getObjectByName('Cockpit')!,
      panelLight: this.panelLight,
      quality,
      canvasTexture: (c, a) => this.canvasTexture(c, a),
      track: (m) => this.track(m),
    });
    this.finishSetup();
    ['L', 'R'].forEach((s, i) => {
      for (const n of [`FanBlades_${s}`, `FanBlades_${s}_lod1`]) {
        const b = this.object.getObjectByName(n);
        if (b) this.fanBlades[i]!.push(b);
      }
    });
  }

  protected override lightSwitches(t: Telemetry, cockpit?: Cockpit): AircraftLights {
    const L = super.lightSwitches(t, cockpit);
    const powered = !t.systems || t.systems.busVolts > 20;
    const has = (id: string) => !!cockpit?.has(id);
    const get = (id: string) => cockpit!.get(id);
    if (has('lightNav')) {
      // The switches decide, where the systems do not report the lights yet.
      if (!t.systems?.lights) {
        L.nav = powered && get('lightNav') >= 0.5;
        L.beacon = powered && get('lightBeacon') >= 0.5;
        const strobe = Math.round(get('lightStrobe'));
        L.strobe = powered && (strobe === 2 || (strobe === 1 && !t.onGround));
        L.landing = powered && get('lightLanding') >= 0.5;
        L.taxi = powered && get('lightNose') >= 1;
      }
      this.xl = {
        takeoff: powered && Math.round(get('lightNose')) === 2,
        turnoff: powered && get('lightRunwayTurnoff') >= 0.5,
        wing: powered && get('lightWing') >= 0.5,
        logo: powered && get('lightNav') >= 0.5 && (t.onGround || t.flaps > 0.1),
      };
    } else {
      this.xl = { takeoff: L.landing, turnoff: L.taxi, wing: false, logo: L.nav && t.onGround };
    }
    return L;
  }

  protected lightLevels(L: LightState, t: Telemetry): LightLevels {
    const nav = L.nav ? 1 : 0;
    const down = gearLights(t.gear).down ? 1 : 0;
    const landing = L.landing ? 1 : 0;
    const taxi = L.taxi ? down : 0;
    const takeoff = this.xl.takeoff ? down : 0;
    const turnoff = this.xl.turnoff ? down : 0;
    const wing = this.xl.wing ? 1 : 0;
    const logo = this.xl.logo ? 1 : 0;
    return {
      lamps: {
        Lamp_NavRed: 6 * nav,
        Lamp_NavGreen: 6 * nav,
        Lamp_NavWhite: 6 * nav,
        Lamp_Beacon: 12 * L.beaconFlash,
        Lamp_Strobe: 40 * L.strobeFlash,
        Lamp_Landing: 25 * landing,
        Lamp_Taxi: 25 * taxi,
        Lamp_Takeoff: 25 * takeoff,
        Lamp_Turnoff: 25 * turnoff,
        Lamp_Wing: 15 * wing,
        Lamp_Logo: 15 * logo,
      },
      glows: {
        Nav_L: 1.6 * nav,
        Nav_R: 1.6 * nav,
        Tail: 1.2 * nav,
        Strobe_L: 8 * L.strobeFlash,
        Strobe_R: 8 * L.strobeFlash,
        Strobe_Tail: 6 * L.strobeFlash,
        Beacon_Top: 3 * L.beaconFlash,
        Beacon_Bottom: 3 * L.beaconFlash,
        Landing_L: 4 * landing,
        Landing_R: 4 * landing,
        Wing_L: 1.5 * wing,
        Wing_R: 1.5 * wing,
        Logo_L: 1.2 * logo,
        Logo_R: 1.2 * logo,
        Taxi: 3 * taxi,
        Takeoff: 3.5 * takeoff,
        Turnoff_L: 2.5 * turnoff,
        Turnoff_R: 2.5 * turnoff,
      },
      spot: landing ? 120000 : takeoff ? 70000 : taxi ? 30000 : 0,
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
    const up = this.deg('Aileron_L', 'upDeg', 25);
    const down = this.deg('Aileron_L', 'downDeg', 20);
    this.rotate('Aileron_L', a > 0 ? a * down : a * up);
    this.rotate('Aileron_R', a > 0 ? -a * up : -a * down);
    const e = t.elevator;
    for (const side of ['L', 'R'])
      this.rotate(
        `Elevator_${side}`,
        e > 0 ? e * this.deg('Elevator_L', 'upDeg', 30) : e * this.deg('Elevator_L', 'downDeg', 17),
      );
    const trim = cockpit?.has('trim') ? cockpit.get('trim') : c.pitchTrim;
    const ths = t.stabiliser ?? (trim > 0 ? trim * 13.5 * DEG : trim * 4 * DEG);
    this.rotate('Stabilizer', ths);
    this.rotate('Rudder', t.rudder * this.deg('Rudder', 'rightDeg', 30));
    // --- slats, flaps, spoilers ------------------------------------------------------------
    const a3 = readA320(t.avionics);
    const hl =
      a3.slats !== undefined && a3.flaps !== undefined
        ? { slats: a3.slats, flaps: a3.flaps }
        : highLift(
            cockpit?.has('flaps') ? cockpit.get('flaps') : Math.round(c.flaps * 4),
            t.flaps,
            t.ias / 0.514444,
          );
    s.slats = this.follow(s.slats, hl.slats, dt, 0.25);
    s.flaps = this.follow(s.flaps, hl.flaps, dt, 0.25);
    for (const side of ['L', 'R']) {
      this.rotate(`Slat_In_${side}`, s.slats * DEG);
      this.rotate(`Slat_Out_${side}`, s.slats * DEG);
      for (const f of ['FlapIn', 'FlapOut']) {
        // Fowler flaps: mostly aft on the tracks first, then they turn down.
        this.rotate(`${f}_${side}`, s.flaps * DEG);
        this.slideBy(`${f}_${side}`, Math.min(1, s.flaps / 22));
      }
    }
    const sp = spoilerPose(
      a3.groundSpoilers ? 1 : (t.speedbrake ?? 0),
      a,
      t.onGround || !!a3.groundSpoilers,
    );
    const target = [...sp.left, ...sp.right];
    ['L', 'R'].forEach((side, w) => {
      ['Spoiler1', 'Spoiler234', 'Spoiler5'].forEach((name, i) => {
        const j = w * 3 + i;
        s.spoilers[j] = this.follow(s.spoilers[j]!, target[j]!, dt, 0.12);
        this.rotate(`${name}_${side}`, s.spoilers[j]! * DEG);
      });
    });
    // --- gear ------------------------------------------------------------------------------
    const g = gearSequence(t.gear);
    for (const side of ['L', 'R']) {
      const name = `MainGear_${side}`;
      const angle = (1 - g.main) * this.deg(name, 'retractDeg', 90);
      this.rotate(name, angle);
      this.rotateLod2(name, angle);
      this.rotate(`MainDoor_${side}`, g.mainDoors * this.deg(`MainDoor_${side}`, 'openDeg', 85));
      this.rotate(`NoseDoor_${side}`, g.noseDoors * this.deg(`NoseDoor_${side}`, 'openDeg', 88));
    }
    const noseAngle = (1 - g.nose) * this.deg('NoseGear', 'retractDeg', 95);
    this.rotate('NoseGear', noseAngle);
    this.rotateLod2('NoseGear', noseAngle);
    s.arm = lag(s.arm, t.onGround ? 0 : 1, dt, k(0.25));
    for (const n of ['MainOleo_L', 'MainOleo_R', 'NoseOleo']) this.slideBy(n, s.arm);
    // Nose wheel steering: the tiller's +-75 degrees at taxi speeds, the pedals' 6 above.
    const fast = Math.min(1, Math.max(0, (t.groundSpeed - 10) / 30));
    const steerTarget = t.onGround
      ? Math.max(-1, Math.min(1, c.yaw)) * (40 * (1 - fast) + 6 * fast) * DEG
      : 0;
    s.steer = lag(s.steer, steerTarget, dt, k(0.2));
    this.rotate('NoseSteer', s.steer);
    if (t.onGround) s.wheelSpin = t.groundSpeed;
    else s.wheelSpin = lag(s.wheelSpin, 0, dt, t.gear < 0.98 ? 0.6 : 6);
    s.wheel = (s.wheel + (s.wheelSpin * dt) / 0.585) % (Math.PI * 2);
    this.rotate('Wheel_L', s.wheel);
    this.rotate('Wheel_R', s.wheel);
    this.rotate('Wheel_N', s.wheel * (0.585 / 0.38));
    // --- engines ---------------------------------------------------------------------------
    let disc = 0;
    ['L', 'R'].forEach((side, i) => {
      const eng = t.engines[i] ?? t.engines[0];
      const rpm = fanRpm(eng);
      s.fan[i] = (s.fan[i]! + (rpm / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
      this.rotate(`Fan_${side}`, s.fan[i]!);
      const blur = fanBlur(rpm);
      disc = Math.max(disc, blur.disc);
      for (const b of this.fanBlades[i]!) b.visible = blur.blades;
      s.rev[i] = this.follow(s.rev[i]!, eng?.reversing ? 1 : 0, dt, 0.6);
      for (let d = 0; d < 4; d++) {
        const n = `RevDoor_${side}${d}`;
        this.rotate(n, s.rev[i]! * this.deg(n, 'openDeg', 38));
      }
    });
    this.discOpacity.value = disc * (this.inside ? 0.5 : 0.85);
    // --- cockpit -----------------------------------------------------------------------------
    for (const side of ['L', 'R']) {
      this.turnCockpit(`Sidestick_${side}`, -c.pitch * 16 * DEG);
      this.turnCockpit(`SidestickRoll_${side}`, c.roll * 20 * DEG);
      this.turnCockpit(`Tiller_${side}`, -s.steer * 1.2);
    }
    this.slideBy('Pedals_R', c.yaw);
    this.slideBy('Pedals_L', -c.yaw);
    this.cockpit.update(
      dt,
      t,
      c,
      cockpit,
      this.altOffset,
      t.systems?.panelLight ??
        (cockpit?.has('lightPanel') ? cockpit.get('lightPanel') : L.nav ? 1 : 0),
    );
  }

  private turnCockpit(name: string, angle: number) {
    const p = this.pivots.get(name);
    if (p) p.node.quaternion.setFromAxisAngle(p.axis, angle);
  }

  /** The gear legs of the farthest level move too (they are kept as their own nodes). */
  private rotateLod2(name: string, angle: number) {
    const p = this.pivots.get(`${name}_lod2`);
    if (p) p.node.quaternion.setFromAxisAngle(p.axis, angle);
  }
}
