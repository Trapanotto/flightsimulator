/**
 * The radio stack's displays, the annunciator panel, the marker lamps and the altimeter's
 * setting window, painted into one canvas atlas. Each window is redrawn only when what it
 * shows changes (`content` builds a key from the shown text), and the atlas is uploaded at a
 * few Hz at most: displays are cheap however many frames are drawn.
 *
 * Formatting is plain functions (tested in Node); the painters need a 2D canvas.
 */
import type { AvionicsTelemetry, Cockpit, SystemsTelemetry, Waypoint } from '@sim';
import type { DisplayId } from './c172Parts';

// ---- formatting ------------------------------------------------------------------------------

/** A frequency in kHz as a radio shows it: '118.10', '110.50' (25 kHz steps lose their last digit). */
export function formatFrequency(kHz: number): string {
  const mhz = Math.floor(kHz / 1000);
  const hundredths = Math.floor((Math.round(kHz) % 1000) / 10);
  return `${mhz}.${String(hundredths).padStart(2, '0')}`;
}

/** Transponder code, always four digits: '7000', '0021'. */
export function formatSquawk(code: number): string {
  return String(Math.max(0, Math.min(7777, Math.round(code)))).padStart(4, '0');
}

/** DME distance: one decimal below 100 NM, whole miles above, dashes without a signal. */
export function formatDmeDistance(nm: number | undefined): string {
  if (nm === undefined || !Number.isFinite(nm)) return '--.-';
  if (nm < 99.95) return nm.toFixed(1);
  return String(Math.min(Math.round(nm), 389));
}

export function formatDmeSpeed(kt: number | undefined): string {
  if (kt === undefined || !Number.isFinite(kt)) return '---';
  return String(Math.min(Math.max(Math.round(kt), 0), 999)).padStart(3, ' ');
}

export function formatDmeMinutes(min: number | undefined): string {
  if (min === undefined || !Number.isFinite(min)) return '--';
  return String(Math.min(Math.max(Math.round(min), 0), 99));
}

/** Degrees as a navigator writes them: '005°'. */
export function formatBearing(deg: number | undefined): string {
  if (deg === undefined || !Number.isFinite(deg)) return '---°';
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return `${String(d === 0 ? 360 : d).padStart(3, '0')}°`;
}

/** Selected vertical speed with its sign: '+500', '-1200', '0'. */
export function formatVerticalSpeed(fpm: number): string {
  const v = Math.round(fpm / 100) * 100;
  return v > 0 ? `+${v}` : String(v);
}

/** The autopilot's mode annunciations (KAP 140 style). */
export function autopilotModes(ap: AvionicsTelemetry['autopilot']): {
  lateral: string;
  lateralArmed: string;
  vertical: string;
  verticalArmed: string;
} {
  if (!ap.engaged) return { lateral: '', lateralArmed: '', vertical: '', verticalArmed: '' };
  const lat = { roll: 'ROL', hdg: 'HDG', nav: 'NAV', apr: 'APR' } as const;
  const ver = { pitch: '', vs: 'VS', alt: 'ALT', gs: 'GS' } as const;
  return {
    lateral: lat[ap.lateral],
    lateralArmed: ap.lateralArmed ? `${lat[ap.lateralArmed]} ARM` : '',
    vertical: ver[ap.vertical],
    verticalArmed: ap.verticalArmed ? `${ver[ap.verticalArmed]} ARM` : '',
  };
}

/**
 * Without the avionics (not connected yet) the stack still shows what the knobs set, powered
 * by the master and avionics switches; nothing is received.
 */
