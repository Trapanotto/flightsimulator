# Trapanotto Flight Simulator – Konzept

> Arcade-Flugsimulator im Browser über einer echten, gestreamten 3D-Schweiz.
> Three.js · Daten von geo.admin.ch (swisstopo) · Assets aus Blender · gehostet auf GitHub Pages.

Version 1.0 · 24.10.2026 · Status: **zur Freigabe**

---

## 0. Inhalt

1. Vision & Leitprinzipien
2. Zielplattformen & Performance-Budget
3. Datenquellen geo.admin.ch (verifiziert)
4. Systemarchitektur
5. Koordinatensysteme & Präzision
6. Terrain-Engine (Streaming, LOD, Texturierung)
7. Gebäude & Vegetation
8. Rendering & Grafik-Features
9. Flugmodell (Arcade)
10. Flugzeug: Blender-Modellierung & Texturen
11. Kameras
12. Steuerung & Eingabegeräte
13. HUD, UI & Menüs
14. Gameplay & Spielmodi
15. Audio
16. Qualitätsstufen & adaptive Performance
17. Projektstruktur & Tooling
18. Build, CI & Deployment (GitHub Pages)
19. Lizenz, Attribution & Fair Use
20. Risiken & Gegenmassnahmen
21. Umsetzungsplan (Phasen mit Abnahmekriterien)
22. Offene Entscheidungen

---

## 1. Vision & Leitprinzipien

**Vision:** Man öffnet eine URL, wählt einen Startort (z. B. Flugplatz Bern-Belp oder «Matterhorn») und fliegt innerhalb von Sekunden mit einem selbst modellierten Flugzeug durch fotorealistische Alpentäler – mit echtem Höhenmodell, echten Luftbildern und echten Gebäuden der Schweiz.

**Leitprinzipien**

| #   | Prinzip                                | Konsequenz                                                                                                                                       |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | **Arcade vor Simulation**              | Flugzeug fliegt sich «wie im Film»: direkte Reaktion, kein Strömungsabriss-Frust, kein Checklisten-Start.                                        |
| P2  | **Performance ist ein Feature**        | 60 FPS auf integrierter Grafik (Intel UHD, Klasse deines Laptops) in Stufe _Mittel_ bei 1080p. Jede Grafik-Funktion hat Budget und Abschaltpfad. |
| P3  | **Beeindruckend auf den ersten Blick** | Atmosphäre, Licht, Wolken, Weitsicht. Lieber wenige, aber starke Effekte.                                                                        |
| P4  | **Reine Static Site**                  | Kein eigener Server. Alles läuft im Browser, Daten kommen direkt von geo.admin.ch (CORS `*` verifiziert).                                        |
| P5  | **Reproduzierbare Assets**             | Blender-Modell und Texturen entstehen per Python-Skript (`blender -b -P …`), damit jede Änderung nachvollziehbar und neu baubar ist.             |
| P6  | **Schritt für Schritt lieferbar**      | Jede Phase endet mit einer lauffähigen, auf GitHub Pages veröffentlichten Version.                                                               |

---

## 2. Zielplattformen & Performance-Budget

**Zielplattformen**

- Desktop: Chrome, Edge, Firefox, Safari (aktuelle Versionen) – Hauptziel
- Mobile/Tablet: Chrome Android, Safari iOS – spielbar in Stufe _Niedrig_, Touch-Steuerung
- Renderer: **WebGL 2** (Standard, breiteste Kompatibilität). WebGPU als späteres Experiment, nicht Voraussetzung.

**Referenzhardware:** Intel UHD Graphics (Raptor Lake), 8 Kerne, 14 GB RAM → Stufe _Mittel_ @ 1080p ≥ 60 FPS.

**Budget pro Frame (Stufe Mittel)**

| Kennzahl                                   | Budget                                          |
| ------------------------------------------ | ----------------------------------------------- |
| Frametime                                  | ≤ 16,6 ms (GPU ≤ 12 ms, CPU-Hauptthread ≤ 6 ms) |
| Draw Calls                                 | ≤ 250                                           |
| Dreiecke                                   | ≤ 1,5 Mio.                                      |
| GPU-Texturspeicher                         | ≤ 400 MB                                        |
| JS-Heap                                    | ≤ 350 MB                                        |
| Gleichzeitige Netz-Requests                | ≤ 10                                            |
| Erster spielbarer Frame                    | ≤ 5 s bei 50 Mbit/s                             |
| Initial-Download (JS+Assets ohne Geodaten) | ≤ 4 MB (gzip/brotli)                            |

---

## 3. Datenquellen geo.admin.ch (am 24.10.2026 verifiziert)

Alle Endpunkte liefern `Access-Control-Allow-Origin: *` und sind damit direkt aus GitHub Pages nutzbar.

| Zweck                     | Dienst                             | URL-Muster                                                                                                       | Format                                                                                          |
| ------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Höhenmodell (Terrain)** | `ch.swisstopo.terrain.3d`          | `https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/20250101/{z}/{x}/{y}.terrain?v=1.43646.0` (aus `layer.json`) | Quantized-Mesh 1.0, EPSG:4326, TMS-Schema, Zoom 0–18, Extensions `octvertexnormals`, `metadata` |
| **Luftbild (Textur)**     | `ch.swisstopo.swissimage`          | `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg`                  | JPEG 256 px, EPSG:3857, bis Zoom ~20 (≈10–25 cm/px)                                             |
| **Landeskarte (Minimap)** | `ch.swisstopo.pixelkarte-farbe`    | `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg`            | JPEG 256 px                                                                                     |
| **Gebäude 3D**            | `ch.swisstopo.swissbuildings3d.3d` | `https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json`                                       | Cesium 3D Tiles 1.0 (b3dm), `refine: ADD`                                                       |
| **Vegetation/TLM 3D**     | `ch.swisstopo.swisstlm3d.3d`       | `https://3d.geo.admin.ch/ch.swisstopo.swisstlm3d.3d/v1/tileset.json`                                             | 3D Tiles (Bäume, Objekte)                                                                       |
| **Punkthöhe**             | REST `height`                      | `https://api3.geo.admin.ch/rest/services/height?easting=…&northing=…` (LV95)                                     | JSON `{"height":"555.5"}`                                                                       |
| **Ortssuche**             | REST `SearchServer`                | `https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=…&type=locations`                           | JSON                                                                                            |
| **Kachel-Metadaten**      | WMTS Capabilities                  | `https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml`                                                 | XML                                                                                             |
| (optional) Rohdaten Höhe  | STAC `swissalti3d`                 | `https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d`                                   | COG GeoTIFF 0,5 m / 2 m – nur für Offline-Vorverarbeitung, nicht zum Streamen                   |

