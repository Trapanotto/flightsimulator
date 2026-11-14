# Changelog

## 1.0.0-alpha.3 – Phase 2: die Welt (2026-11-14)

- **Wald und Bäume:** 3D-Bäume in den Waldflächen und die einzeln vermessenen Bäume der
  Landeskarte; Laub- und Nadelwald nach Höhenlage bis zur Baumgrenze.
- **Gebäude:** in der Nähe die echten 3D-Gebäude von swisstopo (swissBUILDINGS3D), in der
  Ferne Grundrisse mit berechneten Dächern; nachts beleuchtete Fenster.
- **Flugplätze:** 63 Flugplätze mit 85 Pisten. Scharfe Pisten mit Markierungen nach ICAO,
  Rollwege und Vorfelder, Pisten-, Anflug- und Rollwegbefeuerung, Gleitwinkelanzeige (PAPI),
  Windsäcke.
- **Jahreszeiten**, in der Flugplanung wählbar: Schneegrenze, Frühlingsgrün, Herbstfarben,
  kahler Winterwald, Schnee auf Dächern und Baumkronen, gefrorene Bergseen.
- **Nacht:** Strassen- und Siedlungslichter, einzelne Lichter bei Höfen und Hütten, dunkle
  Seen und Wälder.
- **Boden:** Bergschatten bei tiefer Sonne, hellere Nordhänge, Strassen als scharfe Bänder
  mit Linien, Ackerfurchen in Feldrichtung.

Daten: © swisstopo, OurAirports, © OpenStreetMap contributors.

## 1.0.0-alpha.2 – Phase 1 abgerundet (2026-11-13)

- **Laden:** Das Gelände wird vollständig geladen, bevor Menü oder Flug erscheinen; der
  Ladebalken zeigt den echten Fortschritt. Das Flugzeug steht von Anfang an ruhig auf
  seinem Fahrwerk, statt nachzufedern, und der einmalige Hänger beim ersten Bild liegt
  hinter dem Ladebild.
- **Ton:** Triebwerk aus Zündfolge und Propeller berechnet, Fahrtwind, Rollgeräusch und
  Überziehwarnung; im Cockpit gedämpft. Lautstärke und Stummschalten in den Einstellungen.
- **Live-Wetter** von Open-Meteo: Bewölkung, Wolkenbasis, Sicht, Wind und Temperatur am
  Startort.
- **Seitenruder-Hilfe** hält den Startlauf jetzt auf unter 2 Grad genau.
- **Tastatur:** Bei hoher Geschwindigkeit bewegen die Tasten das Steuer feiner, damit volles
  Drücken das Flugzeug nicht überlastet.

## 1.0.0-alpha.1 – Phase 1: Kostprobe Bern–Thunersee (2026-11-13)

Der erste fliegbare Stand des Neuaufbaus.

- **Flugmodell Cessna 172S** aus Flächenstücken gerechnet, mit Motor, Propeller und Fahrwerk;
  alle geprüften Handbuchwerte (Überziehen, Startstrecke, Steigrate, Reiseflug, Gleitzahl,
  Landestrecke) innerhalb von 5 %.
- **Echtes Gelände** der Schweiz von swisstopo, nachgeladen nach Entfernung, mit Bodendetail
  in der Nähe, Seen und Flüssen als Wasser und exakter Höhe unter den Rädern.
- **Himmel** physikalisch gerechnet von Mittag bis Nacht, Dunst über die Distanz,
  volumetrische Wolken mit Schatten, vier Wetterlagen, Mond und Sterne.
- **Cessna 172S** als neues 3D-Modell mit beweglichen Rudern, Klappen und Propeller, Lichtern
  und einem Cockpit, dessen Instrumente die echten Werte zeigen.
- **Menü**: Hauptmenü über der Live-Szene, Flugplanung mit Schweizerkarte, Tageszeit und
  Wetter, Briefing, Fluganzeigen, Pause, Einstellungen, Touch-Steuerung für das Handy.
- **Steuerung**: Tastatur, Gamepad und Touch; eine Seitenruder-Hilfe hält die Maschine am
  Boden gerade und im Flug sauber, solange man das Seitenruder nicht selbst bedient.
- Aussen- und Cockpitansicht, sechs Startflugplätze, Start auf der Piste oder in der Luft.

Noch nicht enthalten: Ton, Bäume und Gebäude, Pistenmarkierungen, Live-Wetter, bedienbare
Schalter im Cockpit.

## 1.0.0-alpha.0 – Neuaufbau, Phase 0: Fundament (2026-11-13)

Der Simulator wird von Grund auf neu gebaut ([Konzept](docs/KONZEPT.md)). Der bisherige Code
ist entfernt und bleibt als Tag `v0.11.0` abrufbar.

- Neuer Aufbau in acht Paketen mit festen Schnittstellen; die Grenzen prüft der Linter.
- Darstellung auf WebGPU (three.js), mit Rückfall auf WebGL 2.
- Simulation mit festem Zeitschritt von 120 Hz, getrennt von der Bildrate.
- Koordinaten: WGS84, ECEF, lokales Bezugssystem, LV95.
- Geräteklassen Desktop und Mobil mit eigenem Budget; Bedienung mit Maus und Finger.
- Oberfläche mit Preact, Deutsch und Englisch.
- Bildvergleich fester Szenen im echten Browser (`npm run shots`).

Zu sehen ist eine Platzhalter-Szene: Himmel mit Sonnenstand, Bezugsraster, Bezugsmodell.

## v0.11.0 – Live-Wetter, Flugphysik, Triebwerksklang (2026-11-03)

### Neu

