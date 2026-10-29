import {
  AdditiveBlending,
  DoubleSide,
  Group,
  LOD,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
  type Texture,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { type CockpitData, CockpitDisplays } from './CockpitDisplays';
import type { AircraftType } from './types';

/** Control inputs, all normalised. */
export interface AircraftControls {
  /** -1 left .. 1 right roll */
  aileron: number;
  /** -1 nose down .. 1 nose up */
  elevator: number;
  /** -1 left .. 1 right yaw */
  rudder: number;
  /** 0 .. 1 */
  flaps: number;
  /** 0 retracted .. 1 down */
  gear: number;
  /** propeller speed 0 .. 1 */
  rpm: number;
  /** thrust lever 0 .. 1 */
  throttle: number;
}

const DEG = Math.PI / 180;
/** Max deflections. Positive rotation is about each part's local X (hinge) axis. */
const LIMITS = { aileron: 20 * DEG, elevator: 25 * DEG, rudder: 25 * DEG, flaps: 35 * DEG };
const GEAR_FOLD = { main: 88 * DEG, nose: 95 * DEG };
/** LOD switch distances for a 10 m aircraft (concept ch. 10.3); scaled with the length. */
const LOD_DISTANCES = [0, 25, 180];
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Z = new Vector3(0, 0, 1);
const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const tmpV = new Vector3();

/** Cockpit controls: how far they move at full input. */
const COCKPIT = {
  yokeRoll: 75 * DEG,
  yokeTravel: 0.07,
  columnPitch: 11 * DEG,
  stick: 15 * DEG,
  throttleIdle: -18 * DEG,
  throttleRange: 42 * DEG,
  knobTravel: 0.06,
};

/** A cockpit part moved by position and rotation from its rest pose (pivots are axis-aligned). */
class Rest {
  readonly pos: Vector3;
  readonly quat: Quaternion;
  constructor(readonly node: Object3D) {
    this.pos = node.position.clone();
    this.quat = node.quaternion.clone();
  }
}

/** A moving part: its rest orientation from the file plus a rotation about one local axis. */
class Joint {
  private readonly rest: Quaternion;
  /**
   * For horizontal surfaces: +1 if a positive angle moves the trailing edge down.
   * Hinge axes point outboard, so the sign differs between the left (+X) and right (-X) side.
   */
  readonly downSign: number;
  /** For main gear: +1 if a positive angle swings the wheel towards the centre line. */
  readonly inwardSign: number;

  constructor(
    readonly node: Object3D,
    private readonly axis = AXIS_X,
  ) {
    this.rest = node.quaternion.clone();
    const worldAxis = axis.clone().applyQuaternion(node.getWorldQuaternion(new Quaternion()));
    const worldPos = node.getWorldPosition(new Vector3());
    // Right-hand rule: rotating about +X lifts points behind the hinge (-Z in glTF, nose is +Z).
    this.downSign = worldAxis.x > 0 ? -1 : 1;
    // Rotating about +Z by a positive angle swings a wheel below the pivot towards +X.
    this.inwardSign = Math.sign(worldPos.x) * (worldAxis.z > 0 ? -1 : 1);
  }

  set(angle: number) {
    this.node.quaternion.copy(this.rest).multiply(tmpQ.setFromAxisAngle(this.axis, angle));
  }

  /** Positive = trailing edge down. */
  setDown(angle: number) {
    this.set(angle * this.downSign);
  }
}

interface Parts {
  aileronL: Joint[];
  aileronR: Joint[];
  elevator: Joint[];
  rudder: Joint[];
  flaps: Joint[];
  gearMain: Joint[];
  gearNose: Joint[];
  props: Joint[];
  discs: Mesh[];
  yokes: Rest[];
  sticks: Rest[];
  throttles: Rest[];
  knobs: Rest[];
  /** 747: column and wheel per side, matched by side letter. */
  columns: Map<string, Rest>;
  wheels: Map<string, Rest>;
}

/**
 * One aircraft of the fleet: loads <type>.glb (three levels of detail) and animates control
 * surfaces, gear, propellers and fans. Nose points to +Z, up is +Y.
 */
export class Aircraft {
  readonly root = new Group();
  readonly lod = new LOD();
  readonly controls: AircraftControls = {
    aileron: 0,
    elevator: 0,
    rudder: 0,
    flaps: 0,
    gear: 1,
    rpm: 0,
    throttle: 0,
  };
  /** Live instruments; created when the model has display surfaces. */
  displays?: CockpitDisplays;
  private readonly parts: Parts = {
    aileronL: [],
    aileronR: [],
    elevator: [],
    rudder: [],
    flaps: [],
    gearMain: [],
    gearNose: [],
    props: [],
    discs: [],
    yokes: [],
    sticks: [],
    throttles: [],
    knobs: [],
    columns: new Map(),
    wheels: new Map(),
  };
  private propAngle = 0;
  private gearPos = 1;
  private flapPos = 0;
  triangles: number[] = [];

  constructor(readonly type: AircraftType) {}

  static async load(type: AircraftType, envMap?: Texture): Promise<Aircraft> {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(type.url);
    const a = new Aircraft(type);
    a.setup(gltf.scene, envMap);
    return a;
  }

  private setup(scene: Object3D, envMap?: Texture) {
    this.root.name = this.type.id;
    scene.updateMatrixWorld(true);
    this.root.add(this.lod);
    const k = Math.max(1, this.type.length / 10);
    for (let level = 0; level < 3; level++) {
      const node = scene.getObjectByName(`AC_LOD${level}`);
      if (!node) throw new Error(`${this.type.id}.glb: missing AC_LOD${level}`);
      let tris = 0;
      node.traverse((o) => {
        if (o instanceof Mesh) {
          tris +=
            (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position!.count) / 3;
          this.prepareMesh(o, envMap);
        }
        this.register(o);
      });
      this.triangles.push(Math.round(tris));
      this.lod.addLevel(node, LOD_DISTANCES[level]! * k);
    }
    const displays = new CockpitDisplays(this.lod, this.type.id);
    if (displays.count > 0) this.displays = displays;
  }

  /** Redraws the cockpit displays (only worth it while the pilot can see them). */
  updateDisplays(dt: number, data: CockpitData) {
    this.displays?.update(dt, data);
  }

  private readonly glass: MeshPhysicalMaterial[] = [];
  private cockpitView = false;

  /**
   * From inside, the windshield is seen at a grazing angle: with its sky reflection it would
   * veil the whole view. In the cockpit it is nearly invisible, like real cockpit glass.
   */
  setCockpitView(inside: boolean) {
    if (inside === this.cockpitView) return;
    this.cockpitView = inside;
    for (const g of this.glass) {
      g.opacity = inside ? 0.035 : 0.16;
      g.envMapIntensity = inside ? 0 : 0.8;
      g.clearcoat = inside ? 0 : 1;
      g.needsUpdate = true;
    }
  }

  /** Material fixes the glTF format cannot express well. */
  private prepareMesh(mesh: Mesh, envMap?: Texture) {
    const mat = mesh.material as MeshStandardMaterial;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (mat.name === 'Glass') {
      const glass = new MeshPhysicalMaterial({
        name: 'Glass',
        color: 0x8fa3b8,
        roughness: 0.03,
        metalness: 0,
        transparent: true,
        // Clear enough to fly from the cockpit, still visibly glass from outside.
        opacity: 0.16,
        envMap,
        envMapIntensity: 0.8,
        clearcoat: 1,
        side: DoubleSide,
        depthWrite: false,
      });
      mesh.material = glass;
      this.glass.push(glass);
      mesh.castShadow = false;
      mesh.renderOrder = 2;
    } else if (mat.name === 'PropDisc') {
      mesh.material = new MeshStandardMaterial({
        name: 'PropDisc',
        color: 0x222222,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
      });
      mesh.castShadow = false;
      mesh.visible = false;
    } else if (envMap) {
      mat.envMap = envMap;
    }
  }

  private register(o: Object3D) {
    // Pivot nodes are named <Part>_LOD<n>; their geometry sits in a <Part>_LOD<n>_mesh child.
    // Only the pivot moves: the children would otherwise turn a second time on top of it.
    if (!/_LOD\d$/.test(o.name)) return;
    const name = o.name.replace(/_LOD\d$/, '');
    const p = this.parts;
    if (name === 'Aileron_L') p.aileronL.push(new Joint(o));
    else if (name === 'Aileron_R') p.aileronR.push(new Joint(o));
    else if (name.startsWith('Elevator_')) p.elevator.push(new Joint(o));
    else if (name.startsWith('Rudder')) p.rudder.push(new Joint(o));
    else if (name.startsWith('Flap_')) p.flaps.push(new Joint(o));
    else if (name === 'Gear_N') p.gearNose.push(new Joint(o));
    else if (name.startsWith('Gear_')) p.gearMain.push(new Joint(o));
    else if (name.startsWith('Propeller') || name.startsWith('Fan'))
      p.props.push(new Joint(o, AXIS_Z));
    else if (name.startsWith('PropDisc')) o.traverse((m) => m instanceof Mesh && p.discs.push(m));
    else if (name.startsWith('Yoke_')) p.yokes.push(new Rest(o));
    else if (name.startsWith('Stick_')) p.sticks.push(new Rest(o));
    else if (name.startsWith('Throttle_')) p.throttles.push(new Rest(o));
    else if (name === 'Knob_Throttle') p.knobs.push(new Rest(o));
    // Columns and wheels exist per LOD level: key by side and level.
    else if (/^Column_[LR]_LOD\d$/.test(o.name)) p.columns.set(o.name.slice(7), new Rest(o));
    else if (/^Wheel_[LR]_LOD\d$/.test(o.name)) p.wheels.set(o.name.slice(6), new Rest(o));
  }

  update(dt: number) {
    const c = this.controls;
    const p = this.parts;
    // Gear and flaps move at a real-ish speed instead of snapping.
    this.gearPos +=
      Math.sign(c.gear - this.gearPos) * Math.min(Math.abs(c.gear - this.gearPos), dt / 4);
    this.flapPos +=
      Math.sign(c.flaps - this.flapPos) * Math.min(Math.abs(c.flaps - this.flapPos), dt / 2.5);

    // Roll right: right aileron up, left aileron down. Nose up: elevator trailing edge up.
    for (const j of p.aileronR) j.setDown(-c.aileron * LIMITS.aileron);
    for (const j of p.aileronL) j.setDown(c.aileron * LIMITS.aileron);
    for (const j of p.elevator) j.setDown(-c.elevator * LIMITS.elevator);
    // Rudder hinge points up: a positive angle swings the trailing edge to the right (-X).
    for (const j of p.rudder) j.set(c.rudder * LIMITS.rudder);
    for (const j of p.flaps) j.setDown(this.flapPos * LIMITS.flaps);
    if (this.type.physics.fixedGear) this.gearPos = 1;
    const fold = 1 - this.gearPos;
    // There are no gear wells: once folded away the gear is hidden so wheels never poke through.
    const stowed = this.gearPos < 0.02;
    for (const j of p.gearMain) {
      j.set(j.inwardSign * fold * GEAR_FOLD.main);
      j.node.visible = !stowed;
    }
    for (const j of p.gearNose) {
      j.set(fold * GEAR_FOLD.nose);
      j.node.visible = !stowed;
    }

    const maxRadS = 2 * Math.PI * this.type.engine.maxRps;
    this.propAngle = (this.propAngle + c.rpm * maxRadS * dt) % (Math.PI * 2);
    // Above ~40 % rpm the blades blur into a disc.
    const blur = Math.min(1, Math.max(0, (c.rpm - 0.4) / 0.4));
    for (const j of p.props) {
      j.set(this.propAngle);
      j.node.visible = blur < 0.95;
    }
    for (const d of p.discs) {
      d.visible = blur > 0;
      (d.material as MeshStandardMaterial).opacity = 0.35 * blur;
    }
    this.updateCockpit();
  }

  /**
   * Yokes, side sticks, columns and thrust levers follow the inputs. Model axes: x = left,
   * y = up, z = forward; pulling (nose up) moves the controls aft (-z), rolling right moves the
   * top of a stick / wheel to the right (-x), i.e. a positive turn about +z.
   */
  private updateCockpit() {
    const c = this.controls;
    const p = this.parts;
    const K = COCKPIT;
    for (const r of p.yokes) {
      r.node.position.copy(r.pos).add(tmpV.set(0, 0, -c.elevator * K.yokeTravel));
      r.node.quaternion
        .copy(r.quat)
        .multiply(tmpQ.setFromAxisAngle(AXIS_Z, c.aileron * K.yokeRoll));
    }
    for (const r of p.sticks) {
      tmpQ.setFromAxisAngle(AXIS_X, -c.elevator * K.stick);
      tmpQ2.setFromAxisAngle(AXIS_Z, c.aileron * K.stick);
      r.node.quaternion.copy(r.quat).multiply(tmpQ).multiply(tmpQ2);
    }
    const lever = K.throttleIdle + c.throttle * K.throttleRange;
    for (const r of p.throttles)
      r.node.quaternion.copy(r.quat).multiply(tmpQ.setFromAxisAngle(AXIS_X, lever));
    for (const r of p.knobs)
      r.node.position.copy(r.pos).add(tmpV.set(0, 0, c.throttle * K.knobTravel));
    for (const [key, col] of p.columns) {
      tmpQ.setFromAxisAngle(AXIS_X, -c.elevator * K.columnPitch);
      col.node.quaternion.copy(col.quat).multiply(tmpQ);
      const wheel = p.wheels.get(key);
      if (!wheel) continue;
      // The wheel rides on top of the column: swing its rest offset with the column.
      tmpV.copy(wheel.pos).sub(col.pos).applyQuaternion(tmpQ);
      wheel.node.position.copy(col.pos).add(tmpV);
      tmpQ2.setFromAxisAngle(AXIS_Z, c.aileron * K.yokeRoll);
      wheel.node.quaternion.copy(wheel.quat).premultiply(tmpQ).multiply(tmpQ2);
    }
  }

  /** Current LOD index for the debug display. */
  get level(): number {
    return this.lod.getCurrentLevel();
  }
}
