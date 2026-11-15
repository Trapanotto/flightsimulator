/**
 * The A320's primary flight display and navigation display painted into canvases, laid out
 * at 768 x 768 like the real 7.25 in display units.
 *
 * PFD: the flight mode annunciator (five columns from the telemetry's strings, a white box
 * round a newly engaged mode), attitude with the fixed aircraft symbol, the flight director
 * bars and the side-slip index, the speed tape with its trend arrow, target, VLS and alpha
 * protection strips, VMAX, F, S and green dot, the altitude tape with the selected altitude
 * and QNH or STD, vertical speed, the heading tape with selected heading and track, LOC and
 * G/S scales with the ILS identification, radio altitude and the DH callout.
 *
 * ND: ARC, NAV (ROSE NAV), PLAN, ROSE ILS and ROSE VOR with the flight plan in green, range
 * rings, ground speed, true airspeed and wind, the next waypoint with its distance at the top
 * right, navaids and the selected heading.
 */
import type { Waypoint } from '@sim';
import { mapOffsetNm } from './avionicsFormat';
import { type FmaColor, fmaColor } from './a320Format';
import {
  AB,
  type Ctx,
  angleDiff,
  arc,
  clear,
  line,
  poly,
  polar,
  q,
  rect,
  txt,
  wrap360,
} from './a320Paint';

const FMA_COLOR: Record<FmaColor, string> = {
  green: AB.green,
  blue: AB.blue,
  white: AB.white,
  magenta: AB.magenta,
  amber: AB.amber,
};

// =============================================================================================
// PFD

export interface PfdData {
  on: boolean;
  pitch: number;
  bank: number;
  /** Side slip, -1..1 of the index's travel. */
  slip: number;
  ias: number;
  /** Speed in 10 s at the present acceleration, kt. */
  trend: number;
  mach: number;
  alt: number;
  baro: number;
  std: boolean;
  vs: number;
  heading: number;
  track: number;
  /** Speed target: magenta when managed, blue when selected; undefined without one. */
  speedTarget: number | undefined;
  speedManaged: boolean;
  selAlt: number;
  altManaged: boolean;
  /** Selected heading (shown only when selected). */
  selHeading: number | undefined;
  fd: { pitch: number; bank: number } | undefined;
  /** LS pressed: the deviation scales and the ILS information. */
  ls: boolean;
  loc: number | undefined;
  gs: number | undefined;
  ilsIdent: string;
  ilsFreq: string;
  ilsCourse: number | undefined;
  dme: number | undefined;
  radioAlt: number | undefined;
  dh: number | undefined;
  fma: string[][];
  boxes: boolean[];
  /** LAND, FLARE, ROLL OUT span the vertical and lateral columns. */
  fmaCombined: boolean;
  /** Column 5's A/THR armed (blue) rather than active (white). */
  athrArmed: boolean;
  vls: number;
  vAlphaProt: number;
  vAlphaMax: number;
  vmax: number;
  f: number | undefined;
  s: number | undefined;
  greenDot: number | undefined;
  v1: number | undefined;
  vr: number | undefined;
  onGround: boolean;
  /** 'normal' unless a degraded law is in force (amber crosses replace the protections). */
  law: string;
  time: number;
}

export function pfdKey(d: PfdData): string {
  if (!d.on) return 'off';
  return [
    q(d.pitch, 0.1),
    q(d.bank, 0.2),
    q(d.slip, 0.05),
    q(d.ias, 0.2),
    q(d.trend, 1),
    q(d.mach, 0.002),
    q(d.alt, 2),
    q(d.baro, 1),
    d.std,
    q(d.vs, 20),
    q(d.heading, 0.2),
    q(d.track, 0.5),
    q(d.speedTarget, 1),
    d.speedManaged,
    q(d.selAlt, 100),
    q(d.selHeading, 1),
    d.fd ? `${q(d.fd.pitch, 0.1)},${q(d.fd.bank, 0.2)}` : '',
    d.ls,
    q(d.loc, 0.01),
    q(d.gs, 0.01),
    d.ilsIdent,
    q(d.dme, 0.1),
    q(d.radioAlt, d.radioAlt !== undefined && d.radioAlt < 50 ? 1 : 10),
    q(d.dh, 10),
    d.radioAlt !== undefined && d.dh !== undefined && d.radioAlt < d.dh
      ? Math.floor(d.time * 2) % 2
      : 0,
    JSON.stringify(d.fma),
    d.boxes.join(''),
    d.fmaCombined,
    d.athrArmed,
    q(d.vls, 1),
    q(d.vmax, 1),
    q(d.f, 1),
    q(d.s, 1),
    q(d.greenDot, 1),
    q(d.v1, 1),
    q(d.vr, 1),
    d.onGround,
    d.law,
  ].join('|');
}

const W = 768;
const AX = 384;
const AY = 330;
/** Pixels per degree of pitch. */
const PPD = 8.2;