**Hinweis:** Die Terrain-URL enthält einen Zeitstempel (`20250101`) und eine Version. Sie wird **zur Laufzeit aus `layer.json` gelesen**, nie hart codiert – sonst bricht das Spiel bei einem Datenupdate von swisstopo.

**Abdeckung:** Volle Detailtiefe nur in der Schweiz + Grenzgebiet. Ausserhalb: grobes Terrain, keine Luftbilder → das Spielgebiet wird auf die Bounding-Box Schweiz (LV95 2'480'000–2'840'000 / 1'070'000–1'300'000) begrenzt, mit weichem «Umkehren»-Hinweis am Rand.

---

## 4. Systemarchitektur

```
┌──────────────────────────── Hauptthread ────────────────────────────┐
│  Game Loop (fixed-step Physik 120 Hz, variabler Render-Schritt)     │
│   ├─ Input-System (Tastatur/Maus/Gamepad/Touch → Achsen 0..1)       │
│   ├─ Flugmodell (Arcade)                                             │
│   ├─ Kamera-System                                                   │
│   ├─ World/Origin-Manager (Floating Origin)                         │
│   ├─ Terrain-Quadtree (LOD-Entscheid, Sichtbarkeit)                 │
│   ├─ Tiles-Manager Gebäude (3D Tiles)                                │
│   ├─ Renderer (Three.js WebGLRenderer + Post-Processing)            │
│   ├─ HUD/UI (DOM + CSS, kein Framework)                              │
│   └─ Audio (WebAudio, prozedural)                                    │
└───────────────▲───────────────────────────────────▲──────────────────┘
                │ Transferables (ArrayBuffer,       │
                │ ImageBitmap)                      │
┌───────────────┴──────────┐   ┌────────────────────┴─────────────────┐
│ Worker-Pool «Terrain»    │   │ Worker-Pool «Bilder»                  │
│ (N = Kerne-2, max 4)     │   │ (OffscreenCanvas)                     │
│ - fetch .terrain         │   │ - fetch WMTS-JPEGs                    │
│ - Quantized-Mesh dekod.  │   │ - Reprojektion 3857 → Kachel-UV       │
│ - ECEF → lokal (ENU)     │   │ - Komposition zu 512² Kacheltextur    │
│ - Normalen, Skirts       │   │ - Mipmaps / ImageBitmap               │
│ - Höhenraster für        │   │                                       │
│   Kollision (65×65)      │   │                                       │
└──────────────────────────┘   └───────────────────────────────────────┘
                │
        ┌───────┴────────┐
        │ Netzwerk-Layer │  Prioritäts-Queue, max. 10 parallel, AbortController
        │                │  für veraltete Anfragen, LRU-Cache (RAM) + Cache API
        └────────────────┘
```

**Module (TypeScript)**

| Modul                 | Aufgabe                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `core/Loop`           | Fixed-Timestep-Physik, Interpolation für Rendering, Pause/Resume bei Tab-Wechsel |
| `core/Events`         | Typisierter Event-Bus (Crash, Checkpoint, Settings geändert …)                   |
| `geo/Projection`      | WGS84 ↔ LV95 ↔ ECEF ↔ lokales ENU, Web-Mercator-Kachelmathematik                 |
| `net/RequestQueue`    | Priorisierte Fetch-Queue, Abbruch, Retry mit Backoff, Statistik                  |
| `terrain/*`           | Quadtree, Kachel-Lifecycle, Mesh-Erzeugung, Material, Höhenabfrage               |
| `buildings/*`         | 3D-Tiles-Anbindung, Shading der Gebäude                                          |
| `render/*`            | Renderer-Setup, Himmel, Wolken, Nebel, Post-FX, Schatten                         |
| `aircraft/*`          | GLB-Laden, Animation der Ruder/Propeller, Effekte (Kondensstreifen)              |
| `physics/FlightModel` | Arcade-Flugmodell, Boden-Kollision                                               |
| `camera/*`            | Verfolger-, Cockpit-, Flügel-, Orbit-, Kinokamera                                |
| `input/*`             | Geräte-Abstraktion, Belegung, Empfindlichkeit                                    |
| `ui/*`                | Startbildschirm, Ladeanzeige, HUD, Minimap, Einstellungen                        |
| `audio/*`             | Motor, Wind, UI-Sounds                                                           |
| `game/*`              | Spielmodi, Startorte, Ringe, Zeitmessung, Highscores (localStorage)              |

---

## 5. Koordinatensysteme & Präzision

Das zentrale technische Problem: Die Schweiz ist ~350 km breit, die GPU rechnet in 32-Bit-Float (≈7 Stellen). Bei 300'000 m Koordinate bleibt nur ~3 cm Auflösung → Zittern («Jitter»).

**Lösung: Floating Origin in einem lokalen Tangentialsystem (ENU)**

1. Alle Geodaten werden im Worker in **ECEF (Double, JS-Number = 64 Bit)** berechnet.
2. Es gibt einen **Welt-Ursprung O** (ECEF + Rotationsmatrix ENU). Vertices werden relativ zu O **und** relativ zum Kachelzentrum gespeichert (Float32), die Kachel selbst bekommt ihre Position relativ zu O.
3. Entfernt sich das Flugzeug > 5 km von O, wird O neu gesetzt und alle Objekt-Positionen werden verschoben (eine Matrix-Operation pro Kachel, unsichtbar für den Spieler).
4. **Erdkrümmung** ist dadurch automatisch korrekt (Alpen hinter dem Horizont verschwinden realistisch).
5. Achsen in Three.js: X = Ost, Y = Oben, Z = −Nord (Three.js-Konvention Y-up).

**Tiefenpuffer:** Sichtweite bis 150 km bei Nah-Ebene 0,5 m. `logarithmicDepthBuffer` kostet Performance (deaktiviert Early-Z) → stattdessen **Reversed-Z** (`reversedDepthBuffer`, in aktuellem Three.js via `EXT_clip_control`), Fallback auf logarithmisch, wenn die Extension fehlt.

**Projektionen:**

