import {
  DataTexture,
  DoubleSide,
  FrontSide,
  Mesh,
  MeshStandardNodeMaterial,
  NearestFilter,
  RedFormat,
  UnsignedByteType,
  Vector2,
} from 'three/webgpu';
import {
  abs,
  attribute,
  cameraPosition,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  floor,
  fract,
  fwidth,
  hash,
  int,
  interleavedGradientNoise,
  ivec2,
  length,
  max,
  mix,
  modelViewMatrix,
  modelWorldMatrixInverse,
  normalize,
  positionGeometry,
  positionView,
  pow,
  screenCoordinate,
  select,
  smoothstep,
  step,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { KIND } from './mesh';

/** Side of the window of swissBUILDINGS3D cells whose fade-in hides footprint buildings. */
export const MASK_SIZE = 64;

/**
 * One drawn tile. Per-tile values live on the mesh, not the material, and reach the shader
 * as uniforms updated per object (the shadow pass draws with a material of its own).
 */
export class BuildingMesh extends Mesh {
  /** Dithered fade: drawn where the screen's noise value lies in [fadeLo, fadeHi). */
  fadeLo = 0;
  fadeHi = 0;
  /** Geoid undulation at the tile (tile-frame y is above the ellipsoid; snow is by sea level). */
  geoid = 50;
}

/**
 * The look of all buildings: one node graph, one shader. Walls get procedural windows (dark
 * glass by day, a varied share lit warm or cool at night), roofs a hint of tile courses and
 * snow above the snow line. Faces are flat, their normal taken from screen-space derivatives.
 *
 * Vertex attributes (see MeshData): position (y above the building's ground point), lift
 * (metres that put the vertex onto the drawn terrain, refreshed on the CPU when the terrain
 * changes), roof and wall colour with kind and seed, and the 3D cell, eave height and flags.
 */
export class BuildingMaterials {
  readonly uniforms = {
    night: uniform(0),
    exposure: uniform(1),
    snowLine: uniform(2900),
    /** 1 in winter: roofs hold snow a little below the snow line. */
    winter: uniform(0),
    /** Lowest cell x/y of the fade mask window. */
    maskOrigin: uniform(new Vector2(-1e4, -1e4)),
    /** Window luminance scale (relative to the sky's units, before exposure). */
    lightLevel: uniform(2.2e-3),
  };
  /** Fade of the swissBUILDINGS3D cells around the camera: footprints step aside there. */
  readonly mask: DataTexture;
  private readonly nodes: Record<string, Node | null>;

  constructor() {
    this.mask = new DataTexture(
      new Uint8Array(MASK_SIZE * MASK_SIZE),
      MASK_SIZE,
      MASK_SIZE,
      RedFormat,
      UnsignedByteType,
    );
    this.mask.magFilter = this.mask.minFilter = NearestFilter;
    this.mask.generateMipmaps = false;
    this.mask.needsUpdate = true;
    this.nodes = this.build();
  }

  /** A material for footprint tiles (closed, outward-facing) or 3D cells (as modelled). */
  create(doubleSided: boolean): MeshStandardNodeMaterial {
    const m = new MeshStandardNodeMaterial();
    Object.assign(m, this.nodes);
    m.side = doubleSided ? DoubleSide : FrontSide;
    m.fog = false;
    return m;
  }

  dispose() {
    this.mask.dispose();
  }

  private build() {
    const u = this.uniforms;
    const perMesh = (get: (m: BuildingMesh) => number) =>
      uniform(0).onObjectUpdate(({ object }) => get(object as BuildingMesh));
    const fadeLo = perMesh((m) => m.fadeLo);
    const fadeHi = perMesh((m) => m.fadeHi);
    const geoid = perMesh((m) => m.geoid);

    // ---- vertex stage ----
    const p = positionGeometry;
    const lift = attribute('bLift', 'float');
    const roofAttr = attribute('bRoof', 'vec4');
    const wallAttr = attribute('bWall', 'vec4');
    const info = attribute('bInfo', 'vec4').mul(65535);

    // Footprint buildings in a cell whose swissBUILDINGS3D model is shown step aside.
    const mx = info.x.sub(u.maskOrigin.x);
    const my = info.y.sub(u.maskOrigin.y);
    const inMask = info.x
      .lessThan(65000)
      .and(mx.greaterThanEqual(0))
      .and(my.greaterThanEqual(0))
      .and(mx.lessThan(MASK_SIZE))
      .and(my.lessThan(MASK_SIZE));
    const maskTexel = texture(this.mask, ivec2(int(mx), int(my)) as never).setSampler(
      false,
    ) as unknown as Node<'vec4'>;
    const hide = select(inMask, maskTexel.x, float(0));
    // Fully replaced: every vertex to one point, so the building has no fragments at all.
    const placed = select(hide.greaterThan(0.996), vec3(0), vec3(p.x, p.y.add(lift), p.z));

    const vLocal = varying(placed, 'bLocal');
    const vRel = varying(p.y, 'bRel');
    const vHide = varying(hide, 'bHide');
    // Colours arrive as sRGB bytes; the shader works in linear light.
    const vRoof = varying(vec4(pow(roofAttr.xyz, vec3(2.2)), roofAttr.w.mul(255)), 'bRoofV');
    const vWall = varying(vec4(pow(wallAttr.xyz, vec3(2.2)), wallAttr.w), 'bWallV');
    const vEave = varying(info.z.div(10), 'bEave');

    // ---- fragment stage ----
    const lp = vLocal;
    const camLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
    const nRaw = normalize(cross(dFdx(lp), dFdy(lp)));
    const n = nRaw
      .mul(select(dot(nRaw, camLocal.sub(lp)).lessThan(0), float(-1), float(1)))
      .toVar();
    const kind = vRoof.w;
    const seed = vWall.w;
    const roofColour = vRoof.xyz;
    const wallColour = vWall.xyz;
    const eave = vEave;
    const roofness = smoothstep(0.3, 0.45, n.y);
    const isKind = (k: number) => abs(kind.sub(k)).lessThan(0.5);

    // Windows: columns along the wall, storeys up from the ground point.
    const tangent = normalize(vec2(n.z.negate(), n.x).add(vec2(1e-5, 0)));
    const along = dot(lp.xz, tangent);
    const big = isKind(KIND.flat);
    const storey = select(big, float(3.6), float(2.9));
    const column = select(big, float(2.0), float(2.7));
    const cu = along.div(column);
    const cv = vRel.sub(0.9).div(storey);
    const fu = fract(cu);
    const fv = fract(cv);
    // Antialiased box per cell; on far walls the pattern turns into its average.
    const wu = max(fwidth(cu), 1e-4);
    const wv = max(fwidth(cv), 1e-4);
    const uMin = select(big, float(0.08), float(0.22));
    const uMax = select(big, float(0.92), float(0.72));
    const sharp = smoothstep(uMin.sub(wu), uMin.add(wu), fu)
      .mul(float(1).sub(smoothstep(uMax.sub(wu), uMax.add(wu), fu)))
      .mul(smoothstep(float(0.3).sub(wv), float(0.3).add(wv), fv))
      .mul(float(1).sub(smoothstep(float(0.78).sub(wv), float(0.78).add(wv), fv)));
    const coverage = uMax.sub(uMin).mul(0.48);
    const detail = float(1).sub(smoothstep(0.35, 0.9, max(wu, wv)));
    const glazed = isKind(KIND.house)
      .or(isKind(KIND.flat))
      .or(isKind(KIND.chalet))
      .or(isKind(KIND.farm))
      .or(isKind(KIND.church));
    const storeyOk = vRel.greaterThan(0.9).and(vRel.lessThan(eave.sub(0.4)));
    const onWall = select(glazed.and(storeyOk), float(1), float(0))
      .mul(float(1).sub(roofness))
      .mul(select(isKind(KIND.church), float(0.35), float(1)));
    const windowMask = mix(coverage, sharp, detail).mul(onWall).toVar();

    // Chalets and farmhouses: plastered ground floor, weathered wood above.
    const plaster = vec3(0.72, 0.68, 0.6);
    const woody = isKind(KIND.chalet).or(isKind(KIND.farm));
    const wallBase = select(woody.and(vRel.lessThan(2.8)), plaster, wallColour);
    const glass = vec3(0.025, 0.03, 0.035);
    const wallAlbedo = mix(wallBase, glass, windowMask);

    // Roofs: courses of tiles across the slope, fading out with distance.
    const downhill = normalize(n.xz.add(vec2(1e-4, 0)));
    const course = dot(lp.xz, downhill).div(0.38);
    const cw = smoothstep(0.3, 0.8, fwidth(course));
    const ridge = smoothstep(0.4, 0.8, abs(fract(course).sub(0.5)).mul(2));
    const rows = float(1).sub(ridge.mul(0.12)).mul(float(1).sub(cw)).add(cw.mul(0.95));
    const flatRoof = n.y.greaterThan(0.97);
    const roofAlbedo = roofColour.mul(select(flatRoof, float(1), rows));

    // Snow: above the snow line (sea level), on roofs that are not too steep.
    const seaLevel = lp.y.sub(geoid);
    const line = u.snowLine.sub(u.winter.mul(250));
    const patchy = hash(seed.mul(9173)).mul(160);
    const snow = smoothstep(line.sub(60), line.add(120), seaLevel.add(patchy))
      .mul(smoothstep(0.45, 0.65, n.y))
      .mul(roofness);
    const snowColour = vec3(0.82, 0.84, 0.88);

    const albedo = mix(mix(wallAlbedo, roofAlbedo, roofness), snowColour, snow);
    const roughness = mix(mix(float(0.85), float(0.12), windowMask), float(0.7), roofness);

    // Night: a varied share of the windows lit, mostly warm, some cool, steady.
    const wx = floor(cu);
    const wy = floor(cv);
    const ws = seed.mul(977);
    const h1 = hash(wx.mul(12.9898).add(wy.mul(78.233)).add(ws));
    const h2 = hash(wx.mul(39.346).add(wy.mul(11.135)).add(ws.mul(1.7)));
    const share = hash(seed.mul(331)).mul(0.5).add(0.15);
    const lit = step(h1, u.night.mul(share).mul(1.15));
    const warm = vec3(1.0, 0.6, 0.28);
    const cool = vec3(0.7, 0.8, 1.0);
    const tint = mix(warm, cool, step(0.86, h2)).mul(h2.mul(0.6).add(0.55));
    // Far away the windows average out; lift them so a town still reads as lights.
    const dist = length(positionView);
    const far = smoothstep(800, 9000, dist).mul(2.5).add(1);
    const sharpLit = tint.mul(lit).mul(sharp);
    const meanLit = mix(warm, cool, 0.1).mul(u.night.mul(share).mul(0.85)).mul(coverage);
    const glow = mix(meanLit, sharpLit, detail)
      .mul(onWall)
      .mul(select(isKind(KIND.church), float(0.4), float(1)));
    const emissive = glow.mul(u.lightLevel).mul(u.exposure).mul(far);

    // Dithered fades: the tile's own, and the footprint giving way to the 3D model.
    const noise = interleavedGradientNoise(screenCoordinate.xy);
    const mask = noise
      .greaterThanEqual(fadeLo)
      .and(noise.lessThan(fadeHi))
      .and(noise.greaterThanEqual(vHide));

    return {
      positionNode: placed,
      colorNode: vec4(albedo, 1),
      normalNode: normalize(modelViewMatrix.mul(vec4(n, 0)).xyz),
      roughnessNode: roughness,
      metalnessNode: float(0),
      emissiveNode: emissive,
      maskNode: mask,
    } as unknown as Record<string, Node | null>;
  }
}
