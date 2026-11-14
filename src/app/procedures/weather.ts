/**
 * The weather as the controller reports it, the runway in use that follows from the wind,
 * and the ATIS broadcast.
 */
import type { Weather } from '@sky';
import { angleDiff } from './geometry';
import {
  type Line,
  celsius,
  digits,
  feetWords,
  line,
  phonetic,
  qnh,
  runway,
  sentences,
  wind,
} from './phraseology';
import type { AtcAirport, AtcRunway } from './world';

export type CloudCover = 'FEW' | 'SCT' | 'BKN' | 'OVC';

export interface AtcWeather {
  /** Surface wind: from where (degrees true) and how strong (knots). */
  windFromDeg: number;
  windKt: number;
  gustKt?: number;
  /** Visibility in metres; below `lowVisibility.belowFt` (feet above sea level) the other. */
  visibilityM: number;
  lowVisibility?: { belowFt: number; visibilityM: number };
  /** Cloud layers, bases in feet above sea level, lowest first. */
  clouds: { cover: CloudCover; baseFt: number }[];
  /** Air temperature reduced to sea level, °C (each aerodrome gets its own by the lapse rate). */
  temperatureC: number;
  precipitation: 'none' | 'rain' | 'snow';
  /** hPa */
  qnh: number;
}

const FT = 3.28084;
const KT = 1.943844;

/** The sky package's weather in the controller's terms. The sky knows no pressure: pass QNH. */
export function atcWeatherFromSky(w: Weather, qnhHpa = 1013): AtcWeather {
  const clouds: AtcWeather['clouds'] = [];
  if (w.stratus) clouds.push({ cover: 'OVC', baseFt: w.stratus.base * FT });
  const c = w.cloudCover;
  if (c >= 0.05) {
    const cover: CloudCover = c < 0.25 ? 'FEW' : c < 0.5 ? 'SCT' : c < 0.875 ? 'BKN' : 'OVC';
    clouds.push({ cover, baseFt: w.cloudBase * FT });
  }
  clouds.sort((a, b) => a.baseFt - b.baseFt);
  const out: AtcWeather = {
    windFromDeg: w.windFromDeg,
    windKt: w.windSpeed * KT,
    visibilityM: w.visibility,
    clouds,
    temperatureC: w.temperature,
    precipitation: w.precipitation < 0.05 ? 'none' : w.temperature < 2 ? 'snow' : 'rain',
    qnh: qnhHpa,
  };
  if (w.stratus)
    out.lowVisibility = { belowFt: w.stratus.base * FT, visibilityM: w.stratus.visibilityBelow };
  return out;
}

/** Head- and crosswind components on a runway, knots (negative headwind = tailwind). */
export function windComponents(w: AtcWeather, rwy: AtcRunway) {
  const a = (angleDiff(w.windFromDeg, rwy.course) * Math.PI) / 180;
  return { head: w.windKt * Math.cos(a), cross: Math.abs(w.windKt * Math.sin(a)) };
}

/**
 * The runway in use. A preferred runway (the flight plan's, then the airport's first) stays
 * in use up to 5 knots of tailwind and 15 knots of crosswind, as noise abatement keeps it in
 * practice; otherwise the one most into wind.
 */
export function runwayInUse(ap: AtcAirport, w: AtcWeather, preferred?: string): AtcRunway {
  const rws = ap.runways;
  const prefs = [preferred, rws[0]?.ident].filter((p): p is string => !!p);
  for (const p of prefs) {
    const r = rws.find((x) => x.ident === p);
    if (!r) continue;
    const c = windComponents(w, r);
    if (c.head >= -5 && c.cross <= 15) return r;
  }
  let best = rws[0]!;
  for (const r of rws) if (windComponents(w, r).head > windComponents(w, best).head) best = r;
  return best;
}

/** The wind as the tower gives it: magnetic, rounded to ten degrees. */
export function towerWind(w: AtcWeather, declinationDeg: number): Line {
  return wind(w.windFromDeg - declinationDeg, w.windKt, w.gustKt);
}

