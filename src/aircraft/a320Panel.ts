/**
 * The A320's small windows, painted into one canvas atlas: the FCU's speed, heading, altitude
 * and vertical speed windows, the EFIS baro window, the radio management panels, ADF,
 * transponder and rudder trim, the gear indicator, the ECAM control panel, and the legends
 * of the lit push buttons (OFF, ON, FAULT, AVAIL, OPEN, the FCU's green bars, MASTER WARN and
 * CAUT, the autobrake's DECEL and ON) drawn by state. Also the MCDU (the flight plan page) and
 * the standby instrument.
 */
import type { Waypoint } from '@sim';
import type { AtlasPainter, Rect } from './canvasAtlas';
import { type KeyLegend, KEY_LEGENDS, type PanelWindow } from './a320Parts';
import { AB, FONT, MONO, type Ctx, clear, line, poly, rect, txt } from './a320Paint';

const LCD = '#ff9a1e';
const LCD_DIM = '#3a2408';
const LCD_BG = '#0d0904';

/** Atlas regions (pixels at scale 1); their shapes match the model's windows. */
export const PANEL_WINDOW_REGIONS: Readonly<Record<PanelWindow, Rect>> = {
  ECP: { x: 0, y: 0, w: 800, h: 48 },
  ADF: { x: 800, y: 0, w: 176, h: 48 },
  RMP1_COM: { x: 0, y: 48, w: 360, h: 56 },
  RMP1_NAV: { x: 360, y: 48, w: 360, h: 56 },
  ATC: { x: 720, y: 48, w: 176, h: 48 },
  RUDTRIM: { x: 896, y: 48, w: 128, h: 48 },
  RMP2_COM: { x: 0, y: 104, w: 360, h: 56 },
  RMP2_NAV: { x: 360, y: 104, w: 360, h: 56 },
  BARO1: { x: 720, y: 104, w: 144, h: 48 },
  FCU_SPD: { x: 0, y: 160, w: 160, h: 80 },
  FCU_HDG: { x: 160, y: 160, w: 160, h: 80 },
  FCU_ALT: { x: 320, y: 160, w: 232, h: 80 },
  FCU_VS: { x: 552, y: 160, w: 192, h: 80 },
  GEARIND: { x: 744, y: 160, w: 160, h: 80 },
};

const KEY_W = 64;
const KEY_H = 48;
export const KEY_REGIONS: Readonly<Record<KeyLegend, Rect>> = Object.fromEntries(
  KEY_LEGENDS.map((k, i) => [
    k,
    { x: (i % 16) * KEY_W, y: 240 + Math.floor(i / 16) * KEY_H, w: KEY_W, h: KEY_H },
  ]),
) as Record<KeyLegend, Rect>;

export type PanelId = PanelWindow | `KY_${KeyLegend}`;

/** One half of a push button's legend: lit or not. */
export interface LegendHalf {
  text: string;
  color: string;
  lit: boolean;
}
/** 'korry': two halves (FAULT over OFF); 'bars': the FCU's three green bars under a name. */
export type KeyFace =
  | { kind: 'korry'; upper?: LegendHalf; lower?: LegendHalf }
  | { kind: 'bars'; text: string; lit: boolean }
  | { kind: 'master'; text: [string, string]; color: string; lit: boolean };

export interface PanelData {
  powered: boolean;
  spd: { text: string; mach: boolean; managed: boolean };
  hdg: { text: string; managed: boolean };
  alt: { text: string; managed: boolean };
  vs: { text: string };
  baro: { text: string; std: boolean };
  rmp: {
    com1: [string, string];
    nav1: [string, string];
    com2: [string, string];
    nav2: [string, string];
  };
  adf: string;
  atc: { code: string; mode: string; ident: boolean };
  rudderTrim: string;
  gear: { down: boolean; transit: boolean };
  ecp: number;
  keys: Readonly<Record<KeyLegend, KeyFace>>;
}

const half = (h: LegendHalf | undefined) => (h ? `${h.text}${h.lit ? 1 : 0}` : '');
function faceKey(f: KeyFace): string {
  if (f.kind === 'korry') return `k${half(f.upper)}/${half(f.lower)}`;
  if (f.kind === 'bars') return `b${f.lit ? 1 : 0}`;
  return `m${f.lit ? 1 : 0}`;
}

const ECP_KEYS = ['ENG', 'BLEED', 'PRESS', 'ELEC', 'HYD', 'FUEL', 'APU', 'WHEEL', 'F/CTL', 'STS'];

