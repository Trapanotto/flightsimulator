import { MeshLambertMaterial, type Texture } from 'three';
import { NOISE_PERIOD, type AtmosphereUniforms } from '../render/Atmosphere';

/** Terrain albedo boost: orthophotos are darker than the PBR lighting expects. */
export const TERRAIN_GAIN = 1.6;

export interface TerrainLook {
  /** Fine noise near the camera so low passes do not look blurry. */
  detail: boolean;
  cloudShadows: boolean;
}

/** GLSL shared by terrain and clouds: cloud coverage at a base-frame position. */
export const CLOUD_GLSL = /* glsl */ `
  uniform sampler2D uNoise;
  uniform vec2 uOriginMod;
  uniform float uTime;
  uniform float uCloudCoverage;
  uniform float uCloudAltitude;
  const float NOISE_PERIOD = ${NOISE_PERIOD.toFixed(1)};

  // Base-frame xz (stable across floating-origin moves) for a render-space position.
  vec2 basePos(vec3 p) { return p.xz + uOriginMod; }

  // 0 = clear sky, 1 = solid cloud. Two scales of the noise texture, drifting with the wind.
  float cloudDensity(vec2 p) {
    vec2 wind = vec2(9.0, 3.5) * uTime;
    float n = texture2D(uNoise, (p + wind) / NOISE_PERIOD).r * 0.65
            + texture2D(uNoise, (p + wind * 1.6) / (NOISE_PERIOD * 0.31)).r * 0.35;
    float edge = 1.0 - uCloudCoverage;
    return smoothstep(edge - 0.06, edge + 0.14, n);
  }
`;

const DECLARATIONS = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uHazeColor;
  uniform vec3 uHazeSunColor;
  uniform float uHazeDensity;
  uniform float uHazeHeight;
  uniform float uCameraElevation;
  uniform float uCloudShadow;
  varying vec3 vWorldPos;
  varying float vElevation;
  ${CLOUD_GLSL}
`;

/** Updates our feature switches on a terrain material without dropping three's own defines. */
export function setTerrainDefines(mat: MeshLambertMaterial, look: TerrainLook) {
  mat.defines = {
    ...mat.defines,
    TERRAIN_DETAIL: look.detail ? 1 : 0,
    TERRAIN_CLOUD_SHADOWS: look.cloudShadows ? 1 : 0,
  };
}

/**
 * Terrain material: three's Lambert (lights, shadows) plus our own look, injected with
 * onBeforeCompile so all tiles share one shader program.
 */
export function createTerrainMaterial(
  map: Texture,
  atmosphere: AtmosphereUniforms,
  look: TerrainLook,
) {
  const mat = new MeshLambertMaterial({ map });
  mat.color.setScalar(TERRAIN_GAIN);
  mat.fog = false;
  // Keep three's own defines (Lambert needs them, e.g. for shadows) and add ours.
  setTerrainDefines(mat, look);
  mat.customProgramCacheKey = () => `terrain-${look.detail ? 1 : 0}${look.cloudShadows ? 1 : 0}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, atmosphere);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float elevation;
        varying vec3 vWorldPos;
        varying float vElevation;`,
      )
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vElevation = elevation;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECLARATIONS}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 c = diffuseColor.rgb;
          float lum = dot(c, vec3(0.299, 0.587, 0.114));
          // Slightly richer colours than the raw orthophoto.
          c = mix(vec3(lum), c, 1.12);
          #if TERRAIN_DETAIL
            float dist = length(vWorldPos - cameraPosition);
            vec2 p = basePos(vWorldPos);
            float n = texture2D(uNoise, p / 190.0).r * 0.6 + texture2D(uNoise, p / 41.0).r * 0.4;
            c *= mix(1.0, 0.86 + 0.28 * n, 1.0 - smoothstep(500.0, 2600.0, dist));
          #endif
          // Snow: bright surfaces high up get brighter and bluish white.
          float snow = smoothstep(2350.0, 2950.0, vElevation) * smoothstep(0.32 * ${TERRAIN_GAIN.toFixed(1)}, 0.62 * ${TERRAIN_GAIN.toFixed(1)}, lum);
          c = mix(c, vec3(0.93, 0.96, 1.0) * max(lum * 1.08, 0.78 * ${TERRAIN_GAIN.toFixed(1)}), snow * 0.65);
          diffuseColor.rgb = c;
        }`,
      )
      .replace(
        '#include <opaque_fragment>',
        `#if TERRAIN_CLOUD_SHADOWS
          {
            // Shadow of the cloud layer: follow the sun ray up to the cloud altitude.
            float dh = max(uCloudAltitude - vElevation, 0.0);
            vec2 q = basePos(vWorldPos) + uSunDir.xz / max(uSunDir.y, 0.12) * dh;
            outgoingLight *= 1.0 - uCloudShadow * cloudDensity(q);
          }
        #endif
        #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
          {
            // Aircraft shadow: the ambient term is high (orthophotos carry their own shadows), so
            // the regular shadow on the sun term alone is almost invisible. Darken it explicitly.
            DirectionalLightShadow dls = directionalLightShadows[ 0 ];
            float sh = receiveShadow ? getShadow( directionalShadowMap[ 0 ], dls.shadowMapSize,
              dls.shadowIntensity, dls.shadowBias, dls.shadowRadius, vDirectionalShadowCoord[ 0 ] ) : 1.0;
            outgoingLight *= mix( 0.55, 1.0, sh );
          }
        #endif
        #include <opaque_fragment>`,
      )
      .replace(
        '#include <fog_fragment>',
        `{
          // Aerial perspective: haze thins out with altitude and glows towards the sun.
          vec3 toFrag = vWorldPos - cameraPosition;
          float dist = length(toFrag);
          float hAvg = 0.5 * (uCameraElevation + vElevation);
          float density = uHazeDensity * exp(-max(hAvg - 400.0, 0.0) / uHazeHeight);
          float fogAmt = 1.0 - exp(-dist * density);
          float sunAmt = pow(max(dot(toFrag / max(dist, 1.0), uSunDir), 0.0), 14.0) * 0.8;
          gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(uHazeColor, uHazeSunColor, sunAmt), fogAmt);
        }`,
      );
  };
  return mat;
}
