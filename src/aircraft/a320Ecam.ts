/**
 * The A320's ECAM displays painted into canvases (768 x 768): the engine/warning display
 * (N1 with its limit, the thrust lever angle donut and the digits, EGT, N2, fuel flow, the
 * thrust limit mode, fuel on board, the slat and flap indicator, warnings, cautions and memo)
 * and the system display's pages in the Airbus manner (ENG, BLEED, PRESS, ELEC, HYD, FUEL,
 * APU, WHEEL, F/CTL, STATUS) with the permanent data at the bottom.
 */
import type { EcamPage } from './a320Format';
import { AB, type Ctx, arc, clear, line, poly, polar, q, rect, txt } from './a320Paint';

const W = 768;

// =============================================================================================
// E/WD

export interface EngineDisplay {
  n1: number;
  /** N1 the thrust lever asks for (the white donut), undefined at idle. */
  n1Cmd: number | undefined;
  egt: number;
  n2: number;
  /** kg/h */
  ff: number;
  running: boolean;
  starting: boolean;
  reverse: boolean;
}

export interface EwdData {
  on: boolean;
  engines: [EngineDisplay, EngineDisplay];
  thrustMode: string;
  thrustN1: number;
  flexTemp: number | undefined;
  /** kg */
  fob: number;
  slats: number;
  flaps: number;
  config: string;
  warnings: readonly string[];
  cautions: readonly string[];
  memo: readonly string[];
  time: number;
}

export function ewdKey(d: EwdData): string {
  if (!d.on) return 'off';
  return [
    ...d.engines.map((e) =>
      [
        q(e.n1, 0.1),
        q(e.n1Cmd, 0.5),
        q(e.egt, 1),
        q(e.n2, 0.1),
        q(e.ff, 20),
        e.running,
        e.starting,
        e.reverse,
      ].join(','),
    ),
    d.thrustMode,
    q(d.thrustN1, 0.1),
    q(d.flexTemp, 1),
    q(d.fob, 20),
    q(d.slats, 0.5),
    q(d.flaps, 0.5),
    d.config,
    d.warnings.join(';'),
    d.cautions.join(';'),
    d.memo.join(';'),
    d.warnings.length ? Math.floor(d.time * 2) % 2 : 0,
  ].join('|');
}

const N1_A0 = -135;
const N1_A1 = 75;
const n1Angle = (n1: number) =>
  N1_A0 + ((Math.min(Math.max(n1, 0), 110) - 0) / 110) * (N1_A1 - N1_A0);
const EGT_A0 = -120;
const EGT_A1 = 60;
const egtAngle = (t: number) =>
  EGT_A0 + (Math.min(Math.max(t, 0), 1200) / 1200) * (EGT_A1 - EGT_A0);

