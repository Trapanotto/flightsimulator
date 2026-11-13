/**
 * The radiance of the sky in a direction: the sky-view tables of sun and moon, the sun and
 * moon discs, the stars and the faint glow of the night sky. Used by the dome the camera sees
 * and, without the discs, by the environment map.
 */
import {
  abs,
  acos,
  clamp,
  exp,
  float,
  floor,
  fwidth,
  hash,
  max,
  min,
  mix,
  normalize,
  pow,
  select,
  smoothstep,
  sqrt,
  vec2,
  vec3,
} from 'three/tsl';
import { LUMA, MOON_ANGULAR_RADIUS, SOLAR_ILLUMINANCE_LUX, SUN_ANGULAR_RADIUS } from './atmosphere';
import type { AtmosphereLuts } from './luts';
import { R, azimuthBetween, hitsGround, rgb, skyViewUV, type F, type V3 } from './nodes';
import type { SkyUniforms } from './uniforms';

/** Brightest sun disc radiance after exposure: keeps the half-float scene buffer finite. */
const MAX_DISC = 30_000;

/** Night sky glow, cd/m²: airglow at the zenith, more towards the horizon (light pollution). */
const NIGHT_ZENITH = 3e-4;
const NIGHT_HORIZON = 1.6e-3;

export interface SkyOptions {
  /** Sun and moon discs and stars (the environment map leaves them out: they are lights). */
  discs: boolean;
}

export function skyRadiance(
  dir: V3,
  u: SkyUniforms,
  luts: AtmosphereLuts,
  opts: SkyOptions,
  pixelAngle?: F,
): V3 {
  const up = u.up;
  const h = max(u.altitude.mul(0.001), 0.001);
  const r = h.add(R);
  const mu = dir.dot(up);
  const ground = hitsGround(r, h, mu);
  const azSun = azimuthBetween(dir, u.sunDir, up);
  const azMoon = azimuthBetween(dir, u.moonDir, up);
  const sky = rgb(luts.skyViewSunNode.sample(skyViewUV(h, mu, azSun, ground)).level(float(0))).div(
    luts.sunScale,
  );
  const moonSky = rgb(luts.skyViewMoonNode.sample(skyViewUV(h, mu, azMoon, ground)).level(float(0)))
    .div(luts.moonScale)
    .mul(u.moonIlluminance);
  // Light pollution and airglow: brighter and warmer towards the horizon.
  const horizon = pow(float(1).sub(clamp(mu, 0, 1)), 4);
  const glow = mix(
    vec3(0.75, 0.85, 1.0).mul(NIGHT_ZENITH),
    vec3(1.2, 0.95, 0.7).mul(NIGHT_HORIZON),
    horizon,
  )
    .mul(1 / SOLAR_ILLUMINANCE_LUX)
    .mul(select(ground, float(0.3), float(1)));
  let L: V3 = sky.add(moonSky).add(glow);

  if (opts.discs) {
    const T = rgb(luts.sampleTransmittance(luts.transmittanceNode, h, mu)).mul(
      select(ground, float(0), float(1)),
    );
    const px = pixelAngle ?? float(0.0005);
    // Sun: limb darkening (per channel, stronger in blue), normalised to the disc's flux.
    const cosSun = dir.dot(u.sunDir);
    const angSun = acos(clamp(cosSun, -1, 1));
    const rho = clamp(angSun.div(SUN_ANGULAR_RADIUS), 0, 1);
    const muLimb = sqrt(max(float(1).sub(rho.mul(rho)), 0));
    const k = vec3(0.4, 0.5, 0.65);
    const limb = vec3(1)
      .sub(k.mul(float(1).sub(muLimb)))
      .div(vec3(1).sub(k.div(3)));
    const sunEdge = smoothstep(
      px.add(SUN_ANGULAR_RADIUS),
      px.negate().add(SUN_ANGULAR_RADIUS),
      angSun,
    );
    const sunL = limb.mul(1 / (Math.PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS)).mul(sunEdge);
    // Clamp by the brightest channel so a red setting sun stays red.
    const disc = sunL.mul(T).mul(u.exposure);
    const peak = max(max(disc.x, disc.y), max(disc.z, 1e-6));
    L = L.add(disc.mul(min(float(MAX_DISC).div(peak), 1)).div(u.exposure));

    // Moon: a lit sphere (Lambert is close enough at this size), mottled maria.
    const cosMoon = dir.dot(u.moonDir);
    const angMoon = acos(clamp(cosMoon, -1, 1));
    const moonEdge = smoothstep(
      px.add(MOON_ANGULAR_RADIUS),
      px.negate().add(MOON_ANGULAR_RADIUS),
      angMoon,
    );
    const offset = dir.sub(u.moonDir.mul(cosMoon));
    const rm = clamp(offset.length().div(Math.sin(MOON_ANGULAR_RADIUS)), 0, 1);
    const normal = normalize(
      offset
        .div(Math.sin(MOON_ANGULAR_RADIUS))
        .sub(u.moonDir.mul(sqrt(max(float(1).sub(rm.mul(rm)), 0)))),
    );
    const lit = max(normal.dot(u.sunDir), 0);
    const maria = hash(floor(offset.x.mul(900)).add(floor(offset.y.mul(900)).mul(57.0)))
      .mul(0.25)
      .add(0.75);
    const earthshine = 0.0006;
    const moonL = lit
      .mul(maria)
      .mul(0.07 / Math.PI)
      .add(earthshine * 0.07)
      .mul(moonEdge);
    L = L.add(vec3(1.0, 0.97, 0.92).mul(moonL).mul(T));

    // Stars: one per cell of a cube grid in equatorial coordinates, so they wheel with
    // sidereal time; drawn as Gaussian points of about a pixel, flux from their magnitude.
    L = L.add(
      stars(dir, u, px)
        .mul(T)
        .mul(select(cosMoon.greaterThan(Math.cos(MOON_ANGULAR_RADIUS * 1.2)), float(0), float(1))),
    );
  }
  return L.mul(u.exposure);
}

