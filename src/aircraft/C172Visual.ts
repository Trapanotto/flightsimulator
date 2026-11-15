/**
 * Cessna 172S on screen: loads public/assets/aircraft/c172.glb (built by
 * tools/aircraft/build_c172.py), wires the materials only it has (dial faces, the attitude
 * card, the wet compass) and moves its parts from the telemetry; model.ts does the rest.
 *
 * Model frame: x left, y up, z forward, metres; origin = the centre of gravity (FS 41 in,
 * 1.041 m aft of the firewall face, on the centre line, 1.22 m above the ground on the gear).
 */
import {
  ClampToEdgeWrapping,
  type Material,
  type Mesh,
  MeshStandardNodeMaterial,
  RepeatWrapping,
} from 'three/webgpu';
import { texture, uniform, uv, vec2 } from 'three/tsl';
import type { Cockpit, ControlInput, Telemetry } from '@sim';
import type { AircraftVisual, AircraftVisualOptions } from './AircraftVisual';
import { C172Cockpit } from './c172Cockpit';
import { FACES, type FaceId } from './c172Parts';
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  TILE_PAD,
  drawCompassBand,
  drawDialAtlas,
  drawPitchCard,
  tileOf,
} from './dials';
import { AI_CARD_RADIUS, AI_CARD_RANGE, AI_PITCH_SCALE, lag } from './instruments';
import type { AircraftLights } from './lights';
import {
  AircraftModel,
  type LightLevels,
  type LightState,
  type ModelConfig,
  loadModelScene,
} from './model';
import { partName } from './meshUtil';

const DEG = Math.PI / 180;
/** Distances (m) at which the reduced models take over. */
export const LOD_DISTANCES = [0, 45, 170] as const;

const CONFIG: ModelConfig = {
  name: 'C172',
  lodDistances: LOD_DISTANCES,
  chaseDistance: 17,
  chaseHeight: 3.5,
  wheels: ['Wheel_N', 'Wheel_L', 'Wheel_R'],
  lamps: {
    Lamp_NavRed: 0xff1a0d,
    Lamp_NavGreen: 0x19ff6a,
    Lamp_NavWhite: 0xffffff,
    Lamp_Beacon: 0xff2208,
    Lamp_Strobe: 0xeef4ff,
    Lamp_Landing: 0xfff3dd,
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
    Landing: {
      color: 0xfff1d8,
      dir: [0, -0.05, 1],
      cone: [Math.cos(35 * DEG), Math.cos(12 * DEG)],
      screen: 0.12,
    },
    Taxi: {
      color: 0xfff1d8,
      dir: [0, -0.1, 1],
      cone: [Math.cos(45 * DEG), Math.cos(20 * DEG)],
      screen: 0.1,
    },
  },
  blades: ['PropBlades', 'PropBlades_lod1'],
  disc: { tip: 0.93, hub: 0.2 },
  landingLight: [2.9, 0.75, 0.3],
  noShadow: /Glass|PropDisc|Lens|Lamp|GaugeGlass/,
  noReceive: /PropDisc|Lamp/,
};

export async function loadC172(options: AircraftVisualOptions = {}): Promise<AircraftVisual> {
  const scene = await loadModelScene('c172.glb', options.url);
  return new C172(scene, options.quality ?? 'high', options);
}

class C172 extends AircraftModel {
  protected readonly cockpit: C172Cockpit;
  private readonly aiOffset = uniform(0);
  private faceMaterial!: Material;
  // Animation state of the exterior.
  private s = {
    steer: 0,
    wheel: 0,
    wheelSpin: 0,
  };

  constructor(
    scene: import('three/webgpu').Object3D,
    quality: 'high' | 'low',
    options: AircraftVisualOptions,
  ) {
    super(scene, quality, options, CONFIG);
    this.setupMaterials(quality);
    this.object.updateMatrixWorld(true);
    this.cockpit = new C172Cockpit({
      root: this.object,
      cockpit: this.lod0.getObjectByName('Cockpit')!,
      faceMaterial: this.faceMaterial,
      panelLight: this.panelLight,
      aiOffset: this.aiOffset,
      quality,
      canvasTexture: (c, a) => this.canvasTexture(c, a),
      track: (m) => this.track(m),
    });
    this.finishSetup();
  }

