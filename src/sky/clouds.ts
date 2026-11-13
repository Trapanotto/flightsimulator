/**
 * Volumetric cumulus clouds, ray-marched at reduced resolution and accumulated over frames.
 * Built like the Horizon Zero Dawn / Nubis clouds (Schneider 2015-2017) with Hillaire's
 * energy-conserving integration:
 *
 *  - Placement: a weather map (coverage cells, cloud type) thresholded by the cloud cover,
 *    drifting with the wind. Overcast fills the gaps to a deck.
 *  - Shape: Perlin-Worley base noise, remapped by coverage and a height profile (flat base,
 *    rounded tops, taller where the cell is dense), eroded by detail Worley noise (wispy at
 *    the base, billowy at the top).
 *  - Light: sun light marched towards the sun, multiple scattering by octaves (Wrenninge),
 *    two-lobe phase function, sky light from above and the ground's bounce from below.
 *  - The layer is a spherical shell on the curved Earth, so a deck meets the horizon right;
 *    the march stops at the scene depth (terrain occludes the clouds) and applies aerial
 *    perspective to what it found.
 *
 * Output (low resolution, pre-exposed): rgb = light from the clouds, a = transmittance.
 */
import {
  Data3DTexture,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RGBAFormat,
  RenderTarget,
  RendererUtils,
  RepeatWrapping,
  TempNode,
  UnsignedByteType,
  Vector2,
  Vector3,
  type NodeBuilder,
  type NodeFrame,
  type TextureNode,
} from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  clamp,
  context,
  exp,
  float,
  fract,
  max,
  min,
  mix,
  passTexture,
  screenCoordinate,
  select,
  sqrt,
  texture,
  texture3D,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { aerialLookup, sceneDistance, viewRay } from './aerial';
import { DETAIL_SIZE, SHAPE_SIZE, WEATHER_SIZE, type CloudNoise } from './cloudNoise';
import type { AtmosphereLuts } from './luts';
import { henyeyGreenstein, loop, type F, type V2, type V3, type V4 } from './nodes';
import type { SkyUniforms } from './uniforms';

/** Earth radius in metres (the cloud shells). */
const RE = 6_360_000;
/** Size of one tile of the weather map, metres: cumulus cells of 1-3 km. */
const WEATHER_PERIOD = 48_000;
/** Size of one tile of the shape noise, metres. */
const SHAPE_PERIOD = 5_200;
const DETAIL_PERIOD = 720;
/** Extinction of a dense cumulus, 1/m (a mean free path of ~25 m). */
const SIGMA = 0.07;
/** The clouds are marched to this distance at most, metres (beyond the view distance). */
const MAX_DISTANCE = 240_000;

export interface CloudQuality {
  /** Steps per view ray; 0 = no clouds. */
  steps: number;
  /** Steps towards the sun per sample. */
  lightSteps: number;
  /** Resolution of the march relative to the screen. */
  scale: number;
  /** Weight of the history in the temporal accumulation (0 = none). */
  history: number;
  /** Detail erosion (the most expensive texture reads). */
  detail: boolean;
  /** Samples of the cloud shadow on the ground per pixel; 0 = no shadows. */
  shadowSamples: number;
}

