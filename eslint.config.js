import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Package boundaries (docs/ARCHITEKTUR.md). Each package lists the packages it may import;
 * everything else is an error. Other packages are imported only through their index
 * (`@sim`, never `@sim/...` or `../sim/...`).
 */
const ALLOWED = {
  sim: [],
  geo: [],
  sky: [],
  world: ['geo'],
  aircraft: ['sim'],
  audio: ['sim'],
  ui: ['sim', 'geo', 'world', 'sky', 'aircraft', 'audio'],
  app: ['sim', 'geo', 'world', 'sky', 'aircraft', 'audio', 'ui'],
};
/** Packages that must run without a renderer or a browser (tested headless). */
const NO_THREE = ['sim', 'geo'];
const ALL = Object.keys(ALLOWED);

const boundaries = ALL.map((pkg) => {
  const forbidden = ALL.filter((p) => p !== pkg && !ALLOWED[pkg].includes(p));
  const patterns = [
    {
      group: ALL.map((p) => `@${p}/*`),
      message: 'Import other packages only through their index (e.g. "@sim").',
    },
    {
      group: ALL.filter((p) => p !== pkg).flatMap((p) => [`../${p}`, `../${p}/*`, `**/../${p}/*`]),
      message: 'Use the package alias (e.g. "@sim") instead of a relative path.',
    },
    { group: [`@${pkg}`], message: 'Inside a package, import its files by relative path.' },
  ];
  if (forbidden.length)
    patterns.push({
      group: forbidden.map((p) => `@${p}`),
      message: `"${pkg}" may only depend on: ${ALLOWED[pkg].join(', ') || 'nothing'} (docs/ARCHITEKTUR.md).`,
    });
  if (NO_THREE.includes(pkg))
    patterns.push({
      group: ['three', 'three/*', 'preact', 'preact/*'],
      message: `"${pkg}" is plain TypeScript: no renderer, no UI framework.`,
    });
  return {
    files: [`src/${pkg}/**/*.{ts,tsx}`],
    rules: { 'no-restricted-imports': ['error', { patterns }] },
  };
});

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'public'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // Parameters an interface demands but an implementation does not use yet: `_name`.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tools/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  ...boundaries,
);
