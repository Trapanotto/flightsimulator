/**
 * The F/A-18C's displays painted into canvases: the head-up display (navigation and landing
 * modes), the two digital display indicators (green monochrome pages: horizontal situation,
 * flight control system, engines, attitude, checklist, fuel), the multi-purpose colour display
 * (moving-map horizontal situation, fuel, engines), and the panel's small windows (the up-front
 * control's scratchpad, option windows and COMM channels, the fuel and engine indicator, the
 * standby instruments, the radar altimeter, the caution lights, the angle-of-attack indexer,
 * master caution, gear and hook lights, the NAV and IFF windows).
 *
 * Each window repaints only when its key (the values it shows, rounded to what a pixel can
 * show) changes; the head-up display is drawn every frame its picture changes.
 */
import type { Waypoint } from '@sim';
import type { AtlasPainter } from './canvasAtlas';
import { formatFrequency, formatSquawk, mapOffsetNm } from './avionicsFormat';
import {
  type Fa18Surfaces,
  type HudGeometry,
  type PanelWindowId,
  ON_SPEED,
  earthToBody,
  hudPixelsPerDegree,
  hudProject,
} from './fa18Parts';

type Ctx = CanvasRenderingContext2D;
const DEG = Math.PI / 180;
const MONO = '"Consolas", "Lucida Console", "Courier New", monospace';
const SANS = '"Segoe UI", "Bahnschrift", "Arial Narrow", Arial, sans-serif';
/** DDI green: the monochrome displays' phosphor. */
const G = '#5dff7a';
const GD = '#2a8f3c';
const C = {
  white: '#f0f2f2',
  cyan: '#38dcff',
  magenta: '#ff4cf2',
  green: '#3cf05a',
  amber: '#ffb400',
  red: '#ff3030',
  yellow: '#ffe21a',
  grey: '#7d8488',
};

// =============================================================================================
// What the flight control system will report for the head-up display (not yet in the sim).

export type IndexerState = 'off' | 'fast' | 'slightlyFast' | 'onSpeed' | 'slightlySlow' | 'slow';

/**
 * The F/A-18 block of the avionics under `telemetry.avionics.fa18` (Fa18HudTelemetry in the
 * sim on main), read defensively: every field may be missing, and what is missing is derived
 * from the plain telemetry. SI units, radians unless the comment says degrees.
 * `surfaces` and `fcsFailed` are not in the sim's block yet: proposed for the FCS page.
 */
export interface Fa18AvionicsBlock {
  /** Velocity vector: flight path angle (up positive) and drift (track right of heading). */
  flightPath?: number;
  drift?: number;
  alpha?: number;
  /** Approach indexer, only with the gear down and airborne. */
  onSpeed?: Exclude<IndexerState, 'off'>;
  g?: number;
  peakG?: number;
  gLimit?: number;
  mach?: number;
  /** Indicated airspeed (m/s), barometric altitude (m), vertical velocity (m/s). */
  airspeed?: number;
  altitude?: number;
  verticalVelocity?: number;
  /** Radar altitude (m); undefined above 5000 ft or beyond 60 degrees of bank or pitch. */
  radarAltitude?: number;
  radarAltitudeShown?: boolean;
  /** Degrees; heading magnetic. */
  bank?: number;
  pitch?: number;
  heading?: number;
  steering?: {
    source: 'wypt' | 'tacan' | 'ils';
    valid: boolean;
    /** Degrees magnetic. */
    bearing: number;
    rangeNm: number;
    minutes?: number;
  };
  /** ILS needles -1..1 (fly towards them). */
  ils?: { localizer?: number; glideSlope?: number };
  ilsOn?: boolean;
  flapMode?: 'auto' | 'half' | 'full';
  trailingEdgeFlap?: number;
  leadingEdgeFlap?: number;
  gear?: 'up' | 'transit' | 'down';
  fcsMode?: 'ua' | 'pa' | 'spin' | 'mech';
  cautions?: readonly string[];
  advisories?: readonly string[];
  /** Autopilot modes as the UFC and HUD show them: ATT, HSEL, BALT, RALT, CPL WYPT, ATC ... */
  modes?: readonly string[];
  /** Fuel and bingo setting (kg), bingo reached. */
  fuel?: number;
  bingoSetting?: number;
  bingo?: boolean;
  fuelDumping?: boolean;
  apu?: 'off' | 'starting' | 'ready';
  /** Canopy and hook positions 0..1. */
  canopy?: number;
  hook?: number;
  nosewheelSteering?: 'off' | 'low' | 'high';
  /** Proposed: surface positions in degrees, and the failed FCS channels (1..4). */
  surfaces?: Partial<Fa18Surfaces>;
  fcsFailed?: readonly number[];
}

// =============================================================================================
// Formatting (tested)

/** Heading on the tape: three digits, 360 for north. */
export function formatHeading(deg: number): string {
  const h = Math.round(((deg % 360) + 360) % 360);
  return String(h === 0 ? 360 : h).padStart(3, '0');
}

/** The HUD's altitude box: thousands with a comma, the last digits to 10 ft below 1000 ft AGL. */
export function formatHudAltitude(ft: number): string {
  const a = Math.round(ft / 10) * 10;
  const s = Math.abs(a);
  const t = Math.floor(s / 1000);
  const r = String(s % 1000).padStart(3, '0');
  return `${a < 0 ? '-' : ''}${t > 0 ? `${t},${r}` : String(s % 1000)}`;
}

export function formatMach(m: number): string {
  return m.toFixed(2).replace(/^0/, '');
}

export function formatG(g: number): string {
  return g.toFixed(1);
}