- WGS84 ↔ LV95: offizielle swisstopo-Näherungsformeln (Genauigkeit ~1 m, reicht für Spiel & API-Aufrufe).
- WGS84 ↔ ECEF: exakt (GRS80/WGS84-Ellipsoid).
- Höhen: Terrain liefert ellipsoidische bzw. orthometrische Höhen → Abgleich einmalig mit `height`-API am Startort; Anzeige im HUD in m ü. M.

---

## 6. Terrain-Engine

### 6.1 Variante & Entscheid

| Variante | Beschreibung                                                                               | Pro                                                   | Contra                                             |
| -------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------- |
| A        | Bibliothek **3d-tiles-renderer** (NASA-AMMOS) mit Quantized-Mesh- und Bild-Overlay-Plugins | schnell umgesetzt, erprobt                            | weniger Kontrolle über Shader, Kollision, Speicher |
| B        | **Eigene Terrain-Engine** (Quadtree + Worker-Decoder)                                      | volle Kontrolle über Performance, Material, Kollision | ~1–2 Wochen mehr Aufwand                           |

**Empfehlung:** In Phase 2 einen 1-tägigen **Spike mit Variante A**. Erreicht er das Budget aus Kapitel 2 und lässt sich die Höhenabfrage für die Kollision sauber anbinden → A. Sonst B (unten detailliert beschrieben, das ist auch der Plan, falls A Einschränkungen hat). Für **Gebäude** wird in jedem Fall 3d-tiles-renderer genutzt (b3dm-Parser selbst zu schreiben lohnt nicht).

### 6.2 Quadtree & LOD (Variante B)

- Wurzel: die zwei TMS-Kacheln Zoom 0 (EPSG:4326 hat 2×1 Wurzelkacheln). Praktisch startet der Baum bei Zoom 7 über der Schweiz (~ 6 Kacheln).
- **Verfeinerungskriterium – Screen Space Error (SSE):**
  `SSE = geometricError(z) × screenHeight / (2 × distance × tan(fov/2))`
  Kachel wird geteilt, wenn `SSE > τ` (τ = 2 px Ultra … 8 px Niedrig).
  `geometricError(z)` aus Kachelgrösse: ≈ `kachelbreite_m / 65`.
- Max. Zoom: 17 (Ultra) / 16 (Hoch) / 15 (Mittel) / 13 (Niedrig).
- **Frustum-Culling** per Bounding-Sphere aus dem Quantized-Mesh-Header (liegt schon im Datenformat).
- **Horizon-Culling** über den `horizonOcclusionPoint` aus dem Header (ebenfalls im Format enthalten) → Kacheln hinter Bergen/Erdkrümmung werden nicht gezeichnet.
- **Vorausladen** in Flugrichtung: Prioritätswert = SSE × (1 + 0,5 × max(0, cos(Winkel zur Flugrichtung))).
- Eltern bleiben sichtbar, bis alle 4 Kinder geladen sind → keine Löcher.
- **Risse zwischen LODs:** Skirts (vertikale Ränder, 1 % der Kachelbreite nach unten), ohne Geometrie-Stitching.
- **Geomorphing** (optional Ultra): Vertex-Shader blendet Höhen beim LOD-Wechsel über 0,3 s, verhindert «Ploppen».

### 6.3 Dekodierung Quantized-Mesh (Worker)

1. Header (88 Byte): Zentrum ECEF, Min/Max-Höhe, Bounding-Sphere, Horizon-Occlusion-Point.
2. Vertexdaten u/v/h (zickzack + delta-kodierte Uint16) → Längen-/Breitengrad/Höhe → ECEF → lokal relativ Kachelzentrum.
3. Indices (High-Water-Mark-kodiert), 16- oder 32-Bit.
4. Randvertices (West/Süd/Ost/Nord) → Skirts.
5. Extension `octvertexnormals` → Normalen (oct-dekodiert), spart Normalenberechnung.
6. Zusätzlich: **Höhenraster 33×33** pro Kachel (aus Dreiecken gerastert) für schnelle Kollisions- und AGL-Abfragen auf dem Hauptthread.
7. Rückgabe als Transferables (kein Kopieren).

### 6.4 Texturierung (das knifflige Detail)

Terrain-Kacheln sind in **EPSG:4326**, Luftbilder in **EPSG:3857**. Gleicher Längengrad-Ausschnitt, aber die Breitengrade sind nicht linear verteilt.

**Lösung:** Pro Terrain-Kachel erzeugt der Bild-Worker **eine eigene 512×512-Textur**:

1. Ermitteln, welche WMTS-Kacheln (Zoom = Terrain-Zoom + 2, gekappt bei 19) die Kachel abdecken (typ. 4–9 JPEGs).
2. JPEGs per `fetch` → `createImageBitmap` (Dekodierung off-thread).
3. Auf `OffscreenCanvas` zeilenweise (in 32 Streifen) reprojizieren: Für jeden Streifen wird die Mercator-y-Spanne berechnet und gestreckt gezeichnet → Fehler < 0,1 px.
4. Ergebnis als `ImageBitmap` an den Hauptthread → `THREE.Texture` mit Mipmaps, anisotroper Filterung (4×/8×).
5. Fehlt ein Luftbild (Grenzgebiet), wird die Textur des Elternknotens hochskaliert verwendet.

**Vorteil:** Ein Material/eine Textur pro Kachel, UV einfach (lineare u/v aus dem Quantized-Mesh), keine Shader-Tricks.

### 6.5 Terrain-Shader (eigenes `ShaderMaterial` bzw. `onBeforeCompile` auf `MeshStandardMaterial`)

- Basisfarbe: Luftbild, leicht entsättigt + farbkorrigiert (Luftbilder haben eingebackene Schatten; Gegensteuern durch reduzierten Direktlicht-Anteil).
- **Detail-Textur** im Nahbereich (< 2 km): kachelbare Fels/Gras/Schnee-Detailnormalen, gemischt nach Hangneigung und Höhe → verhindert Matsch bei Tiefflug.
- **Schnee-Boost** über 2'800 m (heller, leicht glänzend).
- **Atmosphärische Perspektive** (siehe 8.3) im selben Shader.
- Seen: Erkennung über Farbe+Flachheit im Shader ist unzuverlässig → in Phase 7 optional Wassermaske aus swissTLM3D; bis dahin Seen nur aus Luftbild.

### 6.6 Speicher & Cache

