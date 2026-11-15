/**
 * The PC-12's displays painted into canvases, in the manner of the Honeywell Primus Apex: the
 * primary flight display (attitude with the flight director, speed and altitude tapes,
 * vertical speed, the HSI with the selected navigation source, glide slope, marker beacons,
 * radar altitude and minimums, the mode annunciations), the left multi-function display (the
 * engine indications and a moving map), the right one (systems synopsis and the crew alerting
 * messages), and the small windows of the panel (radios, standby instrument, gear lights, the
 * flight guidance panel's legends and lamps, the trim positions).
 *
 * Each window repaints only when its key (the values it shows, rounded to what a pixel can
 * show) changes; canvasAtlas.ts limits the uploads.
 */
import type { AvionicsTelemetry, SystemsTelemetry, Waypoint } from '@sim';
import type { AtlasPainter } from './canvasAtlas';
import { formatBearing, formatDmeDistance, mapOffsetNm } from './avionicsFormat';
import { type PanelData, content as radioContent, paint as radioPaint } from './displays';
import {
  type CasMessage,
  type GaugeLimits,
  type ModeAnnunciation,
  PC12_LIMITS,
  PC12_SPEEDS,
  altitudeDigits,
  formatBaro,
  formatNg,
  formatRadarAltitude,
  formatSelectedAltitude,
  formatTorque,
  formatVs,
  formatWhole,
  gaugeZone,
  legColor,
  mapNorthUp,
  maxSpeed,
  pitchScale,
  stallSpeed,
} from './pc12Avionics';

type Ctx = CanvasRenderingContext2D;
const FONT = '"Segoe UI", "Bahnschrift", "Arial Narrow", Arial, sans-serif';
const C = {
  white: '#f0f2f2',
  grey: '#8c9296',
  dim: '#4b5155',
  cyan: '#38dcff',
  magenta: '#ff3cf6',
  green: '#29f04f',
  amber: '#ffb400',
  red: '#ff2b2b',
  yellow: '#ffe21a',
  sky: '#1a63c9',
  skyTop: '#0d3f8f',
  ground: '#704521',
  groundLow: '#3f250f',
  tape: 'rgba(40,46,54,0.82)',
  black: '#000000',
};

function txt(
  c: Ctx,
  s: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'center',
  weight = 600,
) {
  c.fillStyle = color;
  c.font = `${weight} ${size}px ${FONT}`;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillText(s, x, y);
}

function line(c: Ctx, x0: number, y0: number, x1: number, y1: number, w: number, color: string) {
  c.strokeStyle = color;
  c.lineWidth = w;
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
}

function rect(c: Ctx, x: number, y: number, w: number, h: number, color: string, lw = 0) {
  if (lw) {
    c.strokeStyle = color;
    c.lineWidth = lw;
    c.strokeRect(x, y, w, h);
  } else {
    c.fillStyle = color;
    c.fillRect(x, y, w, h);
  }
}

const zoneColor = (z: string) =>
  z === 'red' ? C.red : z === 'amber' ? C.amber : z === 'green' ? C.green : C.white;

// =============================================================================================
// Primary flight display

export interface PfdData {
  on: boolean;
  pitch: number;
  bank: number;
  slip: number;
  ias: number;
  trend: number;
  tas: number;
  gs: number;
  mach: number;
  alt: number;
  baro: number;
  std: boolean;
  vs: number;
  heading: number;
  hdgBug: number;
  selAlt: number;
  selVs: number;
  selSpeed: number | undefined;
  source: 'FMS' | 'NAV1' | 'NAV2';
  course: number;
  deviation: number | undefined;
  toFrom: 'to' | 'from' | 'off';
  glide: number | undefined;
  ident: string;
  distance: number | undefined;
  fd: { pitch: number; bank: number } | undefined;
  modes: ModeAnnunciation;
  markers: string;
  radioAlt: number | undefined;
  minimums: number;
  flaps: number;
  gear: number;
  time: number;
}

/** The PFD's key: everything it shows, rounded to what a pixel can show. */
export function pfdKey(d: PfdData): string {
  if (!d.on) return 'off';
  const r = (v: number | undefined, q: number) => (v === undefined ? '-' : Math.round(v / q));
  return [
    r(d.pitch, 0.1),
    r(d.bank, 0.2),
    r(d.slip, 0.05),
    r(d.ias, 0.2),
    r(d.trend, 1),
    r(d.tas, 1),
    r(d.gs, 1),
    r(d.mach, 0.01),
    r(d.alt, 2),
    r(d.baro, 1),
    d.std,
    r(d.vs, 20),
    r(d.heading, 0.2),
    r(d.hdgBug, 1),
    r(d.selAlt, 100),
    r(d.selVs, 100),
    r(d.selSpeed, 1),
    d.source,
    r(d.course, 1),
    r(d.deviation, 0.01),
    d.toFrom,
    r(d.glide, 0.01),
    d.ident,
    r(d.distance, 0.1),
    d.fd ? `${r(d.fd.pitch, 0.1)},${r(d.fd.bank, 0.2)}` : '',
    JSON.stringify(d.modes),
    d.modes.apWarning ? Math.floor(d.time * 3) % 2 : 0,
    d.markers,
    d.markers ? Math.floor(d.time * 3) % 2 : 0,
    r(d.radioAlt, 5),
    r(d.minimums, 10),
    r(d.flaps, 0.02),
    r(d.gear, 0.05),
  ].join('|');
}

/** Paints the PFD into a w x h box (the layout is designed at 1024 x 768). */
export function paintPfd(c: Ctx, w: number, h: number, d: PfdData) {
  c.fillStyle = C.black;
  c.fillRect(0, 0, w, h);
  if (!d.on) return;
  c.save();
  c.scale(w / 1024, h / 768);
  attitude(c, d);
  speedTape(c, d);
  altitudeTape(c, d);
  vsi(c, d);
  hsi(c, d);
  fma(c, d);
  c.restore();
}

const AX = 512;
const AY = 300;

