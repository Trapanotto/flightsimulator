# Benchmark

Automatisch erzeugt mit `npm run benchmark` am 2026-10-24.

- GPU: ANGLE (Intel, Mesa Intel(R) Graphics (RPL-U), OpenGL ES 3.2)
- Auflösung: 1920×1080, Edge headless (echte GPU)
- Szene: Testflug Genf → Lausanne mit 500 km/h, Goldene Stunde, heiter; 60 s Messung nach 12 s Aufwärmen
- «Auflösung» ist der Mittelwert der dynamischen Auflösung (Anteil der vollen Pixelzahl je Achse)

| Stufe  | Ø FPS | 10 % der Sekunden unter | Ø Auflösung | Ø Kacheln | Längster Frame | Detail min. |
| ------ | ----- | ----------------------- | ----------- | --------- | -------------- | ----------- |
| low    | 51.6  | 48 FPS                  | 61 %        | 83        | 67 ms          | 98 %        |
| medium | 51.7  | 44 FPS                  | 60 %        | 136       | 50 ms          | 99 %        |
| high   | 47.8  | 40 FPS                  | 60 %        | 206       | 67 ms          | 98 %        |
| ultra  | 38.1  | 30 FPS                  | 60 %        | 288       | 83 ms          | 75 %        |

Bei diesem Lauf liefen im Hintergrund weitere Programme mit GPU-Last (Microsoft Edge und die
OpenCode-Desktop-App, zusammen ~45 % CPU in ihren GPU-Prozessen, Systemlast ~5). Darum erreicht
auch «Niedrig» keine 60 FPS; am selben Morgen lief derselbe Testflug ohne diese Programme mit
60 FPS bei voller Auflösung (Phase 2). Für die Abstufung zwischen den Presets sind die Werte
trotzdem aussagekräftig, weil alle im selben Lauf gemessen wurden.

Hinweis: Laptops drosseln je nach Energiemodus und Temperatur. Vergleichbar sind Werte aus
demselben Lauf; zwischen Läufen an verschiedenen Tagen können sie um 10–20 % schwanken.
