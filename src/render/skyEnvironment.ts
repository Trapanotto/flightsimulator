import { PMREMGenerator, Scene, type Texture, type WebGLRenderer } from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

/**
 * Reflections for aircraft: a pre-filtered copy of the current sky. Only aircraft materials
 * get it (scene.environment would also light the terrain and wash it out).
 */
export function makeSkyEnvironment(renderer: WebGLRenderer, sky: Sky): Texture {
  const copy = new Sky();
  copy.scale.setScalar(1000);
  const src = sky.material.uniforms;
  const dst = copy.material.uniforms;
  for (const k of Object.keys(src)) {
    const v = src[k]!.value;
    dst[k]!.value = v?.clone ? v.clone() : v;
  }
  const scene = new Scene();
  scene.add(copy);
  const pmrem = new PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0, 1, 2000).texture;
  pmrem.dispose();
  return tex;
}

/** The white paint washes out under full-strength sky reflections: tone them down. */
export function softenReflections(root: { traverse(cb: (o: unknown) => void): void }) {
  root.traverse((o) => {
    const m = (o as { material?: { envMapIntensity?: number; name?: string } }).material;
    if (m && m.envMapIntensity !== undefined && m.name !== 'Glass') m.envMapIntensity = 0.45;
  });
}