function noiseTexture3D(size: number): Data3DTexture {
  const tex = new Data3DTexture(new Uint8Array(size * size * size * 4), size, size, size);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

function weatherTexture(): DataTexture {
  const tex = new DataTexture(
    new Uint8Array(WEATHER_SIZE * WEATHER_SIZE * 4),
    WEATHER_SIZE,
    WEATHER_SIZE,
  );
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Ray against a sphere of height hs (m) from a camera at height hc: both roots (near, far). */
function shell(rc: F, mu: F, hc: F, hs: F | number) {
  const hsn = typeof hs === 'number' ? float(hs) : hs;
  const b = rc.mul(mu);
  // c = rc² - Rs² written with heights (no cancellation).
  const c = hc.sub(hsn).mul(hc.add(hsn).add(2 * RE));
  const disc = b.mul(b).sub(c);
  const sq = sqrt(max(disc, 0));
  // Stable roots: q = -b - sign(b) sqrt(disc), t = q and c / q.
  const q = b.negate().sub(select(b.greaterThanEqual(0), sq, sq.negate()));
  const tA = q;
  const tB = c.div(select(abs0(q), float(-1e-6), q));
  return { hit: disc.greaterThanEqual(0), near: min(tA, tB), far: max(tA, tB) };
}

const abs0 = (x: F) => x.abs().lessThan(1e-6);

export class CloudNode extends TempNode {
  static get type() {
    return 'SkyCloudNode';
  }

  readonly shape = noiseTexture3D(SHAPE_SIZE);
  readonly detail = noiseTexture3D(DETAIL_SIZE);
  readonly weather = weatherTexture();

  private readonly march = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  private history = [
    new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false }),
    new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false }),
  ];
  private readonly marchNode = texture(this.march.texture);
  private readonly weatherNode = texture(this.weather);
  private readonly shapeNode = texture3D(this.shape);
  private readonly detailNode = texture3D(this.detail);
  private readonly historyNode = texture(this.history[0]!.texture);
  private readonly output: TextureNode;
  private readonly quad = new QuadMesh(new NodeMaterial());
  private readonly marchMaterial = new NodeMaterial();
  private readonly accumMaterial = new NodeMaterial();
  private state?: RendererUtils.RendererState;
  private sharedContext: unknown = null;
  private readonly size = new Vector2();
  private built = false;

  /** Low-resolution size and its reciprocal, for the upsampling. */
  readonly lowSize = uniform(new Vector2(1, 1));
  readonly historyWeight = uniform(0.9);
  private readonly prevViewProj = uniform(new Matrix4());
  /** How far the render origin moved since the last frame (reprojection across a rebase). */
  private readonly originShift = uniform(new Vector3());
  private readonly prevOrigin = new Vector2();
  private hasHistory = false;
  private prevMatrix = new Matrix4();

  constructor(
    private readonly u: SkyUniforms,
    private readonly luts: AtmosphereLuts,
    private readonly depthNode: TextureNode,
    readonly quality: CloudQuality,
  ) {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.output = passTexture(this as never, this.history[0]!.texture);
    this.march.texture.name = 'sky.clouds.march';
    this.historyWeight.value = quality.history;
  }

  getTextureNode(): TextureNode {
    return this.output;
  }

  setNoise(n: CloudNoise) {
    (this.shape.image.data as Uint8Array).set(n.shape);
    this.shape.needsUpdate = true;
    (this.detail.image.data as Uint8Array).set(n.detail);
    this.detail.needsUpdate = true;
    (this.weather.image.data as Uint8Array).set(n.weather);
    this.weather.needsUpdate = true;
  }

  /** Called by the sky after the camera moved: remembers the matrix for the next frame. */
  setCamera(viewProj: Matrix4) {
    this.prevMatrix.copy(viewProj);
  }

  updateBefore(frame: NodeFrame): boolean | undefined {
    const renderer = frame.renderer!;
    this.state = RendererUtils.resetRendererState(renderer, this.state!);
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.round(this.size.x * this.quality.scale));
    const h = Math.max(1, Math.round(this.size.y * this.quality.scale));
    if (this.march.width !== w || this.march.height !== h) {
      this.march.setSize(w, h);
      for (const rt of this.history) rt.setSize(w, h);
      this.hasHistory = false;
    }
    this.lowSize.value.set(w, h);
    if (!this.built) {
      this.marchMaterial.contextNode = context(this.sharedContext as never);
      this.marchMaterial.fragmentNode = this.marchPass();
      this.accumMaterial.contextNode = context(this.sharedContext as never);
      this.accumMaterial.fragmentNode = this.accumPass();
      this.marchMaterial.needsUpdate = this.accumMaterial.needsUpdate = true;
      this.built = true;
    }
    this.u.frame.value = (this.u.frame.value + 1) % 1024;

    this.quad.material = this.marchMaterial;
    renderer.setRenderTarget(this.march);
    this.quad.render(renderer);

    const [prev, next] = this.history as [RenderTarget, RenderTarget];
    this.historyNode.value = prev.texture;
    this.historyWeight.value = this.hasHistory ? this.quality.history : 0;
    const off = this.u.originOffset.value;
    this.originShift.value.set(off.x - this.prevOrigin.x, 0, off.y - this.prevOrigin.y);
    this.quad.material = this.accumMaterial;
    renderer.setRenderTarget(next);
    this.quad.render(renderer);
    this.output.value = next.texture;
    this.history = [next, prev];
    this.hasHistory = true;
    this.prevViewProj.value.copy(this.prevMatrix);
    this.prevOrigin.copy(off);
    RendererUtils.restoreRendererState(renderer, this.state);
    return undefined;
  }

  setup(builder: NodeBuilder) {
    this.sharedContext = (builder as unknown as { getSharedContext(): unknown }).getSharedContext();
    return this.output;
  }

  dispose() {
    super.dispose();
    this.march.dispose();
    for (const rt of this.history) rt.dispose();
    this.marchMaterial.dispose();
    this.accumMaterial.dispose();
    this.shape.dispose();
    this.detail.dispose();
    this.weather.dispose();
  }

  /** Height (m) of a point at distance t along a ray from the camera (curved Earth). */
  private heightAt(rc: F, hc: F, mu: F, t: F): F {
    const num = t.mul(t.add(rc.mul(mu).mul(2)));
    return hc.add(num.div(sqrt(max(rc.mul(rc).add(num), 1)).add(rc)));
  }

  /** The segment of a view ray inside the cloud layer, metres; empty when t1 <= t0. */
  layer(dir: V3) {
    const u = this.u;
    const hc = u.altitude;
    const rc = hc.add(RE);
    const mu = dir.dot(u.up);
    const base = u.cloudBase;
    const top = u.cloudTop;
    const sb = shell(rc, mu, hc, base);
    const st = shell(rc, mu, hc, top);
    const sg = shell(rc, mu, hc, 0);
    const groundHit = mu.lessThan(0).and(sg.hit);
    const below = hc.lessThan(base);
    const above = hc.greaterThan(top);
    // Below: from the base sphere to the top sphere going up (nothing if the ground comes first).
    const t0Below = select(groundHit, float(1e9), sb.far);
    const t1Below = select(groundHit, float(0), st.far);
    // Above: from the top sphere down to the base sphere (or out again through the top).
    const downHit = mu.lessThan(0).and(st.hit);
    const t0Above = select(downHit, max(st.near, 0), float(1e9));
    const t1Above = select(downHit, select(sb.hit, sb.near, st.far), float(0));
    // Inside: from the camera to whichever boundary comes first.
    const t1Inside = select(mu.lessThan(0).and(sb.hit), sb.near, st.far);
    const t0 = select(below, t0Below, select(above, t0Above, float(0)));
    const t1 = select(below, t1Below, select(above, t1Above, t1Inside));
    return { t0, t1: min(t1, MAX_DISTANCE), mu, rc, hc };
  }

  /** Extinction (1/m) at a world position (east, south in m) and height (m). */
  density(q: V2, h: F, opts: { detail: boolean; distance?: F }): F {
    const u = this.u;
    const thickness = max(u.cloudTop.sub(u.cloudBase), 1);
    const hn = h.sub(u.cloudBase).div(thickness);
    const inside = hn.greaterThan(0).and(hn.lessThan(1));
    const p = q.add(u.windOffset);
    const wm = this.weatherNode.sample(p.div(WEATHER_PERIOD)).level(float(0)) as unknown as V4;
    const cover = u.cloudCover;
    // Coverage (Schneider 2017): the weather map's cells pass the threshold the cloud cover
    // sets; overcast fills the gaps. The outline itself comes from the 3D noise below, so
    // the weather map's soft contours never show.
    const field = wm.r.mul(0.85).add(wm.b.mul(0.15));
    const lo = float(1).sub(cover);
    const coverage = mix(
      smoothstep01(field, lo.sub(0.12), lo.add(0.2)),
      float(1),
      smoothstep01(cover, 0.75, 1).mul(0.9),
    ).mul(smoothstep01(cover, 0, 0.05));
    // Cloud type: overcast decks are stratiform (flat), fair weather cumulus taller in the
    // denser cells.
    const type = clamp(
      wm.g
        .mul(0.55)
        .add(coverage.mul(0.35))
        .add(cover.mul(0.2))
        .sub(smoothstep01(cover, 0.8, 1).mul(0.55)),
      0.05,
      1,
    );
    const topH = mix(0.45, 1.0, type).mul(mix(0.7, 1.0, coverage));
    // Shear: tops lean downwind; slow boiling.
    const s = vec3(p.x, h.mul(1.25), p.y)
      .add(vec3(u.windOffset.x, 0, u.windOffset.y).mul(hn.mul(0.06)))
      .add(vec3(u.time.mul(1.5), u.time.mul(0.4), 0));
    const n = this.shapeNode.sample(s.div(SHAPE_PERIOD)).level(float(0)) as unknown as V4;
    // Uneven bases: the bottom rises and falls a little with the noise.
    const lift = n.g.oneMinus().mul(0.08);
    const bottom = smoothstep01(hn, lift, lift.add(mix(0.04, 0.12, type)));
    // Rounded tops: the density fades over the upper part of the cloud's height.
    const roof = float(1).sub(smoothstep01(hn, topH.mul(mix(0.35, 0.6, type)), topH));
    const profile = bottom.mul(roof);
    const wfbm = n.g.mul(0.625).add(n.b.mul(0.25)).add(n.a.mul(0.125));
    const baseShape = remap(n.r, wfbm.sub(1), float(1), float(0), float(1)).mul(profile);
    // Sparse cells keep only their cores, and are thinner.
    let d = clamp(remap(baseShape, float(1).sub(coverage), float(1), float(0), float(1)), 0, 1).mul(
      sqrt(coverage),
    );
    if (opts.detail && this.quality.detail) {
      const dn = this.detailNode.sample(s.div(DETAIL_PERIOD)).level(float(0)) as unknown as V4;
      const dfbm = dn.r.mul(0.625).add(dn.g.mul(0.25)).add(dn.b.mul(0.125));
      // Wispy at the base, billowy (cauliflower) towards the top.
      const m = mix(dfbm, dfbm.oneMinus(), clamp(hn.mul(5), 0, 1));
      // Far away the fine erosion only adds noise.
      const k = opts.distance
        ? float(0.45).mul(float(1).sub(smoothstep01(opts.distance, 15_000, 50_000).mul(0.7)))
        : float(0.45);
      d = clamp(remap(d, m.mul(k), float(1), float(0), float(1)), 0, 1);
    } else {
      // Without detail erosion (light march, mobile) erode by the mean, so the volume matches.
      d = clamp(remap(d, float(0.12), float(1), float(0), float(1)), 0, 1);
    }
    // Decks are less dense than towering cumulus.
    const sigma = mix(SIGMA * 0.55, SIGMA, type);
    // Steepen the edge: real cumulus end within tens of metres, the noise ramps over hundreds.
    const dense = opts.detail ? clamp(d.mul(3), 0, 1) : clamp(d.mul(2), 0, 1);
    return select(inside, dense.mul(dense.mul(-0.5).add(1.5)).mul(sigma), float(0));
  }

  private marchPass(): V4 {
    const u = this.u;
    const q = this.quality;
    return Fn(() => {
      const p = uv();
      const rayV = viewRay(u, p);
      const dir = u.cameraRotation.mul(rayV).normalize();
      const depth = (this.depthNode.sample(p) as unknown as V4).x;
      const scene = sceneDistance(u, depth, rayV);
      const sceneDist = select(scene.sky, float(1e9), scene.dist);
      const L = this.layer(dir);
      const t0 = L.t0;
      const t1 = min(L.t1, sceneDist);
      const result = vec4(0, 0, 0, 1).toVar();
      If(t1.greaterThan(t0).and(u.cloudCover.greaterThan(0.001)), () => {
        // Jitter per pixel and frame (interleaved gradient noise, golden ratio in time): the
        // accumulation turns the step pattern into a smooth average.
        const coord = screenCoordinate.xy;
        const jitter = fract(
          fract(coord.x.mul(0.06711056).add(coord.y.mul(0.00583715)))
            .mul(52.9829189)
            .add(u.frame.mul(0.61803399)),
        );
        const len = t1.sub(t0);
        // Steps grow along long rays (fine near, coarse far), uniform through a thin layer.
        const K = clamp(len.div(20_000), 0.05, 4.0);
        const norm = len.div(exp(K).sub(1));
        const sunUp = u.lightDir.dot(u.up);
        const cosSun = dir.dot(u.lightDir);
        // Phase per scattering octave (constant along the ray), capped against fireflies.
        const phase2 = (c: F, k: number) =>
          mix(henyeyGreenstein(c, 0.8 * k), henyeyGreenstein(c, -0.25 * k), 0.35).mul(4 * Math.PI);
        const ph0 = min(phase2(cosSun, 1), 9);
        const ph1 = min(phase2(cosSun, 0.5), 4);
        const ph2 = min(phase2(cosSun, 0.25), 2);
        const powderMix = clamp(cosSun.mul(-0.5).add(0.5), 0, 1);
        const scatter = vec3(0).toVar();
        const T = float(1).toVar();
        const wSum = float(0).toVar();
        const wDist = float(0).toVar();
        loop('ci', q.steps, (i) => {
          const s0 = float(i).add(jitter).div(q.steps);
          const t = t0.add(norm.mul(exp(K.mul(s0)).sub(1)));
          const dt = norm
            .mul(K)
            .mul(exp(K.mul(s0)))
            .div(q.steps);
          const pos = u.cameraPosition.add(dir.mul(t));
          const qxz = vec2(pos.x, pos.z).add(u.originOffset);
          const h = this.heightAt(L.rc, L.hc, L.mu, t);
          const sigma = this.density(qxz, h, { detail: true, distance: t });
          If(sigma.greaterThan(1e-5), () => {
            // Optical depth towards the sun, steps growing from 30 m (cheap density).
            const od = float(0).toVar();
            const ls = float(30).toVar();
            const lp = pos.toVar();
            const lh = h.toVar();
            loop('cl', q.lightSteps, () => {
              lp.addAssign(u.lightDir.mul(ls));
              lh.addAssign(sunUp.mul(ls));
              const lq = vec2(lp.x, lp.z).add(u.originOffset);
              od.addAssign(this.density(lq, lh, { detail: false }).mul(ls));
              ls.mulAssign(1.9);
            });
            // Multiple scattering (Wrenninge): octaves see less extinction, a softer phase.
            const ms = exp(od.negate())
              .mul(ph0)
              .add(exp(od.mul(-0.4)).mul(ph1).mul(0.45))
              .add(exp(od.mul(-0.15)).mul(ph2).mul(0.2));
            const powder = float(1).sub(exp(od.mul(-2).sub(sigma.mul(60))));
            const msp = ms.mul(mix(float(1), powder.mul(1.7), powderMix));
            const hn = clamp(h.sub(u.cloudBase).div(max(u.cloudTop.sub(u.cloudBase), 1)), 0, 1);
            const light = u.cloudSun
              .mul(msp)
              .add(u.cloudAmbient.mul(sqrt(hn).mul(0.7).add(0.3)))
              .add(u.groundRadiance.mul(hn.oneMinus().mul(0.5)));
            const stepT = exp(sigma.mul(dt).negate());
            const w = T.mul(stepT.oneMinus());
            scatter.addAssign(light.mul(w));
            wDist.addAssign(w.mul(t));
            wSum.addAssign(w);
            T.mulAssign(stepT);
          });
          If(T.lessThan(0.01), () => {
            Break();
          });
        });
        // Aerial perspective on the clouds at their weighted distance.
        const dist = select(wSum.greaterThan(1e-4), wDist.div(max(wSum, 1e-4)), t0);
        const ap = aerialLookup(u, this.luts, dir, dist.mul(0.001));
        const haze = ap.inscatter.mul(u.exposure).mul(float(1).sub(u.hazeShadow.mul(0.6)));
        const lit = scatter.mul(ap.transmittance).add(haze.mul(T.oneMinus()));
        result.assign(vec4(lit, T));
      });
      return result;
    })() as unknown as V4;
  }

  /** Temporal accumulation: blend with last frame's result where this cloud was then. */
  private accumPass(): V4 {
    const u = this.u;
    return Fn(() => {
      const p = uv();
      const cur = this.marchNode.sample(p) as unknown as V4;
      const rayV = viewRay(u, p);
      const dir = u.cameraRotation.mul(rayV).normalize();
      const L = this.layer(dir);
      const dist = select(L.t1.greaterThan(L.t0), L.t0.add(L.t1.sub(L.t0).mul(0.3)), float(5000));
      const world = u.cameraPosition.add(dir.mul(min(dist, 200_000))).add(this.originShift);
      const clip = this.prevViewProj.mul(vec4(world, 1));
      const ndc = clip.xy.div(clip.w);
      const prevUv = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)));
      const valid = clip.w
        .greaterThan(0)
        .and(prevUv.x.greaterThan(0))
        .and(prevUv.y.greaterThan(0))
        .and(prevUv.x.lessThan(1))
        .and(prevUv.y.lessThan(1));
      // Clamp the history to the current neighbourhood: no ghosts when things change.
      const texel = vec2(1).div(this.lowSize);
      const lo = vec4(cur).toVar();
      const hi = vec4(cur).toVar();
      for (const [x, y] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
        [-1, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
      ] as const) {
        const n = this.marchNode.sample(p.add(texel.mul(vec2(x, y)))) as unknown as V4;
        lo.assign(min(lo, n));
        hi.assign(max(hi, n));
      }
      const hist = clamp(this.historyNode.sample(prevUv) as unknown as V4, lo, hi);
      const w = select(valid, this.historyWeight, float(0));
      return mix(cur, hist, w);
    })() as unknown as V4;
  }

  /**
   * Light the clouds take from the sun along the way down to a point: transmittance of the
   * layer towards the sun from a ground point (for cloud shadows in the post pass).
   */
  shadow(pos: V3, h: F, samples: number): F {
    const u = this.u;
    const sunUp = max(u.lightDir.dot(u.up), 0.03);
    const od = float(0).toVar();
    const thickness = u.cloudTop.sub(u.cloudBase);
    for (let i = 0; i < samples; i++) {
      const hs = u.cloudBase.add(thickness.mul((i + 0.5) / samples));
      const t = max(hs.sub(h), 0).div(sunUp);
      const sp = pos.add(u.lightDir.mul(t));
      const q = vec2(sp.x, sp.z).add(u.originOffset);
      od.addAssign(this.density(q, hs, { detail: false }).mul(thickness.div(sunUp).div(samples)));
    }
    // Clouds scatter much of the light forward: the shadow under a thin cloud is not black.
    return exp(od.mul(-0.6)).toVar();
  }
}

function remap(x: F, a: F, b: F, c: F, d: F): F {
  return c.add(
    x
      .sub(a)
      .div(max(b.sub(a), 1e-4))
      .mul(d.sub(c)),
  );
}

function smoothstep01(x: F, a: F | number, b: F | number): F {
  const an = typeof a === 'number' ? float(a) : a;
  const bn = typeof b === 'number' ? float(b) : b;
  const t = clamp(x.sub(an).div(max(bn.sub(an), 1e-5)), 0, 1);
  return t.mul(t).mul(float(3).sub(t.mul(2)));
}
