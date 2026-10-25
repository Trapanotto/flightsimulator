import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  TorusGeometry,
  Vector3,
} from 'three';
import type { ChallengeRun } from './ChallengeRun';

// Slightly above 1 so the bloom pass catches them; much higher washes them out to white.
const NEXT = new Color(1.9, 0.42, 0.0);
const AFTER = new Color(1.1, 1.1, 1.1);
const LATER = new Color(0.9, 0.9, 0.9);
const FINISH = new Color(0.08, 1.3, 0.2);

/**
 * The rings of a challenge as glowing tori. The next ring is orange and pulses, the one after
 * it is white, later ones are faint, passed rings disappear; the last ring is green.
 */
export class RingLayer {
  readonly group = new Group();
  private readonly rings: Mesh<TorusGeometry, MeshBasicMaterial>[] = [];
  private readonly glows: Mesh<TorusGeometry, MeshBasicMaterial>[] = [];
  private t = 0;
  private readonly tmp = new Vector3();

  constructor(private readonly run: ChallengeRun) {
    const r = run.course.radius;
    const geo = new TorusGeometry(r, Math.max(1.6, r * 0.05), 12, 72);
    // A wider, faint halo makes far rings readable without a thicker solid ring.
    const halo = new TorusGeometry(r, r * 0.16, 8, 72);
    run.gates.forEach((g, i) => {
      const mat = new MeshBasicMaterial({ color: LATER, transparent: true, depthWrite: false });
      const ring = new Mesh(geo, mat);
      ring.renderOrder = 3;
      const glowMat = new MeshBasicMaterial({
        color: LATER,
        transparent: true,
        opacity: 0.18,
        blending: AdditiveBlending,
        depthWrite: false,
      });
      const glow = new Mesh(halo, glowMat);
      glow.renderOrder = 3;
      this.place(ring, g, run.normals[i]!);
      this.place(glow, g, run.normals[i]!);
      this.rings.push(ring);
      this.glows.push(glow);
      this.group.add(ring, glow);
    });
  }

  /** Torus lies in its XY plane; +Z must point along the ring normal. */
  private place(o: Object3D, at: Vector3, normal: Vector3) {
    o.position.copy(at);
    o.lookAt(this.tmp.copy(at).add(normal));
  }

  update(dt: number) {
    this.t += dt;
    const run = this.run;
    const last = run.gates.length - 1;
    const pulse = 1 + 0.06 * Math.sin(this.t * 6);
    this.rings.forEach((ring, i) => {
      const glow = this.glows[i]!;
      // Positions follow the floating origin (the run shifts them on rebase).
      ring.position.copy(run.gates[i]!);
      glow.position.copy(ring.position);
      const passed = i < run.next || run.finished;
      ring.visible = glow.visible = !passed;
      if (passed) return;
      const k = i - run.next;
      const color = i === last ? FINISH : k === 0 ? NEXT : k === 1 ? AFTER : LATER;
      ring.material.color.copy(color);
      glow.material.color.copy(color);
      ring.material.opacity = k === 0 ? 1 : k === 1 ? 0.85 : 0.45;
      glow.material.opacity = k === 0 ? 0.16 : k === 1 ? 0.07 : 0.03;
      const s = k === 0 ? pulse : 1;
      ring.scale.setScalar(s);
      glow.scale.setScalar(s);
    });
  }

  dispose() {
    this.group.removeFromParent();
    this.rings[0]?.geometry.dispose();
    this.glows[0]?.geometry.dispose();
    for (const m of [...this.rings, ...this.glows]) m.material.dispose();
  }
}