function lcd(c: Ctx, w: number, h: number) {
  clear(c, w, h, LCD_BG);
}

function content(id: PanelId, d: PanelData): string {
  const p = d.powered ? 1 : 0;
  if (id.startsWith('KY_')) return `${p}${faceKey(d.keys[id.slice(3) as KeyLegend])}`;
  switch (id as PanelWindow) {
    case 'FCU_SPD':
      return `${p}${JSON.stringify(d.spd)}`;
    case 'FCU_HDG':
      return `${p}${JSON.stringify(d.hdg)}`;
    case 'FCU_ALT':
      return `${p}${JSON.stringify(d.alt)}`;
    case 'FCU_VS':
      return `${p}${d.vs.text}`;
    case 'BARO1':
      return `${p}${d.baro.text}`;
    case 'RMP1_COM':
      return `${p}${d.rmp.com1.join()}`;
    case 'RMP1_NAV':
      return `${p}${d.rmp.nav1.join()}`;
    case 'RMP2_COM':
      return `${p}${d.rmp.com2.join()}`;
    case 'RMP2_NAV':
      return `${p}${d.rmp.nav2.join()}`;
    case 'ADF':
      return `${p}${d.adf}`;
    case 'ATC':
      return `${p}${JSON.stringify(d.atc)}`;
    case 'RUDTRIM':
      return `${p}${d.rudderTrim}`;
    case 'GEARIND':
      return `${p}${d.gear.down}${d.gear.transit}`;
    case 'ECP':
      return `${p}${d.ecp}`;
  }
}

function paintWindow(c: Ctx, id: PanelId, w: number, h: number, d: PanelData) {
  const k = h / (id.startsWith('KY_') ? KEY_H : (PANEL_WINDOW_REGIONS[id as PanelWindow]?.h ?? h));
  c.save();
  c.scale(k, k);
  const W = w / k;
  const H = h / k;
  if (id.startsWith('KY_')) paintKey(c, W, H, d.powered, d.keys[id.slice(3) as KeyLegend]);
  else paintPanelWindow(c, id as PanelWindow, W, H, d);
  c.restore();
}

function paintKey(c: Ctx, w: number, h: number, powered: boolean, f: KeyFace) {
  clear(c, w, h, '#101113');
  rect(c, 1, 1, w - 2, h - 2, '#2a2c30', 2);
  const on = (lit: boolean) => powered && lit;
  if (f.kind === 'korry') {
    const draw = (hh: LegendHalf | undefined, y: number) => {
      if (!hh) return;
      if (on(hh.lit)) {
        txt(c, hh.text, w / 2, y, 15, hh.color, 'center', FONT, 700);
      } else txt(c, hh.text, w / 2, y, 15, '#2e3034', 'center', FONT, 700);
    };
    draw(f.upper, 14);
    draw(f.lower, 34);
  } else if (f.kind === 'bars') {
    txt(c, f.text, w / 2, 16, 16, '#c9cccc', 'center', FONT, 700);
    for (const x of [-16, 0, 16])
      rect(c, w / 2 + x - 6, 31, 12, 6, on(f.lit) ? AB.green : '#26302a');
  } else {
    const col = on(f.lit) ? f.color : '#2e2020';
    txt(c, f.text[0], w / 2, 15, 15, col, 'center', FONT, 700);
    txt(c, f.text[1], w / 2, 34, 17, col, 'center', FONT, 700);
  }
}

function digits(
  c: Ctx,
  s: string,
  x: number,
  y: number,
  size: number,
  align: CanvasTextAlign = 'center',
) {
  txt(c, s, x, y, size, LCD, align, MONO, 700);
}

