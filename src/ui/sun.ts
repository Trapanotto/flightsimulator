/**
 * Where the sun stands during a day, for the time-of-day slider of the flight setup. A light
 * copy of the usual low-precision solar formulas (good to a few tenths of a degree): the sky
 * package has the precise one, but importing it would pull the renderer into the interface.
 */

const RAD = Math.PI / 180;

/** Sun elevation in degrees at a UTC instant. */
export function sunElevation(date: Date, lat: number, lon: number): number {
  const d = date.getTime() / 86_400_000 - 10_957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const l = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l));
  const dec = Math.asin(Math.sin(e) * Math.sin(l));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + lon) * RAD - ra;
  const sinAlt =
    Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;
}

/**
 * Offset of Swiss local time from UTC in hours on that day (1 in winter, 2 in summer).
 * The setup's hour is Swiss local time wherever the player sits.
 */
export function swissOffsetHours(date: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Zurich',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    if (Number.isFinite(h)) return (((h - date.getUTCHours()) % 24) + 24) % 24;
  } catch {
    // No time zone data: Central European Time is the safer guess.
  }
  return 1;
}

/** The UTC instant of a Swiss local hour on the calendar day of `day`. */
export function swissHourToDate(day: Date, hours: number): Date {
  const midnightUtc = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const offset = swissOffsetHours(new Date(midnightUtc + 12 * 3_600_000));
  return new Date(midnightUtc + (hours - offset) * 3_600_000);
}

/** The current Swiss local time of day in hours. */
export function swissNowHours(now: Date): number {
  const h = now.getUTCHours() + now.getUTCMinutes() / 60 + swissOffsetHours(now);
  return ((h % 24) + 24) % 24;
}

/** Sunrise and sunset (sun centre at -0.833°) in Swiss local hours, or null in polar cases. */
export function sunTimes(
  day: Date,
  lat: number,
  lon: number,
): { sunrise: number; sunset: number } | null {
  const h = -0.833;
  const elev = (hours: number) => sunElevation(swissHourToDate(day, hours), lat, lon) - h;
  const find = (from: number, to: number) => {
    let a = from;
    let b = to;
    if (Math.sign(elev(a)) === Math.sign(elev(b))) return null;
    for (let i = 0; i < 30; i++) {
      const m = (a + b) / 2;
      if (Math.sign(elev(m)) === Math.sign(elev(a))) a = m;
      else b = m;
    }
    return (a + b) / 2;
  };
  const sunrise = find(0, 13);
  const sunset = find(13, 24);
  return sunrise === null || sunset === null ? null : { sunrise, sunset };
}

/** Colour of the sky for a sun elevation: night, blue hour, golden hour, day. */
export function skyColour(elevation: number): string {
  const stops: [number, [number, number, number]][] = [
    [-18, [9, 13, 28]],
    [-8, [28, 38, 82]],
    [-2, [120, 82, 120]],
    [2, [236, 132, 68]],
    [8, [244, 190, 112]],
    [20, [118, 176, 228]],
    [60, [92, 160, 232]],
  ];
  if (elevation <= stops[0]![0]) return rgb(stops[0]![1]);
  for (let i = 1; i < stops.length; i++) {
    const [e1, c1] = stops[i]!;
    const [e0, c0] = stops[i - 1]!;
    if (elevation <= e1) {
      const f = (elevation - e0) / (e1 - e0);
      return rgb([0, 1, 2].map((k) => c0[k]! + (c1[k]! - c0[k]!) * f) as [number, number, number]);
    }
  }
  return rgb(stops[stops.length - 1]![1]);
}

function rgb(c: [number, number, number]): string {
  return `rgb(${c.map((v) => Math.round(v)).join(' ')})`;
}

/** A CSS gradient for a 24-hour slider track: the colour of the sky through the day. */
export function dayGradient(day: Date, lat: number, lon: number, steps = 48): string {
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const hours = (i / steps) * 24;
    const e = sunElevation(swissHourToDate(day, hours), lat, lon);
    parts.push(`${skyColour(e)} ${((i / steps) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}