- **Live-Wetter mit Wind** (Open-Meteo): Wolken, Sicht, Temperatur und Wind wie gerade
  draussen. Der Wind versetzt das Flugzeug; angezeigt wird die Geschwindigkeit gegenüber der
  Luft, das Navigationsdisplay zeigt zusätzlich Grundgeschwindigkeit und Wind.
- **Flugverkehr**: simulierte Flugzeuge starten und landen gegen den Wind, fliegen Platzrunden
  und überfliegen die Gegend.
- **Flugphysik nach JSBSim / FlightGear**: weicher Übergang in den Strömungsabriss mit
  abkippendem Flügel, Auftriebsverzögerung bei schnellen Lagewechseln, mehr Auftrieb in
  Bodennähe, Propellerdrehmoment, Propellerstrahl und P-Faktor bei langsamer Fahrt,
  Triebwerke laufen verzögert hoch, Luftdichte mit Temperatur.
- **Triebwerksklang neu berechnet** statt gefiltertem Rauschen: Auspuffstösse und
  Propeller beim Kolbenmotor, sägender Propeller und Turbinenpfeifen beim Turboprop,
  Fan-Ton und tiefes Dröhnen beim Jet, Grollen und Knistern beim Nachbrenner der F-35.
- **Abstürze je nach Aufprall**: leichtes Aufsetzen, harter Aufprall oder Einschlag – das
  Flugzeug bricht entsprechend in wenige oder viele Teile, die über den Boden rutschen;
  kurz danach die Explosion. Eigener Klang für Aufprall, Bersten und Explosion.
- **Glühende Düse der F-35**: dunkelrot im Leerlauf, orange bei Vollgas; mit Nachbrenner
  eine lange Flamme mit Schockdiamanten.
- **Startklappen**: am Boden starten die Flugzeuge mit Klappen, die über 120 m über Grund
  automatisch einfahren. Die F-35 steuert ihre Klappen selbst.

### Verbessert

- **Startbildschirm in 8 s statt 46 s**, ohne Szenenwechsel nach dem Laden; das Flugzeug
  wird zuerst von der Seite gezeigt. Startorte laden direkt mit der richtigen Ausrichtung.
- Kein Stocken mehr beim Absturz.
- **Geschwindigkeitsanzeige** in angezeigter Fluggeschwindigkeit (IAS) wie im Cockpit;
  die Flugzeuge heben bei realistischem Tempo ab (C172 ~100 km/h, A320 ~250 km/h,
  F-35 ~235 km/h).
- **Lenkung am Boden** mit den Pfeiltasten links/rechts weicher und ohne Umkippen.
- **Aussenkamera** näher am Flugzeug und ohne Zurückfallen bei hoher Geschwindigkeit.
- **Minimap** immer nach Norden ausgerichtet.

## v0.10.0 – Wetter, Cockpits, Aussteigen (2026-10-30)

### Neu

- **Cockpits für alle sechs Flugzeuge** mit live laufenden Instrumenten: Rundinstrumente,
  Motoranzeigen und Funkgeräte in der C172; Glascockpits mit PFD, Navigationsdisplay,
  Motor- und Systemanzeigen in PC-12, Phenom, A320 und 747; Panoramadisplay in der F-35;
  Autopilot-Panel, MCDU und Overhead-Panel. Steuerhorn, Steuersäule, Sidestick und
  Schubhebel bewegen sich mit den Eingaben.
- **Abstürze**: Das Flugzeug zerbricht in seine Teile (Rumpf in drei Stücken, Flügel, Leitwerk,
  Fahrwerk, Triebwerke), die mit dem Aufprall wegfliegen, über das Gelände springen und
  verkohlen. Feuerball, Funken, Lichtblitz, brennende Trümmer und Rauchsäule; eine Kamera
  kreist um die Absturzstelle.
- **Aussteigen** (J, stehend am Boden): zu Fuss gehen und rennen, Ich- oder Aussenansicht (C),
  wieder einsteigen mit J.
- **Fallschirmsprung** (J im Flug): freier Fall, Schirm ziehen mit Leertaste oder J (öffnet
  automatisch auf 300 m über Grund), steuern, bremsen, abfangen. Die F-35 schiesst den
  Schleudersitz. Das leere Flugzeug fliegt weiter, bis es abstürzt.
- **Pilot als Blender-Figur** mit Skelett und Animationen für Stehen, Gehen, Rennen,
  freien Fall und Schirmflug.
- **Hochnebel und Bodennebel** als Wetter: das Nebelmeer über dem Mittelland, die Alpen
  darüber in der Sonne.
- **Echte 3D-Wolken** auf allen Qualitätsstufen, durch die man fliegen kann: Quell- und
  Schichtwolken mit Blumenkohl-Rändern, ungleichmässigen Basen und Windscherung; Licht mit
  Mehrfachstreuung, Silberrand gegen die Sonne und dunklen Bäuchen; Schatten auf dem Gelände.
- **Physikalische Atmosphäre** (Rayleigh- und Mie-Streuung): blaue Ferne, Dunst nach Wetter,
  Sonnenfarbe aus der Luftmasse – orange und rot bei tiefer Sonne.
- **Startbildschirm lädt direkt in die echte 3D-Szene** mit Fortschrittsbalken statt Video.

### Verbessert

- Ruckelfreie Bewegung: Das Flugzeug wird zwischen den Physikschritten (120 Hz) gezeichnet.
- Klare Sicht aus dem Cockpit: keine Himmelsspiegelung mehr als Schleier auf der Scheibe.
- Ruder, Fahrwerk und Propeller bewegen sich so weit wie vorgesehen (vorher doppelt).

### Entfernt

- Die generierten 3D-Bäume; echte Bäume bleiben auf den Luftbildern sichtbar.
- Das Video des Startbildschirms (3,3 MB weniger zu laden).

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
