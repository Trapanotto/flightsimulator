/**
 * Node materials of the airport ground: runways with their Annex 14 markings, and the ground
 * mesh (aprons, taxiways, grass strips) with a second material for its painted lines.
 *
 * Everything is computed per pixel from the surface's own coordinates (metres along and across
 * a runway or taxiway), so the paint is razor sharp at 2 m. Every mark is box-filtered over the
 * pixel footprint (fwidth), and repeating marks (stripes, dashes) use the exact integral of
 * their pattern, so far away they turn into the right shade of grey instead of moiré.
 *
 * How the surfaces lie on the terrain (see pull.ts): they are draped on the terrain's own
 * heights, drawn without writing depth, in a fixed order (aprons, taxiways, lines, runways),
 * and pulled towards the camera along the view ray (which moves nothing on screen) by a margin
 * that covers the difference between the drape and the drawn terrain.
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardNodeMaterial,
  NoColorSpace,
  type Node,
  RGBAFormat,
  RedFormat,
  RepeatWrapping,
  UnsignedByteType,
} from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  exp,
  float,
  floor,
  fract,
  fwidth,
  max,
  min,
  mix,
  mod,
  positionLocal,
  pow,
  select,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { NOISE_SIZE, buildNoiseTexels } from '../terrain/noise';
import {
  ATLAS_PAD,
  ATLAS_RANGE,
  ATLAS_RES,
  CELL_H,
  CELL_W,
  GLYPH_COUNT,
  buildGlyphAtlas,
} from './glyphs';
import {
  CENTRE_PERIOD,
  CENTRE_STRIPE,
  DESIGNATOR_START,
  GLYPH_GAP,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  LETTER_GAP,
  STRIPES_LENGTH,
  STRIPES_START,
  TDZ_GAP,
  TDZ_LENGTH,
  TDZ_SPACING,
  TDZ_STRIPE,
  THRESHOLD_BAR,
} from './layout';
import { GROUND_APRON, GROUND_GRASS, GROUND_HOLD, GROUND_TAXIWAY } from './geometry';
import { pulledVertex } from './pull';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

/** Coverage of [lo, hi] by a pixel `w` wide centred on x (exact box filter). */
function box(x: F, lo: F | number, hi: F | number, w: F): F {
  const half = w.mul(0.5);
  return clamp(
    min(x.add(half), hi)
      .sub(max(x.sub(half), lo))
      .div(w),
    0,
    1,
  );
}

/** Integral of a pattern that is on for [0, duty) of every `period`. */
function stripeIntegral(x: F, period: F | number, duty: F | number): F {
  const q = x.div(period);
  return floor(q)
    .mul(duty)
    .add(min(fract(q).mul(period), duty));
}

/** Coverage of a repeating stripe pattern by a pixel `w` wide (exact, so alias-free). */
function stripes(x: F, period: F | number, duty: F | number, w: F): F {
  const half = w.mul(0.5);
  return stripeIntegral(x.add(half), period, duty)
    .sub(stripeIntegral(x.sub(half), period, duty))
    .div(w);
}

/**
 * Bit `k` (0-based) of a small integer stored in a float. Rounded first: a per-vertex constant
 * comes out of interpolation a hair off (13 as 12.99999), which would flip bits per pixel.
 */
function bit(mask: F, k: F): F {
  return mod(floor(floor(mask.add(0.5)).div(pow(2, k)).add(1e-3)), 2);
}

/** Textures shared by every airport. */
export class SurfaceTextures {
  readonly noise: DataTexture;
  readonly glyphs: DataTexture;

  constructor() {
    this.noise = new DataTexture(
      buildNoiseTexels(),
      NOISE_SIZE,
      NOISE_SIZE,
      RGBAFormat,
      UnsignedByteType,
    );
    this.noise.wrapS = this.noise.wrapT = RepeatWrapping;
    this.noise.magFilter = LinearFilter;
    this.noise.minFilter = LinearMipmapLinearFilter;
    this.noise.generateMipmaps = true;
    this.noise.colorSpace = NoColorSpace;
    this.noise.needsUpdate = true;
    const atlas = buildGlyphAtlas();
    this.glyphs = new DataTexture(
      atlas.data,
      atlas.width,
      atlas.height,
      RedFormat,
      UnsignedByteType,
    );
    this.glyphs.wrapS = this.glyphs.wrapT = ClampToEdgeWrapping;
    // A distance field is interpolated, never mipmapped: far away the shader fades the glyph
    // to its average instead.
    this.glyphs.magFilter = LinearFilter;
    this.glyphs.minFilter = LinearFilter;
    this.glyphs.generateMipmaps = false;
    this.glyphs.colorSpace = NoColorSpace;
    this.glyphs.needsUpdate = true;
  }