export function paintPfd(c: Ctx, w: number, h: number, d: PfdData) {
  clear(c, w, h);
  if (!d.on) return;
  c.save();
  c.scale(w / W, h / W);
  attitude(c, d);
  speedTape(c, d);
  altitudeTape(c, d);
  vsi(c, d);
  headingTape(c, d);
  fma(c, d);
  ilsInfo(c, d);
  c.restore();
}

function fma(c: Ctx, d: PfdData) {
  const xs = [0, 166, 316, 466, 606, 768];
  for (let i = 1; i < 5; i++)
    if (!(d.fmaCombined && i === 2)) line(c, xs[i]!, 6, xs[i]!, 92, 2, AB.grey);
  const box = (text: string, cx: number) => {
    c.font = `600 23px "Segoe UI", Arial, sans-serif`;
    const tw = c.measureText(text).width;
    rect(c, cx - tw / 2 - 6, 8, tw + 12, 28, AB.white, 2);
  };
  d.fma.forEach((col, i) => {
    // A combined mode is written once across the vertical and lateral columns.
    if (d.fmaCombined && i === 2) return;
    const cx = d.fmaCombined && i === 1 ? (xs[1]! + xs[3]!) / 2 : (xs[i]! + xs[i + 1]!) / 2;
    col.forEach((t, l) => {
      if (!t) return;
      const color =
        i === 4 && l === 2 && d.athrArmed
          ? AB.blue
          : i === 0 && l === 1
            ? AB.amber
            : FMA_COLOR[fmaColor(i, l, t)];
      txt(c, t, cx, 22 + l * 28, 23, color);
    });
    if (d.boxes[i] && col[0]) box(col[0], cx);
  });
}
function attitude(c: Ctx, d: PfdData) {
  c.save();
  // The Airbus sphere: a rectangle with rounded top and bottom.
  c.beginPath();
  c.moveTo(196, 160);
  c.quadraticCurveTo(AX, 100, 572, 160);
  c.lineTo(572, 500);
  c.quadraticCurveTo(AX, 560, 196, 500);
  c.closePath();
  c.clip();
  c.translate(AX, AY);
  c.rotate((-d.bank * Math.PI) / 180);
  c.translate(0, d.pitch * PPD);
  rect(c, -800, -1200, 1600, 1200, AB.sky);
  rect(c, -800, 0, 1600, 1200, AB.ground);
  line(c, -800, 0, 800, 0, 2.5, AB.white);
  // Heading marks on the horizon line every 10 degrees.
  for (let k = -6; k <= 6; k++) {
    const x = (k * 10 - angleDiff(d.heading, Math.round(d.heading / 10) * 10)) * 6.4;
    line(c, x, 0, x, 10, 2, AB.white);
  }
  c.save();
  c.beginPath();
  c.rect(-140, -d.pitch * PPD - 150, 280, 270);
  c.clip();
  for (let p = -80; p <= 80; p += 2.5) {
    if (p === 0) continue;
    const y = -p * PPD;
    const major = p % 10 === 0;
    const half = major ? 62 : p % 5 === 0 ? 32 : 14;
    line(c, -half, y, half, y, 2.2, AB.white);
    if (major) {
      txt(c, String(Math.abs(p)), -half - 22, y, 20, AB.white);
      txt(c, String(Math.abs(p)), half + 22, y, 20, AB.white);
    }
  }
  c.restore();
  c.restore();
  // Roll scale and the bank pointer with the side-slip index.
  c.save();
  c.translate(AX, AY);
  const R = 190;
  arc(c, 0, 0, R, -45, 45, 2.5, AB.white);
  for (const a of [-45, -30, -20, -10, 10, 20, 30, 45]) {
    const [x0, y0] = polar(0, 0, R, a);
    const [x1, y1] = polar(0, 0, R + (Math.abs(a) === 30 || Math.abs(a) === 45 ? 18 : 11), a);
    line(c, x0, y0, x1, y1, 2.5, AB.white);
  }
  for (const a of [-67, 67]) {
    const [x0, y0] = polar(0, 0, R + 2, a);
    const [x1, y1] = polar(0, 0, R + 14, a);
    line(c, x0 - 3, y0, x1 - 3, y1, 2, AB.green);
    line(c, x0 + 3, y0, x1 + 3, y1, 2, AB.green);
  }
  poly(
    c,
    [
      [0, -R],
      [-11, -R - 18],
      [11, -R - 18],
    ],
    AB.yellow,
  );
  c.rotate((-d.bank * Math.PI) / 180);
  poly(
    c,
    [
      [0, -R + 2],
      [-12, -R + 20],
      [12, -R + 20],
    ],
    AB.yellow,
    2.5,
  );
  const sx = d.slip * 30;
  poly(
    c,
    [
      [sx - 15, -R + 24],
      [sx + 15, -R + 24],
      [sx + 18, -R + 31],
      [sx - 18, -R + 31],
    ],
    AB.yellow,
    2.5,
  );
  c.restore();
  // Flight director bars.
  if (d.fd) {
    const bx = AX + Math.max(-1, Math.min(1, (d.fd.bank - d.bank) / 25)) * 110;
    const by = AY - Math.max(-1, Math.min(1, (d.fd.pitch - d.pitch) / 12)) * 110;
    line(c, AX - 100, by, AX + 100, by, 4, AB.green);
    line(c, bx, AY - 100, bx, AY + 100, 4, AB.green);
  }
  // The fixed aircraft symbol: black with a yellow outline.
  for (const s of [-1, 1]) {
    const x0 = AX + s * 70;
    const pts: [number, number][] = [
      [x0, AY - 5],
      [x0 + s * 85, AY - 5],
      [x0 + s * 85, AY + 5],
      [x0 + s * 10, AY + 5],
      [x0 + s * 10, AY + 28],
      [x0, AY + 28],
    ];
    poly(c, pts, AB.black);
    poly(c, pts, AB.yellow, 3);
  }
  rect(c, AX - 6, AY - 6, 12, 12, AB.black);
  rect(c, AX - 6, AY - 6, 12, 12, AB.yellow, 3);
  // Radio altitude in the lower attitude.
  if (d.radioAlt !== undefined && d.radioAlt < 2500) {
    const below = d.dh !== undefined && d.radioAlt < d.dh;
    const ra = d.radioAlt < 50 ? Math.round(d.radioAlt) : Math.round(d.radioAlt / 10) * 10;
    txt(c, String(Math.max(0, ra)), AX, 520, 30, below ? AB.amber : AB.green);
  }
  if (
    d.dh !== undefined &&
    d.radioAlt !== undefined &&
    d.radioAlt < d.dh &&
    Math.floor(d.time * 2) % 2 === 0
  )
    txt(c, 'DH', AX - 120, 470, 30, AB.amber);
  if (d.law !== 'normal') {
    for (const a of [-45, 45]) {
      const [x, y] = polar(AX, AY, 205, a);
      txt(c, 'x', x, y, 26, AB.amber);
    }
  }
}