/** The aerodrome's temperature and an estimated dew point from the cloud base. */
function temperatures(w: AtcWeather, elevationFt: number) {
  const t = w.temperatureC - (6.5 * elevationFt) / FT / 1000;
  const base = w.clouds[0]?.baseFt;
  // Cumulus forms where the rising air reaches its dew point: about 400 ft per degree of spread.
  let spread = base !== undefined ? (base - elevationFt) / 400 : 10;
  if (w.precipitation !== 'none') spread = Math.min(spread, 2);
  spread = Math.min(Math.max(spread, 0), 15);
  return { t: Math.round(t), d: Math.round(t - spread) };
}

function visibility(w: AtcWeather, elevationFt: number): number {
  return w.lowVisibility && elevationFt < w.lowVisibility.belowFt
    ? w.lowVisibility.visibilityM
    : w.visibilityM;
}

function visibilityLine(m: number): Line {
  if (m >= 10_000)
    return line('visibility 10 km or more', 'visibility one zero kilometres or more');
  if (m >= 5000) {
    const km = Math.floor(m / 1000);
    return line(`visibility ${km} km`, `visibility ${digits(km)} kilometres`);
  }
  const r = Math.max(100, Math.floor(m / 100) * 100);
  return line(`visibility ${r} m`, `visibility ${feetWords(r)} metres`);
}

const COVER_WORD: Record<CloudCover, string> = {
  FEW: 'few',
  SCT: 'scattered',
  BKN: 'broken',
  OVC: 'overcast',
};

/** Ceiling and visibility OK: 10 km, no cloud below 5000 ft above the aerodrome, no weather. */
export function isCavok(w: AtcWeather, elevationFt: number): boolean {
  return (
    visibility(w, elevationFt) >= 10_000 &&
    w.precipitation === 'none' &&
    w.clouds.every((c) => c.baseFt - elevationFt >= 5000)
  );
}

/** The weather part of an ATIS (and of a controller's weather report). */
export function weatherLines(w: AtcWeather, ap: AtcAirport, declinationDeg: number): Line[] {
  const out: Line[] = [towerWind(w, declinationDeg)];
  if (isCavok(w, ap.elevationFt)) out.push(line('CAVOK', 'cav okay'));
  else {
    out.push(visibilityLine(visibility(w, ap.elevationFt)));
    if (w.precipitation !== 'none') out.push(line(`light ${w.precipitation}`));
    const layers = w.clouds.filter((c) => c.baseFt > ap.elevationFt);
    if (layers.length === 0) out.push(line('no significant clouds'));
    for (const c of layers.slice(0, 3)) {
      const h = Math.max(100, Math.round((c.baseFt - ap.elevationFt) / 100) * 100);
      out.push(
        line(`${COVER_WORD[c.cover]} ${h} ft`, `${COVER_WORD[c.cover]} ${feetWords(h)} feet`),
      );
    }
  }
  const { t, d } = temperatures(w, ap.elevationFt);
  const tl = celsius(t);
  const dl = celsius(d);
  out.push(
    line(
      `temperature ${tl.text}, dew point ${dl.text}`,
      `temperature ${tl.spoken}, dew point ${dl.spoken}`,
    ),
  );
  out.push(qnh(w.qnh));
  return out;
}

/** The letters of the ATIS: A..Z. */
export const atisLetter = (index: number) => String.fromCharCode(65 + (((index % 26) + 26) % 26));

/**
 * The ATIS broadcast: 'Bern information Alfa. Runway in use 14. Wind ...'. ICAO Annex 11
 * order: identification, runway, wind, visibility, weather, clouds, temperatures, QNH.
 */
export function atisMessage(
  ap: AtcAirport,
  w: AtcWeather,
  letterIndex: number,
  runwayIdent: string,
  declinationDeg: number,
): Line {
  const letter = phonetic(atisLetter(letterIndex));
  const rw = runway(runwayIdent);
  return sentences(
    line(`${ap.name} information ${letter}`),
    line(
      `${rw.text.replace('runway', 'runway in use')}`,
      rw.spoken.replace('runway', 'runway in use'),
    ),
    ...weatherLines(w, ap, declinationDeg),
    line(`advise on initial contact you have information ${letter}`),
  );
}
