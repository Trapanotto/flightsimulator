# Konzept V2 – Neustart des Flugsimulators

Stand: 13. November 2026 · Entwurf zur Freigabe

## 1. Entscheide

| Frage                                  | Entscheid                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| Technik                                | Browser, WebGPU                                                                               |
| Spielkern                              | Reine Simulation                                                                              |
| Welt                                   | Echte Schweiz, neu aufgebaut                                                                  |
| Grafikstil                             | Fotorealistisch                                                                               |
| Ablage                                 | Gleiches Repository, die alte Version wird direkt ersetzt (bleibt als Tag `v0.11.0` abrufbar) |
| Flugzeugmodelle                        | Blender-Skripte, deutlich verbessert                                                          |
| Geräte                                 | Desktop und Mobil von Anfang an                                                               |
| Angefangene Nacht/Jahreszeiten in v0.x | verworfen, entsteht in V2 neu                                                                 |

**Leitsatz:** Der glaubwürdigste Flugsimulator, der in einem Browser-Tab läuft – die ganze
Schweiz, echtes Wetter, echte Verfahren, per Link spielbar.

**Zu «Triple A»:** Ein AAA-Titel wie Microsoft Flight Simulator hat hunderte Leute und
handgebaute Inhalte. Das Ziel hier ist deshalb: in grosser Höhe und bei Licht, Wetter und
Flugverhalten auf Augenhöhe wirken, in Bodennähe und bei den Flugzeugmodellen sichtbar besser
als heute, aber nicht auf MSFS-Niveau. Wo die Grenze liegt, steht jeweils im Abschnitt.

## 2. Warum ein Neustart

Was am heutigen Stand (v0.11.0, ~20 000 Zeilen) nicht mehr trägt:

- **Renderer:** WebGL2 mit Lambert-Gelände und Shader-Stücken, die in fremde Shader
  eingespritzt werden. Jede Neuerung (Nacht, Jahreszeiten, Schnee) muss an fünf Stellen
  nachgezogen werden. Licht ist nicht durchgehend physikalisch.
- **Boden aus der Nähe:** nur das Luftbild. Keine 3D-Bäume, wenige generische Häuser, kein
  Material unter dem Bild – unter 300 m über Grund wirkt die Welt flach.
- **Flugmodell:** ein Koeffizientenmodell pro Flugzeug, von Hand abgestimmt. Fehler wie das zu
  späte Abheben fallen erst beim Spielen auf, weil nichts gegen Handbuchwerte geprüft wird.
- **Aufbau:** Spiel, Kamera, Eingabe und Anzeige hängen in wenigen grossen Dateien zusammen
  (`FlightGame.ts`, `World.ts`). Parallel daran zu arbeiten ist kaum möglich.
- **Menü und Bedienung:** einzelne Dialoge statt eines durchgehenden Ablaufs; Cockpits sind
  Kulisse, nicht bedienbar.

Was als Wissen mitkommt (als Referenz, nicht als Code-Kopie): die swisstopo-Anbindung, das
Nachladen der Geländekacheln, der verschiebbare Koordinatenursprung, die Pisten- und
Flugplatzdaten, der berechnete Triebwerksklang, die automatischen Flugtests im Browser.

## 3. Säulen

### 3.1 Flugverhalten

- **Modell aus Flächenstücken** statt Gesamtkoeffizienten: Flügel, Leitwerk und Rumpf werden in
  Streifen gerechnet, jeder mit eigener Anströmung. Strömungsabriss, Trudeln, Bodeneffekt,
  Propellerstrahl und Seitenwind ergeben sich daraus, statt einzeln nachgebaut zu werden.
- **Triebwerke** als eigene Modelle: Kolbenmotor mit Gemisch und Vergaservorwärmung, Turboprop
  mit Drehmoment- und Temperaturgrenze, Strahltriebwerk mit Hochlaufverhalten.
- **Fahrwerk und Boden:** Federbeine, Reifenhaftung nach Untergrund (Asphalt, Gras, nass,
  Schnee), Bremsen, Bugradlenkung.