- LRU-Cache: max. 600 Kacheln (Mittel) inkl. Texturen; Kacheln ausserhalb Sicht > 30 s → Kandidaten zum Entsorgen (`geometry.dispose()`, `texture.dispose()`).
- Netzwerk: zusätzlich **Service Worker mit Cache API** für `.terrain` und WMTS (max. 300 MB, LRU), damit der zweite Flug am selben Ort sofort lädt.
- Ladeziel beim Start: zuerst grobe Kacheln (Zoom 9–11) für die Fernsicht, dann Detail um das Flugzeug.

### 6.7 Höhenabfrage & Kollision

`terrain.heightAt(x, z)` → findet die feinste geladene Kachel, bilineare Interpolation im 33×33-Raster. Kosten < 1 µs. Genutzt für: Kollision, AGL-Anzeige, Kameras (nicht unter den Boden), Ringplatzierung, Startposition.

---

## 7. Gebäude & Vegetation

- **swissBUILDINGS3D** über 3d-tiles-renderer, eigene Kopplung an den Floating Origin (Tileset-Gruppe wird mit Ursprung verschoben).
- Gebäude werden **erst unter 4'000 m über Grund** und in einem Radius von ~6 km geladen (Fliegen über Städte ist der «Wow»-Moment, in 5 km Höhe sieht man sie eh kaum).
- Shading: Dächer rötlich/grau variiert per Hash der Position, Wände hell; ambient occlusion per Vertex-Farbe (falls im Datensatz), sonst einfacher Höhen-Gradient. Fenster-Emission nachts (prozedural im Shader).
- **Vegetation:** swissTLM3D 3D-Tiles für Bäume prüfen (Phase 7). Fallback: Instanced Billboards/Impostors in Waldflächen (aus Luftbild-Grünton + Hangneigung abgeleitet), nur < 1,5 km Distanz, Stufe Hoch/Ultra.
- Budget Gebäude: ≤ 80 Draw Calls, ≤ 500k Dreiecke.

---

## 8. Rendering & Grafik-Features

Reihenfolge nach Wirkung/Kosten. Jede Zeile hat eine Abschaltstufe.

| Feature                    | Technik                                                                                                                                                                         | Kosten              | Ab Stufe           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------ |
| Tonemapping                | AgX (bzw. ACES), sRGB-Output, HDR-Pipeline (HalfFloat)                                                                                                                          | sehr gering         | Niedrig            |
| Physikalischer Himmel      | Rayleigh/Mie-Streuung (Three.js `Sky`-Shader erweitert), Sonnenstand nach echter Uhrzeit & Ort                                                                                  | gering              | Niedrig            |
| Atmosphärische Perspektive | Distanz- und höhenabhängiger Nebel mit Himmelsfarbe in Blickrichtung (Inscattering-Näherung)                                                                                    | gering              | Niedrig            |
| Image-Based Lighting       | Himmel → PMREM-Environment-Map, alle 2 s bei Sonnenänderung aktualisiert                                                                                                        | gering              | Niedrig            |
| Wolken                     | **Ebene 1:** 2D-Wolkenschicht (Noise-Shader, scrollend, mit Schatten auf Terrain). **Ebene 2:** volumetrische Wolken per Raymarching in ¼-Auflösung mit temporaler Reprojektion | E1 gering / E2 hoch | E1 Mittel, E2 Hoch |
| Schatten                   | Shadow-Map nur für Flugzeug + Nahbereich (Kaskade 1–2, 2048²)                                                                                                                   | mittel              | Mittel             |
| Bloom                      | Mip-Chain-Bloom (Sonne, Lichter, Wasserreflexe)                                                                                                                                 | gering-mittel       | Mittel             |
| Lens Flare                 | Sprite-basiert bei Blick in die Sonne, Okklusionstest per Tiefe                                                                                                                 | gering              | Mittel             |
| Kondensstreifen & Rauch    | Instanzierte Partikel / Ribbon-Trails an den Flügelspitzen bei hoher G-Last                                                                                                     | gering              | Mittel             |
| Motion Blur Propeller      | Propeller-Disk-Shader statt Geometrie bei hoher Drehzahl                                                                                                                        | sehr gering         | Niedrig            |
| Antialiasing               | SMAA (Post) bzw. MSAA 4× wenn kein Post-FX                                                                                                                                      | gering-mittel       | Mittel             |
| Farbkorrektur/Vignette     | LUT-Pass                                                                                                                                                                        | sehr gering         | Mittel             |
| Tag/Nacht                  | Sonne, Mond, Sterne, Gebäudelichter, Landeslichter                                                                                                                              | gering              | Hoch               |
| SSAO                       | GTAO halbe Auflösung                                                                                                                                                            | hoch                | Ultra              |
| Hitzeflimmern Auspuff      | Distortion-Pass lokal                                                                                                                                                           | gering              | Hoch               |

**Post-Processing-Kette:** `pmndrs/postprocessing` (verbindet Effekte zu wenigen Passes → schneller als Three.js-EffectComposer).

**Optisches Ziel:** «Golden Hour über dem Lauterbrunnental» als Referenzbild für Look-Entwicklung; Standard-Startzeit = Echtzeit, im Menü wählbar.

---

## 9. Flugmodell (Arcade)

**Ziel:** Eingängig wie _Ace Combat_ / _Pilotwings_, aber mit spürbarem Gewicht.

**Zustand:** Position (Double), Orientierung (Quaternion), Geschwindigkeitsvektor, Winkelgeschwindigkeit, Schub (0–1), Fahrwerk, Klappen.

**Kräfte (vereinfacht, pro Physikschritt 1/120 s):**

```
v_vorwärts   = dot(velocity, nose)
Schub        = throttle × T_max  (+ Boost × 1.6 für max. 5 s, lädt nach)
Widerstand   = c_d × v² (+ Fahrwerk/Klappen-Zuschlag)
Auftrieb     = c_l(α) × v² senkrecht zu velocity, in Flügelebene
               c_l(α) linear bis 15°, dann sanft abflachend (kein harter Stall)
Schwerkraft  = 9.81 m/s²
Ausrichtung  = velocity wird mit Rate k(v) in Richtung Nase gezogen
               («Arcade-Grip»: verhindert seitliches Rutschen)
```

**Steuerung:**

