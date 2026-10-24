import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  type Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';

const POINTS = 90;
/** Wing tips in model coordinates (left +X, right -X). */
const TIPS = [new Vector3(4.6, 0.06, -0.45), new Vector3(-4.6, 0.06, -0.45)];
const WIDTH = 0.22;

const material = () =>
  new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float alpha;
      varying float vAlpha;
      void main() {
        vAlpha = alpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() { gl_FragColor = vec4(vec3(0.9, 0.93, 1.0) * vAlpha, vAlpha); }`,
  });

interface Ribbon {
  pts: Vector3[];
  life: number[];
  geo: BufferGeometry;
}

/**
 * Wing-tip vortex trails: thin ribbons that appear at high load factor or high angle of attack
 * and fade out over ~1.5 s. Positions are in render coordinates (rebased with the world).
 */
export class WingTrails {
  readonly group = new Group();
  enabled = true;
  private readonly ribbons: Ribbon[] = [];
  private readonly side = new Vector3();
  private readonly tmp = new Vector3();

  constructor() {
    for (let i = 0; i < TIPS.length; i++) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(POINTS * 2 * 3), 3));
      geo.setAttribute('alpha', new BufferAttribute(new Float32Array(POINTS * 2), 1));
      const index: number[] = [];
      for (let k = 0; k < POINTS - 1; k++) {
        const a = k * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      geo.setIndex(index);
      const mesh = new Mesh(geo, material());
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.ribbons.push({ pts: [], life: [], geo });
    }
  }

  rebase(delta: Vector3) {
    for (const r of this.ribbons) for (const p of r.pts) p.sub(delta);
  }

  /** `intensity` 0..1 from load factor / angle of attack; up = aircraft up axis. */
  update(dt: number, position: Vector3, quaternion: Quaternion, up: Vector3, intensity: number) {
    const k = this.enabled ? intensity : 0;
    this.ribbons.forEach((r, i) => {
      for (let j = 0; j < r.life.length; j++) r.life[j]! -= dt / 1.5;
      if (k > 0.02) {
        r.pts.unshift(this.tmp.copy(TIPS[i]!).applyQuaternion(quaternion).add(position).clone());
        r.life.unshift(k);
      }
      while (r.pts.length > POINTS || (r.life.length && r.life[r.life.length - 1]! <= 0)) {
        r.pts.pop();
        r.life.pop();
      }
      const pos = r.geo.getAttribute('position') as BufferAttribute;
      const alpha = r.geo.getAttribute('alpha') as BufferAttribute;
      this.side.copy(up).multiplyScalar(WIDTH / 2);
      for (let j = 0; j < POINTS; j++) {
        const p = r.pts[Math.min(j, r.pts.length - 1)];
        const a = j < r.pts.length ? Math.max(0, r.life[j]!) * 0.45 * (1 - j / POINTS) : 0;
        if (p) {
          pos.setXYZ(j * 2, p.x + this.side.x, p.y + this.side.y, p.z + this.side.z);
          pos.setXYZ(j * 2 + 1, p.x - this.side.x, p.y - this.side.y, p.z - this.side.z);
        }
        alpha.setX(j * 2, a);
        alpha.setX(j * 2 + 1, a);
      }
      pos.needsUpdate = true;
      alpha.needsUpdate = true;
      r.geo.setDrawRange(0, Math.max(0, r.pts.length - 1) * 6);
    });
  }
}
