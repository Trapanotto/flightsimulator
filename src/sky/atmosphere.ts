/**
 * The atmosphere model shared by the shaders (lookup tables, sky, aerial perspective) and the
 * CPU (sun light colour, exposure). Plain TypeScript, no three.js, so it is tested in Node.
 *
 * Hillaire 2020 / Bruneton 2017 parameters for the Earth: Rayleigh scattering by air
 * molecules (blue sky), Mie scattering by aerosols (haze, the glow around the sun) and ozone
 * absorption (keeps the twilight zenith blue instead of grey). Lengths are kilometres and
 * coefficients 1/km, because the shaders work in kilometres: metres would push the planet
 * radius to the edge of single precision.
 */

export const EARTH_RADIUS = 6360;
export const ATMOSPHERE_TOP = 6460;

export type Vec3 = [number, number, number];

/** Rayleigh scattering at sea level, 1/km, for (680, 550, 440) nm. */
export const RAYLEIGH_SCATTERING: Vec3 = [5.802e-3, 13.558e-3, 33.1e-3];
export const RAYLEIGH_SCALE_HEIGHT = 8;
/** Mie scattering and extinction at sea level for clean air, 1/km (single scattering albedo 0.9). */
export const MIE_SCATTERING = 3.996e-3;
export const MIE_EXTINCTION = 4.44e-3;
export const MIE_SCALE_HEIGHT = 1.2;
/** Asymmetry of the Mie phase function: strongly forward, the bright aureole around the sun. */
export const MIE_G = 0.8;
/** Ozone absorption at the peak of its layer, 1/km. */
export const OZONE_ABSORPTION: Vec3 = [0.65e-3, 1.881e-3, 0.085e-3];
/** The ozone layer as a tent around 25 km, 30 km wide. */
export const OZONE_CENTER = 25;
export const OZONE_HALF_WIDTH = 15;
/** Average albedo of the landscape seen from far away (fields, forest, rock). */
export const GROUND_ALBEDO: Vec3 = [0.1, 0.11, 0.09];
/** Angular radius of the sun disc, radians. */
export const SUN_ANGULAR_RADIUS = 0.2666 * (Math.PI / 180);
/** Angular radius of the moon disc, radians (mean). */
export const MOON_ANGULAR_RADIUS = 0.259 * (Math.PI / 180);
/** Solar illuminance outside the atmosphere, lux: the unit the sky computes in is this = 1. */
export const SOLAR_ILLUMINANCE_LUX = 128_000;

/** Luminance weights of the three channels (Rec. 709, the working colour space). */
export const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];

/**
 * How much denser than clean air the aerosols are, from the visibility at the ground
 * (Koschmieder: contrast falls to 2 % at the visibility, so the extinction there is
 * 3.912 / visibility). The air molecules alone already limit the view to about 290 km.
 */
export function mieDensityFromVisibility(visibilityM: number): number {
  const extinction = 3912 / Math.max(visibilityM, 500);
  const mie = extinction - RAYLEIGH_SCATTERING[1];
  return Math.min(Math.max(mie / MIE_EXTINCTION, 0.3), 60);
}

/** Air density relative to sea level at height h (km) for the three constituents. */
export function densities(h: number): { rayleigh: number; mie: number; ozone: number } {
  return {
    rayleigh: Math.exp(-Math.max(h, 0) / RAYLEIGH_SCALE_HEIGHT),
    mie: Math.exp(-Math.max(h, 0) / MIE_SCALE_HEIGHT),
    ozone: Math.max(0, 1 - Math.abs(h - OZONE_CENTER) / OZONE_HALF_WIDTH),
  };
}

/** Extinction per channel at height h (km), 1/km. */
export function extinctionAt(h: number, mieDensity = 1): Vec3 {
  const d = densities(h);
  return [0, 1, 2].map(
    (i) =>
      RAYLEIGH_SCATTERING[i]! * d.rayleigh +
      MIE_EXTINCTION * mieDensity * d.mie +
      OZONE_ABSORPTION[i]! * d.ozone,
  ) as Vec3;
}

/** Distance from a point at radius r along a ray with cosine mu to a sphere of radius s, or -1. */
export function raySphere(r: number, mu: number, s: number, far = true): number {
  const disc = r * r * (mu * mu - 1) + s * s;
  if (disc < 0) return -1;
  const q = Math.sqrt(disc);
  return far ? -r * mu + q : -r * mu - q;
}

/** Whether a ray from radius r with view cosine mu hits the ground. */
export function hitsGround(r: number, mu: number): boolean {
  return mu < 0 && r * r * (mu * mu - 1) + EARTH_RADIUS * EARTH_RADIUS >= 0;
}

/**
 * Optical depth (dimensionless, per channel) from height h (km) towards the top of the
 * atmosphere along a ray whose cosine to the zenith is mu. Infinite if the ray hits the ground.
 */
export function opticalDepthToSpace(h: number, mu: number, mieDensity = 1, steps = 200): Vec3 {
  const r = EARTH_RADIUS + h;
  if (hitsGround(r, mu)) return [Infinity, Infinity, Infinity];
  const len = raySphere(r, mu, ATMOSPHERE_TOP);
  const od: Vec3 = [0, 0, 0];
  const dt = len / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const ri = Math.sqrt(r * r + t * t + 2 * r * mu * t);
    const e = extinctionAt(ri - EARTH_RADIUS, mieDensity);
    for (let c = 0; c < 3; c++) od[c] = od[c]! + e[c]! * dt;
  }
  return od;
}

