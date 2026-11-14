import {
  BackSide,
  CubeCamera,
  CubeRenderTarget,
  DirectionalLight,
  Group,
  HalfFloatType,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  NodeUpdateType,
  Scene,
  SphereGeometry,
  TempNode,
  Vector3,
  Vector4,
  type Camera,
  type CubeTexture,
  type Node,
  type NodeFrame,
  type PerspectiveCamera,
  type Renderer,
  type TextureNode,
} from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  clamp,
  float,
  floor,
  log,
  max,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  select,
  smoothstep,
  sqrt,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { aerialLookup, depthToViewZ, sceneDistance, viewRay } from './aerial';
import {
  EARTH_RADIUS,
  GROUND_ALBEDO,
  NIGHT_FLOOR_LUX,
  LUMA,
  SOLAR_ILLUMINANCE_LUX,
  exposureFor,
  horizontalIlluminance,
  luminance,
  mieDensityFromVisibility,
  skyDiffuseLux,
  sunIlluminance,
  type Vec3,
} from './atmosphere';
import {
  equatorialToLocal,
  moonIlluminanceLux,
  moonIlluminatedFraction,
  moonPosition,
} from './astro';
import { CloudNode } from './clouds';
import type { CloudNoise } from './cloudNoise';
import { PrecipitationNode, fallSpeed, snowShare, temperatureAt } from './precipitation';
import {
  BILLOW_PERIOD,
  KOSCHMIEDER,
  STRATUS_ALBEDO,
  belowness,
  diffuseTransmission,
  directThrough,
  stratusExtinction,
  stratusProfile,
  stratusThickness,
  type StratusProfile,
} from './stratus';
import { StratusLayer } from './stratusNode';
import { AtmosphereLuts } from './luts';
import { R, distanceToGround, hitsGround, type F, type V3, type V4 } from './nodes';
import { pixelAngleOf, skyRadiance } from './skyDome';
import { solarPosition } from './solar';
import { SkyUniforms } from './uniforms';
import { WEATHER_PRESETS, cloudWind, type Weather } from './weather';

const DEG = Math.PI / 180;

/**
 * Share of the light on top of the cloud layer that comes out of its underside as seen from
 * below: broken cumulus let much through their gaps and sides, a thick deck about a sixth
 * (matched to what the ray march gives, so the haze, the environment and the deck agree).
 */
function deckTransmission(cover: number): number {
  return 0.5 - 0.35 * cover;
}

/** The light of the moment, for everything that is lit or tinted by the sky. */
export interface SkyState {
  date: Date;
  /** Unit vector towards the sun in render space (x east, y up, z south). */
  sunDirection: Vector3;
  /** Degrees above the horizon. */
  sunElevation: number;
  /** Degrees from north, clockwise. */
  sunAzimuth: number;
  /** Unit vector towards the moon in render space. */
  moonDirection: Vector3;
  moonElevation: number;
  /** Illuminated fraction of the moon, 0 new .. 1 full. */
  moonPhase: number;
  /**
   * Direction of `sky.sun`, the main directional light: the sun by day, the moon at night
   * (it changes over when the moon outshines the setting sun, a moment when both are dim).
   * Point the shadow camera along this, not along sunDirection.
   */
  lightDirection: Vector3;
  /**
   * Exposure already applied to everything the sky outputs (lights, environment, dome,
   * aerial perspective, clouds): "pre-exposure", so that night and noon both stay in the
   * range of the half-float scene buffer. Keep `renderer.toneMappingExposure` at 1 (a user
   * brightness setting may scale it) and multiply your own emissive light by this value, or
   * use `sky.exposureNode` in materials.
   */
  exposure: number;
  /** Light on a horizontal surface at the camera, lux (for the simulation, instruments). */
  illuminance: number;
  /**
   * How much of the main light's direct beam reaches the camera's surroundings, 0..1: 0 under
   * a closed deck (no shadows, no sun glints; `sky.sun` is already dimmed by it), 1 in the
   * clear. Fades smoothly through the stratus.
   */
  sunlight: number;
  /** Horizontal visibility at the camera's height, metres (50-150 m inside a stratus). */
  visibility: number;
  /** Share of the precipitation that falls as snow at the camera's height, 0..1. */
  snow: number;
}

/** How much the sky may cost; presets per device class are exported as SKY_QUALITY. */
export interface SkyQuality {
  /** Ray-marched clouds: steps per ray, 0 = no volumetric clouds. */
  cloudSteps: number;
  /** Steps from each cloud sample towards the sun. */
  cloudLightSteps: number;
  /** Resolution of the cloud march relative to the screen (upsampled with depth awareness). */
  cloudScale: number;
  /** Temporal accumulation of the clouds: weight of the history, 0 = off. */
  cloudHistory: number;
  /** Detail erosion of the cloud edges (two extra texture reads per sample). */
  cloudDetail: boolean;
  /** Samples of the cloud shadow on the ground per pixel, 0 = no cloud shadows. */
  cloudShadowSamples: number;
  /** Edge of the environment cube map in texels. */
  environmentSize: number;
  /** Texture reads along a ray that finds the stratus top's billows from above (2..8). */
  stratusSteps: number;
  /** Bisection steps for the depth the stratus light comes from. */
  stratusBisection: number;
  /** Ragged scud under the stratus base. */
  stratusScud: boolean;
  /** Most rain drops or snowflakes around the camera; 0 = no precipitation drawn. */
  precipitationDrops: number;
  /** Resolution of the precipitation layer relative to the screen. */
  precipitationScale: number;
}

