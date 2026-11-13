/**
 * Instrument maths of the Cessna 172S panel: unit conversions, value -> needle angle for every
 * gauge, and the derived values the simulation does not provide directly (turn rate, slip
 * ball, engine temperatures). Plain TypeScript, no renderer: tested in Node.
 *
 * Angles are degrees clockwise from 12 o'clock, as the pilot sees the dial.
 */

export const MS_TO_KT = 1 / 0.514444;
export const M_TO_FT = 1 / 0.3048;
export const MS_TO_FPM = 60 / 0.3048;
/** Avgas 100LL at 0.72 kg/l, US gallon 3.785411784 l. */
export const KG_PER_GAL_AVGAS = 0.72 * 3.785411784;
export const RAD_TO_DEG = 180 / Math.PI;

/** Airspeed markings of the 172S (POH section 2, KIAS). */
export const C172S_ASI = {
  /** White arc: full-flap operating range, Vs0 .. Vfe. */
  white: [40, 85] as const,
  /** Green arc: normal operating range, Vs1 .. Vno. */
  green: [48, 129] as const,
  /** Yellow arc: caution range, Vno .. Vne. */
  yellow: [129, 163] as const,
  /** Red line: never exceed. */
  vne: 163,
};

/** Tachometer markings of the 172S (POH section 2): green 2100-2700 rpm, red line 2700. */
export const C172S_TACH = { green: [2100, 2700] as const, red: 2700, max: 3500 };

/** Usable fuel per tank of the 172S standard tanks, US gallons (53 usable in total). */
export const C172S_TANK_GAL = 26.5;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Piecewise linear lookup in a table of [value, angle] pairs (sorted by value). */
export function lookup(table: readonly (readonly [number, number])[], v: number): number {
  const first = table[0]!;
  const last = table[table.length - 1]!;
  if (v <= first[0]) return first[1];
  if (v >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const b = table[i]!;
    if (v <= b[0]) {
      const a = table[i - 1]!;
      return a[1] + ((v - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
    }
  }
  return last[1];
}

/**
 * Airspeed indicator scale: compressed below 40 kt (the dial has no marks there), then about
 * 2.4 degrees per knot, like the real non-linear dial.
 */
export const ASI_SCALE: readonly (readonly [number, number])[] = [
  [0, 0],
  [40, 30],
  [60, 78],
  [80, 126],
  [100, 174],
  [120, 220],
  [140, 262],
  [160, 300],
  [180, 330],
  [200, 352],
];

export function asiAngle(knots: number): number {
  return lookup(ASI_SCALE, knots);
}

/** Altimeter: the three pointers for 100, 1000 and 10 000 ft (one turn each per 1000/10k/100k). */
export function altimeterAngles(feet: number): { p100: number; p1000: number; p10000: number } {
  const wrap = (v: number, period: number) => (((v % period) + period) % period) / period;
  return {
    p100: wrap(feet, 1000) * 360,
    p1000: wrap(feet, 10000) * 360,
    p10000: wrap(feet, 100000) * 360,
  };
}

/** Vertical speed: 0 at 9 o'clock, +-2000 ft/min at +-170 degrees from there. */
export function vsiAngle(fpm: number): number {
  return -90 + (clamp(fpm, -2000, 2000) / 2000) * 170;
}

/** Tachometer: 0 .. 3500 rpm over 250 degrees, 0 at about 7 o'clock. */
export function tachAngle(rpm: number): number {
  return -125 + (clamp(rpm, 0, C172S_TACH.max) / C172S_TACH.max) * 250;
}

/** Small engine gauges sweep +-50 degrees around 12 o'clock over their range. */
export function smallGaugeAngle(value: number, min: number, max: number): number {
  return -50 + clamp((value - min) / (max - min), 0, 1) * 100;
}

/** Flap position indicator: 0 .. 30 degrees of flap over -60 .. +60 degrees of needle. */
export function flapIndicatorAngle(flapFraction: number): number {
  return -60 + clamp(flapFraction, 0, 1) * 120;
}

/** Fuel per tank in US gallons (the 172S feeds from both tanks: half of the total each). */
export function fuelPerTankGal(fuelKg: number): number {
  return Math.max(0, fuelKg) / 2 / KG_PER_GAL_AVGAS;
}

/**
 * Turn coordinator: the aircraft symbol banks 20 degrees at standard rate (3 deg/s). Its gyro
 * is canted, so it also answers the roll rate a little. Positive = right (clockwise).
 */
export const TC_STANDARD_RATE_DEG_S = 3;
export const TC_STANDARD_RATE_TILT = 20;
export function turnCoordinatorAngle(turnRateDegS: number, rollRateDegS: number): number {
  const v = (turnRateDegS / TC_STANDARD_RATE_DEG_S) * TC_STANDARD_RATE_TILT + 0.25 * rollRateDegS;
  return clamp(v, -40, 40);
}

/**
 * Slip ball: displacement along its tube (degrees of arc, positive = to the pilot's right).
 * Without a lateral load factor in the telemetry, the sideslip drives it: a right sideslip
 * (beta > 0) pushes the cabin left, so the ball rolls right ("step on the ball").
 */
export function slipBallAngle(betaRad: number): number {
  return clamp(betaRad * RAD_TO_DEG * 1.6, -10, 10);
}

/**
 * Attitude indicator: the roll node turns counter-clockwise (as seen by the pilot) by the bank
 * angle, so in a right bank the horizon's right end rises. The pitch card shifts the horizon
 * down by PITCH_SCALE dial radii per degree of nose-up pitch.
 */
export const AI_PITCH_SCALE = 0.025;
/** The pitch card texture covers +-AI_CARD_RANGE degrees from top to bottom. */
export const AI_CARD_RANGE = 70;
/** Radius of the pitch card relative to the dial (must match the model). */
export const AI_CARD_RADIUS = 0.7;

export function attitudeRollAngle(bankRad: number): number {
  return bankRad;
}

/**
 * Texture v (0 at the top of the card texture, 1 at the bottom) seen at the card's own v
 * coordinate (0 top .. 1 bottom of the visible disc) for a given pitch.
 */
export function attitudeCardV(cardV: number, pitchDeg: number): number {
  const y = (0.5 - cardV) * 2 * AI_CARD_RADIUS; // dial radii above the centre
  const cardAngle = pitchDeg + y / AI_PITCH_SCALE;
  return (AI_CARD_RANGE - cardAngle) / (2 * AI_CARD_RANGE);
}

/** v offset the shader adds to the card texture for a pitch (linear in pitch). */
export function attitudeCardOffset(pitchDeg: number): number {
  return -clamp(pitchDeg, -AI_CARD_RANGE + 30, AI_CARD_RANGE - 30) / (2 * AI_CARD_RANGE);
}

/** Heading indicator card: counter-clockwise by the heading, so the heading is at the top. */
export function headingCardAngle(headingDeg: number): number {
  return headingDeg;
}

/**
 * Wet compass card around the vertical axis: turns by +heading (counter-clockwise from above)
 * relative to the aircraft; its numbers are printed so the heading faces the pilot.
 */
export function compassLabelAt(u: number): number {
  return (((360 - u * 360) % 360) + 360) % 360;
}

/** Shortest signed difference between two headings, degrees (-180 .. 180]. */
export function headingDelta(fromDeg: number, toDeg: number): number {
  let d = (toDeg - fromDeg) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** First-order lag towards a target (instrument damping), stable for any dt. */
export function lag(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0 || dt <= 0) return dt <= 0 ? current : target;
  return target + (current - target) * Math.exp(-dt / tau);
}
