/**
 * Radar vectors to an ILS. The controller leads the aircraft through up to three points in
 * the frame of the approach (see `approachFrame`) and then gives the intercept heading: from
 * the last point a 30 degree leg meets the final approach course 8 NM out, at an altitude
 * below the glide slope so that the aircraft captures it from below, as ICAO PANS-ATM 8.9.4
 * asks.
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

/** Where the intercept leg meets the localizer, NM from the threshold. */
export const INTERCEPT_NM = 8;
export const INTERCEPT_ANGLE = 30;
const LEG_NM = 3;
const COS30 = Math.cos((INTERCEPT_ANGLE * Math.PI) / 180);
const SIN30 = Math.sin((INTERCEPT_ANGLE * Math.PI) / 180);
const FT_PER_NM_3DEG = 6076.12 * Math.tan((3 * Math.PI) / 180);

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
}

/** Feet above sea level to intercept at: 300 ft or more below the glide slope at 8 NM. */
export function interceptAltitude(rwy: AtcRunway): number {
  const gs = rwy.elevationFt + INTERCEPT_NM * FT_PER_NM_3DEG;
  const a = Math.floor((gs - 300) / 500) * 500;
  return Math.max(a, Math.ceil((rwy.elevationFt + 1500) / 500) * 500);
}

/** Close to the final course and heading roughly along it: no vectors needed. */
export function nearlyEstablished(rwy: AtcRunway, p: LonLat, headingDeg: number): boolean {
  const { x, y } = approachFrame(rwy, p);
  return x > 3 && x < 14 && Math.abs(y) < 1.5 && Math.abs(angleDiff(headingDeg, rwy.course)) < 40;
}

export function planVectors(rwy: AtcRunway, p: LonLat, time: number): VectorPlan {
  const { x, y } = approachFrame(rwy, p);
  const side: 1 | -1 = Math.abs(y) > 1 ? (y > 0 ? 1 : -1) : 1;
  const points: { x: number; y: number }[] = [];
  // From abeam or beyond the runway: a downwind leg first, then a base point well out, so
  // the last turn onto the intercept leg is a small one.
  if (x < 3) points.push({ x: 3, y: 6 * side });
  if (x < 11) points.push({ x: 15, y: 6 * side });
  points.push({ x: INTERCEPT_NM + LEG_NM * COS30, y: LEG_NM * SIN30 * side });
  return {
    side,
    points,
    next: 0,
    lastHeading: null,
    lastAt: time,
    issuedFor: -1,
    altitudeFt: interceptAltitude(rwy),
  };
}

export type VectorStep =
  { kind: 'heading'; headingTrue: number } | { kind: 'intercept'; headingTrue: number } | null;

/**
 * Where on the final approach course an aircraft would meet it, NM from the threshold, if
 * it turned now at standard rate onto `toHeading` and flew straight on: the controller's
 * judgement of when to give the intercept heading. Null if it would never meet it.
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
  for (let i = 0; i < 120 && Math.abs(angleDiff(a1, a)) > 1.5; i++) {
    a += Math.sign(angleDiff(a1, a)) * 3;
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
 * would meet the final course 8 NM out.
 */
export function nextVector(
  plan: VectorPlan,
  rwy: AtcRunway,
  p: LonLat,
  headingDeg: number,
  groundSpeedKt: number,
  time: number,
): VectorStep {
  const here = approachFrame(rwy, p);
  while (plan.next < plan.points.length - 1) {
    const t = plan.points[plan.next]!;
    if (Math.hypot(here.x - t.x, here.y - t.y) > 1.5) break;
    plan.next++;
  }
  const intercept = norm360(rwy.course - INTERCEPT_ANGLE * plan.side);
  const t = plan.points[plan.next]!;
  if (plan.next === plan.points.length - 1) {
    const hit = predictedIntercept(rwy, p, headingDeg, intercept, groundSpeedKt);
    const onSide = here.y * plan.side > 0.5 && here.x > INTERCEPT_NM + 0.5;
    const close = Math.hypot(here.x - t.x, here.y - t.y) < 0.8;
    const passed = here.x < t.x - 0.3 && here.y * plan.side > 0;
    if ((onSide && hit !== null && Math.abs(hit - INTERCEPT_NM) < 0.4) || close || passed)
      return { kind: 'intercept', headingTrue: intercept };
  }
  const want = bearingTo(p, fromApproachFrame(rwy, t.x, t.y));
  // Close to a point the bearing to it swings quickly; a correction there would only zigzag.
  const far = Math.hypot(here.x - t.x, here.y - t.y) > 3;
  const stale =
    plan.lastHeading === null ||
    plan.issuedFor !== plan.next ||
    (far && Math.abs(angleDiff(want, plan.lastHeading)) > 20 && time - plan.lastAt > 20);
  return stale ? { kind: 'heading', headingTrue: want } : null;
}

/** Nautical miles from the threshold. */
export const fromTouchdown = (rwy: AtcRunway, p: LonLat) => distanceNm(rwy.threshold, p);
