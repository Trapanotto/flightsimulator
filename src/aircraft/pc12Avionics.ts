/**
 * What the PC-12's displays show, as plain data and functions (tested in Node): the
 * limitations of the PT6A-67P and the airframe as the engine page and the speed tape mark
 * them, number formats, the crew alerting messages, and the scales of the primary flight
 * display. The painters in pc12Displays.ts only draw what these return.
 *
 * Sources: Pilatus PC-12/47E (NG) Pilot's Operating Handbook, section 2 (limitations).
 */
import type { AvionicsTelemetry, SystemsTelemetry, Waypoint } from '@sim';

// ---- limitations -------------------------------------------------------------------------------

/** A gauge's coloured ranges (low .. high) and its red lines. */
export interface GaugeLimits {
  min: number;
  max: number;
  green?: readonly [number, number];
  amber?: readonly (readonly [number, number])[];
  red?: readonly (readonly [number, number])[];
  redLine?: readonly number[];
}

/** Maximum torque of the PT6A-67P in the PC-12 NG, psi (take-off and maximum continuous). */
export const TORQUE_MAX_PSI = 44.34;

export const PC12_LIMITS = {
  /** Torque, psi: green to the limit, red line at it. */
  torque: { min: 0, max: 50, green: [0, 44.3], redLine: [44.3] } as GaugeLimits,
  /** ITT, deg C: maximum continuous 820, take-off (5 min) 850; amber between. */
  itt: { min: 0, max: 1000, green: [400, 820], amber: [[820, 850]], redLine: [850] } as GaugeLimits,
  /** Gas generator speed, %: ground idle 64 %, maximum 104 %. */
  ng: { min: 0, max: 110, green: [64, 104], redLine: [104] } as GaugeLimits,
  /** Propeller speed, rpm: governed 1550..1700, maximum 1700. */
  np: { min: 0, max: 1900, green: [1550, 1700], redLine: [1700] } as GaugeLimits,
  /** Oil pressure, psi: normal 90..135, minimum 60 at idle. */
  oilP: {
    min: 0,
    max: 200,
    green: [90, 135],
    amber: [[60, 90]],
    red: [
      [0, 60],
      [135, 200],
    ],
    redLine: [60, 135],
  } as GaugeLimits,
  /** Oil temperature, deg C: normal 10..105, maximum 110. */
  oilT: {
    min: -40,
    max: 130,
    green: [10, 105],
    amber: [
      [0, 10],
      [105, 110],
    ],
    red: [[110, 130]],
    redLine: [110],
  } as GaugeLimits,
} as const;

/** Airspeed limitations, KIAS. */
export const PC12_SPEEDS = {
  /** Maximum operating speed, and its Mach number. */
  vmo: 236,
  mmo: 0.48,
  /** Flap extension speeds by setting (degrees -> KIAS). */
  vfe: { 15: 163, 30: 130, 40: 117 } as Record<number, number>,
  /** Gear operating and extended. */
  vlo: 180,
  vle: 240,
  /** Stall speeds at maximum weight, power idle, by flap setting. */
  vs: { 0: 91, 15: 78, 30: 71, 40: 67 } as Record<number, number>,
  /** Bugs shown on the tape: rotation, best climb, approach. */
  vr: 85,
  vy: 124,
  vref: 85,
} as const;

export const FLAP_SETTINGS = [0, 15, 30, 40] as const;

/** The flap setting (degrees) a 0..1 flap position is at or past. */
export function flapDegrees(flaps: number): number {
  const deg = Math.min(Math.max(flaps, 0), 1) * 40;
  let best = 0;
  for (const s of FLAP_SETTINGS) if (deg >= s - 1) best = s;
  return best;
}

/** Stall speed (KIAS) for a flap position, interpolated between the settings. */
export function stallSpeed(flaps: number): number {
  const deg = Math.min(Math.max(flaps, 0), 1) * 40;
  const keys = FLAP_SETTINGS;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (deg <= b) {
      const t = (deg - a) / (b - a);
      return PC12_SPEEDS.vs[a]! + t * (PC12_SPEEDS.vs[b]! - PC12_SPEEDS.vs[a]!);
    }
  }
  return PC12_SPEEDS.vs[40]!;
}

/**
 * The highest speed allowed now (the barber pole's low end): VMO, or MMO converted to
 * indicated airspeed at this Mach-to-IAS ratio, or the flap and gear limits.
 */
export function maxSpeed(iasKt: number, mach: number, flaps: number, gear: number): number {
  let v: number = PC12_SPEEDS.vmo;
  if (mach > 0.2 && iasKt > 40) v = Math.min(v, (iasKt * PC12_SPEEDS.mmo) / mach);
  const deg = flapDegrees(flaps);
  if (deg > 0) v = Math.min(v, PC12_SPEEDS.vfe[deg]!);
  if (gear > 0.01 && gear < 0.99) v = Math.min(v, PC12_SPEEDS.vlo);
  return v;
}