  dispose() {
    this.noise.dispose();
    this.glyphs.dispose();
  }
}

/** Albedos (linear) of the ground materials. */
const ASPHALT = vec3(0.068, 0.068, 0.072);
const CONCRETE = vec3(0.34, 0.33, 0.31);
const RUBBER = vec3(0.03, 0.03, 0.032);
const PAINT_WHITE = vec3(0.72, 0.72, 0.7);
const PAINT_YELLOW = vec3(0.62, 0.42, 0.04);

function surfaceBase(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.transparent = true;
  // Nothing writes depth: the surfaces are decals on the terrain, drawn in a fixed order, and
  // the depth the haze needs is the terrain's own (the same place).
  m.depthWrite = false;
  m.depthTest = true;
  m.metalnessNode = float(0);
  m.vertexNode = pulledVertex(positionLocal);
  m.fog = false;
  return m;
}

/** Fine grain, patches and their average, in [about -1, 1], from the noise texture. */
function grain(tex: DataTexture, p: V2) {
  const fine = texture(tex, p.div(0.37)).r.sub(0.5);
  const mid = texture(tex, p.div(2.9)).r.sub(0.5);
  const big = texture(tex, p.div(57)).a.sub(0.5);
  return { fine, mid, big };
}

/** The runway material (paved runways; one mesh per airport, parameters per vertex). */
export function createRunwayMaterial(t: SurfaceTextures): MeshStandardNodeMaterial {
  const m = surfaceBase();
  const st = attribute('st', 'vec2') as unknown as V2;
  const rw = (i: number) => attribute(`rw${i}`, 'vec4') as unknown as V4;
  const rw0 = rw(0);
  const s = st.x;
  const tt = st.y;
  const L = rw0.x;
  const W = rw0.y;
  const centreW = rw0.z;
  const edgeW = rw0.w;
  const fs = max(fwidth(s), 1e-3);
  const ft = max(fwidth(tt), 1e-3);
  const footprint = max(fs, ft);

  /**
   * Paint seen from one end: a = metres past its landing threshold, x = metres right of the
   * centre line in its landing direction.
   */
  const endPaint = (a: F, x: F, p1: V4, p2: V4, p3: V4) => {
    const thr = p1.x;
    const perSide = p1.y;
    const unit = p1.z;
    const mask = p1.w;
    const ax = abs(x);
    // Threshold stripes: stripes and gaps of `unit`, the centre gap doubled.
    const across = stripes(ax.sub(unit), unit.mul(2), unit, ft).mul(
      box(ax, unit, unit.mul(perSide.mul(2)), ft),
    );
    let paint = across.mul(box(a, STRIPES_START, STRIPES_START + STRIPES_LENGTH, fs));
    // Displaced threshold: a transverse bar, and arrows on the centre line before it.
    const displaced = smoothstep(0.5, 1, thr);
    paint = max(paint, box(a, -THRESHOLD_BAR, 0, fs).mul(displaced));
    const u = mod(a.negate().sub(12), 30); // metres before the next arrow tip
    const shaft = box(ax, 0, 0.45, ft).mul(box(u, 6, 24, fs));
    const head = box(ax, u.mul(0.55).sub(0.5), u.mul(0.55).add(0.5), ft).mul(box(u, 0, 7, fs));
    const arrows = max(shaft, head)
      .mul(box(a, thr.negate().add(10), -11, fs))
      .mul(displaced);
    paint = max(paint, arrows);
    // Aiming point.
    const aimOn = smoothstep(0.5, 1, p2.y);
    const inner = select(
      aimOn.greaterThan(0.5),
      p2.w.mul(0.5),
      select(W.greaterThanEqual(30), 9, 4.5),
    );
    paint = max(
      paint,
      box(a, p2.x, p2.x.add(p2.y), fs)
        .mul(box(ax, inner, inner.add(p2.z), ft))
        .mul(aimOn),
    );
    // Touchdown zone: 3, 3, 2, 2, 1, 1 stripes per side every 150 m.
    const slot = floor(a.div(TDZ_SPACING)).sub(1);
    const local = a.sub(slot.add(1).mul(TDZ_SPACING));
    const count = select(slot.lessThan(2), 3, select(slot.lessThan(4), 2, 1));
    const present = select(
      slot.greaterThanEqual(0).and(slot.lessThan(6)),
      bit(mask, max(slot, 0)),
      0,
    );
    // As many stripes as fit inside the side stripe of a narrow runway.
    const room = floor(
      W.mul(0.5)
        .sub(edgeW)
        .sub(0.5)
        .sub(inner)
        .add(TDZ_GAP)
        .div(TDZ_STRIPE + TDZ_GAP),
    );
    const stripesHere = max(min(count, room), 1);
    const tdzAcross = stripes(ax.sub(inner), TDZ_STRIPE + TDZ_GAP, TDZ_STRIPE, ft).mul(
      box(ax, inner, inner.add(stripesHere.mul(TDZ_STRIPE + TDZ_GAP)).sub(TDZ_GAP), ft),
    );
    paint = max(paint, tdzAcross.mul(box(local, 0, TDZ_LENGTH, fs)).mul(present));
    // Designator: digits (and a letter for parallel runways), 9 m high, read from the approach.
    const hasLetter = p3.z.greaterThanEqual(0);
    const letterRow = hasLetter
      .and(a.greaterThan(DESIGNATOR_START - 1))
      .and(a.lessThan(DESIGNATOR_START + GLYPH_HEIGHT + 1));
    const numberStart = select(
      hasLetter,
      DESIGNATOR_START + GLYPH_HEIGHT + LETTER_GAP,
      DESIGNATOR_START,
    );
    const halfNumber = GLYPH_WIDTH + GLYPH_GAP / 2;
    const glyph = floor(select(letterRow, p3.z, select(x.lessThan(0), p3.x, p3.y)).add(0.5));
    const x0 = select(
      letterRow,
      -GLYPH_WIDTH / 2,
      select(x.lessThan(0), -halfNumber, GLYPH_GAP / 2),
    );
    const a0 = select(letterRow, float(DESIGNATOR_START), numberStart);
    const gx = clamp(x.sub(x0), -ATLAS_PAD, GLYPH_WIDTH + ATLAS_PAD);
    const gy = clamp(a.sub(a0), -ATLAS_PAD, GLYPH_HEIGHT + ATLAS_PAD);
    const atlasW = CELL_W * GLYPH_COUNT;
    const uvAtlas = vec2(
      max(glyph, 0).mul(CELL_W).add(gx.add(ATLAS_PAD).mul(ATLAS_RES)).div(atlasW),
      gy.add(ATLAS_PAD).mul(ATLAS_RES).div(CELL_H),
    );
    const dist = float(0.5)
      .sub(texture(t.glyphs, uvAtlas).r)
      .mul(2 * ATLAS_RANGE);
    const inBox = box(a, a0.sub(0.5), a0.add(GLYPH_HEIGHT + 0.5), fs)
      .mul(
        select(
          letterRow,
          box(x, -GLYPH_WIDTH / 2 - 0.5, GLYPH_WIDTH / 2 + 0.5, ft),
          box(ax, 0, halfNumber + 0.5, ft),
        ),
      )
      .mul(select(glyph.greaterThanEqual(0), 1, 0));
    // Antialiased by the distance field's own screen gradient (sharp across, soft along at
    // grazing angles); once the 0.9 m strokes are below a pixel, the glyph's average.
    const sharp = clamp(float(0.5).sub(dist.div(max(fwidth(dist), 1e-3))), 0, 1);
    const glyphCov = mix(sharp, float(0.22), smoothstep(0.5, 1.5, footprint)).mul(inBox);
    paint = max(paint, glyphCov);
    return paint;
  };

  const rA1 = rw(1);
  const rA2 = rw(2);
  const rA3 = rw(3);
  const rB1 = rw(4);
  const rB2 = rw(5);
  const rB3 = rw(6);
  const aA = s.sub(rA1.x);
  const aB = L.sub(s).sub(rB1.x);
  let paint = max(endPaint(aA, tt, rA1, rA2, rA3), endPaint(aB, tt.negate(), rB1, rB2, rB3));
  // Centre line: between the designators, 30 m stripes and 20 m gaps.
  const clStart = rA1.x.add(DESIGNATOR_START + 2 * GLYPH_HEIGHT + LETTER_GAP + 6);
  const clEnd = L.sub(rB1.x).sub(DESIGNATOR_START + 2 * GLYPH_HEIGHT + LETTER_GAP + 6);
  const centre = box(tt, centreW.mul(-0.5), centreW.mul(0.5), ft)
    .mul(stripes(s.sub(clStart), CENTRE_PERIOD, CENTRE_STRIPE, fs))
    .mul(box(s, clStart, clEnd, fs));
  paint = max(paint, centre);
  // Side stripes along both edges.
  const absT = abs(tt);
  paint = max(paint, box(absT, W.mul(0.5).sub(edgeW), W.mul(0.5), ft).mul(box(s, 0, L, fs)));

  // ---- Pavement ----
  const g = grain(t.noise, st);
  const near = float(1).sub(smoothstep(30, 400, footprint.mul(1000)));
  const concrete = rA3.w;
  let albedo: V3 = mix(ASPHALT, CONCRETE, concrete);
  albedo = albedo.mul(
    float(1).add(g.big.mul(0.35)).add(g.mid.mul(0.25)).add(g.fine.mul(0.45).mul(near)),
  );
  // Concrete slabs: joints every 5 m along and across.
  const joints = max(
    stripes(s.add(0.03), 5, 0.06, fs),
    stripes(tt.add(W.mul(0.5)).add(0.03), 5, 0.06, ft),
  ).mul(concrete);
  albedo = albedo.mul(float(1).sub(joints.mul(0.45)));
  // Tyre rubber in both touchdown zones, in two bands either side of the centre line.
  const zone = (a: F) => smoothstep(40, 160, a).mul(float(1).sub(smoothstep(450, 1000, a)));
  const band = exp(pow(absT.sub(3.6).div(2.6), 2).negate());
  const streak = texture(t.noise, vec2(s.div(41), tt.div(0.9))).r;
  const rubber = clamp(max(zone(aA), zone(aB)).mul(band).mul(streak.mul(1.6).sub(0.1)), 0, 0.85);
  albedo = mix(albedo, RUBBER, rubber);
  // Worn paint: grain and rubber show through.
  const wear = clamp(float(0.8).add(g.fine.mul(0.5)).add(g.mid.mul(0.3)), 0, 1);
  paint = paint.mul(mix(float(1), wear, near)).mul(float(1).sub(rubber.mul(0.7)));
  albedo = mix(albedo, PAINT_WHITE, paint);

  // Antialiased pavement edge (the mesh reaches EDGE_MARGIN beyond it).
  const edge = min(W.mul(0.5).sub(absT), min(s, L.sub(s)));
  const alpha = clamp(edge.div(max(fwidth(edge), 1e-3)).add(0.5), 0, 1);
  m.colorNode = vec4(albedo, alpha);
  m.roughnessNode = mix(float(0.92), float(0.75), paint).sub(rubber.mul(0.1));
  return m;
}

