import {
  type BufferGeometry,
  DynamicDrawUsage,
  type Frustum,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  type Material,
  type Matrix4,
  Mesh,
  Sphere,
  Vector3,
} from 'three/webgpu';
import type { ChunkUniforms } from './material';
import { STRIDE } from './protocol';
import { FORM_COUNT, type Form } from './species';

/** What the near set reads from a chunk. */
export interface NearSource {
  parts?: ReadonlyArray<{
    form: Form;
    data: Float32Array;
    count: number;
    ground: InstancedBufferAttribute;
    groundPrev: InstancedBufferAttribute;
    /** Only the cells of fully stored chunks have one; only they give near trees. */
    mid?: Mesh;
  }>;
  group: { matrix: Matrix4 };
  inverse: Matrix4;
  blend: number;
  draw: ChunkUniforms;
}

/**
 * The trees close to the camera, drawn with the full mesh. Rather than drawing whole cells with
 * the expensive mesh and discarding most trees in the shader, the few hundred to few thousand
 * trees within reach are copied into one buffer per form, already in render space with their
 * current ground height, and drawn in a single call each. Rebuilt when the camera has moved or
 * turned a little, or the trees under it changed.
 */
export class NearSet {
  readonly meshes: Mesh[] = [];
  private readonly buffers: InstancedInterleavedBuffer[] = [];
  private readonly counts: number[] = [];
  private readonly draw: ChunkUniforms = { blend: 1, undulation: 50, farFrom: 0 };
  private readonly lastPos = new Vector3(Infinity, 0, 0);
  private readonly lastDir = new Vector3();
  private readonly local = new Vector3();
  private readonly sphere = new Sphere();
  private overflowed = false;

  constructor(
    geometries: BufferGeometry[],
    materials: Material[],
    private readonly capacity: number,
  ) {
    for (let form = 0; form < FORM_COUNT; form++) {
      const base = geometries[form]!;
      const g = new InstancedBufferGeometry();
      g.setIndex(base.index);
      for (const name of ['position', 'normal', 'part', 'ao'])
        g.setAttribute(name, base.getAttribute(name));
      const inter = new InstancedInterleavedBuffer(new Float32Array(capacity * STRIDE), STRIDE);
      inter.setUsage(DynamicDrawUsage);
      g.setAttribute('iPos', new InterleavedBufferAttribute(inter, 4, 0));
      g.setAttribute('iShape', new InterleavedBufferAttribute(inter, 4, 4));
      g.setAttribute('iPhoto', new InterleavedBufferAttribute(inter, 4, 8));
      // Positions are baked with their ground height: these stay zero.
      const zero = new InstancedBufferAttribute(new Float32Array(capacity), 1);
      g.setAttribute('iGround', zero);
      g.setAttribute('iGroundPrev', zero);
      g.instanceCount = 0;
      const mesh = new Mesh(g, materials[form]!);
      mesh.name = `near ${form === 0 ? 'conifer' : 'broadleaf'}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.visible = false;
      mesh.userData.trees = this.draw;
      this.meshes.push(mesh);
      this.buffers.push(inter);
      this.counts.push(0);
    }
  }

  get bytes() {
    return this.capacity * (STRIDE + 1) * 4 * FORM_COUNT;
  }

  /**
   * @param cam camera position, render space
   * @param dir camera view direction
   * @param radius metres: trees within it may be drawn at the near level
   * @param dirty the trees changed (uploads, re-seating)
   */
  update(
    chunks: Iterable<NearSource>,
    cam: Vector3,
    dir: Vector3,
    frustum: Frustum,
    radius: number,
    dirty: boolean,
  ): { count: number; draws: number } {
    // Turning is cheap to cover with a margin on the frustum test; moving needs fresh distances.
    const moved = cam.distanceToSquared(this.lastPos) > 3 * 3 || dir.dot(this.lastDir) < 0.9995;
    if (dirty || moved) this.rebuild(chunks, cam, frustum, radius);
    if (moved || dirty) {
      this.lastPos.copy(cam);
      this.lastDir.copy(dir);
    }
    let count = 0;
    let draws = 0;
    for (let f = 0; f < FORM_COUNT; f++) {
      const n = this.counts[f]!;
      this.meshes[f]!.visible = n > 0;
      count += n;
      if (n > 0) draws++;
    }
    return { count, draws };
  }

  private rebuild(chunks: Iterable<NearSource>, cam: Vector3, frustum: Frustum, radius: number) {
    const counts = this.counts.fill(0);
    const r2 = radius * radius;
    let nearest = Infinity;
    for (const c of chunks) {
      if (!c.parts) continue;
      const local = this.local.copy(cam).applyMatrix4(c.inverse);
      const m = c.group.matrix.elements;
      for (const part of c.parts) {
        if (!part.mid) continue;
        const out = this.buffers[part.form]!.array as Float32Array;
        const g = part.ground.array as Float32Array;
        const gp = part.groundPrev.array as Float32Array;
        const d = part.data;
        for (let i = 0; i < part.count; i++) {
          const o = i * STRIDE;
          const x = d[o]!;
          const z = d[o + 2]!;
          const dx = x - local.x;
          const dz = z - local.z;
          if (dx * dx + dz * dz > r2) continue;
          const y = d[o + 1]! + gp[i]! + (g[i]! - gp[i]!) * c.blend;
          const dy = y - local.y;
          const dist2 = dx * dx + dy * dy + dz * dz;
          if (dist2 > r2) continue;
          // Render space: the chunk's frame turned into the render frame (a near chunk's
          // frame is level with the render frame to a few hundredths of a degree).
          const px = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
          const py = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
          const pz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
          const h = d[o + 4]!;
          this.sphere.center.set(px, py + h * 0.5, pz);
          // Margin: the set is kept while the camera turns a little.
          this.sphere.radius = h * 0.6 + 8 + Math.sqrt(dist2) * 0.06;
          if (!frustum.intersectsSphere(this.sphere)) continue;
          const n = counts[part.form]!;
          if (n >= this.capacity) {
            if (!this.overflowed) console.warn('trees: near set full');
            this.overflowed = true;
            continue;
          }
          const w = n * STRIDE;
          out.set(d.subarray(o, o + STRIDE), w);
          out[w] = px;
          out[w + 1] = py;
          out[w + 2] = pz;
          counts[part.form] = n + 1;
          if (dist2 < nearest) {
            nearest = dist2;
            this.draw.undulation = c.draw.undulation;
          }
        }
      }
    }
    for (let f = 0; f < FORM_COUNT; f++) {
      const inter = this.buffers[f]!;
      const n = counts[f]!;
      inter.clearUpdateRanges();
      inter.addUpdateRange(0, Math.max(1, n) * STRIDE);
      inter.needsUpdate = true;
      (this.meshes[f]!.geometry as InstancedBufferGeometry).instanceCount = n;
    }
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
  }
}
