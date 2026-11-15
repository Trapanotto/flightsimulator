/**
 * Dial faces of the 172S panel, drawn at runtime into one canvas atlas: crisp at any size,
 * nothing to download, and smaller on mobile. Scales come from instruments.ts, so the needle
 * maths and the printed marks cannot drift apart.
 */
import {
  AI_CARD_RANGE,
  C172S_ASI,
  C172S_TACH,
  asiAngle,
  compassLabelAt,
  flapIndicatorAngle,
  smallGaugeAngle,
  tachAngle,
  vsiAngle,
} from './instruments';
import { FACES, type FaceId } from './c172Parts';

export const ATLAS_COLS = 5;
export const ATLAS_ROWS = 4;
/** Inset of each tile (fraction) so mipmaps do not bleed between dials. */
export const TILE_PAD = 0.01;

const FONT = '"Bahnschrift", "DIN Alternate", "Arial Narrow", Arial, sans-serif';
const WHITE = '#f2f2ee';
const FACE = '#141414';
const GREEN = '#1fa34a';
const YELLOW = '#f1c21b';
const RED = '#d8231f';
const SKY = '#2b6db8';
const GROUND = '#76482a';

export function tileOf(face: FaceId): { col: number; row: number } {
  const i = FACES.indexOf(face);
  return { col: i % ATLAS_COLS, row: Math.floor(i / ATLAS_COLS) };
}

type Ctx = CanvasRenderingContext2D;

