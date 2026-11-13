import { MeshPhysicalNodeMaterial, type Node, Vector4 } from 'three/webgpu';
import {
  Discard,
  Fn,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  cos,
  distance,
  float,
  floor,
  fract,
  int,
  interleavedGradientNoise,
  materialReference,
  min,
  mix,
  modelWorldMatrix,
  mx_noise_float,
  mx_noise_vec3,
  abs,
  dot,
  normalize,
  pow,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  uniform,
  uniformArray,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { BROADLEAF_CROWN_BASE, CONIFER_CROWN_BASE } from './geometry';
import { LOD_BAND, LOD_JITTER, THIN_POWER } from './presets';
import { PALETTE_STRIDE, summerColor } from './season';
import { Form, SPECIES_COUNT, Species } from './species';

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not follow swizzles
   and arithmetic through Fn bodies; the graph is checked when the shader is built. */
type N = any;

/** Per-species shape: crown base (share of the height), trunk radius per metre of height. */
const SHAPE: Record<Species, [number, number]> = {
  [Species.Spruce]: [0.12, 0.013],
  [Species.Fir]: [0.14, 0.014],
  [Species.Larch]: [0.22, 0.013],
  [Species.Pine]: [0.25, 0.018],
  [Species.Beech]: [0.32, 0.016],
  [Species.Oak]: [0.3, 0.02],
  [Species.Shrub]: [0.04, 0.02],
  [Species.Solitary]: [0.3, 0.022],
};

/** Bark, linear albedo: beech grey, the rest grey-brown. */
const BARK: Record<Species, [number, number, number]> = {
  [Species.Spruce]: [0.07, 0.05, 0.04],
  [Species.Fir]: [0.11, 0.1, 0.09],
  [Species.Larch]: [0.08, 0.05, 0.04],
  [Species.Pine]: [0.09, 0.06, 0.045],
  [Species.Beech]: [0.17, 0.16, 0.145],
  [Species.Oak]: [0.09, 0.08, 0.07],
  [Species.Shrub]: [0.08, 0.07, 0.06],
  [Species.Solitary]: [0.1, 0.085, 0.07],
};

/** Shared state of all tree materials: distances, the season palette, light-independent knobs. */
export class TreeUniforms {
  /** Level-of-detail switch distances (already scaled to the screen), metres. */
  readonly near = uniform(200);
  readonly mid = uniform(1000);
  readonly thin = uniform(1200);
  readonly fadeStart = uniform(4200);
  readonly fadeEnd = uniform(6000);
  readonly time = uniform(0);
  /** Branch sway amplitude (0 = off). */
  readonly wind = uniform(1);
  readonly snowLine = uniform(2900);
  /**
   * Crowns shade themselves (ambient occlusion, dark sides), the photo's forest does not: a
   * small gain on the crown albedo keeps a lit forest as bright as the photo it stands on.
   */
  readonly crownGain = uniform(1.1);
  /** Two vec4 per species: colour A + bareness, colour B + spare (season.ts). */
  readonly palette: N;
  /** Per species: summer reference colour (what the photo is compared with). */
  readonly summer: N;
  /** Per species: crown base, trunk radius per metre, mesh crown base of its form, unused. */
  readonly shape: N;
  readonly bark: N;

  constructor() {
    const v4 = (n: number) => Array.from({ length: n }, () => new Vector4());
    this.palette = uniformArray(v4(SPECIES_COUNT * 2), 'vec4');
    const summer = v4(SPECIES_COUNT);
    const shape = v4(SPECIES_COUNT);
    const bark = v4(SPECIES_COUNT);
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const c = summerColor(s);
      summer[s]!.set(c[0], c[1], c[2], 1);
      const conifer = s === Species.Spruce || s === Species.Fir || s === Species.Larch;
      shape[s]!.set(
        SHAPE[s as Species][0],
        SHAPE[s as Species][1],
        conifer ? CONIFER_CROWN_BASE : BROADLEAF_CROWN_BASE,
        0,
      );
      const b = BARK[s as Species];
      bark[s]!.set(b[0], b[1], b[2], 1);
    }
    this.summer = uniformArray(summer, 'vec4');
    this.shape = uniformArray(shape, 'vec4');
    this.bark = uniformArray(bark, 'vec4');
  }

  setPalette(p: Float32Array) {
    const values = (this.palette as { array: Vector4[] }).array;
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const o = s * PALETTE_STRIDE;
      values[s * 2]!.set(p[o]!, p[o + 1]!, p[o + 2]!, p[o + 3]!);
      values[s * 2 + 1]!.set(p[o + 4]!, p[o + 5]!, p[o + 6]!, p[o + 7]!);
    }
  }
}

