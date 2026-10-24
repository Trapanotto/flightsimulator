# Attribution and data licences

Trapanotto Flight Simulator is an independent open-source project. It is not
affiliated with Microsoft or Microsoft Flight Simulator.

## Runtime geodata

### swisstopo

- **swissALTI3D** terrain, served as Cesium quantized-mesh tiles:
  `https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/`
- **SWISSIMAGE** orthophotos, served via WMTS:
  `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage-product/`
- **swissBUILDINGS3D**, **swissTLM3D**, **swissNAMES3D**, vegetation:
  `https://3d.geo.admin.ch/ch.swisstopo.*.3d/` (planned)

**© swisstopo** — Bundesamt für Landestopografie.
Data is used under the swisstopo open-government-data terms. Attribution is
shown permanently in the application. The data is streamed at runtime and is
not redistributed as part of this repository, except for one small decoder
test fixture (`tests/fixtures/zurich-z14.terrain`).

- https://www.swisstopo.admin.ch
- https://www.geo.admin.ch

### OpenStreetMap

Planned for taxiways, water polygons and landmarks. **© OpenStreetMap
contributors**, available under the Open Database License (ODbL).

### OurAirports

Planned for runway and frequency data. Public domain.

### Open-Meteo

Planned for live weather. **Weather data by Open-Meteo.com**, CC BY 4.0.

## Software

- [Three.js](https://threejs.org) — MIT
- [proj4js](https://github.com/proj4js/proj4js) — MIT
- [Vite](https://vite.dev) — MIT
- [Vitest](https://vitest.dev) — MIT
- [TypeScript](https://www.typescriptlang.org) — Apache-2.0

## Original assets

Aircraft models, textures, sounds and UI artwork created specifically for this
project are original works. They will be released under CC BY 4.0 unless a
file states otherwise. The aircraft type is a fictional "TFS-172" inspired by
the Cessna 172 class; no manufacturer logos or trademarks are used.

## Disclaimer

This is a game/simulator, not a certified training device. Do not use it for
real-world flight preparation. Always follow official aviation regulations.