function attitude(c: Ctx, d: PfdData) {
  const ppd = pitchScale(768);
  c.save();
  c.beginPath();
  c.roundRect(214, 66, 596, 470, 18);
  c.clip();
  c.translate(AX, AY);
  c.rotate((-d.bank * Math.PI) / 180);
  c.translate(0, d.pitch * ppd);
  const sky = c.createLinearGradient(0, -900, 0, 0);
  sky.addColorStop(0, C.skyTop);
  sky.addColorStop(1, C.sky);
  c.fillStyle = sky;
  c.fillRect(-1200, -1200, 2400, 1200);
  const gnd = c.createLinearGradient(0, 0, 0, 900);
  gnd.addColorStop(0, C.ground);
  gnd.addColorStop(1, C.groundLow);
  c.fillStyle = gnd;
  c.fillRect(-1200, 0, 2400, 1200);
  line(c, -1200, 0, 1200, 0, 2.5, C.white);
  // Pitch ladder: 2.5 degree steps, numbers every 10; clipped to the middle.
  c.save();
  c.beginPath();
  c.rect(-170, -d.pitch * ppd - 175, 340, 330);
  c.clip();
  for (let p = -90; p <= 90; p += 2.5) {
    if (p === 0) continue;
    const y = -p * ppd;
    const major = p % 10 === 0;
    const half = major ? 70 : p % 5 === 0 ? 38 : 18;
    line(c, -half, y, half, y, 2, C.white);
    if (major) {
      txt(c, String(Math.abs(p)), -half - 24, y, 21, C.white);
      txt(c, String(Math.abs(p)), half + 24, y, 21, C.white);
    }
  }
  c.restore();
  c.restore();
  // Roll scale and pointer.
  c.save();
  c.translate(AX, AY);
  const R = 205;
  c.strokeStyle = C.white;
  c.lineWidth = 2.5;
  c.beginPath();
  c.arc(0, 0, R, (-150 * Math.PI) / 180, (-30 * Math.PI) / 180);
  c.stroke();
  for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const rad = ((a - 90) * Math.PI) / 180;
    const len = Math.abs(a) === 30 || Math.abs(a) === 60 ? 22 : 13;
    line(
      c,
      R * Math.cos(rad),
      R * Math.sin(rad),
      (R + len) * Math.cos(rad),
      (R + len) * Math.sin(rad),
      2.5,
      C.white,
    );
  }
  c.fillStyle = C.white;
  c.beginPath();
  c.moveTo(0, -R);
  c.lineTo(-11, -R - 18);
  c.lineTo(11, -R - 18);
  c.closePath();
  c.fill();
  c.rotate((-d.bank * Math.PI) / 180);
  const over = Math.abs(d.bank) > 35;
  c.fillStyle = over ? C.amber : C.white;
  c.beginPath();
  c.moveTo(0, -R + 2);
  c.lineTo(-12, -R + 22);
  c.lineTo(12, -R + 22);
  c.closePath();
  c.fill();
  // Slip: the trapezoid under the pointer slides.
  const sx = Math.max(-1, Math.min(1, d.slip)) * 24;
  c.fillRect(sx - 13, -R + 26, 26, 6);
  c.restore();
  // Flight director: a magenta command chevron at the commanded attitude.
  if (d.fd) {
    c.save();
    c.translate(AX, AY + (d.pitch - d.fd.pitch) * pitchScale(768));
    c.rotate(((d.fd.bank - d.bank) * Math.PI) / 180);
    c.fillStyle = C.magenta;
    c.strokeStyle = '#000';
    c.lineWidth = 1.5;
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(0, -4);
      c.lineTo(s * 150, 34);
      c.lineTo(s * 150, 44);
      c.lineTo(0, 8);
      c.closePath();
      c.fill();
      c.stroke();
    }
    c.restore();
  }
  // The aircraft symbol: a yellow delta outlined in black.
  c.save();
  c.translate(AX, AY);
  c.fillStyle = C.yellow;
  c.strokeStyle = '#000';
  c.lineWidth = 2;
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(s * 128, 36);
    c.lineTo(s * 96, 36);
    c.lineTo(0, 14);
    c.closePath();
    c.fill();
    c.stroke();
  }
  c.fillRect(-4, -4, 8, 8);
  c.restore();
  // Glide slope (or the GPS vertical path) on the right of the attitude.
  if (d.glide !== undefined) {
    const gx = 780;
    for (const k of [-2, -1, 1, 2]) {
      c.strokeStyle = C.white;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(gx, AY - k * 38, 6, 0, Math.PI * 2);
      c.stroke();
    }
    line(c, gx - 12, AY, gx + 12, AY, 2, C.white);
    const y = AY - Math.max(-1.2, Math.min(1.2, d.glide)) * 76;
    c.fillStyle = d.source === 'FMS' ? C.magenta : C.green;
    c.beginPath();
    c.moveTo(gx, y - 12);
    c.lineTo(gx + 9, y);
    c.lineTo(gx, y + 12);
    c.lineTo(gx - 9, y);
    c.closePath();
    c.fill();
    txt(c, d.source === 'FMS' ? 'V' : 'G', gx, 92, 18, c.fillStyle as string);
  }
  // Marker beacons.
  if (d.markers && Math.floor(d.time * 3) % 2 === 0) {
    const m = d.markers[0]!;
    const col = m === 'O' ? C.cyan : m === 'M' ? C.amber : C.white;
    rect(c, 230, 82, 40, 34, '#000');
    rect(c, 230, 82, 40, 34, col, 2.5);
    txt(c, m, 250, 100, 24, col);
  }
  // Radar altitude and minimums near the ground.
  const ra = formatRadarAltitude(d.radioAlt);
  if (ra) {
    const below = d.radioAlt !== undefined && d.radioAlt < d.minimums;
    rect(c, AX - 52, 472, 104, 36, 'rgba(0,0,0,0.65)');
    txt(c, ra, AX, 491, 28, below ? C.amber : C.green);
    if (below && Math.floor(d.time * 2) % 2 === 0) txt(c, 'MINIMUMS', AX, 446, 24, C.amber);
  }
  txt(c, `RA MIN ${Math.round(d.minimums)}`, 806, 548, 17, C.cyan, 'right');
}

function speedTape(c: Ctx, d: PfdData) {
  const x0 = 96;
  const x1 = 196;
  const y0 = 70;
  const y1 = 530;
  const ppk = 4.4;
  const ias = Math.max(d.ias, 20);
  const yOf = (kt: number) => AY - (kt - ias) * ppk;
  c.save();
  c.beginPath();
  c.rect(x0, y0, x1 - x0 + 14, y1 - y0);
  c.clip();
  rect(c, x0, y0, x1 - x0, y1 - y0, C.tape);
  for (let kt = Math.floor((ias - 60) / 5) * 5; kt <= ias + 60; kt += 5) {
    if (kt < 20) continue;
    const y = yOf(kt);
    const major = kt % 10 === 0;
    line(c, x1 - (major ? 18 : 10), y, x1, y, 2, C.white);
    if (major) txt(c, String(kt), x1 - 26, y, 23, C.white, 'right');
  }
  // Low-speed awareness: red below the stall speed, amber to 1.1 Vs.
  const vs = stallSpeed(d.flaps);
  rect(c, x1 - 6, yOf(vs), 7, Math.max(0, y1 - yOf(vs)), C.red);
  rect(c, x1 - 6, yOf(vs * 1.1), 7, yOf(vs) - yOf(vs * 1.1), C.amber);
  // The barber pole from the highest allowed speed upwards.
  const vmax = maxSpeed(d.ias, d.mach, d.flaps, d.gear);
  const top = yOf(vmax);
  if (top > y0) {
    for (let y = top; y > y0 - 12; y -= 12) {
      rect(c, x1 - 6, y - 12, 7, 6, C.red);
      rect(c, x1 - 6, y - 6, 7, 6, C.white);
    }
  }
  // Bugs on the right edge.
  const bug = (kt: number, label: string) => {
    const y = yOf(kt);
    line(c, x1, y, x1 + 12, y, 2, C.cyan);
    txt(c, label, x1 - 2, y - 11, 13, C.cyan, 'right');
  };
  if (d.ias < 140 && d.flaps < 0.3) {
    bug(PC12_SPEEDS.vr, 'R');
    bug(PC12_SPEEDS.vy, 'Y');
  } else if (d.flaps >= 0.3) bug(PC12_SPEEDS.vref, 'REF');
  if (d.selSpeed !== undefined) {
    const y = Math.max(y0 + 6, Math.min(y1 - 6, yOf(d.selSpeed)));
    c.fillStyle = C.cyan;
    c.fillRect(x1, y - 9, 10, 18);
  }
  // Trend vector: where the speed will be in six seconds.
  if (Math.abs(d.trend) > 2) {
    line(c, x1 - 3, AY, x1 - 3, yOf(ias + d.trend), 4, C.magenta);
  }
  c.restore();
  // Readout with the pointer.
  c.fillStyle = '#000';
  c.strokeStyle = C.white;
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(x0 + 2, AY - 22);
  c.lineTo(x1 - 14, AY - 22);
  c.lineTo(x1 - 14, AY - 9);
  c.lineTo(x1 - 2, AY);
  c.lineTo(x1 - 14, AY + 9);
  c.lineTo(x1 - 14, AY + 22);
  c.lineTo(x0 + 2, AY + 22);
  c.closePath();
  c.fill();
  c.stroke();
  const low = d.ias < stallSpeed(d.flaps) * 1.05 && d.ias > 30;
  const high = d.ias > maxSpeed(d.ias, d.mach, d.flaps, d.gear);
  txt(
    c,
    d.ias < 20 ? '---' : String(Math.round(d.ias)),
    x1 - 20,
    AY + 1,
    34,
    low || high ? C.red : C.white,
    'right',
  );
  // Selected speed above, TAS and Mach below.
  if (d.selSpeed !== undefined) txt(c, `${Math.round(d.selSpeed)}`, (x0 + x1) / 2, 50, 26, C.cyan);
  txt(c, `TAS ${Math.round(d.tas)}`, (x0 + x1) / 2, 548, 18, C.white);
  if (d.mach >= 0.3)
    txt(
      c,
      `M .${String(Math.round(d.mach * 1000)).padStart(3, '0')}`,
      (x0 + x1) / 2,
      570,
      18,
      C.white,
    );
  txt(c, `GS ${Math.round(d.gs)}`, (x0 + x1) / 2, d.mach >= 0.3 ? 592 : 570, 18, C.white);
}

