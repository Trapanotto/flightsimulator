# Phase 6 – Regionstypische Gebäude und Bäume (Konzept-Ergänzung)

Stand 25.10.2026 · ersetzt Kapitel 7 des Hauptkonzepts (dort: swissBUILDINGS3D / swissTLM3D-Bäume)

## Entscheid

swisstopo liefert nur **wo** etwas steht und wie gross es ist; **wie** es aussieht, kommt aus
eigenen Blender-Modellen, passend zur Region. Damit sieht ein Engadiner Dorf anders aus als ein
Emmentaler Weiler oder ein Tessiner Nucleo.

## Daten (geo.admin.ch, Vektorkacheln `ch.swisstopo.base.vt`, CORS ok)

`https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/{z}/{x}/{y}.pbf` (Web Mercator, z14)

| Ebene                         | Nutzen                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| `building`                    | Grundriss-Polygon + `render_height` → Grösse, Ausrichtung, Höhe |
| `landcover` (`wood`/`forest`) | Waldflächen → Bäume streuen                                     |
| `landcover_pt` (`tree`)       | Einzelbäume (Obstgärten, Alleen)                                |
| `poi` (`place_of_worship`)    | Kirchen                                                         |
| `landuse`                     | Wohnen/Gewerbe/Industrie → Haustyp                              |

## Regionen und Gebäudetypen (Blender, prozedural wie das Flugzeug)

| Typ                           | Region / Regel                                                        | Merkmale                                                                  |
| ----------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Berner Bauernhaus             | Mittelland & Voralpen, ländlich, grosse Grundfläche                   | weisser Sockel, Holz-Obergeschoss, riesiges Walmdach mit Ründe            |
| Chalet                        | Berner Oberland, Freiburger/Waadtländer Alpen, Zentralschweiz > 700 m | dunkles Holz auf Steinsockel, flaches Satteldach, Balkone                 |
| Walliser Stadel / Holzhaus    | Wallis                                                                | dunkles Lärchenholz, Steinsockel, Steinplattendach                        |
| Engadiner Haus                | Graubünden (Engadin, Münstertal)                                      | dicke weisse Mauern, kleine Trichterfenster, Sgraffito, flaches Dach      |
| Tessiner Rustico              | Tessin, Misox, Bergell                                                | Bruchsteinmauern, Gneisplatten-Dach                                       |
| Tessiner / südliches Wohnhaus | Tessin, grössere Grundfläche                                          | Pastellputz, flaches Ziegeldach                                           |
| Mehrfamilienhaus / Altstadt   | städtisch (Höhe > 11 m oder `residential` dicht)                      | Putz, Fensterreihen, Ziegel- oder Flachdach                               |
| Halle / Gewerbe               | grosse Grundfläche, niedrig                                           | Flachdach, Blech                                                          |
| Kirche                        | `place_of_worship`                                                    | Schiff + Turm, Region bestimmt Turmform (Spitzhelm / Zwiebel / Campanile) |
| Schuppen / Garage             | < 40 m²                                                               | einfaches Pultdach                                                        |

Jeder Typ in Blender auf Normgrösse modelliert, ein gemeinsamer Textur-Atlas (Fassaden, Dächer,
Holz, Stein, Fenster) per numpy gebacken, 150–900 Dreiecke pro Haus. Im Spiel: InstancedMesh pro
Kachel und Typ, Grösse/Ausrichtung aus dem Grundriss (orientierte Bounding-Box), Farbvariation pro
Instanz.

## Bäume (Blender)

Fichte, Weisstanne, Lärche, Arve, Buche, Kastanie – Auswahl nach Höhe und Region
(Lärche/Arve hoch im Engadin/Wallis, Kastanie im Tessin, Buche im Mittelland).
Low-Poly ohne Alpha-Texturen (40–150 Dreiecke), dicht nur nahe der Kamera.

## Budget (Mittel)

Gebäude bis 3 km, Bäume bis 700 m, ≤ 60 zusätzliche Draw Calls, ≤ 600 000 zusätzliche Dreiecke.
Niedrig: nur Gebäude bis 1,5 km, keine Bäume. Hoch/Ultra: weiter und dichter.

## Teilschritte

- **6a** Blender-Gebäudeset + Atlas → `public/assets/buildings/buildings.glb`
- **6b** Vektorkacheln im Worker, Regionsregeln, Platzierung, Instancing
- **6c** Blender-Bäume + Wald/Einzelbäume
- **6d** HUD-Ausbau, Minimap, Startort-Suche (SearchServer)
