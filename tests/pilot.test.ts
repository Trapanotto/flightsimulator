import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('pilot model', () => {
  it('is a skinned figure with the five animations the game plays', () => {
    const buf = readFileSync('public/assets/pilot/pilot.glb');
    const len = new DataView(buf.buffer, buf.byteOffset).getUint32(12, true);
    const gltf = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + len))) as {
      animations: Array<{ name: string; channels: unknown[] }>;
      skins: Array<{ joints: number[] }>;
    };
    const names = gltf.animations.map((a) => a.name).sort();
    expect(names).toEqual(['Canopy', 'FreeFall', 'Idle', 'Run', 'Walk']);
    expect(gltf.skins.length).toBe(1);
    expect(gltf.skins[0]!.joints.length).toBeGreaterThanOrEqual(19);
    for (const a of gltf.animations) expect(a.channels.length).toBeGreaterThan(10);
  });
});
