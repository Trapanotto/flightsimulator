/**
 * Shader building blocks of the atmosphere (TSL): the medium, phase functions, ray-sphere
 * geometry and the parametrisations of the lookup tables. Shared by the table passes
 * (luts.ts), the sky dome, the aerial perspective and the clouds, so all of them see the
 * same air.
 *
 * Heights in kilometres; numerically fragile differences of squared radii are written in
 * terms of heights (r² - R² = h (2R + h)), because r² of the planet is ~4e7 and single
 * precision would lose metres there.
 */
import type { Node } from 'three/webgpu';
import { Loop, abs, acos, clamp, exp, float, max, pow, select, sqrt, vec2, vec3 } from 'three/tsl';
import {
  ATMOSPHERE_TOP,
  EARTH_RADIUS,
  MIE_EXTINCTION,
  MIE_G,
  MIE_SCALE_HEIGHT,
  MIE_SCATTERING,
  OZONE_ABSORPTION,
  OZONE_CENTER,
  OZONE_HALF_WIDTH,
  RAYLEIGH_SCALE_HEIGHT,
  RAYLEIGH_SCATTERING,
} from './atmosphere';

export type F = Node<'float'>;
export type V2 = Node<'vec2'>;
export type V3 = Node<'vec3'>;
export type V4 = Node<'vec4'>;
export type B = Node<'bool'>;

/** The colour of a texture sample (the typings lose the vec4 of a texture node). */
export const rgb = (n: unknown): V3 => (n as V4).rgb;

export const R = EARTH_RADIUS;
export const TOP = ATMOSPHERE_TOP;
export const ATMOSPHERE_HEIGHT = TOP - R;
/** Distance from the ground to the horizon of the top of the atmosphere. */
const H_TOP = Math.sqrt(TOP * TOP - R * R);

export const TRANSMITTANCE_SIZE = [256, 64] as const;
export const MULTI_SCATTERING_SIZE = 32;
export const SKY_VIEW_SIZE = [192, 108] as const;
/** Aerial perspective atlas: azimuth x elevation per slice, slices side by side. */
export const AP_AZIMUTH = 32;
export const AP_ELEVATION = 32;
export const AP_SLICES = 32;
/** Farthest distance the aerial perspective table covers, km (view distance plus curvature). */
export const AP_MAX_DISTANCE = 220;

/** Scattering and extinction of the air at height h (km), 1/km. */
export function medium(h: F, mieDensity: F) {
  const hc = max(h, 0);
  const dR = exp(hc.mul(-1 / RAYLEIGH_SCALE_HEIGHT));
  const dM = exp(hc.mul(-1 / MIE_SCALE_HEIGHT)).mul(mieDensity);
  const dO = max(float(1).sub(abs(h.sub(OZONE_CENTER)).div(OZONE_HALF_WIDTH)), 0);
  const scatR = vec3(...RAYLEIGH_SCATTERING).mul(dR);
  const scatM = dM.mul(MIE_SCATTERING);
  const ext = scatR.add(dM.mul(MIE_EXTINCTION)).add(vec3(...OZONE_ABSORPTION).mul(dO));
  return { scatR, scatM, ext };
}

export function rayleighPhase(c: F): F {
  return c
    .mul(c)
    .add(1)
    .mul(3 / (16 * Math.PI));
}

/** Cornette-Shanks: like Henyey-Greenstein, with the Rayleigh-like back lobe of real haze. */
export function miePhase(c: F, g = MIE_G): F {
  const g2 = g * g;
  const k = (3 / (8 * Math.PI)) * ((1 - g2) / (2 + g2));
  return c
    .mul(c)
    .add(1)
    .mul(k)
    .div(pow(max(c.mul(-2 * g).add(1 + g2), 1e-4), 1.5));
}

export function henyeyGreenstein(c: F, g: F | number): F {
  const gn = typeof g === 'number' ? float(g) : g;
  const g2 = gn.mul(gn);
  return float(1)
    .sub(g2)
    .div(pow(max(g2.add(1).sub(gn.mul(c).mul(2)), 1e-4), 1.5))
    .mul(1 / (4 * Math.PI));
}

/** r² (mu² - 1) + s², written with heights: the discriminant of a ray against a sphere. */
function discriminant(r: F, h: F, mu: F, hs: number): F {
  // s² - r² = (hs - h) (2R + hs + h)
  return r
    .mul(r)
    .mul(mu.mul(mu))
    .add(
      float(hs)
        .sub(h)
        .mul(h.add(2 * R + hs)),
    );
}

/** Whether a ray from height h (km) with zenith cosine mu hits the ground. */
export function hitsGround(r: F, h: F, mu: F): B {
  return mu.lessThan(0).and(discriminant(r, h, mu, 0).greaterThanEqual(0));
}