export function avionicsFromCockpit(c: Cockpit | undefined): AvionicsTelemetry | undefined {
  if (!c) return undefined;
  const nav = (n: 1 | 2) => ({
    frequency: c.get(`nav${n}Active`),
    standby: c.get(`nav${n}Standby`),
    valid: false,
    ident: '',
    localizer: false,
    course: c.get(`obs${n}`),
    deviation: 0,
    toFrom: 'off' as const,
    bearing: undefined,
    glideSlope: undefined,
  });
  const modes = ['off', 'standby', 'on', 'alt'] as const;
  return {
    powered: c.get('battery') >= 0.5 && c.get('avionics') >= 0.5,
    com1: { active: c.get('com1Active'), standby: c.get('com1Standby') },
    com2: { active: c.get('com2Active'), standby: c.get('com2Standby') },
    nav1: nav(1),
    nav2: nav(2),
    dme: {
      source: c.get('dmeSource') >= 0.5 ? 'nav2' : 'nav1',
      distanceNm: undefined,
      groundSpeedKt: undefined,
      minutes: undefined,
    },
    adf: { frequency: c.get('adfFrequency'), valid: false, ident: '', relativeBearing: undefined },
    transponder: {
      code: c.get('xpdrCode'),
      mode: modes[Math.round(c.get('xpdrMode'))] ?? 'off',
      ident: false,
      reply: false,
    },
    markers: { outer: false, middle: false, inner: false },
    autopilot: {
      engaged: false,
      lateral: 'roll',
      lateralArmed: undefined,
      vertical: 'pitch',
      verticalArmed: undefined,
      selectedAltitude: c.get('apAltitude'),
      selectedVerticalSpeed: 0,
      disconnectWarning: false,
    },
    gps: {
      plan: [],
      active: -1,
      distanceNm: undefined,
      bearing: undefined,
      desiredTrack: undefined,
      crossTrackNm: undefined,
      groundSpeedKt: 0,
      track: 0,
      lon: 0,
      lat: 0,
    },
  };
}

/** The GPS map's range (NM across its width) that shows the next waypoint. */
export function mapRange(distanceNm: number | undefined): number {
  const ranges = [2, 5, 10, 20, 50, 100];
  const d = distanceNm ?? 10;
  return ranges.find((r) => r >= d * 1.6) ?? 100;
}

/** Position of a point on a north-up map around the aircraft, NM east and north. */
export function mapOffsetNm(
  lon0: number,
  lat0: number,
  lon: number,
  lat: number,
): { east: number; north: number } {
  return {
    east: (lon - lon0) * 60 * Math.cos((lat0 * Math.PI) / 180),
    north: (lat - lat0) * 60,
  };
}

// ---- what each window shows -------------------------------------------------------------------

export interface PanelData {
  avionics: AvionicsTelemetry | undefined;
  systems: SystemsTelemetry | undefined;
  /** hPa in the altimeter's window. */
  altimeterSetting: number;
  /** The VOR/ILS indicator 1 follows the GPS. */
  gpsCdi: boolean;
  /** Annunciators lit for the lamp test or by the systems. */
  time: number;
}

