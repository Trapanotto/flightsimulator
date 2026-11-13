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
  },
  mobile: {
    cloudSteps: 28,
    cloudLightSteps: 3,
    cloudScale: 0.33,
    cloudHistory: 0.9,
    cloudDetail: false,
    cloudShadowSamples: 1,
    environmentSize: 32,
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
    };
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
  post(color: Node, depth: Node, _camera: Camera): Node {
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
    const clouds = this.clouds;
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
      const ap = aerialLookup(u, this.luts, dir, apDist.mul(0.001));
      const T = ap.transmittance;
      const fade = float(1).sub(T.dot(vec3(...LUMA)));
      // Under an overcast deck the haze is lit by the grey cloud base instead of the sun.
      const haze = ap.inscatter
        .mul(u.exposure)
        .mul(float(1).sub(u.hazeShadow))
        .add(u.deckRadiance.mul(u.hazeShadow).mul(fade));
      out.assign(select(geometry.or(farGround), out.mul(T).add(haze), out));
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
        out.assign(out.mul(c.a).add(c.rgb));
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

    if (Math.abs(altitude - this.altitude) > 1) {
      this.altitude = altitude;
      this.updateLight();
    }
    this.checkDirty();

    this.dome.position.copy(camera.position);
    if (persp.far) this.dome.scale.setScalar(persp.far * 0.9);
    this.sun.target.position.copy(camera.position);
    this.sun.position.copy(camera.position).addScaledVector(this.state.lightDirection, 1000);
  }

  dispose() {
    this.luts.dispose();
    this.clouds?.dispose();
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
    const lux = horizontalIlluminance(sunEl, sunDirect, moonLux) * cloudDim;
    s.illuminance = lux;
    const X = exposureFor(lux, sunEl);
    s.exposure = X;
    u.exposure.value = X;

    // The main light: whichever of sun and moon gives more direct light.
    const moonMain = luminance(moonDirect) > luminance(sunDirect);
    const direct = moonMain ? moonDirect : sunDirect;
    s.lightDirection.copy(moonMain ? s.moonDirection : s.sunDirection);
    u.lightDir.value.copy(s.lightDirection);
    const lum = luminance(direct);
    if (lum > 0) this.sun.color.setRGB(direct[0] / lum, direct[1] / lum, direct[2] / lum);
    // A closed deck takes the sun away below it altogether (the post pass shades only the
    // broken cloud's shadows, and cannot tell direct from diffuse light per pixel).
    const deckClosed = Math.min(Math.max((cover - 0.7) / 0.25, 0), 1);
    const sunThrough = 1 - deckClosed * deckClosed * (3 - 2 * deckClosed) * below;
    this.sun.intensity = lum * X * sunThrough;
    const lightMu = moonMain ? muMoon : muSun;

    // Sky light (diffuse) on a horizontal surface, sky units; bluish by day.
    const skyE = (skyDiffuseLux(sunEl) * cloudDim + moonLux * 0.1) / SOLAR_ILLUMINANCE_LUX;
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
    return select(below, withBelow, select(above, withAbove, insideMix));
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