/** Which colour band a gauge value falls in. */
export function gaugeZone(v: number, l: GaugeLimits): 'red' | 'amber' | 'green' | 'white' {
  // Past the top red line is an exceedance whatever the bands say.
  if (l.redLine?.length && v > Math.max(...l.redLine)) return 'red';
  if (l.red?.some(([a, b]) => v >= a && v <= b)) return 'red';
  if (l.amber?.some(([a, b]) => v > a && v <= b)) return 'amber';
  if (l.green && v >= l.green[0] && v <= l.green[1]) return 'green';
  return 'white';
}

// ---- formatting -------------------------------------------------------------------------------

/** Torque as the engine page shows it: one decimal. */
export function formatTorque(psi: number): string {
  return Math.max(0, psi).toFixed(1);
}

/** ITT and propeller rpm: whole numbers; Ng: one decimal. */
export function formatWhole(v: number): string {
  return String(Math.round(Math.max(0, v)));
}

export function formatNg(pct: number): string {
  return Math.max(0, pct).toFixed(1);
}

/** Fuel flow, lb/h, from kg/s: whole tens, as the Apex shows it. */
export function fuelFlowLbh(kgPerS: number): number {
  return Math.round((Math.max(0, kgPerS) * 3600 * 2.20462) / 10) * 10;
}

export const KG_TO_LB = 2.20462;

/** Altimeter setting: 'STD', or hPa as four digits. */
export function formatBaro(hpa: number, std: boolean): string {
  return std ? 'STD' : `${Math.round(hpa)} HPA`;
}

/** The selected altitude: hundreds of feet, no separator ('12000'). */
export function formatSelectedAltitude(ft: number): string {
  return String(Math.round(ft / 100) * 100);
}

/** The altitude readout's rolling digits: the hundreds and the twenty-foot drum. */
export function altitudeDigits(ft: number): { thousands: string; hundreds: string; tens: number } {
  const v = Math.round(ft);
  const neg = v < 0;
  const a = Math.abs(v);
  const thousands = Math.floor(a / 1000);
  const hundreds = Math.floor((a % 1000) / 100);
  return {
    thousands: `${neg ? '-' : ''}${thousands > 0 ? thousands : ''}`,
    hundreds: String(hundreds),
    tens: a % 100,
  };
}

/** Vertical speed next to the scale: rounded to 50 ft/min, blank below 100. */
export function formatVs(fpm: number): string {
  if (Math.abs(fpm) < 100) return '';
  return String(Math.round(Math.abs(fpm) / 50) * 50);
}

/** Radar altitude near the ground: to 10 ft above 200 ft, 5 ft below; blank above 2500 ft. */
export function formatRadarAltitude(ft: number | undefined): string {
  if (ft === undefined || ft > 2500 || ft < -20) return '';
  const step = ft < 200 ? 5 : 10;
  return String(Math.max(0, Math.round(ft / step) * step));
}

// ---- the flight director and autopilot -----------------------------------------------------------

export interface ModeAnnunciation {
  ap: boolean;
  yd: boolean;
  lateral: string;
  lateralArmed: string;
  vertical: string;
  verticalArmed: string;
  /** The autopilot has just disconnected: AP flashes amber. */
  apWarning: boolean;
}

/** The PFD's flight mode annunciations (Apex names) from the autopilot. */
export function modeAnnunciation(
  av: AvionicsTelemetry | undefined,
  source: 'nav1' | 'gps' | 'nav2',
): ModeAnnunciation {
  const ap = av?.autopilot;
  const fd = !!ap?.flightDirector || !!ap?.engaged;
  const nav = source === 'gps' ? 'LNAV' : 'VOR';
  const lat = (m: string | undefined) =>
    m === 'roll'
      ? 'ROL'
      : m === 'hdg'
        ? 'HDG'
        : m === 'nav'
          ? av?.nav1.localizer && source !== 'gps'
            ? 'LOC'
            : nav
          : m === 'apr'
            ? source === 'gps'
              ? 'LNAV'
              : 'LOC'
            : '';
  const ver = (m: string | undefined) =>
    m === 'pitch'
      ? 'PIT'
      : m === 'vs'
        ? 'VS'
        : m === 'alt'
          ? 'ALT'
          : m === 'gs'
            ? source === 'gps'
              ? 'VGP'
              : 'GS'
            : m === 'flc'
              ? 'FLC'
              : '';
  return {
    ap: !!ap?.engaged,
    yd: !!ap?.yawDamper,
    lateral: fd && ap ? lat(ap.lateral) : '',
    lateralArmed: fd && ap?.lateralArmed ? lat(ap.lateralArmed) : '',
    vertical: fd && ap ? ver(ap.vertical) : '',
    verticalArmed:
      fd && ap?.verticalArmed ? (ap.verticalArmed === 'alt' ? 'ALTS' : ver(ap.verticalArmed)) : '',
    apWarning: !!ap?.disconnectWarning,
  };
}

// ---- crew alerting -------------------------------------------------------------------------------

export type CasLevel = 'warning' | 'caution' | 'advisory';
export interface CasMessage {
  text: string;
  level: CasLevel;
}