/** Text content (and so the redraw key) of each window. */
export function content(id: DisplayId, d: PanelData): string {
  const a = d.avionics;
  const on = !!a?.powered;
  switch (id) {
    case 'COM1':
    case 'COM2': {
      if (!on || !a) return '';
      const c = id === 'COM1' ? a.com1 : a.com2;
      return `${formatFrequency(c.active)}|${formatFrequency(c.standby)}`;
    }
    case 'NAV1':
    case 'NAV2': {
      if (!on || !a) return '';
      const n = id === 'NAV1' ? a.nav1 : a.nav2;
      return `${formatFrequency(n.frequency)}|${formatFrequency(n.standby)}`;
    }
    case 'ADF':
      return on && a ? `${Math.round(a.adf.frequency)}|${a.adf.valid ? a.adf.ident : ''}` : '';
    case 'DME': {
      if (!on || !a) return '';
      const m = a.dme;
      return `${m.source === 'nav2' ? 'N2' : 'N1'}|${formatDmeDistance(m.distanceNm)}|${formatDmeSpeed(
        m.groundSpeedKt,
      )}|${formatDmeMinutes(m.minutes)}`;
    }
    case 'XPDR': {
      if (!on || !a || a.transponder.mode === 'off') return '';
      const x = a.transponder;
      return `${formatSquawk(x.code)}|${x.mode}|${x.reply || x.ident ? 'R' : ''}`;
    }
    case 'AP': {
      if (!on || !a) return '';
      const ap = a.autopilot;
      const m = autopilotModes(ap);
      // The disconnect warning flashes the AP annunciation.
      const flash = ap.disconnectWarning && Math.floor(d.time * 3) % 2 === 0;
      const vs =
        ap.engaged && ap.vertical === 'vs' ? formatVerticalSpeed(ap.selectedVerticalSpeed) : '';
      return [
        ap.engaged || flash ? 'AP' : '',
        m.lateral,
        m.lateralArmed,
        m.vertical,
        m.verticalArmed,
        vs,
        String(Math.round(ap.selectedAltitude)),
      ].join('|');
    }
    case 'MKR': {
      if (!on || !a) return '';
      const k = a.markers;
      return `${k.outer ? 'O' : ''}${k.middle ? 'M' : ''}${k.inner ? 'I' : ''}`;
    }
    case 'ANN': {
      const s = d.systems;
      if (!s || s.busVolts < 8) return '';
      const n = s.annunciators;
      return [n.lowFuelLeft, n.lowFuelRight, n.oilPressure, n.lowVacuum, n.lowVolts]
        .map((b) => (b ? 1 : 0))
        .join('');
    }
    case 'KOLL':
      return String(Math.round(d.altimeterSetting));
    case 'GPS': {
      if (!on || !a) return '';
      const g = a.gps;
      const range = mapRange(g.distanceNm);
      // Quantised so the map redraws when it would move by about a pixel.
      const q = range / 400;
      return [
        g.plan.map((w) => w.ident).join(','),
        g.active,
        range,
        Math.round(g.lon / (q / 60)),
        Math.round(g.lat / (q / 60)),
        Math.round(g.track / 2),
        g.distanceNm?.toFixed(1) ?? '',
        Math.round(g.desiredTrack ?? -1),
        Math.round(g.groundSpeedKt),
        d.gpsCdi ? 'GPS' : 'VLOC',
      ].join('|');
    }
  }
}

// ---- atlas layout ------------------------------------------------------------------------------

/** Window rectangles in the atlas at scale 1 (desktop: 1024 x 512 pixels). */
export const ATLAS_W = 1024;
export const ATLAS_H = 512;
export const REGIONS: Record<DisplayId, { x: number; y: number; w: number; h: number }> = {
  GPS: { x: 0, y: 0, w: 416, h: 228 },
  COM1: { x: 416, y: 0, w: 300, h: 78 },
  NAV1: { x: 716, y: 0, w: 300, h: 78 },
  COM2: { x: 416, y: 78, w: 300, h: 78 },
  NAV2: { x: 716, y: 78, w: 300, h: 78 },
  ADF: { x: 416, y: 156, w: 384, h: 72 },
  KOLL: { x: 800, y: 156, w: 120, h: 63 },
  DME: { x: 0, y: 228, w: 420, h: 72 },
  XPDR: { x: 420, y: 228, w: 394, h: 72 },
  MKR: { x: 814, y: 228, w: 192, h: 64 },
  AP: { x: 0, y: 300, w: 450, h: 70 },
  ANN: { x: 0, y: 370, w: 1000, h: 88 },
};
/** Windows lit by the panel lights, not by a backlight of their own. */
export const PASSIVE: readonly DisplayId[] = ['KOLL'];

// ---- painting ---------------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;
const SEG = '"DSEG7 Classic", "Consolas", "Lucida Console", monospace';
const SANS = '"Bahnschrift", "Arial Narrow", Arial, sans-serif';
/** The radios' gas-discharge orange, the KAP 140's green-ish LCD, the GPS screen. */
const AMBER = '#ff8a1c';
const LCD = '#d9ffb8';

function clear(c: Ctx, w: number, h: number, color = '#050505') {
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
}

function txt(
  c: Ctx,
  s: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'left',
  font = SEG,
  maxWidth?: number,
) {
  c.fillStyle = color;
  c.font = `600 ${size}px ${font}`;
  c.textAlign = align;
  c.textBaseline = 'middle';
  // Squeezed rather than overflowing into the neighbouring field.
  if (maxWidth !== undefined) c.fillText(s, x, y, maxWidth);
  else c.fillText(s, x, y);
}

