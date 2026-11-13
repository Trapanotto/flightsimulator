# Trapanotto Flight Simulator

Flugsimulator im Browser über der echten Schweiz – per Link spielbar, ohne Installation.

**Stand: Neuaufbau.** Der Simulator entsteht von Grund auf neu (Version 1). Unter
<https://trapanotto.github.io/flightsimulator/> läuft der jeweilige Zwischenstand. Die
bisherige Version ist als Tag [`v0.11.0`](../../tree/v0.11.0) abrufbar.

- [Konzept](docs/KONZEPT.md) – was gebaut wird, in welchen Phasen
- [Architektur](docs/ARCHITEKTUR.md) – Aufbau, Regeln, Prüfbefehle

## Entwickeln

```bash
npm install
npm run dev
```

```bash
npm run check
```

Technik: TypeScript, three.js auf WebGPU (Rückfall WebGL 2), Preact, Vite. Geodaten von
swisstopo.

## Lizenz

MIT, siehe [LICENSE](LICENSE). Geodaten © swisstopo.
