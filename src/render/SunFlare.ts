import { type PerspectiveCamera, Vector3 } from 'three';

const GHOSTS = [
  { at: 0.45, size: 60, color: 'rgba(255,190,120,0.18)' },
  { at: 0.8, size: 26, color: 'rgba(160,220,255,0.22)' },
  { at: 1.25, size: 110, color: 'rgba(255,150,90,0.08)' },
  { at: 1.6, size: 40, color: 'rgba(170,255,200,0.14)' },
];

/**
 * Sun glare and lens ghosts as a DOM overlay (no GPU cost). Visibility comes from the caller
 * (terrain/cloud occlusion test) and fades smoothly.
 */
export class SunFlare {
  readonly el: HTMLElement;
  private readonly glow: HTMLElement;
  private readonly ghosts: HTMLElement[];
  private visible = 0;
  enabled = true;
  private readonly v = new Vector3();

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'sun-flare';
    this.el.setAttribute('aria-hidden', 'true');
    this.glow = document.createElement('div');
    this.glow.className = 'sun-glow';
    this.el.appendChild(this.glow);
    this.ghosts = GHOSTS.map((g) => {
      const e = document.createElement('div');
      e.className = 'sun-ghost';
      e.style.width = e.style.height = `${g.size}px`;
      e.style.background = `radial-gradient(circle, ${g.color} 0%, transparent 70%)`;
      this.el.appendChild(e);
      return e;
    });
    parent.appendChild(this.el);
  }

  dispose() {
    this.el.remove();
  }

  /** `occlusion` 0 = sun fully visible, 1 = hidden. */
  update(dt: number, camera: PerspectiveCamera, sunDir: Vector3, occlusion: number) {
    const p = this.v.copy(camera.position).addScaledVector(sunDir, 10_000).project(camera);
    const inView = this.enabled && p.z < 1 && Math.abs(p.x) < 1.3 && Math.abs(p.y) < 1.3;
    const target = inView ? 1 - occlusion : 0;
    this.visible += (target - this.visible) * Math.min(1, dt * 6);
    if (this.visible < 0.01) {
      this.el.style.opacity = '0';
      return;
    }
    const w = innerWidth;
    const h = innerHeight;
    const sx = ((p.x + 1) / 2) * w;
    const sy = ((1 - p.y) / 2) * h;
    // Stronger when the sun is near the centre of the view.
    const centre = 1 - Math.min(1, Math.hypot(p.x, p.y) / 1.4);
    this.el.style.opacity = String(this.visible * (0.55 + 0.45 * centre));
    this.glow.style.transform = `translate(${sx}px, ${sy}px)`;
    this.ghosts.forEach((g, i) => {
      const t = GHOSTS[i]!.at;
      const gx = sx + (w / 2 - sx) * t * 2;
      const gy = sy + (h / 2 - sy) * t * 2;
      g.style.transform = `translate(${gx}px, ${gy}px)`;
    });
  }
}