const SPD_X = 36;
const SPD_W = 112;
const SPD_PX = 4.6; // pixels per knot

function speedTape(c: Ctx, d: PfdData) {
  const top = 120;
  const bot = 540;
  c.save();
  c.beginPath();
  c.rect(SPD_X, top, SPD_W + 40, bot - top);
  c.clip();
  rect(c, SPD_X, top, SPD_W, bot - top, AB.tape);
  const ias = Math.max(d.ias, 30);
  const y = (v: number) => AY - (v - ias) * SPD_PX;
  for (let v = Math.floor((ias - 60) / 10) * 10; v <= ias + 60; v += 10) {
    if (v < 30) continue;
    line(c, SPD_X + SPD_W - 16, y(v), SPD_X + SPD_W, y(v), 2.5, AB.white);
    if (v % 20 === 0) txt(c, String(v).padStart(3, '0'), SPD_X + 46, y(v), 25, AB.white);
  }
  const strip = SPD_X + SPD_W - 2;
  if (!d.onGround) {
    // VLS (amber), alpha protection (black and amber barber pole), alpha max (red).
    rect(c, strip - 6, y(d.vls), 6, (d.vls - d.vAlphaProt) * SPD_PX, AB.amber);
    for (let v = d.vAlphaProt; v > d.vAlphaMax; v -= 4)
      rect(c, strip - 8, y(v), 8, Math.min(2, v - d.vAlphaMax) * SPD_PX, AB.amber);
    rect(c, strip - 9, y(d.vAlphaMax), 9, 400, AB.red);
  }
  // VMAX: red and black barber pole upwards.
  for (let v = d.vmax; v < d.vmax + 80; v += 4) rect(c, strip - 8, y(v + 2), 8, 2 * SPD_PX, AB.red);
  // Characteristic speeds.
  const mark = (v: number | undefined, s: string, color: string) => {
    if (v === undefined) return;
    line(c, strip, y(v), strip + 12, y(v), 2.5, color);
    txt(c, s, strip + 22, y(v), 20, color);
  };
  if (!d.onGround) {
    mark(d.f, 'F', AB.green);
    mark(d.s, 'S', AB.green);
    if (d.greenDot !== undefined) {
      c.strokeStyle = AB.green;
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(strip + 12, y(d.greenDot), 6, 0, Math.PI * 2);
      c.stroke();
    }
  } else {
    mark(d.v1, '1', AB.blue);
    if (d.vr !== undefined) {
      c.strokeStyle = AB.blue;
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(strip + 12, y(d.vr), 6, 0, Math.PI * 2);
      c.stroke();
    }
  }
  // Speed target.
  if (d.speedTarget !== undefined) {
    const ty = Math.max(top + 8, Math.min(bot - 8, y(d.speedTarget)));
    const col = d.speedManaged ? AB.magenta : AB.blue;
    if (y(d.speedTarget) < top + 8 || y(d.speedTarget) > bot - 8)
      txt(
        c,
        String(Math.round(d.speedTarget)),
        SPD_X + 56,
        y(d.speedTarget) < top ? top + 16 : bot - 16,
        22,
        col,
      );
    else
      poly(
        c,
        [
          [strip + 2, ty],
          [strip + 22, ty - 11],
          [strip + 22, ty + 11],
        ],
        col,
        3,
      );
  }
  c.restore();
  // The yellow reference line and the trend arrow.
  poly(
    c,
    [
      [SPD_X - 6, AY - 3],
      [SPD_X + SPD_W + 22, AY - 3],
      [SPD_X + SPD_W + 22, AY + 3],
      [SPD_X - 6, AY + 3],
    ],
    AB.yellow,
  );
  poly(
    c,
    [
      [SPD_X + SPD_W + 14, AY],
      [SPD_X + SPD_W + 30, AY - 9],
      [SPD_X + SPD_W + 30, AY + 9],
    ],
    AB.yellow,
  );
  if (Math.abs(d.trend) > 2) {
    const ty = AY - Math.max(-90, Math.min(90, d.trend * SPD_PX));
    const x = SPD_X + SPD_W - 4;
    line(c, x, AY, x, ty, 3, AB.yellow);
    const s = Math.sign(d.trend);
    poly(
      c,
      [
        [x, ty - s * 10],
        [x - 7, ty + s * 2],
        [x + 7, ty + s * 2],
      ],
      AB.yellow,
    );
  }
  line(c, SPD_X, top, SPD_X + SPD_W, top, 2, AB.white);
  line(c, SPD_X, bot, SPD_X + SPD_W, bot, 2, AB.white);
  if (d.mach >= 0.5)
    txt(
      c,
      `.${String(Math.round(d.mach * 1000))
        .padStart(3, '0')
        .slice(0, 2)}`,
      SPD_X + 52,
      572,
      26,
      AB.green,
    );
}