function altitudeTape(c: Ctx, d: PfdData) {
  const x0 = 828;
  const x1 = 940;
  const y0 = 70;
  const y1 = 530;
  const ppf = 0.42;
  const yOf = (ft: number) => AY - (ft - d.alt) * ppf;
  c.save();
  c.beginPath();
  c.rect(x0 - 14, y0, x1 - x0 + 14, y1 - y0);
  c.clip();
  rect(c, x0, y0, x1 - x0, y1 - y0, C.tape);
  for (let ft = Math.floor((d.alt - 600) / 100) * 100; ft <= d.alt + 600; ft += 100) {
    const y = yOf(ft);
    const major = ft % 500 === 0;
    line(c, x0, y, x0 + (major ? 18 : 10), y, 2, C.white);
    if (major) txt(c, String(ft), x0 + 24, y, ft % 1000 === 0 ? 23 : 20, C.white, 'left');
  }
  // Ground below (radar altitude): an amber-brown band.
  if (d.radioAlt !== undefined && d.radioAlt < 600) {
    const g = yOf(d.alt - d.radioAlt);
    for (let y = g; y < y1; y += 10) line(c, x0, y, x0 + 30, y + 10, 3, '#b07a2a');
  }
  // Minimums as a cyan bug at the barometric height of the decision height.
  if (d.radioAlt !== undefined) {
    const y = yOf(d.alt - d.radioAlt + d.minimums);
    line(c, x0 - 12, y, x0 + 20, y, 3, C.cyan);
  }
  // Selected altitude bug.
  const sy = Math.max(y0 + 8, Math.min(y1 - 8, yOf(d.selAlt)));
  c.fillStyle = C.cyan;
  c.beginPath();
  c.moveTo(x0, sy - 14);
  c.lineTo(x0 + 10, sy - 14);
  c.lineTo(x0 + 10, sy - 5);
  c.lineTo(x0 + 3, sy);
  c.lineTo(x0 + 10, sy + 5);
  c.lineTo(x0 + 10, sy + 14);
  c.lineTo(x0, sy + 14);
  c.closePath();
  c.fill();
  c.restore();
  // Readout: thousands and hundreds fixed, the last two digits on a rolling drum.
  c.fillStyle = '#000';
  c.strokeStyle = C.white;
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(x0 - 10, AY);
  c.lineTo(x0 + 2, AY - 10);
  c.lineTo(x0 + 2, AY - 24);
  c.lineTo(x1 - 26, AY - 24);
  c.lineTo(x1 - 26, AY - 36);
  c.lineTo(x1 + 2, AY - 36);
  c.lineTo(x1 + 2, AY + 36);
  c.lineTo(x1 - 26, AY + 36);
  c.lineTo(x1 - 26, AY + 24);
  c.lineTo(x0 + 2, AY + 24);
  c.lineTo(x0 + 2, AY + 10);
  c.closePath();
  c.fill();
  c.stroke();
  const dg = altitudeDigits(d.alt);
  txt(c, dg.thousands, x0 + 52, AY + 1, 34, C.white, 'right');
  txt(c, dg.hundreds, x0 + 72, AY + 1, 28, C.white, 'right');
  c.save();
  c.beginPath();
  c.rect(x1 - 25, AY - 35, 27, 70);
  c.clip();
  const tens = dg.tens / 20;
  const base = Math.floor(tens);
  for (let k = -2; k <= 2; k++) {
    const v = (((base + k) % 5) + 5) % 5;
    const y = AY + (tens - (base + k)) * 26;
    txt(c, String(v * 20).padStart(2, '0'), x1 - 11, y, 22, C.white);
  }
  c.restore();
  // Selected altitude above, the baro setting below.
  rect(c, x0, 30, x1 - x0, 34, '#000');
  txt(c, formatSelectedAltitude(d.selAlt), (x0 + x1) / 2, 48, 26, C.cyan);
  txt(c, formatBaro(d.baro, d.std), (x0 + x1) / 2, 548, 20, C.cyan);
}

function vsi(c: Ctx, d: PfdData) {
  const x = 958;
  // Non-linear scale: 1000 ft/min at 90 px, 2000 at 140, 4000 at 180.
  const yOf = (fpm: number) => {
    const a = Math.min(Math.abs(fpm), 4000);
    const px = a <= 1000 ? a * 0.09 : a <= 2000 ? 90 + (a - 1000) * 0.05 : 140 + (a - 2000) * 0.02;
    return AY - Math.sign(fpm) * px;
  };
  rect(c, x - 8, AY - 190, 58, 380, 'rgba(40,46,54,0.6)');
  for (const f of [-4000, -2000, -1000, -500, 500, 1000, 2000, 4000]) {
    const y = yOf(f);
    line(c, x, y, x + (Math.abs(f) % 1000 === 0 ? 14 : 8), y, 2, C.white);
    if (Math.abs(f) >= 1000) txt(c, String(Math.abs(f) / 1000), x + 26, y, 17, C.white);
  }
  line(c, x - 6, AY, x + 16, AY, 2, C.white);
  // Selected VS in VS mode.
  if (d.modes.vertical === 'VS') {
    const y = yOf(d.selVs);
    rect(c, x - 6, y - 6, 12, 12, C.cyan);
  }
  const y = yOf(d.vs);
  line(c, x + 46, AY, x + 2, y, 3.5, C.white);
  const s = formatVs(d.vs);
  if (s) txt(c, s, x + 20, d.vs > 0 ? AY - 210 : AY + 210, 20, C.white);
}

