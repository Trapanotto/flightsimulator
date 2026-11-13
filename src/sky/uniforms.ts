/**
 * The per-frame and per-hour inputs every sky shader shares (one set of uniforms, so the
 * dome, the aerial perspective, the clouds and the environment can never disagree).
 */
import { Matrix3, Vector2, Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';

export class SkyUniforms {
  // Light.
  /** Unit vectors in render space. */
  readonly sunDir = uniform(new Vector3(0, 1, 0));
  readonly moonDir = uniform(new Vector3(0, -1, 0));
  /** The light that lights the clouds: the sun, or the moon at night. */
  readonly lightDir = uniform(new Vector3(0, 1, 0));
  /** Moonlight outside the atmosphere in sky units (solar illuminance = 1). */
  readonly moonIlluminance = uniform(0);
  /** Exposure baked into everything the sky outputs (see Sky, "pre-exposure"). */
  readonly exposure = uniform(1);
  /** Equatorial -> render space is its inverse; this one turns view directions to the stars. */
  readonly toEquatorial = uniform(new Matrix3());

  // Observer.
  /** Local up at the camera in render space. */
  readonly up = uniform(new Vector3(0, 1, 0));
  /** Camera height above sea level, metres. */
  readonly altitude = uniform(500);
  /** Camera position in render space. */
  readonly cameraPosition = uniform(new Vector3());
  /** Horizontal offset of the render-space origin from a fixed point (east, south), metres. */
  readonly originOffset = uniform(new Vector2());
  /** Projection: x and y scale and offset (P[0], P[5], P[8], P[9]); near and far. */
  readonly projection = uniform(new Vector2(1, 1));
  readonly projectionOffset = uniform(new Vector2(0, 0));
  readonly near = uniform(0.5);
  readonly far = uniform(225_000);
  /** Camera orientation (view -> render space). */
  readonly cameraRotation = uniform(new Matrix3());

  // Clouds and weather.
  readonly cloudBase = uniform(1500);
  readonly cloudTop = uniform(3000);
  readonly cloudCover = uniform(0);
  /** Distance the clouds have drifted with the wind (east, south), metres. */
  readonly windOffset = uniform(new Vector2());
  /** Seconds since start: the clouds slowly change shape. */
  readonly time = uniform(0);
  /** Pre-exposed sunlight at the cloud layer (colour of the light the clouds get). */
  readonly cloudSun = uniform(new Vector3(1, 1, 1));
  /** Pre-exposed isotropic sky radiance at the cloud layer. */
  readonly cloudAmbient = uniform(new Vector3(0.2, 0.25, 0.35));
  /** Pre-exposed radiance of the ground below (bounce light under the clouds). */
  readonly groundRadiance = uniform(new Vector3(0.02, 0.02, 0.02));
  /**
   * How much of the air below the clouds is in their shadow (0 clear .. ~0.9 overcast): the
   * haze there is lit by the grey cloud base instead of the sun.
   */
  readonly hazeShadow = uniform(0);
  /** Pre-exposed radiance of the underside of an overcast deck (lights the haze below it). */
  readonly deckRadiance = uniform(new Vector3(0.1, 0.1, 0.1));
  /** Share of the light on the ground that is not direct sun (fills cloud shadows). */
  readonly diffuseShare = uniform(0.3);
  readonly frame = uniform(0);
}
