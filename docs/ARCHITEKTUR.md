# Architektur

Wie der Code aufgebaut ist und welche Regeln für alle gelten, die daran arbeiten – Menschen wie
Agenten. Das Warum steht in [KONZEPT.md](KONZEPT.md).

## Pakete

Der Code liegt in `src/`, geteilt in acht Pakete. Jedes hat eine `index.ts`: das ist seine
öffentliche Schnittstelle. Alles andere im Ordner ist privat.

| Paket      | Inhalt                                                    | darf importieren            |
| ---------- | --------------------------------------------------------- | --------------------------- |
| `sim`      | Flugmodell, Triebwerke, Systeme, Luft, fester Zeitschritt | nichts (auch kein three.js) |
| `geo`      | Koordinaten, lokale Bezugssysteme, Kacheln, Datenquellen  | nichts (auch kein three.js) |
| `sky`      | Himmel, Sonne, Mond, Wolken, Wetter, Tageszeit            | nichts                      |
| `world`    | Gelände, Bäume, Gebäude, Wasser, Flugplätze               | `geo`                       |
| `aircraft` | 3D-Modelle, Cockpit, Avionik-Anzeigen                     | `sim`                       |
| `audio`    | Triebwerk, Wind, Funk                                     | `sim`                       |
| `ui`       | Menü, Flugplanung, Anzeigen (Preact)                      | alle ausser `app`           |
| `app`      | Zusammenbau: Renderer, Schleife, Eingabe, Ablauf          | alle                        |

Regeln, vom Linter erzwungen (`eslint.config.js`, geprüft in `tests/architecture.test.ts`):

- Andere Pakete nur über ihren Alias importieren: `import { FixedStep } from '@sim'` – nie
  `@sim/fixedStep` und nie `../sim/...`.
- Innerhalb eines Pakets mit relativen Pfaden importieren.
- Nur die Abhängigkeiten aus der Tabelle. Braucht ein Paket etwas aus einem anderen, das nicht
  erlaubt ist, gehört die Verbindung in `app` (über eine Schnittstelle), nicht in das Paket.
- `sim` und `geo` laufen ohne Browser und ohne Renderer; sie werden in Node getestet.

`ui` spricht mit dem Rest über Signale (`status` in `src/ui/state.ts`) und Rückrufe. `app`
schreibt die Signale, Komponenten lesen sie. Die Oberfläche greift nie in Renderer oder
Simulation.

## Koordinaten

- **Welt (Simulation):** ECEF in Metern (WGS84), doppelte Genauigkeit. Körperachsen eines
  Flugzeugs: x vorwärts, y rechts, z unten.
- **Darstellung:** ein lokales Bezugssystem (`LocalFrame` in `geo`): x Ost, y oben, z Süd.
  Sein Ursprung folgt der Kamera (verschiebbarer Ursprung), weil die Grafikkarte nur einfach
  genau rechnet. Ein 3D-Modell hat x links, y oben, z vorwärts.
- **Geografisch:** Länge und Breite in Grad, Höhe in Metern über dem Ellipsoid.
- **Simulation und Welt** begegnen sich nur über `Environment` (`src/sim/types.ts`): lokale
  Senkrechte, Luft, Boden.

## Zeit

Die Simulation läuft mit festem Schritt von 120 Hz (`FixedStep`), unabhängig von der Bildrate.
Die Darstellung blendet zwischen zwei Schritten. Nichts in `sim` liest die Uhr oder
`Math.random()` ohne festen Startwert: ein Flug muss wiederholbar sein.

## Geräte

`src/app/device.ts` kennt zwei Klassen, Desktop und Mobil, mit je einem Budget
(`DeviceProfile`). Jede Grafiktechnik liest ihre Grenzen von dort und hat von Anfang an eine
leichte Variante. Bedienung funktioniert immer mit Maus und Finger.

## Grafik

- three.js mit `WebGPURenderer` (`three/webgpu`), Materialien als Knoten (`three/tsl`). Keine
  eingespritzten Shader-Texte, kein `onBeforeCompile`.
- Ohne WebGPU fällt der Renderer von selbst auf WebGL 2 zurück (`?webgl=1` erzwingt das zum
  Testen). Neue Technik muss dort laufen oder sauber abgeschaltet sein.
- Alle Farben und Helligkeiten physikalisch und vor der Tonwertkorrektur; ein Lichtmodell für
  alles.

## Prüfen

| Befehl                 | prüft                                                                      |
| ---------------------- | -------------------------------------------------------------------------- |
| `npm run check`        | Typen, Lint (inkl. Paketgrenzen), Tests                                    |
| `npm test`             | Tests in `tests/` (Node, ohne Browser)                                     |
| `npm run shots`        | Bildvergleich fester Szenen im echten Browser gegen `tests/shots/baseline` |
| `npm run shots:update` | speichert neue Vergleichsbilder nach einer gewollten Änderung              |
| `npm run build`        | Typen und Produktions-Build                                                |

Der Bildvergleich braucht eine Grafikkarte und läuft deshalb lokal, nicht in der
Veröffentlichung. Neue Szenen kommen in die Liste in `tools/shots.mjs`; jede wird mit `?shot=1`
gezeichnet (feste Zeit, feste Kamera, kein wechselnder Text).

Schalter in der Adresse zum Testen: `?device=mobile|desktop`, `?webgl=1`,
`?t=2026-06-21T10:00Z`, `?shot=1`. Die Seite legt unter `window.__app` Renderer, Szene und
Kamera für Tests offen.

## Schreibweise

- Code, Kommentare und Commit-Texte auf Englisch; Dokumente in `docs/` und Texte im Spiel
  auf Deutsch und Englisch (`src/ui/i18n.ts`, beide Sprachen immer vollständig).
- Kommentare sagen, warum etwas so ist, nicht was die Zeile tut.
- Formatierung mit Prettier (`npm run format`).