export function paintEwd(c: Ctx, w: number, h: number, d: EwdData) {
  clear(c, w, h);
  if (!d.on) return;
  c.save();
  c.scale(w / W, h / W);
  const cols = [200, 456];
  d.engines.forEach((e, i) => {
    const cx = cols[i]!;
    // N1.
    const cy = 140;
    const R = 92;
    arc(c, cx, cy, R, N1_A0, n1Angle(104), 3, AB.white);
    arc(c, cx, cy, R, n1Angle(104), n1Angle(110), 6, AB.red);
    for (const v of [20, 40, 60, 80, 100]) {
      const a = n1Angle(v);
      const [x0, y0] = polar(cx, cy, R, a);
      const [x1, y1] = polar(cx, cy, R - 12, a);
      line(c, x0, y0, x1, y1, 3, AB.white);
      if (v === 50 || v === 100) {
        const [tx, ty] = polar(cx, cy, R - 30, a);
        txt(c, String(v / 10), tx, ty, 20, AB.white);
      }
    }
    for (const v of [50]) {
      const a = n1Angle(v);
      const [x0, y0] = polar(cx, cy, R, a);
      const [x1, y1] = polar(cx, cy, R - 12, a);
      line(c, x0, y0, x1, y1, 3, AB.white);
      const [tx, ty] = polar(cx, cy, R - 30, a);
      txt(c, '5', tx, ty, 20, AB.white);
    }
    // Thrust limit (amber tick) and the lever's donut.
    {
      const a = n1Angle(d.thrustN1);
      const [x0, y0] = polar(cx, cy, R + 2, a);
      const [x1, y1] = polar(cx, cy, R + 16, a);
      line(c, x0, y0, x1, y1, 4, AB.amber);
    }
    if (e.n1Cmd !== undefined) {
      const [x, y] = polar(cx, cy, R + 10, n1Angle(e.n1Cmd));
      c.strokeStyle = AB.white;
      c.lineWidth = 3;
      c.beginPath();
      c.arc(x, y, 7, 0, Math.PI * 2);
      c.stroke();
    }
    if (e.running || e.n1 > 2) {
      const [x, y] = polar(cx, cy, R + 4, n1Angle(e.n1));
      line(c, cx, cy, x, y, 4, AB.green);
    }
    rect(c, cx + 2, cy + 8, 92, 40, AB.grey, 2);
    txt(c, e.n1.toFixed(1), cx + 88, cy + 29, 32, AB.green, 'right');
    if (e.reverse) {
      rect(c, cx - 36, cy - 60, 72, 34, AB.black);
      txt(c, 'REV', cx, cy - 43, 26, AB.green);
    }
    // EGT.
    const ey = 300;
    const r = 62;
    arc(c, cx, ey, r, EGT_A0, egtAngle(850), 3, AB.white);
    arc(c, cx, ey, r, egtAngle(850), egtAngle(950), 3, AB.amber);
    arc(c, cx, ey, r, egtAngle(950), EGT_A1, 6, AB.red);
    if (e.running || e.egt > 100) {
      const [x, y] = polar(cx, ey, r + 4, egtAngle(e.egt));
      line(c, cx, ey, x, y, 4, AB.green);
    }
    txt(
      c,
      String(Math.round(e.egt)),
      cx + 52,
      ey + 30,
      30,
      e.egt > 950 ? AB.red : AB.green,
      'right',
    );
    // N2 (in a grey box while starting) and fuel flow.
    if (e.starting) rect(c, cx - 64, 382, 110, 36, AB.dark);
    txt(c, e.n2.toFixed(1), cx + 40, 400, 30, AB.green, 'right');
    txt(c, String(Math.round(e.ff)), cx + 40, 446, 30, AB.green, 'right');
  });
  txt(c, 'N1', 328, 150, 22, AB.white);
  txt(c, '%', 328, 174, 20, AB.blue);
  txt(c, 'EGT', 328, 300, 22, AB.white);
  txt(c, '°C', 328, 324, 20, AB.blue);
  txt(c, 'N2', 328, 392, 22, AB.white);
  txt(c, '%', 328, 414, 20, AB.blue);
  txt(c, 'F.F', 328, 440, 22, AB.white);
  txt(c, 'KG/H', 328, 462, 18, AB.blue);
  // Thrust limit.
  txt(c, d.thrustMode, 650, 40, 30, AB.blue);
  txt(c, `${d.thrustN1.toFixed(1)}`, 680, 76, 30, AB.green, 'right');
  txt(c, '%', 704, 78, 22, AB.blue);
  if (d.thrustMode === 'FLX' && d.flexTemp !== undefined)
    txt(c, `${Math.round(d.flexTemp)}°C`, 680, 108, 24, AB.blue);
  // Fuel on board.
  txt(c, 'FOB :', 30, 522, 26, AB.white, 'left');
  txt(c, String(Math.round(d.fob)), 230, 522, 30, AB.green, 'right');
  txt(c, 'KG', 240, 524, 22, AB.blue, 'left');
  slatsFlaps(c, d);
  // Lower: warnings and cautions left, memo; a white line between upper and lower parts.
  line(c, 20, 556, 520, 556, 3, AB.white);
  line(c, 540, 556, 748, 556, 3, AB.white);
  let y = 590;
  const flash = Math.floor(d.time * 2) % 2 === 0;
  for (const s of d.warnings) {
    if (flash || y > 590) txt(c, s, 30, y, 25, AB.red, 'left');
    y += 30;
  }
  for (const s of d.cautions) {
    txt(c, s, 30, y, 25, AB.amber, 'left');
    y += 30;
  }
  for (const s of d.memo) {
    if (y > 750) break;
    txt(c, s, 30, y, 25, AB.green, 'left');
    y += 30;
  }
  c.restore();
}

