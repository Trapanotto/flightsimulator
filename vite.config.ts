import { defineConfig } from 'vite';

// GitHub Pages serves the project under /flightsimulator/.
// Keep the same base in dev and preview so local URLs match production.
export default defineConfig({
  base: '/flightsimulator/',
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: 'es',
  },
});
