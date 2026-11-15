/**
 * Drawing helpers and the colours of the Airbus displays (FCOM 1.31.40): green for engaged and
 * normal, blue (cyan) for selected and armed, magenta for managed targets and constraints,
 * amber for cautions, red for warnings and limits, white for scales and titles, yellow for the
 * fixed references.
 */
export type Ctx = CanvasRenderingContext2D;

export const FONT = '"Segoe UI", "Bahnschrift", "Arial Narrow", Arial, sans-serif';
export const MONO = '"Consolas", "Lucida Console", "Courier New", monospace';

export const AB = {
  green: '#1fe23a',
  blue: '#2fd8ff',
  magenta: '#ff40ff',
  amber: '#ffa514',
  red: '#ff2020',
  white: '#f2f4f4',
  grey: '#7d8489',
  dark: '#2c3238',
  tape: '#3e464e',
  yellow: '#ffea00',
  sky: '#1e7fd6',
  ground: '#7c4b23',
  black: '#000000',
} as const;

export function txt(
  c: Ctx,
  s: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'center',
  font = FONT,
  weight = 600,
) {
  c.fillStyle = color;
  c.font = `${weight} ${size}px ${font}`;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillText(s, x, y);
}

export function line(
  c: Ctx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  color: string,
) {
  c.strokeStyle = color;
  c.lineWidth = w;
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
}

export function poly(c: Ctx, pts: readonly (readonly [number, number])[], color: string, w = 0) {
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
  if (w) {
    c.strokeStyle = color;
    c.lineWidth = w;
    c.stroke();
  } else {
    c.fillStyle = color;
    c.fill();
  }
}

export function rect(c: Ctx, x: number, y: number, w: number, h: number, color: string, lw = 0) {
  if (lw) {
    c.strokeStyle = color;
    c.lineWidth = lw;
    c.strokeRect(x, y, w, h);
  } else {
    c.fillStyle = color;
    c.fillRect(x, y, w, h);
  }
}

/** An arc stroke; angles in degrees clockwise from 12 o'clock. */
export function arc(
  c: Ctx,
  x: number,
  y: number,
  r: number,
  a0: number,
  a1: number,
  w: number,
  color: string,
) {
  c.strokeStyle = color;
  c.lineWidth = w;
  c.beginPath();
  c.arc(x, y, r, ((a0 - 90) * Math.PI) / 180, ((a1 - 90) * Math.PI) / 180);
  c.stroke();
}

/** Point at an angle (degrees clockwise from 12 o'clock) and radius round a centre. */
export function polar(x: number, y: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [x + r * Math.cos(a), y + r * Math.sin(a)];
}

export function clear(c: Ctx, w: number, h: number, color: string = AB.black) {
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
}

/** A key part: rounds a value to what a pixel shows. */
export const q = (v: number | undefined, step: number) =>
  v === undefined ? '-' : Math.round(v / step);

/** Signed difference of two headings, -180..180. */
export function angleDiff(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

export const wrap360 = (d: number) => ((d % 360) + 360) % 360;
