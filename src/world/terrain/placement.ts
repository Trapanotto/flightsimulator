import type { LocalFrame } from '@geo';

const AXES = [
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: 1 },
];
const a = { x: 0, y: 0, z: 0 };
const b = { x: 0, y: 0, z: 0 };

/**
 * Column-major 4x4 matrix (three.js layout) that takes points of a tile's own tangent frame into
 * the render frame: the tile frame's axes and origin expressed in render coordinates. Computed in
 * double precision; only the result, with render-sized numbers, goes to the GPU.
 */
export function tileToRenderMatrix(tile: LocalFrame, render: LocalFrame, out: number[]): number[] {
  AXES.forEach((axis, col) => {
    render.dirToLocal(tile.dirToEcef(axis, a), b);
    out[col * 4] = b.x;
    out[col * 4 + 1] = b.y;
    out[col * 4 + 2] = b.z;
    out[col * 4 + 3] = 0;
  });
  render.toLocal(tile.originEcef(a), b);
  out[12] = b.x;
  out[13] = b.y;
  out[14] = b.z;
  out[15] = 1;
  return out;
}