export function distanceToGround(r: F, h: F, mu: F): F {
  return r
    .mul(mu)
    .negate()
    .sub(sqrt(max(discriminant(r, h, mu, 0), 0)));
}

export function distanceToTop(r: F, h: F, mu: F): F {
  return r
    .mul(mu)
    .negate()
    .add(sqrt(max(discriminant(r, h, mu, ATMOSPHERE_HEIGHT), 0)));
}

/** Zenith cosine of the horizon seen from height h. */
export function horizonMu(h: F): F {
  const r = h.add(R);
  return sqrt(max(h.mul(h.add(2 * R)), 0))
    .div(r)
    .negate();
}

const toSub = (u: F, size: number): F => u.mul(1 - 1 / size).add(0.5 / size);

/** Bruneton's parametrisation of the transmittance table (rays that miss the ground). */
export function transmittanceUV(h: F, mu: F): V2 {
  const r = h.add(R);
  const rho = sqrt(max(h.mul(h.add(2 * R)), 0));
  const d = max(distanceToTop(r, h, mu), 0);
  const dMin = float(ATMOSPHERE_HEIGHT).sub(h);
  const dMax = rho.add(H_TOP);
  const x = d.sub(dMin).div(max(dMax.sub(dMin), 1e-4));
  const y = rho.div(H_TOP);
  return vec2(toSub(clamp(x, 0, 1), TRANSMITTANCE_SIZE[0]), toSub(y, TRANSMITTANCE_SIZE[1]));
}

export function multiScatteringUV(h: F, muSun: F): V2 {
  return vec2(
    toSub(clamp(muSun.mul(0.5).add(0.5), 0, 1), MULTI_SCATTERING_SIZE),
    toSub(clamp(h.div(ATMOSPHERE_HEIGHT), 0, 1), MULTI_SCATTERING_SIZE),
  );
}

/**
 * Hillaire's sky-view parametrisation: the horizon in the middle row, rows crowded towards it
 * (that is where the sky changes fastest), azimuth from the light crowded towards the light.
 * `azimuth` is the angle between the view and the light around the zenith, 0..π.
 */
export function skyViewUV(h: F, mu: F, azimuth: F, ground: B): V2 {
  const r = h.add(R);
  const vHorizon = sqrt(max(h.mul(h.add(2 * R)), 0));
  const beta = acos(clamp(vHorizon.div(r), -1, 1));
  const zenithHorizon = float(Math.PI).sub(beta);
  const viewZenith = acos(clamp(mu, -1, 1));
  const above = float(1)
    .sub(sqrt(max(float(1).sub(viewZenith.div(zenithHorizon)), 0)))
    .mul(0.5);
  const below = sqrt(clamp(viewZenith.sub(zenithHorizon).div(max(beta, 1e-4)), 0, 1))
    .mul(0.5)
    .add(0.5);
  const v = select(ground, below, above);
  const u = sqrt(clamp(azimuth.div(Math.PI), 0, 1));
  return vec2(toSub(u, SKY_VIEW_SIZE[0]), toSub(v, SKY_VIEW_SIZE[1]));
}

/** Elevation mapping of the aerial perspective table: crowded towards the horizontal. */
export function apElevationToV(sinEl: F): F {
  const el = sinEl.asin();
  return el
    .sign()
    .mul(sqrt(abs(el).div(Math.PI / 2)))
    .mul(0.5)
    .add(0.5);
}

export function apAzimuthToU(azimuth: F): F {
  return sqrt(clamp(azimuth.div(Math.PI), 0, 1));
}

/** Azimuth (0..π) between a direction and the light around the local up. */
export function azimuthBetween(dir: V3, light: V3, up: V3): F {
  const a = dir.sub(up.mul(dir.dot(up)));
  const b = light.sub(up.mul(light.dot(up)));
  const c = a.dot(b).div(max(a.length().mul(b.length()), 1e-6));
  return acos(clamp(c, -1, 1));
}

/** Smooth planet shadow for a point at height h towards a light at zenith cosine mu. */
export function lightVisibility(h: F, mu: F, angularRadius = 0.0047): F {
  const x = mu.sub(horizonMu(h)).div(angularRadius);
  return clamp(x.mul(0.5).add(0.5), 0, 1);
}

/**
 * A counted loop with its own variable name: nested TSL loops would otherwise all call their
 * counter `i` and shadow each other.
 */
export function loop(name: string, count: number | Node<'int'>, body: (i: Node<'int'>) => void) {
  const params = { start: 0, end: count, type: 'int', condition: '<', name };
  (Loop as unknown as (p: object, f: (v: Record<string, Node<'int'>>) => void) => void)(
    params,
    (vars) => body(vars[name]!),
  );
}
