import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { AirportOption } from '../api';
import { IconExpand, IconMinus, IconPlus } from '../components/icons';

/**
 * Outline of Switzerland (and a few lakes for orientation), simplified by hand to about
 * 2 km, as [lon, lat] in degrees. Clockwise from Basel. A stylised locator map, not survey
 * data: the world package has the real borders when a precise map is needed.
 */
const BORDER: [number, number][] = [
  [7.586, 47.59],
  [7.64, 47.6],
  [7.69, 47.572],
  [7.795, 47.556],
  [7.91, 47.556],
  [8.06, 47.566],
  [8.225, 47.605],
  [8.4, 47.58],
  [8.47, 47.63],
  [8.52, 47.64],
  [8.47, 47.66],
  [8.52, 47.78],
  [8.62, 47.81],
  [8.73, 47.76],
  [8.82, 47.71],
  [8.87, 47.665],
  [9.0, 47.68],
  [9.18, 47.656],
  [9.38, 47.57],
  [9.56, 47.505],
  [9.64, 47.452],
  [9.63, 47.4],
  [9.56, 47.32],
  [9.53, 47.27],
  [9.49, 47.18],
  [9.48, 47.06],
  [9.6, 47.06],
  [9.87, 47.02],
  [10.1, 46.85],
  [10.23, 46.87],
  [10.39, 46.99],
  [10.49, 46.94],
  [10.47, 46.86],
  [10.48, 46.62],
  [10.44, 46.54],
  [10.3, 46.55],
  [10.22, 46.63],
  [10.1, 46.6],
  [10.05, 46.47],
  [10.16, 46.4],
  [10.17, 46.3],
  [10.14, 46.23],
  [10.05, 46.25],
  [9.98, 46.33],
  [9.95, 46.38],
  [9.8, 46.36],
  [9.71, 46.3],
  [9.52, 46.32],
  [9.45, 46.4],
  [9.33, 46.51],
  [9.28, 46.42],
  [9.22, 46.3],
  [9.16, 46.17],
  [9.08, 46.11],
  [9.08, 46.03],
  [9.04, 45.92],
  [9.03, 45.82],
  [8.94, 45.85],
  [8.92, 45.88],
  [8.86, 45.97],
  [8.8, 46.0],
  [8.72, 46.1],
  [8.6, 46.13],
  [8.45, 46.22],
  [8.44, 46.33],
  [8.47, 46.45],
  [8.38, 46.48],
  [8.28, 46.38],
  [8.17, 46.3],
  [8.15, 46.15],
  [8.08, 46.11],
  [7.98, 46.0],
  [7.86, 45.92],
  [7.66, 45.98],
  [7.53, 45.97],
  [7.39, 45.9],
  [7.18, 45.86],
  [7.04, 45.92],
  [6.94, 46.02],
  [6.86, 46.09],
  [6.8, 46.15],
  [6.86, 46.25],
  [6.79, 46.3],
  [6.8, 46.39],
  [6.6, 46.43],
  [6.4, 46.38],
  [6.24, 46.31],
  [6.3, 46.25],
  [6.22, 46.2],
  [6.13, 46.14],
  [5.97, 46.13],
  [6.03, 46.2],
  [6.1, 46.24],
  [6.15, 46.3],
  [6.07, 46.4],
  [6.12, 46.47],
  [6.14, 46.59],
  [6.38, 46.71],
  [6.46, 46.85],
  [6.46, 46.91],
  [6.63, 46.99],
  [6.72, 47.05],
  [6.86, 47.1],
  [6.96, 47.22],
  [6.95, 47.29],
  [7.0, 47.36],
  [6.88, 47.37],
  [6.94, 47.43],
  [7.01, 47.5],
  [7.13, 47.5],
  [7.2, 47.44],
  [7.32, 47.44],
  [7.42, 47.45],
  [7.46, 47.48],
  [7.53, 47.52],
];