const ALT_X = 604;
const ALT_W = 92;
const ALT_PX = 0.58; // pixels per foot

function altitudeTape(c: Ctx, d: PfdData) {
  const top = 120;
  const bot = 540;
  c.save();
  c.beginPath();
  c.rect(ALT_X, top, ALT_W + 4, bot - top);
  c.clip();
  rect(c, ALT_X, top, ALT_W - 20, bot - top, AB.tape);
  const y = (a: number) => AY - (a - d.alt) * ALT_PX;
  for (let a = Math.floor((d.alt - 400) / 100) * 100; a <= d.alt + 400; a += 100) {
    line(c, ALT_X + ALT_W - 36, y(a), ALT_X + ALT_W - 20, y(a), 2.5, AB.white);
    if (a % 500 === 0)
      txt(c, String(Math.round(a / 100)).padStart(3, '0'), ALT_X + 28, y(a), 24, AB.white);
  }
  // Ground reference: a red ribbon below the radio-altitude ground.
  if (d.radioAlt !== undefined && d.radioAlt < 570) {
    const g = y(d.alt - d.radioAlt);
    rect(c, ALT_X + ALT_W - 34, g, 14, 400, AB.red);
  }
  // Selected altitude: a blue (magenta when managed with a constraint) bug in range.
  const sel = y(d.selAlt);
  const selCol = AB.blue;
  if (sel > top + 20 && sel < bot - 20) {
    rect(c, ALT_X + 2, sel - 24, ALT_W - 26, 48, selCol, 2.5);
    txt(c, String(Math.round(d.selAlt / 100)).padStart(3, '0'), ALT_X + 34, sel, 24, selCol);
  }
  c.restore();
  if (sel <= top + 20 || sel >= bot - 20) {
    const ty = sel <= top + 20 ? top - 18 : bot + 18;
    txt(
      c,
      d.std && d.selAlt >= 3000
        ? `FL${String(Math.round(d.selAlt / 100)).padStart(3, '0')}`
        : String(Math.round(d.selAlt)),
      ALT_X + 46,
      ty,
      24,
      selCol,
    );
  }
  line(c, ALT_X, top, ALT_X + ALT_W - 20, top, 2, AB.white);
  line(c, ALT_X, bot, ALT_X + ALT_W - 20, bot, 2, AB.white);
  // The yellow window with the drum digits.
  const hundreds = Math.floor(Math.max(d.alt, -999) / 100);
  rect(c, ALT_X - 4, AY - 24, ALT_W + 6, 48, AB.black);
  rect(c, ALT_X - 4, AY - 24, ALT_W + 6, 48, AB.yellow, 3);
  txt(c, String(Math.abs(hundreds)).padStart(3, '0'), ALT_X + 34, AY, 30, AB.green);
  const rest = ((d.alt % 100) + 100) % 100;
  c.save();
  c.beginPath();
  c.rect(ALT_X + 58, AY - 22, 40, 44);
  c.clip();
  for (let k = -1; k <= 2; k++) {
    const v = (Math.floor(rest / 20) + k) * 20;
    const yy = AY + ((rest - v) / 20) * 24;
    txt(c, String(((v % 100) + 100) % 100).padStart(2, '0'), ALT_X + 78, yy, 22, AB.green);
  }
  c.restore();
  // Baro setting.
  if (d.std) {
    rect(c, ALT_X + 4, 586, 70, 32, AB.yellow, 2);
    txt(c, 'STD', ALT_X + 39, 603, 24, AB.blue);
  } else {
    txt(c, 'QNH', ALT_X - 10, 603, 20, AB.white, 'left');
    txt(c, String(Math.round(d.baro)), ALT_X + 96, 603, 24, AB.blue, 'right');
  }
}

