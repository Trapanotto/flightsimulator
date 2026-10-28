import {
  type BufferGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  Quaternion,
  type Texture,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { AtmosphereUniforms } from '../render/Atmosphere';
import { createBuildingMaterial } from './buildingMaterial';

export const HOUSE_TYPES = [
  'farmhouse',
  'chalet',
  'valais',
  'engadin',
  'rustico',
  'ticino',
  'urban',
  'block',
  'hall',
  'shed',
] as const;
export type HouseType = (typeof HOUSE_TYPES)[number];
export const CHURCH_TYPES = ['spire', 'campanile'] as const;
export type ChurchType = (typeof CHURCH_TYPES)[number];

export const BUILDINGS_URL = `${import.meta.env.BASE_URL}assets/buildings/buildings.glb`;

/** One placed house: footprint centre (render coords), orientation, size in metres. */
export interface HouseInstance {
  type: HouseType;
  x: number;
  y: number;
  z: number;
  /** Rotation about the local vertical, radians (long side along local +x). */
  yaw: number;
  length: number;
  width: number;
  height: number;
  tint: Color;
  /** Texture variants (0..3) for the walls and the roof, see footprints.variantOf. */
  variant?: [number, number];
  /** Full orientation (local vertical + yaw); overrides `yaw` and the shared `up`. */
  q?: Quaternion;
}

export interface ChurchInstance {
  type: ChurchType;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Nave length in metres (uniform scale). */
  size: number;
  q?: Quaternion;
}

const m4 = new Matrix4();
const q = new Quaternion();
const qUp = new Quaternion();
const s = new Vector3();
const p = new Vector3();
const Y = new Vector3(0, 1, 0);
const tmpUp = new Vector3();

/** Loaded building geometry + material; creates instanced meshes for batches of houses. */
export class BuildingSet {
  private constructor(
    readonly bodies: Map<HouseType, BufferGeometry>,
    readonly roofs: Map<HouseType, BufferGeometry>,
    readonly churches: Map<ChurchType, BufferGeometry>,
    readonly material: Material,
  ) {}

  static async load(atmosphere?: AtmosphereUniforms): Promise<BuildingSet> {
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(BUILDINGS_URL);
    const geos = new Map<string, BufferGeometry>();
    let atlas: Texture | null = null;
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      // Name is on the mesh or on its parent pivot (see tools/optimize-aircraft.mjs).
      const name = o.name.replace(/_mesh$/, '') || o.parent?.name || '';
      const key =
        name.startsWith('Body_') || name.startsWith('Roof_') || name.startsWith('Church_')
          ? name
          : (o.parent?.name ?? '');
      const g = (o.geometry as BufferGeometry).clone();
      // Bake the node transform (the exporter may add one) into the geometry.
      g.applyMatrix4(o.matrixWorld);
      geos.set(key, g);
      atlas ??= (o.material as { map?: Texture }).map ?? null;
    });
    if (!atlas) throw new Error('buildings.glb: no atlas texture');
    const tex = atlas as Texture;
    tex.anisotropy = 4;
    const need = (k: string) => {
      const g = geos.get(k);
      if (!g) throw new Error(`buildings.glb: missing ${k}`);
      return g;
    };
    return new BuildingSet(
      new Map(HOUSE_TYPES.map((t) => [t, need(`Body_${t}`)])),
      new Map(HOUSE_TYPES.map((t) => [t, need(`Roof_${t}`)])),
      new Map(CHURCH_TYPES.map((t) => [t, need(`Church_${t}`)])),
      createBuildingMaterial(tex, atmosphere),
    );
  }

  /**
   * Instanced meshes for a list of houses (one body + one roof mesh per type).
   * `up` is the local vertical of the area (all houses of a tile share it).
   */
  createHouses(houses: HouseInstance[], up: Vector3): InstancedMesh[] {
    const out: InstancedMesh[] = [];
    qUp.setFromUnitVectors(Y, up);
    for (const type of HOUSE_TYPES) {
      const list = houses.filter((h) => h.type === type);
      if (!list.length) continue;
      for (const part of ['body', 'roof'] as const) {
        const geo = (part === 'body' ? this.bodies : this.roofs).get(type)!.clone();
        const tint = new Float32Array(list.length * 3);
        list.forEach((h, i) => {
          tint[i * 3] = h.tint.r;
          tint[i * 3 + 1] = h.tint.g;
          tint[i * 3 + 2] = h.tint.b;
        });
        geo.setAttribute('iTint', new InstancedBufferAttribute(tint, 3));
        const variant = new Float32Array(list.length * 2);
        list.forEach((h, i) => {
          variant[i * 2] = h.variant?.[0] ?? 0;
          variant[i * 2 + 1] = h.variant?.[1] ?? 0;
        });
        geo.setAttribute('iVar', new InstancedBufferAttribute(variant, 2));
        const mesh = new InstancedMesh(geo, this.material, list.length);
        list.forEach((h, i) => {
          if (h.q) q.copy(h.q);
          else q.setFromAxisAngle(Y, h.yaw).premultiply(qUp);
          p.set(h.x, h.y, h.z);
          if (part === 'body') s.set(h.length, h.height, h.width);
          else {
            // Roof sits on the walls: move up along the house's own vertical.
            p.add(tmpUp.copy(Y).applyQuaternion(q).multiplyScalar(h.height));
            s.set(h.length, h.width, h.width);
          }
          mesh.setMatrixAt(i, m4.compose(p, q, s));
        });
        mesh.computeBoundingSphere();
        mesh.name = `${part}_${type}`;
        out.push(mesh);
      }
    }
    return out;
  }

  createChurches(churches: ChurchInstance[], up: Vector3): InstancedMesh[] {
    const out: InstancedMesh[] = [];
    qUp.setFromUnitVectors(Y, up);
    for (const type of CHURCH_TYPES) {
      const list = churches.filter((c) => c.type === type);
      if (!list.length) continue;
      const geo = this.churches.get(type)!.clone();
      geo.setAttribute(
        'iTint',
        new InstancedBufferAttribute(new Float32Array(list.length * 3).fill(1), 3),
      );
      geo.setAttribute('iVar', new InstancedBufferAttribute(new Float32Array(list.length * 2), 2));
      const mesh = new InstancedMesh(geo, this.material, list.length);
      list.forEach((c, i) => {
        if (c.q) q.copy(c.q);
        else q.setFromAxisAngle(Y, c.yaw).premultiply(qUp);
        mesh.setMatrixAt(i, m4.compose(p.set(c.x, c.y, c.z), q, s.setScalar(c.size)));
      });
      mesh.computeBoundingSphere();
      out.push(mesh);
    }
    return out;
  }
}
