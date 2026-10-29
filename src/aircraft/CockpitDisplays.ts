import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from 'three';

/** What the instruments show. SI units in, the displays convert to knots, feet, ft/min. */
export interface CockpitData {
  /** Airspeed m/s, altitude m (sea level), vertical speed m/s. */
  ias: number;
  alt: number;
  vs: number;
  /** Degrees 0..360 (true north). */
  heading: number;
  /** Radians: nose above the horizon, bank (right wing down positive). */
  pitch: number;
  bank: number;
  /** Turn rate rad/s (positive right). */
  turnRate: number;
  throttle: number;
  /** Engine value as on the HUD (rpm or % N1) and its range. */
  engine: number;
  engineDisplay: 'rpm' | 'n1';
  engineIdle: number;
  engineMax: number;
  /** 0..1 and the flap angle at full flaps. */
  flaps: number;
  maxFlapDeg: number;
  gearDown: boolean;
  fixedGear: boolean;
  gLoad: number;
  aoa: number;
  stalled: boolean;
  onGround: boolean;
  /** Speeds m/s: never exceed, stall (current flaps). */
  vne: number;
  vstall: number;
  /** Elevator trim -1..1, 0 with fly-by-wire. */
  trim: number;
  lon: number;
  lat: number;
  /** Seconds since the flight started. */
  time: number;
  boosting: boolean;
  crashed: boolean;
}

const KT = 1.943844;
const FT = 3.28084;
const FPM = 196.8504;
const DEG = 180 / Math.PI;

/** Display looks per aircraft type. */
type Style = 'airbus' | 'boeing' | 'garmin' | 'apex' | 'steam' | 'fighter';
const STYLES: Record<string, Style> = {
  c172: 'steam',
  pc12: 'apex',
  phenom100: 'garmin',
  f35: 'fighter',
  a320: 'airbus',
  b747: 'boeing',
};
const ENGINES: Record<string, number> = { b747: 4, a320: 2, phenom100: 2 };

interface Screen {
  kind: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: CanvasTexture;
  material: MeshBasicMaterial;
  /** Drawn once (overhead panel). */
  fixed: boolean;
  drawn: boolean;
}

/**
 * Live glass-cockpit displays and steam gauges. The model carries flat quads named
 * Display_<KIND>_<n> (tools/blender/ac/cockpit.py); each kind gets a canvas that is redrawn
 * about 20 times a second while the pilot looks at it.
 */
export class CockpitDisplays {
  private readonly screens = new Map<string, Screen>();
  private readonly style: Style;
  private readonly engines: number;
  private acc = 1;

  constructor(
    root: Object3D,
    private readonly typeId: string,
  ) {
    this.style = STYLES[typeId] ?? 'garmin';
    this.engines = ENGINES[typeId] ?? 1;
    root.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      // Pivot nodes are Display_<KIND>_<n>_LOD<l>, their mesh child adds "_mesh".
      const m =
        /^Display_([A-Z0-9]+)_\d/.exec(o.name) ??
        /^Display_([A-Z0-9]+)_\d/.exec(o.parent?.name ?? '');
      if (!m) return;
      const kind = m[1]!;
      let s = this.screens.get(kind);
      if (!s) {
        s = this.makeScreen(kind, o);
        this.screens.set(kind, s);
      }
      o.material = s.material;
      o.castShadow = false;
      o.receiveShadow = false;
    });
  }

  get count(): number {
    return this.screens.size;
  }

  private makeScreen(kind: string, mesh: Mesh): Screen {
    const [w, h] = quadSize(mesh);
    const scale = kind === 'OVH' ? 1100 : 2600;
    const cw = clampInt(w * scale, 192, 1024);
    const ch = clampInt(h * scale, 64, 1024);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d')!;
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    // glTF UVs have v = 0 at the top of the image.
    tex.flipY = false;
    tex.anisotropy = 4;
    const material = new MeshBasicMaterial({
      name: `Display_${kind}`,
      map: tex,
      toneMapped: false,
    });
    return { kind, canvas, ctx, tex, material, fixed: kind === 'OVH', drawn: false };
  }

  /** Redraws the displays (rate-limited); call every frame while in the cockpit view. */
  update(dt: number, d: CockpitData, force = false) {
    this.acc += dt;
    if (!force && this.acc < 0.05) return;
    this.acc = 0;
    for (const s of this.screens.values()) {
      if (s.fixed && s.drawn) continue;
      this.draw(s, d);
      s.drawn = true;
      s.tex.needsUpdate = true;
    }
  }

  dispose() {
    for (const s of this.screens.values()) {
      s.tex.dispose();
      s.material.dispose();
    }
  }

  private draw(s: Screen, d: CockpitData) {
    const c = s.ctx;
    const W = s.canvas.width;
    const H = s.canvas.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#05070a';
    c.fillRect(0, 0, W, H);
    if (d.crashed && s.kind !== 'OVH') return; // power lost
    switch (s.kind) {
      case 'PFD':
        if (this.style === 'garmin' || this.style === 'apex') garminPfd(c, W, H, d);
        else airlinerPfd(c, W, H, d, this.style);
        break;
      case 'ND':
        nd(c, W, H, d, this.style === 'boeing' ? '#e8e8e8' : '#ffffff');
        break;
      case 'MFD':
        mfd(c, W, H, d, this.style === 'garmin' ? this.engines : 0, this.style);
        break;
      case 'EICAS':
      case 'EWD':
        engineDisplay(c, W, H, d, this.engines, this.style, this.typeId);
        break;
      case 'SD':
        systemDisplay(c, W, H, d, this.style);
        break;
      case 'SIX':
        sixPack(c, W, H, d);
        break;
      case 'ENG':
        c172Engine(c, W, H, d);
        break;
      case 'RADIO':
        radioStack(c, W, H, d);
        break;
      case 'FCU':
        fcu(c, W, H, d, this.style);
        break;
      case 'MCDU':
        mcdu(c, W, H, d, this.style);
        break;
      case 'OVH':
        overhead(c, W, H, this.style);
        break;
      case 'PCD':
        panoramic(c, W, H, d);
        break;
      default:
        label(c, s.kind, W / 2, H / 2, H * 0.2, '#3a3', 'center');
    }
  }
}

/** Width and height (m) of a display quad from its UV corners. */
function quadSize(mesh: Mesh): [number, number] {
  const pos = mesh.geometry.attributes.position!;
  const uv = mesh.geometry.attributes.uv;
  if (!uv || pos.count < 3) return [0.2, 0.15];
  const p = new Vector3();
  const corners: Record<string, Vector3> = {};
  const t = new Vector2();
  mesh.updateMatrix();
  for (let i = 0; i < pos.count; i++) {
    t.set(uv.getX(i), uv.getY(i));
    p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrix);
    corners[`${Math.round(t.x)}${Math.round(t.y)}`] = p.clone();
  }
  const a = corners['00'];
  const b = corners['10'];
  const c = corners['01'];
  if (!a || !b || !c) return [0.2, 0.15];
  return [a.distanceTo(b), a.distanceTo(c)];
}