export const SKY_QUALITY: Record<'desktop' | 'mobile', SkyQuality> = {
  desktop: {
    cloudSteps: 64,
    cloudLightSteps: 6,
    cloudScale: 0.5,
    cloudHistory: 0.85,
    cloudDetail: true,
    cloudShadowSamples: 3,
    environmentSize: 128,
    stratusSteps: 6,
    stratusBisection: 8,
    stratusScud: true,
    precipitationDrops: 16_000,
    precipitationScale: 1,
  },
  mobile: {
    cloudSteps: 28,
    cloudLightSteps: 3,
    cloudScale: 0.33,
    cloudHistory: 0.9,
    cloudDetail: false,
    cloudShadowSamples: 1,
    environmentSize: 32,
    stratusSteps: 2,
    stratusBisection: 3,
    stratusScud: false,
    precipitationDrops: 4000,
    precipitationScale: 0.5,
  },
};

/** Where the camera is, beyond its render-space position. All optional. */
export interface SkyObserver {
  /** Seconds since the last frame (cloud drift). Default 1/60. */
  dt?: number;
  /**
   * Camera height above sea level, metres. Default: camera.position.y, i.e. a render frame
   * whose origin lies at sea level.
   */
  altitude?: number;
  /** Local up at the camera in render space. Default (0, 1, 0). */
  up?: Vector3;
  /**
   * Position of the render-space origin in a fixed east/south frame, metres (x east, z south),
   * so the clouds stay put over the land when the floating origin moves. Default (0, 0).
   */
  origin?: { x: number; z: number };
}

/**
 * Sky, sun and moon light, image-based light, aerial perspective and clouds: one physically
 * based atmosphere (Hillaire 2020) that every part of the picture is lit and tinted by.
 *
 * Add `object` to the scene, assign `environment` to `scene.environment`, put `post()` right
 * after the scene pass, call `update()` every frame before rendering.
 */
export class Sky {
  /** Add to the scene: the dome and the lights. */
  readonly object = new Group();
  readonly state: SkyState;
  /** The main directional light: sun by day, moon by night (see state.lightDirection). */
  readonly sun = new DirectionalLight(0xffffff, 3);
  /**
   * Hemisphere light. Off (intensity 0) while `environmentLighting` is true, because the
   * environment map already brings the sky's diffuse light; light the scene with one or the
   * other, not both.
   */
  readonly ambient = new HemisphereLight(0xbfd4ff, 0x6b6257, 0);
  /**
   * Image-based light of the sky (assign to `scene.environment`): a cube map of the sky, the
   * ground below the horizon and the cloud cover, pre-exposed like everything else. It is
   * re-rendered when the sun, the weather or the camera height change noticeably, not every
   * frame; three's PMREM follows it through `pmremVersion`.
   */
  readonly environment: CubeTexture;
  /** The pre-exposure as a shader node (multiply emissive colours with it). */
  readonly exposureNode: F;
  readonly quality: SkyQuality;

  private readonly u = new SkyUniforms();
  private readonly luts = new AtmosphereLuts();
  private readonly dome: Mesh;
  private readonly envTarget: CubeRenderTarget;
  private readonly envCamera: CubeCamera;
  private readonly envScene = new Scene();
  private readonly refreshNode: RefreshNode;
  private clouds: CloudNode | null = null;
  private readonly stratus: StratusLayer;
  private precipitation: PrecipitationNode | null = null;
  private profile: StratusProfile | null = null;
  /** Camera position in the fixed frame last frame, and its smoothed velocity (m/s). */
  private readonly lastPosition = new Vector3(NaN, NaN, NaN);
  private readonly velocity = new Vector3();
  /** What the environment cube was last rendered with under, in or over the deck. */
  private readonly renderedEnv = new Vector4(NaN, NaN, NaN, NaN);
  private weather: Weather = { ...WEATHER_PRESETS.clear };
  private mieDensity = mieDensityFromVisibility(WEATHER_PRESETS.clear.visibility);
  private readonly up = new Vector3(0, 1, 0);
  private altitude = 500;
  private noise: CloudNoise | null = null;
  private noiseUploaded = false;
  private useEnvironment = true;
  // What the lookup tables were last rendered for.
  private readonly dirty = { air: true, sun: true, moon: true, env: true };
  private readonly rendered = { sunMu: NaN, moonMu: NaN, altitude: NaN, envAltitude: NaN };
  private readonly viewProj = new Matrix4();
  private readonly tmpMatrix = new Matrix4();

  constructor(
    date: Date,
    private lon: number,
    private lat: number,
    quality: SkyQuality = SKY_QUALITY.desktop,
  ) {
    this.quality = quality;
    this.exposureNode = this.u.exposure;
    this.state = {
      date,
      sunDirection: new Vector3(0, 1, 0),
      sunElevation: 45,
      sunAzimuth: 180,
      moonDirection: new Vector3(0, -1, 0),
      moonElevation: -45,
      moonPhase: 0.5,
      lightDirection: new Vector3(0, 1, 0),
      exposure: 1,
      illuminance: 100_000,
      sunlight: 1,
      visibility: WEATHER_PRESETS.clear.visibility,
      snow: 0,
    };
    this.stratus = new StratusLayer(this.u, {
      steps: quality.stratusSteps,
      bisection: quality.stratusBisection,
      scud: quality.stratusScud,
    });
    this.refreshNode = new RefreshNode((r) => this.refresh(r));
    const refresh = vec3(this.refreshNode as unknown as F);

    // The dome: radiance of the sky behind everything, drawn first without writing depth, so
    // the post pass knows empty sky by the cleared depth.
    const domeMaterial = new MeshBasicNodeMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
    const dir = normalize(positionWorld.sub(cameraPosition)) as unknown as V3;
    domeMaterial.colorNode = skyRadiance(
      dir,
      this.u,
      this.luts,
      { discs: true },
      pixelAngleOf(dir),
    ).add(refresh);
    this.dome = new Mesh(new SphereGeometry(1, 64, 32), domeMaterial);
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
    this.dome.name = 'SkyDome';

    // Environment: the sky without discs (sun and moon come as lights) with cloud cover.
    this.envTarget = new CubeRenderTarget(quality.environmentSize, { type: HalfFloatType });
    this.envTarget.texture.name = 'sky.environment';
    this.environment = this.envTarget.texture;
    this.envCamera = new CubeCamera(0.1, 1000, this.envTarget);
    const envMaterial = new MeshBasicNodeMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
    envMaterial.colorNode = this.environmentRadiance(normalize(positionLocal) as unknown as V3);
    const envDome = new Mesh(new SphereGeometry(100, 32, 16), envMaterial);
    envDome.frustumCulled = false;
    this.envScene.add(envDome, this.envCamera);

    this.sun.name = 'SkySun';
    this.object.name = 'Sky';
    this.object.add(this.dome, this.sun, this.sun.target, this.ambient);
    this.setWeather(this.weather);
    this.setTime(date);
    this.loadNoise();
  }