function paintPanelWindow(c: Ctx, id: PanelWindow, w: number, h: number, d: PanelData) {
  lcd(c, w, h);
  if (!d.powered) return;
  const lab = (s: string, x: number, y: number, lit = true) =>
    txt(c, s, x, y, 15, lit ? LCD : LCD_DIM, 'center', FONT, 700);
  const dot = (x: number, y: number) => {
    c.fillStyle = LCD;
    c.beginPath();
    c.arc(x, y, 6, 0, Math.PI * 2);
    c.fill();
  };
  switch (id) {
    case 'FCU_SPD':
      lab('SPD', 40, 14, !d.spd.mach);
      lab('MACH', 110, 14, d.spd.mach);
      digits(c, d.spd.text, 70, 52, 40);
      if (d.spd.managed) dot(140, 52);
      break;
    case 'FCU_HDG':
      lab('HDG', 30, 14);
      lab('TRK', 80, 14, false);
      lab('LAT', 130, 14);
      digits(c, d.hdg.text, 70, 52, 40);
      if (d.hdg.managed) dot(140, 52);
      break;
    case 'FCU_ALT':
      lab('ALT', 40, 14);
      lab('LVL/CH', 170, 14);
      digits(c, d.alt.text, 105, 52, 40);
      if (d.alt.managed) dot(212, 52);
      break;
    case 'FCU_VS':
      lab('V/S', 50, 14);
      lab('FPA', 140, 14, false);
      digits(c, d.vs.text, 96, 52, 40);
      break;
    case 'BARO1':
      lab(d.baro.std ? '' : 'QNH', 26, 24);
      digits(c, d.baro.text, 92, 25, 32);
      break;
    case 'RMP1_COM':
    case 'RMP1_NAV':
    case 'RMP2_COM':
    case 'RMP2_NAV': {
      const pair =
        d.rmp[
          (id.startsWith('RMP1')
            ? id.endsWith('COM')
              ? 'com1'
              : 'nav1'
            : id.endsWith('COM')
              ? 'com2'
              : 'nav2') as 'com1'
        ];
      digits(c, pair[0], 90, 29, 34);
      line(c, 180, 6, 180, 50, 2, LCD_DIM);
      digits(c, pair[1], 270, 29, 34);
      break;
    }
    case 'ADF':
      digits(c, d.adf, 88, 25, 32);
      break;
    case 'ATC':
      digits(c, d.atc.code, 70, 25, 32);
      lab(d.atc.mode, 150, 25, d.atc.mode !== 'STBY');
      if (d.atc.ident) lab('ID', 150, 10);
      break;
    case 'RUDTRIM':
      digits(c, d.rudderTrim, 64, 25, 30);
      break;
    case 'GEARIND':
      clear(c, w, h, '#0a0b0c');
      for (const x of [30, 80, 130]) {
        if (d.gear.down)
          poly(
            c,
            [
              [x - 18, 46],
              [x + 18, 46],
              [x, 70],
            ],
            AB.green,
          );
        else
          poly(
            c,
            [
              [x - 18, 46],
              [x + 18, 46],
              [x, 70],
            ],
            '#1d2a1f',
            2,
          );
        txt(c, 'UNLK', x, 24, 15, d.gear.transit ? AB.red : '#2a1515', 'center', FONT, 700);
      }
      break;
    case 'ECP':
      clear(c, w, h, '#101113');
      ECP_KEYS.forEach((s, i) => {
        const x = 40 + i * 80;
        rect(c, x - 36, 4, 72, 40, '#2a2c30', 2);
        txt(c, s, x, 18, 15, '#c9cccc', 'center', FONT, 700);
        rect(c, x - 14, 32, 28, 5, i === d.ecp ? AB.white : '#28292c');
      });
      break;
  }
}

export const PANEL_PAINTER: AtlasPainter<PanelId, PanelData> = {
  width: 1024,
  height: 384,
  regions: {
    ...PANEL_WINDOW_REGIONS,
    ...Object.fromEntries(KEY_LEGENDS.map((k) => [`KY_${k}`, KEY_REGIONS[k]])),
  } as Record<PanelId, Rect>,
  content,
  paint: (c, id, w, h, _key, d) => paintWindow(c, id, w, h, d),
  background: '#0d0904',
};

// =============================================================================================
// MCDU: the flight plan page

export interface McduData {
  on: boolean;
  plan: readonly Waypoint[];
  active: number;
  /** Distances from the aircraft to each waypoint along the plan (NM), and the ground speed. */
  dist: number[];
  gs: number;
  time: number;
  cruiseFl: number;
}

export function mcduKey(d: McduData): string {
  if (!d.on) return 'off';
  return [
    d.active,
    d.plan.map((w) => w.ident).join(','),
    d.dist.map((x) => Math.round(x)).join(','),
    Math.round(d.gs / 10),
    Math.floor(d.time / 60),
    d.cruiseFl,
  ].join('|');
}

