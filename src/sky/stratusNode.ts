/**
 * The stratus deck in the post pass, at full resolution and without a march through its
 * volume: per pixel the ray's segment below the deck's top, the optical depth along it from
 * the analytic profile (stratus.ts), the point where the deck's light comes from (a short
 * bisection on that optical depth) and the light there. Only the billowy top is searched
 * for with a few texture reads along the ray, where the ray comes down to it from above.
 *
 * Everything is a continuous function of the camera height, so flying through the base and
 * the top never pops, and with no noise in the integration nothing flickers or bands.
 */
import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  RepeatWrapping,
} from 'three/webgpu';
import {
  If,
  clamp,
  exp,
  float,
  fract,
  log,
  log2,
  max,
  min,
  mix,
  normalize,
  pow,
  screenCoordinate,
  screenSize,
  select,
  smoothstep,
  sqrt,
  texture,
  vec2,
  vec3,
} from 'three/tsl';
import { shell } from './clouds';
import { henyeyGreenstein, type F, type V3, type V4 } from './nodes';
import {
  BILLOW_GRADIENT_SCALE,
  BILLOW_PERIOD,
  BILLOW_SIZE,
  billowData,
  sampleBillow,
} from './stratus';
import type { SkyUniforms } from './uniforms';

const RE = 6_360_000;

/**
 * A ray against a sphere with its results in variables. TSL turns a select with branches
 * into if/else and emits a node shared by two branches only in the first: the second then
 * reads it uninitialised. Everything used on more than one path is made a variable first.
 */
function shellVar(rc: F, mu: F, hc: F, hs: F) {
  const s = shell(rc, mu, hc, hs);
  return { hit: s.hit.toVar(), near: s.near.toVar(), far: s.far.toVar() };
}
const TEXEL = BILLOW_PERIOD / BILLOW_SIZE;
const FAR = 1e9;

export interface StratusQuality {
  /** Texture reads along the ray to find the billowy top from above (at least 2). */
  steps: number;
  /** Bisection steps for the depth the deck's light comes from. */
  bisection: number;
  /** Ragged scud under the base (one more texture read). */
  scud: boolean;
}

export interface StratusSample {
  /** Light of the deck and the mist along the ray (pre-exposed, before the air in front). */
  color: V3;
  /** Transmittance of the deck and the mist along the ray. */
  transmittance: F;
  /** Distance the deck's light comes from (the aerial perspective in front of it). */
  distance: F;
}

export class StratusLayer {
  /** The billows on the CPU too: the camera's own top is read from the same data. */
  readonly data = billowData(BILLOW_SIZE);
  readonly texture: DataTexture;
  private readonly node;

  constructor(
    private readonly u: SkyUniforms,
    readonly quality: StratusQuality,
  ) {
    const half = new Uint16Array(this.data.length);
    for (let i = 0; i < half.length; i++) half[i] = DataUtils.toHalfFloat(this.data[i]!);
    const tex = new DataTexture(half, BILLOW_SIZE, BILLOW_SIZE);
    tex.format = RGBAFormat;
    tex.type = HalfFloatType;
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    tex.name = 'sky.stratus.billows';
    this.texture = tex;
    this.node = texture(tex);
  }

  /** Height of the top (m) at a point of the fixed east/south frame, as the shader sees it. */
  topAt(east: number, south: number): number {
    const u = this.u;
    const s = sampleBillow(
      this.data,
      BILLOW_SIZE,
      (east + u.stratusOffset.value.x) / BILLOW_PERIOD,
      (south + u.stratusOffset.value.y) / BILLOW_PERIOD,
    );
    return u.stratusTop.value + (s[0]! - 0.5) * 2 * u.stratusAmplitude.value;
  }

  dispose() {
    this.texture.dispose();
  }

