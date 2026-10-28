/**
 * Taxiways and aprons (OpenStreetMap, tools/fetch-aeroways.mjs) rasterised for one terrain
 * tile, used by the terrain shader to make airport pavement sharp:
 *   R  pavement (taxiways and aprons, antialiased edges)
 *   G  signed distance to the nearest taxiway centre line (left negative), -MAX..MAX metres →
 *      0..255; signed, bilinear filtering stays exact across the line, so the yellow line is
 *      centimetre-sharp and unbroken at any texture resolution
 *   B  concrete apron (slab joints) instead of asphalt
 * Pure geometry plus an OffscreenCanvas; runs in the imagery worker.
 */
import type { GeoBounds } from '../geo/tiles';

export const AERO_MAX_DIST = 3;

export interface AeroData {
  taxiways: Array<{ w: number; c: number[] }>;
  aprons: Array<{ c: number[] }>;
}

interface Feature {
  w: number;
  c: number[];
  west: number;
  east: number;
  south: number;
  north: number;
}

export interface AeroIndex {
  taxiways: Feature[];
  aprons: Feature[];
}

function bbox(c: number[], w: number): Omit<Feature, 'w' | 'c'> {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let i = 0; i < c.length; i += 2) {
    west = Math.min(west, c[i]!);
    east = Math.max(east, c[i]!);
    south = Math.min(south, c[i + 1]!);
    north = Math.max(north, c[i + 1]!);
  }
  // Half the width, in degrees (generous in longitude).
  const pad = w / 2 / 70_000;
  return { west: west - pad, east: east + pad, south: south - pad, north: north + pad };
}

export function indexAero(data: AeroData): AeroIndex {
  return {
    taxiways: data.taxiways.map((t) => ({ ...t, ...bbox(t.c, t.w) })),
    aprons: data.aprons.map((a) => ({ w: 0, c: a.c, ...bbox(a.c, 0) })),
  };
}

const overlaps = (f: Feature, b: GeoBounds) =>
  f.east >= b.west && f.west <= b.east && f.north >= b.south && f.south <= b.north;

/** Features touching the tile, or null if there is no airport pavement on it. */
export function aeroInTile(index: AeroIndex, b: GeoBounds) {
  const taxiways = index.taxiways.filter((f) => overlaps(f, b));
  const aprons = index.aprons.filter((f) => overlaps(f, b));
  return taxiways.length || aprons.length ? { taxiways, aprons } : null;
}

/** Draws the mask for a tile; `size` pixels square, row 0 = north (like the imagery). */
export function drawAeroMask(
  features: { taxiways: Feature[]; aprons: Feature[] },
  b: GeoBounds,
  size: number,
): ImageBitmap {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const sx = size / (b.east - b.west);
  const sy = size / (b.north - b.south);
  const px = (lon: number) => (lon - b.west) * sx;
  const py = (lat: number) => (b.north - lat) * sy;
  // Metres per pixel (east, north).
  const latMid = (b.north + b.south) / 2;
  const mx = ((b.east - b.west) * 111_320 * Math.cos((latMid * Math.PI) / 180)) / size;
  const my = ((b.north - b.south) * 110_540) / size;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Taxiways: red, as wide as they are.
  ctx.strokeStyle = 'rgb(255,0,0)';
  for (const t of features.taxiways) {
    ctx.lineWidth = t.w / ((mx + my) / 2);
    ctx.beginPath();
    for (let i = 0; i < t.c.length; i += 2) {
      const x = px(t.c[i]!);
      const y = py(t.c[i + 1]!);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Aprons: red + blue (concrete).
  ctx.fillStyle = 'rgb(255,0,255)';
  for (const a of features.aprons) {
    ctx.beginPath();
    for (let i = 0; i < a.c.length; i += 2) {
      const x = px(a.c[i]!);
      const y = py(a.c[i + 1]!);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  // Distance to the taxiway centre lines in G: each segment updates the texels around it.
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const dist = new Float32Array(size * size).fill(AERO_MAX_DIST);
  const side = new Int8Array(size * size).fill(1);
  const rx = Math.ceil(AERO_MAX_DIST / mx) + 1;
  const ry = Math.ceil(AERO_MAX_DIST / my) + 1;
  for (const t of features.taxiways) {
    for (let i = 0; i + 3 < t.c.length; i += 2) {
      // Segment in metres relative to the tile's north-west corner.
      const ax = px(t.c[i]!) * mx;
      const ay = py(t.c[i + 1]!) * my;
      const bx = px(t.c[i + 2]!) * mx;
      const by = py(t.c[i + 3]!) * my;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-9;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) / mx) - rx);
      const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx) / mx) + rx);
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) / my) - ry);
      const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by) / my) + ry);
      for (let y = y0; y <= y1; y++) {
        // Texel centres.
        const qy = (y + 0.5) * my;
        for (let x = x0; x <= x1; x++) {
          const qx = (x + 0.5) * mx;
          const s = Math.max(0, Math.min(1, ((qx - ax) * dx + (qy - ay) * dy) / len2));
          const ex = ax + dx * s - qx;
          const ey = ay + dy * s - qy;
          const e = Math.sqrt(ex * ex + ey * ey);
          const k = y * size + x;
          if (e < dist[k]!) {
            dist[k] = e;
            side[k] = dx * (qy - ay) - dy * (qx - ax) < 0 ? -1 : 1;
          }
        }
      }
    }
  }
  for (let k = 0; k < size * size; k++)
    d[k * 4 + 1] = Math.round((0.5 + (0.5 * side[k]! * dist[k]!) / AERO_MAX_DIST) * 255);
  ctx.putImageData(img, 0, 0);
  return canvas.transferToImageBitmap();
}
