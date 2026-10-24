# ADR 0001 — Phase 1 world engine

**Status:** accepted · **Date:** 2026-10-24

## Context

Phase 1 must deliver a browser-based Switzerland world with real terrain,
orthophotos, smooth streaming and a free camera, deployed to GitHub Pages.
The project must work without a backend and without CesiumJS.

## Decisions

### 1. Fixed local ENU origin instead of floating origin

The whole of Switzerland fits inside a ~160 km radius around
`46.8° N, 8.2° E`. `Float32` positions are accurate to a few millimetres at
that distance, so phase 1 uses a fixed ENU origin. A floating origin will be
introduced when the aircraft can leave the country or when centimetre-level
cockpit interaction requires it.

**Consequence:** simple, fast math; terrain meshes never need rebuilding.

### 2. Own quantized-mesh decoder instead of CesiumJS

The swisstopo terrain service returns Cesium Quantized Mesh 1.0. The decoder
is ~250 lines, runs in a Web Worker, handles delta/zig-zag vertices, 16/32-bit
high-water-mark indices, edge lists, oct-encoded normals and metadata.

**Consequence:** no 4 MB Cesium dependency, full control over memory layout
and LOD. Verified against a real Zurich z14 tile in unit tests.

### 3. Terrain workers + main-thread scene graph

Workers fetch, decode and transform tiles into ENU. Transferable typed arrays
are handed to the main thread, which only creates `BufferGeometry` and
textures.

**Consequence:** decoding does not block rendering; no `SharedArrayBuffer`
needed (GitHub Pages cannot set COOP/COEP headers).

### 4. Imagery coupled to terrain zoom, canvas composition

Terrain is EPSG:4326, SWISSIMAGE is EPSG:3857. Each terrain tile gets a
composed canvas (`z >= 13`: 512², otherwise 256²) from 1–4 WMTS tiles at
`imageryZoom = clamp(terrainZoom + 1, 9, 19)`.

**Consequence:** roughly two image requests per terrain tile, correct draping
without reprojection shaders, and low memory for distant tiles. Seams between
different LOD levels remain a known limitation.

### 5. LOD budget and serialised splitting

The quadtree splits only after the parent mesh is ready, uses a screen-space
error threshold of 1.5 px, caps terrain detail at zoom 14 for phase 1 and
stops creating nodes after 520 tiles.

**Consequence:** stable 60 fps and bounded memory. Low-altitude detail will be
raised in phase 2 with a larger budget and caching.

### 6. Imagery only for visible tiles

A tile requests its texture when it is actually shown, not when its geometry
arrives. This avoids hundreds of useless texture uploads for hidden siblings.

### 7. GitHub Pages base path everywhere

`base: '/flightsimulator/'` is used in dev, preview and production so local
URLs match the deployed URL. The CI workflow builds and deploys the `dist`
artifact.

### 8. Arcade/einsteiger as the default flight mode

Product decision from the concept review: TFS should be fun within seconds.
Realistic physics is selectable, not mandatory. This does not affect phase 1,
but it guides the phase 2 flight model defaults.

## Known limitations

- No minimap or airport markers yet.
- No IndexedDB tile persistence yet (HTTP cache and an in-memory imagery LRU
  are active).
- LOD seams are visible at some tile borders.
- Only Switzerland and the border region have terrain coverage.
- No aircraft, avionics, weather or audio yet.