- Roll-, Nick-, Gierrate direkt aus Eingabe × Maximalrate × Wirksamkeit(v) (wenig wirksam bei langsamer Fahrt).
- **Auto-Koordination:** Bei Querneigung wird automatisch Gier hinzugefügt → saubere Kurven ohne Seitenruder.
- **Assistenzstufen:** _Einfach_ (Auto-Horizont bei losgelassenem Stick, Bodenschutz-Warnung), _Normal_, _Pro_ (keine Hilfen, Stall stärker).
- Kennwerte (Startflugzeug): v_min 30 m/s, Reise 80 m/s, max 140 m/s (Boost 170), Steigrate max 15 m/s, Rollrate 180°/s.

**Boden:**

- Kollision: Flugzeug-Hülle als 5 Punkte (Nase, Flügelspitzen, Heck, Fahrwerk) gegen `heightAt`, plus Gebäude per Bounding-Box-Raycast (nur nahe Kacheln).
- Landung erlaubt bei Sinkrate < 4 m/s, Querneigung < 10°, Fahrwerk unten → Rollen mit Bodenreibung, Bremse.
- Crash: Explosions-/Staubpartikel, Kamera-Zeitlupe 1 s, Neustart am letzten Checkpoint oder in der Luft über dem Crashpunkt.

**Wind & Turbulenz** (optional, Phase 7): leichte Böen per Perlin-Noise, stärker in Lee von Bergkämmen.

---

## 10. Flugzeug: Blender-Modellierung & Texturen

### 10.1 Design

Eigenes, markenfreies Design: **«Trapanotto TR-1 Alpenfalke»** – einmotoriger Turboprop-Trainer (Proportionen ähnlich moderner Schulungsflugzeuge), Tandem-Cockpit, Tiefdecker, Einziehfahrwerk. Lackierung: Weiss/Rot mit Schweizer Akzenten und Schriftzug «TRAPANOTTO» am Rumpf, Kennzeichen «HB-TRP».

### 10.2 Pipeline (vollständig per Skript, Blender 5.2 headless)

```
tools/blender/
  build_aircraft.py     # erzeugt Geometrie prozedural (Rumpf über Spantkurven,
                        #   Flügel über Profil-Extrusion NACA 2412, Leitwerk, Propeller,
                        #   Cockpithaube, Fahrwerk, Ruderflächen als eigene Objekte)
  uv_and_bake.py        # Smart-UV + manuelle Seams, Bake: AO, Normal (High→Low),
                        #   Curvature, ID-Map
  texture_livery.py     # Lackierung: Base Color, Metallic/Roughness, Decals (Text,
                        #   Kennzeichen, Warnhinweise), Schmutz/Abnutzung über AO+Curvature
  export_glb.py         # glTF 2.0 Export, Pivots für Animation, LODs, Validierung
```

Aufruf: `npm run assets` → `blender -b -P tools/blender/build_all.py` → `public/assets/aircraft/tr1.glb`.

### 10.3 Geometrie & LOD

| LOD  | Dreiecke | Einsatz                                |
| ---- | -------- | -------------------------------------- |
| LOD0 | ~25'000  | Cockpit-/Nahansicht, Hangar-Menü       |
| LOD1 | ~8'000   | Verfolgerkamera                        |
| LOD2 | ~1'500   | > 200 m (Replays, KI-Flugzeuge später) |

**Separate Nodes mit korrektem Drehpunkt:** Querruder L/R, Höhenruder, Seitenruder, Klappen, Propeller, Propeller-Disk (Blur), Fahrwerk (3 Beine + Klappen), Cockpithaube, Steuerknüppel, Instrumentenzeiger (Cockpit).

### 10.4 Texturen (PBR, Metallic-Roughness)

| Textursatz    | Auflösung      | Inhalt                                                                 |
| ------------- | -------------- | ---------------------------------------------------------------------- |
| Rumpf/Flügel  | 2048²          | BaseColor (Lack + Decals), ORM (AO/Roughness/Metallic gepackt), Normal |
| Cockpit innen | 1024²          | Instrumente, Sitze, Panels                                             |
| Glas          | –              | `MeshPhysicalMaterial` mit Transmission/Reflexion (kein Bild nötig)    |
| Detail        | 512² kachelbar | Nieten/Blechstösse als Detailnormal                                    |

- Komprimierung: **KTX2 (Basis Universal UASTC für Normals, ETC1S für Farbe)** via `gltf-transform` → ~4× weniger GPU-Speicher, schneller Upload.
- Geometrie: **Meshopt**-Kompression (schneller Dekoder als Draco).
- Ziel-Grösse `tr1.glb` inkl. Texturen: ≤ 2,5 MB.

### 10.5 Weitere Blender-Assets

- **Ringe** für Challenge-Modus (Glas-/Neon-Ring, 1 Draw Call per Instancing)
- **Windsack, Pistenmarkierungen, Hangar** für Startflugplätze
- **Detail-Texturen fürs Terrain** (Fels, Gras, Schnee – prozedural in Blender gebacken, kachelbar, 512²)
- **Startbildschirm-Rendering**: Cycles-Render des Flugzeugs über Alpen als Hintergrundbild/Social-Preview (`og:image`)

---

## 11. Kameras

| Kamera               | Taste        | Verhalten                                                                                                         |
| -------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| Verfolger (Standard) | `C` zyklisch | Federgedämpft hinter dem Flugzeug, FOV steigt mit Geschwindigkeit (60°→75°), leichtes Schütteln bei Boost/hoher G |
| Cockpit              |              | 3D-Cockpit (LOD0), Kopfbewegung per Maus/rechter Stick, Kopf neigt sich mit G-Kraft                               |
| Flügel               |              | Fest auf der Flügelspitze, Blick nach vorn                                                                        |
| Orbit                |              | Frei mit Maus um das Flugzeug, Zoom per Rad                                                                       |
| Kino                 |              | Automatische Vorbeiflug-Kamera: setzt sich vor das Flugzeug an einen Punkt über Grund, schwenkt mit               |
| Foto-Modus           | `P`          | Pause, freie Kamera, Tiefenschärfe, Uhrzeit, Screenshot (PNG-Download)                                            |

Alle Kameras werden gegen `heightAt` geprüft (nie unter Gelände).

---

## 12. Steuerung & Eingabegeräte

**Tastatur (Standardbelegung, im Menü änderbar)**

