/**
 * What air traffic control needs to know about the world: the stations and their
 * frequencies, runways with their circuits, reporting points, control zones. The navigation
 * data of the geo package will implement `AtcWorld` later; until then `BUILTIN_ATC_WORLD`
 * holds a small table (Bern, Zürich, Langenthal) so the procedures run and can be tested.
 */
import { bearingDeg, distanceM, findAirport, findRunwayEnd, thresholdOf } from '@geo';

/**
 * 'delivery' gives IFR clearances (ground does where there is none), 'departure' takes IFR
 * departures (arrival does where there is none), 'radar' is area control.
 */
export type StationRole =
  | 'atis'
  | 'delivery'
  | 'ground'
  | 'tower'
  | 'departure'
  | 'arrival'
  | 'information'
  | 'aerodrome'
  | 'radar';

export interface AtcStation {
  /** Unique, e.g. 'LSZB.tower' or 'FIS.zurich'. */
  id: string;
  role: StationRole;
  /** Display name, e.g. 'Bern Tower'. */
  name: string;
  /** How the station is called on the radio (no umlauts), e.g. 'Zurich Information'. */
  spoken: string;
  /** kHz on the 25 kHz grid of the COM radios. */
  frequency: number;
  /** ICAO code of the airport for airport stations. */
  airport?: string;
}

/** A VFR reporting point of a control zone. */
export interface ReportingPoint {
  /** As on the chart, e.g. 'E'. */
  name: string;
  /** As said on the radio, e.g. 'Echo'. */
  spoken: string;
  lon: number;
  lat: number;
}

/** A runway end as the controller uses it: for take-off and landing in its direction. */
export interface AtcRunway {
  ident: string;
  /** True course of take-off and landing, degrees. */
  course: number;
  /** Landing threshold. */
  threshold: { lon: number; lat: number };
  /** Where the pavement starts on this side (the take-off run starts here). */
  start: { lon: number; lat: number };
  /** Usable length from `start`, metres. */
  length: number;
  width: number;
  /** Threshold elevation, feet above sea level. */
  elevationFt: number;
  /** An ILS serves this end. */
  ils: boolean;
  /** Side of the traffic circuit. */
  circuit: 'left' | 'right';
}

export interface AtcAirport {
  icao: string;
  /** Place name as used on the radio, e.g. 'Bern', 'Zurich'. */
  name: string;
  lon: number;
  lat: number;
  elevationFt: number;
  /** Has a tower: clearances are needed. Otherwise pilots make blind calls. */
  controlled: boolean;
  stations: AtcStation[];
  /** The runway ends the controller hands out, with the preferred one (calm wind) first. */
  runways: AtcRunway[];
  reportingPoints: ReportingPoint[];
  /** Feet above sea level. */
  circuitAltitudeFt: number;
}

/** The navigation data as air traffic control sees it. */
export interface AtcWorld {
  airport(icao: string): AtcAirport | undefined;
  /** The station heard on a frequency at a place (the nearest one if several share it). */
  stationOn(khz: number, lon: number, lat: number): AtcStation | undefined;
  /** The flight information service responsible for a place. */
  information(lon: number, lat: number): AtcStation | undefined;
  /** ICAO code of the control zone around a point (altitude in feet above sea level). */
  controlZone(lon: number, lat: number, altitudeFt: number): string | undefined;
  /**
   * The area control station for IFR traffic at a place. Optional: without it the controller
   * uses `SWISS_RADAR`.
   */
  area?(lon: number, lat: number, altitudeFt: number): AtcStation | undefined;
}

/**
 * Area control when the world names none. The name is the real one; the frequency is a
 * stand-in on the 25 kHz grid, not a verified sector frequency.
 */
export const SWISS_RADAR: AtcStation = {
  id: 'ACC.swiss',
  role: 'radar',
  name: 'Swiss Radar',
  spoken: 'Swiss Radar',
  frequency: 128_050,
};

const FT = 3.28084;

/**
 * Runway ends of an airport of the geo package's table, in the controller's form. `circuits`
 * gives the circuit side per end (left by default).
 */
export function runwaysFromGeo(
  icao: string,
  idents: readonly string[],
  circuits: Record<string, 'left' | 'right'> = {},
): AtcRunway[] {
  const ap = findAirport(icao);
  if (!ap) return [];
  const out: AtcRunway[] = [];
  for (const ident of idents) {
    const f = findRunwayEnd(ap, ident);
    if (!f) continue;
    const threshold = thresholdOf(f.end, f.opposite);
    out.push({
      ident,
      course: bearingDeg(f.end, f.opposite),
      threshold,
      start: { lon: f.end.lon, lat: f.end.lat },
      length: distanceM(f.end, f.opposite),
      width: f.runway.width,
      elevationFt: (f.end.elevation ?? ap.elevation) * FT,
      ils: f.end.approach === 'ils',
      circuit: circuits[ident] ?? 'left',
    });
  }
  return out;
}

interface Zone {
  icao: string;
  lon: number;
  lat: number;
  radiusNm: number;
  ceilingFt: number;
}

/** An AtcWorld over a fixed list of airports, round control zones and FIS sectors. */
export class TableAtcWorld implements AtcWorld {
  private readonly airports = new Map<string, AtcAirport>();
  private readonly stations: AtcStation[] = [];