function vsi(c: Ctx, d: PfdData) {
  const x = 704;
  rect(c, x, 170, 40, 320, AB.tape);
  const ys = (fpm: number) => {
    const v = Math.max(-6000, Math.min(6000, fpm));
    const a = Math.abs(v);
    const k =
      a <= 1000
        ? (a / 1000) * 80
        : a <= 2000
          ? 80 + ((a - 1000) / 1000) * 50
          : 130 + ((a - 2000) / 4000) * 28;
    return AY - Math.sign(v) * k;
  };
  for (const v of [-6000, -2000, -1500, -1000, -500, 500, 1000, 1500, 2000, 6000]) {
    line(c, x + 2, ys(v), x + 12, ys(v), 2, AB.white);
    if ([-6000, -2000, -1000, 1000, 2000, 6000].includes(v))
      txt(c, String(Math.abs(v) / 1000), x + 22, ys(v), 16, AB.white);
  }
  line(c, x, AY, x + 16, AY, 3, AB.yellow);
  const col = Math.abs(d.vs) > 6000 ? AB.amber : AB.green;
  line(c, x + 40, AY, x + 4, ys(d.vs), 3.5, col);
  if (Math.abs(d.vs) >= 200) {
    const ty = ys(d.vs) + (d.vs > 0 ? -16 : 16);
    rect(c, x - 2, ty - 12, 38, 24, AB.black);
    txt(c, String(Math.round(Math.abs(d.vs) / 100)).padStart(2, '0'), x + 18, ty, 20, col);
  }
}

function headingTape(c: Ctx, d: PfdData) {
  const top = 610;
  const x0 = 216;
  const x1 = 552;
  const px = 7.2;
  c.save();
  c.beginPath();
  c.rect(x0, top, x1 - x0, 64);
  c.clip();
  rect(c, x0, top, x1 - x0, 64, AB.tape);
  const base = Math.round(d.heading / 5) * 5;
  for (let k = -30; k <= 30; k += 5) {
    const hdg = wrap360(base + k);
    const x = AX + angleDiff(hdg, d.heading) * px;
    const major = hdg % 10 === 0;
    line(c, x, top, x, top + (major ? 16 : 9), 2.5, AB.white);
    if (major) {
      const n = Math.round(hdg / 10) % 36;
      txt(c, String(n), x, top + 32, n % 3 === 0 ? 24 : 19, AB.white);
    }
  }
  const tx = AX + angleDiff(d.track, d.heading) * px;
  poly(
    c,
    [
      [tx, top + 2],
      [tx + 7, top + 12],
      [tx, top + 22],
      [tx - 7, top + 12],
    ],
    AB.green,
    2.5,
  );
  if (d.selHeading !== undefined) {
    const sx = AX + Math.max(-24, Math.min(24, angleDiff(d.selHeading, d.heading))) * px;
    poly(
      c,
      [
        [sx, top],
        [sx - 10, top - 1],
        [sx, top + 16],
        [sx + 10, top - 1],
      ],
      AB.blue,
      3,
    );
  }
  if (d.ls && d.ilsCourse !== undefined && Math.abs(angleDiff(d.ilsCourse, d.heading)) < 24) {
    const cx = AX + angleDiff(d.ilsCourse, d.heading) * px;
    line(c, cx, top, cx, top + 30, 3, AB.magenta);
  }
  c.restore();
  line(c, AX, top - 14, AX, top + 18, 4, AB.yellow);
  if (d.selHeading !== undefined && Math.abs(angleDiff(d.selHeading, d.heading)) >= 24)
    txt(
      c,
      String(Math.round(wrap360(d.selHeading))).padStart(3, '0'),
      angleDiff(d.selHeading, d.heading) > 0 ? x1 - 30 : x0 + 30,
      top + 50,
      22,
      AB.blue,
    );
}

function ilsInfo(c: Ctx, d: PfdData) {
  if (!d.ls) return;
  // LOC scale below the sphere, G/S scale right of it; two dots either way.
  const ly = 560;
  for (const k of [-2, -1, 1, 2]) {
    c.strokeStyle = AB.white;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(AX + k * 52, ly, 6, 0, Math.PI * 2);
    c.stroke();
  }
  line(c, AX, ly - 12, AX, ly + 12, 3, AB.yellow);
  const gx = 588;
  for (const k of [-2, -1, 1, 2]) {
    c.beginPath();
    c.arc(gx, AY + k * 52, 6, 0, Math.PI * 2);
    c.stroke();
  }
  line(c, gx - 12, AY, gx + 12, AY, 3, AB.yellow);
  if (d.loc !== undefined) {
    const x = AX + Math.max(-2.3, Math.min(2.3, d.loc * 2)) * 52;
    poly(
      c,
      [
        [x, ly - 12],
        [x + 10, ly],
        [x, ly + 12],
        [x - 10, ly],
      ],
      AB.magenta,
      Math.abs(d.loc) > 1.1 ? 2 : 0,
    );
  }
  if (d.gs !== undefined) {
    const y = AY - Math.max(-2.3, Math.min(2.3, d.gs * 2)) * 52;
    poly(
      c,
      [
        [gx - 10, y],
        [gx, y - 12],
        [gx + 10, y],
        [gx, y + 12],
      ],
      AB.magenta,
      Math.abs(d.gs) > 1.1 ? 2 : 0,
    );
  }
  txt(c, d.ilsIdent || '', 16, 692, 22, AB.magenta, 'left');
  txt(c, d.ilsFreq, 16, 718, 22, AB.magenta, 'left');
  if (d.dme !== undefined) txt(c, `${d.dme.toFixed(1)}NM`, 16, 744, 22, AB.magenta, 'left');
  if (d.dh !== undefined) {
    txt(c, 'DH', 640, 690, 20, AB.white, 'left');
    txt(c, String(Math.round(d.dh)), 740, 690, 22, AB.blue, 'right');
  }
}

