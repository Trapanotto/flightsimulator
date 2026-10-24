import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  // GitHub Pages serves the site from https://trapanotto.github.io/flightsimulator/
  base: '/flightsimulator/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // three.js alone is ~130 kB gzip; that is expected.
    chunkSizeWarningLimit: 1000,
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