/** Paints one window into the atlas context (already translated and scaled to the region). */
export function paint(c: Ctx, id: DisplayId, w: number, h: number, key: string, d: PanelData) {
  const parts = key.split('|');
  if (key === '' && id !== 'ANN' && id !== 'KOLL') {
    clear(c, w, h, '#030303');
    return;
  }
  switch (id) {
    case 'COM1':
    case 'COM2':
    case 'NAV1':
    case 'NAV2': {
      clear(c, w, h);
      txt(c, parts[0]!, w * 0.03, h * 0.58, h * 0.6, AMBER, 'left', SEG, w * 0.45);
      txt(c, parts[1]!, w * 0.97, h * 0.58, h * 0.6, AMBER, 'right', SEG, w * 0.45);
      // Small 'USE' / 'STBY' legends as on a KX 155.
      txt(c, 'USE', w * 0.03, h * 0.12, h * 0.16, AMBER, 'left', SANS);
      txt(c, 'STBY', w * 0.97, h * 0.12, h * 0.16, AMBER, 'right', SANS);
      break;
    }
    case 'ADF': {
      clear(c, w, h);
      txt(c, 'ADF', w * 0.04, h * 0.5, h * 0.3, AMBER, 'left', SANS);
      txt(c, parts[0]!, w * 0.62, h * 0.55, h * 0.66, AMBER, 'right', SEG, w * 0.4);
      txt(c, parts[1] ?? '', w * 0.96, h * 0.55, h * 0.42, AMBER, 'right', SANS);
      break;
    }
    case 'DME': {
      clear(c, w, h);
      txt(c, parts[0]!, w * 0.03, h * 0.5, h * 0.3, '#ff3a1c', 'left', SANS);
      txt(c, parts[1]!, w * 0.42, h * 0.55, h * 0.66, '#ff3a1c', 'right', SEG, w * 0.3);
      txt(c, 'NM', w * 0.43, h * 0.7, h * 0.24, '#ff3a1c', 'left', SANS);
      txt(c, parts[2]!, w * 0.72, h * 0.55, h * 0.66, '#ff3a1c', 'right', SEG, w * 0.2);
      txt(c, 'KT', w * 0.73, h * 0.7, h * 0.24, '#ff3a1c', 'left', SANS);
      txt(c, parts[3]!, w * 0.92, h * 0.55, h * 0.66, '#ff3a1c', 'right', SEG, w * 0.12);
      txt(c, 'MIN', w * 0.93, h * 0.7, h * 0.2, '#ff3a1c', 'left', SANS);
      break;
    }
    case 'XPDR': {
      clear(c, w, h);
      const mode = { standby: 'SBY', on: 'ON', alt: 'ALT', off: '' }[parts[1] as 'on'] ?? '';
      txt(
        c,
        parts[0]!.split('').join(' '),
        w * 0.5,
        h * 0.55,
        h * 0.7,
        AMBER,
        'center',
        SEG,
        w * 0.5,
      );
      txt(c, mode, w * 0.03, h * 0.5, h * 0.34, AMBER, 'left', SANS);
      // Reply light.
      c.fillStyle = parts[2] ? '#ffd23a' : '#1c1408';
      c.beginPath();
      c.arc(w * 0.92, h * 0.5, h * 0.2, 0, Math.PI * 2);
      c.fill();
      txt(c, 'R', w * 0.86, h * 0.5, h * 0.24, parts[2] ? '#ffd23a' : '#3a2c10', 'right', SANS);
      break;
    }
    case 'AP': {
      clear(c, w, h, '#0a0f08');
      const [ap, lat, latArm, ver, verArm, vs, alt] = parts;
      const k = h * 0.36;
      txt(c, ap!, w * 0.02, h * 0.5, k * 1.2, LCD, 'left', SANS);
      txt(c, lat!, w * 0.15, h * 0.32, k, LCD, 'left', SANS);
      txt(c, latArm!, w * 0.15, h * 0.75, k * 0.7, LCD, 'left', SANS);
      txt(c, ver!, w * 0.36, h * 0.32, k, LCD, 'left', SANS);
      txt(c, verArm!, w * 0.36, h * 0.75, k * 0.7, LCD, 'left', SANS);
      if (vs) {
        txt(c, vs, w * 0.72, h * 0.55, h * 0.56, LCD, 'right', SEG, w * 0.18);
        txt(c, 'FPM', w * 0.73, h * 0.72, h * 0.2, LCD, 'left', SANS);
      }
      txt(c, alt!, w * 0.93, h * 0.55, h * 0.56, LCD, 'right', SEG, w * 0.18);
      txt(c, 'FT', w * 0.94, h * 0.72, h * 0.2, LCD, 'left', SANS);
      break;
    }
    case 'MKR': {
      clear(c, w, h, '#0c0c0c');
      const lamps: [string, string, string][] = [
        ['O', '#3d6bff', '#0c1430'],
        ['M', '#ffb020', '#2a1e08'],
        ['I', '#f4f4f4', '#202020'],
      ];
      lamps.forEach(([s, on, off], i) => {
        const lit = key.includes(s);
        c.fillStyle = lit ? on : off;
        c.fillRect(w * (0.04 + i * 0.33), h * 0.12, w * 0.26, h * 0.76);
        txt(c, s, w * (0.17 + i * 0.33), h * 0.52, h * 0.5, lit ? '#111' : '#555', 'center', SANS);
      });
      break;
    }
    case 'ANN': {
      clear(c, w, h, '#080808');
      const lit = key.split('').map((ch) => ch === '1');
      const cells: [string, number, string][] = [
        ['L LOW FUEL', 0, '#ffb21e'],
        ['LOW FUEL R', 1, '#ffb21e'],
        ['OIL PRESS', 2, '#ff2a1a'],
        ['LOW VAC', 3, '#ffb21e'],
        ['VOLTS', 4, '#ff2a1a'],
      ];
      const cw = w / cells.length;
      cells.forEach(([s, i, color]) => {
        const on = !!lit[i];
        c.fillStyle = on ? color : '#141414';
        c.fillRect(i * cw + cw * 0.04, h * 0.12, cw * 0.92, h * 0.76);
        txt(c, s, i * cw + cw / 2, h * 0.52, h * 0.34, on ? '#1a0d00' : '#3c3c3c', 'center', SANS);
      });
      break;
    }
    case 'KOLL': {
      clear(c, w, h, '#0b0b0b');
      txt(c, key, w * 0.5, h * 0.55, h * 0.62, '#f2f2ee', 'center', SANS);
      break;
    }
    case 'GPS':
      paintGps(c, w, h, d, parts[9] ?? 'VLOC');
      break;
  }
}

