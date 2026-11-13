# Trapanotto Flight Simulator

Flight simulator in the browser over the real Switzerland. Rebuilt from scratch as version 1
(the old game is the tag `v0.11.0`). Read `docs/KONZEPT.md` for what is being built and why,
and `docs/ARCHITEKTUR.md` for the rules below in full.

## Commands

- `npm run check` – types, lint (including package boundaries) and tests. Run before finishing.
- `npm run shots` – screenshot comparison in a real browser; `npm run shots:update` after an
  intended visual change.
- `npm run dev` – dev server at http://localhost:5173/flightsimulator/
- `npm run format` – Prettier.

## Rules

- `src/` is split into packages: `sim`, `geo`, `sky`, `world`, `aircraft`, `audio`, `ui`,
  `app`. Import another package only through its alias (`@sim`, `@geo`, …), never by path.
  Allowed dependencies are in `docs/ARCHITEKTUR.md`; the linter enforces them. If you need a
  dependency that is not allowed, the wiring belongs in `app`.
- Stay inside the package you were given. Do not edit another package's files; if its
  interface is missing something, say so in your report instead.
- `sim` and `geo` are plain TypeScript: no three.js, no DOM, tested in Node.
- Rendering uses three.js `WebGPURenderer` (`three/webgpu`) and node materials (`three/tsl`).
  No shader string injection, no `onBeforeCompile`. Everything needs to run, or switch off
  cleanly, on the WebGL 2 fallback and within the mobile budget (`src/app/device.ts`).
- The simulation is deterministic: fixed 120 Hz step, no wall clock, no unseeded randomness.
- Coordinates: world = ECEF metres; render space = `LocalFrame` (x east, y up, z south);
  aircraft body = x forward, y right, z down; a 3D model = x left, y up, z forward.
- Every user-visible text goes through `t()` in `src/ui/i18n.ts`, in German and English.
- Code, comments and commit messages in English. Comments explain why, not what.
- New behaviour comes with a test in `tests/`. Numbers from a manual or a standard are tested
  against the published value.
