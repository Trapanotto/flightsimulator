# Trapanotto Flight Simulator

> **Die Schweiz aus der Luft.** Ein browserbasierter Flugsimulator mit echten
> swisstopo-Geodaten, Three.js und Blender-Assets. Kein Download, kein Launcher
> — ein Link genügt.

[![Status](https://img.shields.io/badge/status-Konzept-brightgreen)](#status)
[![Plattform](https://img.shields.io/badge/platform-WebGL2-blue)](#technik)
[![Lizenz](https://img.shields.io/badge/code-MIT-lightgrey)](#lizenz)

---

## Status

**Phase 0 — Konzept abgeschlossen.** Die vollständige Produkt- und
Technikspezifikation steht in **[KONZEPT.md](./KONZEPT.md)**.

| Phase | Inhalt | Status |
|---|---|---|
| 0 | Konzept, Datenquellen, Architektur | ✅ |
| 1 | Fundament & Welt (Terrain, Orthofotos, Streaming) | ⏳ |
| 2 | Flugzeug & Flugmodell | ⏳ |
| 3 | Cockpit & Avionik | ⏳ |
| 4 | Flugplätze & Szenerie | ⏳ |
| 5 | Wetter & Atmosphäre | ⏳ |
| 6 | UX & Missionen | ⏳ |
| 7 | Polish & Launch v1.0 | ⏳ |

Geplant: **https://trapanotto.github.io/flightsimulator/**

---

## Vision

In 20 Sekunden auf der Piste in Zürich stehen, abheben und entlang des
Zürichsees Richtung Alpen fliegen — mit echtem Höhenmodell, echten
Orthofotos und einem glaubwürdigen Flugmodell. Im Browser.

Mehr dazu: **[KONZEPT.md](./KONZEPT.md)**

---

## Technik

- **Three.js** (WebGL2) für Rendering und Szene
- **TypeScript + Vite** für Entwicklung und Build
- **swissALTI3D Terrain** als Cesium Quantized Mesh
- **SWISSIMAGE** als WMTS-Orthofotos
- **swissBUILDINGS3D** als 3D Tiles
- **Blender 5.2** für Flugzeug, Texturen und Wolken
- **Web Audio API** für synthetischen Sound
- **GitHub Pages** für Deployment

Alle Geodaten werden zur Laufzeit direkt vom Browser gestreamt. Es gibt
keinen eigenen Backend-Server.

---

## Datenquellen und Attribution

| Quelle | Verwendung | Lizenz |
|---|---|---|
| [swisstopo](https://www.swisstopo.admin.ch) | Terrain, Orthofotos, Gebäude | OGD, Quellenangabe |
| [OpenStreetMap](https://www.openstreetmap.org) | Rollwege, Seen, Landmarken | ODbL |
| [OurAirports](https://ourairports.com) | Pisten, Frequenzen | Public Domain |
| [Open-Meteo](https://open-meteo.com) | Live-Wetter | CC BY 4.0 |

**© swisstopo** · **© OpenStreetMap contributors** · Weather data by Open-Meteo.com

Dieses Projekt steht in keiner Verbindung zu Microsoft oder Microsoft Flight
Simulator. Es ist ein unabhängiges Open-Source-Projekt.

---

## Entwicklung

> Das Projekt befindet sich in Phase 0. Der Entwicklungsstart erfolgt mit
> Phase 1. Die folgenden Befehle werden mit dem ersten Code-Commit aktiv.

```bash
npm install
npm run dev      # lokaler Entwicklungsserver
npm run build    # Produktionsbuild
npm run test     # Unit-Tests
```

---

## Lizenz

- Code: MIT (finale Bestätigung ausstehend)
- Eigene Assets: CC BY 4.0 (finale Bestätigung ausstehend)
- swisstopo-Daten: Nutzungsbedingungen von swisstopo
- OpenStreetMap: ODbL
- Open-Meteo: CC BY 4.0

---

**Nächster Meilenstein:** Phase 1 — Terrain-Streaming, Orthofotos und
fliegende Kamera über der Schweiz.
