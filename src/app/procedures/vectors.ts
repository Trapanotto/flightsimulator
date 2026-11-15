/**
 * Radar vectors to an ILS. The controller leads the aircraft through up to three points in
 * the frame of the approach (see `approachFrame`) and then gives the intercept heading: from
 * the last point a 30 degree leg meets the final approach course, at an altitude below the
 * glide slope so that the aircraft captures it from below, as ICAO PANS-ATM 8.9.4 asks.
 *
 * The pattern scales with the speed the aircraft has when the plan is made: a light aircraft
 * at 100 kt joins 8 NM out, a jet at 210 kt about 12 NM out, with every leg and every
 * distance at which a turn is given stretched in proportion, because the jet turns on a
 * wider radius and needs longer to settle on the localizer.
 */
import {
  angleDiff,
  approachFrame,
  bearingTo,
  distanceNm,
  fromApproachFrame,
  norm360,
} from './geometry';
import type { LonLat } from './geometry';
import type { AtcRunway } from './world';

/** Where the intercept leg meets the localizer for a slow aircraft, NM from the threshold. */
export const INTERCEPT_NM = 8;
export const INTERCEPT_ANGLE = 30;
const LEG_NM = 3;
const COS30 = Math.cos((INTERCEPT_ANGLE * Math.PI) / 180);
const SIN30 = Math.sin((INTERCEPT_ANGLE * Math.PI) / 180);
const FT_PER_NM_3DEG = 6076.12 * Math.tan((3 * Math.PI) / 180);
/** A jet's autopilot banks about 25 degrees; slower aircraft fly standard rate. */
const BANK_LIMIT = (25 * Math.PI) / 180;

/** The intercept distance for a ground speed: 8 NM up to 110 kt, 12 NM at 220 kt, 13 at most. */
export function interceptDistance(groundSpeedKt: number): number {
  return Math.min(13, Math.max(INTERCEPT_NM, INTERCEPT_NM + ((groundSpeedKt - 110) * 4) / 110));
}

/** Rate of turn in degrees per second: standard rate, or less where that needs over 25° bank. */
export function turnRate(groundSpeedKt: number): number {
  return Math.min(3, (1091 * Math.tan(BANK_LIMIT)) / Math.max(groundSpeedKt, 60));
}

export interface VectorPlan {
  /** Side of the final course the aircraft joins from: 1 right, -1 left. */
  side: 1 | -1;
  /** Points in the approach frame, flown in order. */
  points: { x: number; y: number }[];
  next: number;
  /** The last heading given, degrees true, and when. */
  lastHeading: number | null;
  lastAt: number;
  /** The point the last heading led to. */
  issuedFor: number;
  /** Feet above sea level. */
  altitudeFt: number;
  /** NM from the threshold where the intercept leg meets the localizer (8 when missing). */
  interceptNm?: number;
}

/** How much the plan is stretched against the slow aircraft's. */
export const planScale = (plan: VectorPlan) => (plan.interceptNm ?? INTERCEPT_NM) / INTERCEPT_NM;

/**
 * Feet above sea level to intercept at: 300 ft or more below the glide slope where the
 * intercept leg meets the localizer. Far out the altitude is rounded to whole thousands.
 */
export function interceptAltitude(rwy: AtcRunway, interceptNm = INTERCEPT_NM): number {
  const gs = rwy.elevationFt + interceptNm * FT_PER_NM_3DEG;
  const step = interceptNm > 9 ? 1000 : 500;
  const a = Math.floor((gs - 300) / step) * step;
  return Math.max(a, Math.ceil((rwy.elevationFt + 1500) / 500) * 500);
}

/** Close to the final course and heading roughly along it: no vectors needed. */
export function nearlyEstablished(
  rwy: AtcRunway,
  p: LonLat,
  headingDeg: number,
  interceptNm = INTERCEPT_NM,
): boolean {
  const { x, y } = approachFrame(rwy, p);
  return (
    x > 3 &&
    x < interceptNm + 6 &&
    Math.abs(y) < 1.5 &&
    Math.abs(angleDiff(headingDeg, rwy.course)) < 40
  );
}