/** Aprons, taxiways and grass strips (the ground mesh), without their painted lines. */
export function createGroundMaterial(t: SurfaceTextures): MeshStandardNodeMaterial {
  const m = surfaceBase();
  const st = attribute('st', 'vec2') as unknown as V2;
  const ground = attribute('ground', 'vec3') as unknown as V3;
  const kind = ground.x;
  const half = ground.y;
  const length = ground.z;
  const p = positionLocal.xz as unknown as V2;
  const g = grain(t.noise, p);
  const near = float(1).sub(smoothstep(0.03, 0.4, max(fwidth(p.x), fwidth(p.y))));
  const isApron = kind.lessThan(GROUND_APRON + 0.5);
  const isTaxi = kind.greaterThan(GROUND_TAXIWAY - 0.5).and(kind.lessThan(GROUND_TAXIWAY + 0.5));
  const isGrass = kind.greaterThan(GROUND_GRASS - 0.5).and(kind.lessThan(GROUND_GRASS + 0.5));
  const isHold = kind.greaterThan(GROUND_HOLD - 0.5);
  const fx = max(fwidth(p.x), 1e-3);
  const fz = max(fwidth(p.y), 1e-3);
  // Apron: concrete slabs, joints every 5 m on the airport grid.
  const joints = max(stripes(p.x.add(0.03), 5, 0.06, fx), stripes(p.y.add(0.03), 5, 0.06, fz));
  const apron = CONCRETE.mul(
    float(0.92).add(g.big.mul(0.3)).add(g.mid.mul(0.2)).add(g.fine.mul(0.3).mul(near)),
  ).mul(float(1).sub(joints.mul(0.4)));
  const taxi = ASPHALT.mul(
    float(1.05).add(g.big.mul(0.35)).add(g.mid.mul(0.25)).add(g.fine.mul(0.45).mul(near)),
  );
  // Grass strip: mown in lanes along the runway, lighter and darker, over the photo's own grass.
  const ft = max(fwidth(st.y), 1e-3);
  const fs = max(fwidth(st.x), 1e-3);
  const lanes = stripes(st.y.add(half), 7, 3.5, ft);
  const grass = mix(vec3(0.05, 0.09, 0.025), vec3(0.11, 0.16, 0.05), lanes).mul(
    float(1).add(g.mid.mul(0.4)),
  );
  const albedo = select(isApron, apron, select(isTaxi, taxi, grass));
  const edgeAcross = half.sub(abs(st.y));
  const edgeTaxi = clamp(edgeAcross.div(ft).add(0.5), 0, 1);
  const edgeGrass = clamp(
    min(edgeAcross, min(st.x, length.sub(st.x)))
      .div(max(ft, fs))
      .add(0.5),
    0,
    1,
  );
  const alpha = select(
    isHold,
    0,
    select(isApron, 1, select(isTaxi, edgeTaxi, edgeGrass.mul(0.22))),
  );
  m.colorNode = vec4(albedo, alpha);
  m.roughnessNode = select(isGrass, 0.95, 0.9);
  return m;
}