  /**
   * True (default): the scene gets its sky light from `environment` and `ambient` is off.
   * False: `ambient` carries an approximation of the sky light instead.
   */
  get environmentLighting(): boolean {
    return this.useEnvironment;
  }

  set environmentLighting(on: boolean) {
    this.useEnvironment = on;
    this.updateLight();
  }

  /** Where on Earth the sky is seen from (sun position). */
  setLocation(lon: number, lat: number) {
    this.lon = lon;
    this.lat = lat;
    this.setTime(this.state.date);
  }

  setTime(date: Date) {
    const s = this.state;
    s.date = date;
    const { azimuth, elevation } = solarPosition(date, this.lat, this.lon);
    s.sunAzimuth = azimuth;
    s.sunElevation = elevation;
    const az = azimuth * DEG;
    const el = elevation * DEG;
    // Render space: x east, y up, z south.
    s.sunDirection.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
    const moon = moonPosition(date, this.lat, this.lon);
    s.moonDirection.set(...moon.direction);
    s.moonElevation = moon.elevation;
    s.moonPhase = moonIlluminatedFraction(
      [s.sunDirection.x, s.sunDirection.y, s.sunDirection.z],
      moon.direction,
    );
    const m = equatorialToLocal(date, this.lat, this.lon);
    // The shader turns view directions back to equatorial: the transpose.
    this.u.toEquatorial.value.set(m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!);
    this.u.sunDir.value.copy(s.sunDirection);
    this.u.moonDir.value.copy(s.moonDirection);
    this.updateLight();
  }

  /** Clouds, haze (from the visibility) and the wind drift of the clouds. */
  setWeather(weather: Weather) {
    const changedAir = weather.visibility !== this.weather.visibility;
    this.weather = { ...weather };
    const top = Math.max(weather.cloudTop, weather.cloudBase + 100);
    this.u.cloudBase.value = weather.cloudBase;
    this.u.cloudTop.value = top;
    this.u.cloudCover.value =
      this.quality.cloudSteps > 0 ? Math.min(Math.max(weather.cloudCover, 0), 1) : 0;
    this.mieDensity = mieDensityFromVisibility(weather.visibility);
    this.luts.mieDensity.value = this.mieDensity;
    const p = weather.stratus ? stratusProfile(weather.stratus) : null;
    this.profile = p;
    const su = this.u;
    su.stratusOn.value = p ? 1 : 0;
    if (p) {
      su.stratusH.value.set(p.h[0], p.h[1], p.h[2], p.h[3]);
      su.stratusH4.value = p.h[4];
      su.stratusS.value.set(p.s[0], p.s[1], p.s[2], p.s[3]);
      su.stratusBase.value = p.base;
      su.stratusTop.value = p.top;
      su.stratusAmplitude.value = p.amplitude;
      su.stratusScud.value = p.scud;
      su.stratusTopAtCamera.value = p.top;
    } else {
      su.stratusFront.value = 0;
    }
    if (changedAir) this.dirty.air = true;
    this.dirty.env = true;
    this.updateLight();
  }