function clampInt(v: number, lo: number, hi: number) {
  return Math.round(Math.min(hi, Math.max(lo, v)));
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;
const MONO = '"Consolas", "DejaVu Sans Mono", monospace';
const SANS = '"Arial Narrow", "Roboto Condensed", Arial, sans-serif';

function label(
  c: Ctx,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'left',
  font = SANS,
) {
  c.font = `bold ${Math.max(6, Math.round(size))}px ${font}`;
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillText(text, x, y);
}

function line(c: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, w = 1) {
  c.strokeStyle = color;
  c.lineWidth = w;
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
}

function box(
  c: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  stroke: string,
  fill?: string,
  lw = 1,
) {
  if (fill) {
    c.fillStyle = fill;
    c.fillRect(x, y, w, h);
  }
  c.strokeStyle = stroke;
  c.lineWidth = lw;
  c.strokeRect(x, y, w, h);
}

function pad(n: number, len: number) {
  const s = String(Math.abs(Math.round(n)));
  return (n < 0 ? '-' : '') + s.padStart(len, '0');
}

const wrap360 = (a: number) => ((a % 360) + 360) % 360;

// ---------------------------------------------------------------------------
// Attitude, tapes, heading (shared by the PFDs)
// ---------------------------------------------------------------------------

/** Artificial horizon inside the rectangle (x, y, w, h), centred at (cx, cy). */
function attitude(
  c: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  cx: number,
  cy: number,
  d: CockpitData,
  pxPerDeg: number,
  sky = '#2e6fc4',
  ground = '#7a4a22',
  round = false,
) {
  c.save();
  c.beginPath();
  if (round) c.arc(cx, cy, Math.min(w, h) / 2, 0, Math.PI * 2);
  else c.rect(x, y, w, h);
  c.clip();
  c.translate(cx, cy);
  c.rotate(-d.bank);
  const off = d.pitch * DEG * pxPerDeg;
  const R = Math.hypot(w, h) * 1.5;
  c.fillStyle = sky;
  c.fillRect(-R, -R + off, 2 * R, R);
  c.fillStyle = ground;
  c.fillRect(-R, off, 2 * R, R);
  line(c, -R, off, R, off, '#fff', Math.max(1.5, pxPerDeg * 0.25));
  // Pitch ladder every 2.5 degrees, labels every 10.
  const size = Math.max(8, pxPerDeg * 2.2);
  for (let p = -90; p <= 90; p += 2.5) {
    if (p === 0) continue;
    const py = off - p * pxPerDeg;
    if (Math.abs(py) > h * 0.42) continue;
    const major = p % 10 === 0;
    const half = major ? w * 0.12 : p % 5 === 0 ? w * 0.06 : w * 0.03;
    line(c, -half, py, half, py, '#fff', Math.max(1, pxPerDeg * 0.18));
    if (major) {
      label(c, String(Math.abs(p)), -half - size * 0.3, py, size, '#fff', 'right');
      label(c, String(Math.abs(p)), half + size * 0.3, py, size, '#fff', 'left');
    }
  }
  c.restore();
}

/** Bank scale (fixed) with a pointer that turns with the horizon. */
function bankScale(c: Ctx, cx: number, cy: number, r: number, d: CockpitData, color = '#fff') {
  c.strokeStyle = color;
  c.lineWidth = Math.max(1.5, r * 0.012);
  c.beginPath();
  c.arc(cx, cy, r, (-90 - 60) / DEG, (-90 + 60) / DEG);
  c.stroke();
  for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const big = Math.abs(a) === 30 || Math.abs(a) === 60;
    const t = (a - 90) / DEG;
    const r1 = r * (big ? 1.09 : 1.05);
    line(
      c,
      cx + Math.cos(t) * r,
      cy + Math.sin(t) * r,
      cx + Math.cos(t) * r1,
      cy + Math.sin(t) * r1,
      color,
      c.lineWidth,
    );
  }
  // Zero mark (fixed triangle at the top).
  c.fillStyle = '#ffd400';
  c.beginPath();
  c.moveTo(cx, cy - r);
  c.lineTo(cx - r * 0.05, cy - r * 1.1);
  c.lineTo(cx + r * 0.05, cy - r * 1.1);
  c.fill();
  // Roll pointer, moving with the bank.
  c.save();
  c.translate(cx, cy);
  c.rotate(-d.bank);
  c.fillStyle = Math.abs(d.bank * DEG) > 35 ? '#ffb000' : '#ffffff';
  c.beginPath();
  c.moveTo(0, -r);
  c.lineTo(-r * 0.05, -r * 0.9);
  c.lineTo(r * 0.05, -r * 0.9);
  c.fill();
  c.restore();
}

/** Fixed aircraft symbol (wings and centre dot). */
function aircraftSymbol(c: Ctx, cx: number, cy: number, s: number, style: Style) {
  c.lineWidth = Math.max(2, s * 0.08);
  if (style === 'garmin' || style === 'apex') {
    // Yellow chevron.
    c.fillStyle = '#ffd400';
    c.strokeStyle = '#000';
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx - s * 1.6, cy + s * 0.7);
    c.lineTo(cx - s * 0.9, cy + s * 0.7);
    c.lineTo(cx, cy + s * 0.3);
    c.lineTo(cx + s * 0.9, cy + s * 0.7);
    c.lineTo(cx + s * 1.6, cy + s * 0.7);
    c.closePath();
    c.fill();
    c.stroke();
    return;
  }
  const col = style === 'airbus' ? '#ffd400' : '#ffffff';
  c.fillStyle = '#000';
  c.strokeStyle = col;
  for (const side of [-1, 1]) {
    c.fillRect(cx + side * s * 0.6 - (side < 0 ? s * 1.2 : 0), cy - s * 0.12, s * 1.2, s * 0.24);
    c.strokeRect(cx + side * s * 0.6 - (side < 0 ? s * 1.2 : 0), cy - s * 0.12, s * 1.2, s * 0.24);
  }
  c.fillRect(cx - s * 0.12, cy - s * 0.12, s * 0.24, s * 0.24);
  c.strokeRect(cx - s * 0.12, cy - s * 0.12, s * 0.24, s * 0.24);
}

/** Vertical tape (speed left, altitude right). */
function tape(
  c: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  value: number,
  range: number,
  minor: number,
  major: number,
  fmt: (v: number) => string,
  side: 'left' | 'right',
  min = -Infinity,
  bands: Array<[number, number, string]> = [],
) {
  c.save();
  c.fillStyle = 'rgba(70, 74, 82, 0.85)';
  c.fillRect(x, y, w, h);
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  const cy = y + h / 2;
  const k = h / range;
  for (const [a, b, col] of bands) {
    const y0 = cy - (b - value) * k;
    const y1 = cy - (a - value) * k;
    c.fillStyle = col;
    c.fillRect(side === 'left' ? x + w * 0.86 : x, y0, w * 0.14, y1 - y0);
  }
  const size = Math.min(w * 0.3, h * 0.05);
  const start = Math.ceil((value - range / 2) / minor) * minor;
  for (let v = start; v <= value + range / 2; v += minor) {
    if (v < min) continue;
    const ty = cy - (v - value) * k;
    const isMajor = Math.abs(v % major) < 1e-6;
    const len = w * (isMajor ? 0.18 : 0.1);
    if (side === 'left') line(c, x + w - len, ty, x + w, ty, '#fff', 1.5);
    else line(c, x, ty, x + len, ty, '#fff', 1.5);
    if (isMajor)
      label(
        c,
        fmt(v),
        side === 'left' ? x + w * 0.74 : x + w * 0.26,
        ty,
        size,
        '#fff',
        side === 'left' ? 'right' : 'left',
      );
  }
  c.restore();
  // Readout box.
  const bh = size * 1.6;
  box(c, x + 2, cy - bh / 2, w - 4, bh, '#ffd400', '#000', 2);
  label(
    c,
    fmt(value),
    side === 'left' ? x + w * 0.88 : x + w * 0.12,
    cy,
    size * 1.15,
    '#00ff66',
    side === 'left' ? 'right' : 'left',
  );
}

function vsScale(c: Ctx, x: number, y: number, w: number, h: number, vs: number) {
  c.fillStyle = 'rgba(60, 64, 72, 0.85)';
  c.fillRect(x, y, w, h);
  const cy = y + h / 2;
  const f = (v: number) => Math.sign(v) * (1 - Math.exp(-Math.abs(v) / 2000));
  for (const v of [-6000, -2000, -1000, 0, 1000, 2000, 6000]) {
    const ty = cy - f(v) * h * 0.45;
    line(c, x, ty, x + w * 0.35, ty, '#fff', 1.5);
    if (v !== 0 && Math.abs(v) <= 6000)
      label(c, String(Math.abs(v) / 1000), x + w * 0.65, ty, w * 0.38, '#ccc', 'center');
  }
  const fpm = vs * FPM;
  const ty = cy - f(fpm) * h * 0.45;
  line(c, x + w * 1.4, cy, x + w * 0.1, ty, '#00ff66', Math.max(2, w * 0.1));
  if (Math.abs(fpm) > 200)
    label(
      c,
      String(Math.round(fpm / 100) * 100),
      x + w / 2,
      fpm > 0 ? y + w * 0.4 : y + h - w * 0.4,
      w * 0.36,
      '#00ff66',
      'center',
    );
}

/** Heading tape along the bottom (airliners). */
function headingTape(c: Ctx, x: number, y: number, w: number, h: number, hdg: number) {
  c.save();
  c.fillStyle = 'rgba(60, 64, 72, 0.85)';
  c.fillRect(x, y, w, h);
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  const k = w / 40;
  const cx = x + w / 2;
  for (let a = Math.floor(hdg - 22); a <= hdg + 22; a++) {
    if (a % 5 !== 0) continue;
    const tx = cx + (a - hdg) * k;
    line(c, tx, y, tx, y + h * (a % 10 === 0 ? 0.32 : 0.18), '#fff', 1.5);
    if (a % 10 === 0)
      label(c, String(wrap360(a) / 10), tx, y + h * 0.62, h * 0.42, '#fff', 'center');
  }
  c.restore();
  line(c, cx, y - h * 0.1, cx, y + h * 0.35, '#ffd400', 3);
}