const LAKES: [number, number][][] = [
  // Lake Geneva
  [
    [6.15, 46.21],
    [6.24, 46.3],
    [6.33, 46.38],
    [6.48, 46.45],
    [6.63, 46.52],
    [6.8, 46.46],
    [6.92, 46.39],
    [6.82, 46.38],
    [6.62, 46.4],
    [6.45, 46.36],
    [6.3, 46.3],
    [6.18, 46.22],
  ],
  // Lake Neuchâtel
  [
    [6.64, 46.77],
    [6.77, 46.84],
    [6.95, 46.97],
    [7.05, 47.0],
    [7.02, 46.94],
    [6.87, 46.85],
    [6.7, 46.76],
  ],
  // Lakes Thun and Brienz
  [
    [7.62, 46.75],
    [7.7, 46.73],
    [7.85, 46.69],
    [7.84, 46.66],
    [7.68, 46.69],
    [7.6, 46.73],
  ],
  [
    [7.89, 46.69],
    [8.01, 46.75],
    [8.08, 46.75],
    [7.98, 46.71],
    [7.89, 46.67],
  ],
  // Lake Lucerne
  [
    [8.31, 47.05],
    [8.42, 47.03],
    [8.47, 46.99],
    [8.6, 46.99],
    [8.62, 46.92],
    [8.58, 46.94],
    [8.45, 46.97],
    [8.33, 47.01],
  ],
  // Lake Zurich
  [
    [8.54, 47.36],
    [8.62, 47.28],
    [8.82, 47.22],
    [8.86, 47.21],
    [8.7, 47.25],
    [8.6, 47.3],
    [8.53, 47.35],
  ],
];

const LON0 = 5.85;
const LAT0 = 47.9;
/** Equirectangular at the latitude of Switzerland: east-west distances shrink by cos(46.8°). */
const KX = Math.cos((46.8 * Math.PI) / 180) * 100;
const KY = 100;
export const MAP_W = (10.6 - LON0) * KX;
export const MAP_H = (LAT0 - 45.75) * KY;

export function project(lon: number, lat: number): [number, number] {
  return [(lon - LON0) * KX, (LAT0 - lat) * KY];
}