function paintGps(c: Ctx, w: number, h: number, d: PanelData, cdi: string) {
  const a = d.avionics!;
  const g = a.gps;
  clear(c, w, h, '#06101c');
  const mapW = w * 0.64;
  const range = mapRange(g.distanceNm);
  const px = mapW / range;
  const cx = mapW / 2;
  const cy = h * 0.55;
  c.save();
  c.beginPath();
  c.rect(0, 0, mapW, h);
  c.clip();
  // Range ring.
  c.strokeStyle = '#2a4a66';
  c.lineWidth = Math.max(1, h * 0.006);
  c.beginPath();
  c.arc(cx, cy, mapW * 0.25, 0, Math.PI * 2);
  c.stroke();
  const pt = (wp: Waypoint) => {
    const o = mapOffsetNm(g.lon, g.lat, wp.lon, wp.lat);
    return [cx + o.east * px, cy - o.north * px] as const;
  };
  // Flight plan: flown legs grey, the active leg magenta, the rest white.
  c.lineWidth = Math.max(1.5, h * 0.012);
  for (let i = 1; i < g.plan.length; i++) {
    const [x0, y0] = pt(g.plan[i - 1]!);
    const [x1, y1] = pt(g.plan[i]!);
    c.strokeStyle = i === g.active ? '#ff3cf0' : i < g.active ? '#5a6470' : '#e8e8e8';
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
  }
  g.plan.forEach((wp, i) => {
    const [x, y] = pt(wp);
    c.fillStyle = i === g.active ? '#ff3cf0' : '#e8e8e8';
    c.beginPath();
    c.arc(x, y, h * 0.018, 0, Math.PI * 2);
    c.fill();
    txt(c, wp.ident, x + h * 0.03, y - h * 0.04, h * 0.07, c.fillStyle as string, 'left', SANS);
  });
  // The aircraft, pointing along its track.
  c.translate(cx, cy);
  c.rotate((g.track * Math.PI) / 180);
  c.fillStyle = '#ffffff';
  c.beginPath();
  c.moveTo(0, -h * 0.06);
  c.lineTo(h * 0.035, h * 0.04);
  c.lineTo(0, h * 0.02);
  c.lineTo(-h * 0.035, h * 0.04);
  c.closePath();
  c.fill();
  c.restore();
  txt(c, `${range} NM`, h * 0.03, h * 0.07, h * 0.065, '#8fb4d6', 'left', SANS);
  txt(c, 'N', mapW - h * 0.04, h * 0.07, h * 0.07, '#8fb4d6', 'right', SANS);
  // Data column.
  c.fillStyle = '#0b1828';
  c.fillRect(mapW, 0, w - mapW, h);
  const x = mapW + (w - mapW) * 0.08;
  const rows: [string, string][] = [
    ['WPT', g.active >= 0 ? (g.plan[g.active]?.ident ?? '') : '----'],
    ['DIS', g.distanceNm === undefined ? '--.-' : g.distanceNm.toFixed(1)],
    ['DTK', formatBearing(g.desiredTrack)],
    ['GS', String(Math.round(g.groundSpeedKt))],
    ['TRK', formatBearing(g.track)],
  ];
  rows.forEach(([k, v], i) => {
    const y = h * (0.12 + i * 0.165);
    txt(c, k, x, y, h * 0.065, '#7f9ab4', 'left', SANS);
    txt(c, v, w - (w - mapW) * 0.06, y + h * 0.055, h * 0.1, '#e8f2ff', 'right', SANS);
  });
  // Which source the VOR/ILS indicator follows.
  c.fillStyle = cdi === 'GPS' ? '#ff3cf0' : '#2bd96b';
  c.fillRect(0, h * 0.88, mapW * 0.2, h * 0.12);
  txt(c, cdi, mapW * 0.1, h * 0.94, h * 0.08, '#081018', 'center', SANS);
}