function hsi(c: Ctx, d: PfdData) {
  const cx = AX;
  const cy = 800;
  const R = 225;
  const navColor = d.source === 'FMS' ? C.magenta : C.green;
  c.save();
  c.beginPath();
  c.rect(0, 556, 1024, 212);
  c.clip();
  c.fillStyle = 'rgba(40,46,54,0.7)';
  c.beginPath();
  c.arc(cx, cy, R + 4, 0, Math.PI * 2);
  c.fill();
  c.translate(cx, cy);
  c.save();
  c.rotate((-d.heading * Math.PI) / 180);
  for (let a = 0; a < 360; a += 5) {
    const rad = ((a - 90) * Math.PI) / 180;
    const len = a % 10 === 0 ? 20 : 11;
    line(
      c,
      R * Math.cos(rad),
      R * Math.sin(rad),
      (R - len) * Math.cos(rad),
      (R - len) * Math.sin(rad),
      2,
      C.white,
    );
    if (a % 30 === 0) {
      c.save();
      c.rotate((a * Math.PI) / 180);
      const lbl =
        a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a / 10);
      txt(c, lbl, 0, -R + 40, 24, C.white);
      c.restore();
    }
  }
  // Heading bug.
  c.save();
  c.rotate((d.hdgBug * Math.PI) / 180);
  c.fillStyle = C.cyan;
  c.beginPath();
  c.moveTo(-14, -R - 2);
  c.lineTo(-14, -R + 10);
  c.lineTo(-5, -R + 10);
  c.lineTo(0, -R + 4);
  c.lineTo(5, -R + 10);
  c.lineTo(14, -R + 10);
  c.lineTo(14, -R - 2);
  c.closePath();
  c.fill();
  c.restore();
  // Course pointer with the deviation bar.
  c.save();
  c.rotate((d.course * Math.PI) / 180);
  c.strokeStyle = navColor;
  c.fillStyle = navColor;
  c.lineWidth = 5;
  line(c, 0, -R + 26, 0, -105, 5, navColor);
  c.beginPath();
  c.moveTo(0, -R + 22);
  c.lineTo(-12, -R + 46);
  c.lineTo(12, -R + 46);
  c.closePath();
  c.fill();
  line(c, 0, 105, 0, R - 26, 5, navColor);
  for (const k of [-2, -1, 1, 2]) {
    c.strokeStyle = C.white;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(k * 34, 0, 6, 0, Math.PI * 2);
    c.stroke();
  }
  if (d.deviation !== undefined) {
    const dx = Math.max(-1.15, Math.min(1.15, d.deviation)) * 68;
    line(c, dx, -95, dx, 95, 5, navColor);
    if (d.toFrom !== 'off') {
      c.fillStyle = C.white;
      c.beginPath();
      const s = d.toFrom === 'to' ? -1 : 1;
      c.moveTo(dx + 30, s * 60);
      c.lineTo(dx + 20, s * 42);
      c.lineTo(dx + 40, s * 42);
      c.closePath();
      c.fill();
    }
  }
  c.restore();
  c.restore();
  // Aircraft symbol in the middle, lubber line at the top.
  c.fillStyle = C.white;
  c.fillRect(-3, -40, 6, 70);
  c.fillRect(-36, -12, 72, 6);
  c.fillRect(-14, 22, 28, 5);
  c.restore();
  c.fillStyle = C.white;
  c.beginPath();
  c.moveTo(cx, cy - R + 2);
  c.lineTo(cx - 10, cy - R - 16);
  c.lineTo(cx + 10, cy - R - 16);
  c.closePath();
  c.fill();
  rect(c, cx - 44, cy - R - 52, 88, 36, '#000');
  rect(c, cx - 44, cy - R - 52, 88, 36, C.white, 2);
  txt(c, formatBearing(d.heading).replace('°', ''), cx, cy - R - 33, 28, C.white);
  // Side readouts.
  txt(c, 'HDG', 214, 612, 19, C.white, 'left');
  txt(c, formatBearing(d.hdgBug), 270, 612, 22, C.cyan, 'left');
  txt(c, d.source, 214, 650, 22, navColor, 'left');
  txt(c, d.ident, 214, 680, 19, navColor, 'left');
  txt(c, 'CRS', 810, 612, 19, C.white, 'right');
  txt(c, formatBearing(d.course), 878, 612, 22, navColor, 'right');
  txt(c, `${formatDmeDistance(d.distance)} NM`, 878, 650, 22, C.white, 'right');
  if (d.deviation === undefined)
    txt(c, d.source === 'FMS' ? 'NO FMS' : 'NO NAV', 878, 680, 19, C.amber, 'right');
}

function fma(c: Ctx, d: PfdData) {
  const m = d.modes;
  rect(c, 0, 0, 1024, 30, '#000');
  const cell = (x: number, w: number, active: string, armed: string) => {
    line(c, x + w, 2, x + w, 28, 1.5, C.dim);
    if (active) txt(c, active, x + w * 0.32, 15, 22, C.green);
    if (armed) txt(c, armed, x + w * 0.74, 15, 19, C.white);
  };
  // The autopilot and yaw damper status in the middle, modes either side.
  cell(214, 220, m.lateral, m.lateralArmed);
  const apFlash = m.apWarning && Math.floor(d.time * 3) % 2 === 0;
  if (m.ap || apFlash) txt(c, 'AP', 470, 15, 22, apFlash ? C.amber : C.green);
  if (m.yd) txt(c, 'YD', 520, 15, 22, C.green);
  line(c, 576, 2, 576, 28, 1.5, C.dim);
  cell(576, 234, m.vertical, m.verticalArmed);
  if (m.vertical === 'VS')
    txt(c, `${d.selVs > 0 ? '+' : ''}${Math.round(d.selVs)}`, 760, 15, 18, C.cyan);
  if (m.vertical === 'FLC' && d.selSpeed !== undefined)
    txt(c, `${Math.round(d.selSpeed)} KT`, 770, 15, 18, C.cyan);
}

// =============================================================================================
// Engine indications and the moving map (MFD 1)

export interface EngineData {
  on: boolean;
  torque: number;
  itt: number;
  ng: number;
  np: number;
  oilP: number;
  oilT: number;
  ff: number;
  fuelL: number;
  fuelR: number;
  starting: boolean;
}

export interface MapData {
  on: boolean;
  range: number;
  heading: number;
  track: number;
  gs: number;
  lon: number;
  lat: number;
  plan: readonly Waypoint[];
  active: number;
  distance: number | undefined;
  stations: { ident: string; east: number; north: number }[];
  hdgBug: number;
}

/** Arc gauge: 210 degrees of sweep with the colour bands, a pointer and a digital box. */
function arcGauge(
  c: Ctx,
  x: number,
  y: number,
  r: number,
  v: number,
  l: GaugeLimits,
  label: string,
  unit: string,
  value: string,
) {
  const a0 = (150 * Math.PI) / 180;
  const sweep = (240 * Math.PI) / 180;
  const ang = (q: number) => a0 + sweep * Math.min(Math.max((q - l.min) / (l.max - l.min), 0), 1);
  const band = (from: number, to: number, color: string) => {
    c.strokeStyle = color;
    c.lineWidth = 7;
    c.beginPath();
    c.arc(x, y, r - 4, ang(from), ang(to));
    c.stroke();
  };
  c.strokeStyle = C.white;
  c.lineWidth = 2;
  c.beginPath();
  c.arc(x, y, r, a0, a0 + sweep);
  c.stroke();
  if (l.green) band(l.green[0], l.green[1], C.green);
  for (const [a, b] of l.amber ?? []) band(a, b, C.amber);
  for (const [a, b] of l.red ?? []) band(a, b, C.red);
  for (const q of l.redLine ?? []) {
    const t = ang(q);
    line(
      c,
      x + (r - 14) * Math.cos(t),
      y + (r - 14) * Math.sin(t),
      x + (r + 6) * Math.cos(t),
      y + (r + 6) * Math.sin(t),
      4,
      C.red,
    );
  }
  const t = ang(v);
  const zone = zoneColor(gaugeZone(v, l));
  c.fillStyle = zone;
  c.beginPath();
  c.moveTo(x + r * Math.cos(t), y + r * Math.sin(t));
  c.lineTo(x + 12 * Math.cos(t + 1.57), y + 12 * Math.sin(t + 1.57));
  c.lineTo(x + 12 * Math.cos(t - 1.57), y + 12 * Math.sin(t - 1.57));
  c.closePath();
  c.fill();
  rect(c, x - 4, y - 2, r + 10, 34, '#000');
  rect(c, x - 4, y - 2, r + 10, 34, C.dim, 1.5);
  txt(c, value, x + r + 2, y + 16, 28, zone === C.white ? C.white : zone, 'right');
  txt(c, label, x - r * 0.15, y + r * 0.55 + 4, 19, C.white, 'right');
  txt(c, unit, x + r * 0.95, y + r * 0.55 + 4, 14, C.grey, 'right');
}

