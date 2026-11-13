import type { AirportOption } from '../api';

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

/**
 * Locator map of Switzerland. The airport list next to it is the accessible control; the
 * dots are a pointer shortcut and therefore hidden from assistive technology.
 */
export function SwissMap(props: {
  airports: AirportOption[];
  selected: string;
  onSelect?: (icao: string) => void;
  label: string;
}) {
  const sel = props.airports.find((a) => a.icao === props.selected);
  return (
    <figure
      class={`swissmap${props.onSelect ? ' is-interactive' : ''}`}
      role="img"
      aria-label={props.label}
    >
      <svg
        viewBox={`0 0 ${MAP_W.toFixed(0)} ${MAP_H.toFixed(0)}`}
        preserveAspectRatio="xMidYMid meet"
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
        {sel &&
          (() => {
            const [x, y] = project(sel.lon, sel.lat);
            return <circle cx={x} cy={y} r="26" fill="url(#swissmap-glow)" class="swissmap-glow" />;
          })()}
        {props.airports.map((a) => {
          const [x, y] = project(a.lon, a.lat);
          const on = a.icao === props.selected;
          // Labels go left of dots in the east of the map so they stay inside the frame.
          const left = x > MAP_W * 0.78;
          return (
            <g
              key={a.icao}
              class={`swissmap-apt${on ? ' is-on' : ''}`}
              transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
              onClick={() => props.onSelect?.(a.icao)}
              aria-hidden="true"
            >
              <circle class="swissmap-hit" r="12" />
              {on && <circle class="swissmap-ring" r="7" />}
              <circle class="swissmap-dot" r={on ? 3.6 : 2.6} />
              <text
                class="swissmap-label"
                x={left ? -7 : 7}
                y="3"
                text-anchor={left ? 'end' : 'start'}
              >
                {a.icao}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