function pathOf(points: [number, number][]): string {
  return (
    points
      .map(([lon, lat], i) => {
        const [x, y] = project(lon, lat);
        return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join('') + 'Z'
  );
}

const BORDER_PATH = pathOf(BORDER);
const LAKE_PATHS = LAKES.map(pathOf);

/** The view of the map: a window onto it in map units, always in the whole map's proportions. */
export interface MapView {
  x: number;
  y: number;
  w: number;
}

const ASPECT = MAP_H / MAP_W;
/** About 25 km across at the closest: enough to pick apart the fields around Bern or Zürich. */
const MIN_ZOOM_W = 22;

/** A view kept inside the map and between the closest zoom and the whole country. */
export function clampView(v: MapView): MapView {
  const w = Math.min(MAP_W, Math.max(MIN_ZOOM_W, v.w));
  const h = w * ASPECT;
  return {
    w,
    x: Math.max(0, Math.min(MAP_W - w, v.x)),
    y: Math.max(0, Math.min(MAP_H - h, v.y)),
  };
}

/** Zooms by `factor` (below 1 is closer) around a point of the map that stays put. */
export function zoomView(v: MapView, factor: number, px: number, py: number): MapView {
  const w = Math.min(MAP_W, Math.max(MIN_ZOOM_W, v.w * factor));
  const f = w / v.w;
  return clampView({ w, x: px - (px - v.x) * f, y: py - (py - v.y) * f });
}

/** Inverse of `project`. */
export function unproject(x: number, y: number): [number, number] {
  return [x / KX + LON0, LAT0 - y / KY];
}

/** A press that moves less than this (CSS pixels) is a tap, not a drag. */
const TAP_PX = 6;
/** How far from a dot (CSS pixels) a tap still picks it: a dot is far smaller than a finger. */
const PICK_PX = 22;

/** Rough size of an ICAO label in map units at full view, for keeping labels apart. */
const LABEL_CHAR_W = 6;
const LABEL_H = 12;

/**
 * Locator map of Switzerland. The airport list next to it is the accessible control; the
 * dots are a pointer shortcut and therefore hidden from assistive technology.
 *
 * With `zoomable` the wheel, a pinch or the buttons zoom and a drag pans. A tap picks the
 * nearest airport within a finger's reach (or, with `onPlace`, puts a place there). Labels are
 * placed largest airport first and only where they do not overlap one already placed, so the
 * crowded Mittelland reads as dots until one zooms in.
 */
export function SwissMap(props: {
  airports: AirportOption[];
  selected: string;
  onSelect?: (icao: string) => void;
  label: string;
  /** A flight from one airport to another: a dashed line and a marker at the far end. */
  route?: { from: string; to: string };
  /** Airports that get a label at any zoom (the others only once there is room). */
  isMain?: (a: AirportOption) => boolean;
  /** The text of a dot's label (the place name); the ICAO code without it. */
  labelOf?: (a: AirportOption) => string;
  /** Which label wins where two would overlap: higher first (e.g. the longest runway). */
  labelPriority?: (a: AirportOption) => number;
  /** The airport highlighted from outside (a list row under the pointer), and back out. */
  hovered?: string | null;
  onHover?: (icao: string | null) => void;
  zoomable?: boolean;
  /** An air start placed on the map, drawn as a marker with its heading. */
  place?: { lon: number; lat: number; heading: number } | null;
  /** When set, a tap puts the place there instead of picking an airport. */
  onPlace?: (lon: number, lat: number) => void;
  /** Labels of the zoom buttons. */
  zoomLabels?: { in: string; out: string; reset: string };
}) {
  const home: MapView = { x: 0, y: 0, w: MAP_W };
  const view = useSignal<MapView>(home);
  const svgRef = useRef<SVGSVGElement>(null);
  const hoverOwn = useSignal<string | null>(null);

  const v = view.value;
  const h = v.w * ASPECT;
  // Dots, rings and labels keep their size on screen at any zoom.
  const k = v.w / MAP_W;
  const zoomed = v.w < MAP_W - 0.01;
  const hovered = props.hovered ?? hoverOwn.value;
  const labelOf = (a: AirportOption) => props.labelOf?.(a) ?? a.icao;
  const labelWidth = (a: AirportOption) => (labelOf(a).length * LABEL_CHAR_W + 4) * k;
  // A label goes left of its dot where it would run out of the frame on the right.
  const labelLeft = (a: AirportOption, x: number) => x + labelWidth(a) + 8 * k > v.x + v.w;

  const sel = props.airports.find((a) => a.icao === props.selected);
  const from = props.airports.find((a) => a.icao === props.route?.from);
  const to = props.airports.find((a) => a.icao === props.route?.to);

  // Map units under a point of the screen (the transform covers letterboxing and CSS zoom).
  const toMap = (clientX: number, clientY: number): [number, number] | null => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  };
  /** Map units per CSS pixel at the present zoom. */
  const unitsPerPx = () => {
    const m = svgRef.current?.getScreenCTM();
    return m ? 1 / m.a : 1;
  };
  const nearestAt = (x: number, y: number): AirportOption | null => {
    const reach = PICK_PX * unitsPerPx();
    let best: AirportOption | null = null;
    let bestD = reach * reach;
    for (const a of props.airports) {
      const [ax, ay] = project(a.lon, a.lat);
      // A main airport wins a close call: it is the one a pilot most likely aimed at.
      const d = ((ax - x) ** 2 + (ay - y) ** 2) * (props.isMain?.(a) ? 0.5 : 1);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  };
  const setHover = (icao: string | null) => {
    if (hoverOwn.value === icao) return;
    hoverOwn.value = icao;
    props.onHover?.(icao);
  };

  // Pointers down on the map: one drags, two pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const interactive = !!(props.onSelect || props.onPlace || props.zoomable);

  const onDown = (e: PointerEvent) => {
    if (!interactive || (e.pointerType === 'mouse' && e.button !== 0)) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = { x: e.clientX, y: e.clientY, moved: false };
    else if (gesture.current) gesture.current.moved = true;
  };
  const onMove = (e: PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) {
      // A mouse passing over: highlight the airport it would pick.
      if (e.pointerType === 'mouse' && props.onSelect && !props.onPlace) {
        const p = toMap(e.clientX, e.clientY);
        setHover(p ? (nearestAt(p[0], p[1])?.icao ?? null) : null);
      }
      return;
    }
    const g = gesture.current;
    if (g && Math.hypot(e.clientX - g.x, e.clientY - g.y) > TAP_PX) g.moved = true;
    if (!props.zoomable || !g?.moved) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      return;
    }
    const all = [...pointers.current.entries()];
    if (all.length === 1) {
      const s = unitsPerPx();
      view.value = clampView({
        w: view.value.w,
        x: view.value.x - (e.clientX - prev.x) * s,
        y: view.value.y - (e.clientY - prev.y) * s,
      });
    } else if (all.length === 2) {
      const other = all.find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      const mid = toMap((e.clientX + other.x) / 2, (e.clientY + other.y) / 2);
      if (before > 0 && after > 0 && mid) view.value = zoomView(view.value, before / after, ...mid);
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onUp = (e: PointerEvent) => {
    const had = pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!had || pointers.current.size > 0) return;
    gesture.current = null;
    if (!g || g.moved || e.type === 'pointercancel') return;
    const p = toMap(e.clientX, e.clientY);
    if (!p) return;
    if (props.onPlace) {
      const [lon, lat] = unproject(p[0], p[1]);
      props.onPlace(lon, lat);
      return;
    }
    const a = nearestAt(p[0], p[1]);
    if (a) props.onSelect?.(a.icao);
  };

  // The wheel zooms around the pointer. Not passive: the sheet must not scroll meanwhile.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !props.zoomable) return;
    const onWheel = (e: WheelEvent) => {
      const p = toMap(e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      view.value = zoomView(view.value, Math.exp(Math.sign(e.deltaY) * 0.25), ...p);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [props.zoomable]);

  const zoomBy = (factor: number) =>
    (view.value = zoomView(
      view.value,
      factor,
      view.value.x + view.value.w / 2,
      view.value.y + (view.value.w * ASPECT) / 2,
    ));

  // Labels: the selected and hovered airport always, then the main ones, then (zoomed in) any
  // that still fit, each only where it does not cover one already placed.
  const labelled = new Set<string>();
  {
    const boxes: [number, number, number, number][] = [];
    const rank = (a: AirportOption) =>
      a.icao === props.selected || a.icao === hovered
        ? 0
        : a === from || a === to
          ? 1
          : props.isMain?.(a)
            ? 2
            : 3;
    const candidates = props.airports
      .filter((a) => rank(a) < 3 || !props.isMain || k <= 0.55)
      .sort(
        (x, y) =>
          rank(x) - rank(y) || (props.labelPriority?.(y) ?? 0) - (props.labelPriority?.(x) ?? 0),
      );
    for (const a of candidates) {
      const [x, y] = project(a.lon, a.lat);
      const left = labelLeft(a, x);
      const bw = labelWidth(a);
      const bh = LABEL_H * k;
      const box: [number, number, number, number] = [
        left ? x - bw - 3 * k : x - 3 * k,
        y - bh / 2,
        left ? x + 3 * k : x + bw,
        y + bh / 2,
      ];
      const free = boxes.every(
        (b) => box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3],
      );
      if (free || rank(a) === 0) {
        boxes.push(box);
        labelled.add(a.icao);
      }
    }
  }

  const map = (
    <figure
      class={`swissmap${props.onSelect || props.onPlace ? ' is-interactive' : ''}${zoomed ? ' is-zoomed' : ''}${props.onPlace ? ' is-placing' : ''}`}
      role="img"
      aria-label={props.label}
    >
      <svg
        ref={svgRef}
        viewBox={`${v.x.toFixed(2)} ${v.y.toFixed(2)} ${v.w.toFixed(2)} ${h.toFixed(2)}`}
        preserveAspectRatio="xMidYMid meet"
        style={
          props.zoomable
            ? // Unzoomed, a vertical swipe still scrolls the sheet; zoomed, every drag pans.
              { touchAction: zoomed ? 'none' : 'pan-y' }
            : undefined
        }
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)}
      >
        <defs>
          <radialGradient id="swissmap-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0" stop-color="var(--c-accent)" stop-opacity="0.45" />
            <stop offset="1" stop-color="var(--c-accent)" stop-opacity="0" />
          </radialGradient>
          <pattern id="swissmap-grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M10 0H0V10" fill="none" stroke="rgb(255 255 255 / 0.05)" stroke-width="0.5" />
          </pattern>
          <clipPath id="swissmap-clip">
            <path d={BORDER_PATH} />
          </clipPath>
        </defs>
        <path class="swissmap-land" d={BORDER_PATH} />
        <rect
          width={MAP_W}
          height={MAP_H}
          fill="url(#swissmap-grid)"
          clip-path="url(#swissmap-clip)"
        />
        {LAKE_PATHS.map((d) => (
          <path class="swissmap-lake" d={d} key={d} />
        ))}
        <path class="swissmap-border" d={BORDER_PATH} />
        {from &&
          to &&
          from !== to &&
          (() => {
            const [x1, y1] = project(from.lon, from.lat);
            const [x2, y2] = project(to.lon, to.lat);
            return (
              <line
                class="swissmap-route"
                x1={x1.toFixed(2)}
                y1={y1.toFixed(2)}
                x2={x2.toFixed(2)}
                y2={y2.toFixed(2)}
                vector-effect="non-scaling-stroke"
              />
            );
          })()}
        {sel &&
          !props.onPlace &&
          (() => {
            const [x, y] = project(sel.lon, sel.lat);
            return (
              <circle cx={x} cy={y} r={26 * k} fill="url(#swissmap-glow)" class="swissmap-glow" />
            );
          })()}
        {props.airports.map((a) => {
          const [x, y] = project(a.lon, a.lat);
          const on = a.icao === props.selected;
          const hover = a.icao === hovered && !on;
          // The other end of the route (the selection is one end already).
          const end = !on && !!to && (a === to || a === from);
          const left = labelLeft(a, x);
          const main = !!props.isMain?.(a);
          return (
            <g
              key={a.icao}
              class={`swissmap-apt${on ? ' is-on' : ''}${hover ? ' is-hover' : ''}${end ? ' is-end' : ''}${main ? ' is-main' : ''}`}
              transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(4)})`}
              aria-hidden="true"
            >
              {(on || hover) && <circle class="swissmap-ring" r="7" />}
              <circle class="swissmap-dot" r={on ? 3.6 : hover ? 3.4 : main ? 2.8 : 2.2} />
              {labelled.has(a.icao) && (
                <text
                  class="swissmap-label"
                  x={left ? -7 : 7}
                  y="3"
                  text-anchor={left ? 'end' : 'start'}
                >
                  {labelOf(a)}
                </text>
              )}
            </g>
          );
        })}
        {props.place &&
          (() => {
            const [x, y] = project(props.place.lon, props.place.lat);
            return (
              <g
                class="swissmap-place"
                transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(4)})`}
                aria-hidden="true"
              >
                <circle class="swissmap-place-halo" r="11" />
                <g transform={`rotate(${props.place.heading})`}>
                  <path
                    class="swissmap-place-arrow"
                    d="M0 -15 5 -5 1.6 -6.5 1.6 4 -1.6 4 -1.6 -6.5 -5 -5Z"
                  />
                </g>
                <circle class="swissmap-place-dot" r="2.6" />
              </g>
            );
          })()}
      </svg>
    </figure>
  );

  if (!props.zoomable) return map;
  const labels = props.zoomLabels ?? { in: '+', out: '−', reset: '⟲' };
  return (
    <div class="swissmap-frame">
      {map}
      <div class="swissmap-zoom">
        <button
          type="button"
          class="swissmap-zoom-btn"
          aria-label={labels.in}
          title={labels.in}
          disabled={v.w <= MIN_ZOOM_W + 0.01}
          onClick={() => zoomBy(0.6)}
        >
          <IconPlus size={18} />
        </button>
        <button
          type="button"
          class="swissmap-zoom-btn"
          aria-label={labels.out}
          title={labels.out}
          disabled={!zoomed}
          onClick={() => zoomBy(1 / 0.6)}
        >
          <IconMinus size={18} />
        </button>
        {(v.w !== home.w || v.x !== home.x || v.y !== home.y) && (
          <button
            type="button"
            class="swissmap-zoom-btn"
            aria-label={labels.reset}
            title={labels.reset}
            onClick={() => (view.value = home)}
          >
            <IconExpand size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