export function planVectors(
  rwy: AtcRunway,
  p: LonLat,
  time: number,
  groundSpeedKt = 100,
): VectorPlan {
  const interceptNm = interceptDistance(groundSpeedKt);
  const k = interceptNm / INTERCEPT_NM;
  const { x, y } = approachFrame(rwy, p);
  const side: 1 | -1 = Math.abs(y) > 1 ? (y > 0 ? 1 : -1) : 1;
  const points: { x: number; y: number }[] = [];
  // From abeam or beyond the runway: a downwind leg first, then a base point well out, so
  // the last turn onto the intercept leg is a small one.
  // A fast aircraft that is already close to the last point has no room to settle on the
  // intercept leg: it goes out to the base point first, like one coming from abeam.
  const last = { x: interceptNm + LEG_NM * k * COS30, y: LEG_NM * k * SIN30 * side };
  const cramped = k > 1 && x - last.x < 5 * k;
  if (x < 3 * k) points.push({ x: 3 * k, y: 6 * k * side });
  if (x < 11 * k || cramped) points.push({ x: 15 * k, y: 6 * k * side });
  points.push(last);
  const plan: VectorPlan = {
    side,
    points,
    next: 0,
    lastHeading: null,
    lastAt: time,
    issuedFor: -1,
    altitudeFt: interceptAltitude(rwy, interceptNm),
  };
  // Left out for the slow aircraft, so its plan stays as it always was.
  if (interceptNm !== INTERCEPT_NM) plan.interceptNm = interceptNm;
  return plan;
}

export type VectorStep =
  { kind: 'heading'; headingTrue: number } | { kind: 'intercept'; headingTrue: number } | null;

/**
 * Where on the final approach course an aircraft would meet it, NM from the threshold, if
 * it turned now onto `toHeading` (at the rate it can turn at this speed) and flew straight
 * on: the controller's judgement of when to give the intercept heading. Null if it would
 * never meet it.
 */
export function predictedIntercept(
  rwy: AtcRunway,
  p: LonLat,
  headingDeg: number,
  toHeading: number,
  groundSpeedKt: number,
): number | null {
  let { x, y } = approachFrame(rwy, p);
  const v = Math.max(groundSpeedKt, 60) / 3600;
  const rate = turnRate(groundSpeedKt);
  let a = angleDiff(headingDeg, rwy.course);
  const a1 = angleDiff(toHeading, rwy.course);
  const step = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    const ny = y + Math.sin(r) * v;
    const nx = x - Math.cos(r) * v;
    const crossed = ny * y <= 0 && y !== 0;
    x = nx;
    y = ny;
    return crossed;
  };
  for (let i = 0; i < 240 && Math.abs(angleDiff(a1, a)) > rate / 2; i++) {
    a += Math.sign(angleDiff(a1, a)) * rate;
    if (step(a)) return x;
  }
  const r = (a1 * Math.PI) / 180;
  const dy = Math.sin(r);
  if (dy * y >= 0) return null;
  return x - Math.cos(r) * (-y / dy);
}

/**
 * What to tell the aircraft now, if anything: a new heading when a point is reached or the
 * aircraft has drifted off the line to it; the intercept heading as soon as turning onto it
 * would meet the final course where the plan wants it.
 */
export function nextVector(
  plan: VectorPlan,
  rwy: AtcRunway,
  p: LonLat,
  headingDeg: number,
  groundSpeedKt: number,
  time: number,
): VectorStep {
  const k = planScale(plan);
  const interceptNm = plan.interceptNm ?? INTERCEPT_NM;
  const here = approachFrame(rwy, p);
  while (plan.next < plan.points.length - 1) {
    const t = plan.points[plan.next]!;
    if (Math.hypot(here.x - t.x, here.y - t.y) > 1.5 * k) break;
    plan.next++;
  }
  const intercept = norm360(rwy.course - INTERCEPT_ANGLE * plan.side);
  const t = plan.points[plan.next]!;
  if (plan.next === plan.points.length - 1) {
    const hit = predictedIntercept(rwy, p, headingDeg, intercept, groundSpeedKt);
    const onSide = here.y * plan.side > 0.5 * k && here.x > interceptNm + 0.5 * k;
    const close = Math.hypot(here.x - t.x, here.y - t.y) < 0.8 * k;
    const passed = here.x < t.x - 0.3 * k && here.y * plan.side > 0;
    if ((onSide && hit !== null && Math.abs(hit - interceptNm) < 0.4 * k) || close || passed)
      return { kind: 'intercept', headingTrue: intercept };
  }
  const want = bearingTo(p, fromApproachFrame(rwy, t.x, t.y));
  // Close to a point the bearing to it swings quickly; a correction there would only zigzag.
  const far = Math.hypot(here.x - t.x, here.y - t.y) > 3 * k;
  const stale =
    plan.lastHeading === null ||
    plan.issuedFor !== plan.next ||
    (far && Math.abs(angleDiff(want, plan.lastHeading)) > 20 && time - plan.lastAt > 20);
  return stale ? { kind: 'heading', headingTrue: want } : null;
}

/** Nautical miles from the threshold. */
export const fromTouchdown = (rwy: AtcRunway, p: LonLat) => distanceNm(rwy.threshold, p);
