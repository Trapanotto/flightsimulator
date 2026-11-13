// Contact sheet: tiles screenshots (halved) into one PNG to compare a sequence at a glance.
//   node tools/sky/sheet.mjs out.png columns a.png b.png ...
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [out, cols, ...files] = process.argv.slice(2);
const images = files.map((f) => PNG.sync.read(readFileSync(f)));
const w = Math.floor(images[0].width / 2);
const h = Math.floor(images[0].height / 2);
const columns = Number(cols);
const rows = Math.ceil(images.length / columns);
const sheet = new PNG({ width: w * columns, height: h * rows });
images.forEach((img, n) => {
  const ox = (n % columns) * w;
  const oy = Math.floor(n / columns) * h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        // Box filter 2x2.
        let sum = 0;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ])
          sum += img.data[((y * 2 + dy) * img.width + x * 2 + dx) * 4 + c];
        sheet.data[((oy + y) * sheet.width + ox + x) * 4 + c] = Math.round(sum / 4);
      }
});
writeFileSync(out, PNG.sync.write(sheet));