function hBar(
  c: Ctx,
  x: number,
  y: number,
  w: number,
  v: number,
  l: GaugeLimits,
  label: string,
  value: string,
) {
  const px = (q: number) => x + w * Math.min(Math.max((q - l.min) / (l.max - l.min), 0), 1);
  txt(c, label, x, y - 16, 17, C.white, 'left');
  rect(c, x, y, w, 8, '#20262c');
  if (l.green) rect(c, px(l.green[0]), y, px(l.green[1]) - px(l.green[0]), 8, C.green);
  for (const [a, b] of l.amber ?? []) rect(c, px(a), y, px(b) - px(a), 8, C.amber);
  for (const [a, b] of l.red ?? []) rect(c, px(a), y, px(b) - px(a), 8, C.red);
  const zone = zoneColor(gaugeZone(v, l));
  c.fillStyle = C.white;
  c.beginPath();
  c.moveTo(px(v), y + 12);
  c.lineTo(px(v) - 7, y + 24);
  c.lineTo(px(v) + 7, y + 24);
  c.closePath();
  c.fill();
  txt(c, value, x + w, y - 16, 22, zone, 'right');
}

export function engineKey(e: EngineData): string {
  if (!e.on) return 'off';
  return [
    e.torque.toFixed(1),
    Math.round(e.itt),
    e.ng.toFixed(1),
    Math.round(e.np),
    Math.round(e.oilP),
    Math.round(e.oilT),
    Math.round(e.ff / 10),
    Math.round(e.fuelL / 5),
    Math.round(e.fuelR / 5),
    e.starting,
  ].join('|');
}

export function paintEngine(c: Ctx, w: number, h: number, e: EngineData) {
  c.fillStyle = '#05080b';
  c.fillRect(0, 0, w, h);
  if (!e.on) return;
  c.save();
  c.scale(w / 300, h / 768);
  line(c, 299, 0, 299, 768, 2, C.dim);
  const L = PC12_LIMITS;
  arcGauge(c, 120, 92, 70, e.torque, L.torque, 'TRQ', 'PSI', formatTorque(e.torque));
  arcGauge(c, 120, 248, 70, e.itt, L.itt, 'ITT', '°C', formatWhole(e.itt));
  arcGauge(c, 120, 404, 70, e.ng, L.ng, 'NG', '%', formatNg(e.ng));
  // Propeller speed as a number with its colour.
  const npZone = zoneColor(gaugeZone(e.np, L.np));
  txt(c, 'NP', 28, 520, 20, C.white, 'left');
  rect(c, 96, 502, 150, 36, '#000');
  rect(c, 96, 502, 150, 36, C.dim, 1.5);
  txt(c, formatWhole(e.np), 236, 521, 28, npZone, 'right');
  txt(c, 'RPM', 290, 521, 14, C.grey, 'right');
  hBar(c, 24, 586, 250, e.oilP, L.oilP, 'OIL PSI', formatWhole(e.oilP));
  hBar(c, 24, 640, 250, e.oilT, L.oilT, 'OIL °C', String(Math.round(e.oilT)));
  txt(c, 'FUEL LB', 24, 688, 17, C.white, 'left');
  txt(
    c,
    `${Math.round(e.fuelL / 5) * 5}`,
    140,
    688,
    22,
    e.fuelL < 150 ? C.amber : C.white,
    'right',
  );
  txt(
    c,
    `${Math.round(e.fuelR / 5) * 5}`,
    230,
    688,
    22,
    e.fuelR < 150 ? C.amber : C.white,
    'right',
  );
  txt(c, 'L', 154, 688, 15, C.grey, 'left');
  txt(c, 'R', 244, 688, 15, C.grey, 'left');
  txt(c, 'FF LB/H', 24, 726, 17, C.white, 'left');
  txt(c, `${Math.round(e.ff / 10) * 10}`, 230, 726, 22, C.white, 'right');
  if (e.starting) txt(c, 'START', 150, 20, 20, C.cyan);
  c.restore();
}

export function mapKey(m: MapData): string {
  if (!m.on) return 'off';
  const q = m.range / 300;
  return [
    m.plan.map((w) => w.ident).join(','),
    m.active,
    m.range,
    Math.round(m.lon / (q / 60)),
    Math.round(m.lat / (q / 60)),
    Math.round(m.track),
    Math.round(m.heading),
    Math.round(m.gs),
    m.distance?.toFixed(1) ?? '',
    m.stations
      .map((s) => `${s.ident}${Math.round(s.east / q)},${Math.round(s.north / q)}`)
      .join(';'),
    Math.round(m.hdgBug),
  ].join('|');
}

