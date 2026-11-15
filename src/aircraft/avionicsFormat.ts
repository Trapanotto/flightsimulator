/**
 * How avionics show numbers: frequencies, squawks, DME readouts, bearings, the autopilot's
 * modes, and a stand-in for the avionics before they are connected. Plain functions, tested
 * in Node; every type's displays use them.
 */
import type { AvionicsTelemetry, Cockpit } from '@sim';

/** A frequency in kHz as a radio shows it: '118.10', '110.50' (25 kHz steps lose their last digit). */
export function formatFrequency(kHz: number): string {
  const mhz = Math.floor(kHz / 1000);
  const hundredths = Math.floor((Math.round(kHz) % 1000) / 10);
  return `${mhz}.${String(hundredths).padStart(2, '0')}`;
}

/** Transponder code, always four digits: '7000', '0021'. */
export function formatSquawk(code: number): string {
  return String(Math.max(0, Math.min(7777, Math.round(code)))).padStart(4, '0');
}

/** DME distance: one decimal below 100 NM, whole miles above, dashes without a signal. */
export function formatDmeDistance(nm: number | undefined): string {
  if (nm === undefined || !Number.isFinite(nm)) return '--.-';
  if (nm < 99.95) return nm.toFixed(1);
  return String(Math.min(Math.round(nm), 389));
}

export function formatDmeSpeed(kt: number | undefined): string {
  if (kt === undefined || !Number.isFinite(kt)) return '---';
  return String(Math.min(Math.max(Math.round(kt), 0), 999)).padStart(3, ' ');
}

export function formatDmeMinutes(min: number | undefined): string {
  if (min === undefined || !Number.isFinite(min)) return '--';
  return String(Math.min(Math.max(Math.round(min), 0), 99));
}

/** Degrees as a navigator writes them: '005°'. */
export function formatBearing(deg: number | undefined): string {
  if (deg === undefined || !Number.isFinite(deg)) return '---°';
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return `${String(d === 0 ? 360 : d).padStart(3, '0')}°`;
}

/** Selected vertical speed with its sign: '+500', '-1200', '0'. */
export function formatVerticalSpeed(fpm: number): string {
  const v = Math.round(fpm / 100) * 100;
  return v > 0 ? `+${v}` : String(v);
}

/** The autopilot's mode annunciations (KAP 140 style). */
export function autopilotModes(ap: AvionicsTelemetry['autopilot']): {
  lateral: string;
  lateralArmed: string;
  vertical: string;
  verticalArmed: string;
} {
  if (!ap.engaged) return { lateral: '', lateralArmed: '', vertical: '', verticalArmed: '' };
  const lat = { roll: 'ROL', hdg: 'HDG', nav: 'NAV', apr: 'APR' } as const;
  const ver = { pitch: '', vs: 'VS', alt: 'ALT', gs: 'GS', flc: 'FLC' } as const;
  return {
    lateral: lat[ap.lateral],
    lateralArmed: ap.lateralArmed ? `${lat[ap.lateralArmed]} ARM` : '',
    vertical: ver[ap.vertical],
    verticalArmed: ap.verticalArmed ? `${ver[ap.verticalArmed]} ARM` : '',
  };
}

/**
 * Without the avionics (not connected yet) the stack still shows what the knobs set, powered
 * by the master and avionics switches; nothing is received.
 */
export function avionicsFromCockpit(c: Cockpit | undefined): AvionicsTelemetry | undefined {
  if (!c) return undefined;
  const nav = (n: 1 | 2) => ({
    frequency: c.get(`nav${n}Active`),
    standby: c.get(`nav${n}Standby`),
    valid: false,
    ident: '',
    localizer: false,
    course: c.get(`obs${n}`),
    deviation: 0,
    toFrom: 'off' as const,
    bearing: undefined,
    glideSlope: undefined,
  });
  const modes = ['off', 'standby', 'on', 'alt'] as const;
  return {
    powered: c.get('battery') >= 0.5 && c.get('avionics') >= 0.5,
    com1: { active: c.get('com1Active'), standby: c.get('com1Standby') },
    com2: { active: c.get('com2Active'), standby: c.get('com2Standby') },
    nav1: nav(1),
    nav2: nav(2),
    dme: {
      source: c.get('dmeSource') >= 0.5 ? 'nav2' : 'nav1',
      distanceNm: undefined,
      groundSpeedKt: undefined,
      minutes: undefined,
    },
    adf: { frequency: c.get('adfFrequency'), valid: false, ident: '', relativeBearing: undefined },
    transponder: {
      code: c.get('xpdrCode'),
      mode: modes[Math.round(c.get('xpdrMode'))] ?? 'off',
      ident: false,
      reply: false,
    },
    markers: { outer: false, middle: false, inner: false },
    autopilot: {
      engaged: false,
      lateral: 'roll',
      lateralArmed: undefined,
      vertical: 'pitch',
      verticalArmed: undefined,
      selectedAltitude: c.get('apAltitude'),
      selectedVerticalSpeed: 0,
      disconnectWarning: false,
    },
    gps: {
      plan: [],
      active: -1,
      distanceNm: undefined,
      bearing: undefined,
      desiredTrack: undefined,
      crossTrackNm: undefined,
      groundSpeedKt: 0,
      track: 0,
      lon: 0,
      lat: 0,
    },
  };
}

/** The GPS map's range (NM across its width) that shows the next waypoint. */
export function mapRange(distanceNm: number | undefined): number {
  const ranges = [2, 5, 10, 20, 50, 100];
  const d = distanceNm ?? 10;
  return ranges.find((r) => r >= d * 1.6) ?? 100;
}

/** Position of a point on a north-up map around the aircraft, NM east and north. */
export function mapOffsetNm(
  lon0: number,
  lat0: number,
  lon: number,
  lat: number,
): { east: number; north: number } {
  return {
    east: (lon - lon0) * 60 * Math.cos((lat0 * Math.PI) / 180),
    north: (lat - lat0) * 60,
  };
}