| Aktion     | Taste                       |
| ---------- | --------------------------- |
| Nicken     | `W`/`S` oder ↑/↓            |
| Rollen     | `A`/`D` oder ←/→            |
| Gieren     | `Q`/`E`                     |
| Schub +/−  | `Shift`/`Ctrl` oder `R`/`F` |
| Boost      | `Space`                     |
| Fahrwerk   | `G`                         |
| Klappen    | `V`                         |
| Bremse     | `B`                         |
| Kamera     | `C`                         |
| Pause/Menü | `Esc`                       |
| Reset      | `Backspace`                 |

- **Maus-Flug** (optional): Maus zeigt die gewünschte Flugrichtung, Autopilot folgt (wie _War Thunder_-Steuerung) – ideal für Einsteiger.
- **Gamepad** (Gamepad API, Xbox/PS-Layout): linker Stick Rollen/Nicken, Trigger Schub, Schultertasten Gieren, Rumble bei Crash/Boost.
- **Touch:** virtueller Stick links, Schub-Schieber rechts, optional **Neige-Steuerung** über DeviceOrientation (benötigt Erlaubnis auf iOS).
- Eingabe-Pipeline: Rohwert → Deadzone (0,08) → Expo-Kurve (0,4) → Glättung → Achse −1..1.

---

## 13. HUD, UI & Menüs

**Technik:** DOM + CSS (scharf auf allen Auflösungen, keine Draw Calls), Werte-Updates per `transform`/`textContent` max. 30×/s, kein Framework. HUD in grünem/weissem Head-up-Stil, skaliert mit Bildschirm.

**HUD-Elemente:** Geschwindigkeit (km/h oder kt), Höhe m ü. M. + über Grund (AGL), Variometer, Kompassband mit Kurs, künstlicher Horizont (Pitch-Leiter), Schub-/Boost-Balken, G-Anzeige, Warnungen («TERRAIN – PULL UP», «STALL», «GRENZE»), Ortsname der nächsten Ortschaft (aus SearchServer, gedrosselt alle 10 s).

**Minimap:** runde Karte unten rechts aus `pixelkarte-farbe` WMTS (Zoom 12–14), Flugzeug-Pfeil, Nordpfeil, nächster Ring/Checkpoint. Taste `M` für Vollbildkarte mit Klick-Teleport.

**Bildschirme:**

1. **Startbildschirm** – Titel «Trapanotto Flight Simulator», animierter Hintergrund (Kino-Kamera über echter Landschaft, sobald geladen; vorher Cycles-Render), Buttons _Fliegen_, _Challenges_, _Einstellungen_, _Credits_.
2. **Startort-Auswahl** – Kacheln mit vordefinierten Orten + **Suchfeld** (SearchServer → beliebiger Ort der Schweiz), Uhrzeit-Schieber, Wetter (klar/Wolken).
3. **Ladeanzeige** – echter Fortschritt (geladene Kacheln um Startpunkt), Tipps.
4. **Pause-Menü** – Fortsetzen, Kamera, Einstellungen, Neustart, Hauptmenü.
5. **Einstellungen** – Grafik (Stufe + Einzeloptionen + Auflösungsskala), Steuerung (Belegung, Invertieren, Empfindlichkeit, Assistenz), Audio, Einheiten, Sprache (DE/EN/FR/IT – i18n-Struktur ab Tag 1, Inhalt DE+EN zuerst).
6. **Credits/Attribution** – © swisstopo, Bibliotheken, Lizenz.

**Debug-Overlay** (`F3`): FPS, Frametime-Graf, Draw Calls, Dreiecke, Texturspeicher, geladene Kacheln, offene Requests, Ursprung, Koordinaten LV95.

---

## 14. Gameplay & Spielmodi

**Vordefinierte Startorte**

| Ort                    | Typ   | Start                                |
| ---------------------- | ----- | ------------------------------------ |
| Bern-Belp (LSZB)       | Piste | am Boden, Startbahn 32               |
| Zürich (LSZH)          | Piste | am Boden                             |
| Samedan (LSZS)         | Piste | höchster Flugplatz Europas, am Boden |
| Sion (LSGS)            | Piste | Rhonetal, am Boden                   |
| Lugano (LSZA)          | Piste | am Boden                             |
| Lauterbrunnental       | Luft  | 1'500 m, Richtung Süden              |
| Matterhorn             | Luft  | 4'000 m, Ostseite                    |
| Jungfraujoch / Aletsch | Luft  | 3'800 m, über dem Gletscher          |
| Vierwaldstättersee     | Luft  | 800 m                                |
| Genfersee / Lavaux     | Luft  | 700 m                                |

**Spielmodi**

1. **Freier Flug** – ohne Ziel, alles erkunden. Ortsnamen erscheinen beim Überfliegen.
2. **Ring-Challenges** (Zeitfahren) – 5 handgebaute Strecken als JSON (Liste aus LV95-Koordinaten + Höhe), z. B.:
   - «Lauterbrunnen Canyon Run» (tief durchs Tal, 15 Ringe)
   - «Matterhorn Umrundung»
   - «Aletsch Gletscher-Express»
   - «Seen-Tour Zentralschweiz»
   - «Landeanflug Samedan» (Präzision, endet mit Landung)
     Medaillen Gold/Silber/Bronze, Bestzeiten in `localStorage`, **Geister-Replay** der Bestzeit (Aufzeichnung 10 Hz, interpoliert).
3. **Landungsherausforderung** – zufälliger Flugplatz, Wertung nach Sinkrate, Mittellinie, Aufsetzpunkt.
4. **Foto-Safari** (später) – Sehenswürdigkeiten fotografieren.

**Teilen:** URL enthält Position/Kurs/Uhrzeit (`#lv95=2635000,1158000,2500&hdg=180&t=18:30`) → Freunde starten am gleichen Ort. Nur Spieldaten, keine persönlichen Daten.

---

## 15. Audio

Komplett **prozedural mit WebAudio** (keine Lizenzprobleme, winziger Download):

- **Motor/Turboprop:** zwei Sägezahn-Oszillatoren + gefiltertes Rauschen, Tonhöhe & Lautstärke folgen Drehzahl; Propeller-«Wummern» per Amplituden-Modulation.
- **Wind:** Rosa Rauschen, Bandpass, Lautstärke ~ v², stärker im Cockpit bei offener Haube.
- **Boost:** zusätzlicher Turbinen-Layer.
- **Warnungen:** Synthetische Töne + Sprachausgabe optional über `speechSynthesis` («Pull up»).
- **Doppler & Räumlichkeit** in Aussenkameras (PannerNode).
- Audio startet erst nach erster Nutzer-Interaktion (Browser-Regel).