  /**
   * The air between the camera and what was drawn: takes the rendered scene (colour and depth
   * nodes of the scene pass) and returns it with cloud shadows, aerial perspective and
   * clouds. `depth` must be the scene pass's depth texture node
   * (`scenePass.getTextureNode('depth')`); `camera` the camera of that pass, the same one
   * passed to `update()`. Call once; the result goes into the render pipeline.
   */
  post(color: Node, depth: Node, camera: Camera): Node {
    const depthTex = depth as unknown as TextureNode;
    const q = this.quality;
    if (q.cloudSteps > 0 && !this.clouds) {
      this.clouds = new CloudNode(this.u, this.luts, depthTex, {
        steps: q.cloudSteps,
        lightSteps: q.cloudLightSteps,
        scale: q.cloudScale,
        history: q.cloudHistory,
        detail: q.cloudDetail,
        shadowSamples: q.cloudShadowSamples,
      });
      this.noiseUploaded = false;
    }
    if (q.precipitationDrops > 0 && !this.precipitation) {
      this.precipitation = new PrecipitationNode(this.u, depthTex, camera, {
        drops: q.precipitationDrops,
        scale: q.precipitationScale,
      });
    }
    const clouds = this.clouds;
    const precipitation = this.precipitation;
    const u = this.u;
    return Fn(() => {
      const scene = vec4(color as unknown as V4).toVar();
      const p = uv();
      const depthValue = (depthTex as unknown as V4).x;
      const rayV = viewRay(u, p);
      const dir = normalize(u.cameraRotation.mul(rayV));
      const sd = sceneDistance(u, depthValue, rayV);
      const dist = sd.dist;
      const out = scene.rgb.add(vec3(this.refreshNode as unknown as F)).toVar();
      const geometry = sd.sky.not();
      if (clouds && q.cloudShadowSamples > 0) {
        // Cloud shadow: the scene was lit by the full sun; take back the direct part where a
        // cloud stands between the point and the sun (diffuseShare is the rest).
        const mu = dir.dot(u.up);
        const h = u.altitude.add(mu.mul(dist)).add(
          dist
            .mul(dist)
            .mul(float(1).sub(mu.mul(mu)))
            .div(2 * EARTH_RADIUS * 1000),
        );
        const pos = u.cameraPosition.add(dir.mul(dist));
        const lit = geometry
          .and(h.lessThan(u.cloudTop))
          .and(u.cloudCover.greaterThan(0.001))
          .and(u.lightDir.dot(u.up).greaterThan(0));
        const shadowT = select(lit, clouds.shadow(pos, h, q.cloudShadowSamples), float(1));
        out.mulAssign(mix(u.diffuseShare, float(1), shadowT));
      }
      // Empty sky below the horizon is land beyond the drawn terrain: give it the same air
      // as the terrain (and the cloud deck's shade), so the two meet without a seam.
      const hKm = max(u.altitude.mul(0.001), 0.001);
      const rKm = hKm.add(R);
      const muView = dir.dot(u.up);
      const farGround = sd.sky.and(hitsGround(rKm, hKm, muView));
      const apDist = select(farGround, distanceToGround(rKm, hKm, muView).mul(1000), dist);
      out.assign(select(farGround, u.groundRadiance.mul(1 / 1.3), out));
      const solid = geometry.or(farGround);
      // The stratus along the ray, up to what stops it.
      const deck = this.stratus.trace(dir, select(solid, apDist, float(1e9)));
      const Ts = deck.transmittance;
      // The air in front reaches as far as the light comes from: the scene through a clear
      // ray, the depth the deck shines from where it is opaque.
      const ap = aerialLookup(u, this.luts, dir, mix(deck.distance, apDist, Ts).mul(0.001));
      const T = ap.transmittance;
      const fade = float(1).sub(T.dot(vec3(...LUMA)));
      // Under an overcast deck the haze is lit by the grey cloud base instead of the sun.
      const haze = ap.inscatter
        .mul(u.exposure)
        .mul(float(1).sub(u.hazeShadow))
        .add(u.deckRadiance.mul(u.hazeShadow).mul(fade));
      out.assign(select(solid, out.mul(T).add(haze), out));
      // The deck's light seen through the air in front of it (pixels of empty sky get that
      // air only where the deck covers them: the dome already holds the air beyond).
      const deckLight = deck.color.mul(T).add(haze.mul(Ts.oneMinus()));
      if (clouds) {
        // Depth-aware upsampling: of the four nearest low-resolution texels, trust those whose
        // depth matches this pixel's (no cloud bleeding over a mountain's edge).
        const cloudTex = clouds.getTextureNode();
        const low = clouds.lowSize;
        const pl = p.mul(low).sub(0.5);
        const base = floor(pl);
        const f = pl.sub(base);
        const zOf = (d: F) =>
          log(max((depthToViewZ(d, u.near, u.far) as unknown as F).negate(), 0.01));
        const zPix = zOf(depthValue);
        const sum = vec4(0).toVar();
        const wsum = float(0).toVar();
        for (const [ox, oy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const tuv = base.add(vec2(ox + 0.5, oy + 0.5)).div(low);
          const zt = zOf((depthTex.sample(tuv) as unknown as V4).x);
          const bx = ox ? f.x : f.x.oneMinus();
          const by = oy ? f.y : f.y.oneMinus();
          const w = bx.mul(by).add(1e-3).div(zt.sub(zPix).abs().mul(8).add(0.02));
          sum.addAssign((cloudTex.sample(tuv) as unknown as V4).mul(w));
          wsum.addAssign(w);
        }
        // Geometry in front of the layer has no cloud in front of it, whatever the
        // low-resolution neighbours say (clean silhouettes against the clouds).
        const layer = clouds.layer(dir);
        const clear = geometry.and(dist.lessThan(layer.t0).or(layer.t1.lessThanEqual(layer.t0)));
        const c = select(clear, vec4(0, 0, 0, 1), sum.div(max(wsum, 1e-6)));
        // The stratus lies below the cumulus: in front of them from below and inside it,
        // behind them from above.
        const deckFirst = out.mul(Ts).add(deckLight).mul(c.a).add(c.rgb);
        const cumulusFirst = out.mul(c.a).add(c.rgb).mul(Ts).add(deckLight);
        out.assign(mix(deckFirst, cumulusFirst, u.stratusFront));
      } else {
        out.assign(out.mul(Ts).add(deckLight));
      }
      if (precipitation) {
        // Rain and snow right in front of the camera, over everything else.
        const r = precipitation.getTextureNode().sample(p) as unknown as V4;
        out.assign(out.mul(float(1).sub(clamp(r.a, 0, 1))).add(r.rgb));
      }
      return vec4(out, scene.a);
    })() as unknown as Node;
  }

  /**
   * Per frame, before rendering: follows the camera (dome, light, the inputs of the post
   * pass) and drifts the clouds.
   */
  update(camera: Camera, observer: SkyObserver = {}) {
    const u = this.u;
    camera.updateMatrixWorld();
    const dt = observer.dt ?? 1 / 60;
    const altitude = observer.altitude ?? camera.position.y;
    if (observer.up) this.up.copy(observer.up).normalize();
    u.up.value.copy(this.up);
    u.altitude.value = altitude;
    u.cameraPosition.value.copy(camera.position);
    if (observer.origin) u.originOffset.value.set(observer.origin.x, observer.origin.z);
    const pm = camera.projectionMatrix.elements;
    u.projection.value.set(pm[0]!, pm[5]!);
    u.projectionOffset.value.set(pm[8]!, pm[9]!);
    const persp = camera as PerspectiveCamera;
    if (persp.isPerspectiveCamera) {
      u.near.value = persp.near;
      u.far.value = persp.far;
    }
    u.cameraRotation.value.setFromMatrix4(camera.matrixWorld);
    this.tmpMatrix.copy(camera.matrixWorld).invert();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, this.tmpMatrix);
    this.clouds?.setCamera(this.viewProj);

    // Wind drift and slow evolution of the cloud shapes; bounded so precision holds.
    const wind = cloudWind(this.weather);
    const wrap = 48_000 * 50;
    u.windOffset.value.x = (u.windOffset.value.x - wind.east * dt) % wrap;
    u.windOffset.value.y = (u.windOffset.value.y - wind.south * dt) % wrap;
    u.time.value = (u.time.value + dt) % 20_000;

    let relight = Math.abs(altitude - this.altitude) > 1;
    const p = this.profile;
    if (p) {
      // The deck drifts slowly with the surface wind (a Hochnebel moves with the Bise).
      const w = this.weather;
      const to = (w.windFromDeg + 180) * DEG;
      const off = u.stratusOffset.value;
      off.x = (off.x - Math.sin(to) * w.windSpeed * dt) % BILLOW_PERIOD;
      off.y = (off.y + Math.cos(to) * w.windSpeed * dt) % BILLOW_PERIOD;
      const o = u.originOffset.value;
      const top = this.stratus.topAt(camera.position.x + o.x, camera.position.z + o.y);
      if (Math.abs(top - u.stratusTopAtCamera.value) > 0.5) relight = true;
      u.stratusTopAtCamera.value = top;
    }
    if (relight) {
      this.altitude = altitude;
      this.updateLight();
    }
    this.updatePrecipitation(camera, dt);
    this.checkDirty();

    this.dome.position.copy(camera.position);
    if (persp.far) this.dome.scale.setScalar(persp.far * 0.9);
    this.sun.target.position.copy(camera.position);
    this.sun.position.copy(camera.position).addScaledVector(this.state.lightDirection, 1000);
  }

