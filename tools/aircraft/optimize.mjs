// Optimises the Blender export for the web: dedupe, prune, meshopt geometry compression.
// Usage: node tools/aircraft/optimize.mjs [in=build/aircraft/c172_raw.glb] [out=public/assets/aircraft/c172.glb] [limit MB=4]
// Run by tools/aircraft/build_c172.py after the export.
import { statSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [
  input = 'build/aircraft/c172_raw.glb',
  output = 'public/assets/aircraft/c172.glb',
  limit = '4',
] = process.argv.slice(2);
/** The aircraft budget (phase 1 brief): about 4 MB including textures; a type may set less. */
const LIMIT_MB = Number(limit);

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const doc = await io.read(input);
// Quantisation writes a dequantisation transform into the node that owns a mesh. Give every
// mesh its own child node so named nodes (pivots, parts the loader looks up) keep their
// transforms; the loader finds a part's mesh below its named node.
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const child = doc.createNode(`${node.getName()}_geo`).setMesh(mesh);
  node.setMesh(null);
  node.addChild(child);
}
// keepAttributes: dial faces carry UVs without a texture (the game draws on them).
await doc.transform(
  dedup(),
  prune({ keepAttributes: true, keepLeaves: true, keepExtras: true }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
await io.write(output, doc);

const mb = (p) => statSync(p).size / 1024 / 1024;
const root = doc.getRoot();
const textures = root.listTextures().map((t) => {
  const s = t.getSize();
  return `${t.getName() || t.getURI()} ${s?.[0]}x${s?.[1]} ${(t.getImage().byteLength / 1024).toFixed(0)} KB`;
});
console.log(`${input} ${mb(input).toFixed(2)} MB -> ${output} ${mb(output).toFixed(2)} MB`);
console.log(`meshes ${root.listMeshes().length}, materials ${root.listMaterials().length}`);
console.log('textures:', textures.join(' | '));
if (mb(output) > LIMIT_MB) {
  console.error(`The aircraft is larger than the ${LIMIT_MB} MB budget.`);
  process.exit(1);
}
