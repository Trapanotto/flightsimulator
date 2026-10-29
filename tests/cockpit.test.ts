import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AIRCRAFT } from '../src/aircraft/types';

/** Node names and per-mesh attributes from the JSON chunk of a GLB file. */
function glbJson(path: string) {
  const buf = readFileSync(path);
  const len = new DataView(buf.buffer, buf.byteOffset).getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + len))) as {
    nodes: Array<{ name?: string; mesh?: number; children?: number[] }>;
    meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
  };
}

// Cockpit contract with tools/blender/ac/cockpit.py: displays and moving controls per type.
const EXPECT: Record<string, { displays: string[]; controls: string[] }> = {
  c172: { displays: ['SIX', 'ENG', 'RADIO'], controls: ['Yoke_L', 'Yoke_R', 'Knob_Throttle'] },
  pc12: { displays: ['PFD', 'MFD', 'EICAS', 'FCU'], controls: ['Yoke_L', 'Throttle_1'] },
  phenom100: { displays: ['PFD', 'MFD', 'FCU', 'MCDU'], controls: ['Yoke_L', 'Throttle_2'] },
  f35: { displays: ['PCD'], controls: ['Stick_R', 'Throttle_1'] },
  a320: {
    displays: ['PFD', 'ND', 'EWD', 'SD', 'FCU', 'MCDU', 'OVH'],
    controls: ['Stick_L', 'Stick_R', 'Throttle_2'],
  },
  b747: {
    displays: ['PFD', 'ND', 'EICAS', 'SD', 'FCU', 'MCDU', 'OVH'],
    controls: ['Column_L', 'Wheel_L', 'Wheel_R', 'Throttle_4'],
  },
};

describe('cockpits', () => {
  for (const type of AIRCRAFT) {
    it(`${type.id} has its displays (with UVs) and moving controls`, () => {
      const gltf = glbJson(`public/assets/aircraft/${type.id}.glb`);
      const names = new Set(gltf.nodes.map((n) => n.name ?? ''));
      const want = EXPECT[type.id]!;
      for (const kind of want.displays) {
        const node = gltf.nodes.find((n) => n.name === `Display_${kind}_0_LOD0`);
        expect(node, `Display_${kind}`).toBeDefined();
        // The geometry sits in the _mesh child and must keep its UVs for the canvas.
        const child = gltf.nodes[node!.children![0]!]!;
        expect(gltf.meshes[child.mesh!]!.primitives[0]!.attributes.TEXCOORD_0).toBeDefined();
        expect(names.has(`Display_${kind}_0_LOD1`)).toBe(true);
      }
      for (const c of want.controls) expect(names.has(`${c}_LOD0`), c).toBe(true);
      expect(names.has('Cockpit_LOD0')).toBe(true);
    });
  }
});