/** Time to go as minutes:seconds (or hours:minutes beyond an hour). */
export function formatTimeToGo(s: number | undefined): string {
  if (s === undefined || !Number.isFinite(s) || s < 0) return '--:--';
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}H`;
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Fuel in pounds on the IFEI: to the nearest 10 lb. */
export function formatFuelLb(lb: number): string {
  return String(Math.max(0, Math.round(lb / 10) * 10));
}

// =============================================================================================
// Shared drawing

function txt(
  c: Ctx,
  s: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'center',
  font = MONO,
  weight = 600,
) {
  c.fillStyle = color;
  c.font = `${weight} ${size}px ${font}`;
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

function boxed(c: Ctx, x: number, y: number, w: number, h: number, lw: number, color: string) {
  c.strokeStyle = color;
  c.lineWidth = lw;
  c.strokeRect(x - w / 2, y - h / 2, w, h);
}

const wrap360 = (d: number) => ((d % 360) + 360) % 360;
const delta = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

// =============================================================================================
// Head-up display

export interface HudData {
  on: boolean;
  /** Degrees. */
  pitch: number;
  bank: number;
  /** Magnetic heading, degrees. */
  heading: number;
  ias: number;
  mach: number;
  g: number;
  peakG: number;
  /** Angle of attack, degrees. */
  alpha: number;
  /** Altitude to show, ft, and whether it is the radar altitude (the R). */
  alt: number;
  radar: boolean;
  /** Vertical velocity, ft/min. */
  vv: number;
  /** Velocity vector: flight path angle and drift, degrees. */
  fpa: number;
  drift: number;
  /** Landing mode (gear down): AOA bracket, ILS needles, water line. */
  landing: boolean;
  steering?: { ident: string; bearing: number; rangeNm: number; timeToGo?: number };
  ils?: { localizer?: number; glideSlope?: number };
  hdgBug: number;
  cautions: readonly string[];
  bingo: boolean;
}

/** Key of the HUD picture, rounded to what its pixels show. */
export function hudKey(d: HudData): string {
  if (!d.on) return 'off';
  const r = (v: number, k: number) => Math.round(v * k);
  return [
    r(d.pitch, 8),
    r(d.bank, 4),
    r(d.heading, 4),
    r(d.ias, 1),
    r(d.mach, 100),
    r(d.g, 10),
    r(d.peakG, 10),
    r(d.alpha, 10),
    r(d.alt, 0.1),
    d.radar,
    r(d.vv, 0.1),
    r(d.fpa, 8),
    r(d.drift, 8),
    d.landing,
    d.steering
      ? `${d.steering.ident}${r(d.steering.bearing, 1)}/${r(d.steering.rangeNm, 10)}/${r(d.steering.timeToGo ?? -1, 1)}`
      : '',
    d.ils ? `${r(d.ils.localizer ?? 9, 100)}/${r(d.ils.glideSlope ?? 9, 100)}` : '',
    r(d.hdgBug, 1),
    d.cautions.join(','),
    d.bingo,
  ].join('|');
}

/**
 * The head-up display as the F/A-18's shows it, drawn for the eye point: the velocity vector,
 * the pitch ladder centred on it (bars bent towards the horizon by half their angle, dashed
 * below the horizon), heading tape, airspeed and altitude boxes, vertical velocity, bank
 * scale, angle of attack, Mach, g and peak g, steering data; in the landing mode the water
 * line, the on-speed bracket and the ILS needles. Transparent background (additive).
 */
export function paintHud(c: Ctx, w: number, h: number, d: HudData, geom: HudGeometry) {
  c.clearRect(0, 0, w, h);
  if (!d.on) return;
  const size = { w, h };
  const k = w / 512;
  const col = '#ffffff';
  const lw = 2.2 * k;
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = col;
  c.fillStyle = col;
  // Everything stays in the combiner's rounded field.
  c.beginPath();
  c.roundRect(4 * k, 4 * k, w - 8 * k, h - 8 * k, 40 * k);
  c.clip();
  const proj = (azDeg: number, elDeg: number) => {
    const [f, r, u] = earthToBody(azDeg * DEG, elDeg * DEG, d.pitch * DEG, d.bank * DEG);
    return hudProject(geom, size, f, r, u);
  };
  const body = (rightDeg: number, upDeg: number) =>
    hudProject(geom, size, 1, Math.tan(rightDeg * DEG), Math.tan(upDeg * DEG));
  const ppd = hudPixelsPerDegree(geom, h);
  // --- velocity vector ---
  const vv = proj(d.drift, d.fpa);
  if (vv) {
    const r = 7 * k;
    c.lineWidth = lw;
    c.beginPath();
    c.arc(vv.x, vv.y, r, 0, Math.PI * 2);
    c.stroke();
    line(c, vv.x - r, vv.y, vv.x - r - 11 * k, vv.y, lw, col);
    line(c, vv.x + r, vv.y, vv.x + r + 11 * k, vv.y, lw, col);
    line(c, vv.x, vv.y - r, vv.x, vv.y - r - 8 * k, lw, col);
  }
  // --- pitch ladder, centred on the velocity vector's azimuth ---
  const pitchMin = Math.floor((d.pitch - 14) / 5) * 5;
  for (let e = pitchMin; e <= d.pitch + 14; e += 5) {
    if (e < -90 || e > 90) continue;
    const p = proj(d.drift, e);
    const p2 = proj(d.drift + 0.5, e);
    if (!p || !p2) continue;
    let dx = p2.x - p.x;
    let dy = p2.y - p.y;
    const n = Math.hypot(dx, dy) || 1;
    dx /= n;
    dy /= n;
    if (e === 0) {
      // The horizon: a long line with a gap round the centre.
      for (const s of [-1, 1]) {
        line(
          c,
          p.x + s * dx * 26 * k,
          p.y + s * dy * 26 * k,
          p.x + s * dx * 210 * k,
          p.y + s * dy * 210 * k,
          lw,
          col,
        );
      }
      continue;
    }
    const half = 52 * k;
    const gap = 20 * k;
    // Bent towards the horizon by half the pitch angle.
    const bend = (-Math.sign(e) * Math.min(Math.abs(e), 90) * DEG) / 2;
    for (const s of [-1, 1]) {
      const ax = dx * Math.cos(bend * s) - dy * Math.sin(bend * s);
      const ay = dx * Math.sin(bend * s) + dy * Math.cos(bend * s);
      const x0 = p.x + s * dx * gap;
      const y0 = p.y + s * dy * gap;
      const x1 = x0 + s * ax * (half - gap);
      const y1 = y0 + s * ay * (half - gap);
      c.setLineDash(e < 0 ? [8 * k, 6 * k] : []);
      line(c, x0, y0, x1, y1, lw, col);
      c.setLineDash([]);
      // End ticks point to the horizon.
      const tx = -dy * Math.sign(e) * -1;
      const ty = dx * Math.sign(e) * -1;
      line(c, x0, y0, x0 + tx * 8 * k, y0 + ty * 8 * k, lw, col);
      const lx = x1 + s * ax * 16 * k;
      const ly = y1 + s * ay * 16 * k;
      txt(c, String(Math.abs(e)), lx, ly, 20 * k, col);
    }
  }
  // --- heading tape at the top ---
  const tapeY = 40 * k;
  const pxPerDeg = 6.2 * k;
  c.save();
  c.beginPath();
  c.rect(w / 2 - 130 * k, tapeY - 26 * k, 260 * k, 52 * k);
  c.clip();
  const h0 = Math.floor((d.heading - 25) / 5) * 5;
  for (let hd = h0; hd <= d.heading + 25; hd += 5) {
    const x = w / 2 + (hd - d.heading) * pxPerDeg;
    const major = wrap360(hd) % 10 === 0;
    line(c, x, tapeY + 12 * k, x, tapeY + (major ? 2 : 7) * k, lw * 0.85, col);
    if (major)
      txt(
        c,
        String(Math.round(wrap360(hd) / 10) || 36).padStart(2, '0'),
        x,
        tapeY - 8 * k,
        14 * k,
        col,
      );
  }
  // Steering caret (waypoint or course) under the tape.
  const steer = d.steering?.bearing ?? d.hdgBug;
  const sx = w / 2 + Math.max(-120, Math.min(120, (delta(d.heading, steer) * pxPerDeg) / k)) * k;
  c.beginPath();
  c.moveTo(sx, tapeY + 14 * k);
  c.lineTo(sx - 6 * k, tapeY + 24 * k);
  c.lineTo(sx + 6 * k, tapeY + 24 * k);
  c.closePath();
  c.lineWidth = lw * 0.8;
  c.stroke();
  c.restore();
  line(c, w / 2, tapeY + 14 * k, w / 2, tapeY + 26 * k, lw, col);
  // --- airspeed and altitude boxes ---
  const boxY = h / 2 - 20 * k;
  boxed(c, w / 2 - 150 * k, boxY, 66 * k, 26 * k, lw * 0.8, col);
  txt(c, String(Math.round(d.ias)), w / 2 - 150 * k, boxY + 1 * k, 25 * k, col);
  boxed(c, w / 2 + 150 * k, boxY, 84 * k, 26 * k, lw * 0.8, col);
  txt(
    c,
    formatHudAltitude(d.alt),
    w / 2 + 150 * k + (d.radar ? -6 : 0) * k,
    boxY + 1 * k,
    19 * k,
    col,
  );
  if (d.radar) txt(c, 'R', w / 2 + 202 * k, boxY + 1 * k, 22 * k, col);
  txt(c, String(Math.round(d.vv / 10) * 10), w / 2 + 150 * k, boxY - 28 * k, 20 * k, col);
  // --- left column: angle of attack, Mach, g, peak g ---
  const lx = w / 2 - 172 * k;
  txt(c, `α ${d.alpha.toFixed(1)}`, lx, h / 2 + 40 * k, 20 * k, col, 'left');
  txt(c, `M ${formatMach(d.mach)}`, lx, h / 2 + 62 * k, 20 * k, col, 'left');
  txt(c, `G ${formatG(d.g)}`, lx, h / 2 + 84 * k, 20 * k, col, 'left');
  txt(c, formatG(d.peakG), lx + 24 * k, h / 2 + 106 * k, 20 * k, col, 'left');
  // --- right column: steering data ---
  if (d.steering) {
    const rx = w / 2 + 112 * k;
    txt(c, `${d.steering.ident}`, rx, h / 2 + 62 * k, 20 * k, col, 'left');
    txt(c, `${d.steering.rangeNm.toFixed(1)}`, rx, h / 2 + 84 * k, 20 * k, col, 'left');
    txt(c, formatTimeToGo(d.steering.timeToGo), rx, h / 2 + 106 * k, 20 * k, col, 'left');
  }
  // --- bank scale at the bottom, pointer for the bank ---
  const bc = body(0, -8.5);
  if (bc) {
    const R = 70 * k;
    for (const a of [-45, -30, -20, -10, -5, 0, 5, 10, 20, 30, 45]) {
      const t = (90 + a) * DEG;
      const len = a % 10 === 0 || Math.abs(a) === 45 ? 9 : 5;
      line(
        c,
        bc.x + Math.cos(t) * R,
        bc.y + Math.sin(t) * R,
        bc.x + Math.cos(t) * (R + len * k),
        bc.y + Math.sin(t) * (R + len * k),
        lw * 0.8,
        col,
      );
    }
    const b = Math.max(-47, Math.min(47, -d.bank)) * DEG + Math.PI / 2;
    const px = bc.x + Math.cos(b) * (R - 3 * k);
    const py = bc.y + Math.sin(b) * (R - 3 * k);
    c.beginPath();
    c.moveTo(px, py);
    c.lineTo(
      px - Math.cos(b) * 10 * k + Math.sin(b) * 5 * k,
      py - Math.sin(b) * 10 * k - Math.cos(b) * 5 * k,
    );
    c.lineTo(
      px - Math.cos(b) * 10 * k - Math.sin(b) * 5 * k,
      py - Math.sin(b) * 10 * k + Math.cos(b) * 5 * k,
    );
    c.closePath();
    c.fill();
  }
  // --- landing mode ---
  if (d.landing) {
    const wl = body(0, 0);
    if (wl) {
      // The water line: a W at the boresight.
      c.lineWidth = lw;
      c.beginPath();
      c.moveTo(wl.x - 22 * k, wl.y);
      c.lineTo(wl.x - 11 * k, wl.y);
      c.lineTo(wl.x - 5.5 * k, wl.y + 9 * k);
      c.lineTo(wl.x, wl.y);
      c.lineTo(wl.x + 5.5 * k, wl.y + 9 * k);
      c.lineTo(wl.x + 11 * k, wl.y);
      c.lineTo(wl.x + 22 * k, wl.y);
      c.stroke();
    }
    // The E-bracket left of the velocity vector: centred on it at the on-speed angle of attack.
    if (vv) {
      const top = body(d.drift, -ON_SPEED.slow + 0 * ppd);
      const ctr = body(d.drift, -ON_SPEED.alpha);
      const bot = body(d.drift, -ON_SPEED.fast);
      if (top && ctr && bot) {
        const ex = vv.x - 30 * k;
        c.lineWidth = lw;
        c.beginPath();
        c.moveTo(ex + 8 * k, top.y);
        c.lineTo(ex, top.y);
        c.lineTo(ex, bot.y);
        c.lineTo(ex + 8 * k, bot.y);
        c.moveTo(ex, ctr.y);
        c.lineTo(ex + 7 * k, ctr.y);
        c.stroke();
      }
    }
    if (d.ils && wl) {
      const span = 70 * k;
      if (d.ils.localizer !== undefined) {
        const x = wl.x + Math.max(-1, Math.min(1, d.ils.localizer)) * span;
        line(c, x, wl.y - span, x, wl.y + span, lw, col);
      }
      if (d.ils.glideSlope !== undefined) {
        const y = wl.y - Math.max(-1, Math.min(1, d.ils.glideSlope)) * span;
        line(c, wl.x - span, y, wl.x + span, y, lw, col);
      }
    }
  }
  // --- cautions and bingo, low in the field ---
  const lines = [...d.cautions.slice(0, 2), ...(d.bingo ? ['BINGO'] : [])];
  lines.forEach((s, i) => txt(c, s, w / 2, h - 70 * k + i * 18 * k, 20 * k, col));
  c.restore();
}

// =============================================================================================
// DDIs and the MPCD

export type DdiPage = 'off' | 'hsi' | 'fcs' | 'engine' | 'adi' | 'checklist' | 'fuel';
export type MpcdPage = 'off' | 'hsi' | 'fuel' | 'engine';

export interface EngineRow {
  running: boolean;
  /** N2 per cent, EGT degrees C, fuel flow lb/h, nozzle per cent, oil psi, afterburner 0..1. */
  rpm: number;
  egt: number;
  ff: number;
  noz: number;
  oil: number;
  ab: number;
}

export interface Fa18Displays {
  on: boolean;
  pitch: number;
  bank: number;
  heading: number;
  track: number;
  ias: number;
  alt: number;
  vv: number;
  alpha: number;
  mach: number;
  g: number;
  engines: [EngineRow, EngineRow];
  /** Fuel, lb: total, internal (= total, no tanks carried), the feed tanks, bingo. */
  fuel: { total: number; left: number; right: number; bingo: number; flow: number };
  surfaces: Fa18Surfaces;
  fcsFailed: readonly number[];
  gear: number;
  flaps: 'auto' | 'half' | 'full';
  speedbrake: number;
  /** Navigation: what the HSI shows. */
  nav: {
    source: 'NAV' | 'GPS' | 'TCN';
    course: number;
    hdgBug: number;
    deviation: number | undefined;
    ident: string;
    bearing: number | undefined;
    distance: number | undefined;
    plan: readonly Waypoint[];
    active: number;
    lon: number;
    lat: number;
    range: number;
    tacan: number;
  };
  cautions: readonly string[];
  advisories: readonly string[];
  time: number;
}

function ddiKey(page: DdiPage, d: Fa18Displays): string {
  if (!d.on || page === 'off') return 'off';
  const r = Math.round;
  switch (page) {
    case 'hsi':
      return `hsi|${r(d.heading)}|${r(d.nav.course)}|${r(d.nav.hdgBug)}|${r((d.nav.deviation ?? 9) * 20)}|${d.nav.ident}|${r((d.nav.distance ?? -1) * 10)}|${r(d.nav.bearing ?? -1)}|${d.nav.source}`;
    case 'fcs':
      return `fcs|${Object.values(d.surfaces)
        .map((v) => r(v))
        .join(',')}|${d.fcsFailed.join(',')}`;
    case 'engine':
      return `eng|${d.engines.map((e) => [r(e.rpm), r(e.egt / 5), r(e.ff / 50), r(e.noz), r(e.oil), r(e.ab * 10)].join(',')).join('/')}`;
    case 'adi':
      return `adi|${r(d.pitch * 4)}|${r(d.bank * 2)}|${r(d.heading)}|${r(d.ias)}|${r(d.alt / 10)}`;
    case 'checklist':
      return `ck|${r(d.gear * 10)}|${d.flaps}|${r(d.speedbrake * 10)}`;
    case 'fuel':
      return `fuel|${r(d.fuel.total / 10)}|${r(d.fuel.left / 10)}|${r(d.fuel.right / 10)}|${r(d.fuel.bingo / 10)}`;
  }
}

/** Push-button legends round a display (top, right, bottom, left; five each). */
function osb(
  c: Ctx,
  w: number,
  h: number,
  legends: Partial<Record<'t' | 'r' | 'b' | 'l', string[]>>,
  color: string,
  sel?: string,
) {
  const k = w / 512;
  for (const [side, list] of Object.entries(legends) as [string, string[]][]) {
    list.forEach((s, i) => {
      if (!s) return;
      const t = (i - 2) * (0.172 / 0.128) * (w / 7.8);
      let x = w / 2 + t;
      let y = 16 * k;
      if (side === 'b') y = h - 16 * k;
      if (side === 'l' || side === 'r') {
        x = side === 'l' ? 30 * k : w - 30 * k;
        y = h / 2 + t;
      }
      txt(c, s, x, y, 15 * k, color, 'center', MONO, 700);
      if (s === sel) boxed(c, x, y, 46 * k, 20 * k, 1.5 * k, color);
    });
  }
}

function paintDdi(c: Ctx, w: number, h: number, page: DdiPage, d: Fa18Displays) {
  c.fillStyle = '#000';
  c.fillRect(0, 0, w, h);
  if (!d.on || page === 'off') return;
  const k = w / 512;
  const menu = { b: ['', 'HSI', 'FCS', 'ENG', ''], t: ['ADI', 'CHKLST', '', 'FUEL', 'MENU'] };
  const label =
    page === 'hsi'
      ? 'HSI'
      : page === 'fcs'
        ? 'FCS'
        : page === 'engine'
          ? 'ENG'
          : page === 'adi'
            ? 'ADI'
            : page === 'checklist'
              ? 'CHKLST'
              : 'FUEL';
  osb(c, w, h, menu, G, label);
  switch (page) {
    case 'hsi':
      paintHsi(c, w, h, d, true);
      break;
    case 'adi':
      paintAdi(c, w, h, d);
      break;
    case 'fcs': {
      paintFcs(c, w, h, d);
      break;
    }
    case 'engine':
      paintEngines(c, w, h, d, G);
      break;
    case 'checklist': {
      const items: [string, string][] = [
        ['LANDING CHECKLIST', ''],
        ['GEAR', d.gear > 0.99 ? 'DOWN' : d.gear < 0.01 ? 'UP' : 'TRANSIT'],
        ['FLAPS', d.flaps.toUpperCase()],
        ['HOOK', 'AS REQ'],
        ['SPD BRK', d.speedbrake > 0.05 ? 'OUT' : 'IN'],
        ['ANTI SKID', 'ON'],
        ['', ''],
        ['LIMITS', ''],
        ['VMAX', '750 KCAS / M1.8'],
        ['G CLEAN', '+7.5 / -3.0'],
        ['GEAR EXT', '250 KCAS'],
        ['FLAPS HALF/FULL', '250 KCAS'],
        ['AOA LANDING', '8.1 DEG'],
        ['MAX EGT', '890 C (MIL/AB)'],
      ];
      items.forEach(([a, b], i) => {
        const y = 70 * k + i * 27 * k;
        txt(c, a, 70 * k, y, 21 * k, G, 'left');
        txt(c, b, w - 70 * k, y, 17 * k, a === 'GEAR' && b !== 'DOWN' ? '#fff' : G, 'right');
      });
      break;
    }
    case 'fuel':
      paintFuel(c, w, h, d, G);
      break;
  }
}

function paintAdi(c: Ctx, w: number, h: number, d: Fa18Displays) {
  const k = w / 512;
  const cx = w / 2;
  const cy = h / 2 + 10 * k;
  const R = 150 * k;
  c.save();
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.clip();
  c.translate(cx, cy);
  c.rotate(-d.bank * DEG);
  const ppd = 5 * k;
  c.translate(0, d.pitch * ppd);
  // Ground cross-hatched, sky plain: the monochrome ball.
  c.fillStyle = '#062a10';
  c.fillRect(-400 * k, 0, 800 * k, 800 * k);
  line(c, -400 * k, 0, 400 * k, 0, 2.6 * k, G);
  for (let e = -60; e <= 60; e += 5) {
    if (e === 0) continue;
    const y = -e * ppd;
    const half = (e % 10 === 0 ? 40 : 20) * k;
    c.setLineDash(e < 0 ? [6 * k, 5 * k] : []);
    line(c, -half, y, half, y, 2 * k, G);
    c.setLineDash([]);
    if (e % 10 === 0) txt(c, String(Math.abs(e)), half + 18 * k, y, 18 * k, G);
  }
  c.restore();
  c.strokeStyle = G;
  c.lineWidth = 2 * k;
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.stroke();
  line(c, cx - 60 * k, cy, cx - 15 * k, cy, 4 * k, '#fff');
  line(c, cx + 15 * k, cy, cx + 60 * k, cy, 4 * k, '#fff');
  txt(c, String(Math.round(d.ias)), 60 * k, cy, 25 * k, G);
  txt(c, formatHudAltitude(d.alt), w - 62 * k, cy, 25 * k, G);
  txt(c, formatHeading(d.heading), cx, 52 * k, 22 * k, G);
}

/** The flight control system page: surface positions and X's where a channel has failed. */
function paintFcs(c: Ctx, w: number, _h: number, d: Fa18Displays) {
  const k = w / 512;
  const s = d.surfaces;
  const failed = new Set(d.fcsFailed);
  const cell = (x: number, y: number, title: string, v: number) => {
    txt(c, title, x, y - 22 * k, 18 * k, G);
    boxed(c, x, y + 2 * k, 66 * k, 26 * k, 1.6 * k, G);
    txt(c, String(Math.round(v)), x, y + 3 * k, 22 * k, G);
  };
  cell(110 * k, 110 * k, 'LEF', s.lef);
  cell(w - 110 * k, 110 * k, 'LEF', s.lef);
  cell(110 * k, 190 * k, 'TEF', s.tef);
  cell(w - 110 * k, 190 * k, 'TEF', s.tef);
  cell(110 * k, 270 * k, 'AIL', s.aileronL);
  cell(w - 110 * k, 270 * k, 'AIL', s.aileronR);
  cell(200 * k, 360 * k, 'RUD', s.rudderL);
  cell(w - 200 * k, 360 * k, 'RUD', s.rudderR);
  cell(110 * k, 430 * k, 'STAB', s.stabL);
  cell(w - 110 * k, 430 * k, 'STAB', s.stabR);
  // The four channels of each column; X where failed.
  for (let ch = 1; ch <= 4; ch++) {
    const x = w / 2 - 75 * k + (ch - 1) * 50 * k;
    txt(c, String(ch), x, 120 * k, 19 * k, G);
    for (let r = 0; r < 4; r++) {
      const y = 150 * k + r * 34 * k;
      boxed(c, x, y, 30 * k, 22 * k, 1.2 * k, GD);
      if (failed.has(ch)) {
        line(c, x - 12 * k, y - 9 * k, x + 12 * k, y + 9 * k, 2.6 * k, G);
        line(c, x - 12 * k, y + 9 * k, x + 12 * k, y - 9 * k, 2.6 * k, G);
      }
    }
  }
  txt(c, 'FCS', w / 2, 82 * k, 22 * k, G);
}

function paintEngines(c: Ctx, w: number, _h: number, d: Fa18Displays, color: string) {
  const k = w / 512;
  const rows: [string, (e: EngineRow) => string][] = [
    ['RPM %', (e) => String(Math.round(e.rpm))],
    ['EGT C', (e) => String(Math.round(e.egt))],
    ['FF PPH', (e) => String(Math.round(e.ff / 10) * 10)],
    ['NOZ %', (e) => String(Math.round(e.noz))],
    ['OIL PSI', (e) => String(Math.round(e.oil))],
    ['AB', (e) => (e.ab > 0.01 ? String(Math.round(e.ab * 100)) : '--')],
  ];
  txt(c, 'L', 180 * k, 70 * k, 25 * k, color);
  txt(c, 'R', w - 180 * k, 70 * k, 25 * k, color);
  rows.forEach(([name, f], i) => {
    const y = 115 * k + i * 54 * k;
    txt(c, name, w / 2, y, 20 * k, color);
    for (const [j, e] of d.engines.entries()) {
      const x = j === 0 ? 180 * k : w - 180 * k;
      boxed(c, x, y, 92 * k, 34 * k, 1.6 * k, color);
      txt(c, e.running || name === 'NOZ %' ? f(e) : '0', x, y + 1 * k, 28 * k, color);
    }
  });
}

function paintFuel(c: Ctx, w: number, _h: number, d: Fa18Displays, color: string) {
  const k = w / 512;
  const f = d.fuel;
  // The aircraft's outline with its tanks, left and right feed tanks.
  c.strokeStyle = color;
  c.lineWidth = 2 * k;
  c.beginPath();
  c.moveTo(w / 2, 70 * k);
  c.lineTo(w / 2 + 40 * k, 160 * k);
  c.lineTo(w / 2 + 190 * k, 280 * k);
  c.lineTo(w / 2 + 50 * k, 300 * k);
  c.lineTo(w / 2 + 60 * k, 420 * k);
  c.lineTo(w / 2 - 60 * k, 420 * k);
  c.lineTo(w / 2 - 50 * k, 300 * k);
  c.lineTo(w / 2 - 190 * k, 280 * k);
  c.lineTo(w / 2 - 40 * k, 160 * k);
  c.closePath();
  c.stroke();
  txt(c, formatFuelLb(f.left), w / 2 - 110 * k, 255 * k, 25 * k, color);
  txt(c, formatFuelLb(f.right), w / 2 + 110 * k, 255 * k, 25 * k, color);
  txt(c, 'TOTAL', w / 2, 330 * k, 19 * k, color);
  txt(c, formatFuelLb(f.total), w / 2, 356 * k, 30 * k, color);
  txt(
    c,
    `BINGO ${formatFuelLb(f.bingo)}`,
    w / 2,
    460 * k,
    18 * k,
    f.total < f.bingo ? '#fff' : color,
  );
  txt(c, `FF ${formatFuelLb(f.flow)} PPH`, w / 2, 485 * k, 19 * k, color);
}

/**
 * Horizontal situation: compass rose heading up, the aircraft, the course line with its
 * deviation, the heading bug, waypoints of the flight plan, range by the range knob.
 */
function paintHsi(c: Ctx, w: number, h: number, d: Fa18Displays, mono: boolean) {
  const k = w / 512;
  const n = d.nav;
  const fg = mono ? G : C.white;
  const crs = mono ? G : C.green;
  const wpCol = mono ? G : C.cyan;
  const cx = w / 2;
  const cy = h / 2 + 30 * k;
  const R = 170 * k;
  const rot = (deg: number) => (deg - d.heading) * DEG;
  c.strokeStyle = fg;
  c.lineWidth = 2 * k;
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.stroke();
  for (let a = 0; a < 360; a += 5) {
    const t = rot(a) - Math.PI / 2;
    const len = a % 30 === 0 ? 16 : a % 10 === 0 ? 10 : 5;
    line(
      c,
      cx + Math.cos(t) * R,
      cy + Math.sin(t) * R,
      cx + Math.cos(t) * (R - len * k),
      cy + Math.sin(t) * (R - len * k),
      1.6 * k,
      fg,
    );
    if (a % 30 === 0) {
      const s = a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a / 10);
      txt(c, s, cx + Math.cos(t) * (R - 30 * k), cy + Math.sin(t) * (R - 30 * k), 16 * k, fg);
    }
  }
  // Waypoints on the map (north-up offsets turned to heading-up).
  const nmPx = R / Math.max(n.range, 1);
  if (n.plan.length) {
    const pts = n.plan.map((p) => {
      const o = mapOffsetNm(n.lon, n.lat, p.lon, p.lat);
      const a = -d.heading * DEG;
      const x = o.east * Math.cos(a) - o.north * Math.sin(a);
      const y = o.east * Math.sin(a) + o.north * Math.cos(a);
      return { x: cx + x * nmPx, y: cy - y * nmPx, id: p.ident };
    });
    c.save();
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.clip();
    c.strokeStyle = wpCol;
    c.lineWidth = 2 * k;
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
    c.stroke();
    pts.forEach((p, i) => {
      c.beginPath();
      c.arc(p.x, p.y, 7 * k, 0, Math.PI * 2);
      c.fillStyle = i === n.active ? wpCol : '#000';
      c.fill();
      c.stroke();
      txt(c, p.id, p.x + 10 * k, p.y - 12 * k, 13 * k, wpCol, 'left');
    });
    c.restore();
  }
  // Course arrow with the deviation bar.
  c.save();
  c.translate(cx, cy);
  c.rotate(rot(n.course));
  line(c, 0, -R + 22 * k, 0, -60 * k, 3 * k, crs);
  line(c, 0, 60 * k, 0, R - 22 * k, 3 * k, crs);
  c.fillStyle = crs;
  c.beginPath();
  c.moveTo(0, -R + 12 * k);
  c.lineTo(-9 * k, -R + 30 * k);
  c.lineTo(9 * k, -R + 30 * k);
  c.closePath();
  c.fill();
  if (n.deviation !== undefined) {
    const dx = Math.max(-1, Math.min(1, n.deviation)) * 80 * k;
    line(c, dx, -55 * k, dx, 55 * k, 3 * k, crs);
  }
  for (const dot of [-80, -40, 40, 80]) {
    c.beginPath();
    c.arc(dot * k, 0, 4 * k, 0, Math.PI * 2);
    c.strokeStyle = fg;
    c.stroke();
  }
  c.restore();
  // Heading bug.
  c.save();
  c.translate(cx, cy);
  c.rotate(rot(n.hdgBug));
  c.strokeStyle = mono ? G : C.magenta;
  c.lineWidth = 2.5 * k;
  c.strokeRect(-9 * k, -R - 2 * k, 18 * k, 9 * k);
  c.restore();
  // Own aircraft and the lubber line.
  line(c, cx, cy - 18 * k, cx, cy + 18 * k, 3 * k, fg);
  line(c, cx - 14 * k, cy - 4 * k, cx + 14 * k, cy - 4 * k, 3 * k, fg);
  line(c, cx - 7 * k, cy + 14 * k, cx + 7 * k, cy + 14 * k, 3 * k, fg);
  line(c, cx, cy - R - 12 * k, cx, cy - R + 4 * k, 3 * k, fg);
  // Text: heading, source and its data.
  boxed(c, cx, cy - R - 26 * k, 56 * k, 22 * k, 1.6 * k, fg);
  txt(c, formatHeading(d.heading), cx, cy - R - 25 * k, 17 * k, fg);
  txt(c, `CRS ${formatHeading(n.course)}`, 22 * k, h - 50 * k, 15 * k, crs, 'left');
  txt(c, `${n.source} ${n.ident}`, 22 * k, h - 30 * k, 15 * k, crs, 'left');
  if (n.source === 'TCN') txt(c, `CH ${n.tacan}X`, 22 * k, h - 70 * k, 15 * k, crs, 'left');
  txt(
    c,
    n.distance !== undefined ? `${n.distance.toFixed(1)} NM` : '--- NM',
    w - 22 * k,
    h - 50 * k,
    15 * k,
    crs,
    'right',
  );
  txt(
    c,
    n.bearing !== undefined ? `BRG ${formatHeading(n.bearing)}` : 'BRG ---',
    w - 22 * k,
    h - 30 * k,
    15 * k,
    crs,
    'right',
  );
  txt(c, `${n.range} NM`, w - 22 * k, 60 * k, 14 * k, fg, 'right');
}

function mpcdKey(page: MpcdPage, d: Fa18Displays): string {
  if (!d.on || page === 'off') return 'off';
  if (page === 'hsi')
    return `${ddiKey('hsi', d)}|${Math.round(d.nav.lon * 2000)}|${Math.round(d.nav.lat * 2000)}|${d.nav.range}|${d.nav.active}|${d.nav.tacan}`;
  return ddiKey(page === 'fuel' ? 'fuel' : 'engine', d);
}

function paintMpcd(c: Ctx, w: number, h: number, page: MpcdPage, d: Fa18Displays) {
  c.fillStyle = '#000';
  c.fillRect(0, 0, w, h);
  if (!d.on || page === 'off') return;
  const k = w / 512;
  if (page === 'hsi') {
    // A moving-map style background: a dark terrain tint in the range rings.
    const g = c.createRadialGradient(w / 2, h / 2 + 30 * k, 10 * k, w / 2, h / 2 + 30 * k, 200 * k);
    g.addColorStop(0, '#13261a');
    g.addColorStop(1, '#0a1210');
    c.fillStyle = g;
    c.beginPath();
    c.arc(w / 2, h / 2 + 30 * k, 170 * k, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#2f4f3a';
    c.setLineDash([5 * k, 6 * k]);
    c.beginPath();
    c.arc(w / 2, h / 2 + 30 * k, 85 * k, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    paintHsi(c, w, h, d, false);
  } else if (page === 'fuel') paintFuel(c, w, h, d, C.green);
  else paintEngines(c, w, h, d, C.green);
  osb(
    c,
    w,
    h,
    { t: ['HSI', '', 'FUEL', '', 'ENG'], b: ['', 'SCL', '', 'DATA', ''] },
    C.white,
    page === 'hsi' ? 'HSI' : page === 'fuel' ? 'FUEL' : 'ENG',
  );
}

/** The DDIs share one canvas (left half, right half); the MPCD has its own. */
export interface DdiFrame {
  d: Fa18Displays;
  left: DdiPage;
  right: DdiPage;
  mpcd: MpcdPage;
}

export const DDI_PAINTER: AtlasPainter<'DDI_L' | 'DDI_R', DdiFrame> = {
  width: 1024,
  height: 512,
  regions: { DDI_L: { x: 0, y: 0, w: 512, h: 512 }, DDI_R: { x: 512, y: 0, w: 512, h: 512 } },
  content: (id, f) => ddiKey(id === 'DDI_L' ? f.left : f.right, f.d),
  paint: (c, id, w, h, _key, f) => paintDdi(c, w, h, id === 'DDI_L' ? f.left : f.right, f.d),
  throttled: ['DDI_L', 'DDI_R'],
  background: '#000',
};

export const MPCD_PAINTER: AtlasPainter<'MPCD', DdiFrame> = {
  width: 512,
  height: 512,
  regions: { MPCD: { x: 0, y: 0, w: 512, h: 512 } },
  content: (_id, f) => mpcdKey(f.mpcd, f.d),
  paint: (c, _id, w, h, _key, f) => paintMpcd(c, w, h, f.mpcd, f.d),
  throttled: ['MPCD'],
  background: '#000',
};

// =============================================================================================
// Panel windows

export interface PanelData {
  on: boolean;
  /** Up-front control: the scratchpad, the five options (with the colon when selected). */
  scratchpad: string;
  options: { text: string; on: boolean }[];
  com1: number;
  com2: number;
  nav1: number;
  nav1Standby: number;
  xpdr: { code: number; mode: string };
  ifei: { engines: [EngineRow, EngineRow]; fuel: Fa18Displays['fuel']; time: number };
  stby: { ias: number; alt: number; baro: number; pitch: number; bank: number; vs: number };
  radalt: { ft: number | undefined; minimums: number };
  cautions: readonly string[];
  aoa: IndexerState;
  masterCaution: boolean;
  gear: { down: boolean; transit: boolean };
  hook: { down: boolean; transit: boolean };
  /** Panel and display brightness are the material's; this is for the lamps' test. */
  time: number;
}

/** Window rectangles in the panel atlas (each the shape of its window in the model). */
export const PANEL_WINDOW_REGIONS: Record<
  PanelWindowId,
  { x: number; y: number; w: number; h: number }
> = {
  UFC_SP: { x: 0, y: 0, w: 480, h: 80 },
  UFC_OPT: { x: 480, y: 0, w: 160, h: 256 },
  UFC_C1: { x: 640, y: 0, w: 150, h: 70 },
  UFC_C2: { x: 790, y: 0, w: 150, h: 70 },
  IFEI: { x: 0, y: 80, w: 420, h: 300 },
  STBY_ASI: { x: 640, y: 70, w: 192, h: 192 },
  STBY_ALT: { x: 832, y: 70, w: 192, h: 192 },
  STBY_ADI: { x: 420, y: 256, w: 192, h: 192 },
  STBY_VSI: { x: 612, y: 262, w: 192, h: 192 },
  RADALT: { x: 804, y: 262, w: 192, h: 192 },
  CAUTION: { x: 0, y: 380, w: 240, h: 300 },
  AOA: { x: 240, y: 380, w: 60, h: 120 },
  MC: { x: 300, y: 380, w: 102, h: 60 },
  GEAR: { x: 240, y: 500, w: 128, h: 128 },
  HOOK: { x: 300, y: 440, w: 96, h: 48 },
  NAV: { x: 420, y: 456, w: 300, h: 70 },
  IFF: { x: 420, y: 526, w: 300, h: 70 },
};

const AMBER_LCD = '#ffb84a';

function windowKey(id: PanelWindowId, d: PanelData): string {
  const r = Math.round;
  if (!d.on && id !== 'GEAR' && id !== 'HOOK' && !id.startsWith('STBY')) return 'off';
  switch (id) {
    case 'UFC_SP':
      return d.scratchpad;
    case 'UFC_OPT':
      return d.options.map((o) => `${o.on ? ':' : ''}${o.text}`).join('|');
    case 'UFC_C1':
      return String(d.com1);
    case 'UFC_C2':
      return String(d.com2);
    case 'IFEI':
      return `${d.ifei.engines.map((e) => [r(e.rpm), r(e.egt), r(e.ff / 10), r(e.noz), r(e.oil)].join(',')).join('/')}|${r(d.ifei.fuel.total / 10)}|${r(d.ifei.fuel.bingo / 10)}|${Math.floor(d.ifei.time / 60)}`;
    case 'STBY_ASI':
      return String(r(d.stby.ias));
    case 'STBY_ALT':
      return `${r(d.stby.alt / 5)}|${r(d.stby.baro)}`;
    case 'STBY_ADI':
      return `${r(d.stby.pitch * 2)}|${r(d.stby.bank)}`;
    case 'STBY_VSI':
      return String(r(d.stby.vs / 50));
    case 'RADALT':
      return `${d.radalt.ft === undefined ? 'x' : r(d.radalt.ft / 5)}|${d.radalt.minimums}`;
    case 'CAUTION':
      return d.cautions.join(',');
    case 'AOA':
      return d.aoa;
    case 'MC':
      return String(d.masterCaution);
    case 'GEAR':
      return `${d.gear.down}${d.gear.transit}${d.on}`;
    case 'HOOK':
      return `${d.hook.transit}${d.on}`;
    case 'NAV':
      return `${d.nav1}|${d.nav1Standby}`;
    case 'IFF':
      return `${d.xpdr.code}|${d.xpdr.mode}`;
  }
}

/** The caution lights panel's legends (lit when the cautions list carries them). */
export const CAUTION_LEGENDS = [
  'CK SEAT',
  'APU ACC',
  'BATT SW',
  'FCS HOT',
  'GEN TIE',
  'FUEL LO',
  'FCES',
  'L GEN',
  'R GEN',
  'OBOGS',
  'SPD BRK',
  'L BAR',
] as const;

function gauge(c: Ctx, w: number, h: number) {
  c.fillStyle = '#0b0b0c';
  c.beginPath();
  c.arc(w / 2, h / 2, w * 0.48, 0, Math.PI * 2);
  c.fill();
}

function needle(c: Ctx, w: number, h: number, angle: number) {
  const r = w * 0.4;
  line(
    c,
    w / 2,
    h / 2,
    w / 2 + Math.sin(angle) * r,
    h / 2 - Math.cos(angle) * r,
    w * 0.025,
    '#f2f2ee',
  );
}

function paintWindow(c: Ctx, id: PanelWindowId, w: number, h: number, d: PanelData) {
  c.fillStyle = '#000';
  c.fillRect(0, 0, w, h);
  const k = h / 100;
  switch (id) {
    case 'UFC_SP':
      if (d.on) txt(c, d.scratchpad, w / 2, h / 2, h * 0.55, G);
      return;
    case 'UFC_OPT':
      if (!d.on) return;
      d.options.forEach((o, i) => {
        const y = ((i + 0.5) / 5) * h;
        txt(c, o.on ? ':' : '', 14 * (w / 160), y, h * 0.12, G);
        txt(c, o.text, w / 2 + 8, y, h * 0.11, G);
      });
      return;
    case 'UFC_C1':
    case 'UFC_C2':
      if (d.on)
        txt(
          c,
          formatFrequency(id === 'UFC_C1' ? d.com1 : d.com2).replace('.', ''),
          w / 2,
          h / 2,
          h * 0.5,
          G,
        );
      return;
    case 'IFEI': {
      if (!d.on) return;
      const e = d.ifei.engines;
      const rows: [string, (x: EngineRow) => number][] = [
        ['RPM', (x) => x.rpm],
        ['TEMP', (x) => x.egt],
        ['FF', (x) => x.ff / 100],
        ['NOZ', (x) => x.noz],
        ['OIL', (x) => x.oil],
      ];
      rows.forEach(([name, f], i) => {
        const y = (0.12 + i * 0.14) * h;
        txt(c, String(Math.round(f(e[0]))), w * 0.2, y, h * 0.11, AMBER_LCD, 'right');
        txt(c, name, w * 0.32, y, h * 0.07, AMBER_LCD);
        txt(c, String(Math.round(f(e[1]))), w * 0.48, y, h * 0.11, AMBER_LCD, 'right');
      });
      const f = d.ifei.fuel;
      txt(c, `${formatFuelLb(f.total)}T`, w * 0.97, h * 0.18, h * 0.12, AMBER_LCD, 'right');
      txt(
        c,
        `${formatFuelLb(f.left + f.right)}I`,
        w * 0.97,
        h * 0.38,
        h * 0.12,
        AMBER_LCD,
        'right',
      );
      txt(c, `BINGO ${formatFuelLb(f.bingo)}`, w * 0.97, h * 0.6, h * 0.08, AMBER_LCD, 'right');
      const t = d.ifei.time;
      txt(
        c,
        `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}`,
        w * 0.97,
        h * 0.82,
        h * 0.09,
        AMBER_LCD,
        'right',
      );
      return;
    }
    case 'STBY_ASI': {
      gauge(c, w, h);
      for (let kt = 0; kt <= 850; kt += 50) {
        const a = (kt / 850) * 1.85 * Math.PI;
        const r0 = w * (kt % 100 === 0 ? 0.36 : 0.41);
        line(
          c,
          w / 2 + Math.sin(a) * r0,
          h / 2 - Math.cos(a) * r0,
          w / 2 + Math.sin(a) * w * 0.46,
          h / 2 - Math.cos(a) * w * 0.46,
          w * 0.012,
          '#ddd',
        );
        if (kt % 200 === 0 && kt)
          txt(
            c,
            String(kt / 10),
            w / 2 + Math.sin(a) * w * 0.27,
            h / 2 - Math.cos(a) * w * 0.27,
            w * 0.09,
            '#ddd',
            'center',
            SANS,
          );
      }
      needle(c, w, h, (Math.min(d.stby.ias, 850) / 850) * 1.85 * Math.PI);
      txt(c, 'KNOTS', w / 2, h * 0.68, w * 0.07, '#ccc', 'center', SANS);
      return;
    }
    case 'STBY_ALT': {
      gauge(c, w, h);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * 2 * Math.PI;
        txt(
          c,
          String(i),
          w / 2 + Math.sin(a) * w * 0.34,
          h / 2 - Math.cos(a) * w * 0.34,
          w * 0.1,
          '#ddd',
          'center',
          SANS,
        );
      }
      needle(c, w, h, ((d.stby.alt % 1000) / 1000) * 2 * Math.PI);
      txt(
        c,
        String(Math.floor(Math.max(d.stby.alt, 0) / 1000)).padStart(2, '0'),
        w / 2,
        h * 0.36,
        w * 0.11,
        '#fff',
        'center',
        MONO,
      );
      txt(c, String(Math.round(d.stby.baro)), w / 2, h * 0.68, w * 0.08, '#ddd', 'center', MONO);
      return;
    }
    case 'STBY_ADI': {
      gauge(c, w, h);
      c.save();
      c.beginPath();
      c.arc(w / 2, h / 2, w * 0.44, 0, Math.PI * 2);
      c.clip();
      c.translate(w / 2, h / 2);
      c.rotate(-d.stby.bank * DEG);
      c.translate(0, d.stby.pitch * w * 0.012);
      c.fillStyle = '#e8e8e4';
      c.fillRect(-w, -w, 2 * w, w);
      c.fillStyle = '#1d1d1f';
      c.fillRect(-w, 0, 2 * w, w);
      for (const e of [-20, -10, 10, 20])
        line(
          c,
          -w * 0.12,
          -e * w * 0.012,
          w * 0.12,
          -e * w * 0.012,
          w * 0.012,
          e > 0 ? '#222' : '#ddd',
        );
      c.restore();
      line(c, w * 0.22, h / 2, w * 0.42, h / 2, w * 0.03, C.amber);
      line(c, w * 0.58, h / 2, w * 0.78, h / 2, w * 0.03, C.amber);
      return;
    }
    case 'STBY_VSI': {
      gauge(c, w, h);
      for (const v of [-6, -4, -2, -1, 0, 1, 2, 4, 6]) {
        const a = -Math.PI / 2 + Math.sign(v) * Math.sqrt(Math.abs(v) / 6) * 0.9 * Math.PI;
        txt(
          c,
          String(Math.abs(v)),
          w / 2 + Math.sin(a) * w * 0.33,
          h / 2 - Math.cos(a) * w * 0.33,
          w * 0.09,
          '#ddd',
          'center',
          SANS,
        );
      }
      const v = Math.max(-6, Math.min(6, d.stby.vs / 1000));
      needle(c, w, h, -Math.PI / 2 + Math.sign(v) * Math.sqrt(Math.abs(v) / 6) * 0.9 * Math.PI);
      return;
    }
    case 'RADALT': {
      gauge(c, w, h);
      // 0..5000 ft on a compressed scale; the low-altitude bug at the minimums.
      const ang = (ft: number) =>
        Math.min(
          ft < 1000
            ? (ft / 1000) * 1.2 * Math.PI
            : 1.2 * Math.PI + ((ft - 1000) / 4000) * 0.6 * Math.PI,
          1.8 * Math.PI,
        );
      for (const ft of [0, 200, 400, 600, 800, 1000, 3000, 5000]) {
        const a = ang(ft);
        txt(
          c,
          String(ft >= 1000 ? ft / 1000 + 'K' : ft / 100),
          w / 2 + Math.sin(a) * w * 0.33,
          h / 2 - Math.cos(a) * w * 0.33,
          w * 0.08,
          '#ddd',
          'center',
          SANS,
        );
      }
      const b = ang(d.radalt.minimums);
      line(
        c,
        w / 2 + Math.sin(b) * w * 0.4,
        h / 2 - Math.cos(b) * w * 0.4,
        w / 2 + Math.sin(b) * w * 0.48,
        h / 2 - Math.cos(b) * w * 0.48,
        w * 0.04,
        C.amber,
      );
      if (d.on && d.radalt.ft !== undefined) {
        needle(c, w, h, ang(d.radalt.ft));
        txt(
          c,
          String(Math.round(d.radalt.ft / 10) * 10),
          w / 2,
          h * 0.7,
          w * 0.1,
          '#fff',
          'center',
          MONO,
        );
      } else txt(c, 'OFF', w / 2, h * 0.7, w * 0.1, C.red, 'center', SANS);
      if (d.on && d.radalt.ft !== undefined && d.radalt.ft < d.radalt.minimums) {
        c.fillStyle = C.red;
        c.beginPath();
        c.arc(w * 0.25, h * 0.25, w * 0.06, 0, Math.PI * 2);
        c.fill();
      }
      return;
    }
    case 'CAUTION': {
      const cols = 2;
      CAUTION_LEGENDS.forEach((s, i) => {
        const x = ((i % cols) + 0.5) * (w / cols);
        const y = (Math.floor(i / cols) + 0.5) * (h / 6);
        const lit = d.on && d.cautions.includes(s);
        c.fillStyle = lit ? '#3a2600' : '#0d0d0d';
        c.fillRect(x - w / 4 + 4, y - h / 12 + 3, w / 2 - 8, h / 6 - 6);
        txt(c, s, x, y, h * 0.045, lit ? C.amber : '#3a3a3a', 'center', SANS, 700);
      });
      return;
    }
    case 'AOA': {
      // Top: slow (green chevron pointing down), middle: on speed (amber ring), bottom: fast.
      // Slightly fast or slow lights the ring and the chevron together.
      const on = (s: string) =>
        d.on &&
        (d.aoa === s ||
          d.aoa.toLowerCase().includes(s.toLowerCase()) ||
          (s === 'onSpeed' && d.aoa.startsWith('slightly')));
      const chev = (y: number, down: boolean, col: string, lit: boolean) => {
        c.strokeStyle = lit ? col : '#262626';
        c.lineWidth = w * 0.12;
        c.beginPath();
        c.moveTo(w * 0.2, y + (down ? -1 : 1) * h * 0.06);
        c.lineTo(w * 0.5, y + (down ? 1 : -1) * h * 0.06);
        c.lineTo(w * 0.8, y + (down ? -1 : 1) * h * 0.06);
        c.stroke();
      };
      chev(h * 0.18, true, C.green, on('slow'));
      c.strokeStyle = on('onSpeed') ? C.amber : '#262626';
      c.lineWidth = w * 0.11;
      c.beginPath();
      c.arc(w / 2, h / 2, w * 0.24, 0, Math.PI * 2);
      c.stroke();
      chev(h * 0.82, false, C.red, on('fast'));
      return;
    }
    case 'MC':
      c.fillStyle = d.masterCaution ? '#3a2600' : '#0e0c08';
      c.fillRect(0, 0, w, h);
      txt(
        c,
        'MASTER',
        w / 2,
        h * 0.32,
        h * 0.3,
        d.masterCaution ? C.amber : '#3b3326',
        'center',
        SANS,
        700,
      );
      txt(
        c,
        'CAUTION',
        w / 2,
        h * 0.7,
        h * 0.3,
        d.masterCaution ? C.amber : '#3b3326',
        'center',
        SANS,
        700,
      );
      return;
    case 'GEAR': {
      // Three green NOSE / LEFT / RIGHT and the red handle light.
      const lit = d.on && d.gear.down;
      for (const [x, y, s] of [
        [0.5, 0.25, 'NOSE'],
        [0.25, 0.62, 'LEFT'],
        [0.75, 0.62, 'RIGHT'],
      ] as const) {
        c.fillStyle = lit ? '#0a3a14' : '#0d0d0d';
        c.fillRect(x * w - w * 0.2, y * h - h * 0.12, w * 0.4, h * 0.24);
        txt(c, s, x * w, y * h, h * 0.12, lit ? C.green : '#2a2a2a', 'center', SANS, 700);
      }
      c.fillStyle = d.on && d.gear.transit ? C.red : '#2a0c0c';
      c.beginPath();
      c.arc(w * 0.5, h * 0.88, w * 0.07, 0, Math.PI * 2);
      c.fill();
      return;
    }
    case 'HOOK':
      c.fillStyle = d.on && d.hook.transit ? '#4a0808' : '#120808';
      c.fillRect(0, 0, w, h);
      txt(
        c,
        'HOOK',
        w / 2,
        h / 2,
        h * 0.45,
        d.on && d.hook.transit ? C.red : '#3a1a1a',
        'center',
        SANS,
        700,
      );
      return;
    case 'NAV':
      if (d.on) {
        txt(c, formatFrequency(d.nav1), w * 0.27, h / 2, h * 0.55, G);
        txt(c, formatFrequency(d.nav1Standby), w * 0.75, h / 2, h * 0.45, GD);
      }
      return;
    case 'IFF':
      if (d.on) {
        txt(c, d.xpdr.mode.toUpperCase(), w * 0.25, h / 2, h * 0.45, G);
        txt(c, formatSquawk(d.xpdr.code), w * 0.72, h / 2, h * 0.55, G);
      }
      return;
  }
  void k;
}

export const PANEL_PAINTER: AtlasPainter<PanelWindowId, PanelData> = {
  width: 1024,
  height: 704,
  regions: PANEL_WINDOW_REGIONS,
  content: windowKey,
  paint: (c, id, w, h, _key, d) => paintWindow(c, id, w, h, d),
  throttled: ['STBY_ADI', 'STBY_ALT', 'STBY_ASI', 'STBY_VSI', 'RADALT', 'IFEI'],
  background: '#000',
};
