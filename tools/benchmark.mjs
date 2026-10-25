// Graphics benchmark: flies the test route for each quality preset in headless Edge/Chrome
// (real GPU) and writes docs/BENCHMARK.md.
// Usage: npm run benchmark -- [seconds=60] [base=http://localhost:5180/flightsimulator/]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [seconds = '60', base = 'http://localhost:5180/flightsimulator/'] = process.argv.slice(2);
const [vw, vh] = (process.env.VIEWPORT ?? '1920x1080').split('x').map(Number);
const presets = ['low', 'medium', 'high', 'ultra'];
const browser = await chromium.launch({
  executablePath: process.env.BROWSER ?? '/usr/bin/microsoft-edge',
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist'],
});

let gpu = '';
const rows = [];
for (const preset of presets) {
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  await page.goto(`${base}?debug&route=500&quality=${preset}&t=golden&weather=fair`);
  await page.click('[data-action="preview"]');
  await page.waitForFunction(() => window.__world?.terrain, null, { timeout: 30_000 });
  gpu ||= await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  // Warm-up: the start area streams in.
  await page.waitForTimeout(12_000);
  const samples = await page.evaluate(async (secs) => {
    const out = [];
    for (let i = 0; i < secs; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = window.__world.stats();
      out.push({
        fps: s.fps,
        pixelRatio: s.pixelRatio,
        tiles: s.tilesRendered,
        worst: s.worstFrameMs,
        cov: s.coverage,
      });
    }
    return out;
  }, Number(seconds));
  const avg = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
  const sorted = samples.map((s) => s.fps).sort((a, b) => a - b);
  const row = {
    preset,
    fps: avg('fps'),
    p10: sorted[Math.floor(sorted.length * 0.1)],
    scale: avg('scale'),
    tiles: avg('tiles'),
    worst: Math.max(...samples.map((s) => s.worst)),
    coverage: Math.min(...samples.map((s) => s.cov)),
  };
  rows.push(row);
  console.log(
    `${preset.padEnd(7)} fps ${row.fps.toFixed(1)} (10 % ≤ ${row.p10.toFixed(0)}) scale ${(row.scale * 100).toFixed(0)} % tiles ${row.tiles.toFixed(0)} worst ${row.worst.toFixed(0)} ms detail ≥ ${(row.coverage * 100).toFixed(0)} %`,
  );
  await page.close();
}
await browser.close();

const date = new Date().toISOString().slice(0, 10);
const md = `# Benchmark

Automatisch erzeugt mit \`npm run benchmark\` am ${date}.

- GPU: ${gpu}
- Auflösung: ${vw}×${vh}, Edge headless (echte GPU)
- Szene: Testflug Genf → Lausanne mit 500 km/h, Goldene Stunde, heiter; ${seconds} s Messung nach 12 s Aufwärmen
- «Auflösung» ist der Mittelwert der dynamischen Auflösung (Anteil der vollen Pixelzahl je Achse)

| Stufe | Ø FPS | 10 % der Sekunden unter | Ø Auflösung | Ø Kacheln | Längster Frame | Detail min. |
|---|---|---|---|---|---|---|
${rows
  .map(
    (r) =>
      `| ${r.preset} | ${r.fps.toFixed(1)} | ${r.p10.toFixed(0)} FPS | ${(r.scale * 100).toFixed(0)} % | ${r.tiles.toFixed(0)} | ${r.worst.toFixed(0)} ms | ${(r.coverage * 100).toFixed(0)} % |`,
  )
  .join('\n')}

Hinweis: Laptops drosseln je nach Energiemodus und Temperatur. Vergleichbar sind Werte aus
demselben Lauf; zwischen Läufen an verschiedenen Tagen können sie um 10–20 % schwanken.
`;
writeFileSync('docs/BENCHMARK.md', md);
console.log('\nwrote docs/BENCHMARK.md');