---

## 16. Qualitätsstufen & adaptive Performance

| Einstellung          | Niedrig | Mittel       | Hoch           | Ultra           |
| -------------------- | ------- | ------------ | -------------- | --------------- |
| Render-Skala         | 0,6     | 0,85         | 1,0            | 1,0 (DPR bis 2) |
| Terrain SSE τ        | 8 px    | 4 px         | 3 px           | 2 px            |
| Terrain max. Zoom    | 13      | 15           | 16             | 17              |
| Luftbild-Zoom-Offset | +1      | +2           | +2             | +3              |
| Sichtweite           | 60 km   | 100 km       | 150 km         | 200 km          |
| Gebäude              | aus     | 3 km         | 6 km           | 10 km           |
| Wolken               | 2D      | 2D           | volumetrisch ¼ | volumetrisch ½  |
| Schatten             | aus     | 1024²        | 2048²          | 2 Kaskaden      |
| Post-FX              | Tonemap | +Bloom, SMAA | +Flare, LUT    | +GTAO           |
| Vegetation           | aus     | aus          | Impostors      | Impostors dicht |

**Automatik:**

- Beim ersten Start: GPU-Kennung (`WEBGL_debug_renderer_info`) + 3-s-Benchmark → Vorschlag einer Stufe.
- **Dynamische Auflösung:** misst gleitend die Frametime; > 18 ms → Render-Skala −5 %, < 13 ms → +5 % (Grenzen je Stufe). Spart die meisten Einbrüche, unsichtbar für den Spieler.
- Bei Tab im Hintergrund: Loop pausiert, Requests werden gestoppt.

**Mikro-Optimierungen (Pflicht):**

- Keine Allokationen im Game-Loop (Vektor-Pools, wiederverwendete Objekte).
- Shader-Vorkompilierung (`renderer.compileAsync`) während des Ladebildschirms → kein Ruckeln beim ersten Effekt.
- Texture-Upload gedrosselt: max. 4 neue Kacheltexturen pro Frame.
- Geometrie in `BufferGeometry` mit Interleaving, Uint16-Indices wo möglich.
- Materialien geteilt; pro Kachel nur Uniform-/Textur-Wechsel.

---

## 17. Projektstruktur & Tooling

```
flightsimulator/
├─ .github/workflows/deploy.yml    # Build + GitHub Pages
├─ docs/KONZEPT.md                 # dieses Dokument
├─ public/
│  ├─ assets/aircraft/tr1.glb
│  ├─ assets/textures/…            # Detailtexturen (KTX2)
│  ├─ assets/ui/…                  # Logo, Startbild, Icons
│  ├─ challenges/*.json
│  └─ sw.js                        # Service Worker (Kachel-Cache)
├─ src/
│  ├─ main.ts
│  ├─ core/  geo/  net/  terrain/  buildings/  render/
│  ├─ aircraft/  physics/  camera/  input/  ui/  audio/  game/
│  ├─ workers/terrain.worker.ts
│  ├─ workers/imagery.worker.ts
│  ├─ shaders/*.glsl
│  └─ i18n/de.json, en.json
├─ tools/
│  ├─ blender/*.py                 # Asset-Pipeline
│  └─ optimize-assets.mjs          # gltf-transform: meshopt + KTX2
├─ tests/                          # Vitest: Projektionen, Decoder, Flugmodell
├─ index.html
├─ package.json, tsconfig.json, vite.config.ts
├─ LICENSE  (MIT für Code)
└─ README.md (Screenshots, Steuerung, Credits)
```

**Tooling:** Vite (Build, Worker-Bundling, GLSL-Import), TypeScript strict, ESLint + Prettier, Vitest (Unit-Tests für Mathe/Decoder/Physik), `lil-gui` für Live-Tuning im Debug-Modus, `stats-gl` für GPU-Timing.

**Abhängigkeiten (bewusst wenige):** `three`, `3d-tiles-renderer`, `postprocessing`, dev: `@gltf-transform/cli`, `vite`, `typescript`, `vitest`.

---

## 18. Build, CI & Deployment (GitHub Pages)

- Repo: `https://github.com/Trapanotto/flightsimulator` (public, aktuell leer – verifiziert).
- Live-URL: **`https://trapanotto.github.io/flightsimulator/`** (Vite `base: '/flightsimulator/'`).
- **GitHub Actions** `deploy.yml`: bei Push auf `main` → `npm ci` → `npm test` → `npm run build` → `actions/upload-pages-artifact` → `actions/deploy-pages`. Pages-Quelle = «GitHub Actions».
- Blender läuft **nicht** in CI (zu schwer) → das fertige `tr1.glb` wird versioniert eingecheckt; Quell-Skripte liegen daneben.
- Branch-Strategie: `main` = live; pro Phase ein Feature-Branch + PR (oder direkt `main`, falls dir das lieber ist).
- Versionierung: Tags `v0.1` … `v1.0` pro Phase, Changelog im README.
- Cache-Busting: Vite-Hashes für JS/CSS; Service Worker mit Versionsnummer.

---

## 19. Lizenz, Attribution & Fair Use

- Geodaten von swisstopo sind seit 2021 **Open Government Data**, kostenlos nutzbar; **Quellenangabe ist Pflicht** → dauerhaft sichtbar unten links im Spiel: «© swisstopo · Daten: geo.admin.ch», zusätzlich in Credits und README.
- Die Dienste unterliegen Fair-Use-Regeln. Massnahmen: max. 10 parallele Requests, kein aggressives Vorausladen ausserhalb Sichtweite, Service-Worker-Cache, Abbruch nicht mehr benötigter Anfragen, sinnvolle Zoom-Grenzen. Vor dem öffentlichen Launch kurze Prüfung der aktuellen Nutzungsbedingungen auf geo.admin.ch.
- Keine Weiterverbreitung von Rohdaten im Repo (nur Streaming).
- Code: MIT. Eigene Blender-Assets: CC BY 4.0 (oder nach deinem Wunsch).
- Keine Marken/Logos Dritter im Flugzeugdesign.

---

## 20. Risiken & Gegenmassnahmen