// ---------------------------------------------------------------------------
// PFDs
// ---------------------------------------------------------------------------

function speedBands(d: CockpitData): Array<[number, number, string]> {
  const vs = d.vstall * KT;
  return [
    [0, vs, '#d01818'],
    [vs, vs * 1.13, '#ffb000'],
    [d.vne * KT, 2000, '#d01818'],
  ];
}

function airlinerPfd(c: Ctx, W: number, H: number, d: CockpitData, style: Style) {
  const ax = W * 0.2;
  const aw = W * 0.6;
  const ay = H * 0.1;
  const ah = H * 0.7;
  const cx = ax + aw / 2;
  const cy = ay + ah * 0.48;
  const ppd = ah / 50;
  const sky = style === 'airbus' ? '#1f80d8' : '#2a7fd0';
  attitude(c, ax, ay, aw, ah, cx, cy, d, ppd, sky, style === 'airbus' ? '#8a4e1d' : '#8b5a2b');
  bankScale(c, cx, cy, ah * 0.42, d);
  aircraftSymbol(c, cx, cy, aw * 0.09, style);
  const kt = d.ias * KT;
  tape(
    c,
    W * 0.02,
    ay,
    W * 0.15,
    ah,
    kt,
    80,
    10,
    20,
    (v) => String(Math.max(0, Math.round(v))),
    'left',
    30,
    speedBands(d),
  );
  tape(
    c,
    W * 0.81,
    ay,
    W * 0.13,
    ah,
    d.alt * FT,
    1000,
    100,
    500,
    (v) => String(Math.round(v / 20) * 20),
    'right',
  );
  vsScale(c, W * 0.945, ay + ah * 0.1, W * 0.05, ah * 0.8, d.vs);
  headingTape(c, ax, H * 0.86, aw, H * 0.12, d.heading);
  // Flight mode annunciator along the top.
  const fma =
    style === 'airbus'
      ? ['SPEED', 'HDG', 'ALT', 'AP1', 'A/THR']
      : ['SPD', 'HDG SEL', 'ALT', 'CMD', ''];
  const fw = aw / fma.length;
  fma.forEach((t, i) => {
    label(c, t, ax + fw * (i + 0.5), H * 0.045, H * 0.04, '#00ff66', 'center');
    if (i > 0) line(c, ax + fw * i, 2, ax + fw * i, H * 0.085, '#666', 1);
  });
  if (d.stalled) label(c, 'STALL', cx, cy + ah * 0.3, H * 0.07, '#ff2020', 'center');
  if (!d.fixedGear && style === 'boeing')
    label(c, d.gearDown ? 'GEAR DN' : '', W * 0.1, H * 0.93, H * 0.04, '#00ff66', 'center');
  label(c, `G ${d.gLoad.toFixed(1)}`, W * 0.1, H * 0.86, H * 0.035, '#ccc', 'center');
}

function garminPfd(c: Ctx, W: number, H: number, d: CockpitData) {
  // Synthetic horizon over the whole screen, tapes and HSI on top.
  const cx = W * 0.45;
  const cy = H * 0.4;
  const ppd = H / 45;
  attitude(c, 0, 0, W, H, cx, cy, d, ppd, '#1d68c7', '#7b5426');
  bankScale(c, cx, cy, H * 0.3, d);
  aircraftSymbol(c, cx, cy + H * 0.005, W * 0.05, 'garmin');
  const kt = d.ias * KT;
  tape(
    c,
    W * 0.1,
    H * 0.12,
    W * 0.11,
    H * 0.52,
    kt,
    60,
    10,
    10,
    (v) => String(Math.max(0, Math.round(v))),
    'left',
    20,
    speedBands(d),
  );
  tape(
    c,
    W * 0.7,
    H * 0.12,
    W * 0.12,
    H * 0.52,
    d.alt * FT,
    600,
    100,
    100,
    (v) => String(Math.round(v / 10) * 10),
    'right',
  );
  vsScale(c, W * 0.83, H * 0.16, W * 0.035, H * 0.44, d.vs);
  // Top bar (nav / com frequencies).
  c.fillStyle = 'rgba(0, 0, 0, 0.85)';
  c.fillRect(0, 0, W, H * 0.075);
  label(c, 'NAV1 113.90 ↔ 110.50', W * 0.02, H * 0.038, H * 0.035, '#00e0ff');
  label(c, 'COM1 118.100 ↔ 121.500', W * 0.98, H * 0.038, H * 0.035, '#00e0ff', 'right');
  // HSI at the bottom.
  hsi(c, cx, H * 0.86, H * 0.2, d.heading);
  // Lower bar: OAT, transponder, time.
  c.fillStyle = 'rgba(0, 0, 0, 0.85)';
  c.fillRect(0, H * 0.93, W, H * 0.07);
  label(
    c,
    `OAT ${Math.round(15 - (d.alt / 1000) * 6.5)}°C`,
    W * 0.02,
    H * 0.965,
    H * 0.035,
    '#fff',
  );
  label(c, 'XPDR 7000 ALT', W * 0.62, H * 0.965, H * 0.035, '#00ff66', 'center');
  label(c, clock(d.time), W * 0.98, H * 0.965, H * 0.035, '#fff', 'right');
  if (d.stalled) label(c, 'STALL', cx, H * 0.64, H * 0.07, '#ff2020', 'center');
}

/** Compass rose (heading up) with lubber line; full circle. */
function hsi(c: Ctx, cx: number, cy: number, r: number, hdg: number, color = '#fff') {
  c.save();
  c.fillStyle = 'rgba(0, 0, 0, 0.6)';
  c.beginPath();
  c.arc(cx, cy, r * 1.05, 0, Math.PI * 2);
  c.fill();
  c.translate(cx, cy);
  for (let a = 0; a < 360; a += 5) {
    const t = (a - hdg - 90) / DEG;
    const major = a % 10 === 0;
    const r0 = r * (major ? 0.86 : 0.92);
    line(c, Math.cos(t) * r0, Math.sin(t) * r0, Math.cos(t) * r, Math.sin(t) * r, color, 1.5);
    if (a % 30 === 0) {
      const txt =
        a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a / 10);
      label(c, txt, Math.cos(t) * r * 0.72, Math.sin(t) * r * 0.72, r * 0.16, color, 'center');
    }
  }
  c.restore();
  // Course needle (magenta) along the heading, aircraft symbol.
  line(c, cx, cy - r * 0.62, cx, cy + r * 0.62, '#ff40ff', Math.max(2, r * 0.03));
  c.fillStyle = '#fff';
  c.beginPath();
  c.moveTo(cx, cy - r * 0.12);
  c.lineTo(cx - r * 0.1, cy + r * 0.1);
  c.lineTo(cx + r * 0.1, cy + r * 0.1);
  c.fill();
  box(c, cx - r * 0.22, cy - r * 1.32, r * 0.44, r * 0.22, '#fff', '#000');
  label(c, `${pad(wrap360(Math.round(hdg)), 3)}°`, cx, cy - r * 1.21, r * 0.16, '#fff', 'center');
}