  constructor(
    airports: readonly AtcAirport[],
    private readonly zones: readonly Zone[],
    /** FIS stations with the region they serve: the one whose test passes first. */
    private readonly fis: readonly {
      station: AtcStation;
      covers(lon: number, lat: number): boolean;
    }[],
    private readonly areaStation?: AtcStation,
  ) {
    for (const a of airports) {
      this.airports.set(a.icao, a);
      this.stations.push(...a.stations);
    }
    this.stations.push(...fis.map((f) => f.station));
    if (areaStation) this.stations.push(areaStation);
  }

  area() {
    return this.areaStation;
  }

  airport(icao: string) {
    return this.airports.get(icao.toUpperCase());
  }

  stationOn(khz: number, lon: number, lat: number) {
    const near = (s: AtcStation) => {
      const a = s.airport ? this.airports.get(s.airport) : undefined;
      return a ? distanceM({ lon, lat }, a) : 0;
    };
    return this.stations
      .filter((s) => s.frequency === Math.round(khz))
      .sort((a, b) => near(a) - near(b))[0];
  }

  information(lon: number, lat: number) {
    return this.fis.find((f) => f.covers(lon, lat))?.station;
  }

  controlZone(lon: number, lat: number, altitudeFt: number) {
    return this.zones.find(
      (z) => altitudeFt <= z.ceilingFt && distanceM(z, { lon, lat }) <= z.radiusNm * 1852,
    )?.icao;
  }
}

const station = (
  airport: string,
  role: StationRole,
  name: string,
  frequency: number,
  spoken = name,
): AtcStation => ({ id: `${airport}.${role}`, role, name, spoken, frequency, airport });

/**
 * Bern, Zürich and Langenthal with frequencies and reporting points close to the real
 * ones (rounded to the 25 kHz grid of the radios). A stand-in for the navigation data: the
 * tests rely on these exact values, the real data replaces them in the app.
 */
export const BUILTIN_ATC_WORLD: AtcWorld = new TableAtcWorld(
  [
    {
      icao: 'LSZB',
      name: 'Bern',
      lon: 7.498819,
      lat: 46.912736,
      elevationFt: 1674,
      controlled: true,
      stations: [
        station('LSZB', 'atis', 'Bern ATIS', 125_125),
        station('LSZB', 'ground', 'Bern Ground', 121_700),
        station('LSZB', 'tower', 'Bern Tower', 121_025),
        station('LSZB', 'arrival', 'Bern Arrival', 127_325),
      ],
      runways: runwaysFromGeo('LSZB', ['14', '32'], { '14': 'left', '32': 'right' }),
      reportingPoints: [
        { name: 'E', spoken: 'Echo', lon: 7.6, lat: 46.94 },
        { name: 'W', spoken: 'Whiskey', lon: 7.37, lat: 46.9 },
        { name: 'S', spoken: 'Sierra', lon: 7.55, lat: 46.82 },
        { name: 'N', spoken: 'November', lon: 7.45, lat: 47.0 },
      ],
      circuitAltitudeFt: 2700,
    },
    {
      icao: 'LSZH',
      name: 'Zurich',
      lon: 8.548056,
      lat: 47.458056,
      elevationFt: 1417,
      controlled: true,
      stations: [
        station('LSZH', 'atis', 'Zürich ATIS', 128_525, 'Zurich ATIS'),
        station('LSZH', 'ground', 'Zürich Ground', 121_900, 'Zurich Ground'),
        station('LSZH', 'tower', 'Zürich Tower', 118_100, 'Zurich Tower'),
        station('LSZH', 'arrival', 'Zürich Arrival', 118_000, 'Zurich Arrival'),
        station('LSZH', 'delivery', 'Zürich Delivery', 121_925, 'Zurich Delivery'),
        station('LSZH', 'departure', 'Zürich Departure', 125_950, 'Zurich Departure'),
      ],
      runways: runwaysFromGeo('LSZH', ['14', '32', '28', '10', '16', '34']),
      reportingPoints: [
        { name: 'E', spoken: 'Echo', lon: 8.72, lat: 47.42 },
        { name: 'W', spoken: 'Whiskey', lon: 8.36, lat: 47.45 },
        { name: 'S', spoken: 'Sierra', lon: 8.55, lat: 47.35 },
        { name: 'N', spoken: 'November', lon: 8.53, lat: 47.56 },
      ],
      circuitAltitudeFt: 2500,
    },
    {
      icao: 'LSPL',
      name: 'Langenthal',
      lon: 7.741191,
      lat: 47.18281,
      elevationFt: 1575,
      controlled: false,
      stations: [station('LSPL', 'aerodrome', 'Langenthal Traffic', 123_250)],
      runways: runwaysFromGeo('LSPL', ['23', '05']),
      reportingPoints: [],
      circuitAltitudeFt: 2600,
    },
  ],
  [
    { icao: 'LSZB', lon: 7.498819, lat: 46.912736, radiusNm: 5, ceilingFt: 5500 },
    { icao: 'LSZH', lon: 8.548056, lat: 47.458056, radiusNm: 7, ceilingFt: 5500 },
  ],
  [
    {
      // West of Bern the Geneva sector, the rest of the country Zürich.
      station: {
        id: 'FIS.geneva',
        role: 'information',
        name: 'Geneva Information',
        spoken: 'Geneva Information',
        frequency: 126_350,
      },
      covers: (lon) => lon < 7.2,
    },
    {
      station: {
        id: 'FIS.zurich',
        role: 'information',
        name: 'Zürich Information',
        spoken: 'Zurich Information',
        frequency: 124_700,
      },
      covers: () => true,
    },
  ],
  SWISS_RADAR,
);
