/**
 * From the app's types to the controller's: the flight plan of the menu and the telemetry
 * of the aircraft. Kept apart so the controller itself needs neither.
 */
import type { Telemetry } from '@sim';
import type { FlightPlan } from '@ui';
import type { AtcConfig, AtcSituation } from './atc';
import { ATC_AIRCRAFT } from './fleet';
import type { AtcWeather } from './weather';
import type { AtcWorld } from './world';

const FT = 3.28084;
const KT = 1.943844;
const XPDR_MODES = ['off', 'standby', 'on', 'alt'] as const;

/**
 * The situation for `AtcController.update`. `msl` is the height above sea level in metres
 * (the telemetry's altitude is above the ellipsoid); `com1Failed` from the failures.
 */
export function atcSituation(
  t: Telemetry,
  pos: { lon: number; lat: number; msl: number },
  cockpit: Readonly<Record<string, number>>,
  com1Failed = false,
): AtcSituation {
  const av = t.avionics;
  const powered = av ? av.powered : (cockpit.avionics ?? 0) >= 0.5;
  const sit: AtcSituation = {
    time: t.time,
    lon: pos.lon,
    lat: pos.lat,
    altitudeFt: pos.msl * FT,
    headingDeg: t.headingDeg,
    trackDeg: t.trackDeg,
    groundSpeedKt: t.groundSpeed * KT,
    verticalSpeedFpm: t.verticalSpeed * FT * 60,
    onGround: t.onGround,
    // A twin counts as started when one engine runs (the crew asks for taxi with both).
    engineRunning: t.engines.some((e) => e.running),
    com1: av ? av.com1.active : (cockpit.com1Active ?? 0),
    com1Works: powered && !com1Failed,
    squawk: av ? av.transponder.code : (cockpit.xpdrCode ?? 7000),
    transponder: av
      ? av.transponder.mode
      : (XPDR_MODES[Math.round(cockpit.xpdrMode ?? 0)] ?? 'off'),
  };
  if (t.agl !== undefined) sit.heightFt = t.agl * FT;
  return sit;
}

/**
 * The controller's configuration for a flight of the menu: the type's callsign ('HB-TFS',
 * 'HB-FTS', 'Alpine 482', 'Hornet 11') and flight rules (IFR for the airliner) unless
 * `options` says otherwise.
 */
export function atcConfigFromPlan(
  plan: FlightPlan,
  weather: AtcWeather,
  world?: AtcWorld,
  options: { callsign?: string; flightRules?: 'VFR' | 'IFR'; cruiseLevel?: number } = {},
): AtcConfig | undefined {
  const start = plan.start;
  const airport = plan.airport ?? (start.kind === 'air' ? undefined : start.airport);
  if (!airport) return undefined;
  const runway = start.kind === 'runway' ? start.runway : undefined;
  const type = ATC_AIRCRAFT[plan.aircraft] ?? ATC_AIRCRAFT.c172;
  const cfg: AtcConfig = {
    callsign: options.callsign ?? type.callsign,
    aircraft: plan.aircraft,
    flightRules: options.flightRules ?? type.flightRules,
    departure: runway ? { airport, runway } : { airport },
    weather,
  };
  if (options.cruiseLevel !== undefined) cfg.cruiseLevel = options.cruiseLevel;
  if (world) cfg.world = world;
  if (plan.destination) cfg.destination = { ...plan.destination };
  else if (start.kind === 'approach') cfg.destination = { airport, runway: start.runway };
  return cfg;
}
