# Trapanotto Flight Simulator

Arcade-Flugsimulator im Browser über einer echten, gestreamten 3D-Schweiz.
Three.js · Geodaten von [geo.admin.ch](https://docs.geo.admin.ch/) (swisstopo) · Flugzeug aus Blender.

**Live:** https://trapanotto.github.io/flightsimulator/

## Stand

| Phase | Inhalt                                                | Status |
| ----- | ----------------------------------------------------- | ------ |
| 0     | Fundament: Projekt, CI, GitHub Pages, Startbildschirm | ✅     |
| 1     | Geo-Grundlagen & erstes Terrain                       | ⏳     |
| 2     | Streaming-Terrain (LOD, Floating Origin)              | ⏳     |
| 3     | Flugzeug aus Blender                                  | ⏳     |
| 4     | Flugmodell, Steuerung, Kameras                        | ⏳     |
| 5     | Grafik-Politur                                        | ⏳     |
| 6     | Gebäude, HUD & UI                                     | ⏳     |
| 7     | Gameplay & Audio                                      | ⏳     |
| 8     | Release 1.0                                           | ⏳     |

Das vollständige Konzept steht in [docs/KONZEPT.md](docs/KONZEPT.md).

## Was schon geht

- **Ganze Schweiz streamen:** Terrain (Quantized-Mesh) und SWISSIMAGE-Luftbilder direkt von geo.admin.ch,
  Detail nach Bildschirmfehler (Quadtree, Zoom 7–15), Vorausladen in Flugrichtung, Speicherbudget
- **Freie Flugkamera** mit Startorten (Genf, Bern, Zürich, Lauterbrunnen, Matterhorn, St. Moritz)
  und automatischem Testflug Genf → St. Moritz
- **Floating Origin:** keine Zitterbewegungen, egal wo man in der Schweiz ist
- **Höhe über Grund** aus einem Höhenraster pro Kachel; die Kamera kann nicht mehr durch Berge fliegen
- **Dynamische Auflösung:** wird es eng, rechnet das Spiel mit etwas weniger Pixeln
- Debug-Anzeige mit `F3` (oder `?debug` in der URL)

### Steuerung (freie Kamera)

| Aktion                     | Eingabe                                     |
| -------------------------- | ------------------------------------------- |
| Umschauen                  | Maus ziehen / Pfeiltasten                   |
| Vor / zurück / seitwärts   | W / S / A / D                               |
| Hoch / runter              | E oder Leertaste / Q                        |
| Schneller / langsamer      | Shift / Ctrl, Mausrad ändert das Grundtempo |
| Orte                       | 1–6                                         |
| Testflug Genf → St. Moritz | R                                           |
| Touch                      | Ziehen zum Umschauen, «Vorwärts»-Knopf      |

## Entwickeln

```bash
npm install
npm run dev      # Entwicklungsserver
npm run lint     # ESLint
npm test         # Vitest
npm run build    # Produktions-Build nach dist/
npm run test:route   # 2-Minuten-Testflug in headless Edge/Chrome, braucht laufenden Dev-Server auf Port 5180
```

Jeder Push auf `main` wird per GitHub Actions gebaut, getestet und auf GitHub Pages veröffentlicht.

## Credits & Lizenz

- Geodaten: © swisstopo (Bundesamt für Landestopografie), gestreamt über geo.admin.ch. Die Daten sind nicht Teil dieses Repos.
- Code: MIT, siehe [LICENSE](LICENSE). 3D-Modelle und Texturen: CC BY 4.0.
