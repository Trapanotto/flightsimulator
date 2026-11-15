/**
 * Small geometry helpers the loaders share: the optimiser quantises attributes and hangs a
 * part's mesh below its named node, so moving and merging needs plain float copies.
 */
import {
  BufferAttribute,
  BufferGeometry,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
} from 'three/webgpu';

export function findMesh(node: Object3D): Mesh | undefined {
  if (node instanceof Mesh) return node;
  let found: Mesh | undefined;
  node.traverse((o) => {
    if (!found && o instanceof Mesh) found = o;
  });
  return found;
}

/** The named node a mesh belongs to (the optimiser moves meshes into `<name>_geo` children). */
export function partName(o: Object3D): string {
  if (o.name.endsWith('_geo') && o.parent) return o.parent.name;
  return o.name;
}

/** A copy with plain float attributes (the optimiser quantises them), so it can be moved and merged. */
export function toFloat(g: BufferGeometry): BufferGeometry {
  const out = new BufferGeometry();
  for (const name of ['position', 'normal', 'uv'] as const) {
    const a = g.getAttribute(name);
    if (!a) continue;
    const n = a.itemSize;
    const arr = new Float32Array(a.count * n);
    for (let i = 0; i < a.count; i++) {
      arr[i * n] = a.getX(i);
      if (n > 1) arr[i * n + 1] = a.getY(i);
      if (n > 2) arr[i * n + 2] = a.getZ(i);
    }
    out.setAttribute(name, new BufferAttribute(arr, n));
  }
  if (g.index) out.setIndex(g.index.clone());
  return out;
}

export function concat(parts: BufferGeometry[]): BufferGeometry {
  const out = new BufferGeometry();
  for (const name of ['position', 'normal', 'uv'] as const) {
    if (!parts.every((p) => p.getAttribute(name))) continue;
    const n = parts[0]!.getAttribute(name).itemSize;
    const total = parts.reduce((s, p) => s + p.getAttribute(name).count, 0);
    const arr = new Float32Array(total * n);
    let off = 0;
    for (const p of parts) {
      const a = p.getAttribute(name).array as Float32Array;
      arr.set(a, off);
      off += a.length;
    }
    out.setAttribute(name, new BufferAttribute(arr, n));
  }
  out.computeBoundingSphere();
  return out;
}

/** Joins meshes into one under `parent` (one draw call) and removes the originals. */
export function mergeMeshes(
  meshes: Mesh[],
  material: Material,
  name: string,
  parent: Object3D,
): Mesh | undefined {
  if (!meshes.length) return undefined;
  parent.updateMatrixWorld(true);
  const inv = new Matrix4().copy(parent.matrixWorld).invert();
  const parts = meshes.map((m) => {
    const g = toFloat(m.geometry.index ? m.geometry.toNonIndexed() : m.geometry);
    g.applyMatrix4(new Matrix4().multiplyMatrices(inv, m.matrixWorld));
    return g;
  });
  const merged = concat(parts);
  const mesh = new Mesh(merged, material);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  parent.add(mesh);
  for (const m of meshes) m.removeFromParent();
  return mesh;
}

/** Remaps a mesh's 0..1 UVs into a rectangle of an atlas (u0, v0 top left; flipY off). */
export function remapUv(mesh: Mesh, r: { u0: number; v0: number; u1: number; v1: number }): void {
  const g = toFloat(mesh.geometry);
  const a = g.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < a.count; i++)
    a.setXY(i, r.u0 + a.getX(i) * (r.u1 - r.u0), r.v0 + a.getY(i) * (r.v1 - r.v0));
  mesh.geometry = g;
}