- **Prüfung gegen das Handbuch:** Für jedes Flugzeug laufen automatische Tests gegen
  veröffentlichte Werte – Startstrecke, Steigrate, Überziehgeschwindigkeit, Reisegeschwindigkeit,
  Gleitzahl. Ein Flugzeug gilt erst als fertig, wenn es innerhalb von 5 % liegt.
- **Luft:** Wind mit Höhenprofil, Böen, Turbulenz und – in den Alpen entscheidend –
  Hangaufwind, Leewirbel und Thermik aus Gelände und Sonnenstand.
- **Ausfälle und Zustand:** Motorausfall, Vereisung, elektrische Störungen, Treibstoff,
  Beladung und Schwerpunkt.

### 3.2 Welt

Datenquellen bleiben swisstopo (Gelände, Luftbild, Vektordaten) und OpenStreetMap.

- **Gelände:** Höhenmodell wie heute, neu mit Normalen und Schatten aus dem Höhenfeld, damit
  Berge auch bei tiefer Sonne plastisch sind.
- **Boden aus der Nähe:** Unter dem Luftbild liegt eine Materialschicht aus der
  Bodenbedeckung (Wiese, Acker, Fels, Geröll, Wald, Siedlung). Sie blendet in Bodennähe ein und
  gibt Struktur, wo das Luftbild unscharf wird.
- **Wald und Bäume:** echte 3D-Bäume als Instanzen aus den Waldflächen, Nadel- und Laubwald
  nach Höhe, bis in die Ferne als vereinfachte Formen.
- **Gebäude:** Ziel sind die echten 3D-Gebäude von swisstopo (swissBUILDINGS3D). Ob sie sich
  im Browser schnell genug laden lassen, wird in Phase 1 geprüft; Rückfall sind Grundrisse mit
  berechneten Dächern.
- **Wasser:** Seen und Flüsse mit Wellen, Spiegelung und Ufer.
- **Flugplätze:** alle 39 Schweizer Plätze mit Pisten, Rollwegen, Markierungen, Befeuerung,
  Windsack, Hangars. Die grossen (Zürich, Genf, Basel, Bern, Sion, Lugano) mit Terminals.
- **Nacht:** Stadt- und Strassenlichter aus den Kartendaten, Pisten- und Anflugbefeuerung,
  Sterne an ihrem echten Ort, Mond mit Phase.
- **Jahreszeiten:** Schneegrenze, Herbstfarben, kahler Winterwald, gefrorene Bergseen – nach
  Kalender oder frei wählbar.

**Grenze:** Einzelne Wahrzeichen von Hand nachzubauen (Bundeshaus, Kapellbrücke) ist nicht
Teil des Plans. Das Luftbild bleibt die Farbquelle; es trägt eingebrannte Schatten und
Fahrzeuge, die sich nur mildern, nicht entfernen lassen.

### 3.3 Licht, Himmel, Wetter

- **Himmel physikalisch gerechnet** (Streuung in vorberechneten Tabellen): durchgehende
  Tageszeit von Sonnenaufgang bis Nacht ohne Sprünge, Dämmerungsfarben, Dunst mit Tiefe.
- **Volumetrische Wolken** in mehreren Schichten (Quell-, Schicht-, Schleierwolken), Schatten
  auf dem Gelände, Hochnebel über dem Mittelland, Regen und Schnee mit Tropfen auf der Scheibe.
- **Echtes Wetter** wie heute, neu mit mehreren Höhenschichten und Meldungen der Flugplätze
  (METAR).
- **Bildkette:** Schatten in Stufen für Gelände und Objekte, Umgebungsverdeckung, zeitliche
  Kantenglättung, automatische Belichtung, Überstrahlung.
- **Leistungsziel Desktop:** 60 Bilder pro Sekunde in 1440p auf einer Mittelklasse-Grafikkarte
  (Klasse RTX 3060), 30 auf integrierter Grafik mit reduzierten Stufen.
- **Leistungsziel Mobil:** 30 Bilder pro Sekunde auf einem aktuellen Handy oder Tablet, mit
  eigener Grafikstufe: gleiche Welt und gleiches Licht, aber einfachere Wolken, weniger Bäume
  und Gebäude, kürzere Schatten. Jede Grafiktechnik bekommt von Anfang an eine leichte
  Variante; was sich nicht verkleinern lässt, wird nicht gebaut.