  /** Integral of the extinction from sea level to h, for a local base and top shift. */
  private cumulative(h: F, dBase: F, dTop: F): F {
    const u = this.u;
    const k = [
      u.stratusH.x,
      u.stratusH.y.add(dBase),
      u.stratusH.z.add(dBase),
      u.stratusH.w.add(dTop),
      u.stratusH4.add(dTop),
    ];
    const s = [u.stratusS.x, u.stratusS.y, u.stratusS.z, u.stratusS.w, float(0)];
    let sum = s[0]!.mul(min(h, k[0]!));
    for (let i = 0; i < 4; i++) {
      const d = max(k[i + 1]!.sub(k[i]!), 1e-3);
      const x = clamp(h, k[i]!, k[i + 1]!).sub(k[i]!);
      sum = sum.add(s[i]!.mul(x).add(s[i + 1]!.sub(s[i]!).mul(x.mul(x)).div(d.mul(2))));
    }
    return sum;
  }

  private extinction(h: F, dBase: F, dTop: F): F {
    const u = this.u;
    const k = [
      u.stratusH.x,
      u.stratusH.y.add(dBase),
      u.stratusH.z.add(dBase),
      u.stratusH.w.add(dTop),
      u.stratusH4.add(dTop),
    ];
    const s = [u.stratusS.x, u.stratusS.y, u.stratusS.z, u.stratusS.w, float(0)];
    for (let i = 1; i < 5; i++) k[i] = k[i]!.toVar();
    let v: F = float(0);
    for (let i = 3; i >= 0; i--) {
      const f = clamp(h.sub(k[i]!).div(max(k[i + 1]!.sub(k[i]!), 1e-3)), 0, 1);
      v = select(h.lessThanEqual(k[i + 1]!), mix(s[i]!, s[i + 1]!, f), v);
    }
    return select(h.lessThanEqual(k[0]!), s[0]!, v);
  }

  /** Optical depth of a straight piece of `len` metres from height h0 to h1. */
  private depth(h0: F, h1: F, len: F, dBase: F, dTop: F, s0?: F, s1?: F): F {
    const dh = h1.sub(h0);
    const c0 = s0 ?? this.cumulative(h0, dBase, dTop);
    const c1 = s1 ?? this.cumulative(h1, dBase, dTop);
    const mean = select(
      dh.abs().greaterThan(0.5),
      c1.sub(c0).div(dh),
      this.extinction(h0.add(h1).mul(0.5), dBase, dTop),
    );
    return max(mean, 0).mul(max(len, 0));
  }

  /** Height (m) at distance t along a ray from the camera (curved Earth). */
  private heightAt(rc: F, hc: F, mu: F, t: F): F {
    const num = t.mul(t.add(rc.mul(mu).mul(2)));
    return hc.add(num.div(sqrt(max(rc.mul(rc).add(num), 1)).add(rc)));
  }

  /** The billow texture at distance t along the ray, filtered to `footprint` metres. */
  private billow(dir: V3, t: F, footprint: F): V4 {
    const u = this.u;
    const p = u.cameraPosition.add(dir.mul(t));
    const q = vec2(p.x, p.z).add(u.originOffset).add(u.stratusOffset).div(BILLOW_PERIOD);
    const lod = log2(max(footprint.div(TEXEL), 1));
    return this.node.sample(q).level(lod) as unknown as V4;
  }

