/**
 * Airport lights as camera-facing sprites, one instanced draw per airport.
 *
 * Size: the sprite has the light's physical size, but never less than MIN px (so it reads as a
 * point from 20 km) nor more than MAX px. Brightness: the light's intensity (candela, Annex 14)
 * over the solid angle the sprite covers, i.e. the illuminance it gives at the eye spread over
 * the sprite; in sky units (solar illuminance = 1) and times the sky's exposure, so a runway
 * edge light glares at night, is a faint dot at dusk and nothing by day.
 *
 * Direction: each light has an axis and two colours (green seen from the approach, red from
 * the runway, ...); PAPI units turn red below their angle; flashers and the beacon run on the
 * world's clock.
 *
 * Occlusion: depth-tested against the terrain like everything else. A sprite larger than the
 * light would sink into the ground at grazing angles (its lower half lies below the light, where
 * the ground is nearer), so a sprite bigger than the light is lifted on screen by the excess.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  MeshBasicNodeMaterial,
  type Node,
} from 'three/webgpu';
import {
  abs,
  asin,
  atan,
  attribute,
  clamp,
  cos,
  dot,
  exp,
  float,
  fract,
  length,
  max,
  min,
  mix,
  modelViewMatrix,
  normalize,
  positionGeometry,
  pow,
  select,
  smoothstep,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { SOLAR_ILLUMINANCE_LUX } from './constants';
import { LightKind } from './layout';
import type { LightBuffers } from './lights';
import { pullFor, pulledView } from './pull';


/**
 * cond ? a : b, with both sides evaluated up front. TSL's select() builds an if/else, and a node
 * first built inside one branch is declared there: used again elsewhere it reads as garbage.
 */
function pick(cond: Node<'bool'>, a: Node<'vec3'>, b: Node<'vec3'> | number): Node<'vec3'>;
function pick(cond: Node<'bool'>, a: Node<'float'> | number, b: Node<'float'> | number): Node<'float'>;
function pick(cond: Node<'bool'>, a: Node<'float'> | Node<'vec3'> | number, b: Node<'float'> | Node<'vec3'> | number) {
  const w = select(cond, 1, 0);
  return typeof a === 'number' && typeof b === 'number' ? mix(float(b), float(a), w) : mix(b as Node<'vec3'>, a as Node<'vec3'>, w);
}

type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

/** Per-frame values shared by every airport's lights. */
export const lightUniforms = {
  screenHeight: uniform(1080),
  tanHalfFov: uniform(Math.tan((55 * Math.PI) / 360)),
  exposure: uniform(1),
  /** 0..1: how much of the lighting is switched on (night, later poor visibility). */
  on: uniform(0),
  time: uniform(0),
  /** Brightness step of the lighting (1 = full, as by day in fog). */
  brightness: uniform(0.25),
  minPx: uniform(1.2),
  maxPx: uniform(9),
};

/** A quad per light: corners at (+-1, +-1), drawn once per instance. */
export function createLightGeometry(
  b: LightBuffers,
  positions: Float32Array,
): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  g.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
  );
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  // x, y, z in the airport frame (filled when seated) and the physical radius.
  g.setAttribute('iPos', new InstancedBufferAttribute(positions, 4));
  g.setAttribute('iColA', new InstancedBufferAttribute(b.colourA, 3));
  g.setAttribute('iColB', new InstancedBufferAttribute(b.colourB, 3));
  g.setAttribute('iParam', new InstancedBufferAttribute(b.params, 4));
  g.instanceCount = b.count;
  return g;
}

/**
 * The material of one airport's lights. `cameraLocal` is the camera position in that airport's
 * own frame (set every frame): directions and angles are then plain vectors of the airport frame
 * (y up, the runway axes as stored), with no matrices involved.
 */