  dispose() {
    this.luts.dispose();
    this.clouds?.dispose();
    this.stratus.dispose();
    this.precipitation?.dispose();
    this.envTarget.dispose();
    this.dome.geometry.dispose();
    (this.dome.material as MeshBasicNodeMaterial).dispose();
  }

  /** Sun and moon light, exposure and the light the clouds get, for the current state. */
  private updateLight() {
    const s = this.state;
    const u = this.u;
    const hKm = Math.max(this.altitude, 1) / 1000;
    const muSun = s.sunDirection.dot(this.up);
    const muMoon = s.moonDirection.dot(this.up);
    const sunDirect = sunIlluminance(hKm, muSun, this.mieDensity);
    const moonToa = moonIlluminanceLux(s.moonPhase) / SOLAR_ILLUMINANCE_LUX;
    const moonDirect = sunIlluminance(hKm, muMoon, this.mieDensity).map((v) => v * moonToa) as Vec3;
    u.moonIlluminance.value = moonToa;

    const cover = this.u.cloudCover.value;
    const sunEl = Math.asin(Math.max(-1, Math.min(1, muSun))) / DEG;
    const moonLux = luminance(moonDirect) * SOLAR_ILLUMINANCE_LUX * Math.max(muMoon, 0);
    // Clouds take away much of the light below them (overcast: about a third); above the
    // layer the full sun shines.
    const w = this.weather;
    const below =
      1 -
      Math.min(
        Math.max((this.altitude - w.cloudBase) / Math.max(w.cloudTop - w.cloudBase, 1), 0),
        1,
      );
    const cloudDim = 1 - 0.7 * cover * cover * below;
    const moonMain = luminance(moonDirect) > luminance(sunDirect);
    const lightMu = moonMain ? muMoon : muSun;
    // The stratus: the direct beam through what of it lies above the camera, the diffuse light
    // through the whole deck below it (two-stream), mixed by how deep in it the camera is.
    const p = this.profile;
    const sunlightDeck = p ? directThrough(p, this.altitude, lightMu) : 1;
    const deep = p ? belowness(p, this.altitude) : 0;
    const deckT = p ? diffuseTransmission(stratusThickness(p)) : 1;
    let lux = horizontalIlluminance(sunEl, sunDirect, moonLux) * cloudDim;
    if (p) {
      const direct =
        luminance(sunDirect) * SOLAR_ILLUMINANCE_LUX * Math.max(Math.sin(sunEl * DEG), 0) + moonLux;
      const diffuse = lux / cloudDim - direct;
      const through = (direct + diffuse) * deckT;
      lux = (direct * sunlightDeck + diffuse + (through - diffuse) * deep) * cloudDim;
      lux = Math.max(lux, NIGHT_FLOOR_LUX * deckT);
    }
    s.illuminance = lux;
    const X = exposureFor(lux, sunEl);
    s.exposure = X;
    u.exposure.value = X;

    // The main light: whichever of sun and moon gives more direct light.
    const direct = moonMain ? moonDirect : sunDirect;
    s.lightDirection.copy(moonMain ? s.moonDirection : s.sunDirection);
    u.lightDir.value.copy(s.lightDirection);
    const lum = luminance(direct);
    if (lum > 0) this.sun.color.setRGB(direct[0] / lum, direct[1] / lum, direct[2] / lum);
    // A closed deck takes the sun away below it altogether (the post pass shades only the
    // broken cloud's shadows, and cannot tell direct from diffuse light per pixel).
    const deckClosed = Math.min(Math.max((cover - 0.7) / 0.25, 0), 1);
    const sunThrough = (1 - deckClosed * deckClosed * (3 - 2 * deckClosed) * below) * sunlightDeck;
    s.sunlight = sunThrough;
    this.sun.intensity = lum * X * sunThrough;

    // Sky light (diffuse) on a horizontal surface, sky units; bluish by day.
    const skyClear = (skyDiffuseLux(sunEl) * cloudDim + moonLux * 0.1) / SOLAR_ILLUMINANCE_LUX;
    // Under the deck the sky light is what comes through it, grey.
    const directTop = luminance(direct) * Math.max(lightMu, 0);
    const skyE = p ? skyClear + ((directTop + skyClear) * deckT - skyClear) * deep : skyClear;
    const directH = lum * Math.max(lightMu, 0) * sunThrough;
    const tint: Vec3 = sunEl > -4 ? [0.78, 0.9, 1.15] : [0.7, 0.82, 1.2];
    const tl = luminance(tint);
    this.ambient.color.setRGB(tint[0] / tl, tint[1] / tl, tint[2] / tl);
    const g = GROUND_ALBEDO;
    this.ambient.groundColor.setRGB(g[0] * 3, g[1] * 3, g[2] * 3);
    this.ambient.intensity = this.useEnvironment ? 0 : skyE * X;
    // The diffuse light the environment brings: under clouds that is the grey base (see
    // environmentRadiance), which the cloud shadow in the post pass must leave alone.
    const midKmEnv = (this.weather.cloudBase + this.weather.cloudTop) / 2000;
    const atCloudsEnv = luminance(sunIlluminance(midKmEnv, lightMu, this.mieDensity));
    const deckE =
      (atCloudsEnv * (moonMain ? moonToa : 1) * Math.max(lightMu, 0) + skyE) *
      deckTransmission(cover);
    const envE = skyE * (1 - cover) + deckE * cover;
    u.diffuseShare.value = envE / Math.max(envE + directH, 1e-12);

    // Light at the cloud layer: the main light at mid-layer height, and the sky around it.
    const midKm = (this.weather.cloudBase + this.weather.cloudTop) / 2000;
    const atClouds = sunIlluminance(midKm, lightMu, this.mieDensity).map(
      (v) => v * (moonMain ? moonToa : 1),
    ) as Vec3;
    u.cloudSun.value.set(atClouds[0] * X, atClouds[1] * X, atClouds[2] * X);
    const skyAtClouds =
      (skyDiffuseLux(sunEl) + moonLux * 0.1) / SOLAR_ILLUMINANCE_LUX / Math.PI + 2e-9;
    u.cloudAmbient.value
      .set(tint[0] / tl, tint[1] / tl, tint[2] / tl)
      .multiplyScalar(skyAtClouds * X);
    const groundE = (luminance(atClouds) * Math.max(lightMu, 0) + skyE) * (1 - 0.5 * cover);
    u.groundRadiance.value.set(g[0], g[1], g[2]).multiplyScalar((groundE / Math.PI) * X * 1.3);
    // Under a deck the haze is lit by the grey cloud base, not by the sun.
    u.hazeShadow.value = this.altitude < this.weather.cloudBase ? Math.pow(cover, 2.5) * 0.9 : 0;
    const deck =
      ((luminance(atClouds) * Math.max(lightMu, 0) + skyE) * deckTransmission(cover)) / Math.PI;
    u.deckRadiance.value.set(0.95, 0.97, 1.0).multiplyScalar(deck * X);

    const st = this.state;
    st.visibility = this.weather.visibility;
    if (!p) {
      u.envUpWeight.value = u.envDownWeight.value = 0;
      return;
    }
    // ---- the stratus deck ----
    const hc = this.altitude;
    const light = sunIlluminance(p.top / 1000, lightMu, this.mieDensity).map(
      (v) => v * (moonMain ? moonToa : 1),
    ) as Vec3;
    const skyTop = (skyDiffuseLux(sunEl) + moonLux * 0.1) / SOLAR_ILLUMINANCE_LUX;
    const k = (STRATUS_ALBEDO / Math.PI) * X;
    const up = Math.max(lightMu, 0);
    u.stratusSun.value.set(light[0] * k, light[1] * k, light[2] * k);
    u.stratusSky.value.set(tint[0] / tl, tint[1] / tl, tint[2] / tl).multiplyScalar(skyTop * k);
    const lightTop = u.stratusLightTop.value
      .copy(u.stratusSun.value)
      .multiplyScalar(up)
      .add(u.stratusSky.value);
    // Under the deck: what diffuses through it, grey (the droplets scatter every colour
    // alike), plus the orange glow of the towns below at night.
    const tau = stratusThickness(p);
    const eTop = luminance(light) * up + skyTop;
    const town = (4e-3 / SOLAR_ILLUMINANCE_LUX) * X;
    const grey = (eTop * diffuseTransmission(tau) * X) / Math.PI;
    const lightBase = u.stratusLightBase.value.set(
      0.96 * grey + town,
      0.98 * grey + 0.72 * town,
      grey + 0.48 * town,
    );
    u.stratusLightMist.value.copy(lightBase).multiplyScalar(0.85);
    lightTop.addScaledVector(lightBase, 0.15);
    // Forward scattering lets a little of the beam through a thin deck as a glow.
    const glow = Math.exp((-0.15 * tau) / Math.max(up, 0.05)) * (0.11 / Math.PI) * X;
    u.stratusAureole.value.set(light[0] * glow, light[1] * glow, light[2] * glow);
    // A fog sea also brightens what is above it from below (cumulus bases, the far land).
    u.groundRadiance.value.copy(lightTop).multiplyScalar(1.3);
    // The haze the camera sees is in the deck's shade as far as the deck takes the beam.
    const shade = 1 - sunlightDeck;
    u.hazeShadow.value += (1 - u.hazeShadow.value) * shade;
    u.deckRadiance.value.lerp(u.stratusLightMist.value, shade);
    u.diffuseShare.value += (1 - u.diffuseShare.value) * shade;
    // In front of the cumulus from below and inside, behind them from above.
    const front = (u.stratusTopAtCamera.value + 10 - hc) / 20;
    u.stratusFront.value = Math.min(Math.max(front, 0), 1);
    const sigma = stratusExtinction(p, hc) + KOSCHMIEDER / Math.max(this.weather.visibility, 1);
    st.visibility = KOSCHMIEDER / sigma;

    // The environment: the deck's underside above, the inside all around, the bright sea
    // below; continuous in the height so the light on everything fades through the layer.
    const smooth = (a: number, b: number, x: number) => {
      const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
      return t * t * (3 - 2 * t);
    };
    const aboveTop = smooth(p.top - 20, p.top + 30, hc);
    const aboveBase = smooth(p.base - 30, p.base + 30, hc);
    const f = Math.min(Math.max((hc - p.base) / (p.top - p.base), 0), 1);
    const inside = lightBase.clone().lerp(lightTop, f);
    const ground = lightBase
      .clone()
      .multiplyScalar(GROUND_ALBEDO[1] * 1.2)
      .lerp(lightBase, 0.35);
    u.envUp.value.copy(lightBase).lerp(inside.clone().lerp(lightTop, 0.5), aboveBase);
    u.envUpWeight.value = 1 - aboveTop;
    u.envDown.value
      .copy(ground)
      .lerp(inside.clone().lerp(lightBase, 0.5), aboveBase)
      .lerp(lightTop, aboveTop);
    u.envDownWeight.value = 1;
  }

