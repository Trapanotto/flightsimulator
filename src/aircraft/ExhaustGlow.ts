import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  ConeGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
} from 'three';

/** Radial glow: white-hot centre fading to the edge. */
function glowTexture(): Texture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  grad.addColorStop(0.8, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Flame along the cone: bright at the nozzle, fading towards the tip. */
function flameTexture(): Texture {
  const w = 16;
  const h = 128;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  // Cone UV v = 1 at the tip = top of the canvas (transparent), 0 at the base (bright).
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

const DULL = new Color(0.55, 0.08, 0.02);
const HOT = new Color(3.2, 1.1, 0.25);
const AB_CORE = new Color(2.2, 2.4, 3.2);
const AB_OUTER = new Color(3.5, 1.4, 0.35);
const tmp = new Color();

/**
 * Hot jet exhaust at the nozzle: the nozzle glows dull red at idle, orange at full military
 * thrust; with afterburner a long flame (blue-white core, orange sheath) with shock diamonds,
 * flickering. Additive and brighter than white, so the bloom makes it glow. No light source
 * (adding one would make every material recompile). Nose is +Z: the exhaust points to -Z.
 */
export class ExhaustGlow {
  readonly group = new Group();
  private readonly disc: Mesh;
  private readonly discMat: MeshBasicMaterial;
  private readonly core: Mesh;
  private readonly outer: Mesh;
  private readonly coreMat: MeshBasicMaterial;
  private readonly outerMat: MeshBasicMaterial;
  private readonly diamonds: Mesh[] = [];
  private readonly diamondMat: MeshBasicMaterial;
  private ab = 0;
  private time = 0;

  constructor(
    position: [number, number, number],
    private readonly radius: number,
  ) {
    this.group.name = 'ExhaustGlow';
    this.group.position.set(...position);
    const additive = {
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    };
    this.discMat = new MeshBasicMaterial({ map: glowTexture(), ...additive, side: DoubleSide });
    // A shallow glowing dome just inside the nozzle exit, facing aft.
    this.disc = new Mesh(
      new SphereGeometry(radius, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      this.discMat,
    );
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.scale.set(1, 0.25, 1);
    const flame = flameTexture();
    this.coreMat = new MeshBasicMaterial({ map: flame, ...additive, side: DoubleSide });
    this.outerMat = new MeshBasicMaterial({ map: flame, ...additive, side: DoubleSide });
    // Cones of length 1 from the nozzle aft (-Z); the length is set by scale.z.
    const cone = (r: number) => {
      const geo = new ConeGeometry(r, 1, 24, 1, true);
      // Wide base at the nozzle (z = 0), tip at z = -1.
      geo.translate(0, 0.5, 0);
      geo.rotateX(-Math.PI / 2);
      return geo;
    };
    this.core = new Mesh(cone(radius * 0.55), this.coreMat);
    this.outer = new Mesh(cone(radius * 0.9), this.outerMat);
    this.diamondMat = new MeshBasicMaterial({ map: glowTexture(), ...additive });
    for (let i = 0; i < 4; i++) {
      const d = new Mesh(new SphereGeometry(radius * 0.32, 12, 8), this.diamondMat);
      d.scale.set(1, 1, 1.8);
      this.diamonds.push(d);
    }
    for (const m of [this.disc, this.core, this.outer, ...this.diamonds]) {
      m.renderOrder = 5;
      m.castShadow = false;
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  /** `power` = engine output 0..1, `boost` = afterburner lit. */
  update(dt: number, power: number, boost: boolean) {
    this.time += dt;
    this.ab += ((boost ? 1 : 0) - this.ab) * Math.min(1, dt * 6);
    const flicker = 1 + 0.08 * Math.sin(this.time * 61) * Math.sin(this.time * 23 + 1);
    // Nozzle: dull red at idle, orange-hot at full power, whiter with the afterburner.
    tmp
      .copy(DULL)
      .lerp(HOT, Math.min(1, power ** 1.5))
      .lerp(AB_CORE, this.ab * 0.4);
    this.discMat.color.copy(tmp).multiplyScalar(0.6 + 0.4 * power + this.ab * 0.8);
    // Flame: with the afterburner (a hint of heat at full military power).
    const len = this.radius * (0.6 * Math.max(0, power - 0.8) + this.ab * 11) * flicker;
    const show = len > this.radius * 0.1;
    this.core.visible = this.outer.visible = show;
    if (show) {
      this.core.scale.set(1, 1, len * 0.8);
      this.outer.scale.set(
        1 + 0.05 * Math.sin(this.time * 37),
        1 + 0.05 * Math.sin(this.time * 41),
        len,
      );
      this.coreMat.color.copy(AB_CORE).multiplyScalar((0.25 + this.ab) * flicker);
      this.outerMat.color.copy(AB_OUTER).multiplyScalar((0.15 + 0.6 * this.ab) * flicker);
    }
    // Shock diamonds: bright knots evenly spaced in the afterburner plume.
    this.diamonds.forEach((d, i) => {
      d.visible = this.ab > 0.3;
      d.position.set(0, 0, -this.radius * (1.6 + i * 2.1));
      this.diamondMat.color.copy(AB_CORE).multiplyScalar(this.ab * (1.2 - i * 0.22) * flicker);
    });
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        (o.material as MeshBasicMaterial).map?.dispose();
        (o.material as MeshBasicMaterial).dispose();
      }
    });
  }
}