export function paintMap(c: Ctx, w: number, h: number, m: MapData) {
  c.fillStyle = '#04070b';
  c.fillRect(0, 0, w, h);
  if (!m.on) return;
  c.save();
  c.scale(w / 724, h / 768);
  const northUp = mapNorthUp(m.range);
  const cx = 362;
  const cy = northUp ? 400 : 560;
  const ring = northUp ? 300 : 460;
  const px = ring / m.range;
  const up = northUp ? 0 : m.track;
  c.save();
  c.beginPath();
  c.rect(0, 40, 724, 728);
  c.clip();
  // Range rings: full range and half range.
  c.strokeStyle = '#d0d4d8';
  c.setLineDash([8, 8]);
  c.lineWidth = 1.5;
  c.beginPath();
  c.arc(cx, cy, ring / 2, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  c.beginPath();
  c.arc(cx, cy, ring, 0, Math.PI * 2);
  c.stroke();
  txt(c, String(m.range / 2), cx - (ring / 2) * 0.72, cy - (ring / 2) * 0.72, 17, C.white);
  txt(c, String(m.range), cx - ring * 0.72, cy - ring * 0.72, 17, C.white);
  // Compass ticks round the outer ring (track-up: rotating with the track).
  c.save();
  c.translate(cx, cy);
  c.rotate((-up * Math.PI) / 180);
  for (let a = 0; a < 360; a += 10) {
    const r0 = ring - (a % 30 === 0 ? 14 : 7);
    const rad = ((a - 90) * Math.PI) / 180;
    line(
      c,
      r0 * Math.cos(rad),
      r0 * Math.sin(rad),
      ring * Math.cos(rad),
      ring * Math.sin(rad),
      2,
      '#d0d4d8',
    );
    if (a % 30 === 0) {
      c.save();
      c.rotate((a * Math.PI) / 180);
      txt(
        c,
        a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a / 10),
        0,
        -ring + 28,
        18,
        C.white,
      );
      c.restore();
    }
  }
  // Heading bug on the ring.
  c.save();
  c.rotate((m.hdgBug * Math.PI) / 180);
  c.fillStyle = C.cyan;
  c.fillRect(-10, -ring - 4, 20, 8);
  c.restore();
  c.restore();
  // The flight plan and stations, rotated into the map's frame.
  const rot = (-up * Math.PI) / 180;
  const at = (e: number, n: number): [number, number] => {
    const x = e * Math.cos(rot) - n * Math.sin(rot);
    const y = e * Math.sin(rot) + n * Math.cos(rot);
    return [cx + x * px, cy - y * px];
  };
  const pts = m.plan.map((wp) => {
    const o = mapOffsetNm(m.lon, m.lat, wp.lon, wp.lat);
    return at(o.east, o.north);
  });
  for (let i = 1; i < pts.length; i++) {
    const col = legColor(i, m.active);
    c.strokeStyle = col === 'magenta' ? C.magenta : col === 'grey' ? C.dim : C.white;
    c.lineWidth = col === 'magenta' ? 4 : 2.5;
    c.beginPath();
    c.moveTo(...pts[i - 1]!);
    c.lineTo(...pts[i]!);
    c.stroke();
  }
  pts.forEach(([x, y], i) => {
    const col = i === m.active ? C.magenta : C.white;
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(x, y - 9);
    c.lineTo(x + 3, y - 3);
    c.lineTo(x + 9, y);
    c.lineTo(x + 3, y + 3);
    c.lineTo(x, y + 9);
    c.lineTo(x - 3, y + 3);
    c.lineTo(x - 9, y);
    c.lineTo(x - 3, y - 3);
    c.closePath();
    c.fill();
    txt(c, m.plan[i]!.ident, x + 12, y - 12, 18, col, 'left');
  });
  for (const s of m.stations) {
    const [x, y] = at(s.east, s.north);
    c.strokeStyle = C.cyan;
    c.lineWidth = 2;
    c.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      const fn = k ? c.lineTo.bind(c) : c.moveTo.bind(c);
      fn(x + 10 * Math.cos(a), y + 10 * Math.sin(a));
    }
    c.closePath();
    c.stroke();
    c.fillStyle = C.cyan;
    c.fillRect(x - 2, y - 2, 4, 4);
    txt(c, s.ident, x + 14, y + 14, 17, C.cyan, 'left');
  }
  c.restore();
  // The aircraft (pointing along its heading; in track-up the map turns under it).
  c.save();
  c.translate(cx, cy);
  c.rotate(((m.heading - up) * Math.PI) / 180);
  c.fillStyle = C.white;
  c.strokeStyle = '#000';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(0, -18);
  c.lineTo(3, -6);
  c.lineTo(16, 2);
  c.lineTo(16, 6);
  c.lineTo(3, 2);
  c.lineTo(2, 12);
  c.lineTo(7, 16);
  c.lineTo(-7, 16);
  c.lineTo(-2, 12);
  c.lineTo(-3, 2);
  c.lineTo(-16, 6);
  c.lineTo(-16, 2);
  c.lineTo(-3, -6);
  c.closePath();
  c.fill();
  c.stroke();
  c.restore();
  // Header: orientation, track, ground speed, next waypoint.
  rect(c, 0, 0, 724, 40, '#0b1118');
  line(c, 0, 40, 724, 40, 1.5, C.dim);
  txt(c, northUp ? 'NORTH UP' : 'TRK UP', 14, 20, 18, C.white, 'left');
  txt(c, `TRK ${formatBearing(m.track)}`, 170, 20, 18, C.white, 'left');
  txt(c, `GS ${Math.round(m.gs)} KT`, 320, 20, 18, C.white, 'left');
  const wp = m.active >= 0 ? m.plan[m.active] : undefined;
  if (wp) {
    txt(c, wp.ident, 520, 20, 20, C.magenta, 'left');
    txt(c, `${formatDmeDistance(m.distance)} NM`, 710, 20, 18, C.white, 'right');
  }
  txt(c, `${m.range} NM`, 14, 752, 17, C.white, 'left');
  c.restore();
}

// =============================================================================================
// Systems synopsis and crew alerting (MFD 2)

export interface SynopticData {
  on: boolean;
  busVolts: number;
  amps: number;
  bat1: boolean;
  bat2: boolean;
  gen1: boolean;
  gen2: boolean;
  avionics: boolean;
  eps: number;
  fuelL: number;
  fuelR: number;
  pumpL: boolean;
  pumpR: boolean;
  firewall: boolean;
  ff: number;
  gear: number;
  gearDown: boolean;
  gearTransit: boolean;
  flaps: number;
  cabinAlt: number;
  cabinRate: number;
  diff: number;
  selCabin: number;
  dump: boolean;
  cas: CasMessage[];
}

export function synopticKey(s: SynopticData): string {
  if (!s.on) return 'off';
  return JSON.stringify([
    Math.round(s.busVolts * 2),
    Math.round(s.amps),
    s.bat1,
    s.bat2,
    s.gen1,
    s.gen2,
    s.avionics,
    s.eps,
    Math.round(s.fuelL / 5),
    Math.round(s.fuelR / 5),
    s.pumpL,
    s.pumpR,
    s.firewall,
    Math.round(s.ff / 10),
    Math.round(s.gear * 20),
    s.gearDown,
    s.gearTransit,
    Math.round(s.flaps * 80),
    Math.round(s.cabinAlt / 50),
    Math.round(s.cabinRate / 50),
    Math.round(s.diff * 10),
    s.selCabin,
    s.dump,
  ]);
}

function panelTitle(c: Ctx, s: string, x: number, y: number) {
  txt(c, s, x, y, 18, C.cyan, 'left');
  line(c, x, y + 13, x + 300, y + 13, 1, C.dim);
}

