import type { WorldConditions } from '../layers';
import {
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardNodeMaterial,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  type Node,
  type Texture,
  type TextureNode,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu';
import {
  abs,
  asin,
  attribute,
  cos,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  dot,
  float,
  floor,
  fwidth,
  length,
  materialReference,
  max,
  min,
  mix,
  mod,
  modelWorldMatrix,
  normalWorldGeometry,
  normalize,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { type Ops, seasonColor, seasonSnowAmount, snowCover } from './groundMath';
import { GROUND_SETTINGS, type GroundSettings } from './groundSettings';
import { HORIZON_DIRS, HORIZON_STEPS_PER_DEG, directionWeights } from './horizon';
import { NOISE_SIZE, NOISE_SLOPE_SCALE, buildNoiseTexels } from './noise';
import { MASK_B_RUNWAY } from './protocol';
import { ROAD_MAX_HALF, ROAD_RANGE } from './roads';

/**
 * Detail patterns repeat every DETAIL_PERIOD metres. The render origin moves (floating origin),
 * so the pattern is anchored with an offset taken modulo this period; every noise scale below
 * divides it, so the wrap is invisible.
 */
export const DETAIL_PERIOD = 4096;

/** Switches per quality level; each costs shader work. */
export interface TerrainLook {
  /** Procedural close-up detail (albedo and normal) where the orthophoto gets blurry. */
  detail: boolean;
  /** Lakes and rivers as a water surface (waves, Fresnel, sky reflection). */
  water: boolean;
}

/** Tile textures are per tile; the node graph is shared, so all tiles share one shader. */
export class TerrainNodeMaterial extends MeshStandardNodeMaterial {
  tileImage: Texture | null = null;
  tileMask: Texture | null = null;
  /** Lights and road field (see lights.ts, roads.ts). */
  tileGround: Texture | null = null;
  /** Horizon angles in eight directions (see horizon.ts). */
  tileHorizon: Texture | null = null;
  /** Luminance (cd/m²) of a full byte in the lamp and glow channels of tileGround. */
  tileLightScale = new Vector2();
}

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** groundMath's arithmetic on shader nodes: the same code as the CPU twin. */
const nodeOps: Ops<F> = {
  k: (v) => float(v),
  add: (a, b) => a.add(b),
  sub: (a, b) => a.sub(b),
  mul: (a, b) => a.mul(b),
  div: (a, b) => a.div(b),
  min: (a, b) => min(a, b),
  max: (a, b) => max(a, b),
  clamp: (x, lo, hi) => clamp(x, lo, hi),
  // GLSL leaves a falling smoothstep undefined: flip it explicitly.
  smooth: (e0, e1, x) => (e0 <= e1 ? smoothstep(e0, e1, x) : float(1).sub(smoothstep(e1, e0, x))),
  mix: (a, b, t) => mix(a, b, t),
};

/** Linear-RGB colours of street lighting, scaled to luminance 1. */
const SODIUM = new Color(1.0, 0.42, 0.1);
const LED_WARM = new Color(1.0, 0.7, 0.42);
const LED_COOL = new Color(0.85, 0.9, 1.0);
const unitLuminance = (c: Color) =>
  c.clone().multiplyScalar(1 / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b));
/** The sky's radiance unit is the sun's illuminance (128 klx = 1); lamps are in cd/m². */
const SKY_UNITS_PER_NIT = 1 / 128_000;

/**
 * The terrain look. Orthophotos (SWISSIMAGE) are the albedo, but they are photographs: sunlit
 * meadows come out around 0.08 in linear terms where real grass reflects about 0.2, and the
 * sun of the flight day already shaded every slope. The photo is therefore first relieved of
 * the shading of its own sun (estimated from the terrain's normal), then mapped to albedo with
 * a soft compressive curve on luminance (dark and mid tones gain about 2.5x, snow stays below
 * 0.9); the darkest cast shadows are lifted a little, so our own lighting does not shade them
 * a second time into black. Hue and saturation are kept.
 *
 * On top: the season (colours of the land, snow above the snow line), the lights of the night
 * baked per tile, mountain shadows and sky occlusion from the baked horizon, crisp roads and
 * procedural detail close to the ground.
 */
export class TerrainMaterials {
  readonly uniforms = {
    /** Render-space x/z of a fixed ground point, modulo DETAIL_PERIOD (see World.setFrame). */
    detailOrigin: uniform(new Vector2()),
    skyZenith: uniform(new Color(0.12, 0.3, 0.7)),
    skyHorizon: uniform(new Color(0.62, 0.76, 0.92)),
    /** Albedo of deep water, linear. */
    waterColor: uniform(new Color(0.012, 0.035, 0.04)),
    albedoGain: uniform(2.6),
    shadowLift: uniform(0.7),
    /** Distance (m) where the detail is fully faded in, and where it is gone. */
    detailNear: uniform(120),
    detailFar: uniform(1400),

    // ---- Conditions (setConditions) ----
    /** 0 by day .. 1 at night: lamps on. */
    night: uniform(0),
    /** The sky's pre-exposure (emission is multiplied by it). */
    exposure: uniform(1),
    /** Share of spring, autumn and winter in the look of the land (summer: all 0). */
    season: uniform(new Vector3()),
    snowLine: uniform(2900),
    /** How much of the computed snow is shown (0 in summer: the photos' own snow only). */
    snowAmount: uniform(0),
    /** Towards the sun (or the moon), render space. */
    lightDir: uniform(new Vector3(0, 1, 0)),
    /** Weights of the eight horizon directions for the light's azimuth. */
    horizonA: uniform(new Vector4()),
    horizonB: uniform(new Vector4()),
    /** How much of the sky the water reflects (the colours set by setSkyColors are a day sky). */
    skyReflect: uniform(1),

    // ---- Tuning (1 = on) ----
    /** Brightness of the lamps relative to the physical model. */
    lampGain: uniform(0.035),
    /** Exposed luminance where the lamps' brightness starts to saturate. */
    lampKnee: uniform(4),
    /** Removing the orthophoto's own sun shading. */
    deshade: uniform(1),
    /** Mountain shadows and sky occlusion from the horizon. */
    horizonShadow: uniform(1),
    /** Road ribbons close up. */
    roads: uniform(1),
  };
  readonly noise: DataTexture;
  private nodes?: Pick<
    TerrainNodeMaterial,
    'colorNode' | 'normalNode' | 'roughnessNode' | 'metalnessNode' | 'emissiveNode' | 'aoNode'
  > & { receivedShadowNode: (shadow: F) => F };
  private ground: GroundSettings = GROUND_SETTINGS.desktop;
  private readonly weights = new Array<number>(HORIZON_DIRS);
  private readonly seasonTarget = new Vector3();
  private lastTime = -1;

  constructor(readonly look: TerrainLook) {
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
  }

  /** What the tiles carry (from the device preset); call before the first create(). */
  configure(ground: GroundSettings) {
    this.ground = ground;
    // The detail is seen at grazing angles from low down: anisotropic filtering keeps it sharp
    // there instead of fading it to its average.
    this.noise.anisotropy = ground.noiseAnisotropy;
  }

  /**
   * The light and the season the ground is shown in (snow line, autumn colours, lights at
   * night). Called every frame; cheap.
   */
  setConditions(c: WorldConditions) {
    const u = this.uniforms;
    u.night.value = c.night;
    u.exposure.value = c.exposure;
    u.snowLine.value = c.snowLine;
    u.snowAmount.value = seasonSnowAmount(c.snowLine);
    u.lightDir.value.copy(c.lightDirection).normalize();
    // A day sky in the water by day only; the moon's glint comes from the light itself.
    u.skyReflect.value = (1 - c.night) ** 2;
    // Seasons blend over a few seconds when changed during a flight, and jump at the start.
    this.seasonTarget.set(
      c.season === 'spring' ? 1 : 0,
      c.season === 'autumn' ? 1 : 0,
      c.season === 'winter' ? 1 : 0,
    );
    const dt = this.lastTime < 0 ? Infinity : Math.max(0, c.time - this.lastTime);
    this.lastTime = c.time;
    u.season.value.lerp(this.seasonTarget, Math.min(1, dt / 3));
    // The light's azimuth in render space (x east, z south), clockwise from north.
    const L = c.lightDirection;
    directionWeights(Math.atan2(L.x, -L.z), this.weights);
    const w = this.weights;
    u.horizonA.value.set(w[0]!, w[1]!, w[2]!, w[3]!);
    u.horizonB.value.set(w[4]!, w[5]!, w[6]!, w[7]!);
  }

  /** A material for one tile: its own textures, the shared node graph. */
  create(
    image: Texture,
    mask: Texture,
    ground: Texture,
    horizon: Texture,
    lightScale: [number, number],
  ): TerrainNodeMaterial {
    this.nodes ??= this.buildNodes();
    const m = new TerrainNodeMaterial();
    m.tileImage = image;
    m.tileMask = mask;
    m.tileGround = ground;
    m.tileHorizon = horizon;
    m.tileLightScale.set(lightScale[0], lightScale[1]);
    Object.assign(m, this.nodes);
    m.fog = false;
    return m;
  }

  dispose() {
    this.noise.dispose();
  }

  private buildNodes() {
    const u = this.uniforms;
    const o = nodeOps;
    const roadsBaked = this.ground.groundChannels === 4;
    // Per-tile textures: resolved from the drawn material, so every tile shares one shader.
    const tileTexture = (name: string, at?: Node<'vec2'>) => {
      const ref = materialReference(name, 'texture') as unknown as { node: TextureNode | null };
      // The reference resolves to its inner texture node; given one up front, it samples at
      // `at` (the texture itself is still the drawn material's).
      if (at) ref.node = texture(null as unknown as Texture, at) as unknown as TextureNode;
      return ref as unknown as Node<'vec4'>;
    };
    const photoRaw = tileTexture('tileImage').rgb;
    const mask = tileTexture('tileMask');
    const groundTex = tileTexture('tileGround');
    const lightScale = materialReference('tileLightScale', 'vec2') as unknown as Node<'vec2'>;
    const water = this.look.water ? smoothstep(0.35, 0.65, mask.r).toVar() : float(0);
    const land = float(1).sub(water);

    // ---- The tile's frame and the terrain's shape ----
    const tileUp = normalize(modelWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz);
    const tileSouth = normalize(modelWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz);
    const nGeo = normalWorldGeometry;
    const up = dot(nGeo, tileUp);
    const slope = float(1).sub(up); // 1 - cos(slope angle)
    const elevation = attribute('elevation', 'float');

    // ---- Horizon: mountain shadows and sky occlusion ----
    const H = this.ground.horizonSize;
    const tileUv = uv();
    const hu = tileUv.x.mul((H - 1) / (2 * H)).add(0.5 / (2 * H));
    const hv = tileUv.y.mul((H - 1) / H).add(0.5 / H);
    const hScale = 255 / HORIZON_STEPS_PER_DEG;
    const hA = tileTexture('tileHorizon', vec2(hu, hv)).mul(hScale);
    const hB = tileTexture('tileHorizon', vec2(hu.add(0.5), hv)).mul(hScale);
    const horizonDeg = dot(hA, u.horizonA).add(dot(hB, u.horizonB));
    const lightDeg = asin(clamp(dot(u.lightDir, tileUp), -1, 1)).mul(180 / Math.PI);
    // Half a degree of penumbra for the sun's disc and the interpolated horizon.
    const lit = smoothstep(horizonDeg.sub(0.6), horizonDeg.add(1.4), lightDeg);
    const shadowFactor = mix(float(1), lit, u.horizonShadow).toVar();
    const rad = Math.PI / 180;
    const sA = sin(hA.mul(rad));
    const sB = sin(hB.mul(rad));
    const skyView = float(1).sub(dot(sA.mul(sA), vec4(0.125)).add(dot(sB.mul(sB), vec4(0.125))));
    const hollow = smoothstep(0.9, 0.65, skyView);

    // ---- Photo -> albedo ----
    // The orthophoto's sun: flown around noon in summer, from the south at about 55°.
    const photoSun = normalize(tileUp.mul(0.82).add(tileSouth.mul(0.57)));
    const photoShade = float(0.38).add(max(dot(nGeo, photoSun), 0).mul(0.62 / 0.82));
    const deshade = mix(float(1), clamp(float(1).div(photoShade), 0.8, 2.3), u.deshade);
    const photo = photoRaw.mul(deshade);
    const lum = dot(photo, vec3(0.2126, 0.7152, 0.0722));
    const g = u.albedoGain;
    const mapped = lum.mul(g).div(lum.mul(g.sub(1)).div(0.9).add(1));
    const deep = float(1)
      .sub(smoothstep(0.004, 0.03, lum))
      .mul(u.shadowLift);
    const lifted = mix(mapped, max(mapped, 0.06), deep);
    const scaled = photo.mul(lifted.div(max(lum, 1e-4)));
    const photoAlbedo = min(scaled, vec3(0.92));
    const albLum = dot(photoAlbedo, vec3(0.2126, 0.7152, 0.0722));

    // ---- What the ground is (weights), from the photo, the land-cover mask and the shape ----
    const maxC = max(photo.r, max(photo.g, photo.b));
    const minC = min(photo.r, min(photo.g, photo.b));
    const sat = maxC.sub(minC).div(max(maxC, 1e-3));
    const greenLead = photo.g.sub(max(photo.r, photo.b)).div(max(lum, 1e-3));
    const grey = float(1).sub(smoothstep(0.12, 0.32, sat));
    const forest = max(mask.g, smoothstep(0.05, 0.025, lum).mul(smoothstep(0.0, 0.2, greenLead)))
      .mul(land)
      .toVar();
    const glacier = smoothstep(0.85, 0.95, mask.b);
    const photoSnow = max(
      glacier,
      smoothstep(0.32, 0.5, lum)
        .mul(grey)
        .mul(smoothstep(1400, 2100, elevation)),
    )
      .mul(land)
      .toVar();
    const rock = max(smoothstep(0.22, 0.42, slope), smoothstep(1900, 2500, elevation).mul(grey))
      .mul(float(1).sub(forest))
      .mul(float(1).sub(photoSnow))
      .mul(land)
      .toVar();
    const field = smoothstep(-0.04, 0.06, photo.r.sub(photo.g).div(max(lum, 1e-3)))
      .mul(float(1).sub(forest))
      .mul(float(1).sub(rock))
      .mul(float(1).sub(photoSnow))
      .mul(land)
      .toVar();
    const veg = smoothstep(0.02, 0.14, greenLead)
      .mul(smoothstep(0.06, 0.2, sat))
      .mul(land);

    // ---- Noise ----
    const toCamera = cameraPosition.sub(positionWorld);
    const dist = length(toCamera);
    const p = positionWorld.xz.add(u.detailOrigin);
    const sample = (period: number) => texture(this.noise, p.div(period));
    const slopeOf = (s: ReturnType<typeof sample>, period: number, amp: number) =>
      s.gb
        .sub(0.5)
        .div(NOISE_SLOPE_SCALE * period)
        .mul(amp);
    const v = (s: ReturnType<typeof sample>) => s.r.sub(0.5).mul(2.5);
    const huge = sample(2048);
    const wide = sample(256);
    const big = sample(64);
    const mid = sample(8);

    // ---- Season below the snow ----
    // Broadleaf canopy is lighter and yellower in the summer photo than spruce and fir (whose
    // albedo maps to about 0.08); above 1100 m the forest is mostly conifer.
    const yellowGreen = photo.g.sub(photo.b).div(max(photo.g, 1e-3));
    const broadleaf = smoothstep(0.1, 0.2, albLum)
      .mul(smoothstep(0.3, 0.55, yellowGreen))
      .mul(float(1).sub(smoothstep(1100, 1500, elevation)));
    const larch = smoothstep(1450, 1750, elevation)
      .mul(float(1).sub(smoothstep(2150, 2350, elevation)))
      .mul(smoothstep(0.4, 0.6, wide.a));
    const seasonal = seasonColor(
      o,
      [photoAlbedo.r, photoAlbedo.g, photoAlbedo.b],
      {
        veg,
        forest,
        broadleaf,
        larch,
        soil: field.mul(float(1).sub(veg)),
      },
      { spring: u.season.x, autumn: u.season.y, winter: u.season.z },
      {
        crown: clamp(v(mid), -1, 1),
        plot: clamp(wide.a.sub(0.5).mul(3), -1, 1),
        patch: clamp(v(wide).mul(0.7).add(huge.a.sub(0.5).mul(1.5)), -1, 1),
      },
    );
    let albedo: V3 = vec3(seasonal[0], seasonal[1], seasonal[2]).toVar();

    // ---- Roads (close up, desktop) ----
    let road: F = float(0);
    const roadFade = float(1)
      .sub(smoothstep(250, 600, dist))
      .mul(u.roads)
      .mul(land);
    if (roadsBaked) {
      const d = groundTex.b.mul(ROAD_RANGE);
      const info = floor(groundTex.a.mul(255).add(0.5));
      const paved = smoothstep(126, 130, info);
      const code = info.sub(paved.mul(128)).sub(1);
      const half = floor(code.div(2)).div(60).mul(ROAD_MAX_HALF);
      const marked = mod(code, 2);
      const has = smoothstep(0.5, 1.5, info);
      const aa = max(fwidth(d), 0.04);
      road = smoothstep(half.add(aa), half.sub(aa), d).mul(has).mul(roadFade).toVar();
      // Swiss markings: white edge lines 15 cm wide, 40 cm in from the edge, and a centre line.
      const lineAt = (centre: F) =>
        smoothstep(float(0.075).add(aa), float(0.075).sub(aa).max(0), abs(d.sub(centre)));
      const roadLine = max(lineAt(half.sub(0.45)), lineAt(float(0)))
        .mul(marked)
        .mul(smoothstep(2.4, 3.0, half))
        .mul(road)
        .toVar();
      // Asphalt: dark grey, worn lighter in the wheel tracks, the photo's own patches kept
      // faintly; gravel: the photo's colour, lighter and grainy.
      const asphalt = vec3(0.085, 0.085, 0.09).mul(
        float(0.82).add(clamp(albLum.div(0.2), 0.4, 1.4).mul(0.18)),
      );
      const gravel = mix(photoAlbedo, vec3(0.32, 0.29, 0.24), 0.5);
      albedo = mix(albedo, mix(gravel, asphalt, paved), road);
      albedo = mix(albedo, vec3(0.75, 0.75, 0.72), roadLine);
    }

    // ---- Snow ----
    const coverSite = snowCover(o, {
      elevation,
      snowLine: u.snowLine,
      up,
      north: dot(nGeo, tileSouth).negate(),
      hollow,
      noiseLine: clamp(huge.r.sub(0.5).mul(2.5).add(v(wide).mul(0.3)), -1, 1),
      noisePatch: clamp(v(big).mul(0.7).add(v(mid).mul(0.4)), -1, 1),
    });
    // Forest keeps its dark canopy with snow on the crowns and in the gaps; bare broadleaf
    // woods show more of the white floor.
    const gaps = smoothstep(0.14, 0.28, albLum);
    const forestSnow = float(0.18).add(gaps.mul(0.45)).add(broadleaf.mul(u.season.z).mul(0.2));
    // Small high lakes freeze in winter and carry snow; lakes and rivers below stay open.
    const frozen = water.mul(smoothstep(1300, 1600, elevation));
    const snow = coverSite.cover
      .mul(mix(float(1), forestSnow, forest))
      .mul(max(land, frozen))
      .mul(float(1).sub(road))
      .mul(u.snowAmount)
      .toVar();
    const snowDepth = coverSite.depth;

    // ---- Close-up detail ----
    let nWorld: V3 = nGeo;
    const snowAll = max(snow, photoSnow);
    let roughness: F = mix(float(0.92), float(0.55), snowAll).sub(rock.mul(0.1));
    if (this.look.detail) {
      // Paved runways from the land-cover mask: smooth, fine-grained, no bumps.
      const paved = max(
        smoothstep(0.05, 0.02, abs(mask.b.sub(MASK_B_RUNWAY / 255))).mul(land),
        road,
      );
      const soft = float(1).sub(paved);
      const fade = float(1)
        .sub(smoothstep(u.detailNear, u.detailFar, dist))
        .mul(land)
        .toVar();
      // The finest layers only matter within a few dozen metres; further out they average out
      // in the mipmaps anyway, so they fade early and cost nothing visible.
      const closeFade = float(1)
        .sub(smoothstep(15, 180, dist))
        .mul(fade)
        .toVar();
      const fine = sample(2);
      const micro = sample(0.5);
      const nano = sample(0.25);
      const bare = float(1).sub(snowAll);
      // Within a few metres (beside a runway, after landing in a meadow): single blades.
      const nearFade = float(1)
        .sub(smoothstep(3, 20, dist))
        .mul(fade)
        .toVar();
      // Albedo variation per class: meadows are patchy and grainy, forest canopy is clumpy with
      // dark gaps, rock is grainy, fields fine-grained, snow nearly uniform, asphalt speckled.
      const grass = max(land.sub(forest).sub(rock).sub(photoSnow).sub(field), 0);
      const variation = grass
        .mul(v(big).mul(0.45).add(v(mid).mul(0.35)).add(v(fine).mul(0.3)))
        .add(field.mul(v(mid).mul(0.25).add(v(fine).mul(0.35))))
        .add(forest.mul(big.a.sub(0.5).mul(0.6).add(v(mid).mul(0.9))))
        .add(rock.mul(v(mid).mul(0.6).add(v(fine).mul(0.5))))
        .mul(bare)
        .add(snowAll.mul(v(big).mul(0.06)))
        .mul(soft)
        .add(paved.mul(v(big).mul(0.12)))
        .mul(fade);
      const grain = grass
        .add(field)
        .mul(0.6)
        .add(rock.mul(0.45))
        .mul(bare)
        .add(paved.mul(0.25))
        .add(snowAll.mul(0.05))
        .mul(v(micro))
        .mul(closeFade);
      albedo = albedo.mul(variation.add(grain).add(1));
      // Grass blades: bright and dark ones, and the shade between them.
      const growth = grass.add(field.mul(0.5)).mul(bare).mul(nearFade);
      const blades = v(nano).mul(0.6).add(v(micro).mul(0.3));
      const gaps = smoothstep(0.32, 0.18, nano.a);
      albedo = albedo.mul(float(1).add(growth.mul(blades.mul(0.55).sub(gaps.mul(0.45)))));

      // Rows of crops and furrows along the stripes the photo shows (mask alpha, rows.ts).
      const rowCode = mask.a.mul(255);
      const hasRows = smoothstep(0.5, 1.5, rowCode).mul(
        float(1).sub(smoothstep(254.5, 255, rowCode)),
      );
      const rowAngle = rowCode.sub(1).div(254).mul(Math.PI);
      const across = vec2(sin(rowAngle).negate(), cos(rowAngle));
      const rowPhase = dot(p, across).div(0.75);
      const rowAA = float(1).sub(smoothstep(0.2, 0.45, fwidth(rowPhase)));
      const rowW = hasRows
        .mul(field.add(grass.mul(0.6)))
        .mul(bare)
        .mul(float(1).sub(smoothstep(40, 160, dist)))
        .mul(rowAA)
        .mul(fade)
        .toVar();
      const rowWave = sin(rowPhase.mul(2 * Math.PI));
      albedo = albedo.mul(float(1).add(rowWave.mul(rowW).mul(0.22)));
      // Meadows shift between fresh and dry green in patches.
      const tint = mix(vec3(1.06, 1.0, 0.82), vec3(0.9, 1.02, 0.95), big.a);
      albedo = albedo.mul(mix(vec3(1), tint, grass.mul(fade).mul(bare)));
      const dh = slopeOf(mid, 8, 1)
        .mul(grass.mul(0.08).add(field.mul(0.05)).add(forest.mul(1.2)).add(rock.mul(0.9)))
        .add(
          slopeOf(fine, 2, 1).mul(
            grass.mul(0.04).add(field.mul(0.04)).add(rock.mul(0.18)).add(forest.mul(0.1)),
          ),
        )
        .mul(bare)
        // Snow: soft wind-blown drifts.
        .add(
          slopeOf(big, 64, 1.5)
            .add(slopeOf(mid, 8, 0.06))
            .mul(snowAll),
        )
        .mul(soft)
        .mul(fade)
        .add(
          slopeOf(micro, 0.5, 1)
            .mul(grass.add(field).mul(0.012).add(rock.mul(0.03)).mul(bare).add(snowAll.mul(0.02)))
            .mul(closeFade),
        );
      // Furrows 3 cm deep across the rows; blades tilt every which way.
      const furrow = across.mul(
        cos(rowPhase.mul(2 * Math.PI))
          .mul(rowW)
          .mul((0.03 * 2 * Math.PI) / 0.75),
      );
      const tilt = dh.add(furrow).add(slopeOf(nano, 0.25, 1).mul(growth).mul(0.008));
      nWorld = normalize(nWorld.sub(vec3(tilt.x, 0, tilt.y)));
      // Snow up close: crystals catch the sun in tiny glints.
      const glint = smoothstep(0.72, 0.85, micro.a).mul(closeFade).mul(snowAll);
      roughness = roughness
        .add(forest.mul(0.05))
        .sub(paved.mul(0.1))
        .sub(glint.mul(0.4))
        .add(road.mul(0.05));
    }
    // Snow: bright, a touch blue, the ground's texture showing through where it lies thin.
    const snowAlbedo = vec3(0.86, 0.89, 0.94).mul(
      mix(clamp(albLum.div(0.25), 0.75, 1.0), float(1), snowDepth),
    );
    albedo = mix(albedo, snowAlbedo, snow);

    // ---- Water ----
    let emissive: V3 = vec3(0);
    // How brightly open water mirrors the lit shore (baked into the glow channel there).
    let mirror: F = float(0);
    if (this.look.water) {
      const flow1 = vec2(1.1, 0.6).mul(time);
      const flow2 = vec2(-0.5, 0.9).mul(time);
      const w1 = texture(this.noise, p.add(flow1).div(32));
      const w2 = texture(this.noise, p.add(flow2).div(8));
      // Waves calm down with distance, where they would only shimmer.
      const calm = float(1).sub(smoothstep(800, 6000, dist).mul(0.7));
      const waves = slopeOf(w1, 32, 0.35)
        .add(slopeOf(w2, 8, 0.06))
        .mul(calm);
      const nWater = normalize(tileUp.sub(vec3(waves.x, 0, waves.y)));
      const open = water.mul(float(1).sub(snow));
      nWorld = normalize(mix(nWorld, nWater, open));
      const view = normalize(toCamera);
      const cosT = clamp(dot(nWater, view), 0, 1);
      const fresnel = float(0.02).add(pow(float(1).sub(cosT), 5).mul(0.98));
      const r = reflect(view.negate(), nWater);
      const sky = mix(u.skyHorizon, u.skyZenith, pow(clamp(r.y, 0, 1), 0.5));
      emissive = sky.mul(fresnel).mul(open).mul(u.skyReflect);
      // Shore lights stand on the horizon as seen from the water: only wave facets that send
      // the view ray out nearly level catch them, so the light breaks into glints that crowd
      // towards the shore and stretch towards the viewer, as on a real lake at night. Where the
      // waves are still resolved, crests and troughs break the band into dashes.
      const crests = smoothstep(0.42, 0.68, w1.r.add(w2.r).mul(0.5));
      const glitter = mix(float(1), crests.mul(2.6).add(0.15), calm.sub(0.3).div(0.7));
      // A rough surface still sends some of it up to a viewer high above (the 0.1 floor).
      mirror = fresnel
        .add(0.1)
        .mul(smoothstep(0.7, 0.03, r.y).mul(1.5))
        .add(fresnel.mul(smoothstep(0.1, 0.0, r.y)).mul(4))
        .mul(glitter)
        .mul(open);
      // The photo carries the real colour of each lake and river (green Aare, blue lakes); water
      // reflects little diffuse light, so it is darkened and mixed with a deep-water tone.
      albedo = mix(albedo, mix(u.waterColor, photoAlbedo.mul(0.45), 0.5), open);
      roughness = mix(roughness, float(0.06), open);
    }

    // ---- Lights of the night ----
    // Lamps (the luminaires seen from above) and the glow of lit ground; square-root coded.
    const lamps = groundTex.r.mul(groundTex.r).mul(lightScale.x);
    const glowL = groundTex.g.mul(groundTex.g).mul(lightScale.y);
    // Colours by quarter: old sodium lamps, warm and neutral LEDs; town centres whiter.
    const ledShare = smoothstep(0.35, 0.75, huge.a.add(v(wide).mul(0.15)));
    const coolShare = smoothstep(0.62, 0.8, wide.a).mul(ledShare);
    const lampColor = mix(
      mix(
        vec3(...unitLuminance(SODIUM).toArray()),
        vec3(...unitLuminance(LED_WARM).toArray()),
        ledShare,
      ),
      vec3(...unitLuminance(LED_COOL).toArray()),
      coolShare,
    );
    // Lit snow reflects much more of the lamps' light than asphalt and grass.
    const glowBoost = float(1).add(snowAll.mul(2.5));
    // The baked glow is smooth (lamp pools, windows of a quarter); the photo knows where the
    // streets and roofs are. Gardens, parks and trees stay darker, and blocks vary, so a town
    // reads as streets and houses rather than a lit polygon from any distance. About
    // energy-neutral over a typical quarter.
    const built = float(1).sub(veg).mul(float(1).sub(forest));
    // From afar the photo and the blocks blur away in the mipmaps: there the light gathers into
    // clusters of a hundred metres or two (centres, estates, industrial yards) instead.
    const clusters = mix(
      float(1),
      smoothstep(0.42, 0.62, huge.r).mul(2.2),
      smoothstep(4000, 25000, dist),
    );
    const structure = mix(float(0.3), float(1.45), built)
      .mul(float(0.6).add(smoothstep(0.3, 0.7, wide.a).mul(0.8)))
      .mul(clusters);
    const nits = lamps.mul(clusters).add(glowL.mul(land.mul(structure).mul(glowBoost).add(mirror)));
    // The sky exposes for the dark land around; over a town the eye adapts to the lights.
    // A soft knee keeps lit streets from burning out on a moonless night (exposure ~4e6)
    // while they stay plainly visible under a full moon (~6e4).
    const exposed = nits.mul(u.lampGain).mul(u.exposure).mul(SKY_UNITS_PER_NIT);
    const adapted = exposed.div(exposed.div(u.lampKnee).add(1));
    emissive = emissive.add(lampColor.mul(adapted).mul(u.night));

    const nView = normalize(cameraViewMatrix.mul(vec4(nWorld, 0)).xyz);
    const ao = mix(float(1), skyView, u.horizonShadow.mul(0.85));
    return {
      colorNode: vec4(albedo, 1),
      normalNode: nView,
      roughnessNode: clamp(roughness, 0.04, 1),
      metalnessNode: float(0),
      emissiveNode: emissive,
      aoNode: ao,
      receivedShadowNode: (shadow: F) => shadow.mul(shadowFactor),
    };
  }
}
