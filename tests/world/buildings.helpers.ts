import {
  type MeshData,
  buildingOf,
  isGround,
  vertexPosition,
} from '../../src/world/buildings/mesh';

/** A tile mesh decoded back to metres, for checks that read it vertex by vertex. */
export function unpack(m: MeshData) {
  const positions = new Float32Array(m.vertexCount * 3);
  const building = new Uint32Array(m.vertexCount);
  const ground: boolean[] = [];
  const p = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < m.vertexCount; i++) {
    vertexPosition(m, i, p);
    positions[3 * i] = p.x;
    positions[3 * i + 1] = p.y;
    positions[3 * i + 2] = p.z;
    building[i] = buildingOf(m, i);
    ground.push(isGround(m, i));
  }
  return { positions, building, ground };
}