/**
 * The atlas: one canvas, a window redrawn when its key changes, the texture flagged for
 * upload at most `maxHz` times a second.
 */
export class DisplayAtlas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: Ctx;
  private readonly keys = new Map<DisplayId, string>();
  private dirty = false;
  private sinceUpload = Infinity;

  constructor(
    readonly scale: number,
    private readonly maxHz = 6,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(ATLAS_W * scale);
    this.canvas.height = Math.round(ATLAS_H * scale);
    this.ctx = this.canvas.getContext('2d')!;
    clear(this.ctx, this.canvas.width, this.canvas.height, '#030303');
  }

  /** UV rectangle of a window (u0, v0 at the top left; flipY is off). */
  uvRect(id: DisplayId): { u0: number; v0: number; u1: number; v1: number } {
    const r = REGIONS[id];
    return {
      u0: r.x / ATLAS_W,
      v0: r.y / ATLAS_H,
      u1: (r.x + r.w) / ATLAS_W,
      v1: (r.y + r.h) / ATLAS_H,
    };
  }

  /** Repaints what changed; true when the texture should be uploaded now. */
  update(dt: number, data: PanelData): boolean {
    this.sinceUpload += dt;
    for (const id of Object.keys(REGIONS) as DisplayId[]) {
      const key = content(id, data);
      if (this.keys.get(id) === key) continue;
      // The GPS map moves continuously: it waits for the next upload slot.
      if (id === 'GPS' && this.keys.has(id) && this.sinceUpload < 1 / this.maxHz) continue;
      this.keys.set(id, key);
      const r = REGIONS[id];
      const c = this.ctx;
      c.save();
      c.translate(r.x * this.scale, r.y * this.scale);
      c.beginPath();
      c.rect(0, 0, r.w * this.scale, r.h * this.scale);
      c.clip();
      paint(c, id, r.w * this.scale, r.h * this.scale, key, data);
      c.restore();
      this.dirty = true;
    }
    if (this.dirty && this.sinceUpload >= 1 / this.maxHz) {
      this.dirty = false;
      this.sinceUpload = 0;
      return true;
    }
    return false;
  }
}