- Ohne WebGPU läuft eine vereinfachte Darstellung.

### 3.4 Cockpit und Systeme

- **Bedienbares Cockpit:** Schalter, Hebel und Knöpfe mit der Maus, jeder mit Wirkung.
- **Avionik:** klassische Rundinstrumente und ein Glascockpit (Flug- und Navigationsanzeige,
  Karte, Flugplan), Funk- und Navigationsgeräte, Transponder, Autopilot.
- **Navigation:** Funkfeuer, Instrumentenlandesystem, GPS-Flugplan, Schweizer Meldepunkte und
  Lufträume.
- **Funk:** simulierte Flugverkehrsleitung mit Freigaben für Rollen, Start, Platzrunde und
  Anflug, gesprochen und als Text.
- **Checklisten** je Flugphase, wahlweise mit Hervorhebung des nächsten Schalters.

### 3.5 Hauptmenü und Ablauf

- **Startbild:** das Flugzeug im Hangar oder auf dem Vorfeld in Echtzeit, mit dem aktuellen
  Wetter des Heimatflugplatzes. Kein Ladebalken vor dem ersten Bild.
- **Flug planen:** Schweizerkarte mit allen Flugplätzen. Start und Ziel wählen (Piste,
  Standplatz oder in der Luft), Route, Tageszeit, Jahreszeit, Wetter, Flugzeug, Treibstoff
  und Beladung – auf einer Seite, mit Vorschau.
- **Hangar:** Flugzeuge drehen, Daten und Handbuchwerte ansehen, Bemalung wählen.
- **Flugschule:** geführte Lektionen vom ersten Start bis zum Instrumentenanflug. Ersetzt in
  einer reinen Simulation das Spielziel, ohne Punktejagd.
- **Flugbuch:** jeder Flug mit Route, Dauer, Landung (Sinkrate, Mittellinie), als Karte.
- **Wiederholung und Fotomodus:** Flug zurückspulen, freie Kamera, Bild speichern.
- **Einstellungen:** Grafik, Ton, Steuerung mit freier Belegung für Tastatur, Maus, Gamepad
  und Steuerknüppel.
- **Mobil:** Das ganze Menü funktioniert mit dem Finger und im Hoch- wie Querformat. Im Flug:
  Steuern durch Neigen des Geräts oder mit einem Daumen-Steuerknüppel, Schub, Klappen,
  Fahrwerk und Bremsen als Bedienfelder am Rand. Das Cockpit wird durch Antippen bedient.

### 3.6 Flugzeuge

Lieber wenige, dafür vollständig. Vorschlag in dieser Reihenfolge:

1. **Cessna 172** – Schulflugzeug, erstes vollständiges Muster (Modell, Cockpit, Systeme).
2. **Pilatus PC-12** – Schweizer Turboprop, Glascockpit.
3. **Airbus A320** – Verkehrsflugzeug mit Flugführungssystem.
4. **F/A-18 Hornet** – Kampfjet der Schweizer Luftwaffe.

Später möglich: Segelflugzeug (nutzt Hangaufwind und Thermik), Hubschrauber.

**Grenze:** Die Flugzeugmodelle sind die grösste Lücke zu AAA. Heute entstehen sie aus
Blender-Skripten. Das lässt sich deutlich verbessern (mehr Geometrie, echte Materialien,
Abnutzung), erreicht aber kein von Hand modelliertes Niveau. Die Ladeschnittstelle wird so
gebaut, dass ein Modell später durch ein gekauftes ersetzt werden kann.

## 4. Technik

- **Renderer:** Three.js mit WebGPU und Materialien als Knotengraph statt eingespritzter
  Shader. Ein Beleuchtungsmodell für alles.
