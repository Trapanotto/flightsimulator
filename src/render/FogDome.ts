import { BackSide, Mesh, ShaderMaterial, SphereGeometry, type Vector3 } from 'three';
import type { AtmosphereUniforms } from './Atmosphere';
import { AERIAL_GLSL } from './aerial';

const RADIUS = 30_000;

/**
 * The fog layer seen against the sky: from below or inside it a grey ceiling instead of blue
 * sky, from above nothing (the sea of fog itself is drawn on the terrain by aerial()). A sphere
 * around the camera; each pixel measures how much of its ray runs through the fog layer.
 */
export class FogDome {
  readonly mesh: Mesh;

  constructor(private readonly atmosphere: AtmosphereUniforms) {
    const material = new ShaderMaterial({
      uniforms: { ...atmosphere },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec3 vWorld;
        ${AERIAL_GLSL}
        void main() {
          #include <logdepthbuf_fragment>
          vec3 toFrag = vWorld - cameraPosition;
          float dist = length(toFrag);
          vec3 dir = toFrag / dist;
          float tTop;
          float len = fogPath(uCameraElevation, elevationOf(vWorld), dist, tTop);
          float amt = 1.0 - exp(-len * uFogDensity);
          // Underside: grey, a little brighter towards the sun and overhead.
          float glow = pow(max(dot(dir, uSunDir), 0.0), 6.0) * 0.25 + max(dot(dir, uUp), 0.0) * 0.12;
          vec3 col = uFogColor * vec3(0.62, 0.64, 0.68) * (0.9 + glow);
          if (tTop >= 0.0) col = fogTopColor(cameraPosition + toFrag * tTop);
          gl_FragColor = vec4(col, amt);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: BackSide,
    });
    this.mesh = new Mesh(new SphereGeometry(RADIUS, 48, 24), material);
    this.mesh.name = 'FogDome';
    this.mesh.frustumCulled = false;
    // After the sky and the cloud layers, before nothing else that is transparent and far.
    this.mesh.renderOrder = 5;
  }

  update(cameraPosition: Vector3) {
    this.mesh.visible = this.atmosphere.uFogDensity.value > 0;
    this.mesh.position.copy(cameraPosition);
  }
}
