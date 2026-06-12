// Glyph atlas: every (codepoint, color) pair is rasterized exactly once into an
// offscreen canvas; from then on the frame loop is pure drawImage blits
// (PRD §3.2). Slots are allocated lazily, so any unicode glyph works.

const COLS = 64;

export class GlyphAtlas {
  readonly cellW: number;
  readonly cellH: number;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private slots = new Map<number, number>(); // key -> slot index
  private count = 0;
  private rows = 32;
  private font: string;
  private cssCache = new Map<number, string>();

  constructor(cellW: number, cellH: number, font: string) {
    this.cellW = cellW;
    this.cellH = cellH;
    this.font = font;
    this.canvas = document.createElement('canvas');
    this.canvas.width = COLS * cellW;
    this.canvas.height = this.rows * cellH;
    this.ctx = this.mustCtx();
  }

  private mustCtx(): CanvasRenderingContext2D {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('atlas: no 2d context');
    return ctx;
  }

  css(color: number): string {
    let s = this.cssCache.get(color);
    if (!s) {
      s = `#${color.toString(16).padStart(6, '0')}`;
      this.cssCache.set(color, s);
    }
    return s;
  }

  private rasterize(glyph: number, color: number): number {
    const slot = this.count++;
    if ((Math.floor(slot / COLS) + 1) * this.cellH > this.canvas.height) {
      // Grow: double the atlas height, repaint the old contents.
      const old = this.canvas;
      this.rows *= 2;
      this.canvas = document.createElement('canvas');
      this.canvas.width = COLS * this.cellW;
      this.canvas.height = this.rows * this.cellH;
      this.ctx = this.mustCtx();
      this.ctx.drawImage(old, 0, 0);
    }
    const sx = (slot % COLS) * this.cellW;
    const sy = Math.floor(slot / COLS) * this.cellH;
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.rect(sx, sy, this.cellW, this.cellH);
    c.clip();
    c.font = this.font;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = this.css(color);
    c.fillText(String.fromCharCode(glyph), sx + this.cellW / 2, sy + this.cellH / 2 + 1);
    c.restore();
    return slot;
  }

  /** Blit one tinted glyph to dst at pixel (dx, dy). */
  draw(dst: CanvasRenderingContext2D, glyph: number, color: number, dx: number, dy: number): void {
    const key = glyph * 0x1000000 + color;
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = this.rasterize(glyph, color);
      this.slots.set(key, slot);
    }
    const sx = (slot % COLS) * this.cellW;
    const sy = Math.floor(slot / COLS) * this.cellH;
    dst.drawImage(this.canvas, sx, sy, this.cellW, this.cellH, dx, dy, this.cellW, this.cellH);
  }
}
