import {
  type AirportFrequency,
  airspacesAt,
  distanceM,
  findAirport,
  fisAt,
  fixesOf,
  frequenciesOf,
  AIRPORT_FREQUENCIES,
  FIS_STATIONS,
} from '@geo';
import {
  type AtcAirport,
  type AtcStation,
  type AtcWorld,
  type StationRole,
  runwaysFromGeo,
} from './procedures';

const FT = 3.28084;

/**
 * The frequency a COM radio with 25 kHz steps shows for a published channel. Channels of the
 * 8.33 kHz grid are named ...05, ...30, ...55, ...80 where they coincide with a 25 kHz
 * frequency (125.130 is 125.125 MHz); the others have no 25 kHz equivalent and get the
 * nearest one, so that the simulated radio can reach every station.
 */
export const comFrequency = (khz: number) => Math.round(khz / 25) * 25;

/** A name as said on the radio: no umlauts or accents. */
const spokenName = (name: string) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ue/g, 'u');

const ROLE: Partial<Record<AirportFrequency['type'], StationRole>> = {
  atis: 'atis',
  ground: 'ground',
  apron: 'ground',
  delivery: 'ground',
  tower: 'tower',
  approach: 'arrival',
  arrival: 'arrival',
  info: 'aerodrome',
};

/** Which of several frequencies with the same role the controller uses: lower is better. */
function rank(f: AirportFrequency): number {
  if (f.type === 'ground') return 0;
  if (f.type === 'apron') return 1;
  if (f.type === 'delivery') return 2;
  if (f.type === 'approach' || f.type === 'arrival') return /final/i.test(f.name) ? 1 : 0;
  return 0;
}

function stationsOf(icao: string): AtcStation[] {
  const byRole = new Map<StationRole, AirportFrequency>();
  for (const f of frequenciesOf(icao)) {
    const role = ROLE[f.type];
    if (!role) continue;
    const have = byRole.get(role);
    // Of two towers the later entry is the main frequency in the source's order.
    if (!have || rank(f) < rank(have) || (role === 'tower' && rank(f) === rank(have)))
      byRole.set(role, f);
  }
  // A tower makes the place controlled: an information frequency next to it is not used.
  if (byRole.has('tower')) byRole.delete('aerodrome');
  return [...byRole].map(([role, f]) => ({
    id: `${icao}.${role}`,
    role,
    name: f.name,
    spoken: spokenName(f.name),
    frequency: comFrequency(f.frequency),
    airport: icao,
  }));
}

/** Air traffic control's view of the navigation data of the geo package. */
class GeoAtcWorld implements AtcWorld {
  private readonly airports = new Map<string, AtcAirport | undefined>();
  private all?: AtcStation[];

  airport(icao: string): AtcAirport | undefined {
    const key = icao.toUpperCase();
    if (this.airports.has(key)) return this.airports.get(key);
    const a = findAirport(key);
    let out: AtcAirport | undefined;
    if (a) {
      const stations = stationsOf(key);
      const tower = stations.find((s) => s.role === 'tower');
      const called = tower ?? stations.find((s) => s.role === 'aerodrome');
      out = {
        icao: key,
        // 'Bern Tower' is called 'Bern': the station's name without its last word.
        name: called ? called.spoken.replace(/\s+\S+$/, '') : spokenName(a.name),
        lon: a.lon,
        lat: a.lat,
        elevationFt: a.elevation * FT,
        controlled: !!tower,
        stations,
        runways: runwaysFromGeo(
          key,
          a.runways.flatMap((r) => r.ends.map((e) => e.ident)),
        ),
        reportingPoints: fixesOf(key)
          .filter((f) => f.kind === 'vfr')
          .map((f) => ({ name: f.ident, spoken: spokenName(f.name), lon: f.lon, lat: f.lat })),
        // The usual circuit: 1000 ft above the field, on a round hundred.
        circuitAltitudeFt: Math.round((a.elevation * FT + 1000) / 100) * 100,
      };
    }
    this.airports.set(key, out);
    return out;
  }

  private fis(name: string, frequency: number): AtcStation {
    return {
      id: `FIS.${name}`,
      role: 'information',
      name,
      spoken: spokenName(name),
      frequency: comFrequency(frequency),
    };
  }

  stationOn(khz: number, lon: number, lat: number): AtcStation | undefined {
    if (!this.all) {
      const icaos = new Set(AIRPORT_FREQUENCIES.map((f) => f.airport));
      this.all = [...icaos].flatMap((i) => this.airport(i)?.stations ?? []);
      for (const f of FIS_STATIONS) this.all.push(this.fis(f.name, f.frequency));
    }
    const f = Math.round(khz);
    let best: AtcStation | undefined;
    let bestD = Infinity;
    for (const s of this.all) {
      if (s.frequency !== f) continue;
      const a = s.airport ? findAirport(s.airport) : undefined;
      const d = a ? distanceM({ lon, lat }, a) : 0;
      // An airport's stations carry about 100 km at light-aircraft heights.
      if (d < bestD && d < 110_000) {
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  information(lon: number, lat: number): AtcStation | undefined {
    const f = fisAt(lon, lat);
    return this.fis(f.name, f.frequency);
  }

  controlZone(lon: number, lat: number, altitudeFt: number): string | undefined {
    return airspacesAt(lon, lat, altitudeFt / FT).find((a) => a.type === 'CTR')?.airport;
  }
}

/** The one instance: the data never changes. */
export const ATC_WORLD: AtcWorld = new GeoAtcWorld();
