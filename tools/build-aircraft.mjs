// Builds aircraft models in Blender and optimises them for the web.
// Usage: node tools/build-aircraft.mjs [type ...] [-- extra blender args, e.g. --preview]
// Without types: the whole fleet. Blender: $BLENDER, else `blender` in PATH, else the default
// Windows install location.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const ids = (split >= 0 ? argv.slice(0, split) : argv).filter(Boolean);
const extra = split >= 0 ? argv.slice(split + 1) : [];
const fleet = readdirSync('tools/blender/types')
  .filter((f) => f.endsWith('.py') && !f.startsWith('_'))
  .map((f) => f.replace(/\.py$/, ''));

const winBlender = 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const blender = process.env.BLENDER ?? (existsSync(winBlender) ? winBlender : 'blender');

for (const id of ids.length ? ids : fleet) {
  if (!fleet.includes(id))
    throw new Error(`unknown aircraft type "${id}" (have: ${fleet.join(', ')})`);
  console.log(`\n== ${id}`);
  execFileSync(
    blender,
    ['-b', '--factory-startup', '-P', 'tools/blender/build_aircraft.py', '--', id, ...extra],
    { stdio: 'inherit' },
  );
  execFileSync(
    process.execPath,
    ['tools/optimize-aircraft.mjs', `build/${id}_raw.glb`, `public/assets/aircraft/${id}.glb`],
    { stdio: 'inherit' },
  );
}