| Risiko                                                       | Wahrscheinl.          | Auswirkung | Gegenmassnahme                                                                             |
| ------------------------------------------------------------ | --------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| Intel-GPU schafft Effekte nicht                              | mittel                | hoch       | Qualitätsstufen, dynamische Auflösung, Budget-Messung jede Phase                           |
| Nachladen sichtbar (Ploppen, unscharfe Kacheln bei 500 km/h) | hoch                  | mittel     | Vorausladen in Flugrichtung, Eltern-Fallback, Geomorphing, Geschwindigkeitsabhängiger Zoom |
| Reprojektion 4326↔3857 erzeugt Nähte                         | mittel                | mittel     | Streifen-Reprojektion, 1-px-Rand, Unit-Test mit Testmuster                                 |
| Float-Jitter                                                 | niedrig (mit Konzept) | hoch       | Floating Origin + Kachel-relative Vertices                                                 |
| URL/Version der swisstopo-Dienste ändert sich                | mittel                | hoch       | Version aus `layer.json`, Fehlerseite mit Hinweis, Monitoring-Skript                       |
| Fair-Use-Drosselung                                          | niedrig               | hoch       | Request-Limits, Cache, Backoff bei 429/503                                                 |
| Gebäude-Tiles zu schwer                                      | mittel                | mittel     | Höhen-/Radiusgrenze, nur ab Stufe Mittel                                                   |
| Mobile Safari Speicherlimits                                 | hoch                  | mittel     | Stufe Niedrig, kleinere Caches, KTX2                                                       |
| Blender-Skript-Modellierung wirkt «zu prozedural»            | mittel                | mittel     | Iterativ mit Render-Vorschauen, Details (Nieten, Panels, Decals) über Texturen             |

---

## 21. Umsetzungsplan

Jede Phase endet mit **Push auf GitHub + Live-Deploy** und einer Abnahme durch dich.

### Phase 0 – Fundament (½ Tag)

- Vite + TS + Three.js Projekt, Linting, Tests, Ordnerstruktur
- GitHub Actions + Pages aktivieren, Platzhalter-Startseite mit Titel
- **Abnahme:** `https://trapanotto.github.io/flightsimulator/` zeigt Startbildschirm «Trapanotto Flight Simulator».

### Phase 1 – Geo-Grundlagen & erstes Terrain (1–2 Tage)

- `geo/Projection` mit Unit-Tests (LV95/WGS84/ECEF/ENU, Mercator)
- Netzwerk-Queue, Terrain-Worker (Quantized-Mesh-Decoder), feste Kacheln um Bern
- Einfaches Material mit Luftbild, Orbit-Kamera, Debug-Overlay
- **Abnahme:** Berner Alpen in 3D mit Luftbild sichtbar, rotierbar, 60 FPS.

### Phase 2 – Streaming-Terrain (2–3 Tage)

- Spike Variante A vs. B → Entscheid
- Quadtree-LOD, SSE, Culling, Skirts, LRU-Cache, Floating Origin, Höhenabfrage
- Freie Flugkamera (Spectator) zum Testen über die ganze Schweiz
- **Abnahme:** Genf → St. Moritz mit 500 km/h ohne Löcher, ohne Jitter, ≥ 60 FPS (Mittel).

### Phase 3 – Flugzeug aus Blender (2–3 Tage)

- Blender-Skripte: Geometrie, UV, Bake, Lackierung, Export, LODs
- `gltf-transform`-Optimierung (Meshopt, KTX2)
- Einbindung, Ruder-/Propeller-Animation
- **Abnahme:** TR-1 im Hangar-Viewer + Renderbild; ≤ 2,5 MB; du gibst Design frei.

### Phase 4 – Flugmodell, Steuerung, Kameras (2 Tage)

- Arcade-Physik, Kollision, Start/Landung, Crash/Reset
- Tastatur, Maus-Flug, Gamepad, Touch
- Verfolger-, Cockpit-, Flügel-, Orbit-Kamera
- **Abnahme:** In Bern-Belp starten, durchs Lauterbrunnental fliegen, in Sion landen.

### Phase 5 – Grafik-Politur (3 Tage)

- Himmel, Sonnenstand, atmosphärische Perspektive, IBL, Tonemapping
- Wolken (2D, dann volumetrisch), Schatten, Bloom, Lens Flare, Trails
- Terrain-Detailtexturen, Schnee, Qualitätsstufen + dynamische Auflösung
- **Abnahme:** Golden-Hour-Referenzszene; Stufen-Benchmark auf deinem Laptop dokumentiert.

### Phase 6 – Gebäude, HUD & UI (2 Tage)

- swissBUILDINGS3D, Shading
- HUD, Minimap, Menüs, Startort-Auswahl + Suche, Einstellungen, i18n DE/EN, Attribution
- **Abnahme:** Tiefflug über Zürich mit Gebäuden; komplette Menüführung.

### Phase 7 – Gameplay & Audio (2–3 Tage)

- Ring-Challenges (5 Strecken), Medaillen, Geister-Replay, Landungsherausforderung
- Prozedurales Audio, Teilen-URL, Foto-Modus
- Optional: Vegetation, Wind, Seen-Maske, Tag/Nacht
- **Abnahme:** Alle Challenges spielbar, Bestzeiten bleiben gespeichert.

### Phase 8 – Release 1.0 (1 Tag)

- Performance-Pass (Profiling Chrome/Firefox/Safari, Mobile)
- Service-Worker-Cache, Fehlerbehandlung (offline, Dienst nicht erreichbar)
- README mit Screenshots/GIF, `og:image`, Credits, Tag `v1.0`
- **Abnahme:** Lighthouse Performance ≥ 90 (Startseite), keine Konsolenfehler, Release öffentlich.

**Gesamtaufwand:** ca. 15–20 Arbeitstage-Äquivalente; wir gehen Phase für Phase.

---

## 22. Offene Entscheidungen (bitte bestätigen oder ändern)

1. **Flugzeugtyp:** Turboprop-Trainer «TR-1 Alpenfalke» (Vorschlag) – oder lieber Jet, Segelflugzeug, Helikopter, Pilatus-Porter-artiges Buschflugzeug?
2. **Sprache der Oberfläche:** Deutsch + Englisch zuerst?
3. **Git-Workflow:** direkt auf `main` pushen (schneller) oder pro Phase Branch + Pull Request?
4. **Lizenz:** MIT für Code, CC BY 4.0 für Assets – ok?
5. **Lokaler Projektordner:** Wo soll das Projekt auf deinem Rechner liegen (z. B. `~/Projekte/flightsimulator`)?
