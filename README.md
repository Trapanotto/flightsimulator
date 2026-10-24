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

## Entwickeln

```bash
npm install
npm run dev      # Entwicklungsserver
npm run lint     # ESLint
npm test         # Vitest
npm run build    # Produktions-Build nach dist/
```

Jeder Push auf `main` wird per GitHub Actions gebaut, getestet und auf GitHub Pages veröffentlicht.

## Credits & Lizenz

- Geodaten: © swisstopo (Bundesamt für Landestopografie), gestreamt über geo.admin.ch. Die Daten sind nicht Teil dieses Repos.
- Code: MIT, siehe [LICENSE](LICENSE). 3D-Modelle und Texturen: CC BY 4.0.
