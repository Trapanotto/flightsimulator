import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { CLOUD_GLSL } from '../terrain/terrainMaterial';
import type { AtmosphereUniforms } from './Atmosphere';

/** Vertical spacing of the stacked layers (fake thickness), metres. */
const LAYER_SPACING = 140;
const RADIUS = 90_000;
const EARTH_R = 6_371_000;

const vertexShader = /* glsl */ `
  uniform float uLayer;
  uniform float uLayers;
  varying vec3 vWorldPos;
  void main() {
    vec3 p = position;
    // Far away the stacked layers merge into one: seen at a grazing angle they would show as
    // offset copies (stripes). Near the camera they keep their spacing (thickness).
    float merge = smoothstep(1500.0, 9000.0, length(p.xy));
    p.z += ((uLayers - 1.0) * 0.5 - uLayer) * ${LAYER_SPACING.toFixed(1)} * merge;
    // Curve with the earth so the layer meets the horizon instead of running flat into space.
    p.z -= dot(p.xy, p.xy) / ${(2 * EARTH_R).toFixed(1)};
    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorldPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uHazeColor;
  uniform vec3 uHazeSunColor;
  uniform float uLayer;      // 0 = bottom layer
  uniform float uLayers;
  uniform float uCameraElevation;
  varying vec3 vWorldPos;
  ${CLOUD_GLSL}

  void main() {
    vec3 toFrag = vWorldPos - cameraPosition;
    float dist = length(toFrag);
    vec3 viewDir = toFrag / max(dist, 1.0);
    float d = cloudDensity(basePos(vWorldPos));
    // Middle layers are the dense core; outer layers only show the thick parts (rounded tops).
    float mid = (uLayers - 1.0) * 0.5;
    float shell = abs(uLayer - mid) / max(mid, 0.5);
    float a = smoothstep(0.15 + 0.45 * shell, 0.85, d);
    if (a < 0.01) discard;

    float layerAlt = uCloudAltitude + uLayer * ${LAYER_SPACING.toFixed(1)};
    bool below = uCameraElevation < layerAlt;
    // Light: sunlit tops, darker bases, a bright rim when looking towards the sun.
    float top = (uLayer + 1.0) / uLayers;
    vec3 lit = uSunColor * (0.9 + 0.7 * top) * (1.0 - 0.35 * d * d);
    vec3 ambient = mix(uHazeColor, vec3(0.75, 0.82, 0.95), 0.4) * 0.9;
    vec3 col = mix(ambient, lit, below ? 0.45 + 0.3 * top : 0.85);
    float rim = pow(max(dot(viewDir, uSunDir), 0.0), 10.0) * (1.0 - d);
    col += uSunColor * rim * 1.6;

    // Far clouds fade into the haze and finally out.
    float haze = 1.0 - exp(-dist / 70000.0);
    col = mix(col, mix(uHazeColor, uHazeSunColor, pow(max(dot(viewDir, uSunDir), 0.0), 14.0) * 0.8), haze);
    a *= (1.0 - smoothstep(55000.0, 88000.0, dist)) * (0.55 + 0.45 / uLayers * 2.0);
    gl_FragColor = vec4(col, min(a, 0.92));
  }
`;

const tmpQ = new Quaternion();
/** The discs are built in the XY plane; their normal is +Z. */
const Z = new Vector3(0, 0, 1);

/**
 * Cloud deck: a few stacked, earth-curved discs centred on the camera. Same noise as the
 * cloud shadows on the terrain, so clouds and their shadows always match.
 */
export class CloudLayer {
  readonly group = new Group();
  private readonly meshes: Mesh[] = [];

  constructor(
    private readonly atmosphere: AtmosphereUniforms,
    layers: number,
  ) {
    this.group.name = 'Clouds';
    this.setLayers(layers);
  }

  setLayers(n: number) {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as ShaderMaterial).dispose();
    }
    this.meshes.length = 0;
    const ringGeo = makeRadialDisc(RADIUS, 48, 96);
    for (let i = 0; i < n; i++) {
      const mat = new ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: { ...this.atmosphere, uLayer: { value: i }, uLayers: { value: n } },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
      const mesh = new Mesh(ringGeo, mat);
      mesh.frustumCulled = false;
      mesh.position.z = i * LAYER_SPACING;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    this.group.visible = n > 0;
  }

  /**
   * Places the deck over the camera. `cloudBase` is the render position of the point under/over
   * the camera at cloud altitude, `up` the local vertical there.
   */
  update(cloudBase: Vector3, up: Vector3, cameraElevation: number) {
    const u = this.atmosphere;
    this.group.visible = this.meshes.length > 0 && u.uCloudCoverage.value > 0.01;
    if (!this.group.visible) return;
    this.group.position.copy(cloudBase);
    // Discs are built in the XY plane; turn their +Z onto the local vertical.
    this.group.quaternion.copy(tmpQ.setFromUnitVectors(Z, up));
    // Draw order: farthest layer first, so blending works from above and below.
    const base = u.uCloudAltitude.value;
    this.meshes.forEach((m, i) => {
      const alt = base + i * LAYER_SPACING;
      m.renderOrder = 10 + (cameraElevation < alt ? this.meshes.length - i : i);
    });
  }
}

/** Disc in the XY plane with `rings` concentric rings (needed so vertices can bend). */
function makeRadialDisc(radius: number, rings: number, segments: number) {
  const positions: number[] = [0, 0, 0];
  const index: number[] = [];
  for (let r = 1; r <= rings; r++) {
    // Denser rings near the centre where the camera is.
    const rr = radius * (r / rings) ** 1.8;
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      positions.push(Math.cos(a) * rr, Math.sin(a) * rr, 0);
    }
  }
  for (let s = 0; s < segments; s++) index.push(0, 1 + s, 1 + ((s + 1) % segments));
  for (let r = 1; r < rings; r++) {
    const a0 = 1 + (r - 1) * segments;
    const a1 = 1 + r * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      index.push(a0 + s, a1 + s, a1 + s1, a0 + s, a1 + s1, a0 + s1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}