export function paintSynoptic(c: Ctx, w: number, h: number, s: SynopticData) {
  c.fillStyle = '#05080b';
  c.fillRect(0, 0, w, h);
  if (!s.on) return;
  c.save();
  c.scale(w / 700, h / 768);
  // --- electrical ---
  panelTitle(c, 'ELECTRICAL', 20, 24);
  const src = (x: number, y: number, label: string, on: boolean) => {
    rect(c, x, y, 70, 40, on ? '#0c2a12' : '#1a1d20');
    rect(c, x, y, 70, 40, on ? C.green : C.grey, 2);
    txt(c, label, x + 35, y + 20, 17, on ? C.green : C.grey);
  };
  src(24, 60, 'GEN 1', s.gen1);
  src(110, 60, 'GEN 2', s.gen2);
  src(196, 60, 'BAT 1', s.bat1);
  src(282, 60, 'BAT 2', s.bat2);
  for (const [x, on] of [
    [59, s.gen1],
    [145, s.gen2],
    [231, s.bat1],
    [317, s.bat2],
  ] as const)
    line(c, x, 100, x, 136, 3, on ? C.green : C.dim);
  const busOn = s.busVolts > 20;
  rect(c, 30, 136, 320, 12, busOn ? C.green : C.dim);
  txt(c, 'MAIN BUS', 190, 162, 15, C.white);
  txt(
    c,
    `${s.busVolts.toFixed(1)} V`,
    60,
    190,
    22,
    s.busVolts < 24 && s.busVolts > 0 ? C.amber : C.white,
    'left',
  );
  txt(c, `${Math.round(s.amps)} A`, 330, 190, 22, C.white, 'right');
  txt(
    c,
    `AVIONICS ${s.avionics ? 'ON' : 'OFF'}`,
    60,
    222,
    17,
    s.avionics ? C.green : C.amber,
    'left',
  );
  txt(
    c,
    `EPS ${['OFF', 'ARMED', 'TEST'][Math.round(s.eps)] ?? ''}`,
    330,
    222,
    17,
    s.eps >= 0.5 ? C.green : C.amber,
    'right',
  );
  // --- fuel ---
  panelTitle(c, 'FUEL', 370, 24);
  const tank = (x: number, lb: number, label: string, pump: boolean) => {
    const full = 1352;
    rect(c, x, 60, 110, 130, '#11161b');
    rect(c, x, 60, 110, 130, C.white, 2);
    const k = Math.min(Math.max(lb / full, 0), 1);
    rect(c, x + 3, 187 - 124 * k, 104, 124 * k, lb < 150 ? '#5a3d00' : '#0b3e62');
    txt(c, `${Math.round(lb / 5) * 5}`, x + 55, 110, 24, lb < 150 ? C.amber : C.white);
    txt(c, 'LB', x + 55, 136, 14, C.grey);
    txt(c, label, x + 55, 172, 16, C.white);
    txt(c, pump ? 'PUMP ON' : 'PUMP AUTO', x + 55, 210, 15, pump ? C.green : C.grey);
  };
  tank(380, s.fuelL, 'LEFT', s.pumpL);
  tank(540, s.fuelR, 'RIGHT', s.pumpR);
  txt(
    c,
    s.firewall ? 'FIREWALL OPEN' : 'FIREWALL SHUT',
    545,
    238,
    16,
    s.firewall ? C.green : C.amber,
  );
  txt(c, `FF ${Math.round(s.ff / 10) * 10} LB/H`, 545, 262, 16, C.white);
  // --- gear and flaps ---
  panelTitle(c, 'GEAR  FLAPS', 20, 300);
  const gearBox = (x: number, y: number, label: string) => {
    const col = s.gearDown ? C.green : s.gearTransit ? C.red : C.white;
    rect(c, x, y, 64, 44, s.gearDown ? '#0c2a12' : s.gearTransit ? '#3a0808' : '#1a1d20');
    rect(c, x, y, 64, 44, col, 2);
    txt(c, s.gearDown ? 'DN' : s.gearTransit ? '' : 'UP', x + 32, y + 22, 20, col);
    if (s.gearTransit) {
      c.save();
      c.beginPath();
      c.rect(x, y, 64, 44);
      c.clip();
      for (let k = -50; k < 64; k += 12) line(c, x + k, y + 44, x + k + 44, y, 4, C.red);
      c.restore();
    }
    txt(c, label, x + 32, y + 58, 14, C.grey);
  };
  gearBox(130, 334, 'NOSE');
  gearBox(50, 400, 'LEFT');
  gearBox(210, 400, 'RIGHT');
  // Flap scale.
  const fx = 50;
  const fy = 500;
  txt(c, 'FLAPS', fx, fy - 22, 16, C.white, 'left');
  rect(c, fx, fy, 230, 10, '#20262c');
  for (const [deg, lbl] of [
    [0, '0'],
    [15, '15'],
    [30, '30'],
    [40, '40'],
  ] as const) {
    const x = fx + (deg / 40) * 230;
    line(c, x, fy - 4, x, fy + 14, 2, C.white);
    txt(c, lbl, x, fy + 30, 15, C.white);
  }
  const fxv = fx + s.flaps * 230;
  c.fillStyle = C.cyan;
  c.beginPath();
  c.moveTo(fxv, fy + 5);
  c.lineTo(fxv - 9, fy - 12);
  c.lineTo(fxv + 9, fy - 12);
  c.closePath();
  c.fill();
  txt(c, `${Math.round(s.flaps * 40)}°`, fx + 260, fy + 6, 22, C.white, 'left');
  // --- pressurisation ---
  panelTitle(c, 'PRESSURIZATION', 370, 300);
  const row = (y: number, k: string, v: string, col: string = C.white) => {
    txt(c, k, 380, y, 17, C.grey, 'left');
    txt(c, v, 660, y, 22, col, 'right');
  };
  row(
    350,
    'CAB ALT',
    `${Math.round(s.cabinAlt / 50) * 50} FT`,
    s.cabinAlt > 10000 ? C.red : C.white,
  );
  row(390, 'RATE', `${s.cabinRate >= 0 ? '+' : ''}${Math.round(s.cabinRate / 50) * 50} FPM`);
  row(430, 'DIFF', `${s.diff.toFixed(1)} PSI`, s.diff > 5.75 ? C.red : C.white);
  row(470, 'SEL', `${Math.round(s.selCabin)} FT`, C.cyan);
  row(510, 'MODE', s.dump ? 'DUMP' : 'AUTO', s.dump ? C.amber : C.green);
  c.restore();
}

export function casKey(cas: CasMessage[], on: boolean): string {
  return on ? cas.map((m) => `${m.level[0]}${m.text}`).join(';') : 'off';
}

export function paintCas(c: Ctx, w: number, h: number, cas: CasMessage[], on: boolean) {
  c.fillStyle = '#000';
  c.fillRect(0, 0, w, h);
  if (!on) return;
  c.save();
  c.scale(w / 324, h / 768);
  line(c, 1, 0, 1, 768, 2, C.dim);
  txt(c, 'CAS', 20, 24, 18, C.cyan, 'left');
  line(c, 14, 40, 310, 40, 1, C.dim);
  cas.slice(0, 22).forEach((m, i) => {
    const y = 66 + i * 31;
    const col = m.level === 'warning' ? C.red : m.level === 'caution' ? C.amber : C.white;
    if (m.level === 'warning') rect(c, 14, y - 14, 296, 28, '#3a0505');
    txt(c, m.text, 24, y, 22, col, 'left');
  });
  if (cas.length > 22) txt(c, `+${cas.length - 22} MORE`, 160, 752, 16, C.grey);
  c.restore();
}

// =============================================================================================
// Panel windows: radios, standby instrument, gear lights, FGP legends, trims

export type PanelWindowId =
  'COM1' | 'NAV1' | 'COM2' | 'NAV2' | 'ADF' | 'DME' | 'XPDR' | 'STBY' | 'GEAR' | 'FGP' | 'TRIM';

export interface PanelWindowData {
  radio: PanelData;
  stby: { on: boolean; pitch: number; bank: number; ias: number; alt: number; baro: number };
  gear: { down: boolean; transit: boolean; on: boolean };
  fgp: { on: boolean; lamps: Record<string, boolean> };
  trim: { pitch: number; roll: number; yaw: number; on: boolean };
  avionics: AvionicsTelemetry | undefined;
  systems: SystemsTelemetry | undefined;
}

/** FGP keys and knobs: canvas x of their centre (share of the width) and their legend. */
export const FGP_LEGENDS: readonly [string, number, string][] = [
  ['hdgKnob', 0.068, 'HDG'],
  ['apHdg', 0.169, 'HDG'],
  ['apNav', 0.234, 'NAV'],
  ['apApr', 0.298, 'APR'],
  ['apEngage', 0.411, 'AP'],
  ['yawDamper', 0.476, 'YD'],
  ['flightDirector', 0.54, 'FD'],
  ['apAlt', 0.653, 'ALT'],
  ['apVs', 0.718, 'VS'],
  ['apFlc', 0.782, 'FLC'],
  ['pitch', 0.863, 'UP  DN'],
  ['altKnob', 0.948, 'ALT SEL'],
];

