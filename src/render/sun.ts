/**
 * Solar position (NOAA algorithm, accurate to ~0.1° for current years).
 * Returns azimuth (degrees from north, clockwise) and elevation above the horizon.
 */
export function solarPosition(
  date: Date,
  latDeg: number,
  lonDeg: number,
): { azimuth: number; elevation: number } {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86_400_000 + 2_440_587.5;
  const t = (jd - 2_451_545) / 36_525;

  const l0 = (280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * rad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * rad) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * rad) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));

  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqTime =
    (4 / rad) *
    (y * Math.sin(2 * l0 * rad) -
      2 * e * Math.sin(m * rad) +
      4 * e * y * Math.sin(m * rad) * Math.cos(2 * l0 * rad) -
      0.5 * y * y * Math.sin(4 * l0 * rad) -
      1.25 * e * e * Math.sin(2 * m * rad));

  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarTime = (((minutes + eqTime + 4 * lonDeg) % 1440) + 1440) % 1440;
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const lat = latDeg * rad;
  const cosZen =
    Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle * rad);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  const azDen = Math.cos(lat) * Math.sin(zenith);
  let azimuth: number;
  if (Math.abs(azDen) > 1e-6) {
    const azRad = (Math.sin(lat) * Math.cos(zenith) - Math.sin(decl)) / azDen;
    azimuth = 180 - Math.acos(Math.max(-1, Math.min(1, azRad))) / rad;
    if (hourAngle > 0) azimuth = -azimuth;
    azimuth = ((azimuth % 360) + 360) % 360;
  } else {
    azimuth = lat > 0 ? 180 : 0;
  }
  return { azimuth, elevation: 90 - zenith / rad };
}

/** Local time in Switzerland (CET/CEST) on the calendar day of `ref`, as a Date. */
export function swissTime(ref: Date, hours: number, minutes: number): Date {
  const y = ref.getUTCFullYear();
  const mo = ref.getUTCMonth();
  const d = ref.getUTCDate();
  // CEST from the last Sunday of March to the last Sunday of October (01:00 UTC).
  const lastSunday = (month: number) => {
    const last = new Date(Date.UTC(y, month + 1, 0));
    return Date.UTC(y, month, last.getUTCDate() - last.getUTCDay(), 1);
  };
  const probe = Date.UTC(y, mo, d, hours - 1, minutes);
  const offset = probe >= lastSunday(2) && probe < lastSunday(9) ? 2 : 1;
  return new Date(Date.UTC(y, mo, d, hours - offset, minutes));
}

/**
 * Finds the time on this day when the sun stands `targetDeg` high, searching between two local
 * times (minutes after midnight). Used for "morning" and "golden hour" in any season.
 */
function timeAtElevation(
  now: Date,
  fromMin: number,
  toMin: number,
  targetDeg: number,
  lat: number,
  lon: number,
): Date {
  let best = swissTime(now, Math.floor(fromMin / 60), fromMin % 60);
  let bestErr = Infinity;
  for (let minutes = fromMin; minutes <= toMin; minutes += 5) {
    const d = swissTime(now, Math.floor(minutes / 60), minutes % 60);
    const err = Math.abs(solarPosition(d, lat, lon).elevation - targetDeg);
    if (err < bestErr) {
      bestErr = err;
      best = d;
    }
  }
  return best;
}

/** This day's evening time with the sun ~8° high (golden hour), Swiss local time. */
export function goldenHour(now: Date, latDeg = 46.8, lonDeg = 8.2): Date {
  return timeAtElevation(now, 14 * 60, 21 * 60 + 30, 8, latDeg, lonDeg);
}

/** Morning light: sun ~12° high in the east. */
export function morning(now: Date, latDeg = 46.8, lonDeg = 8.2): Date {
  return timeAtElevation(now, 5 * 60, 11 * 60, 12, latDeg, lonDeg);
}

/** Highest sun of the day (~13:30 in summer, ~12:30 in winter). */
export function noon(now: Date, latDeg = 46.8, lonDeg = 8.2): Date {
  return timeAtElevation(now, 11 * 60, 14 * 60, 90, latDeg, lonDeg);
}

/**
 * Picks the time to show: "HH:MM" (Swiss local time, today), "morning" / "noon" / "golden"
 * (by sun elevation, so they work in every season) or null for the real time. At night the real time is replaced by the golden hour,
 * because night rendering (lights, stars) only comes in a later phase.
 */
export function resolveTime(
  spec: string | null,
  now = new Date(),
  latDeg = 46.8,
  lonDeg = 8.2,
): Date {
  if (spec === 'golden') return goldenHour(now, latDeg, lonDeg);
  if (spec === 'morning') return morning(now, latDeg, lonDeg);
  if (spec === 'noon') return noon(now, latDeg, lonDeg);
  if (spec && /^\d{1,2}:\d{2}$/.test(spec)) {
    const [h, m] = spec.split(':').map(Number) as [number, number];
    return swissTime(now, h, m);
  }
  if (solarPosition(now, latDeg, lonDeg).elevation > 4) return now;
  return goldenHour(now, latDeg, lonDeg);
}