function stars(dir: V3, u: SkyUniforms, px: F): V3 {
  const e = normalize(u.toEquatorial.mul(dir));
  const a = abs(e);
  const xMajor = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z));
  const yMajor = a.y.greaterThan(a.x).and(a.y.greaterThanEqual(a.z));
  const face = select(
    xMajor,
    select(e.x.greaterThan(0), float(0), float(1)),
    select(
      yMajor,
      select(e.y.greaterThan(0), float(2), float(3)),
      select(e.z.greaterThan(0), float(4), float(5)),
    ),
  );
  const uvFace = select(
    xMajor,
    vec2(e.y, e.z).div(a.x),
    select(yMajor, vec2(e.x, e.z).div(a.y), vec2(e.x, e.y).div(a.z)),
  );
  const N = 150;
  const g = uvFace.mul(0.5).add(0.5).mul(N);
  const cell = floor(g);
  const id = cell.x.add(cell.y.mul(N)).add(face.mul(N * N));
  const present = hash(id).lessThan(0.03);
  const jitter = vec2(hash(id.add(0.31)), hash(id.add(0.67)))
    .mul(0.6)
    .add(0.2);
  const starUv = cell.add(jitter).div(N).mul(2).sub(1);
  // Distance in the face plane, converted to an angle (faces are not equal-area, near enough).
  const d = uvFace
    .sub(starUv)
    .length()
    .mul(a.x.max(a.y).max(a.z))
    .div(float(1).add(uvFace.dot(uvFace)));
  const m = max(
    float(6.5).add(
      hash(id.add(0.13))
        .max(1e-5)
        .log()
        .mul(1 / (0.45 * Math.LN10)),
    ),
    -1.4,
  );
  // 2.54e-6 lux for magnitude 0, in sky units.
  const flux = pow(float(10), m.mul(-0.4)).mul(2.54e-6 / SOLAR_ILLUMINANCE_LUX);
  const sigma = max(px.mul(0.6), 1e-5);
  const point = exp(d.mul(d).div(sigma.mul(sigma).mul(-2))).div(sigma.mul(sigma).mul(2 * Math.PI));
  // Stars have colours: from blue-white to orange, by a random temperature.
  const t = hash(id.add(0.89));
  const tint = mix(vec3(0.75, 0.85, 1.15), vec3(1.15, 0.9, 0.7), t);
  // Seen through the eye, faint stars do not glare: the visual brightness is compressed.
  const brightness = 0.12;
  return tint.mul(flux.mul(point).mul(brightness)).mul(select(present, float(1), float(0)));
}

/** Angular size of a pixel at this fragment (for antialiased discs and stars). */
export function pixelAngleOf(dir: V3): F {
  return max(fwidth(dir).length(), 1e-6);
}

export const lumaWeights = vec3(...LUMA);