export const PANEL_WINDOW_REGIONS: Record<
  PanelWindowId,
  { x: number; y: number; w: number; h: number }
> = {
  COM1: { x: 0, y: 0, w: 300, h: 78 },
  NAV1: { x: 300, y: 0, w: 300, h: 78 },
  COM2: { x: 600, y: 0, w: 300, h: 78 },
  NAV2: { x: 0, y: 78, w: 300, h: 78 },
  ADF: { x: 300, y: 78, w: 384, h: 72 },
  DME: { x: 0, y: 156, w: 420, h: 72 },
  XPDR: { x: 420, y: 156, w: 394, h: 72 },
  FGP: { x: 0, y: 228, w: 1024, h: 96 },
  STBY: { x: 0, y: 324, w: 256, h: 256 },
  GEAR: { x: 256, y: 324, w: 128, h: 192 },
  TRIM: { x: 384, y: 324, w: 256, h: 96 },
};

function windowKey(id: PanelWindowId, d: PanelWindowData): string {
  switch (id) {
    case 'STBY': {
      const s = d.stby;
      if (!s.on) return 'off';
      return [
        Math.round(s.pitch * 2),
        Math.round(s.bank),
        Math.round(s.ias),
        Math.round(s.alt / 10),
        Math.round(s.baro),
      ].join('|');
    }
    case 'GEAR':
      return d.gear.on ? `${d.gear.down}|${d.gear.transit}` : 'off';
    case 'FGP':
      return `${d.fgp.on}|${Object.entries(d.fgp.lamps)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(',')}`;
    case 'TRIM':
      return d.trim.on
        ? [d.trim.pitch, d.trim.roll, d.trim.yaw].map((v) => Math.round(v * 50)).join('|')
        : 'off';
    default:
      return radioContent(id, d.radio);
  }
}

function paintStandby(c: Ctx, w: number, h: number, s: PanelWindowData['stby']) {
  c.fillStyle = '#000';
  c.fillRect(0, 0, w, h);
  if (!s.on) return;
  c.save();
  c.scale(w / 256, h / 256);
  c.save();
  c.beginPath();
  c.rect(52, 30, 152, 170);
  c.clip();
  c.translate(128, 115);
  c.rotate((-s.bank * Math.PI) / 180);
  c.translate(0, s.pitch * 3.2);
  c.fillStyle = C.sky;
  c.fillRect(-300, -300, 600, 300);
  c.fillStyle = C.ground;
  c.fillRect(-300, 0, 600, 300);
  line(c, -300, 0, 300, 0, 2, C.white);
  for (const p of [-20, -10, 10, 20]) line(c, -20, -p * 3.2, 20, -p * 3.2, 1.5, C.white);
  c.restore();
  c.fillStyle = C.yellow;
  c.fillRect(88, 113, 26, 5);
  c.fillRect(142, 113, 26, 5);
  c.fillRect(125, 112, 6, 6);
  // Speed and altitude as numbers either side.
  rect(c, 0, 96, 52, 38, '#000');
  txt(c, String(Math.round(s.ias)), 48, 115, 26, C.white, 'right');
  rect(c, 204, 96, 52, 38, '#000');
  txt(c, String(Math.round(s.alt / 10) * 10), 254, 115, 21, C.white, 'right');
  txt(c, 'KT', 26, 150, 14, C.grey);
  txt(c, 'FT', 230, 150, 14, C.grey);
  txt(c, `${Math.round(s.baro)} HPA`, 128, 228, 18, C.cyan);
  c.restore();
}

function paintGear(c: Ctx, w: number, h: number, g: PanelWindowData['gear']) {
  c.fillStyle = '#060606';
  c.fillRect(0, 0, w, h);
  const lamp = (x: number, y: number, on: boolean) => {
    c.fillStyle = on ? '#28ff52' : '#0b1a0d';
    c.beginPath();
    c.arc(x, y, w * 0.15, 0, Math.PI * 2);
    c.fill();
  };
  const on = g.on && g.down;
  lamp(w * 0.5, h * 0.2, on);
  lamp(w * 0.24, h * 0.44, on);
  lamp(w * 0.76, h * 0.44, on);
  c.fillStyle = g.on && g.transit ? '#ff2a1a' : '#200806';
  c.fillRect(w * 0.12, h * 0.66, w * 0.76, h * 0.2);
  txt(c, 'UNSAFE', w * 0.5, h * 0.76, h * 0.085, g.on && g.transit ? '#2a0000' : '#3a1410');
}

function paintFgp(c: Ctx, w: number, h: number, f: PanelWindowData['fgp']) {
  c.fillStyle = '#1a1c1f';
  c.fillRect(0, 0, w, h);
  for (const [id, x, label] of FGP_LEGENDS) {
    const lit = f.on && f.lamps[id];
    txt(c, label, x * w, h * 0.17, h * 0.17, '#e6e6e0');
    if (id.startsWith('ap') || id === 'yawDamper' || id === 'flightDirector') {
      c.fillStyle = lit ? '#3dff6a' : '#0e1a10';
      c.fillRect(x * w - w * 0.012, h * 0.3, w * 0.024, h * 0.08);
    }
  }
}

function paintTrim(c: Ctx, w: number, h: number, t: PanelWindowData['trim']) {
  c.fillStyle = '#0a0b0c';
  c.fillRect(0, 0, w, h);
  if (!t.on) return;
  const bar = (x: number, y: number, len: number, v: number, vertical: boolean, label: string) => {
    c.fillStyle = '#3a3f44';
    if (vertical) c.fillRect(x - 2, y, 4, len);
    else c.fillRect(x, y - 2, len, 4);
    // Take-off range in green on the pitch scale.
    if (vertical) {
      c.fillStyle = '#1f9c3a';
      c.fillRect(x - 4, y + len * 0.4, 8, len * 0.25);
    }
    const p = (Math.max(-1, Math.min(1, v)) + 1) / 2;
    c.fillStyle = '#f0f0ea';
    if (vertical) c.fillRect(x - 10, y + len * (1 - p) - 2, 20, 5);
    else c.fillRect(x + len * p - 2, y - 10, 5, 20);
    txt(
      c,
      label,
      vertical ? x : x + len / 2,
      vertical ? y + len + 10 : y + 22,
      h * 0.15,
      '#c8ccd0',
    );
  };
  bar(w * 0.12, h * 0.08, h * 0.7, t.pitch, true, 'PITCH');
  bar(w * 0.3, h * 0.38, w * 0.28, t.roll, false, 'AIL');
  bar(w * 0.66, h * 0.38, w * 0.28, t.yaw, false, 'RUD');
}

export const PANEL_PAINTER: AtlasPainter<PanelWindowId, PanelWindowData> = {
  width: 1024,
  height: 640,
  regions: PANEL_WINDOW_REGIONS,
  content: windowKey,
  paint(c, id, w, h, key, d) {
    switch (id) {
      case 'STBY':
        paintStandby(c, w, h, d.stby);
        break;
      case 'GEAR':
        paintGear(c, w, h, d.gear);
        break;
      case 'FGP':
        paintFgp(c, w, h, d.fgp);
        break;
      case 'TRIM':
        paintTrim(c, w, h, d.trim);
        break;
      default:
        radioPaint(c, id, w, h, key, d.radio);
    }
  },
  throttled: ['STBY'],
  background: '#030303',
};