// =============================================================================================
// ND

export interface NdData {
  on: boolean;
  mode: 'ils' | 'vor' | 'nav' | 'arc' | 'plan';
  range: number;
  heading: number;
  track: number;
  gs: number;
  tas: number;
  wind: { dir: number; speed: number } | undefined;
  lon: number;
  lat: number;
  plan: readonly Waypoint[];
  active: number;
  distance: number | undefined;
  /** Magnetic variation to turn true bearings into the ND's magnetic heading (deg, east +). */
  declination: number;
  selHeading: number | undefined;
  ils:
    | {
        course: number;
        deviation: number | undefined;
        gs: number | undefined;
        ident: string;
        freq: string;
      }
    | undefined;
  vor:
    | {
        course: number;
        deviation: number | undefined;
        ident: string;
        freq: string;
        bearing: number | undefined;
        toFrom: string;
      }
    | undefined;
  /** Stations with their offsets (NM east, north). */
  navaids: { ident: string; east: number; north: number }[];
  time: number;
}

export function ndKey(d: NdData): string {
  if (!d.on) return 'off';
  return [
    d.mode,
    d.range,
    q(d.heading, 0.5),
    q(d.track, 0.5),
    q(d.gs, 1),
    q(d.tas, 1),
    d.wind ? `${q(d.wind.dir, 1)},${q(d.wind.speed, 1)}` : '',
    q(d.lon, d.range / 4000 / 60),
    q(d.lat, d.range / 4000 / 60),
    d.active,
    d.plan.length,
    q(d.distance, 0.1),
    q(d.selHeading, 1),
    d.ils
      ? `${q(d.ils.course, 1)},${q(d.ils.deviation, 0.02)},${q(d.ils.gs, 0.02)},${d.ils.ident}`
      : '',
    d.vor
      ? `${q(d.vor.course, 1)},${q(d.vor.deviation, 0.02)},${q(d.vor.bearing, 1)},${d.vor.ident}`
      : '',
    d.navaids.map((n) => n.ident).join(','),
  ].join('|');
}

export function paintNd(c: Ctx, w: number, h: number, d: NdData) {
  clear(c, w, h);
  if (!d.on) return;
  c.save();
  c.scale(w / W, h / W);
  if (d.mode === 'plan') planMode(c, d);
  else if (d.mode === 'arc') roseOrArc(c, d, true);
  else roseOrArc(c, d, false);
  topLeft(c, d);
  topRight(c, d);
  c.restore();
}

function topLeft(c: Ctx, d: NdData) {
  txt(c, 'GS', 14, 22, 20, AB.white, 'left');
  txt(c, String(Math.round(d.gs)), 52, 22, 24, AB.green, 'left');
  txt(c, 'TAS', 112, 22, 20, AB.white, 'left');
  txt(c, String(Math.round(d.tas)), 160, 22, 24, AB.green, 'left');
  if (d.wind && d.tas > 100) {
    txt(
      c,
      `${String(Math.round(wrap360(d.wind.dir))).padStart(3, '0')}/${Math.round(d.wind.speed)}`,
      14,
      50,
      22,
      AB.green,
      'left',
    );
    c.save();
    c.translate(40, 88);
    c.rotate(((d.wind.dir + 180 - d.heading) * Math.PI) / 180);
    line(c, 0, -18, 0, 18, 3, AB.green);
    poly(
      c,
      [
        [0, 20],
        [-7, 8],
        [7, 8],
      ],
      AB.green,
    );
    c.restore();
  }
}

