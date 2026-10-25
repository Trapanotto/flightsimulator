// Optimises the Blender export for the web: dedupe, prune, meshopt geometry compression.
// Usage: node tools/optimize-aircraft.mjs <in=build/c172_raw.glb> <out=public/assets/aircraft/c172.glb>
// Also used for build/buildings_raw.glb and build/trees_raw.glb (public/assets/buildings/).
import { statSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [input = 'build/c172_raw.glb', output = 'public/assets/aircraft/c172.glb'] =
  process.argv.slice(2);
const LIMIT_MB = 2.5;

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const doc = await io.read(input);
// Quantisation stores a dequantisation offset/scale in the node that owns a mesh, which would
// move hinge pivots. Give every mesh its own child node so the pivot nodes stay untouched.
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const child = doc.createNode(`${node.getName()}_mesh`).setMesh(mesh);
  node.setMesh(null);
  node.addChild(child);
}
await doc.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
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
  console.error(`Aircraft is larger than the ${LIMIT_MB} MB budget (concept ch. 10.4).`);
  process.exit(1);
}
