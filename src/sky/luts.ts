/**
 * The lookup tables of the atmosphere (Hillaire 2020, "A Scalable and Production Ready Sky
 * and Atmosphere Rendering Technique"), rendered with full-screen passes so they work on
 * WebGPU and on the WebGL 2 fallback alike (no compute shaders, no 3D render targets):
 *
 *  - transmittance (256 x 64): light lost from a height towards space along a zenith angle;
 *  - multiple scattering (32 x 32): the light of all higher scattering orders as seen from a
 *    height for a sun zenith angle (isotropic approximation);
 *  - sky view (192 x 108), once for the sun and once for the moon: the sky radiance around the
 *    camera, azimuth relative to the light;
 *  - aerial perspective (atlas of 32 slices of 32 x 32): in-scattered light and transmittance
 *    from the camera to a distance in every direction, again relative to the light. Hillaire
 *    uses a froxel volume tied to the view; this one is tied to the light instead, so it only
 *    changes when the sun or the camera height do, and it reaches 220 km.
 *
 * Everything per unit of light illuminance outside the atmosphere.
 */
import {
  HalfFloatType,
  LinearFilter,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  RendererUtils,
  Vector3,
  type Renderer,
  type Texture,
} from 'three/webgpu';
import {
  Fn,
  If,
  acos,
  clamp,
  cos,
  exp,
  float,
  floor,
  max,
  min,
  select,
  sin,
  sqrt,
  texture,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import { GROUND_ALBEDO } from './atmosphere';
import {
  AP_AZIMUTH,
  AP_ELEVATION,
  AP_MAX_DISTANCE,
  AP_SLICES,
  ATMOSPHERE_HEIGHT,
  MULTI_SCATTERING_SIZE,
  R,
  SKY_VIEW_SIZE,
  TOP,
  TRANSMITTANCE_SIZE,
  distanceToGround,
  distanceToTop,
  hitsGround,
  lightVisibility,
  loop,
  medium,
  miePhase,
  multiScatteringUV,
  rayleighPhase,
  rgb,
  transmittanceUV,
  type F,
  type V3,
} from './nodes';

const H_TOP = Math.sqrt(TOP * TOP - R * R);
/** The multiple-scattering table is stored times this (its values are small). */
const MS_SCALE = 100;
type TextureSampler = ReturnType<typeof texture>;

function target(width: number, height: number): RenderTarget {
  const rt = new RenderTarget(width, height, {
    type: HalfFloatType,
    depthBuffer: false,
    generateMipmaps: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
  });
  rt.texture.name = 'sky.lut';
  return rt;
}

/** Texel centre in 0..1 -> unit range with the first and last texel on 0 and 1. */
const fromSub = (u: F, size: number): F => u.sub(0.5 / size).div(1 - 1 / size);

export class AtmosphereLuts {
  readonly mieDensity = uniform(1);
  readonly groundAlbedo = uniform(new Vector3(...GROUND_ALBEDO));
  /** Camera height above sea level, km (sky view and aerial perspective). */
  readonly cameraHeight = uniform(0.5);
  /** Zenith cosine of the sun and of the moon. */
  readonly sunMu = uniform(1);
  readonly moonMu = uniform(1);
  /**
   * The sky-view and aerial tables are stored multiplied by these (about the inverse of the
   * sky's brightness for the light's elevation): night skies are 1e-9 of the day's and would
   * vanish in the half floats otherwise. Set together with a render of the tables.
   */
  readonly sunScale = uniform(1);
  readonly moonScale = uniform(1);

  readonly transmittance = target(...TRANSMITTANCE_SIZE);
  readonly multiScattering = target(MULTI_SCATTERING_SIZE, MULTI_SCATTERING_SIZE);
  readonly skyViewSun = target(...SKY_VIEW_SIZE);
  readonly skyViewMoon = target(...SKY_VIEW_SIZE);
  readonly apInscatter = target(AP_AZIMUTH * AP_SLICES, AP_ELEVATION);
  readonly apTransmittance = target(AP_AZIMUTH * AP_SLICES, AP_ELEVATION);

  readonly transmittanceNode = texture(this.transmittance.texture);
  readonly multiScatteringNode = texture(this.multiScattering.texture);
  readonly skyViewSunNode = texture(this.skyViewSun.texture);
  readonly skyViewMoonNode = texture(this.skyViewMoon.texture);
  readonly apInscatterNode = texture(this.apInscatter.texture);
  readonly apTransmittanceNode = texture(this.apTransmittance.texture);

  private readonly quad = new QuadMesh(new NodeMaterial());
  private readonly materials: Record<string, NodeMaterial> = {};
  private state?: RendererUtils.RendererState;

  constructor() {
    this.materials.transmittance = this.material(this.transmittancePass());
    this.materials.multiScattering = this.material(this.multiScatteringPass());
    this.materials.skyViewSun = this.material(this.skyViewPass(this.sunMu, this.sunScale));
    this.materials.skyViewMoon = this.material(this.skyViewPass(this.moonMu, this.moonScale));
    this.materials.apInscatter = this.material(this.aerialPass(false));
    this.materials.apTransmittance = this.material(this.aerialPass(true));
  }

  /** Transmittance from height h (km) along zenith cosine mu towards space (ground ignored). */
  sampleTransmittance(lut: TextureSampler, h: F, mu: F): V3 {
    return rgb(lut.sample(transmittanceUV(h, mu)).level(float(0)));
  }

  sampleMultiScattering(lut: TextureSampler, h: F, mu: F): V3 {
    return rgb(lut.sample(multiScatteringUV(h, mu)).level(float(0))).mul(1 / MS_SCALE);
  }

  /**
   * Renders tables: the atmosphere ones when the air changed (haze), the view ones when the
   * light or the camera height changed. Restores the renderer state afterwards.
   */
  render(renderer: Renderer, what: { air: boolean; sun: boolean; moon: boolean }) {
    this.state = RendererUtils.resetRendererState(renderer, this.state!);
    const run = (name: string, rt: RenderTarget) => {
      this.quad.material = this.materials[name]!;
      renderer.setRenderTarget(rt);
      this.quad.render(renderer);
    };
    if (what.air) {
      run('transmittance', this.transmittance);
      run('multiScattering', this.multiScattering);
    }
    if (what.sun || what.air) {
      run('skyViewSun', this.skyViewSun);
      run('apInscatter', this.apInscatter);
      run('apTransmittance', this.apTransmittance);
    }
    if (what.moon) run('skyViewMoon', this.skyViewMoon);
    RendererUtils.restoreRendererState(renderer, this.state);
  }

  textures(): Texture[] {
    return [
      this.transmittance.texture,
      this.multiScattering.texture,
      this.skyViewSun.texture,
      this.skyViewMoon.texture,
      this.apInscatter.texture,
      this.apTransmittance.texture,
    ];
  }

  dispose() {
    for (const rt of [
      this.transmittance,
      this.multiScattering,
      this.skyViewSun,
      this.skyViewMoon,
      this.apInscatter,
      this.apTransmittance,
    ])
      rt.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
  }

  private material(node: ReturnType<typeof vec4>): NodeMaterial {
    const m = new NodeMaterial();
    m.name = 'sky.lut';
    m.fragmentNode = node;
    m.depthTest = false;
    m.depthWrite = false;
    return m;
  }

  /**
   * Single scattering of the light plus the multiple-scattering table along a ray from height
   * h with zenith cosine mu; the light at zenith cosine muLight, nu = cos(view, light).
   * Steps crowd towards the camera (quadratic), where the air is densest and nearest.
   */
  private scatter(o: { h: F; mu: F; nu: F; muLight: F; tMax: F; steps: number; ground: F | null }) {
    const { h, mu, nu, muLight, tMax, steps } = o;
    const r = h.add(R);
    const L = vec3(0).toVar();
    const T = vec3(1).toVar();
    const phaseR = rayleighPhase(nu);
    const phaseM = miePhase(nu);
    const tPrev = float(0).toVar();
    loop('si', steps, (i) => {
      const s = float(i).add(1).div(steps);
      const tNext = tMax.mul(s.mul(s)).toVar();
      // Materialise before tPrev moves on: TSL expressions are evaluated where they are used.
      const dt = tNext.sub(tPrev).toVar();
      const t = tPrev.add(dt.mul(0.5)).toVar();
      tPrev.assign(tNext);
      const ri = sqrt(max(r.mul(r).add(t.mul(t)).add(r.mul(mu).mul(t).mul(2)), R * R));
      const hi = ri.sub(R);
      const muLi = r.mul(muLight).add(t.mul(nu)).div(ri);
      const med = medium(hi, this.mieDensity);
      const sun = this.sampleTransmittance(this.transmittanceNode, hi, muLi).mul(
        lightVisibility(hi, muLi),
      );
      const ms = this.sampleMultiScattering(this.multiScatteringNode, hi, muLi);
      const S = sun
        .mul(med.scatR.mul(phaseR).add(vec3(med.scatM.mul(phaseM))))
        .add(ms.mul(med.scatR.add(vec3(med.scatM))));
      const stepT = exp(med.ext.mul(dt).negate());
      // Analytic integral over the step (Hillaire): stable for thick and thin steps alike.
      L.addAssign(T.mul(S.sub(S.mul(stepT)).div(max(med.ext, vec3(1e-7)))));
      T.mulAssign(stepT);
    });
    if (o.ground) {
      const isGround = o.ground;
      If(isGround.greaterThan(0.5), () => {
        const ri = R;
        const muLg = r.mul(muLight).add(tMax.mul(nu)).div(ri);
        const sun = this.sampleTransmittance(this.transmittanceNode, float(0), muLg).mul(
          lightVisibility(float(0), muLg),
        );
        L.addAssign(
          T.mul(sun)
            .mul(clamp(muLg, 0, 1))
            .mul(this.groundAlbedo)
            .mul(1 / Math.PI),
        );
      });
    }
    return { L, T };
  }

  private transmittancePass() {
    return Fn(() => {
      const p = uv();
      const x = fromSub(p.x, TRANSMITTANCE_SIZE[0]);
      const y = fromSub(p.y, TRANSMITTANCE_SIZE[1]);
      const rho = y.mul(H_TOP);
      // h = sqrt(rho² + R²) - R without cancellation.
      const h = rho.mul(rho).div(sqrt(rho.mul(rho).add(R * R)).add(R));
      const r = h.add(R);
      const dMin = float(ATMOSPHERE_HEIGHT).sub(h);
      const dMax = rho.add(H_TOP);
      const d = dMin.add(x.mul(dMax.sub(dMin)));
      const mu = select(
        d.lessThan(1e-4),
        float(1),
        clamp(
          float(H_TOP * H_TOP)
            .sub(rho.mul(rho))
            .sub(d.mul(d))
            .div(r.mul(d).mul(2)),
          -1,
          1,
        ),
      );
      const od = vec3(0).toVar();
      const steps = 48;
      const dt = d.div(steps);
      loop('ti', steps, (i) => {
        const t = float(i).add(0.5).mul(dt);
        const ri = sqrt(r.mul(r).add(t.mul(t)).add(r.mul(mu).mul(t).mul(2)));
        od.addAssign(medium(ri.sub(R), this.mieDensity).ext.mul(dt));
      });
      return vec4(exp(od.negate()), 1);
    })();
  }

  private multiScatteringPass() {
    return Fn(() => {
      const p = uv();
      const muS = fromSub(p.x, MULTI_SCATTERING_SIZE).mul(2).sub(1);
      const h = max(fromSub(p.y, MULTI_SCATTERING_SIZE).mul(ATMOSPHERE_HEIGHT), 0.002);
      const r = h.add(R);
      const sunDir = vec3(0, muS, sqrt(max(float(1).sub(muS.mul(muS)), 0)));
      const L2 = vec3(0).toVar();
      const fms = vec3(0).toVar();
      const n = 8;
      loop('mi', n, (i) => {
        loop('mj', n, (j) => {
          const theta = float(i)
            .add(0.5)
            .div(n)
            .mul(2 * Math.PI);
          const phi = acos(float(1).sub(float(j).add(0.5).div(n).mul(2)));
          const dir = vec3(cos(theta).mul(sin(phi)), cos(phi), sin(theta).mul(sin(phi)));
          const mu = dir.y;
          const nu = dir.dot(sunDir);
          const ground = hitsGround(r, h, mu);
          const tMax = select(ground, distanceToGround(r, h, mu), distanceToTop(r, h, mu));
          const L = vec3(0).toVar();
          const f = vec3(0).toVar();
          const T = vec3(1).toVar();
          const steps = 20;
          const dt = tMax.div(steps);
          loop('mk', steps, (k) => {
            const t = float(k).add(0.3).mul(dt);
            const ri = sqrt(max(r.mul(r).add(t.mul(t)).add(r.mul(mu).mul(t).mul(2)), R * R));
            const hi = ri.sub(R);
            const muSi = r.mul(muS).add(t.mul(nu)).div(ri);
            const med = medium(hi, this.mieDensity);
            const sun = this.sampleTransmittance(this.transmittanceNode, hi, muSi).mul(
              lightVisibility(hi, muSi),
            );
            const scat = med.scatR.add(vec3(med.scatM));
            const stepT = exp(med.ext.mul(dt).negate());
            const ext = max(med.ext, vec3(1e-7));
            const S = sun.mul(scat).mul(1 / (4 * Math.PI));
            L.addAssign(T.mul(S.sub(S.mul(stepT)).div(ext)));
            f.addAssign(T.mul(scat.sub(scat.mul(stepT)).div(ext)));
            T.mulAssign(stepT);
          });
          If(ground, () => {
            const muSg = r.mul(muS).add(tMax.mul(nu)).div(R);
            const sun = this.sampleTransmittance(this.transmittanceNode, float(0), muSg).mul(
              lightVisibility(float(0), muSg),
            );
            L.addAssign(
              T.mul(sun)
                .mul(clamp(muSg, 0, 1))
                .mul(this.groundAlbedo)
                .mul(1 / Math.PI),
            );
          });
          L2.addAssign(L.div(n * n));
          fms.addAssign(f.div(n * n));
        });
      });
      return vec4(L2.div(max(vec3(1).sub(fms), vec3(1e-3))).mul(MS_SCALE), 1);
    })();
  }

  private skyViewPass(lightMu: F, scale: F) {
    return Fn(() => {
      const p = uv();
      const x = fromSub(p.x, SKY_VIEW_SIZE[0]);
      const y = fromSub(p.y, SKY_VIEW_SIZE[1]);
      const h = max(this.cameraHeight, 0.001);
      const r = h.add(R);
      const vHorizon = sqrt(h.mul(h.add(2 * R)));
      const beta = acos(clamp(vHorizon.div(r), -1, 1));
      const zh = float(Math.PI).sub(beta);
      const up = float(1).sub(y.mul(2));
      const aboveZenith = zh.mul(float(1).sub(up.mul(up)));
      const down = y.mul(2).sub(1);
      const belowZenith = zh.add(beta.mul(down.mul(down)));
      const viewZenith = select(y.lessThan(0.5), aboveZenith, belowZenith);
      const azimuth = x.mul(x).mul(Math.PI);
      const mu = cos(viewZenith);
      const sinV = sin(viewZenith);
      const dir = vec3(sinV.mul(cos(azimuth)), mu, sinV.mul(sin(azimuth)));
      const light = vec3(sqrt(max(float(1).sub(lightMu.mul(lightMu)), 0)), lightMu, 0);
      const ground = hitsGround(r, h, mu);
      const tMax = select(ground, distanceToGround(r, h, mu), distanceToTop(r, h, mu));
      const { L } = this.scatter({
        h,
        mu,
        nu: dir.dot(light),
        muLight: lightMu,
        tMax,
        steps: 40,
        ground: select(ground, float(1), float(0)),
      });
      return vec4(L.mul(scale), 1);
    })();
  }

  private aerialPass(transmittance: boolean) {
    return Fn(() => {
      const p = uv();
      const px = p.x.mul(AP_AZIMUTH * AP_SLICES);
      const slice = floor(px.div(AP_AZIMUTH));
      const ix = floor(px.sub(slice.mul(AP_AZIMUTH)));
      const iy = floor(p.y.mul(AP_ELEVATION));
      const u = ix.div(AP_AZIMUTH - 1);
      const v = iy.div(AP_ELEVATION - 1);
      const azimuth = u.mul(u).mul(Math.PI);
      const e = v.mul(2).sub(1);
      const elevation = e
        .sign()
        .mul(e.mul(e))
        .mul(Math.PI / 2);
      const s = slice.add(1).div(AP_SLICES);
      const dist = s.mul(s).mul(AP_MAX_DISTANCE);
      const h = max(this.cameraHeight, 0.001);
      const r = h.add(R);
      const mu = sin(elevation);
      const cosEl = cos(elevation);
      const dir = vec3(cosEl.mul(cos(azimuth)), mu, cosEl.mul(sin(azimuth)));
      const lightMu = this.sunMu;
      const light = vec3(sqrt(max(float(1).sub(lightMu.mul(lightMu)), 0)), lightMu, 0);
      const ground = hitsGround(r, h, mu);
      const tEnd = select(ground, distanceToGround(r, h, mu), distanceToTop(r, h, mu));
      const { L, T } = this.scatter({
        h,
        mu,
        nu: dir.dot(light),
        muLight: lightMu,
        tMax: min(dist, tEnd),
        steps: 24,
        ground: null,
      });
      return transmittance ? vec4(T, 1) : vec4(L.mul(this.sunScale), 1);
    })();
  }
}