function clock(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${pad(m, 2)}:${pad(s, 2)}`;
}

// ---------------------------------------------------------------------------
// Navigation / multi-function displays
// ---------------------------------------------------------------------------

function nd(c: Ctx, W: number, H: number, d: CockpitData, color: string) {
  const cx = W / 2;
  const cy = H * 0.8;
  const r = H * 0.66;
  c.save();
  c.beginPath();
  c.rect(0, 0, W, H);
  c.clip();
  // Range rings.
  c.setLineDash([4, 6]);
  for (const k of [0.33, 0.66]) {
    c.strokeStyle = '#888';
    c.beginPath();
    c.arc(cx, cy, r * k, Math.PI, 2 * Math.PI);
    c.stroke();
  }
  c.setLineDash([]);
  // Compass arc.
  c.strokeStyle = color;
  c.lineWidth = 2;
  c.beginPath();
  c.arc(cx, cy, r, (-90 - 50) / DEG, (-90 + 50) / DEG);
  c.stroke();
  for (let a = Math.floor(d.heading - 55); a <= d.heading + 55; a++) {
    if (a % 5 !== 0) continue;
    const t = (a - d.heading - 90) / DEG;
    const r0 = r * (a % 10 === 0 ? 0.94 : 0.97);
    line(
      c,
      cx + Math.cos(t) * r0,
      cy + Math.sin(t) * r0,
      cx + Math.cos(t) * r,
      cy + Math.sin(t) * r,
      color,
      1.5,
    );
    if (a % 30 === 0)
      label(
        c,
        String(wrap360(a) / 10),
        cx + Math.cos(t) * r * 0.88,
        cy + Math.sin(t) * r * 0.88,
        H * 0.05,
        color,
        'center',
      );
  }
  // Track line, active route (magenta) straight ahead with a waypoint.
  line(c, cx, cy, cx, cy - r, '#00ff66', 1.5);
  line(c, cx, cy, cx + r * 0.25, cy - r * 0.9, '#ff40ff', 2.5);
  c.strokeStyle = '#ff40ff';
  c.lineWidth = 2;
  const wx = cx + r * 0.16;
  const wy = cy - r * 0.58;
  c.beginPath();
  c.moveTo(wx, wy - 6);
  c.lineTo(wx + 6, wy);
  c.lineTo(wx, wy + 6);
  c.lineTo(wx - 6, wy);
  c.closePath();
  c.stroke();
  label(c, 'TRA01', wx + 10, wy, H * 0.04, '#ff40ff');
  c.restore();
  // Own aircraft.
  c.strokeStyle = '#ffd400';
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(cx, cy - H * 0.05);
  c.lineTo(cx, cy + H * 0.04);
  c.moveTo(cx - H * 0.04, cy - H * 0.01);
  c.lineTo(cx + H * 0.04, cy - H * 0.01);
  c.moveTo(cx - H * 0.02, cy + H * 0.035);
  c.lineTo(cx + H * 0.02, cy + H * 0.035);
  c.stroke();
  // Heading box, data in the corners.
  box(c, cx - W * 0.07, H * 0.02, W * 0.14, H * 0.07, color, '#000');
  label(c, pad(wrap360(Math.round(d.heading)), 3), cx, H * 0.055, H * 0.05, color, 'center');
  const gs = Math.round(d.ias * KT * (1 + d.alt / 60000));
  label(
    c,
    `GS ${gs}  TAS ${Math.round(d.ias * KT * (1 + d.alt / 50000))}`,
    W * 0.02,
    H * 0.05,
    H * 0.035,
    '#fff',
  );
  label(c, '270/12', W * 0.02, H * 0.1, H * 0.035, '#fff');
  label(c, 'TRA01', W * 0.98, H * 0.05, H * 0.04, '#ff40ff', 'right');
  label(c, `${clock(d.time)}`, W * 0.98, H * 0.1, H * 0.035, '#fff', 'right');
  label(c, '20', cx + r * 0.66 * 0.71, cy - r * 0.66 * 0.71, H * 0.035, '#aaa', 'center');
}

function mfd(c: Ctx, W: number, H: number, d: CockpitData, engines: number, style: Style) {
  // Moving map: compass rose, a few "terrain" rings around the position, engine strip left.
  const left = engines > 0 ? W * 0.22 : 0;
  c.fillStyle = '#0a1a10';
  c.fillRect(left, 0, W - left, H);
  // Pseudo terrain bands from the position (stable while flying).
  c.save();
  c.beginPath();
  c.rect(left, 0, W - left, H);
  c.clip();
  const cx = left + (W - left) / 2;
  const cy = H * 0.55;
  c.translate(cx, cy);
  c.rotate(-d.heading / DEG);
  const k = H * 900; // px per degree of latitude (about 10 NM across)
  for (let i = -6; i <= 6; i++) {
    for (let j = -6; j <= 6; j++) {
      const la = Math.floor(d.lat * 60) / 60 + i / 60;
      const lo = Math.floor(d.lon * 60) / 60 + j / 60;
      const h = Math.abs(Math.sin(la * 917 + lo * 613) + Math.cos(la * 311 - lo * 1201));
      const px = (lo - d.lon) * k * Math.cos(d.lat / DEG);
      const py = -(la - d.lat) * k;
      c.fillStyle = h > 1.5 ? '#5a4a2a' : h > 1.0 ? '#2f4a22' : '#1a3518';
      c.fillRect(px, py, k / 60 + 1, k / 60 + 1);
    }
  }
  c.restore();
  hsi(c, cx, cy, Math.min(W - left, H) * 0.38, d.heading, '#ffffff');
  label(c, 'MAP - NAVIGATION MAP', left + 6, H * 0.04, H * 0.04, '#fff');
  label(
    c,
    style === 'apex' ? 'TRAPANOTTO FMS' : 'NORTH UP OFF',
    W - 6,
    H * 0.04,
    H * 0.035,
    '#0ff',
    'right',
  );
  if (engines > 0) eis(c, 0, 0, left, H, d, engines);
}

/** Garmin engine indication strip (left of the MFD). */
function eis(c: Ctx, x: number, y: number, w: number, h: number, d: CockpitData, engines: number) {
  c.fillStyle = '#000';
  c.fillRect(x, y, w, h);
  line(c, x + w, y, x + w, y + h, '#666', 2);
  const n1 = d.engine;
  label(
    c,
    d.engineDisplay === 'rpm' ? 'RPM' : 'N1 %',
    x + w / 2,
    y + h * 0.05,
    h * 0.04,
    '#fff',
    'center',
  );
  for (let e = 0; e < engines; e++) {
    const gx = x + w * (engines > 1 ? 0.28 + 0.44 * e : 0.5);
    arcGauge(
      c,
      gx,
      y + h * 0.2,
      w * (engines > 1 ? 0.2 : 0.3),
      n1,
      d.engineIdle * 0.5,
      d.engineMax * 1.05,
      d.engineMax,
    );
    label(
      c,
      d.engineDisplay === 'rpm' ? String(Math.round(n1 / 10) * 10) : n1.toFixed(1),
      gx,
      y + h * 0.3,
      h * 0.04,
      '#00ff66',
      'center',
    );
  }
  const rows: Array<[string, number, number]> = [
    ['ITT °C', 400 + 400 * d.throttle, 900],
    ['OIL PSI', 60 + 20 * d.throttle, 120],
    ['OIL °C', 70 + 20 * d.throttle, 140],
    ['FUEL LB', 1450 - d.time * 0.08, 1800],
  ];
  rows.forEach(([name, v, max], i) => {
    const ry = y + h * (0.42 + i * 0.13);
    label(c, name, x + 4, ry, h * 0.032, '#fff');
    bar(c, x + 4, ry + h * 0.03, w - 8, h * 0.025, v / max, '#00ff66');
    label(c, String(Math.round(v)), x + w - 4, ry, h * 0.032, '#00ff66', 'right');
  });
  label(
    c,
    `FLAPS ${Math.round(d.flaps * d.maxFlapDeg)}°`,
    x + w / 2,
    y + h * 0.95,
    h * 0.035,
    '#fff',
    'center',
  );
}

function bar(c: Ctx, x: number, y: number, w: number, h: number, f: number, color: string) {
  box(c, x, y, w, h, '#888');
  c.fillStyle = color;
  c.fillRect(x + 1, y + 1, (w - 2) * Math.max(0, Math.min(1, f)), h - 2);
}

/** Round dial with an arc from min to max (210 deg), needle at v, red line at red. */
function arcGauge(
  c: Ctx,
  cx: number,
  cy: number,
  r: number,
  v: number,
  min: number,
  max: number,
  red: number,
) {
  const a0 = (-210 * Math.PI) / 180;
  const span = (210 * Math.PI) / 180;
  const ang = (x: number) => a0 + span * Math.max(0, Math.min(1, (x - min) / (max - min)));
  c.lineWidth = Math.max(2, r * 0.1);
  c.strokeStyle = '#fff';
  c.beginPath();
  c.arc(cx, cy, r, a0, ang(red));
  c.stroke();
  c.strokeStyle = '#ff2020';
  c.beginPath();
  c.arc(cx, cy, r, ang(red), a0 + span);
  c.stroke();
  // Filled sector up to the value (Airbus style) and the needle.
  c.fillStyle = 'rgba(0, 255, 100, 0.15)';
  c.beginPath();
  c.moveTo(cx, cy);
  c.arc(cx, cy, r * 0.95, a0, ang(v));
  c.closePath();
  c.fill();
  const t = ang(v);
  line(
    c,
    cx,
    cy,
    cx + Math.cos(t) * r * 1.05,
    cy + Math.sin(t) * r * 1.05,
    '#00ff66',
    Math.max(2, r * 0.08),
  );
}

// ---------------------------------------------------------------------------
// Engine and system displays (EICAS / ECAM)
// ---------------------------------------------------------------------------

function engineDisplay(
  c: Ctx,
  W: number,
  H: number,
  d: CockpitData,
  engines: number,
  style: Style,
  id: string,
) {
  const prop = d.engineDisplay === 'rpm';
  const n = Math.max(1, engines);
  const gw = (W * (style === 'apex' ? 0.9 : 0.62)) / n;
  const r = Math.min(gw * 0.36, H * 0.12);
  const names = prop ? ['TRQ %', 'ITT °C', 'NP RPM'] : ['N1 %', 'EGT °C', 'N2 %'];
  const throttle = d.crashed ? 0 : d.throttle;
  const vals = (k: number) =>
    k === 0
      ? prop
        ? 20 + 80 * throttle
        : d.engine
      : k === 1
        ? 380 + 420 * throttle
        : prop
          ? d.engine
          : 58 + 40 * throttle;
  const ranges: Array<[number, number, number]> = [
    prop ? [0, 110, 100] : [0, 110, 104],
    [0, 1000, 900],
    prop ? [0, 1800, 1700] : [0, 110, 105],
  ];
  for (let k = 0; k < 3; k++) {
    const gy = H * (0.16 + 0.25 * k);
    label(c, names[k]!, W * 0.02, gy - r * 0.9, H * 0.035, '#0ff');
    for (let e = 0; e < n; e++) {
      const gx = W * 0.05 + gw * (e + 0.5);
      const [min, max, red] = ranges[k]!;
      const v = vals(k);
      arcGauge(c, gx, gy, r, v, min, max, red);
      const txt = k === 1 ? String(Math.round(v)) : v.toFixed(v < 200 ? 1 : 0);
      box(c, gx - r * 0.1, gy + r * 0.1, r * 1.15, r * 0.6, '#888', '#000');
      label(c, txt, gx + r * 0.95, gy + r * 0.4, r * 0.42, '#00ff66', 'right');
    }
  }
  // Right column: fuel flow, fuel, flaps, gear, memo.
  const x0 = style === 'apex' ? W * 0.05 : W * 0.7;
  const ff =
    (d.crashed ? 0 : 0.2 + 0.8 * throttle) *
    ({ b747: 3200, a320: 1300, phenom100: 280, pc12: 240 }[id] ?? 200);
  const rows: Array<[string, string]> = [
    ['FF', `${Math.round(ff)} kg/h`],
    [
      'FOB',
      `${Math.max(0, Math.round(({ b747: 120000, a320: 12000, phenom100: 1100, pc12: 900 }[id] ?? 500) - ((d.time * ff) / 3600) * n))} kg`,
    ],
    ['FLAP', `${Math.round(d.flaps * d.maxFlapDeg)}°`],
  ];
  const ry0 = style === 'apex' ? H * 0.88 : H * 0.12;
  rows.forEach(([k, v], i) => {
    const ry = style === 'apex' ? ry0 : ry0 + i * H * 0.08;
    const rx = style === 'apex' ? x0 + i * W * 0.3 : x0;
    label(c, k, rx, ry, H * 0.04, '#0ff');
    label(c, v, rx + (style === 'apex' ? W * 0.27 : W * 0.28), ry, H * 0.04, '#00ff66', 'right');
  });
  if (style !== 'apex') {
    flapScale(c, W * 0.72, H * 0.42, W * 0.25, H * 0.08, d.flaps);
    // Memo / alerts.
    const memo: Array<[string, string]> = [];
    if (d.stalled) memo.push(['STALL', '#ff2020']);
    if (d.onGround && d.ias < 3) memo.push(['PARK BRK', '#00ff66']);
    if (!d.fixedGear)
      memo.push([d.gearDown ? 'LDG GEAR DN' : 'LDG GEAR UP', d.gearDown ? '#00ff66' : '#ccc']);
    if (d.ias > d.vne) memo.push(['OVERSPEED', '#ff2020']);
    if (d.boosting) memo.push(['A/B', '#ffb000']);
    memo.forEach(([t, col], i) => label(c, t, W * 0.7, H * (0.62 + i * 0.075), H * 0.045, col));
    line(c, W * 0.67, H * 0.05, W * 0.67, H * 0.95, '#444', 2);
  }
}

function flapScale(c: Ctx, x: number, y: number, w: number, h: number, f: number) {
  label(c, 'FLAP', x, y - h * 0.6, h * 0.5, '#0ff');
  line(c, x, y, x + w, y + h, '#fff', 2);
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    c.fillStyle = f >= t - 0.01 ? '#00ff66' : '#555';
    c.fillRect(x + w * t - 3, y + h * t - 3, 6, 6);
  }
  c.fillStyle = '#00ff66';
  c.beginPath();
  c.arc(x + w * f, y + h * f, h * 0.22, 0, Math.PI * 2);
  c.fill();
}

function systemDisplay(c: Ctx, W: number, H: number, d: CockpitData, style: Style) {
  label(c, style === 'airbus' ? 'WHEEL' : 'GEAR', W / 2, H * 0.06, H * 0.05, '#fff', 'center');
  line(c, W * 0.38, H * 0.09, W * 0.62, H * 0.09, '#fff', 1.5);
  // Gear: nose and two mains, green triangles when down and locked.
  const gear = (x: number, y: number) => {
    const s = H * 0.07;
    if (d.gearDown) {
      c.fillStyle = '#00ff66';
      c.beginPath();
      c.moveTo(x, y + s);
      c.lineTo(x - s, y - s * 0.4);
      c.lineTo(x + s, y - s * 0.4);
      c.fill();
    } else {
      box(c, x - s, y - s * 0.4, 2 * s, s * 1.4, '#888');
      label(c, 'UP', x, y + s * 0.3, s * 0.7, '#ccc', 'center');
    }
  };
  gear(W * 0.5, H * 0.25);
  gear(W * 0.3, H * 0.48);
  gear(W * 0.7, H * 0.48);
  // Brake temperatures rise with braking on the ground (illustrative).
  const temp = d.onGround ? Math.round(80 + Math.max(0, 60 - d.ias) * 0.5) : 60;
  for (const [x, i] of [
    [0.18, 1],
    [0.38, 2],
    [0.62, 3],
    [0.82, 4],
  ] as const) {
    box(c, W * x - W * 0.07, H * 0.62, W * 0.14, H * 0.1, '#888');
    label(c, String(temp + i), W * x, H * 0.67, H * 0.045, '#00ff66', 'center');
  }
  label(c, '°C', W * 0.5, H * 0.67, H * 0.04, '#0ff', 'center');
  // Bottom permanent data: temperatures, G load, weight.
  line(c, 0, H * 0.82, W, H * 0.82, '#fff', 1.5);
  const sat = Math.round(15 - (d.alt / 1000) * 6.5);
  label(
    c,
    `TAT ${sat + Math.round(((d.ias * d.ias) / 2010) * 1)} °C`,
    W * 0.03,
    H * 0.87,
    H * 0.04,
    '#00ff66',
  );
  label(c, `SAT ${sat} °C`, W * 0.03, H * 0.94, H * 0.04, '#00ff66');
  label(c, clock(d.time), W * 0.5, H * 0.9, H * 0.05, '#00ff66', 'center');
  label(c, `G ${d.gLoad.toFixed(2)}`, W * 0.97, H * 0.87, H * 0.04, '#00ff66', 'right');
  label(c, `AOA ${(d.aoa * DEG).toFixed(1)}°`, W * 0.97, H * 0.94, H * 0.04, '#00ff66', 'right');
}

// ---------------------------------------------------------------------------
// Cessna 172: six-pack, engine strip, radio stack
// ---------------------------------------------------------------------------

function dialFace(c: Ctx, cx: number, cy: number, r: number) {
  c.fillStyle = '#0c0c0c';
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.fill();
}

function ticks(
  c: Ctx,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  n: number,
  every: number,
  len = 0.12,
) {
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    const big = i % every === 0;
    const r0 = r * (1 - (big ? len : len * 0.5));
    line(
      c,
      cx + Math.cos(t) * r0,
      cy + Math.sin(t) * r0,
      cx + Math.cos(t) * r,
      cy + Math.sin(t) * r,
      '#eee',
      big ? 2 : 1,
    );
  }
}

function needle(c: Ctx, cx: number, cy: number, r: number, t: number, w = 3, color = '#f4f4f4') {
  line(
    c,
    cx - Math.cos(t) * r * 0.15,
    cy - Math.sin(t) * r * 0.15,
    cx + Math.cos(t) * r,
    cy + Math.sin(t) * r,
    color,
    w,
  );
  c.fillStyle = '#333';
  c.beginPath();
  c.arc(cx, cy, r * 0.07, 0, Math.PI * 2);
  c.fill();
}

function sixPack(c: Ctx, W: number, H: number, d: CockpitData) {
  c.fillStyle = '#1b1c1e';
  c.fillRect(0, 0, W, H);
  // Centres match the bezel rings of the model (0.12 m apart on a 0.36 x 0.24 m plate).
  const r = Math.min(W * 0.135, H * 0.2);
  const pos = (i: number) => [W * (0.1667 + 0.3333 * (i % 3)), H * (i < 3 ? 0.25 : 0.75)] as const;
  const kt = d.ias * KT;
  // 1 Airspeed (kt), 0..200 over 320 deg, coloured arcs.
  {
    const [cx, cy] = pos(0);
    dialFace(c, cx, cy, r);
    const a = (v: number) => (-90 + (Math.min(v, 200) / 200) * 330) / DEG;
    const arc = (v0: number, v1: number, col: string, rr: number) => {
      c.strokeStyle = col;
      c.lineWidth = r * 0.07;
      c.beginPath();
      c.arc(cx, cy, r * rr, a(v0), a(v1));
      c.stroke();
    };
    arc(33, 85, '#f0f0f0', 0.8);
    arc(44, 129, '#20c040', 0.88);
    arc(129, 163, '#e8d020', 0.88);
    arc(163, 166, '#e02020', 0.88);
    ticks(c, cx, cy, r * 0.96, a(0), a(200), 40, 4);
    for (const v of [40, 60, 80, 100, 120, 140, 160]) {
      const t = a(v);
      label(
        c,
        String(v),
        cx + Math.cos(t) * r * 0.62,
        cy + Math.sin(t) * r * 0.62,
        r * 0.16,
        '#eee',
        'center',
      );
    }
    label(c, 'KNOTS', cx, cy + r * 0.3, r * 0.12, '#ccc', 'center');
    needle(c, cx, cy, r * 0.85, a(kt));
  }
  // 2 Attitude indicator.
  {
    const [cx, cy] = pos(1);
    attitude(c, cx - r, cy - r, 2 * r, 2 * r, cx, cy, d, r / 30, '#2c6db8', '#6b4422', true);
    c.strokeStyle = '#111';
    c.lineWidth = r * 0.12;
    c.beginPath();
    c.arc(cx, cy, r * 0.94, 0, Math.PI * 2);
    c.stroke();
    bankScale(c, cx, cy, r * 0.8, d, '#eee');
    line(c, cx - r * 0.5, cy, cx - r * 0.15, cy, '#ff8a00', 4);
    line(c, cx + r * 0.15, cy, cx + r * 0.5, cy, '#ff8a00', 4);
    c.fillStyle = '#ff8a00';
    c.beginPath();
    c.arc(cx, cy, r * 0.05, 0, Math.PI * 2);
    c.fill();
  }
  // 3 Altimeter: 100 ft needle, 1000 ft needle, 10000 ft pointer, Kollsman window.
  {
    const [cx, cy] = pos(2);
    dialFace(c, cx, cy, r);
    ticks(c, cx, cy, r * 0.96, -Math.PI / 2, (3 * Math.PI) / 2, 50, 5);
    for (let i = 0; i < 10; i++) {
      const t = -Math.PI / 2 + (i / 10) * Math.PI * 2;
      label(
        c,
        String(i),
        cx + Math.cos(t) * r * 0.68,
        cy + Math.sin(t) * r * 0.68,
        r * 0.2,
        '#eee',
        'center',
      );
    }
    box(c, cx + r * 0.25, cy - r * 0.08, r * 0.42, r * 0.18, '#777', '#000');
    label(c, '29.92', cx + r * 0.46, cy + r * 0.01, r * 0.12, '#eee', 'center');
    const ft = Math.max(0, d.alt * FT);
    const t = (v: number) => -Math.PI / 2 + v * Math.PI * 2;
    needle(c, cx, cy, r * 0.12 + r * 0.7, t((ft % 10000) / 10000), 1.5);
    needle(c, cx, cy, r * 0.5, t((ft % 10000) / 10000), 5);
    needle(c, cx, cy, r * 0.82, t((ft % 1000) / 1000), 3);
  }
  // 4 Turn coordinator: little aircraft tilts with the turn rate, standard rate marks.
  {
    const [cx, cy] = pos(3);
    dialFace(c, cx, cy, r);
    const std = (3 / DEG) * 1; // 3 deg/s
    const tilt = Math.max(-1.5, Math.min(1.5, d.turnRate / std)) * (20 / DEG);
    for (const s of [-1, 1]) {
      const t = s * (20 / DEG);
      line(
        c,
        cx - Math.cos(t) * r * 0.85,
        cy + Math.sin(t) * r * 0.85 * s * s,
        cx - Math.cos(t) * r * 0.65,
        cy + Math.sin(t) * r * 0.65,
        '#eee',
        3,
      );
      line(
        c,
        cx + Math.cos(t) * r * 0.65,
        cy + Math.sin(t) * r * 0.65,
        cx + Math.cos(t) * r * 0.85,
        cy + Math.sin(t) * r * 0.85,
        '#eee',
        3,
      );
    }
    label(c, 'L', cx - r * 0.75, cy + r * 0.42, r * 0.16, '#eee', 'center');
    label(c, 'R', cx + r * 0.75, cy + r * 0.42, r * 0.16, '#eee', 'center');
    label(c, 'TURN COORDINATOR', cx, cy - r * 0.55, r * 0.1, '#ccc', 'center');
    c.save();
    c.translate(cx, cy);
    c.rotate(tilt);
    c.fillStyle = '#eee';
    c.fillRect(-r * 0.62, -r * 0.035, r * 1.24, r * 0.07);
    c.beginPath();
    c.arc(0, 0, r * 0.1, 0, Math.PI * 2);
    c.fill();
    c.fillRect(-r * 0.02, -r * 0.22, r * 0.04, r * 0.15);
    c.restore();
    // Inclinometer (ball): slip from bank without turn.
    const slip = Math.max(-1, Math.min(1, (Math.sin(d.bank) - (d.turnRate * d.ias) / 9.81) * 2));
    box(c, cx - r * 0.45, cy + r * 0.5, r * 0.9, r * 0.2, '#888', '#202020');
    c.fillStyle = '#000';
    c.beginPath();
    c.arc(cx + slip * r * 0.35, cy + r * 0.6, r * 0.08, 0, Math.PI * 2);
    c.fill();
    line(c, cx - r * 0.1, cy + r * 0.5, cx - r * 0.1, cy + r * 0.7, '#eee', 1.5);
    line(c, cx + r * 0.1, cy + r * 0.5, cx + r * 0.1, cy + r * 0.7, '#eee', 1.5);
  }
  // 5 Heading indicator (directional gyro).
  {
    const [cx, cy] = pos(4);
    dialFace(c, cx, cy, r);
    c.save();
    c.translate(cx, cy);
    for (let a = 0; a < 360; a += 5) {
      const t = (a - d.heading - 90) / DEG;
      const big = a % 10 === 0;
      const r0 = r * (big ? 0.8 : 0.86);
      line(
        c,
        Math.cos(t) * r0,
        Math.sin(t) * r0,
        Math.cos(t) * r * 0.93,
        Math.sin(t) * r * 0.93,
        '#eee',
        big ? 2 : 1,
      );
      if (a % 30 === 0) {
        const txt =
          a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a / 10);
        c.save();
        c.translate(Math.cos(t) * r * 0.62, Math.sin(t) * r * 0.62);
        c.rotate(t + Math.PI / 2);
        label(c, txt, 0, 0, r * 0.2, '#eee', 'center');
        c.restore();
      }
    }
    c.restore();
    c.fillStyle = '#ff8a00';
    c.beginPath();
    c.moveTo(cx, cy - r * 0.95);
    c.lineTo(cx - r * 0.06, cy - r * 1.05);
    c.lineTo(cx + r * 0.06, cy - r * 1.05);
    c.fill();
    c.strokeStyle = '#ff8a00';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(cx, cy - r * 0.35);
    c.lineTo(cx, cy + r * 0.3);
    c.moveTo(cx - r * 0.3, cy - r * 0.05);
    c.lineTo(cx + r * 0.3, cy - r * 0.05);
    c.moveTo(cx - r * 0.12, cy + r * 0.25);
    c.lineTo(cx + r * 0.12, cy + r * 0.25);
    c.stroke();
  }
  // 6 Vertical speed (x100 ft/min), zero at 9 o'clock, +-2000.
  {
    const [cx, cy] = pos(5);
    dialFace(c, cx, cy, r);
    const fpm = Math.max(-2000, Math.min(2000, d.vs * FPM));
    const t = (v: number) => Math.PI + (v / 2000) * (Math.PI * 0.9);
    ticks(c, cx, cy, r * 0.96, t(-2000), t(2000), 40, 5);
    for (const v of [5, 10, 15, 20]) {
      for (const s of [1, -1]) {
        const a = t(s * v * 100);
        label(
          c,
          String(v),
          cx + Math.cos(a) * r * 0.66,
          cy + Math.sin(a) * r * 0.66,
          r * 0.17,
          '#eee',
          'center',
        );
      }
    }
    label(c, '0', cx - r * 0.66, cy, r * 0.18, '#eee', 'center');
    label(c, 'UP', cx - r * 0.25, cy - r * 0.3, r * 0.11, '#ccc', 'center');
    label(c, 'DOWN', cx - r * 0.25, cy + r * 0.3, r * 0.11, '#ccc', 'center');
    needle(c, cx, cy, r * 0.85, t(fpm));
  }
}

function c172Engine(c: Ctx, W: number, H: number, d: CockpitData) {
  c.fillStyle = '#1b1c1e';
  c.fillRect(0, 0, W, H);
  // Tachometer (x100 rpm).
  const r = H * 0.44;
  const cx = H * 0.52;
  const cy = H * 0.52;
  dialFace(c, cx, cy, r);
  const t = (v: number) => (-225 + (Math.min(v, 3500) / 3500) * 270) / DEG;
  c.strokeStyle = '#20c040';
  c.lineWidth = r * 0.1;
  c.beginPath();
  c.arc(cx, cy, r * 0.86, t(2100), t(2700));
  c.stroke();
  ticks(c, cx, cy, r * 0.95, t(0), t(3500), 35, 5);
  for (const v of [0, 5, 10, 15, 20, 25, 30, 35]) {
    const a = t(v * 100);
    label(
      c,
      String(v),
      cx + Math.cos(a) * r * 0.62,
      cy + Math.sin(a) * r * 0.62,
      r * 0.2,
      '#eee',
      'center',
    );
  }
  needle(c, cx, cy, r * 0.82, t(d.crashed ? 0 : d.engine));
  label(c, 'RPM', cx, cy + r * 0.45, r * 0.16, '#ccc', 'center');
  // Small engine gauges: fuel L / R, oil temp, oil press, EGT, ammeter.
  const g: Array<[string, number]> = [
    ['FUEL L', 0.78 - d.time / 20000],
    ['FUEL R', 0.76 - d.time / 20000],
    ['OIL T', 0.45 + 0.2 * d.throttle],
    ['OIL P', 0.55 + 0.2 * d.throttle],
    ['EGT', 0.3 + 0.5 * d.throttle],
    ['AMP', 0.55],
  ];
  const x0 = H * 1.05;
  const cw = (W - x0) / g.length;
  g.forEach(([name, f], i) => {
    const gx = x0 + cw * (i + 0.5);
    const gy = H * 0.6;
    const rr = Math.min(cw * 0.42, H * 0.35);
    dialFace(c, gx, gy, rr);
    const a = (v: number) => (-150 + v * 120) / DEG;
    c.strokeStyle = '#20c040';
    c.lineWidth = rr * 0.12;
    c.beginPath();
    c.arc(gx, gy, rr * 0.8, a(0.25), a(0.8));
    c.stroke();
    needle(c, gx, gy, rr * 0.85, a(Math.max(0, Math.min(1, f))), 2);
    label(c, name, gx, H * 0.12, H * 0.13, '#ddd', 'center');
  });
}

function lcd(
  c: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  left: string,
  right: string,
  color = '#ffb020',
) {
  box(c, x, y, w, h, '#333', '#0a0603');
  label(c, left, x + w * 0.04, y + h / 2, h * 0.55, color, 'left', MONO);
  label(c, right, x + w * 0.96, y + h / 2, h * 0.55, color, 'right', MONO);
}

function radioStack(c: Ctx, W: number, H: number, d: CockpitData) {
  c.fillStyle = '#121314';
  c.fillRect(0, 0, W, H);
  const u = H / 10;
  // Audio panel.
  box(c, W * 0.04, u * 0.2, W * 0.92, u * 0.9, '#444', '#1e1f21');
  ['COM1', 'COM2', 'NAV1', 'MKR', 'ADF'].forEach((t, i) =>
    label(c, t, W * (0.12 + i * 0.19), u * 0.65, u * 0.35, i === 0 ? '#9f9' : '#bbb', 'center'),
  );
  // GPS/NAV/COM (GNS 430 style): frequencies left, small map right.
  box(c, W * 0.04, u * 1.3, W * 0.92, u * 3.6, '#444', '#1e1f21');
  lcd(c, W * 0.07, u * 1.5, W * 0.4, u * 0.7, '122.800', '', '#40ff80');
  lcd(c, W * 0.07, u * 2.3, W * 0.4, u * 0.7, '121.500', '', '#40a0ff');
  lcd(c, W * 0.07, u * 3.1, W * 0.4, u * 0.7, '114.85', '', '#40ff80');
  lcd(c, W * 0.07, u * 3.9, W * 0.4, u * 0.7, '110.30', '', '#40a0ff');
  c.fillStyle = '#062010';
  c.fillRect(W * 0.5, u * 1.5, W * 0.43, u * 3.1);
  c.save();
  c.beginPath();
  c.rect(W * 0.5, u * 1.5, W * 0.43, u * 3.1);
  c.clip();
  const mx = W * 0.715;
  const my = u * 3.6;
  line(c, mx, my, mx + Math.sin(0.3) * u * 3, my - u * 3, '#ff40ff', 2);
  c.fillStyle = '#fff';
  c.beginPath();
  c.moveTo(mx, my - u * 0.25);
  c.lineTo(mx - u * 0.15, my + u * 0.15);
  c.lineTo(mx + u * 0.15, my + u * 0.15);
  c.fill();
  c.restore();
  label(c, `GS ${Math.round(d.ias * KT)}KT`, W * 0.52, u * 4.4, u * 0.3, '#fff', 'left', MONO);
  label(
    c,
    `TRK ${pad(wrap360(Math.round(d.heading)), 3)}°`,
    W * 0.92,
    u * 4.4,
    u * 0.3,
    '#fff',
    'right',
    MONO,
  );
  // NAV/COM 2.
  box(c, W * 0.04, u * 5.1, W * 0.92, u * 1.4, '#444', '#1e1f21');
  lcd(c, W * 0.07, u * 5.35, W * 0.86, u * 0.9, '119.225', '118.100', '#ffb020');
  // Transponder.
  box(c, W * 0.04, u * 6.7, W * 0.92, u * 1.2, '#444', '#1e1f21');
  lcd(
    c,
    W * 0.07,
    u * 6.9,
    W * 0.86,
    u * 0.8,
    `ALT ${pad(Math.round((d.alt * FT) / 100), 3)}`,
    '7000',
    '#ffb020',
  );
  // Autopilot (KAP 140 style).
  box(c, W * 0.04, u * 8.1, W * 0.92, u * 1.5, '#444', '#1e1f21');
  lcd(
    c,
    W * 0.07,
    u * 8.3,
    W * 0.86,
    u * 0.9,
    'ROL',
    `${pad(Math.round((d.alt * FT) / 100) * 100, 5)}FT`,
    '#ffb020',
  );
}

// ---------------------------------------------------------------------------
// Glareshield (FCU / MCP / AFCS), MCDU, overhead
// ---------------------------------------------------------------------------

function fcu(c: Ctx, W: number, H: number, d: CockpitData, style: Style) {
  c.fillStyle = style === 'boeing' ? '#4a4d52' : '#2b2e33';
  c.fillRect(0, 0, W, H);
  const kt = Math.round(d.ias * KT);
  const items: Array<[string, string]> =
    style === 'airbus'
      ? [
          ['SPD', String(kt)],
          ['HDG', pad(wrap360(Math.round(d.heading)), 3)],
          ['ALT', pad(Math.round((d.alt * FT) / 100) * 100, 5)],
          ['V/S', `${d.vs >= 0 ? '+' : '-'}${pad(Math.abs(Math.round((d.vs * FPM) / 100)), 2)}oo`],
        ]
      : style === 'boeing'
        ? [
            ['IAS', String(kt)],
            ['HDG', pad(wrap360(Math.round(d.heading)), 3)],
            ['V/S', String(Math.round((d.vs * FPM) / 100) * 100)],
            ['ALT', String(Math.round((d.alt * FT) / 100) * 100)],
          ]
        : [
            ['HDG', pad(wrap360(Math.round(d.heading)), 3)],
            ['ALT', String(Math.round((d.alt * FT) / 100) * 100)],
            ['VS', String(Math.round((d.vs * FPM) / 100) * 100)],
            ['IAS', String(kt)],
          ];
  const n = items.length;
  const cw = W / n;
  items.forEach(([name, val], i) => {
    const x = cw * i + cw * 0.12;
    label(c, name, cw * (i + 0.5), H * 0.2, H * 0.22, '#ddd', 'center');
    box(c, x, H * 0.36, cw * 0.76, H * 0.5, '#111', '#0c0805');
    label(
      c,
      val,
      cw * (i + 0.5),
      H * 0.62,
      H * 0.38,
      style === 'boeing' ? '#fff' : '#ffb020',
      'center',
      MONO,
    );
  });
}

function mcdu(c: Ctx, W: number, H: number, d: CockpitData, style: Style) {
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);
  const rows = 8;
  const lh = H / (rows + 1);
  const ns = d.lat >= 0 ? 'N' : 'S';
  const ew = d.lon >= 0 ? 'E' : 'W';
  const deg = (v: number) => `${Math.floor(Math.abs(v))}°${((Math.abs(v) % 1) * 60).toFixed(1)}`;
  const lines: Array<[string, string, string]> = [
    [style === 'garmin' ? 'FPL' : 'POSITION MONITOR', '', '#fff'],
    ['FMS', `${ns}${deg(d.lat)}/${ew}${deg(d.lon)}`, '#00ff66'],
    ['GPS', 'NAV ACCUR HIGH', '#00ff66'],
    ['IAS/ALT', `${Math.round(d.ias * KT)}/${Math.round(d.alt * FT)}`, '#0ff'],
    ['HDG/VS', `${pad(wrap360(Math.round(d.heading)), 3)}/${Math.round(d.vs * FPM)}`, '#0ff'],
    ['FLT NBR', 'TRA001', '#fff'],
    ['TIME', clock(d.time), '#00ff66'],
    ['<RETURN', 'NEXT PAGE>', '#fff'],
  ];
  lines.forEach(([a, b, col], i) => {
    const y = lh * (i + 0.9);
    if (i === 0) label(c, a, W / 2, y, lh * 0.62, col, 'center', MONO);
    else {
      label(c, a, W * 0.03, y, lh * 0.5, '#fff', 'left', MONO);
      label(c, b, W * 0.97, y, lh * 0.55, col, 'right', MONO);
    }
  });
}

function overhead(c: Ctx, W: number, H: number, style: Style) {
  c.fillStyle = style === 'airbus' ? '#5a6068' : '#4c5056';
  c.fillRect(0, 0, W, H);
  // Panels in columns, push buttons ("dark cockpit": only a few lights on), guarded switches.
  const cols = 6;
  const rows = 4;
  const names =
    style === 'airbus'
      ? [
          'ADIRS',
          'FLT CTL',
          'EVAC',
          'ELEC',
          'FUEL',
          'AIR COND',
          'ANTI ICE',
          'HYD',
          'ENG',
          'APU',
          'EXT LT',
          'SIGNS',
          'CALLS',
          'RCDR',
          'OXY',
          'WIPER',
          'INT LT',
          'CARGO',
          'FIRE',
          'GPWS',
          'BLEED',
          'PRESS',
          'VENT',
          'MAINT',
        ]
      : [
          'IRS',
          'ELEC',
          'HYD',
          'FUEL',
          'AIR',
          'ENG START',
          'ANTI ICE',
          'LIGHTS',
          'PASS SIGNS',
          'APU',
          'FIRE',
          'BLEED',
          'PRESS',
          'WIPERS',
          'YAW DAMP',
          'GEN',
          'BATT',
          'STBY PWR',
          'CARGO',
          'DOORS',
          'EMER LT',
          'OXY',
          'GND PROX',
          'WX',
        ];
  const pw = W / cols;
  const ph = H / rows;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const x = k * pw;
      const y = r * ph;
      box(c, x + 3, y + 3, pw - 6, ph - 6, '#2a2c30', undefined, 2);
      label(c, names[r * cols + k] ?? '', x + pw / 2, y + ph * 0.12, ph * 0.1, '#f2f2f2', 'center');
      for (let i = 0; i < 6; i++) {
        const bx = x + pw * (0.12 + (i % 3) * 0.28);
        const by = y + ph * (0.3 + Math.floor(i / 3) * 0.35);
        box(c, bx, by, pw * 0.2, ph * 0.22, '#222', '#1a1b1d');
        const lit = (r * 7 + k * 3 + i) % 11 === 0;
        label(
          c,
          lit ? (i % 2 ? 'ON' : 'OFF') : '',
          bx + pw * 0.1,
          by + ph * 0.11,
          ph * 0.08,
          lit ? (i % 2 ? '#40c0ff' : '#ffffff') : '#000',
          'center',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// F-35 panoramic cockpit display: four portals
// ---------------------------------------------------------------------------

function panoramic(c: Ctx, W: number, H: number, d: CockpitData) {
  const pw = W / 4;
  const top = H * 0.08;
  c.fillStyle = '#101418';
  c.fillRect(0, 0, W, top);
  ['FUEL', 'ENG', 'TSD', 'TSD-2', 'SMS', 'FCS', 'ICAWS', 'CNI'].forEach((t, i) =>
    label(c, t, (W / 8) * (i + 0.5), top / 2, top * 0.55, '#5f5', 'center'),
  );
  // Portal 1: engine and fuel.
  c.save();
  c.translate(0, top);
  const ph = H - top;
  label(c, 'ENG', pw / 2, ph * 0.07, ph * 0.06, '#fff', 'center');
  arcGauge(c, pw * 0.5, ph * 0.32, ph * 0.16, d.engine, 0, 110, 104);
  label(c, `${d.engine.toFixed(0)} %`, pw * 0.5, ph * 0.45, ph * 0.06, '#5f5', 'center');
  label(
    c,
    d.boosting ? 'AB' : 'MIL',
    pw * 0.5,
    ph * 0.53,
    ph * 0.05,
    d.boosting ? '#ffb000' : '#5f5',
    'center',
  );
  label(c, 'FUEL', pw * 0.1, ph * 0.66, ph * 0.05, '#fff');
  const fuel = Math.max(0, 18000 - d.time * (d.boosting ? 40 : 8));
  bar(c, pw * 0.1, ph * 0.72, pw * 0.8, ph * 0.06, fuel / 18500, '#5f5');
  label(c, `${Math.round(fuel)} LB`, pw * 0.9, ph * 0.66, ph * 0.05, '#5f5', 'right');
  label(
    c,
    `G ${d.gLoad.toFixed(1)}   AOA ${(d.aoa * DEG).toFixed(0)}`,
    pw * 0.5,
    ph * 0.88,
    ph * 0.05,
    '#5f5',
    'center',
  );
  c.restore();
  // Portal 2: flight (attitude + speed / altitude readouts).
  {
    const x = pw;
    attitude(
      c,
      x + 4,
      top + 4,
      pw - 8,
      H - top - 8,
      x + pw / 2,
      top + (H - top) * 0.5,
      d,
      (H - top) / 60,
      '#0d2c55',
      '#2a1a0c',
    );
    bankScale(c, x + pw / 2, top + (H - top) * 0.5, (H - top) * 0.36, d, '#5f5');
    aircraftSymbol(c, x + pw / 2, top + (H - top) * 0.5, pw * 0.07, 'airbus');
    box(c, x + 8, top + (H - top) * 0.44, pw * 0.22, (H - top) * 0.12, '#5f5', '#000');
    label(
      c,
      String(Math.round(d.ias * KT)),
      x + 8 + pw * 0.11,
      top + (H - top) * 0.5,
      (H - top) * 0.07,
      '#5f5',
      'center',
    );
    box(
      c,
      x + pw - 8 - pw * 0.26,
      top + (H - top) * 0.44,
      pw * 0.26,
      (H - top) * 0.12,
      '#5f5',
      '#000',
    );
    label(
      c,
      String(Math.round(d.alt * FT)),
      x + pw - 8 - pw * 0.13,
      top + (H - top) * 0.5,
      (H - top) * 0.07,
      '#5f5',
      'center',
    );
  }
  // Portals 3 + 4: tactical situation display (big map).
  c.save();
  c.translate(pw * 2, top);
  c.fillStyle = '#04100a';
  c.fillRect(0, 0, pw * 2, H - top);
  nd(c, pw * 2, H - top, d, '#5f5');
  c.restore();
  for (let i = 1; i < 4; i++) line(c, pw * i, top, pw * i, H, i === 2 ? '#05070a' : '#333', 3);
}
