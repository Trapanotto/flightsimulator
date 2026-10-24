# ADR 0001 – Eigene Terrain-Engine (Variante B)

Datum: 24.10.2026 · Status: angenommen

## Kontext

Das Konzept (Kapitel 6.1) sah für Phase 2 einen eintägigen Vergleich vor:
A = Bibliothek 3d-tiles-renderer mit Quantized-Mesh-Plugin,
B = eigene Engine (Quadtree + Worker-Decoder).

## Entscheid

Variante **B**, ohne separaten Spike.

## Begründung

- Phase 1 hat die Bausteine von B bereits geliefert und gemessen: Decoder, Luftbild-Reprojektion
  in Workern, Request-Begrenzung. GPU-Zeit ~9 ms/Frame bei 1080p auf Intel UHD (Budget 16,6 ms).
- B gibt uns direkt, was A nur über Umwege liefert: Höhenraster pro Kachel für Kollision und
  Höhe über Grund, eine Textur pro Kachel ohne Shader-Overlays, volle Kontrolle über
  Speicher-Budget, Upload-Drosselung und Prioritäten in Flugrichtung.
- Der Spike hätte einen Tag gekostet, ohne dass ein Ergebnis B in Frage stellt.

## Folgen

- Gebäude (swissBUILDINGS3D, 3D Tiles/b3dm) nutzen weiterhin 3d-tiles-renderer (Phase 6).
- Fällt B bei der Abnahme von Phase 2 durch (Löcher, Budget), wird A nachträglich geprüft.