/** What the crew alerting system reads (the systems where they exist, else the switches). */
export interface CasInputs {
  systems: SystemsTelemetry | undefined;
  /** Cockpit switch positions (0 when the aircraft lacks one). */
  switch: (id: string) => number;
  onGround: boolean;
  engineRunning: boolean;
  /** Gear position 0 up .. 1 down, flaps 0..1, IAS knots, height above ground feet. */
  gear: number;
  flaps: number;
  ias: number;
  agl: number | undefined;
  /** Cabin altitude, feet. */
  cabinAltitude: number;
  torquePsi: number;
  itt: number;
  oilPressure: number;
}

/**
 * The crew alerting messages, warnings first: red for what needs action now, amber for
 * cautions, white advisories for systems switched on.
 */
export function crewAlerts(c: CasInputs): CasMessage[] {
  const out: CasMessage[] = [];
  const s = c.systems;
  const on = (id: string) => c.switch(id) >= 0.5;
  const w = (text: string) => out.push({ text, level: 'warning' });
  const a = (text: string) => out.push({ text, level: 'caution' });
  const adv = (text: string) => out.push({ text, level: 'advisory' });
  if (c.engineRunning && c.oilPressure < 60) w('OIL PRESS');
  if (c.cabinAltitude > 10000) w('CAB PRESS');
  if (c.torquePsi > 44.4) w('ENG TORQUE');
  if (c.itt > 850) w('ITT');
  if (
    !c.onGround &&
    c.gear < 0.99 &&
    (c.flaps > 0.6 || (c.agl !== undefined && c.agl < 500 && c.ias < 120))
  )
    w('GEAR UNSAFE');
  if (s?.annunciators.lowVolts) w('BUS VOLTS');
  if (s?.annunciators.lowFuelLeft) a('L FUEL LOW');
  if (s?.annunciators.lowFuelRight) a('R FUEL LOW');
  if (c.engineRunning && !on('generator1')) a('GEN 1 OFF');
  if (c.engineRunning && !on('generator2')) a('GEN 2 OFF');
  if (!on('battery')) a('BAT 1 OFF');
  if (!on('battery2')) a('BAT 2 OFF');
  if (c.engineRunning && !on('ecs')) a('ECS OFF');
  if (!c.onGround && !on('pitotHeat')) a('PROBES OFF');
  if (on('parkingBrake') && !c.onGround) a('PARK BRAKE');
  if (c.switch('fuelShutoff') < 0.5) a('FUEL SHUTOFF');
  if (c.switch('eps') < 0.5 && c.engineRunning) a('EPS OFF');
  if (c.gear > 0.01 && c.gear < 0.99) a('GEAR');
  if (c.switch('ignition') >= 0.5) adv('IGNITION ON');
  if (c.switch('fuelPumpLeft') >= 0.5) adv('L FUEL PUMP');
  if (c.switch('fuelPumpRight') >= 0.5) adv('R FUEL PUMP');
  if (on('inertialSeparator')) adv('INERT SEP');
  if (on('propDeice')) adv('PROP DE-ICE');
  if (c.switch('bootsDeice') >= 0.5) adv('DE-ICE BOOTS');
  if (on('windshieldHeat')) adv('WSHLD HEAT');
  if (c.switch('pressurisation') >= 0.5) adv('CAB DUMP');
  if (on('oxygen')) adv('OXYGEN ON');
  return out;
}

// ---- scales ----------------------------------------------------------------------------------------

/** Pixels per degree of pitch on the attitude display at a given display height. */
export function pitchScale(height: number): number {
  return height * 0.0105;
}

/** Map ranges (NM, full scale across the map), the knob's 5..320 snapped to the Apex steps. */
export const MAP_RANGES = [5, 10, 20, 40, 80, 160, 320] as const;
export function mapRangeNm(knob: number): number {
  return MAP_RANGES.find((r) => r >= knob - 0.5) ?? 320;
}

/** Track-up below 100 NM, north-up above (the whole flight plan in view). */
export function mapNorthUp(rangeNm: number): boolean {
  return rangeNm >= 100;
}

/** A station received by a NAV with a DME: where it is, NM east and north of the aircraft. */
export function stationOffset(
  bearingMag: number,
  distanceNm: number,
): { east: number; north: number } {
  const b = (bearingMag * Math.PI) / 180;
  return { east: distanceNm * Math.sin(b), north: distanceNm * Math.cos(b) };
}

/** The leg a waypoint closes, for drawing the plan (the active leg is magenta). */
export function legColor(index: number, active: number): 'magenta' | 'white' | 'grey' {
  if (index === active) return 'magenta';
  return index < active ? 'grey' : 'white';
}

/** Plan points as offsets in NM from the aircraft. */
export function planOffsets(plan: readonly Waypoint[], lon: number, lat: number) {
  const k = Math.cos((lat * Math.PI) / 180);
  return plan.map((w) => ({
    ident: w.ident,
    east: (w.lon - lon) * 60 * k,
    north: (w.lat - lat) * 60,
  }));
}