export function createLightMaterial(cameraLocal: Node<'vec3'>): MeshBasicNodeMaterial {
  const u = lightUniforms;
  const m = new MeshBasicNodeMaterial();
  m.transparent = true;
  m.depthWrite = false;
  m.depthTest = true;
  m.blending = AdditiveBlending;
  m.fog = false;

  const iPos = attribute('iPos', 'vec4') as unknown as V4;
  const colA = attribute('iColA', 'vec3') as unknown as V3;
  const colB = attribute('iColB', 'vec3') as unknown as V3;
  const param = attribute('iParam', 'vec4') as unknown as V4;
  const kind = param.z;

  // ---- where, how big ----
  const centre = modelViewMatrix.mul(vec4(iPos.xyz, 1));
  const dist = max(length(centre.xyz), 0.1);
  const pxPerRad = u.screenHeight.div(u.tanHalfFov.mul(2));
  const pxPerMetre = pxPerRad.div(dist);
  const radiusPx = clamp(iPos.w.mul(pxPerMetre), u.minPx, u.maxPx);
  const radius = radiusPx.div(pxPerMetre);
  // Screen direction of "up" at the light, to lift a sprite larger than the light out of the
  // ground behind it.
  const upView = modelViewMatrix.mul(vec4(0, 1, 0, 0)).xy;
  const lift = upView.mul(max(radius.sub(iPos.w), 0));
  const corner = positionGeometry.xy;
  const view = vec4(centre.xy.add(corner.mul(radius)).add(lift), centre.z, 1);
  // The camera's height above the light decides the pull (see pull.ts).
  const toCamLocal = cameraLocal.sub(iPos.xyz);
  m.vertexNode = pulledView(view, pullFor(toCamLocal.y));

  // ---- seen from where (in the airport frame: y up) ----
  const toCam = normalize(toCamLocal);
  const sinEl = toCam.y;
  const elevation = asin(clamp(sinEl, -1, 1)).mul(180 / Math.PI);
  const horizontal = normalize(vec3(toCam.x, 0, toCam.z).add(vec3(1e-6, 0, 0))) as unknown as V3;
  const axis = vec3(param.x, 0, param.y);
  const c = dot(horizontal, axis);
  const ahead = c.greaterThanEqual(0);
  const colour = pick(ahead, colA, colB);
  const ac = abs(c);
  const isOmni = kind.lessThan(LightKind.Omni + 0.5);
  const isBi = kind
    .greaterThan(LightKind.Bidirectional - 0.5)
    .and(kind.lessThan(LightKind.Bidirectional + 0.5));
  const isPapi = kind.greaterThan(LightKind.Papi - 0.5).and(kind.lessThan(LightKind.Papi + 0.5));
  const isFlasher = kind
    .greaterThan(LightKind.Flasher - 0.5)
    .and(kind.lessThan(LightKind.Flasher + 0.5));
  const isBeacon = kind.greaterThan(LightKind.Beacon - 0.5);
  // Beams: edge lights shine mostly along the runway but are seen all around; approach, touchdown
  // zone and PAPI lights only from within about 15 degrees of their axis.
  const narrow = smoothstep(0.93, 0.985, ac);
  const wide = mix(float(0.3), float(1), smoothstep(0.4, 0.95, ac));
  const beam = pick(isOmni, 1, pick(isBi, wide, narrow));
  // Seen from high above, inset and elevated lights look dimmer.
  const vertical = mix(float(1), float(0.3), smoothstep(12, 60, elevation));
  // PAPI: white above the unit's setting, red below, a 2 arcminute transition.
  const white = smoothstep(param.w.sub(0.017), param.w.add(0.017), elevation);
  const lum = dot(colA, vec3(0.2126, 0.7152, 0.0722));
  const papi = mix(vec3(1, 0.03, 0.01).mul(lum.mul(0.35)), colA, white);
  // Rabbit: each flasher fires once per half second, the next one 1/n later.
  const phase = fract(u.time.mul(2));
  const flash = smoothstep(0.045, 0.0, abs(phase.sub(param.w)));
  // Beacon: two beams 180 degrees apart (white, green), 12 turns a minute.
  const bearing = atan(horizontal.z, horizontal.x).sub(u.time.mul((2 * Math.PI * 12) / 60));
  const beamW = pow(max(cos(bearing), 0), 60);
  const beamG = pow(max(cos(bearing).negate(), 0), 60);
  const beacon = colA.mul(beamW).add(colB.mul(beamG)).add(colA.mul(0.02));
  const rgb = pick(
    isBeacon,
    beacon,
    pick(
      isPapi,
      papi.mul(narrow),
      pick(isFlasher, colour.mul(narrow).mul(flash), colour.mul(beam).mul(vertical)),
    ),
  );

  // ---- how bright ----
  // Candela -> illuminance at the eye -> luminance over the sprite's solid angle (cd/m2) ->
  // sky units (solar illuminance = 1) -> exposed.
  const solidAngle = radiusPx.div(pxPerRad).pow(2).mul(Math.PI);
  const luminance = rgb.div(dist.mul(dist).mul(solidAngle)).div(SOLAR_ILLUMINANCE_LUX);
  // The sprite is a soft disc whose average over its area is 0.32 of its peak. At night the
  // lights run at a low brightness step (about a quarter), as towers set them.
  const exposed = luminance.mul(u.exposure).mul(u.on).mul(u.brightness).div(0.32);
  const peak = varying(exposed);

  const p = uv().mul(2).sub(1);
  const r2 = dot(p, p);
  const profile = exp(r2.mul(-3)).mul(smoothstep(1, 0.8, r2));
  // Limit per pixel, keeping the hue: a bright light becomes a disc of its full colour instead
  // of a white blob, so green, red, yellow and blue stay apart at night (the tone mapping turns
  // anything far above 1 into white).
  const v = peak.mul(profile);
  const vmax = max(v.x, max(v.y, v.z));
  const scaled = v.mul(min(float(1), float(3).div(max(vmax, 1e-6))));
  m.colorNode = vec4(scaled, 1);
  return m;
}