  private setupMaterials(quality: 'high' | 'low') {
    const tile = quality === 'low' ? 256 : 512;
    const atlas = this.canvasTexture(drawDialAtlas(tile));
    atlas.wrapS = atlas.wrapT = ClampToEdgeWrapping;
    const faceMat = new MeshStandardNodeMaterial({ map: atlas, roughness: 0.6, metalness: 0 });
    faceMat.name = 'GaugeFace';
    // A little self-light keeps the dials readable in the cabin's shadow; more at night with
    // the panel lights (switched with the position lights).
    faceMat.emissiveNode = texture(atlas, uv()).rgb.mul(this.panelLight);
    this.track(faceMat);
    this.faceMaterial = faceMat;

    const pitch = this.canvasTexture(drawPitchCard(quality === 'low' ? 256 : 512));
    const scaleV = (2 * AI_CARD_RADIUS) / AI_PITCH_SCALE / (2 * AI_CARD_RANGE);
    const aiMat = new MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
    const cardUv = vec2(
      uv().x,
      uv()
        .y.mul(scaleV)
        .add(0.5 - scaleV / 2)
        .add(this.aiOffset),
    );
    aiMat.colorNode = texture(pitch, cardUv);
    aiMat.emissiveNode = texture(pitch, cardUv).rgb.mul(this.panelLight);
    this.track(aiMat);

    const band = this.canvasTexture(drawCompassBand(quality === 'low' ? 512 : 1024));
    band.wrapS = RepeatWrapping;
    const compassMat = new MeshStandardNodeMaterial({ map: band, roughness: 0.5, metalness: 0 });
    this.track(compassMat);

    const faceTiles = new Set<FaceId>(FACES);
    // Dial faces get their own geometry before their UVs move into the atlas: the optimiser
    // may share one disc between dials of the same shape.
    this.object.traverse((o) => {
      if ((o as Mesh).isMesh && partName(o).startsWith('Face_'))
        (o as Mesh).geometry = (o as Mesh).geometry.clone();
    });
    this.wireMaterials((o, mat, owner) => {
      if (owner === 'AI_Pitch') o.material = aiMat;
      else if (owner === 'Face_COMPASS') o.material = compassMat;
      else if (mat.name === 'GaugeFace' && owner.startsWith('Face_')) {
        const id = owner.slice(5) as FaceId;
        if (faceTiles.has(id)) this.remapToTile(o, id);
        o.material = faceMat;
      } else return false;
      return true;
    });
  }

  private remapToTile(mesh: Mesh, id: FaceId) {
    const { col, row } = tileOf(id);
    const uvAttr = mesh.geometry.getAttribute('uv');
    if (!uvAttr) return;
    const s = 1 - 2 * TILE_PAD;
    for (let i = 0; i < uvAttr.count; i++) {
      const u = uvAttr.getX(i);
      const v = uvAttr.getY(i);
      uvAttr.setXY(i, (col + TILE_PAD + u * s) / ATLAS_COLS, (row + TILE_PAD + v * s) / ATLAS_ROWS);
    }
    uvAttr.needsUpdate = true;
  }

  protected lightLevels(L: LightState): LightLevels {
    const nav = L.nav ? 1 : 0;
    return {
      lamps: {
        Lamp_NavRed: 6 * nav,
        Lamp_NavGreen: 6 * nav,
        Lamp_NavWhite: 6 * nav,
        Lamp_Beacon: 12 * L.beaconFlash,
        Lamp_Strobe: 40 * L.strobeFlash,
        Lamp_Landing: L.landing || L.taxi ? 25 : 0,
      },
      glows: {
        Nav_L: 1.6 * nav,
        Nav_R: 1.6 * nav,
        Tail: 1.2 * nav,
        Beacon: 3 * L.beaconFlash,
        Strobe_L: 8 * L.strobeFlash,
        Strobe_R: 8 * L.strobeFlash,
        Landing: L.landing ? 4 : 0,
        Taxi: L.taxi ? 3 : 0,
      },
      spot: L.landing ? 60000 : L.taxi ? 25000 : 0,
    };
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
    const ail = this.pivots.get('Aileron_L')?.props ?? {};
    const up = Number(ail.upDeg ?? 20) * DEG;
    const down = Number(ail.downDeg ?? 15) * DEG;
    this.rotate('Aileron_L', a > 0 ? a * down : a * up);
    this.rotate('Aileron_R', a > 0 ? -a * up : -a * down);
    const e = t.elevator;
    this.rotate('Elevator', e > 0 ? e * 28 * DEG : e * 23 * DEG);
    const trim = c.pitchTrim;
    this.rotate('TrimTab', trim > 0 ? -trim * 19 * DEG : -trim * 22 * DEG);
    const r = t.rudder;
    this.rotate('Rudder', r > 0 ? r * 16.2 * DEG : r * 17.7 * DEG);
    // Flaps run out on tracks: mostly aft first, then they turn down (Fowler-like).
    const f = Math.min(Math.max(t.flaps, 0), 1);
    for (const n of ['Flap_L', 'Flap_R', 'Flap_L_lod1', 'Flap_R_lod1']) {
      const p = this.pivots.get(n);
      if (!p) continue;
      p.node.quaternion.setFromAxisAngle(p.axis, f * 30 * DEG);
      if (p.slide) p.node.position.copy(p.rest).addScaledVector(p.slide, Math.min(1, f * 1.6));
    }
    // --- gear ----------------------------------------------------------------------------
    const steerTarget = t.onGround ? Math.max(-1, Math.min(1, c.yaw)) * 10 * DEG : 0;
    s.steer = lag(s.steer, steerTarget, dt, k(0.15));
    this.rotate('NoseSteer', s.steer);
    if (t.onGround) s.wheelSpin = t.groundSpeed;
    else s.wheelSpin = lag(s.wheelSpin, 0, dt, 4);
    s.wheel += (s.wheelSpin * dt) / 0.2;
    s.wheel %= Math.PI * 2;
    this.rotate('Wheel_L', s.wheel * (0.2 / 0.215));
    this.rotate('Wheel_R', s.wheel * (0.2 / 0.215));
    this.rotate('Wheel_N', s.wheel * (0.2 / 0.18));
    // --- propeller -------------------------------------------------------------------------
    const rpm = t.engines[0]?.rpm ?? 0;
    this.spinPropeller(dt, rpm, ['Prop', 'Prop_lod1', 'Prop_lod2'], {
      from: 250,
      span: 650,
      bladesBelow: 500,
    });
    // --- cockpit controls -----------------------------------------------------------------
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
}
