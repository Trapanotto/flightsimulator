# Changelog

## v0.9.2 – Flugplätze, Gebäude, Bäume (2026-10-28)

- **Alle Schweizer Flugplätze**: 44 befestigte Pisten an 39 Flugplätzen (inkl. Basel-Mulhouse)
  mit Markierungen; im Flugmenü «Alle Flugplätze» mit beiden Pistenrichtungen. Daten aus
  OpenStreetMap (`tools/fetch-aeroways.mjs`).
- **Rollwege und Vorfelder** an allen Flugplätzen scharf: Asphaltkörnung, Betonplatten mit
  Fugen, durchgehende gelbe Rollweg-Mittellinie (vorzeichenbehaftetes Distanzfeld) – das
  Luftbild mit Standplatz-Markierungen bleibt darunter erhalten.
- **Gebäudevielfalt**: 64 Fassaden- und Dachtexturen (16 Materialien × 4 Varianten) –
  Fensterläden, Blumenkästen, Holzarten, Balkone, Glasfassaden, Hallenverkleidungen, Ziegel
  rot/braun/anthrazit/bemoost, Eternit, begrünte und Solardächer; Varianten pro Gebäude,
  grosse Blöcke mit Glasfassade, farbige Hallen, mehr Putzfarben.
- **Bäume**: neu Waldföhre, Bergahorn und Birke; drei Formen pro Art (27 Modelle); eigene
  Kronenbreite und Farbe pro Baum; Herbstfarben und kahle Winterbäume nach dem echten Datum
  (`?date=2026-07-15` zum Testen). Föhren im Wallis, Kastanien und Birken im Tessin.

## v0.9.1 – Scharfe Pisten (2026-10-28)

- **Pisten mit Asphalt und ICAO-Markierungen** an allen sechs Flugplätzen: Schwellenbalken nach
  Pistenbreite, Pistennummern an beiden Enden (14/32, 07/25, 10/28, 03/21, 01/19, 04/22),
  Mittellinie, Zielpunkt- und Aufsetzzonenmarken, Randlinien, Gummispuren. Direkt im
  Gelände-Shader pro Pixel gerechnet – scharf aus jeder Nähe, ohne Flimmern.
- **Schärferes Luftbild** nahe am Flugzeug: Qualität «hoch» lädt Gelände bis Zoom 17, «ultra»
  bis 18; swissimage bis zur feinsten Stufe (Zoom 20, ~10 cm pro Pixel).
- Minikarte zeichnet nicht mehr, wenn sie ausgeblendet ist.

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
