# ADR 0002 – Flugzeug-Assets: WebP-Texturen, Dreiecksbudget

Datum: 24.10.2026 · Status: angenommen

## Kontext

Das Konzept (Kapitel 10) sah KTX2/Basis-Texturen sowie ~25 000 / 8 000 / 1 500 Dreiecke
für LOD0/1/2 vor.

## Entscheide

1. **WebP statt KTX2.** Auf dem Build-Rechner fehlt `toktx`/`basisu`. Die Texturen werden direkt
   aus Blender als WebP exportiert (BaseColor 2048², Rauheit/Metall 1024²). Download: 0,28 MB.
   Nachteil: unkomprimiert im Grafikspeicher (~22 MB statt ~5 MB). Für ein einziges Flugzeug
   unkritisch; wird nachgeholt, sobald mehrere Flugzeuge (z. B. Geister-Replays) gleichzeitig
   fliegen.
2. **Mehr Dreiecke als geplant:** LOD0 37 700, LOD1 18 500, LOD2 2 100. Für ein Objekt kostet das
   auf der GPU unter 0,1 ms; die Rundungen von Rumpf und Haube profitieren sichtbar.
3. **Geometrie-Kompression mit meshopt** (EXT_meshopt_compression). Damit die Quantisierung die
   Scharnier-Drehpunkte nicht verschiebt, bekommt jedes Mesh einen eigenen Unterknoten
   (`tools/optimize-aircraft.mjs`).
4. **Lackierung per numpy statt Shader-Bake:** Position, Normale und Bauteil-ID werden pro Texel
   selbst im UV-Raum gerastert. Blenders Positions-Bake lieferte unbrauchbare Werte.

## Folgen

Gesamtdatei `tr1.glb`: 0,70 MB (Budget 2,5 MB).
