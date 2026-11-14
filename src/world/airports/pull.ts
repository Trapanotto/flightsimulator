/**
 * How things drawn flat on the terrain stay visible on it without z-fighting or the terrain
 * poking through, at 2 m and at 20 km.
 *
 * The airport surfaces are draped on the terrain's own heights (the triangles the GPU draws,
 * see World.groundHeight), but a drape is never exactly the drawn mesh: between its vertices it
 * cuts across the terrain triangles (centimetres), and far away the drawn tile can be coarser
 * than the one the heights came from (metres). A constant depth bias does not fit a reversed
 * depth buffer from 0.1 m to 200 km; instead every vertex is moved towards the camera along its
 * own view ray. That moves nothing on screen (the projection of a point on the ray is the same
 * point), it only makes the surface nearer in depth.
 *
 * The amount is chosen as a vertical tolerance T: a surface up to T below the terrain still
 * wins. Seen from height h above the surface, moving a point by the fraction k of its distance
 * towards the camera raises it by k*h in effect (at every distance), so k = T / h. T grows with
 * height, because the terrain far below is coarser: 3 cm at the wheels, ~0.5 m at 100 m,
 * ~5 m at 1000 m. The price is the same T at the foot of objects standing on the surface (an
 * aircraft's tyres lose 3-4 cm when seen from the cockpit): invisible.
 */
import type { Node } from 'three/webgpu';
import {
  cameraProjectionMatrix,
  cameraViewMatrix,
  dot,
  float,
  max,
  min,
  modelViewMatrix,
  vec4,
} from 'three/tsl';

/** Vertical tolerance at height h above the surface: TOLERANCE_BASE + TOLERANCE_SLOPE * h. */
export const TOLERANCE_BASE = 0.03;
export const TOLERANCE_SLOPE = 0.005;
/** Never more than this share of the distance (keeps objects close to the surface intact). */
export const MAX_PULL = 0.05;
/** Below this the camera counts as standing on the surface. */
const MIN_HEIGHT = 0.3;

/** The pull k for a camera `h` metres above the surface (CPU twin of the shader, for tests). */
export function pullFraction(h: number): number {
  const hh = Math.max(h, MIN_HEIGHT);
  return Math.min((TOLERANCE_BASE + TOLERANCE_SLOPE * hh) / hh, MAX_PULL);
}

type Vec3Node = Node<'vec3'>;
type ViewNode = Node<'vec4'>;

/**
 * The pull k for a point at `view` (view space). The camera's height above it is measured along
 * the render frame's up (its y axis, expressed in view space).
 */
export function pullNode(view: Node<'vec3'>): Node<'float'> {
  const up = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  return pullFor(dot(view.negate(), up));
}

/** The pull k for a camera `height` metres above the point. */
export function pullFor(
  height: Node<'float'>,
  base = TOLERANCE_BASE,
  slope = TOLERANCE_SLOPE,
  most = MAX_PULL,
): Node<'float'> {
  const h = max(height, MIN_HEIGHT);
  return min(h.mul(slope).add(base).div(h), most);
}

/**
 * Lights are points: drawing one over a bump of the ground just in front of it hides nothing
 * worth seeing, while losing it behind a 10 cm swell of the coarse terrain loses a whole row of
 * edge lights at grazing angles. They get a larger tolerance (25 cm, 1 % of the height) and may
 * come up to 30 % of the way towards the camera.
 */
export const LIGHT_TOLERANCE = { base: 0.25, slope: 0.01, most: 0.3 };

/** Clip position of a local position, pulled towards the camera (a material's vertexNode). */
export function pulledVertex(position: Vec3Node) {
  const view = modelViewMatrix.mul(vec4(position, 1));
  return pulledView(view, pullNode(view.xyz));
}

/** Clip position of a view-space point pulled by the fraction k towards the camera. */
export function pulledView(view: ViewNode, k: Node<'float'>) {
  return cameraProjectionMatrix.mul(vec4(view.xyz.mul(float(1).sub(k)), 1));
}