/** Transmittance of the atmosphere from height h (km) to space along mu. */
export function transmittanceToSpace(h: number, mu: number, mieDensity = 1): Vec3 {
  return opticalDepthToSpace(h, mu, mieDensity).map((d) => Math.exp(-d)) as Vec3;
}

/**
 * Share of the sun disc above the horizon seen from height h (km) for a sun at cosine mu to
 * the zenith: the disc sinks behind the curved Earth over its own diameter, not at once.
 */
export function sunVisibility(h: number, mu: number): number {
  const r = EARTH_RADIUS + Math.max(h, 0.001);
  const sinHorizon = EARTH_RADIUS / r;
  const muHorizon = -Math.sqrt(Math.max(0, 1 - sinHorizon * sinHorizon));
  const x = (mu - muHorizon) / SUN_ANGULAR_RADIUS;
  return Math.min(Math.max(0.5 + 0.5 * x, 0), 1);
}

/**
 * Colour and strength of direct sunlight at height h (km) for a sun at cosine mu to the
 * zenith, per channel, in units of the solar illuminance outside the atmosphere.
 */
export function sunIlluminance(h: number, mu: number, mieDensity = 1): Vec3 {
  const vis = sunVisibility(h, mu);
  if (vis <= 0) return [0, 0, 0];
  // Below the geometric horizon the light still arrives through the grazing ray at the limb.
  const r = EARTH_RADIUS + Math.max(h, 0.001);
  const muHorizon = -Math.sqrt(Math.max(0, 1 - (EARTH_RADIUS / r) ** 2));
  const t = transmittanceToSpace(h, Math.max(mu, muHorizon + 1e-4), mieDensity);
  return t.map((v) => v * vis) as Vec3;
}

export function luminance(c: Vec3): number {
  return c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
}

/**
 * Diffuse light from a clear sky on a horizontal surface, lux, by sun elevation (degrees).
 * Measured twilight values (US Naval Observatory, Kittler & CIE clear sky): about 700 lux at
 * sunset, 3.4 at the end of civil twilight, 0.008 at the end of nautical twilight.
 */
const SKY_DIFFUSE_LOG10: [number, number][] = [
  [-18, -3.3],
  [-12, -2.1],
  [-9, -0.8],
  [-6, 0.53],
  [-4, 1.45],
  [-2, 2.25],
  [0, 2.85],
  [2, 3.25],
  [5, 3.6],
  [10, 3.9],
  [20, 4.15],
  [40, 4.3],
  [90, 4.38],
];

export function skyDiffuseLux(elevationDeg: number): number {
  const table = SKY_DIFFUSE_LOG10;
  if (elevationDeg <= table[0]![0]) return 10 ** table[0]![1];
  for (let i = 1; i < table.length; i++) {
    const [e1, v1] = table[i]!;
    const [e0, v0] = table[i - 1]!;
    if (elevationDeg <= e1) {
      const f = (elevationDeg - e0) / (e1 - e0);
      // Smoothstep inside each segment keeps the exposure free of kinks over a time-lapse.
      return 10 ** (v0 + (v1 - v0) * (f * f * (3 - 2 * f)));
    }
  }
  return 10 ** table[table.length - 1]![1];
}

/** Light from the night sky with no moon (stars, airglow, some light from the towns), lux. */
export const NIGHT_FLOOR_LUX = 0.002;

/**
 * Light on the ground (horizontal illuminance, lux): direct sun, the sky, the moon and the
 * night floor. Haze dims the direct sun through the transmittance.
 */
export function horizontalIlluminance(
  sunElevationDeg: number,
  sunDirect: Vec3,
  moonLux: number,
): number {
  const sinEl = Math.max(Math.sin(sunElevationDeg * (Math.PI / 180)), 0);
  const direct = luminance(sunDirect) * SOLAR_ILLUMINANCE_LUX * sinEl;
  return direct + skyDiffuseLux(sunElevationDeg) + moonLux + NIGHT_FLOOR_LUX;
}

/**
 * How strongly the eye (or camera) adapts, in two regimes: by day like a camera on automatic
 * but not fully (a sunset stays darker than noon), in dim light more (the eye adapts to the
 * night; a moonlit landscape must stay readable). 1 would make every hour equally bright.
 */
export const ADAPTATION_DAY = 0.65;
export const ADAPTATION_NIGHT = 0.9;
/** Illuminance (lux) where the two regimes meet: deep in civil twilight. */
export const ADAPTATION_KNEE = 200;
/** Calibrates the image brightness at noon (middle grey of a sunlit field about 0.18). */
export const EXPOSURE_KEY = 4.2;

/**
 * Exposure for the light of the moment: the factor from sky units (solar illuminance = 1) to
 * what the tone mapping expects, with partial adaptation. Continuous and monotonic in the
 * illuminance. `sunElevationDeg` adds the twilight correction: then the sky towards the sun
 * is hundreds of times brighter than the land, and an eye (or camera) looking at a view that
 * is mostly sky stops down; without this the twilight arch would burn out to white.
 */
export function exposureFor(horizontalLux: number, sunElevationDeg = 90): number {
  const e = Math.max(horizontalLux, 1e-4) / SOLAR_ILLUMINANCE_LUX;
  const knee = ADAPTATION_KNEE / SOLAR_ILLUMINANCE_LUX;
  const adaptedLog =
    e >= knee
      ? ADAPTATION_DAY * Math.log(e)
      : ADAPTATION_DAY * Math.log(knee) + ADAPTATION_NIGHT * Math.log(e / knee);
  const twilight = 1 + 2 * Math.exp(-(((sunElevationDeg + 5) / 3.5) ** 2));
  return EXPOSURE_KEY / Math.exp(adaptedLog) / twilight;
}