  /**
   * The deck along a view ray up to `dist` metres (pass FAR, 1e9, for empty sky).
   */
  trace(dir: V3, dist: F): StratusSample {
    const u = this.u;
    const q = this.quality;
    const hc = u.altitude;
    const rc = hc.add(RE).toVar();
    const mu = dir.dot(u.up).toVar();
    const amp = u.stratusAmplitude;
    const top = u.stratusTop;
    const color = vec3(0).toVar();
    const T = float(1).toVar();
    const tMed = float(dist).toVar();

    // Nothing above the highest billow plus its soft fringe has any extinction.
    const topMax = u.stratusH4.add(amp).toVar();
    const st = shellVar(rc, mu, hc, topMax);
    const camIn = hc.lessThan(topMax).toVar();
    const ta = select(
      camIn,
      float(0),
      select(mu.lessThan(0).and(st.hit), max(st.near, 0), float(FAR)),
    ).toVar();
    const tb = min(dist, select(camIn, st.far, select(st.hit, st.far, float(0)))).toVar();
    If(u.stratusOn.greaterThan(0.5).and(tb.greaterThan(ta)), () => {
      // Size of a pixel's footprint per metre of distance, and a ray's elongation on the deck.
      const pixel = float(2).div(u.projection.y.mul(screenSize.y)).toVar();
      // A pixel's footprint on the deck stretches along a grazing ray; filtering by the long
      // side would flatten the billows towards the horizon, by the short one alias them.
      const grazing = sqrt(float(1).div(max(mu.abs(), 0.03))).toVar();
      const tStar = max(rc.mul(mu).negate(), 0).toVar();

      // The billowy top: march the band the billows occupy from where the ray enters it.
      const dTop = u.stratusTopAtCamera.sub(top).toVar();
      const slope = vec2(0).toVar();
      If(hc.greaterThan(top.sub(amp)), () => {
        const lower = shellVar(rc, mu, hc, top.sub(amp));
        const tBand = clamp(
          select(mu.lessThan(0).and(lower.hit), lower.near, tStar),
          ta,
          tb,
        ).toVar();
        const n = Math.max(q.steps, 2);
        const stepLen = tBand
          .sub(ta)
          .div(n - 1)
          .toVar();
        const gap = (t: F) => {
          const b = this.billow(dir, t, max(t.mul(pixel).mul(grazing), stepLen.mul(0.5)));
          const local = top.add(b.x.sub(0.5).mul(amp.mul(2)));
          return this.heightAt(rc, hc, mu, t).sub(local);
        };
        let prevT: F = ta;
        let prevD: F = gap(ta).toVar();
        const found = prevD.lessThan(0).toVar();
        const tHit = select(found, ta, tBand).toVar();
        for (let i = 1; i < n; i++) {
          const t = mix(ta, tBand, i / (n - 1)).toVar();
          const d = gap(t).toVar();
          const hit = found.not().and(d.lessThan(0));
          // Secant between the last sample above the top and the first below it.
          const ts = prevT.add(t.sub(prevT).mul(prevD.div(max(prevD.sub(d), 1e-3))));
          tHit.assign(select(hit, ts, tHit));
          found.assign(found.or(d.lessThan(0)));
          prevT = t;
          prevD = d;
        }
        const foot = max(tHit.mul(pixel).mul(grazing), stepLen.mul(0.25));
        const b = this.billow(dir, tHit, foot);
        dTop.assign(b.x.sub(0.5).mul(amp.mul(2)));
        // Gradient per period -> slope in metres per metre.
        slope.assign(
          vec2(b.y, b.z)
            .sub(0.5)
            .mul((2 * BILLOW_GRADIENT_SCALE) / BILLOW_PERIOD)
            .mul(amp.mul(2)),
        );
      });

      // Ragged scud: the base hangs lower in patches, read where the ray crosses it.
      const dBase = float(0).toVar();
      const scudN = float(0).toVar();
      if (q.scud) {
        const sb = shellVar(rc, mu, hc, u.stratusBase);
        const tX = select(
          hc.lessThan(u.stratusBase),
          select(mu.greaterThan(0), sb.far, float(0)),
          select(mu.lessThan(0).and(sb.hit), sb.near, float(0)),
        );
        const tXc = min(tX, 60_000);
        const b = this.billow(dir, tXc, max(tXc.mul(pixel).mul(grazing), 1));
        scudN.assign(smoothstep(0.4, 0.85, b.w));
        dBase.assign(scudN.mul(u.stratusScud).negate());
      }

      // Optical depth in two pieces split at the ray's lowest point (heights are monotonic
      // on each, so the profile's integral applies).
      const tm = clamp(tStar, ta, tb).toVar();
      const ha = this.heightAt(rc, hc, mu, ta).toVar();
      const hm = this.heightAt(rc, hc, mu, tm).toVar();
      const hb = this.heightAt(rc, hc, mu, tb).toVar();
      const ca = this.cumulative(ha, dBase, dTop).toVar();
      const cm = this.cumulative(hm, dBase, dTop).toVar();
      const od1 = this.depth(ha, hm, tm.sub(ta), dBase, dTop, ca, cm);
      const od2 = this.depth(hm, hb, tb.sub(tm), dBase, dTop, cm);
      const od = od1.add(od2).toVar();
      T.assign(exp(od.negate()));

      // Where the transmittance has fallen halfway to its final value: the deck's light
      // comes from around there. Searched on a cubic scale, fine close to the entry.
      const target = log(T.add(1).mul(0.5)).negate().toVar();
      const odTo = (t: F) => {
        const t1 = min(t, tm);
        const first = this.depth(ha, this.heightAt(rc, hc, mu, t1), t1.sub(ta), dBase, dTop, ca);
        const second = this.depth(hm, this.heightAt(rc, hc, mu, t), t.sub(tm), dBase, dTop, cm);
        return first.add(select(t.greaterThan(tm), second, float(0)));
      };
      const lo = float(0).toVar();
      const hi = float(1).toVar();
      const span = tb.sub(ta).toVar();
      for (let i = 0; i < q.bisection; i++) {
        const mid = lo.add(hi).mul(0.5);
        const below = odTo(ta.add(span.mul(mid.mul(mid).mul(mid)))).lessThan(target);
        lo.assign(select(below, mid, lo));
        hi.assign(select(below, hi, mid));
      }
      const sMed = lo.add(hi).mul(0.5);
      tMed.assign(ta.add(span.mul(sMed.mul(sMed).mul(sMed))));
      const h = this.heightAt(rc, hc, mu, tMed).toVar();

      // The light there: grey mist, the base, brightening towards the top.
      const bEff = u.stratusBase.add(dBase).toVar();
      const tEff = top.add(dTop).toVar();
      const lightBase = u.stratusLightBase.mul(float(1).sub(scudN.mul(0.25))).toVar();
      const inside = mix(
        lightBase,
        u.stratusLightTop,
        clamp(h.sub(bEff).div(max(tEff.sub(bEff), 1)), 0, 1),
      );
      const mist = mix(u.stratusLightMist, lightBase, smoothstep(u.stratusH.x, bEff, h));
      const L = select(h.lessThan(bEff), mist, inside).toVar();
      // Seen from above: the top lit by the sun, its billows shaded by their slopes.
      const above = smoothstep(tEff.sub(15), tEff.add(25), hc);
      const normal = normalize(u.up.add(vec3(slope.x.negate(), 0, slope.y.negate())));
      const sunUp = max(u.lightDir.dot(u.up), 0);
      const shade = max(normal.dot(u.lightDir).mul(0.85).add(sunUp.mul(0.15)), 0);
      const cosSun = dir.dot(u.lightDir);
      const silver = pow(max(cosSun, 0), 12).mul(1.5).add(1);
      const surface = u.stratusSun.mul(shade).mul(silver).add(u.stratusSky);
      L.assign(mix(L, surface, above));
      // Through a thin deck the light shines as a pale glow around its disc.
      const aureole = u.stratusAureole
        .mul(henyeyGreenstein(cosSun, 0.75).mul(4 * Math.PI))
        .mul(above.oneMinus());
      // A static dither of a fraction of a display step: the deck's gradients are so gentle
      // that eight bits would draw rings around the sun and lines along the horizon.
      const c = screenCoordinate.xy;
      const noise = fract(fract(c.x.mul(0.06711056).add(c.y.mul(0.00583715))).mul(52.9829189));
      color.assign(L.add(aureole).mul(T.oneMinus()).mul(noise.sub(0.5).mul(0.008).add(1)));
    });
    return { color, transmittance: T, distance: tMed };
  }
}