function slatsFlaps(c: Ctx, d: EwdData) {
  const x = 640;
  const y = 482;
  txt(c, 'S', x - 92, y - 26, 22, AB.white);
  txt(c, 'F', x + 104, y - 26, 22, AB.white);
  poly(
    c,
    [
      [x - 18, y - 12],
      [x + 30, y - 12],
      [x + 36, y + 6],
      [x - 18, y + 6],
    ],
    AB.white,
    2,
  );
  // Slat track (left, down) and flap track (right, down) with their position marks.
  const slatPts = [0, 18, 22, 27].map(
    (_a, i) => [x - 30 - i * 26, y + 4 + i * 9] as [number, number],
  );
  const flapPts = [0, 10, 15, 20, 40].map(
    (_a, i) => [x + 48 + i * 22, y + 8 + i * 9] as [number, number],
  );
  for (const p of slatPts.slice(1)) rect(c, p[0] - 3, p[1] - 3, 6, 6, AB.white);
  for (const p of flapPts.slice(1)) rect(c, p[0] - 3, p[1] - 3, 6, 6, AB.white);
  const along = (pts: [number, number][], stops: number[], v: number): [number, number] => {
    for (let i = 1; i < stops.length; i++)
      if (v <= stops[i]! || i === stops.length - 1) {
        const t = Math.min(Math.max((v - stops[i - 1]!) / (stops[i]! - stops[i - 1]!), 0), 1);
        const a = pts[i - 1]!;
        const b = pts[i]!;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
    return pts[0]!;
  };
  const moving = d.config === '';
  const col = moving ? AB.blue : AB.green;
  const s = along(slatPts, [0, 18, 22, 27], d.slats);
  const f = along(flapPts, [0, 10, 15, 20, 35], d.flaps);
  poly(
    c,
    [
      [x - 18, y - 4],
      [s[0], s[1] - 6],
      [s[0], s[1] + 6],
    ],
    col,
  );
  poly(
    c,
    [
      [x + 34, y],
      [f[0], f[1] - 6],
      [f[0] + 4, f[1] + 6],
    ],
    col,
  );
  if (d.slats > 0.5 || d.flaps > 0.5 || d.config)
    txt(c, d.config || '', x + 8, y + 52, 28, AB.green);
}

// =============================================================================================
// SD

export interface SdData {
  on: boolean;
  page: EcamPage;
  engines: [SdEngine, SdEngine];
  apu: { master: boolean; avail: boolean; n: number; egt: number; bleed: boolean; gen: boolean };
  elec: {
    bat: [number, number];
    batOn: [boolean, boolean];
    gen: [boolean, boolean];
    ext: boolean;
    extOn: boolean;
  };
  bleed: { eng: [boolean, boolean]; packs: [boolean, boolean]; xbleed: boolean };
  /** Hydraulic pressures (psi) green, blue, yellow, and whether each pump is on. */
  hyd: { psi: [number, number, number]; pumps: [boolean, boolean, boolean]; yellowElec: boolean };
  /** kg left, centre, right; pumps on per tank; crossfeed open. */
  fuel: {
    tanks: [number, number, number];
    pumps: [boolean, boolean, boolean];
    xfeed: boolean;
    used: number;
  };
  press: { cabinAlt: number; diff: number; rate: number };
  /** 0 up .. 1 down; brake temperatures per wheel (deg C); autobrake mode text. */
  wheel: {
    gear: number;
    down: boolean;
    transit: boolean;
    brakes: [number, number, number, number];
    autobrake: string;
    parking: boolean;
  };
  fctl: {
    aileronL: number;
    aileronR: number;
    elevator: number;
    rudder: number;
    spoilers: number[];
    trim: number;
    law: string;
  };
  status: readonly string[];
  tat: number;
  sat: number;
  gw: number;
  time: number;
}

export interface SdEngine {
  running: boolean;
  oilQt: number;
  oilPsi: number;
  oilT: number;
  vibN1: number;
  vibN2: number;
  used: number;
}

export function sdKey(d: SdData): string {
  if (!d.on) return 'off';
  const common = [d.page, q(d.tat, 1), q(d.sat, 1), q(d.gw, 100), Math.floor(d.time / 60)];
  switch (d.page) {
    case 'engine':
      return [
        ...common,
        JSON.stringify(
          d.engines.map((e) => [e.running, q(e.oilPsi, 1), q(e.oilT, 1), q(e.used, 10)]),
        ),
      ].join('|');
    case 'bleed':
      return [
        ...common,
        JSON.stringify(d.bleed),
        d.apu.bleed,
        d.apu.avail,
        d.engines[0].running,
        d.engines[1].running,
      ].join('|');
    case 'press':
      return [...common, q(d.press.cabinAlt, 50), q(d.press.diff, 0.1), q(d.press.rate, 50)].join(
        '|',
      );
    case 'elec':
      return [
        ...common,
        JSON.stringify(d.elec),
        d.apu.gen,
        d.apu.avail,
        d.engines.map((e) => e.running).join(),
      ].join('|');
    case 'hyd':
      return [
        ...common,
        JSON.stringify(d.hyd.psi.map((p) => Math.round(p / 50))),
        d.hyd.pumps.join(),
        d.hyd.yellowElec,
      ].join('|');
    case 'fuel':
      return [
        ...common,
        JSON.stringify(d.fuel.tanks.map((t) => Math.round(t / 20))),
        d.fuel.pumps.join(),
        d.fuel.xfeed,
        q(d.fuel.used, 10),
      ].join('|');
    case 'apu':
      return [...common, JSON.stringify(d.apu), q(d.apu.n, 1), q(d.apu.egt, 5)].join('|');
    case 'wheel':
      return [
        ...common,
        q(d.wheel.gear, 0.05),
        d.wheel.brakes.map((b) => Math.round(b / 5)).join(),
        d.wheel.autobrake,
        d.wheel.parking,
      ].join('|');
    case 'fctl':
      return [
        ...common,
        q(d.fctl.aileronL, 0.02),
        q(d.fctl.aileronR, 0.02),
        q(d.fctl.elevator, 0.02),
        q(d.fctl.rudder, 0.02),
        d.fctl.spoilers.map((s) => Math.round(s / 2)).join(),
        q(d.fctl.trim, 0.1),
        d.fctl.law,
      ].join('|');
    case 'status':
      return [...common, d.status.join(';')].join('|');
  }
}

const TITLE: Record<EcamPage, string> = {
  engine: 'ENGINE',
  bleed: 'BLEED',
  press: 'CAB PRESS',
  elec: 'ELEC',
  hyd: 'HYD',
  fuel: 'FUEL',
  apu: 'APU',
  wheel: 'WHEEL',
  fctl: 'F/CTL',
  status: 'STATUS',
};

export function paintSd(c: Ctx, w: number, h: number, d: SdData) {
  clear(c, w, h);
  if (!d.on) return;
  c.save();
  c.scale(w / W, h / W);
  txt(c, TITLE[d.page], 24, 30, 28, AB.white, 'left');
  c.font = `600 28px "Segoe UI", Arial, sans-serif`;
  line(c, 24, 48, 24 + c.measureText(TITLE[d.page]).width, 48, 2, AB.white);
  PAGES[d.page](c, d);
  // The permanent data.
  line(c, 0, 660, W, 660, 3, AB.white);
  line(c, 256, 660, 256, 768, 3, AB.white);
  line(c, 512, 660, 512, 768, 3, AB.white);
  txt(c, 'TAT', 20, 690, 22, AB.white, 'left');
  txt(c, `${d.tat >= 0 ? '+' : ''}${Math.round(d.tat)}`, 160, 690, 24, AB.green, 'right');
  txt(c, '°C', 170, 690, 20, AB.blue, 'left');
  txt(c, 'SAT', 20, 726, 22, AB.white, 'left');
  txt(c, `${d.sat >= 0 ? '+' : ''}${Math.round(d.sat)}`, 160, 726, 24, AB.green, 'right');
  txt(c, '°C', 170, 726, 20, AB.blue, 'left');
  const t = (d.time + 12 * 3600) % 86400;
  txt(c, String(Math.floor(t / 3600)).padStart(2, '0'), 360, 708, 30, AB.green, 'right');
  txt(c, 'H', 376, 710, 22, AB.blue);
  txt(c, String(Math.floor((t % 3600) / 60)).padStart(2, '0'), 392, 708, 26, AB.green, 'left');
  txt(c, 'GW', 530, 708, 22, AB.white, 'left');
  txt(c, String(Math.round(d.gw / 100) * 100), 700, 708, 28, AB.green, 'right');
  txt(c, 'KG', 708, 710, 20, AB.blue, 'left');
  c.restore();
}

const val = (c: Ctx, v: string, x: number, y: number, color: string = AB.green, size = 26) =>
  txt(c, v, x, y, size, color, 'right');
const unit = (c: Ctx, u: string, x: number, y: number) => txt(c, u, x, y, 20, AB.blue);

/** A valve: a circle with its bar along the flow (open) or across it (shut). */
function valve(
  c: Ctx,
  x: number,
  y: number,
  open: boolean,
  vertical = true,
  color: string = AB.green,
) {
  c.strokeStyle = color;
  c.lineWidth = 3;
  c.beginPath();
  c.arc(x, y, 14, 0, Math.PI * 2);
  c.stroke();
  if (open === vertical) line(c, x, y - 14, x, y + 14, 3, color);
  else line(c, x - 14, y, x + 14, y, 3, color);
}

function pump(c: Ctx, x: number, y: number, on: boolean, color: string) {
  rect(c, x - 16, y - 16, 32, 32, color, 3);
  if (on) line(c, x, y - 16, x, y + 16, 3, color);
  else line(c, x - 10, y, x + 10, y, 3, AB.amber);
}

const PAGES: Record<EcamPage, (c: Ctx, d: SdData) => void> = {
  engine(c, d) {
    const cols = [190, 578];
    txt(c, 'F.USED', 384, 100, 22, AB.white);
    unit(c, 'KG', 384, 124);
    txt(c, 'OIL', 384, 176, 22, AB.white);
    unit(c, 'QT', 384, 200);
    unit(c, 'PSI', 384, 330);
    txt(c, '°C', 384, 430, 20, AB.blue);
    txt(c, 'VIB N1', 384, 500, 22, AB.white);
    txt(c, 'VIB N2', 384, 548, 22, AB.white);
    d.engines.forEach((e, i) => {
      const x = cols[i]!;
      val(c, String(Math.round(e.used / 10) * 10), x + 40, 112);
      arc(c, x, 225, 46, -120, 120, 3, AB.white);
      const [qx, qy] = polar(x, 225, 50, -120 + (Math.min(e.oilQt, 25) / 25) * 240);
      line(c, x, 225, qx, qy, 4, AB.green);
      val(c, e.oilQt.toFixed(1), x + 30, 262, AB.green, 24);
      arc(c, x, 340, 46, -120, 120, 3, AB.white);
      arc(c, x, 340, 46, -120, -100, 6, AB.red);
      const [px, py] = polar(x, 340, 50, -120 + (Math.min(e.oilPsi, 100) / 100) * 240);
      line(c, x, 340, px, py, 4, e.running && e.oilPsi < 13 ? AB.red : AB.green);
      val(c, String(Math.round(e.oilPsi)), x + 24, 378, AB.green, 24);
      val(c, String(Math.round(e.oilT)), x + 30, 430);
      val(c, e.vibN1.toFixed(1), x + 30, 500);
      val(c, e.vibN2.toFixed(1), x + 30, 548);
    });
    txt(c, 'NAC', 384, 610, 22, AB.white);
  },
  bleed(c, d) {
    const cols = [200, 568];
    const apuOpen = d.apu.bleed && d.apu.avail;
    line(c, 200, 330, 568, 330, 3, AB.green);
    valve(c, 384, 330, d.bleed.xbleed, false);
    txt(c, 'X BLEED', 384, 296, 18, AB.white);
    d.bleed.eng.forEach((on, i) => {
      const x = cols[i]!;
      const run = d.engines[i]!.running;
      const open = on && run;
      line(c, x, 330, x, 560, 3, AB.green);
      valve(c, x, 480, open);
      txt(c, String(i + 1), x, 610, 30, AB.white);
      txt(c, 'HP', x + 46, 540, 18, AB.white);
      txt(c, 'IP', x - 46, 560, 18, AB.white);
      val(c, String(open ? 42 : 0), x + 30, 430, AB.green, 24);
      unit(c, 'PSI', x - 30, 430);
      val(c, String(open ? 180 : 15), x + 30, 400, AB.green, 24);
      unit(c, '°C', x - 30, 400);
      // Packs.
      rect(c, x - 60, 160, 120, 80, AB.white, 2);
      txt(c, `PACK ${i + 1}`, x, 140, 20, AB.white);
      valve(c, x, 280, d.bleed.packs[i]! && (run || apuOpen));
      val(c, String(d.bleed.packs[i] ? 14 : 0), x + 24, 196, AB.green, 24);
      txt(c, '°C', x + 38, 198, 18, AB.blue);
      line(c, x, 240, x, 266, 3, AB.green);
      line(c, x, 294, x, 330, 3, AB.green);
    });
    line(c, 384, 330, 384, 530, 3, AB.green);
    valve(c, 384, 480, apuOpen);
    txt(c, 'APU', 384, 560, 22, AB.white);
    txt(c, 'RAM AIR', 384, 110, 18, AB.white);
  },
  press(c, d) {
    txt(c, 'ΔP', 150, 130, 22, AB.white);
    arc(c, 150, 230, 70, -120, 120, 3, AB.white);
    const [dx, dy] = polar(
      150,
      230,
      74,
      -120 + ((Math.min(Math.max(d.press.diff, -1), 9) + 1) / 10) * 240,
    );
    line(c, 150, 230, dx, dy, 4, AB.green);
    val(c, d.press.diff.toFixed(1), 200, 280);
    unit(c, 'PSI', 150, 310);
    txt(c, 'V/S', 384, 130, 22, AB.white);
    arc(c, 384, 230, 70, -150, -30, 3, AB.white);
    const rate = Math.max(-2000, Math.min(2000, d.press.rate));
    const [vx, vy] = polar(384, 230, 74, -90 + (rate / 2000) * 60);
    line(c, 384, 230, vx, vy, 4, AB.green);
    val(c, String(Math.round(d.press.rate / 50) * 50), 430, 280);
    unit(c, 'FT/MIN', 384, 310);
    txt(c, 'CAB ALT', 618, 130, 22, AB.white);
    arc(c, 618, 230, 70, -120, 120, 3, AB.white);
    arc(c, 618, 230, 70, 90, 120, 6, AB.red);
    const [ax, ay] = polar(
      618,
      230,
      74,
      -120 + ((Math.min(Math.max(d.press.cabinAlt, -625), 10000) + 625) / 10625) * 240,
    );
    line(c, 618, 230, ax, ay, 4, d.press.cabinAlt > 9550 ? AB.red : AB.green);
    val(c, String(Math.round(d.press.cabinAlt / 50) * 50), 680, 280);
    unit(c, 'FT', 618, 310);
    // Fuselage outline with the outflow valve and the packs.
    poly(
      c,
      [
        [110, 380],
        [660, 380],
        [700, 420],
        [700, 560],
        [110, 560],
      ],
      AB.white,
      2,
    );
    txt(c, 'MAN', 600, 440, 18, AB.white);
    valve(c, 600, 520, true);
    txt(c, 'PACK 1', 220, 610, 20, AB.white);
    txt(c, 'PACK 2', 460, 610, 20, AB.white);
    txt(c, 'SYS 1', 270, 420, 20, AB.green);
  },
  elec(c, d) {
    const box = (x: number, y: number, title: string, on: boolean, lines: [string, string][]) => {
      rect(c, x - 70, y - 30, 140, 30 + lines.length * 30, on ? AB.white : AB.amber, 2);
      txt(c, title, x, y - 12, 22, on ? AB.white : AB.amber);
      lines.forEach(([v, u], i) => {
        val(c, v, x + 18, y + 16 + i * 30, on ? AB.green : AB.amber, 24);
        txt(c, u, x + 44, y + 18 + i * 30, 18, AB.blue);
      });
    };
    d.elec.bat.forEach((v, i) => {
      const x = i ? 520 : 248;
      box(x, 90, `BAT ${i + 1}`, d.elec.batOn[i]!, [
        [v.toFixed(0), 'V'],
        [d.elec.batOn[i] ? '-2' : '0', 'A'],
      ]);
    });
    rect(c, 330, 70, 108, 40, AB.white, 2);
    txt(c, 'DC BAT', 384, 90, 22, AB.green);
    for (const [x, t] of [
      [120, 'DC 1'],
      [648, 'DC 2'],
    ] as const) {
      rect(c, x - 60, 230, 120, 40, AB.white, 2);
      txt(c, t, x, 250, 22, AB.green);
    }
    for (const [x, t] of [
      [120, 'AC 1'],
      [648, 'AC 2'],
    ] as const) {
      rect(c, x - 60, 380, 120, 40, AB.white, 2);
      txt(c, t, x, 400, 22, AB.green);
    }
    txt(c, 'AC ESS', 384, 400, 22, AB.green);
    rect(c, 320, 380, 128, 40, AB.white, 2);
    d.elec.gen.forEach((on, i) => {
      const x = i ? 648 : 120;
      const run = d.engines[i]!.running;
      box(x, 520, `GEN ${i + 1}`, on && run, [
        [run && on ? '28' : '0', '%'],
        [run && on ? '115' : '0', 'V'],
        [run && on ? '400' : '0', 'HZ'],
      ]);
      if (on && run) line(c, x, 490, x, 420, 3, AB.green);
    });
    const apuGen = d.apu.gen && d.apu.avail;
    box(
      384,
      520,
      'APU GEN',
      apuGen || !d.apu.master,
      apuGen
        ? [
            ['0', '%'],
            ['115', 'V'],
            ['400', 'HZ'],
          ]
        : [],
    );
    if (d.elec.ext) {
      rect(c, 450, 600, 120, 44, AB.white, 2);
      txt(c, 'EXT PWR', 510, 622, 20, d.elec.extOn ? AB.green : AB.white);
    }
  },
  hyd(c, d) {
    const names = ['GREEN', 'BLUE', 'YELLOW'];
    const xs = [150, 384, 618];
    names.forEach((n, i) => {
      const x = xs[i]!;
      const psi = d.hyd.psi[i]!;
      const ok = psi > 1450;
      txt(c, n, x, 90, 26, ok ? AB.white : AB.amber);
      val(c, String(Math.round(psi / 50) * 50), x + 36, 130, ok ? AB.green : AB.amber, 30);
      poly(
        c,
        [
          [x, 160],
          [x - 12, 180],
          [x + 12, 180],
        ],
        ok ? AB.green : AB.amber,
      );
      line(c, x, 180, x, 560, 3, ok ? AB.green : AB.amber);
      pump(c, x, 400, d.hyd.pumps[i]!, ok ? AB.green : AB.amber);
      txt(c, i === 1 ? 'ELEC' : `ENG ${i === 0 ? 1 : 2}`, x, 450, 20, AB.white);
      rect(c, x - 30, 560, 60, 60, AB.white, 2);
      txt(c, 'LO AIR', x, 640, 16, AB.white);
    });
    line(c, 150, 300, 618, 300, 3, AB.green);
    txt(c, 'PTU', 384, 280, 20, AB.white);
    if (d.hyd.yellowElec) txt(c, 'ELEC', 700, 360, 20, AB.green);
  },
  fuel(c, d) {
    const [l, ctr, r] = d.fuel.tanks;
    txt(c, 'F.USED', 384, 90, 22, AB.white);
    val(c, String(Math.round(d.fuel.used / 10) * 10), 420, 120);
    unit(c, 'KG', 450, 120);
    poly(
      c,
      [
        [40, 420],
        [270, 380],
        [270, 540],
        [40, 520],
      ],
      AB.white,
      2,
    );
    poly(
      c,
      [
        [728, 420],
        [498, 380],
        [498, 540],
        [728, 520],
      ],
      AB.white,
      2,
    );
    rect(c, 290, 380, 188, 160, AB.white, 2);
    val(c, String(Math.round(l / 20) * 20), 230, 470, AB.green, 30);
    val(c, String(Math.round(ctr / 20) * 20), 430, 470, AB.green, 30);
    val(c, String(Math.round(r / 20) * 20), 680, 470, AB.green, 30);
    txt(c, 'KG', 384, 510, 20, AB.blue);
    d.fuel.pumps.forEach((on, i) => {
      const x = [160, 384, 608][i]!;
      pump(c, x, 330, on, AB.green);
      line(c, x, 314, x, 230, 3, AB.green);
    });
    line(c, 160, 230, 608, 230, 3, AB.green);
    valve(c, 384, 230, d.fuel.xfeed, false);
    for (const [x, n] of [
      [160, '1'],
      [608, '2'],
    ] as const) {
      valve(c, x, 170, true);
      txt(c, n, x, 120, 30, AB.white);
    }
    txt(c, 'FOB', 60, 600, 24, AB.white, 'left');
    val(c, String(Math.round((l + ctr + r) / 20) * 20), 300, 600);
    unit(c, 'KG', 330, 600);
  },
  apu(c, d) {
    const ok = d.apu.avail;
    txt(c, d.apu.avail ? 'AVAIL' : '', 384, 90, 26, AB.green);
    rect(c, 80, 120, 150, 120, AB.white, 2);
    txt(c, 'APU GEN', 155, 140, 22, AB.white);
    val(c, ok && d.apu.gen ? '0' : '0', 180, 170, AB.green, 24);
    txt(c, '%', 200, 172, 18, AB.blue);
    val(c, ok && d.apu.gen ? '115' : '0', 180, 200, AB.green, 24);
    txt(c, 'V', 200, 202, 18, AB.blue);
    val(c, ok && d.apu.gen ? '400' : '0', 180, 228, AB.green, 24);
    txt(c, 'HZ', 205, 230, 18, AB.blue);
    txt(c, 'APU BLEED', 560, 140, 22, AB.white);
    valve(c, 560, 220, d.apu.bleed && ok);
    txt(c, 'N', 200, 330, 26, AB.white);
    arc(c, 200, 420, 70, -120, 100, 3, AB.white);
    arc(c, 200, 420, 70, 100, 120, 6, AB.red);
    const [nx, ny] = polar(200, 420, 74, -120 + (Math.min(d.apu.n, 110) / 110) * 240);
    line(c, 200, 420, nx, ny, 4, AB.green);
    val(c, String(Math.round(d.apu.n)), 250, 470);
    unit(c, '%', 200, 500);
    txt(c, 'EGT', 560, 330, 26, AB.white);
    arc(c, 560, 420, 70, -120, 80, 3, AB.white);
    arc(c, 560, 420, 70, 80, 120, 6, AB.red);
    const [ex, ey] = polar(560, 420, 74, -120 + (Math.min(d.apu.egt, 1000) / 1000) * 240);
    line(c, 560, 420, ex, ey, 4, AB.green);
    val(c, String(Math.round(d.apu.egt / 5) * 5), 610, 470);
    unit(c, '°C', 560, 500);
    if (d.apu.master && !d.apu.avail) txt(c, 'FLAP OPEN', 384, 600, 22, AB.green);
  },
  wheel(c, d) {
    const col = d.wheel.down ? AB.green : d.wheel.transit ? AB.red : AB.white;
    for (const [x, y] of [
      [384, 120],
      [180, 300],
      [588, 300],
    ] as const) {
      if (d.wheel.gear > 0.02 || d.wheel.transit) {
        poly(
          c,
          [
            [x - 26, y - 14],
            [x + 26, y - 14],
            [x, y + 18],
          ],
          col,
          d.wheel.down ? 0 : 3,
        );
        poly(
          c,
          [
            [x - 26 + 60, y - 14],
            [x + 26 + 60, y - 14],
            [x + 60, y + 18],
          ],
          col,
          d.wheel.down ? 0 : 3,
        );
      }
      if (d.wheel.transit) txt(c, 'UNLK', x + 30, y + 40, 20, AB.red);
    }
    txt(c, 'NORM BRK', 384, 230, 20, AB.green);
    d.wheel.brakes.forEach((t, i) => {
      const x = [130, 230, 538, 638][i]!;
      rect(c, x - 34, 420, 68, 110, AB.white, 2);
      val(c, String(Math.round(t / 5) * 5), x + 26, 470, t > 300 ? AB.amber : AB.green, 26);
      txt(c, String(i + 1), x, 560, 24, AB.white);
    });
    unit(c, 'REL', 384, 440);
    txt(c, '°C', 384, 474, 20, AB.blue);
    if (d.wheel.autobrake) txt(c, `AUTO BRK ${d.wheel.autobrake}`, 384, 620, 24, AB.green);
    if (d.wheel.parking) txt(c, 'PARK BRK', 384, 600, 24, AB.green);
  },
  fctl(c, d) {
    txt(
      c,
      `PITCH TRIM ${Math.abs(d.fctl.trim).toFixed(1)}°${d.fctl.trim >= 0 ? 'UP' : 'DN'}`,
      384,
      90,
      22,
      AB.green,
    );
    txt(c, 'SPD BRK', 384, 140, 20, AB.white);
    // Spoilers: arrows 1-5 per wing, up when deflected.
    d.fctl.spoilers.forEach((deg, i) => {
      const side = i < 5 ? -1 : 1;
      const k = i % 5;
      const x = 384 + side * (60 + (4 - k) * 40);
      const y = 170 + (4 - k) * 8;
      line(c, x - 14, y, x + 14, y, 3, AB.green);
      if (deg > 2)
        poly(
          c,
          [
            [x, y - 30],
            [x - 10, y - 12],
            [x + 10, y - 12],
          ],
          AB.green,
        );
    });
    // Ailerons and elevators on their scales.
    for (const [x, v, name] of [
      [110, d.fctl.aileronL, 'L AIL'],
      [658, d.fctl.aileronR, 'R AIL'],
    ] as const) {
      txt(c, name, x, 260, 20, AB.white);
      line(c, x, 290, x, 420, 2, AB.white);
      const y = 355 + v * 60;
      poly(
        c,
        [
          [x + 4, y],
          [x + 22, y - 10],
          [x + 22, y + 10],
        ],
        AB.green,
      );
    }
    for (const [x, name] of [
      [200, 'L ELEV'],
      [568, 'R ELEV'],
    ] as const) {
      txt(c, name, x, 440, 20, AB.white);
      line(c, x, 470, x, 600, 2, AB.white);
      const y = 535 - d.fctl.elevator * 60;
      poly(
        c,
        [
          [x + 4, y],
          [x + 22, y - 10],
          [x + 22, y + 10],
        ],
        AB.green,
      );
    }
    txt(c, 'RUD', 384, 470, 20, AB.white);
    arc(c, 384, 480, 110, 150, 210, 3, AB.white);
    const [rx, ry] = polar(384, 480, 110, 180 - d.fctl.rudder * 30);
    line(c, 384, 520, rx, ry, 4, AB.green);
    txt(
      c,
      d.fctl.law === 'normal' ? 'ELAC 1  SEC 1' : `${d.fctl.law.toUpperCase()} LAW`,
      384,
      640,
      20,
      d.fctl.law === 'normal' ? AB.green : AB.amber,
    );
  },
  status(c, d) {
    let y = 100;
    if (!d.status.length) txt(c, 'NORMAL', 384, 300, 30, AB.green);
    for (const s of d.status) {
      txt(c, s, 40, y, 24, s.startsWith('INOP') ? AB.amber : AB.blue, 'left');
      y += 32;
    }
  },
};