function topRight(c: Ctx, d: NdData) {
  const wp = d.plan[d.active];
  if (!wp || d.active < 0) return;
  txt(c, wp.ident, 610, 22, 24, AB.white, 'right');
  const off = mapOffsetNm(d.lon, d.lat, wp.lon, wp.lat);
  const brg = wrap360((Math.atan2(off.east, off.north) * 180) / Math.PI - d.declination);
  txt(c, `${String(Math.round(brg)).padStart(3, '0')}°`, 700, 22, 24, AB.green, 'right');
  const dist = d.distance ?? Math.hypot(off.east, off.north);
  txt(c, dist < 20 ? dist.toFixed(1) : String(Math.round(dist)), 712, 50, 24, AB.green, 'right');
  txt(c, 'NM', 754, 50, 18, AB.blue, 'right');
  if (d.gs > 60) {
    const utc = (d.time + 12 * 3600 + (dist / d.gs) * 3600) % 86400;
    const hh = Math.floor(utc / 3600);
    const mm = Math.floor((utc % 3600) / 60);
    txt(
      c,
      `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
      754,
      78,
      24,
      AB.green,
      'right',
    );
  }
}

/** ARC (aircraft low, a 90 degree arc) or a ROSE (aircraft in the middle, full circle). */
function roseOrArc(c: Ctx, d: NdData, isArc: boolean) {
  const cx = AX;
  const cy = isArc ? 640 : 400;
  const R = isArc ? 520 : 270;
  const up = d.heading;
  const px = R / d.range;
  // Positions: NM east/north -> screen (heading up, magnetic).
  const rot = ((up + d.declination) * Math.PI) / 180;
  const toScreen = (e: number, n: number): [number, number] => {
    const x = e * Math.cos(rot) - n * Math.sin(rot);
    const y = e * Math.sin(rot) + n * Math.cos(rot);
    return [cx + x * px, cy - y * px];
  };
  c.save();
  c.beginPath();
  c.rect(0, 100, W, 668);
  c.clip();
  // Range ring (half range, dashed in ARC), the compass ring.
  c.setLineDash([12, 10]);
  c.strokeStyle = AB.white;
  c.lineWidth = 2;
  c.beginPath();
  if (isArc) c.arc(cx, cy, R / 2, Math.PI * 1.2, Math.PI * 1.8);
  else c.arc(cx, cy, R / 2, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  txt(c, String(d.range / 2), cx - (R / 2) * 0.76 - 18, cy - (R / 2) * 0.66, 20, AB.blue);
  if (isArc) arc(c, cx, cy, R, -50, 50, 2.5, AB.white);
  else arc(c, cx, cy, R, 0, 360, 2.5, AB.white);
  for (let a = 0; a < 360; a += 5) {
    const rel = angleDiff(a, up);
    if (isArc && Math.abs(rel) > 52) continue;
    const major = a % 10 === 0;
    const [x0, y0] = polar(cx, cy, R, rel);
    const [x1, y1] = polar(cx, cy, R + (major ? 18 : 10), rel);
    line(c, x0, y0, x1, y1, 2.5, AB.white);
    if (a % 30 === 0) {
      const [tx, ty] = polar(cx, cy, R + 36, rel);
      txt(c, String(a / 10), tx, ty, 24, AB.white);
    }
  }
  // Flight plan: green legs, the active leg and waypoint white.
  if (d.mode !== 'ils' && d.mode !== 'vor') {
    const pts = d.plan.map((wp) => {
      const o = mapOffsetNm(d.lon, d.lat, wp.lon, wp.lat);
      return toScreen(o.east, o.north);
    });
    for (let i = Math.max(d.active, 1); i < pts.length; i++) {
      const a = i === d.active ? toScreen(0, 0) : pts[i - 1]!;
      const b = pts[i]!;
      line(c, a[0], a[1], b[0], b[1], 3, i === d.active ? AB.white : AB.green);
    }
    pts.forEach((p, i) => {
      if (i < d.active) return;
      const col = i === d.active ? AB.white : AB.green;
      poly(
        c,
        [
          [p[0], p[1] - 9],
          [p[0] + 9, p[1]],
          [p[0], p[1] + 9],
          [p[0] - 9, p[1]],
        ],
        col,
        2.5,
      );
      txt(c, d.plan[i]!.ident, p[0] + 16, p[1] - 2, 22, col, 'left');
    });
    for (const n of d.navaids) {
      const [x, y] = toScreen(n.east, n.north);
      c.strokeStyle = AB.magenta;
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(x, y, 8, 0, Math.PI * 2);
      c.stroke();
      line(c, x - 14, y, x + 14, y, 2, AB.magenta);
      line(c, x, y - 14, x, y + 14, 2, AB.magenta);
      txt(c, n.ident, x + 18, y + 14, 20, AB.magenta, 'left');
    }
  }
  // ROSE ILS / VOR: the course pointer and deviation bar.
  const nav = d.mode === 'ils' ? d.ils : d.mode === 'vor' ? d.vor : undefined;
  if (nav) {
    const col = d.mode === 'ils' ? AB.magenta : AB.blue;
    c.save();
    c.translate(cx, cy);
    c.rotate((angleDiff(nav.course, up) * Math.PI) / 180);
    line(c, 0, -R + 8, 0, -R / 2 - 10, 5, col);
    poly(
      c,
      [
        [0, -R + 4],
        [-12, -R + 26],
        [12, -R + 26],
      ],
      col,
    );
    line(c, 0, R / 2 + 10, 0, R - 8, 5, col);
    for (const k of [-2, -1, 1, 2]) {
      c.strokeStyle = AB.white;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(k * 46, 0, 6, 0, Math.PI * 2);
      c.stroke();
    }
    if (nav.deviation !== undefined) {
      const x = Math.max(-2.2, Math.min(2.2, nav.deviation * 2)) * 46;
      line(c, x, -R / 2 + 12, x, R / 2 - 12, 5, col);
    }
    c.restore();
    txt(c, d.mode === 'ils' ? 'ILS1' : 'VOR1', 640, 690, 22, AB.white, 'left');
    txt(c, nav.freq, 754, 714, 22, col, 'right');
    txt(
      c,
      `CRS ${String(Math.round(wrap360(nav.course))).padStart(3, '0')}°`,
      754,
      738,
      22,
      col,
      'right',
    );
    txt(c, nav.ident, 754, 762, 22, col, 'right');
    if (d.mode === 'ils' && d.ils && d.ils.gs !== undefined) {
      const gx = 700;
      for (const k of [-2, -1, 1, 2]) {
        c.beginPath();
        c.arc(gx, cy + k * 40, 6, 0, Math.PI * 2);
        c.stroke();
      }
      const y = cy - Math.max(-2.2, Math.min(2.2, d.ils.gs * 2)) * 40;
      poly(
        c,
        [
          [gx - 10, y],
          [gx, y - 12],
          [gx + 10, y],
          [gx, y + 12],
        ],
        AB.magenta,
      );
    }
  }
  // Track diamond and selected heading.
  const [tx, ty] = polar(cx, cy, R - 4, angleDiff(d.track, up));
  poly(
    c,
    [
      [tx, ty - 9],
      [tx + 8, ty],
      [tx, ty + 9],
      [tx - 8, ty],
    ],
    AB.green,
    2.5,
  );
  if (d.selHeading !== undefined) {
    const rel = angleDiff(d.selHeading, up);
    if (!isArc || Math.abs(rel) < 50) {
      c.save();
      c.translate(cx, cy);
      c.rotate((rel * Math.PI) / 180);
      poly(
        c,
        [
          [0, -R + 2],
          [-12, -R - 18],
          [12, -R - 18],
        ],
        AB.blue,
        3,
      );
      c.restore();
    }
  }
  c.restore();
  // Lubber line and the heading box, the aircraft symbol.
  line(c, cx, cy - R - 24, cx, cy - R + 18, 4, AB.yellow);
  rect(c, cx - 32, 64, 64, 32, AB.black);
  rect(c, cx - 32, 64, 64, 32, AB.white, 2);
  txt(c, String(Math.round(wrap360(up))).padStart(3, '0'), cx, 80, 24, AB.green);
  line(c, cx - 38, cy, cx + 38, cy, 5, AB.yellow);
  line(c, cx, cy - 18, cx, cy + 34, 5, AB.yellow);
  line(c, cx - 14, cy + 28, cx + 14, cy + 28, 5, AB.yellow);
}

function planMode(c: Ctx, d: NdData) {
  const cx = AX;
  const cy = 420;
  const R = 270;
  const centre = d.plan[d.active] ?? { lon: d.lon, lat: d.lat, ident: '' };
  const px = R / d.range;
  const toScreen = (lon: number, lat: number): [number, number] => {
    const o = mapOffsetNm(centre.lon, centre.lat, lon, lat);
    return [cx + o.east * px, cy - o.north * px];
  };
  c.save();
  c.beginPath();
  c.rect(0, 100, W, 668);
  c.clip();
  arc(c, cx, cy, R, 0, 360, 2.5, AB.white);
  c.setLineDash([12, 10]);
  c.strokeStyle = AB.white;
  c.lineWidth = 2;
  c.beginPath();
  c.arc(cx, cy, R / 2, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  for (const [s, dx, dy] of [
    ['N', 0, -1],
    ['E', 1, 0],
    ['S', 0, 1],
    ['W', -1, 0],
  ] as const)
    txt(c, s, cx + dx * (R + 22), cy + dy * (R + 22), 26, AB.white);
  const pts = d.plan.map((wp) => toScreen(wp.lon, wp.lat));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    line(c, a[0], a[1], b[0], b[1], 3, i === d.active ? AB.white : AB.green);
  }
  pts.forEach((p, i) => {
    const col = i === d.active ? AB.white : AB.green;
    poly(
      c,
      [
        [p[0], p[1] - 9],
        [p[0] + 9, p[1]],
        [p[0], p[1] + 9],
        [p[0] - 9, p[1]],
      ],
      col,
      2.5,
    );
    txt(c, d.plan[i]!.ident, p[0] + 16, p[1] - 2, 22, col, 'left');
  });
  const [ax, ay] = toScreen(d.lon, d.lat);
  c.save();
  c.translate(ax, ay);
  c.rotate(((d.heading + d.declination) * Math.PI) / 180);
  line(c, -26, 0, 26, 0, 5, AB.yellow);
  line(c, 0, -14, 0, 30, 5, AB.yellow);
  line(c, -10, 24, 10, 24, 5, AB.yellow);
  c.restore();
  c.restore();
}