/** Canvas angle (radians, 0 = 3 o'clock, clockwise) of a dial angle (degrees from 12 o'clock). */
function ca(deg: number): number {
  return ((deg - 90) * Math.PI) / 180;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ca(deg);
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function tick(
  c: Ctx,
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  deg: number,
  w: number,
  color = WHITE,
) {
  const [x0, y0] = polar(cx, cy, r0, deg);
  const [x1, y1] = polar(cx, cy, r1, deg);
  c.strokeStyle = color;
  c.lineWidth = w;
  c.lineCap = 'butt';
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
}

function arc(
  c: Ctx,
  cx: number,
  cy: number,
  r: number,
  d0: number,
  d1: number,
  w: number,
  color: string,
) {
  c.strokeStyle = color;
  c.lineWidth = w;
  c.lineCap = 'butt';
  c.beginPath();
  c.arc(cx, cy, r, ca(d0), ca(d1));
  c.stroke();
}

function text(c: Ctx, s: string, x: number, y: number, size: number, color = WHITE, weight = 600) {
  c.fillStyle = color;
  c.font = `${weight} ${size}px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(s, x, y);
}

function label(c: Ctx, s: string, cx: number, cy: number, r: number, deg: number, size: number) {
  const [x, y] = polar(cx, cy, r, deg);
  text(c, s, x, y, size);
}

function base(c: Ctx, cx: number, cy: number, R: number) {
  c.fillStyle = FACE;
  c.beginPath();
  c.arc(cx, cy, R * 1.02, 0, Math.PI * 2);
  c.fill();
  // A faint radial sheen: printed faces are not perfectly flat black.
  const g = c.createRadialGradient(cx, cy - R * 0.4, R * 0.1, cx, cy, R);
  g.addColorStop(0, 'rgba(255,255,255,0.05)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fill();
}

function screw(c: Ctx, cx: number, cy: number, R: number) {
  c.fillStyle = '#2a2a2a';
  c.beginPath();
  c.arc(cx, cy, R * 0.07, 0, Math.PI * 2);
  c.fill();
}

// ---------------------------------------------------------------------------------------------

function drawASI(c: Ctx, cx: number, cy: number, R: number) {
  base(c, cx, cy, R);
  const ang = asiAngle;
  arc(c, cx, cy, R * 0.79, ang(C172S_ASI.white[0]), ang(C172S_ASI.white[1]), R * 0.07, WHITE);
  arc(c, cx, cy, R * 0.87, ang(C172S_ASI.green[0]), ang(C172S_ASI.green[1]), R * 0.08, GREEN);
  arc(c, cx, cy, R * 0.87, ang(C172S_ASI.yellow[0]), ang(C172S_ASI.yellow[1]), R * 0.08, YELLOW);
  tick(c, cx, cy, R * 0.75, R * 0.97, ang(C172S_ASI.vne), R * 0.035, RED);
  for (let kt = 40; kt <= 200; kt += 5) {
    const major = kt % 10 === 0;
    tick(c, cx, cy, R * (major ? 0.8 : 0.88), R * 0.97, ang(kt), R * (major ? 0.03 : 0.018));
    if (kt % 20 === 0) label(c, String(kt), cx, cy, R * 0.6, ang(kt), R * 0.17);
  }
  text(c, 'AIRSPEED', cx, cy - R * 0.25, R * 0.1, WHITE, 500);
  text(c, 'KNOTS', cx, cy + R * 0.28, R * 0.11, WHITE, 500);
  screw(c, cx, cy, R);
}

function drawALT(c: Ctx, cx: number, cy: number, R: number) {
  base(c, cx, cy, R);
  for (let i = 0; i < 50; i++) {
    const major = i % 5 === 0;
    tick(c, cx, cy, R * (major ? 0.8 : 0.88), R * 0.97, i * 7.2, R * (major ? 0.035 : 0.018));
  }
  for (let n = 0; n < 10; n++) label(c, String(n), cx, cy, R * 0.64, n * 36, R * 0.2);
  // Kollsman window: the setting itself is a display drawn over this (displays.ts, KOLL).
  c.fillStyle = '#050505';
  c.fillRect(cx + R * 0.29, cy - R * 0.11, R * 0.4, R * 0.22);
  text(c, 'hPa', cx + R * 0.49, cy + R * 0.2, R * 0.08, WHITE, 500);
  text(c, 'ALT', cx, cy - R * 0.32, R * 0.11, WHITE, 500);
  text(c, '100 FEET', cx, cy + R * 0.3, R * 0.09, WHITE, 500);
  // Low-altitude warning stripes (shown below 10 000 ft on real altimeters; static here).
  c.save();
  c.beginPath();
  c.rect(cx - R * 0.66, cy - R * 0.1, R * 0.32, R * 0.2);
  c.clip();
  c.fillStyle = '#e8e8e8';
  c.fillRect(cx - R * 0.66, cy - R * 0.1, R * 0.32, R * 0.2);
  c.strokeStyle = '#111';
  c.lineWidth = R * 0.04;
  for (let k = -4; k < 6; k++) {
    c.beginPath();
    c.moveTo(cx - R * 0.66 + k * R * 0.08, cy + R * 0.1);
    c.lineTo(cx - R * 0.66 + k * R * 0.08 + R * 0.2, cy - R * 0.1);
    c.stroke();
  }
  c.restore();
  screw(c, cx, cy, R);
}

function drawVSI(c: Ctx, cx: number, cy: number, R: number) {
  base(c, cx, cy, R);
  for (let f = -2000; f <= 2000; f += 100) {
    const major = f % 500 === 0;
    tick(c, cx, cy, R * (major ? 0.8 : 0.88), R * 0.97, vsiAngle(f), R * (major ? 0.035 : 0.018));
  }
  for (const f of [0, 5, 10, 15, 20]) {
    label(c, String(f), cx, cy, R * 0.63, vsiAngle(f * 100), R * 0.17);
    if (f) label(c, String(f), cx, cy, R * 0.63, vsiAngle(-f * 100), R * 0.17);
  }
  text(c, 'UP', cx - R * 0.42, cy - R * 0.32, R * 0.1, WHITE, 500);
  text(c, 'DOWN', cx - R * 0.42, cy + R * 0.32, R * 0.1, WHITE, 500);
  text(c, 'VERTICAL SPEED', cx + R * 0.1, cy - R * 0.2, R * 0.08, WHITE, 500);
  text(c, '100 FEET PER MIN', cx + R * 0.1, cy + R * 0.2, R * 0.075, WHITE, 500);
  screw(c, cx, cy, R);
}

function drawTC(c: Ctx, cx: number, cy: number, R: number) {
  base(c, cx, cy, R);
  // Wings-level and standard-rate marks.
  for (const d of [-90, 90]) tick(c, cx, cy, R * 0.72, R * 0.95, d, R * 0.045);
  for (const d of [-110, 110]) tick(c, cx, cy, R * 0.72, R * 0.95, d, R * 0.045);
  text(c, 'L', cx - R * 0.62, cy + R * 0.42, R * 0.17);
  text(c, 'R', cx + R * 0.62, cy + R * 0.42, R * 0.17);
  text(c, 'TURN COORDINATOR', cx, cy - R * 0.55, R * 0.08, WHITE, 500);
  text(c, '2 MIN', cx, cy + R * 0.27, R * 0.1, WHITE, 500);
  text(c, 'D.C. ELEC.', cx, cy - R * 0.4, R * 0.07, WHITE, 500);
  text(c, 'NO PITCH INFORMATION', cx, cy + R * 0.86, R * 0.06, WHITE, 500);
  // Light band behind the inclinometer tube, with the two reference lines.
  const arcR = R * (0.09 / 0.037);
  const acy = cy + R * 0.52 - arcR;
  c.strokeStyle = '#d9d6c8';
  c.lineWidth = R * 0.16;
  c.beginPath();
  c.arc(cx, acy, arcR, Math.PI / 2 - 0.2, Math.PI / 2 + 0.2);
  c.stroke();
  for (const s of [-1, 1]) {
    const x = cx + s * R * 0.135;
    c.strokeStyle = '#111';
    c.lineWidth = R * 0.025;
    c.beginPath();
    c.moveTo(x, cy + R * 0.42);
    c.lineTo(x, cy + R * 0.62);
    c.stroke();
  }
}

function drawHICard(c: Ctx, cx: number, cy: number, R: number) {
  c.fillStyle = FACE;
  c.beginPath();
  c.arc(cx, cy, R * 1.02, 0, Math.PI * 2);
  c.fill();
  for (let d = 0; d < 360; d += 5) {
    const major = d % 10 === 0;
    tick(c, cx, cy, R * (major ? 0.8 : 0.87), R * 0.97, d, R * (major ? 0.03 : 0.018));
  }
  const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = 0; d < 360; d += 30) {
    const s = names[d] ?? String(d / 10);
    const [x, y] = polar(cx, cy, R * 0.63, d);
    c.save();
    c.translate(x, y);
    c.rotate((d * Math.PI) / 180);
    text(c, s, 0, 0, R * (names[d] ? 0.2 : 0.17));
    c.restore();
  }
}

function drawAIBack(c: Ctx, cx: number, cy: number, R: number) {
  // Rotating outer ring: sky above, ground below, the sky pointer at the top.
  c.save();
  c.beginPath();
  c.arc(cx, cy, R * 1.03, 0, Math.PI * 2);
  c.clip();
  c.fillStyle = SKY;
  c.fillRect(cx - R * 1.1, cy - R * 1.1, R * 2.2, R * 1.1);
  c.fillStyle = GROUND;
  c.fillRect(cx - R * 1.1, cy, R * 2.2, R * 1.1);
  c.fillStyle = WHITE;
  c.fillRect(cx - R * 1.1, cy - R * 0.012, R * 2.2, R * 0.024);
  c.restore();
  c.fillStyle = '#ff7a14';
  c.beginPath();
  c.moveTo(cx, cy - R * 0.72);
  c.lineTo(cx - R * 0.07, cy - R * 0.84);
  c.lineTo(cx + R * 0.07, cy - R * 0.84);
  c.closePath();
  c.fill();
}

function drawSmall(
  c: Ctx,
  cx: number,
  cy: number,
  R: number,
  title: string,
  labels: [string, string],
  arcs: [number, number, string][],
  redLines: number[],
) {
  base(c, cx, cy, R);
  for (const [a0, a1, col] of arcs) arc(c, cx, cy, R * 0.82, a0, a1, R * 0.12, col);
  for (const d of redLines) tick(c, cx, cy, R * 0.7, R * 0.95, d, R * 0.06, RED);
  for (let i = 0; i <= 10; i++)
    tick(c, cx, cy, R * (i % 5 ? 0.86 : 0.72), R * 0.95, -50 + i * 10, R * 0.04);
  label(c, labels[0], cx, cy, R * 0.52, -50, R * 0.2);
  label(c, labels[1], cx, cy, R * 0.52, 50, R * 0.2);
  text(c, title, cx, cy + R * 0.38, R * 0.2, WHITE, 600);
}

function drawTACH(c: Ctx, cx: number, cy: number, R: number) {
  base(c, cx, cy, R);
  arc(
    c,
    cx,
    cy,
    R * 0.87,
    tachAngle(C172S_TACH.green[0]),
    tachAngle(C172S_TACH.green[1]),
    R * 0.08,
    GREEN,
  );
  tick(c, cx, cy, R * 0.75, R * 0.97, tachAngle(C172S_TACH.red), R * 0.035, RED);
  for (let r = 0; r <= 3500; r += 100) {
    const major = r % 500 === 0;
    tick(c, cx, cy, R * (major ? 0.8 : 0.88), R * 0.97, tachAngle(r), R * (major ? 0.03 : 0.016));
    if (major) label(c, String(r / 100), cx, cy, R * 0.62, tachAngle(r), R * 0.16);
  }
  text(c, 'RPM', cx, cy - R * 0.3, R * 0.11, WHITE, 500);
  text(c, 'X100', cx, cy - R * 0.17, R * 0.08, WHITE, 500);
  // Hour meter.
  c.fillStyle = '#050505';
  c.fillRect(cx - R * 0.3, cy + R * 0.3, R * 0.6, R * 0.17);
  text(c, '1 7 2 4 . 3', cx, cy + R * 0.385, R * 0.11, WHITE, 500);
  screw(c, cx, cy, R);
}

/** Azimuth card of a course indicator (turns with the OBS); the dots and needles are geometry. */
function drawCDI(c: Ctx, cx: number, cy: number, R: number, nav: string) {
  base(c, cx, cy, R);
  for (let d = 0; d < 360; d += 5)
    tick(c, cx, cy, R * (d % 10 ? 0.9 : 0.84), R * 0.98, d, R * 0.02);
  for (let d = 0; d < 360; d += 30) {
    const [x, y] = polar(cx, cy, R * 0.72, d);
    c.save();
    c.translate(x, y);
    c.rotate((d * Math.PI) / 180);
    text(
      c,
      d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10),
      0,
      0,
      R * 0.13,
    );
    c.restore();
  }
  // The card's centre is hidden by the needles' mask on the real gauge: keep it plain.
  c.fillStyle = '#0d0d0d';
  c.beginPath();
  c.arc(cx, cy, R * 0.6, 0, Math.PI * 2);
  c.fill();
  text(c, nav, cx, cy + R * 0.32, R * 0.08, '#9a9a96', 500);
}

/** ADF indicator: a fixed card, north up (the pointer shows the bearing relative to the nose). */
function drawADF(c: Ctx, cx: number, cy: number, R: number) {
  base(c, cx, cy, R);
  for (let d = 0; d < 360; d += 5)
    tick(c, cx, cy, R * (d % 10 ? 0.9 : 0.82), R * 0.98, d, R * (d % 10 ? 0.015 : 0.025));
  for (let d = 0; d < 360; d += 30) {
    const [x, y] = polar(cx, cy, R * 0.68, d);
    c.save();
    c.translate(x, y);
    c.rotate((d * Math.PI) / 180);
    text(
      c,
      d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10),
      0,
      0,
      R * 0.14,
    );
    c.restore();
  }
  // Lubber marks and a small aircraft in the middle.
  for (const d of [45, 135, 225, 315]) tick(c, cx, cy, R * 0.98, R * 1.02, d, R * 0.03, '#ff7a14');
  c.fillStyle = '#ff7a14';
  c.fillRect(cx - R * 0.025, cy - R * 0.22, R * 0.05, R * 0.4);
  c.fillRect(cx - R * 0.22, cy - R * 0.07, R * 0.44, R * 0.05);
  c.fillRect(cx - R * 0.09, cy + R * 0.14, R * 0.18, R * 0.04);
  text(c, 'ADF', cx, cy + R * 0.38, R * 0.09, WHITE, 500);
}

function drawFlaps(c: Ctx, cx: number, cy: number, R: number) {
  base(c, cx, cy, R);
  for (const [deg, s] of [
    [0, '0'],
    [10, '10'],
    [20, '20'],
    [30, 'FULL'],
  ] as const) {
    const a = flapIndicatorAngle(deg / 30);
    tick(c, cx, cy, R * 0.74, R * 0.96, a, R * 0.05);
    label(c, s, cx, cy, R * 0.52, a, R * (s === 'FULL' ? 0.15 : 0.2));
  }
  text(c, 'FLAPS', cx, cy + R * 0.42, R * 0.2, WHITE, 600);
}

const DRAW: Record<FaceId, (c: Ctx, cx: number, cy: number, R: number) => void> = {
  ASI: drawASI,
  AI: drawAIBack,
  ALT: drawALT,
  TC: drawTC,
  HI: drawHICard,
  VSI: drawVSI,
  TACH: drawTACH,
  CDI1: (c, x, y, r) => drawCDI(c, x, y, r, 'NAV 1'),
  CDI2: (c, x, y, r) => drawCDI(c, x, y, r, 'NAV 2'),
  FUELL: (c, x, y, r) =>
    drawSmall(
      c,
      x,
      y,
      r,
      'FUEL L',
      ['E', 'F'],
      [[smallGaugeAngle(0, 0, 26.5), smallGaugeAngle(2, 0, 26.5), YELLOW]],
      [-50],
    ),
  FUELR: (c, x, y, r) =>
    drawSmall(
      c,
      x,
      y,
      r,
      'FUEL R',
      ['E', 'F'],
      [[smallGaugeAngle(0, 0, 26.5), smallGaugeAngle(2, 0, 26.5), YELLOW]],
      [-50],
    ),
  OILT: (c, x, y, r) =>
    drawSmall(
      c,
      x,
      y,
      r,
      'OIL °F',
      ['', ''],
      [[smallGaugeAngle(100, 75, 250), smallGaugeAngle(245, 75, 250), GREEN]],
      [smallGaugeAngle(245, 75, 250)],
    ),
  OILP: (c, x, y, r) =>
    drawSmall(
      c,
      x,
      y,
      r,
      'OIL PSI',
      ['', ''],
      [[smallGaugeAngle(50, 0, 120), smallGaugeAngle(90, 0, 120), GREEN]],
      [smallGaugeAngle(20, 0, 120), smallGaugeAngle(115, 0, 120)],
    ),
  EGT: (c, x, y, r) => drawSmall(c, x, y, r, 'EGT', ['', ''], [], []),
  AMP: (c, x, y, r) => drawSmall(c, x, y, r, 'AMP', ['-', '+'], [], []),
  FF: (c, x, y, r) => drawSmall(c, x, y, r, 'GPH', ['0', '20'], [], []),
  VAC: (c, x, y, r) =>
    drawSmall(
      c,
      x,
      y,
      r,
      'VAC',
      ['3', '7'],
      [[smallGaugeAngle(4.5, 3, 7), smallGaugeAngle(5.5, 3, 7), GREEN]],
      [],
    ),
  ADF: drawADF,
  FLAPS: drawFlaps,
};

/** All dial faces in one canvas: ATLAS_COLS x ATLAS_ROWS tiles of `tile` pixels. */
export function drawDialAtlas(tile: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = tile * ATLAS_COLS;
  canvas.height = tile * ATLAS_ROWS;
  const c = canvas.getContext('2d')!;
  c.fillStyle = FACE;
  c.fillRect(0, 0, canvas.width, canvas.height);
  for (const id of FACES) {
    const { col, row } = tileOf(id);
    const cx = (col + 0.5) * tile;
    const cy = (row + 0.5) * tile;
    // The disc's UV circle touches the tile edges (minus the pad).
    const R = tile * (0.5 - TILE_PAD);
    c.save();
    DRAW[id](c, cx, cy, R);
    c.restore();
  }
  return canvas;
}

/** Pitch card of the attitude indicator: +-AI_CARD_RANGE degrees from top to bottom. */
export function drawPitchCard(w: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = w * 2;
  const c = canvas.getContext('2d')!;
  const H = canvas.height;
  const pxPerDeg = H / (2 * AI_CARD_RANGE);
  const y0 = H / 2;
  c.fillStyle = SKY;
  c.fillRect(0, 0, w, y0);
  c.fillStyle = GROUND;
  c.fillRect(0, y0, w, H - y0);
  c.fillStyle = WHITE;
  c.fillRect(0, y0 - w * 0.008, w, w * 0.016);
  const cx = w / 2;
  for (let d = -60; d <= 60; d += 5) {
    if (!d) continue;
    const y = y0 - d * pxPerDeg;
    const len = d % 10 === 0 ? w * 0.36 : w * 0.18;
    c.fillRect(cx - len / 2, y - w * 0.006, len, w * 0.012);
    if (d % 10 === 0) {
      text(c, String(Math.abs(d)), cx - len / 2 - w * 0.07, y, w * 0.07);
      text(c, String(Math.abs(d)), cx + len / 2 + w * 0.07, y, w * 0.07);
    }
  }
  return canvas;
}

/** Band of the wet compass card: u = 0 faces the pilot; numbers fall to the right. */
export function drawCompassBand(w: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = Math.round(w / 8);
  const c = canvas.getContext('2d')!;
  const h = canvas.height;
  c.fillStyle = '#101010';
  c.fillRect(0, 0, w, h);
  for (let i = 0; i < 72; i++) {
    const u = i / 72;
    const deg = Math.round(compassLabelAt(u));
    const x = u * w;
    const major = deg % 10 === 0;
    c.fillStyle = WHITE;
    c.fillRect(x - 1, 0, 2, h * (major ? 0.35 : 0.22));
    if (deg % 30 === 0) {
      const s =
        deg === 0
          ? 'N'
          : deg === 90
            ? 'E'
            : deg === 180
              ? 'S'
              : deg === 270
                ? 'W'
                : String(deg / 10);
      text(c, s, x, h * 0.66, h * 0.42);
      if (x < h) text(c, s, x + w, h * 0.66, h * 0.42);
    }
  }
  return canvas;
}

/** Soft round glow (premultiplied-looking falloff) for the light sprites. */
export function drawGlow(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d')!;
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.08, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.25)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.05)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * Propeller disc at speed: a faint grey veil, darker towards the tips where the blades are
 * wide, with the white tips drawn as a ring.
 */
export function drawPropDisc(
  size: number,
  tipFraction: number,
  hubFraction: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d')!;
  const r = size / 2;
  const g = c.createRadialGradient(r, r, r * hubFraction, r, r, r);
  g.addColorStop(0, 'rgba(30,30,32,0.30)');
  g.addColorStop(0.4, 'rgba(30,30,32,0.22)');
  g.addColorStop(tipFraction - 0.02, 'rgba(40,40,42,0.14)');
  g.addColorStop(tipFraction, 'rgba(235,235,230,0.10)');
  g.addColorStop(0.985, 'rgba(235,235,230,0.07)');
  g.addColorStop(1, 'rgba(235,235,230,0)');
  c.fillStyle = g;
  c.beginPath();
  c.arc(r, r, r, 0, Math.PI * 2);
  c.fill();
  return canvas;
}

/**
 * Placard texts in an atlas of cols x rows cells of 4:1 (the model's label quads have the same
 * shape). Each text is fitted to its cell; the background stays transparent.
 */
export function drawLabelAtlas(
  texts: readonly string[],
  colors: readonly string[],
  cols: number,
  rows: number,
  cellW: number,
): HTMLCanvasElement {
  const cellH = cellW / 4;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cellW;
  canvas.height = rows * cellH;
  const c = canvas.getContext('2d')!;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  texts.forEach((s, i) => {
    const x = ((i % cols) + 0.5) * cellW;
    const y = (Math.floor(i / cols) + 0.5) * cellH;
    let size = cellH * 0.78;
    c.font = `700 ${size}px ${FONT}`;
    const w = c.measureText(s).width;
    if (w > cellW * 0.94) size *= (cellW * 0.94) / w;
    c.font = `700 ${size}px ${FONT}`;
    c.fillStyle = colors[i] ?? WHITE;
    c.fillText(s, x, y + size * 0.04);
  });
  return canvas;
}
