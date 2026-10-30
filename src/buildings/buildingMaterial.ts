import { MeshLambertMaterial, type Texture } from 'three';
import type { AtmosphereUniforms } from '../render/Atmosphere';
import { AERIAL_GLSL } from '../render/aerial';

/** Size of one wall bay (one window) and one roof patch in metres. */
const BAY_W = 3.5;
const BAY_H = 3.0;
const ROOF_TILE = 2.6;

const ATLAS_FN = /* glsl */ `
        vec4 atlasCell(float cell, vec2 uvm) {
          float cx = mod(cell, 8.0);
          float cy = floor(cell / 8.0 + 0.001);
          vec2 f = fract(uvm);
          vec2 p = (vec2(cx, cy) + vec2(f.x, 1.0 - f.y) * 0.98 + 0.01) / 8.0;
          // Gradients from the unwrapped coordinates avoid mip seams at the cell edges; clamping
          // them keeps the lookup inside the cell (no bleeding from neighbours).
          vec2 gx = dFdx(uvm);
          vec2 gy = dFdy(uvm);
          float g = max(length(gx), length(gy));
          vec4 detail = textureGrad(map, p, gx / 8.0 * min(1.0, 0.25 / max(g, 1e-5)), gy / 8.0 * min(1.0, 0.25 / max(g, 1e-5)));
          // Far away: the cell's average colour (mip 8 of the 2048 atlas = one texel per cell).
          vec4 avg = textureLod(map, (vec2(cx, cy) + 0.5) / 8.0, 8.0);
          return mix(detail, avg, smoothstep(0.12, 0.45, g));
        }
`;

/**
 * Material for the instanced Blender buildings. Texture coordinates are computed in metres from
 * the instance scale, so a 25 m farmhouse gets more windows than a 10 m one instead of stretched
 * ones. Per instance: `iTint` (plaster colour). Each face knows its atlas cells (uv) and the
 * height (uv1.x) where the lower cell (plinth/ground floor) switches to the upper one.
 */
export function createBuildingMaterial(atlas: Texture, atmosphere?: AtmosphereUniforms) {
  const mat = new MeshLambertMaterial({ map: atlas });
  mat.fog = false;
  mat.customProgramCacheKey = () => `buildings-${atmosphere ? 1 : 0}`;
  mat.onBeforeCompile = (shader) => {
    if (atmosphere) Object.assign(shader.uniforms, atmosphere);
    shader.defines = { ...shader.defines, BLD_HAZE: atmosphere ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 iTint;
        attribute vec2 iVar;
        attribute vec2 uv1;
        varying vec2 vVar;
        varying vec3 vMetric;
        varying vec3 vObjN;
        varying vec2 vCells;
        varying float vSplit;
        varying vec3 vTint;
        varying vec3 vWorld;
        varying float vVariation;`,
      )
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
        vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vMetric = position * sc;
        vObjN = normal;
        // The Blender glTF exporter stores v as 1 - v.
        vCells = vec2(uv.x, 1.0 - uv.y);
        vSplit = uv1.x;
        vTint = iTint;
        vVar = iVar;
        vec3 ip = instanceMatrix[3].xyz;
        vVariation = fract(sin(dot(ip.xz, vec2(12.9898, 78.233))) * 43758.5453);
        vWorld = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vMetric;
        varying vec3 vObjN;
        varying vec2 vCells;
        varying float vSplit;
        varying vec3 vTint;
        varying vec3 vWorld;
        varying float vVariation;
        varying vec2 vVar;
        #if BLD_HAZE
          ${AERIAL_GLSL}
        #endif

`,
      )
      .replace(
        '#include <map_pars_fragment>',
        `#include <map_pars_fragment>
${ATLAS_FN}`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          vec3 n = normalize(vObjN);
          bool wall = abs(n.y) < 0.5;
          vec2 uvm;
          // Families of 4 variants (bld_textures.py): the building picks one for its walls and
          // one for its roof.
          float cell;
          float variant = wall ? vVar.x : vVar.y;
          if (wall) {
            float along = abs(n.x) > abs(n.z) ? vMetric.z : vMetric.x;
            uvm = vec2(along / ${BAY_W.toFixed(1)}, vMetric.y / ${BAY_H.toFixed(1)});
            cell = vMetric.y < vSplit ? vCells.x : vCells.y;
          } else {
            uvm = vMetric.xz / ${ROOF_TILE.toFixed(1)};
            cell = vCells.y;
          }
          vec4 t = atlasCell(floor(cell + 0.5) * 4.0 + floor(variant + 0.5), uvm);
          vec3 c = t.rgb;
          // Alpha 1.0 = tintable plaster, 0.5 = keep colour (see bld_textures.py).
          c = mix(c, c * vTint, clamp(t.a * 2.0 - 1.0, 0.0, 1.0));
          c *= 0.9 + 0.2 * vVariation;
          diffuseColor.rgb *= c;
        }`,
      )
      .replace(
        '#include <fog_fragment>',
        `#if BLD_HAZE
          gl_FragColor.rgb = aerial(gl_FragColor.rgb, vWorld, elevationOf(vWorld));
        #endif`,
      );
  };
  return mat;
}