  /** Drops around the camera: how many, how they fall, how fast the camera flies through. */
  private updatePrecipitation(camera: Camera, dt: number) {
    const w = this.weather;
    const s = this.state;
    s.snow = snowShare(temperatureAt(w.temperature, this.altitude));
    const node = this.precipitation;
    if (!node) return;
    const o = this.u.originOffset.value;
    const now = new Vector3(camera.position.x + o.x, this.altitude, camera.position.z + o.y);
    if (Number.isFinite(this.lastPosition.x) && dt > 0) {
      const v = now.clone().sub(this.lastPosition).divideScalar(dt);
      // A jump (a new flight, a teleport) is no speed.
      if (v.length() < 400) this.velocity.lerp(v, Math.min(1, dt * 12));
    }
    this.lastPosition.copy(now);
    // Precipitation falls out of the clouds: none above the deck it comes from.
    const p = this.profile;
    const top = p ? p.top : w.cloudCover > 0.05 ? w.cloudTop : Infinity;
    const out = Math.min(Math.max((this.altitude - (top - 100)) / 150, 0), 1);
    const amount = Math.min(Math.max(w.precipitation, 0), 1) * (1 - out);
    node.count = Math.round(node.quality.drops * amount);
    node.intensity.value = amount;
    node.snow.value = s.snow;
    const to = (w.windFromDeg + 180) * DEG;
    // Wind picks up with height above the ground (roughly, without knowing the ground).
    const wind = w.windSpeed * (1 + Math.min(Math.max(this.altitude - 500, 0) / 1000, 1.5));
    const drop = new Vector3(Math.sin(to) * wind, -fallSpeed(s.snow), -Math.cos(to) * wind);
    const rel = node.relative.value.copy(drop).sub(this.velocity);
    const ph = node.phase.value.addScaledVector(rel, -dt);
    const BOX = 36;
    ph.set(((ph.x % BOX) + BOX) % BOX, ((ph.y % BOX) + BOX) % BOX, ((ph.z % BOX) + BOX) % BOX);
    // A drop refracts the brighter sky above into the eye, so it shows lighter than the land
    // behind it; flakes reflect the light around them.
    const L = (s.illuminance / SOLAR_ILLUMINANCE_LUX / Math.PI) * s.exposure * (1.8 - 0.8 * s.snow);
    node.light.value.set(L, L, L * 1.02);
    node.extinction.value = KOSCHMIEDER / Math.max(s.visibility, 1);
    node.time.value = (node.time.value + dt) % 1000;
  }