- **Aufbau in getrennten Paketen** mit festen Schnittstellen:

  | Paket      | Inhalt                                                                                      | hängt ab von             |
  | ---------- | ------------------------------------------------------------------------------------------- | ------------------------ |
  | `sim`      | Flugmodell, Triebwerke, Systeme, Luft. Reines TypeScript, ohne Grafik, ohne Browser testbar | –                        |
  | `geo`      | Koordinaten, Kacheln, Datenquellen                                                          | –                        |
  | `world`    | Gelände, Bäume, Gebäude, Wasser, Flugplätze                                                 | `geo`                    |
  | `sky`      | Himmel, Wolken, Wetter, Tageszeit                                                           | –                        |
  | `aircraft` | Modelle, Cockpit, Avionik-Anzeigen                                                          | `sim`                    |
  | `audio`    | Triebwerk, Wind, Funk                                                                       | `sim`                    |
  | `ui`       | Menü, Flugplanung, Anzeigen                                                                 | alle über Schnittstellen |
  | `app`      | Zusammenbau, Spielablauf, Eingabe                                                           | alle                     |

- **Simulation** mit festem Zeitschritt, getrennt von der Darstellung, wiederholbar – Grundlage
  für Wiederholung und Tests.
- **Datenaufbereitung** als Werkzeuge im Repo: Flugplätze, Navigationsdaten, Lufträume,
  Bodenbedeckung werden vorab zu Kacheln gerechnet und mit ausgeliefert.
- **Speichern** im Browser: Einstellungen, Flugbuch, Kachel-Zwischenspeicher.
- **Sprachen:** Deutsch und Englisch wie heute.
- **Qualitätssicherung:** Handbuch-Tests je Flugzeug, Bildvergleiche fester Szenen bei jedem
  Stand, eine Messstrecke für die Leistung.

## 5. Phasen

| Phase       | Ziel                                                                                                            | Ergebnis zum Anschauen                              |
| ----------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 0 Fundament | Alten Code entfernen, Projektgerüst, Pakete, Schnittstellen, Test- und Bildvergleich-Kette                      | leere Szene läuft auf WebGPU, auf Desktop und Handy |
| 1 Kostprobe | Eine Region (Bern-Belp bis Berner Oberland), ein Flugzeug (C172), neuer Himmel, neues Gelände, Menü-Grundgerüst | ein Flug von Bern zum Thunersee in Zielgrafik       |
| 2 Welt      | Ganze Schweiz, Bäume, Gebäude, Wasser, Nacht, Jahreszeiten, alle Flugplätze                                     | Flug zu jeder Zeit und Jahreszeit überall           |
| 3 Tiefe     | Bedienbares Cockpit, Avionik, Navigation, Funk, Ausfälle, Alpenwind                                             | Instrumentenanflug auf Zürich bei Hochnebel         |
| 4 Flotte    | PC-12, A320, F/A-18                                                                                             | vier vollständige Flugzeuge                         |
| 5 Schliff   | Flugschule, Flugbuch, Wiederholung, Fotomodus, Leistung, Version 1.0                                            | Veröffentlichung                                    |

Mit Phase 0 verschwindet die heutige Version von der Spieladresse; bis zur Kostprobe ist dort
nur der Zwischenstand zu sehen.

Phase 1 ist die Prüfung: Erreicht die Kostprobe die erhoffte Grafik und Bildrate nicht, wird
der Plan dort angepasst, bevor die Breite gebaut wird.

## 6. Umsetzung mit Subagenten

- Jede Phase wird in Arbeitspakete entlang der Paketgrenzen aus Abschnitt 4 geteilt. Ein Paket
  gehört einem Opus-5.5-Subagenten; zwei Agenten bearbeiten nie dieselben Dateien.
- Vor dem Start einer Phase werden die Schnittstellen zwischen den Paketen festgeschrieben. Die
  Agenten bauen dagegen, nicht gegeneinander.
- Die Hauptsitzung verteilt, prüft jedes Ergebnis (Tests, Bildvergleich, Probeflug im Browser),
  führt zusammen und meldet nach jeder Phase den Stand mit Bildern.
- Phase 0 läuft allein in der Hauptsitzung, weil dort die Grenzen entstehen.

## 7. Offene Fragen

1. **Reihenfolge der Flugzeuge:** Vorschlag aus 3.6 übernehmen, oder andere Muster?
2. **Datenmenge:** Vorberechnete Daten (Bodenbedeckung, Bäume, Lichter) für die ganze Schweiz
   können mehrere hundert Megabyte werden. GitHub Pages erlaubt 1 GB. Reicht das, oder ist ein
   eigener Speicher (z. B. Cloudflare) denkbar? Wird erst in Phase 2 dringend.
