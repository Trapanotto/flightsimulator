/**
 * Round minimap from the swisstopo national map (ch.swisstopo.pixelkarte-farbe, Web Mercator
 * tiles). North up, aircraft arrow in the centre rotates with the heading. `M` makes it large.
 */

const TEMPLATE =
  'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg';
const TILE = 256;

export class Minimap {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tiles = new Map<string, HTMLImageElement>();
  private large = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'minimap';
    this.el.innerHTML = `<canvas></canvas><div class="mm-north">N</div><div class="mm-arrow"></div>`;
    parent.appendChild(this.el);
    this.canvas = this.el.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.el.addEventListener('click', () => this.toggle());
  }

  toggle() {
    this.large = !this.large;
    this.el.classList.toggle('large', this.large);
  }

  private tile(z: number, x: number, y: number): HTMLImageElement | null {
    const key = `${z}/${x}/${y}`;
    let img = this.tiles.get(key);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = TEMPLATE.replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
      this.tiles.set(key, img);
      // Small cache: forget the oldest tiles.
      if (this.tiles.size > 120) this.tiles.delete(this.tiles.keys().next().value!);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  /** Draws the map around lon/lat; heading in degrees. */
  update(lon: number, lat: number, headingDeg: number, altitude: number) {
    const size = this.el.clientWidth;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (this.canvas.width !== Math.round(size * dpr)) {
      this.canvas.width = this.canvas.height = Math.round(size * dpr);
    }
    // Zoom out with altitude: z13 low, z10 high up; the large map shows more.
    const z = Math.max(
      9,
      Math.min(13, Math.round(13.6 - Math.log2(Math.max(altitude, 300) / 600))) -
        (this.large ? 1 : 0),
    );
    const n = 2 ** z;
    const px = ((lon + 180) / 360) * n * TILE;
    const r = (lat * Math.PI) / 180;
    const py = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * TILE;
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#d9d6cc';
    c.fillRect(0, 0, size, size);
    const half = size / 2;
    const x0 = Math.floor((px - half) / TILE);
    const x1 = Math.floor((px + half) / TILE);
    const y0 = Math.floor((py - half) / TILE);
    const y1 = Math.floor((py + half) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const img = this.tile(z, tx, ty);
        if (img) c.drawImage(img, tx * TILE - px + half, ty * TILE - py + half, TILE, TILE);
      }
    }
    this.el.style.setProperty('--heading', `${headingDeg}deg`);
  }
}