  /** Marks the tables that no longer match the light or the camera height. */
  private checkDirty() {
    const r = this.rendered;
    const muSun = this.state.sunDirection.dot(this.up);
    const muMoon = this.state.moonDirection.dot(this.up);
    if (!(Math.abs(muSun - r.sunMu) < 2e-4)) this.dirty.sun = true;
    const moonVisible = this.state.moonElevation > -2 && this.state.sunElevation < 0;
    if (moonVisible && !(Math.abs(muMoon - r.moonMu) < 1e-3)) this.dirty.moon = true;
    const tolerance = Math.max(10, Math.abs(this.altitude) * 0.02);
    if (!(Math.abs(this.altitude - r.altitude) < tolerance)) {
      this.dirty.sun = true;
      if (moonVisible) this.dirty.moon = true;
    }
    if (!(Math.abs(this.altitude - r.envAltitude) < 250)) this.dirty.env = true;
    if (this.profile) {
      // Through the deck the environment changes within metres: follow it in small steps.
      const u = this.u;
      const e = this.renderedEnv;
      const now = [
        luminance([u.envUp.value.x, u.envUp.value.y, u.envUp.value.z]),
        luminance([u.envDown.value.x, u.envDown.value.y, u.envDown.value.z]),
        u.envUpWeight.value,
        u.exposure.value,
      ];
      const ref = [e.x, e.y, e.z, e.w];
      const changed = now.some(
        (v, i) => !(Math.abs(v - ref[i]!) <= 0.03 * Math.max(Math.abs(v), 1e-9)),
      );
      if (changed || !(Math.abs(u.envUpWeight.value - e.z) < 0.02)) this.dirty.env = true;
    }
  }

