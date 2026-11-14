import { MeshPhysicalNodeMaterial, type Node, Vector3, Vector4 } from 'three/webgpu';
import {
  Discard,
  Fn,
  If,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  cos,
  distance,
  float,
  floor,
  fract,
  fwidth,
  atan,
  cross,
  int,
  interleavedGradientNoise,
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
import { LEAF, LOOK } from './leaf';
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
  /** Towards the sun (or the moon), render space: light through the leaves. */
  readonly lightDir = uniform(new Vector3(0, 1, 0));
  /** 0 by day .. 1: how much colour the eye has lost (scotopicLoss). */
  readonly scotopic = uniform(0);
  /** Two vec4 per species: colour A + bareness, colour B + spare (season.ts). */
  readonly palette: N;
  /** Per species: summer reference colour (what the photo is compared with). */
  readonly summer: N;
  /** Per species: crown base, trunk radius per metre, mesh crown base of its form, unused. */
  readonly shape: N;
  readonly bark: N;
  /** Per species: LEAF and LOOK. */
  readonly leaf: N;
  readonly leafLook: N;

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
    this.leaf = uniformArray(
      Array.from({ length: SPECIES_COUNT }, (_, s) => new Vector4(...LEAF[s as Species])),
      'vec4',
    );
    this.leafLook = uniformArray(
      Array.from({ length: SPECIES_COUNT }, (_, s) => new Vector4(...LOOK[s as Species], 0)),
      'vec4',
    );
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

/**
 * What differs between chunks, read per draw from `mesh.userData.trees`: one material per form
 * and level serves every chunk, so a new chunk never builds a shader.
 */
export interface ChunkUniforms {
  /** 0 .. 1: from the previous ground heights to the current ones (re-seating without a jump). */
  blend: number;
  /** Geoid undulation at the chunk (ellipsoid minus sea level), metres. */
  undulation: number;
  /**
   * 1 when the chunk has near and mid meshes; 0 while it has only its far meshes (a far chunk
   * that came close before its full build arrived): then the far level draws every tree.
   */
  farFrom: number;
}

export class TreeMaterial extends MeshPhysicalNodeMaterial {}

const perChunk = (key: keyof ChunkUniforms, fallback: number) =>
  uniform(fallback).onObjectUpdate(
    ({ object }) => (object?.userData.trees as ChunkUniforms | undefined)?.[key] ?? fallback,
  );

export type Lod = 0 | 1 | 2;

/** Hash of a float to [0, 1): enough for picking per-cluster variations in the vertex stage. */
const hash1 = (x: N): N => fract(sin(x.mul(12.9898).add(4.1414)).mul(43758.5453));

/**
 * Builds the node graph of one level of detail for one form. The vertex stage places, scales,
 * turns and sways the tree from its instance data, decides whether this level draws it at all
 * (collapsing it to a point if not) and hands the fragment stage the range of the screen-door
 * threshold in which it draws: two levels in transition split the pixels between them.
 * `detail`: 2 = leaves (near level: per-tree crowns, leaf-scale shading and gaps, light through
 * the crown's edge), 1 = tufts in colour and normal, 0 = plain.
 */
export function buildTreeNodes(u: TreeUniforms, form: Form, lod: Lod, detail: 0 | 1 | 2) {
  const iPos = attribute('iPos', 'vec4') as N;
  const iShape = attribute('iShape', 'vec4') as N;
  const iPhoto = attribute('iPhoto', 'vec4') as N;
  const iGround = attribute('iGround', 'float') as N;
  const iGroundPrev = attribute('iGroundPrev', 'float') as N;
  const part = attribute('part', 'float') as N;
  const ao = attribute('ao', 'float') as N;
  const meshPosition = attribute('position', 'vec3') as N;
  const normal = attribute('normal', 'vec3') as N;
  const groundBlend = perChunk('blend', 1) as N;
  const undulation = perChunk('undulation', 50) as N;
  const farFrom = perChunk('farFrom', 0) as N;
  const leafy = detail > 1;
  const conifer = form === Form.Conifer;

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
  const leaf = u.leaf.element(species) as N;
  const leafLook = u.leafLook.element(species) as N;
  const isTrunk = part.lessThan(0.5);
  const isCrownPart = part.greaterThan(0.5).and(part.lessThan(1.5));

  // ---- Every near tree its own crown: clusters (or whorls) grown, shrunk, moved, left out ----
  let position = meshPosition;
  let clusterPick: N = float(0);
  let outer: N = float(0);
  let clusterNormal: N = normal;
  let twigRel: N = vec3(0);
  let twigId: N = float(0);
  if (leafy) {
    const cl = attribute('cluster', 'vec4') as N;
    const has = cl.w.greaterThanEqual(0);
    const key = cl.w.mul(61.7).add(seed.mul(17.3));
    const h1 = hash1(key);
    const h2 = hash1(key.add(1.31));
    const scale = float(1).add(h1.sub(0.5).mul(2).mul(leaf.y));
    if (conifer) {
      // A whorl a little wider or narrower than its neighbours: a ragged, individual cone.
      const s = select(has.and(isCrownPart), scale, float(1));
      position = vec3(meshPosition.x.mul(s), meshPosition.y, meshPosition.z.mul(s));
      outer = select(has, meshPosition.xz.length().div(cl.x.max(0.01)), float(0));
    } else {
      const centre = cl.xyz;
      const kept = select(h2.lessThan(leaf.x), float(0), scale) as N;
      const shift = vec3(
        hash1(key.add(2.7)).sub(0.5),
        hash1(key.add(3.9)).sub(0.5).mul(0.5),
        hash1(key.add(5.3)).sub(0.5),
      ).mul(leaf.z.mul(2));
      const rel = meshPosition.sub(centre);
      const grown = centre.add(rel.mul(vec3(kept, kept.mul(leafLook.x), kept))).add(shift);
      // Branches follow their cluster's move at the tip and stay put at the fork.
      const follow = clamp(float(1).sub(rel.length().div(0.5)), 0, 1);
      const bent = meshPosition.add(shift.mul(follow));
      position = select(has, select(isCrownPart, grown, bent), meshPosition);
      // Crowns turn unevenly in autumn: each cluster leans to one end of the tree's range.
      clusterPick = select(has, hash1(key.add(7.1)).sub(0.5).mul(0.7), float(0));
      // The cluster's own surface normal (its ellipsoid is squashed like the crown).
      const hy = (1 - BROADLEAF_CROWN_BASE) / 2;
      clusterNormal = select(has.and(isCrownPart), vec3(rel.x, rel.y.div(hy * hy), rel.z), normal);
      // From the cluster's (grown, shifted) centre to the point, and 1 + the cluster's id
      // (0 for the core and the wood): bare crowns draw their twigs from it.
      twigRel = select(
        has.and(isCrownPart),
        rel.mul(vec3(kept, kept.mul(leafLook.x), kept)),
        vec3(0),
      );
      twigId = select(has.and(isCrownPart), cl.w.add(1), float(0));
    }
  }

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
  const metric = vec3(position.x.mul(sxz), yTree.mul(hScale), position.z.mul(sxz)) as N;
  let local = metric;
  // Sway: the crown top moves most; only near the camera, where it can be seen.
  const sway = u.wind
    .mul(float(1).sub(smoothstep(120, 260, d)))
    .mul(pow(clamp(yTree, 0, 1), 2))
    .mul(height)
    .mul(conifer ? 0.006 : 0.01);
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

  // Normals: inverse of the non-uniform scale, then the turn.
  const toWorld = (n: N): N => {
    const scaled = normalize(
      vec3(n.x.div(sxz.max(1e-3)), n.y.div(sy.max(1e-3)), n.z.div(sxz.max(1e-3))),
    );
    const turned = vec3(
      scaled.x.mul(c).sub(scaled.z.mul(s)),
      scaled.y,
      scaled.x.mul(s).add(scaled.z.mul(c)),
    );
    return normalize((modelWorldMatrix as N).mul(vec4(turned, 0)).xyz);
  };
  const nWorld = varying(toWorld(normal), 'vTreeNormal') as N;
  // A direction in tree space scaled and turned like the tree (no normalising).
  const spanToWorld = (v: N): N =>
    (modelWorldMatrix as N).mul(
      vec4(
        v.x.mul(sxz).mul(c).sub(v.z.mul(sxz).mul(s)),
        v.y.mul(sy),
        v.x.mul(sxz).mul(s).add(v.z.mul(sxz).mul(c)),
        0,
      ),
    ).xyz;

  const vLo = varying(lo, 'vTreeLo') as N;
  const vHi = varying(hi, 'vTreeHi') as N;
  const vDist = varying(d, 'vTreeDist') as N;
  const vElev = varying(ground.sub(undulation), 'vTreeElev') as N;
  const vTreePos = varying(vec3(position.x, yTree, position.z), 'vTreeLocal') as N;
  const vWorld = varying(
    (modelWorldMatrix as N).mul(vec4(base.add(rotated), 1)).xyz,
    'vTreeWorld',
  ) as N;

  // ---- Leaves (near level): shading, gaps and light at leaf scale, in metres ----
  const view = normalize(cameraPosition.sub(vWorld)) as N;
  let leaves: N = float(0);
  let leafTilt: N = vec3(0);
  let gapEdge: N = float(0);
  let trans: N = float(0);
  let fine: N = float(1);
  let vLeaf: N = vec3(0);
  let vTwig: N = vec4(0);
  if (leafy) {
    vLeaf = varying(metric.add(seed.mul(53)), 'vTreeLeaf') as N;
    const vPick = varying(clusterPick, 'vTreePick') as N;
    clusterPick = vPick;
    // The finest octave flickers once a leaf is smaller than a pixel: it fades out with distance.
    fine = float(1).sub(smoothstep(45, 160, vDist));
    const f = float(1).div(leaf.w);
    // Three octaves: clumps of sprays, sprays, single leaves.
    const n0 = mx_noise_float(vLeaf.mul(f.div(3.5))) as N;
    const n1 = mx_noise_float(vLeaf.mul(f).add(3.1)) as N;
    const n2 = mx_noise_float(vLeaf.mul(f.mul(2.7)).add(7.3)) as N;
    leafTilt = vec3(n1.sub(n2.mul(0.5)), n0, n2.mul(fine).sub(n1.mul(0.5)));
    leaves = n0
      .mul(0.55)
      .add(n1.mul(mix(float(0.25), float(0.5), fine)))
      .add(n2.mul(0.3).mul(fine));
    const facing = abs(dot(nWorld, view));
    // The crown's silhouette, and (broadleaf) the edges of its clusters, open between leaves.
    const silhouette = smoothstep(0.45, 0.05, facing);
    let thin: N;
    if (conifer) {
      // Needle sprays: a fringe of tips at the outer edge of each whorl.
      const vOuter = varying(outer, 'vTreeOuter') as N;
      gapEdge = smoothstep(0.62, 1.0, vOuter).mul(0.9).max(silhouette.mul(0.5));
      thin = smoothstep(0.4, 1.0, vOuter).max(float(1).sub(facing));
    } else {
      const vClusterN = varying(toWorld(clusterNormal), 'vTreeClusterN') as N;
      const clusterRim = float(1).sub(abs(dot(normalize(vClusterN), view)));
      gapEdge = smoothstep(0.15, 0.8, clusterRim).max(silhouette);
      thin = clamp(clusterRim.mul(1.6), 0, 1);
      vTwig = varying(vec4(spanToWorld(twigRel), twigId), 'vTreeTwig') as N;
    }
    gapEdge = gapEdge.mul(leafLook.z);
    // Light through the leaves: looking towards the sun, the whole crown lets some through and
    // its thin outer layers most.
    const L = normalize(u.lightDir) as N;
    const towards = pow(clamp(dot(view, L).negate().add(0.15), 0, 1), 1.5);
    thin = thin.mul(0.75).add(0.25);
    trans = towards.mul(thin).mul(leafLook.y);
  }

  // ---- Colour ----
  const colorNode = Fn(() => {
    // Screen door between two levels of detail (no blending: depth and haze stay exact).
    const t = interleavedGradientNoise(screenCoordinate.xy) as N;
    Discard(t.lessThan(vLo).or(t.greaterThanEqual(vHi)));

    const a = u.palette.element(species.mul(2)) as N;
    const b = u.palette.element(species.mul(2).add(1)) as N;
    const bare = a.w;
    const pick = clamp(fract(seed.mul(7.31).add(0.13)).add(clusterPick), 0, 1);
    const leafColor = mix(a.xyz, b.xyz, pick);
    const summer = (u.summer.element(species) as N).xyz;
    // Near: the species' colour, as much darker or lighter as the photo is under this tree
    // compared with the forest around (dark spruce among light beech stays dark). Far: the
    // photo's own colour, recoloured by the season, so the trees melt into the ground.
    const hasPhoto = iPhoto.x.greaterThanEqual(0);
    const own = vec3(seed.sub(0.5).mul(0.3).add(1), seed.sub(0.5).mul(0.2).add(1), 1);
    const nearColor = leafColor.mul(select(hasPhoto, vec3(pow(clamp(bright, 0.3, 3), 0.8)), own));
    const season = leafColor.div(summer.max(1e-3));
    // Leafless crowns cannot be recoloured by a ratio to the summer green (grey-brown over
    // green has far more red and blue: the wood would turn violet). They take the twig
    // colour, as light or dark as the photo is there.
    const luma = (c: N) => c.x.mul(0.3).add(c.y.mul(0.59)).add(c.z.mul(0.11)) as N;
    const bareFar = leafColor.mul(luma(iPhoto.xyz).div(luma(summer).max(1e-3)).clamp(0.4, 2.5));
    const farColor = mix(iPhoto.xyz.mul(season), bareFar, bare);
    const w = smoothstep(u.near.mul(1.5), u.thin, vDist).mul(select(hasPhoto, float(1), float(0)));
    let crown = mix(nearColor, farColor, w).mul(u.crownGain) as N;
    const isCrown = isCrownPart;
    if (leafy) {
      if (conifer) {
        // Bare larches: a net of twigs (the ridges of a noise) around the whorls.
        If(isCrown.and(bare.greaterThan(0.01)), () => {
          const lace = mx_noise_float(vLeaf.mul(2.2).add(seed.mul(31))) as N;
          const twig = mix(float(0.2), float(0.075), fine);
          Discard(abs(lace).greaterThan(mix(float(2), twig, bare)));
        });
      } else {
        // Bare crowns: straight twigs radiating from each cluster's middle, where its branch
        // ends, as seen from the camera: lines of equal angle around the cluster's centre in
        // the plane facing the viewer, so they stay straight and never close into loops. Each
        // is about a pixel wide (the derivative of its angle sets the width), starts a little
        // out from the middle and stops at its own length; the fine ones only grow outside,
        // so the crown thins out towards its edge. Far away the fine ones crowd closer than a
        // pixel and are thinned to a haze through which the branches show. Derivatives are
        // taken here, outside any branch.
        const id = vTwig.w.sub(1);
        const rel = vTwig.xyz;
        const across = rel.sub(view.mul(dot(rel, view)));
        const right = normalize(cross(view, vec3(0, 1, 0)));
        const up = cross(right, view);
        const ang = atan(dot(across, up), dot(across, right));
        // 0 in the cluster's middle (as seen) .. 1 at its outline.
        const s01 = across.length().div(rel.length().max(1e-4));
        const twigs = (count: number, width: number, from: number, offset: number) => {
          const g0 = ang.mul(count / (2 * Math.PI)).add(id.mul(7.3 + offset));
          const twig = floor(g0.add(0.5)).add(id.mul(13).add(offset));
          const h1 = hash1(twig);
          const h2 = hash1(twig.add(0.71));
          // Each twig leans a little to one side as it grows out (staying in its own sector),
          // starts and stops on its own, and some are missing: no regular star.
          const g = g0.add(hash1(twig.add(1.93)).sub(0.5).mul(0.6).mul(s01));
          const f = fract(g);
          const off = min(f, float(1).sub(f)).div(fwidth(g0).max(1e-4));
          const keepTwig = off
            .lessThan(width)
            .and(h2.greaterThan(0.25))
            .and(s01.greaterThan(h2.mul(0.25).add(from)))
            .and(s01.lessThan(h1.mul(0.45).add(0.5)));
          return { keep: keepTwig, crowd: fwidth(g0) };
        };
        const main = twigs(26, 0.6, 0.15, 0);
        const thinTwigs = twigs(80, 0.4, 0.35, 3.7);
        const dither = fract(t.mul(7.13).add(0.37));
        // Fine twigs closer than about two pixels: only some pixels of them, a haze.
        const haze = mix(float(1), float(0.4), smoothstep(0.25, 0.6, thinTwigs.crowd));
        const kept = main.keep.or(thinTwigs.keep.and(dither.lessThan(haze)));
        If(isCrown.and(bare.greaterThan(0.01)), () => {
          // The core has no branch to fan from: it goes with the leaves.
          Discard(kept.not().or(vTwig.w.lessThan(0.5)).and(dither.lessThan(bare)));
        });
        // Twigs are thin wood seen against the sky: dark, whatever the sun does.
        crown = crown.mul(mix(float(1), float(0.35), bare));
      }
      // Sprays of leaves stand out lit against the dark hollows between them.
      const sprays = smoothstep(-0.25, 0.3, leaves);
      // Light through a leaf comes out yellower than the light it reflects.
      crown = crown
        .mul(mix(float(0.55), float(1.2), sprays))
        .mul(vec3(0.9, 1.1, 0.5).mul(trans).add(1));
      // Gaps: at the cluster edges and the silhouette, and a few inside close up.
      const open = leaves.mul(0.5).add(0.5);
      Discard(
        isCrown.and(bare.lessThan(0.5)).and(open.lessThan(gapEdge.mul(0.85).add(fine.mul(0.05)))),
      );
    } else {
      if (detail > 0) {
        // Leaf and needle clumps: lit tufts and dark hollows between them.
        const clump = mx_noise_float(vTreePos.mul(vec3(6, 16, 6)).add(seed.mul(17))) as N;
        crown = crown.mul(clump.mul(0.45).add(0.95));
      }
      // Bare crowns far out: the twigs merge into a thin grey-brown haze with holes.
      const lace = mx_noise_float(vTreePos.mul(vec3(5, 14, 5)).add(seed.mul(31))) as N;
      Discard(isCrown.and(lace.mul(0.5).add(0.5).lessThan(bare.mul(0.6))));
    }
    // Moonlight is seen without colour (rod vision): crowns lose theirs as the ground does,
    // or an autumn crown glows red against a grey night.
    crown = mix(crown, vec3(luma(crown)), u.scotopic);

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
  if (leafy) {
    // Sprays of leaves tilt every which way; the edges the sun shines through take its light.
    // The octaves already at hand, crossed into a direction: a vector noise costs three more.
    const tilt = leafTilt.mul(0.7);
    nShade = normalize(nWorld.add(select(isCrownPart, tilt, vec3(0))));
    const L = normalize(u.lightDir) as N;
    const bend = select(isCrownPart, trans.mul(0.85), float(0)) as N;
    nShade = normalize(mix(nShade, L, bend) as N);
  } else if (detail > 0) {
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