export function paintMcdu(c: Ctx, w: number, h: number, d: McduData) {
  clear(c, w, h);
  if (!d.on) return;
  c.save();
  c.scale(w / 512, h / 400);
  const from = d.plan[0]?.ident ?? '';
  txt(c, `FROM ${from}`, 24, 22, 24, AB.white, 'left', MONO, 600);
  txt(c, 'AIB123', 488, 22, 22, AB.white, 'right', MONO, 600);
  txt(c, 'TIME  SPD/ALT', 488, 50, 17, AB.white, 'right', MONO, 500);
  let y = 76;
  const start = Math.max(0, d.active - 1);
  for (let i = start; i < Math.min(d.plan.length, start + 5); i++) {
    const wp = d.plan[i]!;
    const col = i === d.active ? AB.white : AB.green;
    txt(c, wp.ident, 24, y + 14, 26, col, 'left', MONO, 700);
    const eta = d.gs > 50 ? d.time + 12 * 3600 + (d.dist[i]! / d.gs) * 3600 : undefined;
    const t =
      eta === undefined
        ? '----'
        : `${String(Math.floor((eta % 86400) / 3600)).padStart(2, '0')}${String(Math.floor((eta % 3600) / 60)).padStart(2, '0')}`;
    txt(c, t, 300, y + 14, 24, AB.green, 'right', MONO, 600);
    const alt =
      wp.altitude !== undefined
        ? String(Math.round(wp.altitude / 0.3048 / 10) * 10)
        : `FL${d.cruiseFl}`;
    txt(
      c,
      `250/${alt}`,
      488,
      y + 14,
      22,
      i === d.plan.length - 1 ? AB.magenta : AB.green,
      'right',
      MONO,
      600,
    );
    if (i > start)
      txt(
        c,
        `${Math.round(d.dist[i]! - d.dist[i - 1]!)}NM`,
        120,
        y - 4,
        16,
        AB.green,
        'left',
        MONO,
        500,
      );
    y += 54;
  }
  line(c, 24, 352, 488, 352, 1, AB.white);
  txt(c, `DEST   TIME  DIST`, 24, 366, 17, AB.white, 'left', MONO, 500);
  const last = d.plan[d.plan.length - 1];
  txt(c, `${last?.ident ?? ''}`, 24, 388, 22, AB.white, 'left', MONO, 700);
  txt(
    c,
    `${Math.round(d.dist[d.dist.length - 1] ?? 0)}`,
    400,
    388,
    22,
    AB.green,
    'right',
    MONO,
    600,
  );
  c.restore();
}

// =============================================================================================
// ISIS: the integrated standby instrument

export interface IsisData {
  on: boolean;
  pitch: number;
  bank: number;
  ias: number;
  alt: number;
  baro: number;
  heading: number;
}

export function isisKey(d: IsisData): string {
  if (!d.on) return 'off';
  return [
    Math.round(d.pitch * 5),
    Math.round(d.bank * 3),
    Math.round(d.ias),
    Math.round(d.alt / 10),
    Math.round(d.baro),
    Math.round(d.heading),
  ].join('|');
}

export function paintIsis(c: Ctx, w: number, h: number, d: IsisData) {
  clear(c, w, h);
  if (!d.on) return;
  c.save();
  c.scale(w / 256, h / 256);
  c.save();
  c.beginPath();
  c.rect(52, 20, 152, 200);
  c.clip();
  c.translate(128, 120);
  c.rotate((-d.bank * Math.PI) / 180);
  c.translate(0, d.pitch * 4);
  rect(c, -300, -400, 600, 400, AB.sky);
  rect(c, -300, 0, 600, 400, AB.ground);
  line(c, -300, 0, 300, 0, 2, AB.white);
  for (const p of [-20, -10, 10, 20]) line(c, -20, -p * 4, 20, -p * 4, 2, AB.white);
  c.restore();
  for (const s of [-1, 1]) line(c, 128 + s * 18, 120, 128 + s * 48, 120, 4, AB.yellow);
  rect(c, 125, 117, 6, 6, AB.yellow);
  // Speed and altitude as plain windows.
  rect(c, 2, 104, 50, 32, AB.black);
  rect(c, 2, 104, 50, 32, AB.white, 1.5);
  txt(c, String(Math.round(d.ias)), 27, 120, 20, AB.white);
  rect(c, 204, 104, 50, 32, AB.black);
  rect(c, 204, 104, 50, 32, AB.white, 1.5);
  txt(c, String(Math.round(d.alt / 10) * 10), 229, 120, 15, AB.green);
  rect(c, 0, 222, 256, 34, '#151719');
  txt(c, `${Math.round(d.baro)} hPa`, 200, 240, 16, AB.blue);
  const hd = Math.round(((d.heading % 360) + 360) % 360);
  txt(c, String(hd).padStart(3, '0'), 60, 240, 18, AB.white);
  c.restore();
}
