import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

/** The packages of docs/ARCHITEKTUR.md; each is imported only through its index. */
export const PACKAGES = ['sim', 'geo', 'world', 'sky', 'aircraft', 'audio', 'ui', 'app'];

export default defineConfig({
  // GitHub Pages serves the site from https://trapanotto.github.io/flightsimulator/
  base: '/flightsimulator/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: Object.fromEntries(
      PACKAGES.map((p) => [
        `@${p}`,
        fileURLToPath(new URL(`./src/${p}/index.ts`, import.meta.url)),
      ]),
    ),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // three.js with the WebGPU renderer is large; that is expected.
    chunkSizeWarningLimit: 1500,
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Some tests fly whole approaches through the flight model: seconds on a fast machine,
    // more on a build server or under load. The default 5 s made them fail at random.
    testTimeout: 30_000,
  },
});