/** One draw's material: the shared graph, plus what differs per chunk. */
export class TreeMaterial extends MeshPhysicalNodeMaterial {
  /** 0 .. 1: from the previous ground heights to the current ones (re-seating without a jump). */
  groundBlend = 1;
  /** Geoid undulation at the chunk (ellipsoid minus sea level), metres. */
  undulation = 50;
  /**
   * Far level only: distance below which the near and mid levels take over. 0 while a chunk
   * has no near meshes yet (a far chunk that came close before its full build arrived).
   */
  farFrom = 0;
}

export type Lod = 0 | 1 | 2;

/**
 * Builds the node graph of one level of detail for one form. The vertex stage places, scales,
 * turns and sways the tree from its instance data, decides whether this level draws it at all
 * (collapsing it to a point if not) and hands the fragment stage the range of the screen-door
 * threshold in which it draws: two levels in transition split the pixels between them.
 * `detail`: 2 = tufts in colour and normal and a ragged outline, 1 = tufts only, 0 = plain.
 */
export function buildTreeNodes(u: TreeUniforms, form: Form, lod: Lod, detail: 0 | 1 | 2) {
  const iPos = attribute('iPos', 'vec4') as N;
  const iShape = attribute('iShape', 'vec4') as N;
  const iPhoto = attribute('iPhoto', 'vec4') as N;
  const iGround = attribute('iGround', 'float') as N;
  const iGroundPrev = attribute('iGroundPrev', 'float') as N;
  const part = attribute('part', 'float') as N;
  const ao = attribute('ao', 'float') as N;
  const position = attribute('position', 'vec3') as N;
  const normal = attribute('normal', 'vec3') as N;
  const groundBlend = materialReference('groundBlend', 'float') as N;
  const undulation = materialReference('undulation', 'float') as N;
  const farFrom = materialReference('farFrom', 'float') as N;

  const rank = iPos.w;
  const height = iShape.x;
  const width = iShape.y;
  const rot = iShape.z;
  const speciesF = floor(iShape.w);
  const species = int(speciesF);
  const seed = fract(iShape.w).div(0.98);
  const edge = floor(iPhoto.w.div(4));
  const bright = iPhoto.w.sub(edge.mul(4));
  const ground = mix(iGroundPrev, iGround, groundBlend);
  const base = vec3(iPos.x, iPos.y.add(ground), iPos.z);
  const baseWorld = (modelWorldMatrix as N).mul(vec4(base, 1)).xyz;
  const d = distance(baseWorld, cameraPosition) as N;

  // ---- How much of the forest is shown at this distance, and is this tree part of it ----
  const thinned = select(d.lessThan(u.thin), float(1), pow(u.thin.div(d), THIN_POWER)) as N;
  const keep = thinned.mul(float(1).sub(smoothstep(u.fadeStart, u.fadeEnd, d)));
  // Trees grow out of and shrink back into the ground over a short span of rank.
  const presence = smoothstep(0, 0.05, keep.sub(rank));
  // Fewer trees far away: the ones left are a little bigger, so the forest keeps its body.
  // Only inside a stand: a lone tree in a field has no neighbours to make up for.
  const comp = pow(clamp(thinned, 0.15, 1), float(-0.3).mul(smoothstep(2, 8, edge)));

  // ---- Level of detail: [lo, hi) of the screen-door threshold this level draws ----
  const jitter = seed.sub(0.5).mul(LOD_JITTER);
  const nearW = float(1).sub(
    smoothstep(u.near.mul(1 - LOD_BAND), u.near.mul(1 + LOD_BAND), d.mul(jitter.add(1))),
  );
  const midW = float(1).sub(
    smoothstep(u.mid.mul(1 - LOD_BAND), u.mid.mul(1 + LOD_BAND), d.mul(jitter.add(1))),
  );
  let lo: N;
  let hi: N;
  if (lod === 0) {
    lo = float(0);
    hi = nearW;
  } else if (lod === 1) {
    lo = nearW;
    hi = midW;
  } else {
    // Without near meshes the far level draws everything.
    lo = select(farFrom.greaterThan(0), midW, float(0));
    hi = float(1);
  }
  const drawn = hi.sub(lo).greaterThan(0.002).and(presence.greaterThan(0.001));

  // ---- Shape ----
  const shape = u.shape.element(species) as N;
  const meshBase = shape.z;
  // Forest-edge and solitary trees keep their branches far down.
  const open = float(1).sub(smoothstep(2, 12, edge));
  const crownBase = shape.x.mul(mix(float(1), float(0.45), open));
  const isTrunk = part.lessThan(0.5);
  const y = position.y;
  // Remap the mesh's crown base to the species' own: crown above it, trunk below.
  const yCrown = crownBase.add(
    y.sub(meshBase).mul(float(1).sub(crownBase).div(float(1).sub(meshBase))),
  );
  const yTrunk = y.mul(crownBase.div(meshBase));
  const yTree = select(isTrunk, yTrunk, yCrown) as N;
  // Height of the tree space per metre of mesh y, for the normals.
  const slope = select(
    isTrunk,
    crownBase.div(meshBase),
    float(1).sub(crownBase).div(float(1).sub(meshBase)),
  );
  const hScale = presence.mul(comp.sub(1).mul(0.35).add(1)).mul(height);
  const sy = slope.mul(hScale);
  const trunkR = shape.y.mul(height).add(0.08);
  const crownR = width.mul(0.5).mul(comp);
  const sxz = select(isTrunk, trunkR, crownR).mul(presence);
  let local = vec3(position.x.mul(sxz), yTree.mul(hScale), position.z.mul(sxz)) as N;
  // Sway: the crown top moves most; only near the camera, where it can be seen.
  const sway = u.wind
    .mul(float(1).sub(smoothstep(120, 260, d)))
    .mul(pow(clamp(yTree, 0, 1), 2))
    .mul(height)
    .mul(form === Form.Conifer ? 0.006 : 0.01);
  const phase = u.time.mul(1.3).add(seed.mul(40));
  const swayX = sin(phase)
    .add(sin(phase.mul(2.3).add(1.7)).mul(0.4))
    .mul(sway);
  const swayZ = cos(phase.mul(0.8).add(0.5)).mul(sway).mul(0.6);
  const c = cos(rot);
  const s = sin(rot);
  const rotated = vec3(
    local.x.mul(c).sub(local.z.mul(s)).add(swayX),
    local.y,
    local.x.mul(s).add(local.z.mul(c)).add(swayZ),
  );
  local = select(drawn, base.add(rotated), vec3(0, 0, 0));

  // Normal: inverse of the non-uniform scale, then the turn.
  const nScaled = normalize(
    vec3(normal.x.div(sxz.max(1e-3)), normal.y.div(sy.max(1e-3)), normal.z.div(sxz.max(1e-3))),
  );
  const nRot = vec3(
    nScaled.x.mul(c).sub(nScaled.z.mul(s)),
    nScaled.y,
    nScaled.x.mul(s).add(nScaled.z.mul(c)),
  );
  const nWorld = varying(
    normalize((modelWorldMatrix as N).mul(vec4(nRot, 0)).xyz),
    'vTreeNormal',
  ) as N;

  const vLo = varying(lo, 'vTreeLo') as N;
  const vHi = varying(hi, 'vTreeHi') as N;
  const vDist = varying(d, 'vTreeDist') as N;
  const vElev = varying(ground.sub(undulation), 'vTreeElev') as N;
  const vTreePos = varying(vec3(position.x, yTree, position.z), 'vTreeLocal') as N;
  const vWorld = varying(
    (modelWorldMatrix as N).mul(vec4(base.add(rotated), 1)).xyz,
    'vTreeWorld',
  ) as N;

  // ---- Colour ----
  const colorNode = Fn(() => {
    // Screen door between two levels of detail (no blending: depth and haze stay exact).
    const t = interleavedGradientNoise(screenCoordinate.xy) as N;
    Discard(t.lessThan(vLo).or(t.greaterThanEqual(vHi)));

    const a = u.palette.element(species.mul(2)) as N;
    const b = u.palette.element(species.mul(2).add(1)) as N;
    const bare = a.w;
    const pick = fract(seed.mul(7.31).add(0.13));
    const leaf = mix(a.xyz, b.xyz, pick);
    const summer = (u.summer.element(species) as N).xyz;
    // Near: the species' colour, as much darker or lighter as the photo is under this tree
    // compared with the forest around (dark spruce among light beech stays dark). Far: the
    // photo's own colour, recoloured by the season, so the trees melt into the ground.
    const hasPhoto = iPhoto.x.greaterThanEqual(0);
    const own = vec3(seed.sub(0.5).mul(0.3).add(1), seed.sub(0.5).mul(0.2).add(1), 1);
    const nearColor = leaf.mul(select(hasPhoto, vec3(pow(clamp(bright, 0.3, 3), 0.8)), own));
    const season = leaf.div(summer.max(1e-3));
    const farColor = iPhoto.xyz.mul(season);
    const w = smoothstep(u.near.mul(1.5), u.thin, vDist).mul(select(hasPhoto, float(1), float(0)));
    const tint = vec3(1);
    let crown = mix(nearColor, farColor, w).mul(tint).mul(u.crownGain) as N;
    if (detail > 0) {
      // Leaf and needle clumps: lit tufts and dark hollows between them.
      const clump = mx_noise_float(vTreePos.mul(vec3(6, 16, 6)).add(seed.mul(17))) as N;
      crown = crown.mul(clump.mul(0.45).add(0.95));
    }
    if (detail > 1) {
      // A finer octave of leaf clusters close up.
      const leaves = mx_noise_float(vTreePos.mul(vec3(17, 45, 17)).add(seed.mul(5))) as N;
      crown = crown.mul(leaves.mul(0.3).add(1));
      const clump = mx_noise_float(vTreePos.mul(vec3(6, 16, 6)).add(seed.mul(17))).add(
        leaves.mul(0.4),
      ) as N;
      // A ragged outline: at the crown's silhouette, gaps open between the tufts.
      const view = normalize(cameraPosition.sub(vWorld)) as N;
      const rim = smoothstep(0.45, 0.05, abs(dot(nWorld, view)));
      const isLeaf = part.greaterThan(0.5).and(part.lessThan(1.5));
      Discard(isLeaf.and(clump.mul(0.5).add(0.5).lessThan(rim.mul(0.75))));
    }
    // Bare crowns in winter: a lacy net of twigs through which the ground shows.
    const lace = mx_noise_float(vTreePos.mul(vec3(9, 26, 9)).add(seed.mul(31))) as N;
    const isCrown = part.greaterThan(0.5).and(part.lessThan(1.5));
    Discard(
      isCrown.and(bare.greaterThan(0.01)).and(lace.mul(0.5).add(0.5).lessThan(bare.mul(0.62))),
    );

    const barkColor = (u.bark.element(species) as N).xyz;
    const occlusion = mix(float(0.42), float(1), ao);
    let albedo = select(isTrunk.or(part.greaterThan(1.5)), barkColor, crown).mul(occlusion) as N;
    // Snow on what faces up, above the snow line; less on bare twigs.
    const snow = smoothstep(u.snowLine.sub(80), u.snowLine.add(160), vElev)
      .mul(smoothstep(0.25, 0.75, nWorld.y))
      .mul(select(bare.greaterThan(0.5), float(0.55), float(0.9)))
      .mul(select(isTrunk, float(0.2), float(1)));
    albedo = mix(albedo, vec3(0.78, 0.8, 0.84), snow);
    return vec4(min(albedo, vec3(0.9)), 1);
  })();

  let nShade = nWorld;
  if (detail > 0) {
    // Tufts tilt the normal: light and shade within the crown, not one smooth ball.
    const tilt = (mx_noise_vec3(vTreePos.mul(vec3(5, 13, 5)).add(seed.mul(9))) as N).mul(0.55);
    nShade = normalize(nWorld.add(select(part.greaterThan(0.5), tilt, vec3(0))));
  }
  return {
    positionNode: local as Node<'vec3'>,
    colorNode: colorNode as Node<'vec4'>,
    normalNode: normalize((cameraViewMatrix as N).mul(vec4(nShade, 0)).xyz) as N as Node<'vec3'>,
    roughnessNode: float(0.9) as Node<'float'>,
    metalnessNode: float(0) as Node<'float'>,
    // Canopies scatter almost no mirror light: their tiny facets shade each other.
    specularIntensityNode: float(0.25) as Node<'float'>,
  };
}

export function createTreeMaterial(nodes: ReturnType<typeof buildTreeNodes>): TreeMaterial {
  const m = new TreeMaterial();
  Object.assign(m, nodes);
  m.fog = false;
  return m;
}
