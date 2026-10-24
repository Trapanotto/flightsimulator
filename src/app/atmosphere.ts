import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

export interface Atmosphere {
  sky: Sky;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
}

function sunDirection(elevationDeg: number, azimuthDeg: number) {
  const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
  const theta = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
}

export function createAtmosphere(
  scene: THREE.Scene,
  elevationDeg = 28,
  azimuthDeg = 262,
): Atmosphere {
  const sky = new Sky();
  sky.scale.setScalar(380_000);
  sky.name = 'sky';
  scene.add(sky);

  const uniforms = sky.material.uniforms;
  uniforms.turbidity.value = 2.8;
  uniforms.rayleigh.value = 1.0;
  uniforms.mieCoefficient.value = 0.0022;
  uniforms.mieDirectionalG.value = 0.8;

  const direction = sunDirection(elevationDeg, azimuthDeg);
  uniforms.sunPosition.value.copy(direction);

  const hemi = new THREE.HemisphereLight(0xd6e8ff, 0x4b5a43, 2.5);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1d8, 1.5);
  sun.position.copy(direction).multiplyScalar(30_000);
  sun.target.position.set(0, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  scene.fog = new THREE.FogExp2(0xa9c0d2, 0.0000075);
  scene.background = new THREE.Color(0x9cb8cf);

  return { sky, sun, hemi };
}

/** Updates the sun for a new elevation/azimuth pair (used by time controls). */
export function updateAtmosphere(
  atmosphere: Atmosphere,
  elevationDeg: number,
  azimuthDeg: number,
) {
  const direction = sunDirection(elevationDeg, azimuthDeg);
  atmosphere.sky.material.uniforms.sunPosition.value.copy(direction);
  atmosphere.sun.position.copy(direction).multiplyScalar(30_000);
}
