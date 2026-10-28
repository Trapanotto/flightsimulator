# Changelog

## v0.9.0 – Flotte & Flugmodell (2026-10-28)

### Neu

- **Flotte «Trapanotto Airlines»** ersetzt den TR-1: Cessna 172 Skyhawk, Pilatus PC-12 NGX,
  Embraer Phenom 100, Lockheed Martin F-35 Lightning II, Airbus A320 und Boeing 747-400 – alle
  per Python-Skript in Blender modelliert, mit Kabine, beweglichen Rudern, Fahrwerk und
  Lackierung. Auswahl im Hangar und im Flugmenü.
- **Realistisches 6-DOF-Flugmodell** nach dem Vorbild von JSBSim (FlightGear), eigener Code:
  Masse und Trägheit, Auftrieb mit Strömungsabriss, Stabilitäts- und Ruderderivate, Schub mit
  Höhenabnahme, Federbein-Fahrwerk pro Rad, Bodeneffekt. Stall- und Höchstgeschwindigkeiten
  wie im Handbuch.
- **Flugsteuerung je Typ**: Fly-by-Wire für A320 und F-35 (Lastfaktor- und Rollratenvorgabe,
  Bahn- und Querlagenhaltung, Schutzfunktionen), Gierdämpfer für alle übrigen. Tastatur gibt
  weiche Drehraten statt Vollausschlag, trimmt beim Loslassen nach und hält die Querlage.
- **Ring-Challenges**: fünf Strecken mit Medaillen und Bestzeiten.
- **HUD im MSFS-Stil**: Karte oben links, Tempo und Triebwerk unten links, Klappen, Trimmung,
  Höhe und Steigrate unten rechts, Menü oben rechts.
- **Animierter Startbildschirm**: die Flotte fliegt live durchs Lauterbrunnental und über die
  Kleine Scheidegg, mit wechselnden Kameraperspektiven; vorher (und auf schwachen Geräten) ein
  aufgezeichnetes Video desselben Flugs.

### Verbessert

- Startbildschirm-Flug geglättet: Bahn ohne Krümmungssprünge, weiche Querlage, Kamera mit
  Federung, Steigungen höchstens 13 %.
- Wolken: die gestapelten Schichten verschmelzen in der Ferne – keine Streifen mehr am
  Horizont.
- Linkvorschau (Open Graph) mit neuem Bild und Video.
- Grafik im Flugmodus nicht mehr ausgewaschen.

## v0.8.1

- Echte Wasserflächen für Seen und Flüsse; dunklerer Triebwerksklang.

## v0.8

- Prozedurale Geräusche mit WebAudio: Triebwerk, Wind, Boost, Warnungen, Aufprall.

Ältere Versionen: siehe die Git-Tags `v0.1` bis `v0.7`.
