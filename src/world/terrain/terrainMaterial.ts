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
  UnsignedByteType,
  Vector2,
} from 'three/webgpu';
import {
  abs,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  dot,
  float,
  length,
  materialReference,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalWorldGeometry,
  normalize,
  positionWorld,
  pow,
  reflect,
  smoothstep,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { NOISE_SIZE, NOISE_SLOPE_SCALE, buildNoiseTexels } from './noise';
import { MASK_B_RUNWAY } from './protocol';

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
}

/**
 * The terrain look. Orthophotos (SWISSIMAGE) are the albedo, but they are photographs: sunlit
 * meadows come out around 0.08 in linear terms where real grass reflects about 0.2, and the
 * sun of the flight day already shaded every slope. The photo is therefore mapped to albedo
 * with a soft compressive curve on luminance (dark and mid tones gain about 2.5x, snow stays
 * below 0.9) and the darkest baked shadows are lifted a little, so our own lighting does not
 * shade them a second time into black. Hue and saturation are kept.
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
  };
  readonly noise: DataTexture;
  private readonly nodes: Pick<
    TerrainNodeMaterial,
    'colorNode' | 'normalNode' | 'roughnessNode' | 'metalnessNode' | 'emissiveNode'
  >;

  /**
   * The light and the season the ground is shown in (snow line, autumn colours, lights at
   * night). Called every frame; phase 2 fills this in.
   */
  setConditions(_conditions: WorldConditions) {}

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
    this.nodes = this.buildNodes();
  }

  /** A material for one tile: its own textures, the shared node graph. */
  create(image: Texture, mask: Texture): TerrainNodeMaterial {
    const m = new TerrainNodeMaterial();
    m.tileImage = image;
    m.tileMask = mask;
    Object.assign(m, this.nodes);
    m.fog = false;
    return m;
  }

  dispose() {
    this.noise.dispose();
  }

  private buildNodes() {
    const u = this.uniforms;
    // Per-tile textures: resolved from the drawn material, so every tile shares one shader.
    const tileTexture = (name: string) =>
      materialReference(name, 'texture') as unknown as Node<'vec4'>;
    const photo = tileTexture('tileImage').rgb;
    const mask = tileTexture('tileMask');
    const water = this.look.water ? smoothstep(0.35, 0.65, mask.r) : float(0);

    // ---- Photo -> albedo ----
    const lum = dot(photo, vec3(0.2126, 0.7152, 0.0722));
    const g = u.albedoGain;
    const mapped = lum.mul(g).div(lum.mul(g.sub(1)).div(0.9).add(1));
    const deep = float(1)
      .sub(smoothstep(0.004, 0.03, lum))
      .mul(u.shadowLift);
    const lifted = mix(mapped, max(mapped, 0.06), deep);
    const scaled = photo.mul(lifted.div(max(lum, 1e-4)));
    const photoAlbedo = min(scaled, vec3(0.92));

    // ---- What the ground is (weights), from the photo, the land-cover mask and the shape ----
    const maxC = max(photo.r, max(photo.g, photo.b));
    const minC = min(photo.r, min(photo.g, photo.b));
    const sat = maxC.sub(minC).div(max(maxC, 1e-3));
    const greenLead = photo.g.sub(max(photo.r, photo.b)).div(max(lum, 1e-3));
    const tileUp = normalize(modelWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz);
    const nGeo = normalWorldGeometry;
    const slope = float(1).sub(dot(nGeo, tileUp)); // 1 - cos(slope angle)
    const elevation = attribute('elevation', 'float');
    const grey = float(1).sub(smoothstep(0.12, 0.32, sat));
    const land = float(1).sub(water);
    const forest = max(mask.g, smoothstep(0.05, 0.025, lum).mul(smoothstep(0.0, 0.2, greenLead)))
      .mul(land)
      .toVar();
    const glacier = smoothstep(0.85, 0.95, mask.b);
    const snow = max(
      glacier,
      smoothstep(0.32, 0.5, lum)
        .mul(grey)
        .mul(smoothstep(1400, 2100, elevation)),
    )
      .mul(land)
      .toVar();
    const rock = max(smoothstep(0.22, 0.42, slope), smoothstep(1900, 2500, elevation).mul(grey))
      .mul(float(1).sub(forest))
      .mul(float(1).sub(snow))
      .mul(land)
      .toVar();
    const field = smoothstep(-0.04, 0.06, photo.r.sub(photo.g).div(max(lum, 1e-3)))
      .mul(float(1).sub(forest))
      .mul(float(1).sub(rock))
      .mul(float(1).sub(snow))
      .mul(land);
    const grass = max(land.sub(forest).sub(rock).sub(snow).sub(field), 0);

    // ---- Close-up detail ----
    const toCamera = cameraPosition.sub(positionWorld);
    const dist = length(toCamera);
    const p = positionWorld.xz.add(u.detailOrigin);
    const sample = (period: number) => texture(this.noise, p.div(period));
    // Height slope (dh/dx, dh/dz) of a noise layer of `amp` metres.
    const slopeOf = (s: ReturnType<typeof sample>, period: number, amp: number) =>
      s.gb
        .sub(0.5)
        .div(NOISE_SLOPE_SCALE * period)
        .mul(amp);

    let albedo = photoAlbedo;
    let nWorld = nGeo;
    let roughness = mix(float(0.92), float(0.55), snow).sub(rock.mul(0.1));
    if (this.look.detail) {
      // Paved runways from the land-cover mask: smooth, fine-grained, no bumps.
      const paved = smoothstep(0.05, 0.02, abs(mask.b.sub(MASK_B_RUNWAY / 255))).mul(land);
      const soft = float(1).sub(paved);
      const fade = float(1)
        .sub(smoothstep(u.detailNear, u.detailFar, dist))
        .mul(land)
        .toVar();
      // The finest layers only matter within a few dozen metres; further out they average out
      // in the mipmaps anyway, so they fade early and cost nothing visible.
      const closeFade = float(1)
        .sub(smoothstep(15, 180, dist))
        .mul(fade);
      const big = sample(64);
      const mid = sample(8);
      const fine = sample(2);
      const micro = sample(0.5);
      // Centred and stretched to about -0.3..0.3 for typical values of the fractal noise.
      const v = (s: ReturnType<typeof sample>) => s.r.sub(0.5).mul(2.5);
      // Albedo variation per class: meadows are patchy and grainy, forest canopy is clumpy with
      // dark gaps, rock is grainy, fields fine-grained, snow nearly uniform, asphalt speckled.
      const variation = grass
        .mul(v(big).mul(0.45).add(v(mid).mul(0.35)).add(v(fine).mul(0.3)))
        .add(field.mul(v(mid).mul(0.25).add(v(fine).mul(0.35))))
        .add(forest.mul(big.a.sub(0.5).mul(0.6).add(v(mid).mul(0.9))))
        .add(rock.mul(v(mid).mul(0.6).add(v(fine).mul(0.5))))
        .add(snow.mul(v(big).mul(0.12)))
        .mul(soft)
        .add(paved.mul(v(big).mul(0.12)))
        .mul(fade);
      const grain = grass
        .add(field)
        .mul(0.55)
        .add(rock.mul(0.4))
        .add(paved.mul(0.25))
        .add(snow.mul(0.08))
        .mul(v(micro))
        .mul(closeFade);
      albedo = albedo.mul(variation.add(grain).add(1));
      // Meadows shift between fresh and dry green in patches.
      const tint = mix(vec3(1.06, 1.0, 0.82), vec3(0.9, 1.02, 0.95), big.a);
      albedo = albedo.mul(mix(vec3(1), tint, grass.mul(fade)));
      const dh = slopeOf(mid, 8, 1)
        .mul(grass.mul(0.08).add(field.mul(0.05)).add(forest.mul(1.2)).add(rock.mul(0.9)))
        .add(
          slopeOf(fine, 2, 1).mul(
            grass.mul(0.04).add(field.mul(0.04)).add(rock.mul(0.18)).add(forest.mul(0.1)),
          ),
        )
        .mul(soft)
        .mul(fade)
        .add(
          slopeOf(micro, 0.5, 1)
            .mul(grass.add(field).mul(0.012).add(rock.mul(0.03)))
            .mul(closeFade),
        );
      nWorld = normalize(nWorld.sub(vec3(dh.x, 0, dh.y)));
      roughness = roughness.add(forest.mul(0.05)).sub(paved.mul(0.1));
    }

    // ---- Water ----
    let emissive: Node<'vec3'> = vec3(0);
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
      nWorld = normalize(mix(nWorld, nWater, water));
      const view = normalize(toCamera);
      const cosT = clamp(dot(nWater, view), 0, 1);
      const fresnel = float(0.02).add(pow(float(1).sub(cosT), 5).mul(0.98));
      const r = reflect(view.negate(), nWater);
      const sky = mix(u.skyHorizon, u.skyZenith, pow(clamp(r.y, 0, 1), 0.5));
      emissive = sky.mul(fresnel).mul(water);
      // The photo carries the real colour of each lake and river (green Aare, blue lakes); water
      // reflects little diffuse light, so it is darkened and mixed with a deep-water tone.
      albedo = mix(albedo, mix(u.waterColor, photoAlbedo.mul(0.45), 0.5), water);
      roughness = mix(roughness, float(0.06), water);
    }

    return {
      colorNode: vec4(albedo, 1),
      normalNode: normalize(cameraViewMatrix.mul(vec4(nWorld, 0)).xyz),
      roughnessNode: clamp(roughness, 0.04, 1),
      metalnessNode: float(0),
      emissiveNode: emissive,
    };
  }
}