  /** Renders what is dirty; runs once per frame from a node of the dome and the post pass. */
  private refresh(renderer: Renderer) {
    if (this.noise && !this.noiseUploaded && this.clouds) {
      this.clouds.setNoise(this.noise);
      this.noiseUploaded = true;
    }
    const d = this.dirty;
    if (!d.air && !d.sun && !d.moon && !d.env) return;
    this.luts.cameraHeight.value = Math.max(this.altitude, 1) / 1000;
    this.luts.sunMu.value = this.state.sunDirection.dot(this.up);
    this.luts.moonMu.value = this.state.moonDirection.dot(this.up);
    // Normalise the stored tables by the sky's brightness for the light's elevation.
    const scaleFor = (mu: number) =>
      SOLAR_ILLUMINANCE_LUX / skyDiffuseLux(Math.asin(Math.max(-1, Math.min(1, mu))) / DEG);
    if (d.air || d.sun) this.luts.sunScale.value = scaleFor(this.luts.sunMu.value);
    if (d.moon) this.luts.moonScale.value = scaleFor(this.luts.moonMu.value);
    if (d.air || d.sun || d.moon) {
      this.luts.render(renderer, { air: d.air, sun: d.sun, moon: d.moon });
      this.rendered.sunMu = this.luts.sunMu.value;
      this.rendered.moonMu = this.luts.moonMu.value;
      this.rendered.altitude = this.altitude;
      d.env = d.env || d.air || d.sun;
    }
    if (d.env) {
      this.envCamera.update(renderer, this.envScene);
      this.environment.pmremVersion++;
      this.rendered.envAltitude = this.altitude;
      const u = this.u;
      this.renderedEnv.set(
        luminance([u.envUp.value.x, u.envUp.value.y, u.envUp.value.z]),
        luminance([u.envDown.value.x, u.envDown.value.y, u.envDown.value.z]),
        u.envUpWeight.value,
        u.exposure.value,
      );
    }
    d.air = d.sun = d.moon = d.env = false;
  }

  /** The environment's radiance: the sky without discs, with the cloud cover as a veil. */
  private environmentRadiance(dir: V3): V3 {
    const u = this.u;
    const sky = skyRadiance(dir, u, this.luts, { discs: false });
    const mu = dir.dot(u.up);
    const cover = u.cloudCover;
    // Clouds hide more of the sky towards the horizon, where one looks through more of them.
    const seen = mix(cover, sqrt(cover), float(1).sub(mu.abs()));
    const light = u.cloudSun.mul(max(u.lightDir.dot(u.up), 0)).add(u.cloudAmbient.mul(Math.PI));
    const fromBelow = light.mul(float(0.5).sub(cover.mul(0.35))).div(Math.PI);
    const fromAbove = light.mul(0.8 / Math.PI);
    const below = u.altitude.lessThan(u.cloudBase);
    const above = u.altitude.greaterThan(u.cloudTop);
    const upper = smoothstep(-0.03, 0.08, mu);
    const withBelow = mix(sky, fromBelow, seen.mul(upper));
    const withAbove = mix(sky, fromAbove, seen.mul(upper.oneMinus()));
    // Inside the layer: mostly cloud all around.
    const inside = mix(fromBelow, fromAbove, mu.mul(0.5).add(0.5));
    const insideMix = mix(sky, inside, clamp(cover.mul(1.5), 0, 1));
    const clouded = select(below, withBelow, select(above, withAbove, insideMix));
    // The stratus under, around or over the camera (weights 0 without one).
    // Blended per hemisphere, so the horizon band takes nothing of the clear sky's colours.
    const withUp = mix(clouded, u.envUp, u.envUpWeight);
    const withDown = mix(clouded, u.envDown, u.envDownWeight);
    return mix(withDown, withUp, upper);
  }

  private loadNoise() {
    if (typeof Worker === 'undefined') return;
    try {
      const worker = new Worker(new URL('./cloudNoise.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (e: MessageEvent<CloudNoise>) => {
        this.noise = e.data;
        this.noiseUploaded = false;
        worker.terminate();
      };
      worker.onerror = () => worker.terminate();
      worker.postMessage(null);
    } catch {
      // No workers: no clouds, everything else works.
    }
  }
}

/**
 * A node with no value that gives the sky a chance to render its tables once per frame,
 * whichever of its materials (dome or post pass) the renderer meets first.
 */
class RefreshNode extends TempNode {
  static get type() {
    return 'SkyRefreshNode';
  }

  constructor(private readonly callback: (renderer: Renderer) => void) {
    super('float');
    this.updateBeforeType = NodeUpdateType.FRAME;
  }

  updateBefore(frame: NodeFrame): boolean | undefined {
    if (frame.renderer) this.callback(frame.renderer as Renderer);
    return undefined;
  }

  setup() {
    return float(0);
  }
}
