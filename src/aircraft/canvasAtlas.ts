/**
 * Displays painted into a canvas: one canvas holds several windows (regions). Each window is
 * redrawn only when what it shows changes (`content` builds a key from the shown values,
 * quantised to what a pixel can show), and the texture is flagged for upload at most `maxHz`
 * times a second: displays cost little however many frames are drawn.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasPainter<Id extends string, D> {
  /** Canvas size at scale 1 and the windows in it. */
  readonly width: number;
  readonly height: number;
  readonly regions: Readonly<Record<Id, Rect>>;
  /** What a window shows, as a string: equal keys mean an equal picture. */
  content(id: Id, data: D): string;
  /** Paints a window into the context (already translated and clipped to its region). */
  paint(c: CanvasRenderingContext2D, id: Id, w: number, h: number, key: string, data: D): void;
  /**
   * Windows that change continuously (a moving map, an attitude): once painted, they wait
   * for the next upload slot instead of being repainted at every change.
   */
  readonly throttled?: readonly Id[];
  /** Colour of the canvas before anything is painted. */
  readonly background?: string;
}

export class CanvasAtlas<Id extends string, D> {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly keys = new Map<Id, string>();
  private readonly ids: Id[];
  private dirty = false;
  private sinceUpload = Infinity;

  constructor(
    private readonly painter: AtlasPainter<Id, D>,
    readonly scale: number,
    private readonly maxHz = 6,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(painter.width * scale);
    this.canvas.height = Math.round(painter.height * scale);
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.fillStyle = painter.background ?? '#030303';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ids = Object.keys(painter.regions) as Id[];
  }

  /** UV rectangle of a window (u0, v0 at the top left; flipY is off). */
  uvRect(id: Id): { u0: number; v0: number; u1: number; v1: number } {
    const r = this.painter.regions[id];
    const W = this.painter.width;
    const H = this.painter.height;
    return { u0: r.x / W, v0: r.y / H, u1: (r.x + r.w) / W, v1: (r.y + r.h) / H };
  }

  /** Repaints what changed; true when the texture should be uploaded now. */
  update(dt: number, data: D): boolean {
    this.sinceUpload += dt;
    const throttled = this.painter.throttled;
    for (const id of this.ids) {
      const key = this.painter.content(id, data);
      if (this.keys.get(id) === key) continue;
      if (throttled?.includes(id) && this.keys.has(id) && this.sinceUpload < 1 / this.maxHz)
        continue;
      this.keys.set(id, key);
      const r = this.painter.regions[id];
      const c = this.ctx;
      c.save();
      c.translate(r.x * this.scale, r.y * this.scale);
      c.beginPath();
      c.rect(0, 0, r.w * this.scale, r.h * this.scale);
      c.clip();
      this.painter.paint(c, id, r.w * this.scale, r.h * this.scale, key, data);
      c.restore();
      this.dirty = true;
    }
    if (this.dirty && this.sinceUpload >= 1 / this.maxHz) {
      this.dirty = false;
      this.sinceUpload = 0;
      return true;
    }
    return false;
  }
}