/** The painted lines of the ground mesh: taxiway centre lines and holding positions. */
export function createLineMaterial(t: SurfaceTextures): MeshStandardNodeMaterial {
  const m = surfaceBase();
  const st = attribute('st', 'vec2') as unknown as V2;
  const ground = attribute('ground', 'vec3') as unknown as V3;
  const kind = ground.x;
  const half = ground.y;
  const fs = max(fwidth(st.x), 1e-3);
  const ft = max(fwidth(st.y), 1e-3);
  const isTaxi = kind.greaterThan(GROUND_TAXIWAY - 0.5).and(kind.lessThan(GROUND_TAXIWAY + 0.5));
  const isHold = kind.greaterThan(GROUND_HOLD - 0.5);
  // Taxiway centre line: 15 cm, yellow.
  const centre = box(st.y, -0.075, 0.075, ft);
  // Pattern A: two solid lines (holding side), then two dashed ones (runway side).
  const solid = max(box(st.x, 0, 0.15, fs), box(st.x, 0.3, 0.45, fs));
  const dashedRows = max(box(st.x, 0.6, 0.75, fs), box(st.x, 0.9, 1.05, fs));
  const dashes = stripes(st.y.add(half), 2, 1, ft);
  const hold = max(solid, dashedRows.mul(dashes)).mul(box(abs(st.y), 0, half, ft));
  const n = texture(t.noise, (positionLocal.xz as unknown as V2).div(0.6)).r;
  const coverage = select(isTaxi, centre, select(isHold, hold, 0)).mul(float(0.8).add(n.mul(0.25)));
  m.colorNode = vec4(PAINT_YELLOW, clamp(coverage, 0, 1));
  m.roughnessNode = float(0.75);
  return m;
}
