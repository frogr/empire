// Full-grid glyph renderer. Owns the visible grid as typed arrays; every frame
// is background fillRects (run-batched per row) + foreground atlas blits.
// Budget: < 4 ms per frame (PRD §3.3).

import { GlyphAtlas } from './atlas';

const CLEAR = '#08080c';
const FONT_STACK = '"Menlo", "Consolas", "DejaVu Sans Mono", monospace';
const CELL_H_CSS = 20;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private atlas!: GlyphAtlas;
  cellW = 0;
  cellH = 0;
  cols = 0;
  rows = 0;
  glyph = new Uint16Array(0);
  fg = new Uint32Array(0);
  bg = new Uint32Array(0);
  blits = 0; // drawImage count last frame, for the perf overlay

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('renderer: no 2d context');
    this.ctx = ctx;
    this.layout();
  }

  /** Recompute cell metrics and grid dimensions from the window size. */
  layout(): void {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const cellH = Math.round(CELL_H_CSS * dpr);
    const fontPx = Math.floor(cellH * 0.92);
    const font = `${fontPx}px ${FONT_STACK}`;
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = font;
    const cellW = Math.ceil(probe.measureText('M').width);

    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;

    if (!this.atlas || this.cellW !== cellW || this.cellH !== cellH) {
      this.atlas = new GlyphAtlas(cellW, cellH, font);
    }
    this.cellW = cellW;
    this.cellH = cellH;
    this.cols = Math.max(40, Math.floor(w / cellW));
    this.rows = Math.max(20, Math.floor(h / cellH));
    const n = this.cols * this.rows;
    this.glyph = new Uint16Array(n);
    this.fg = new Uint32Array(n);
    this.bg = new Uint32Array(n);
  }

  clearGrid(): void {
    this.glyph.fill(0);
    this.fg.fill(0);
    this.bg.fill(0);
  }

  set(x: number, y: number, glyph: number, fg: number, bg = 0): void {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    const i = y * this.cols + x;
    this.glyph[i] = glyph;
    this.fg[i] = fg;
    if (bg) this.bg[i] = bg;
  }

  write(x: number, y: number, text: string, fg: number, bg = 0): void {
    for (let k = 0; k < text.length && x + k < this.cols; k++) {
      const i = y * this.cols + x + k;
      if (i < 0 || i >= this.glyph.length) return;
      this.glyph[i] = text.charCodeAt(k);
      this.fg[i] = fg;
      if (bg) this.bg[i] = bg;
    }
  }

  fillBg(x0: number, y0: number, x1: number, y1: number, bg: number): void {
    for (let y = Math.max(0, y0); y <= Math.min(this.rows - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(this.cols - 1, x1); x++) {
        this.bg[y * this.cols + x] = bg;
      }
    }
  }

  /** Copy a w×h block of worker view buffers into the grid at (dx, dy). */
  blit(src: { w: number; h: number; glyph: Uint16Array; fg: Uint32Array; bg: Uint32Array }, dx: number, dy: number): void {
    const w = Math.min(src.w, this.cols - dx);
    for (let y = 0; y < src.h && dy + y < this.rows; y++) {
      const si = y * src.w;
      const di = (dy + y) * this.cols + dx;
      this.glyph.set(src.glyph.subarray(si, si + w), di);
      this.fg.set(src.fg.subarray(si, si + w), di);
      this.bg.set(src.bg.subarray(si, si + w), di);
    }
  }

  /** Draw the whole grid to the canvas. */
  render(): void {
    const { ctx, cols, rows, cellW, cellH } = this;
    ctx.fillStyle = CLEAR;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Background: batch runs of identical color per row into single fillRects.
    for (let y = 0; y < rows; y++) {
      const base = y * cols;
      let x = 0;
      while (x < cols) {
        const c = this.bg[base + x];
        if (c === 0) { x++; continue; }
        let end = x + 1;
        while (end < cols && this.bg[base + end] === c) end++;
        ctx.fillStyle = this.atlas.css(c);
        ctx.fillRect(x * cellW, y * cellH, (end - x) * cellW, cellH);
        x = end;
      }
    }

    // Foreground: one atlas blit per visible glyph.
    let blits = 0;
    for (let y = 0; y < rows; y++) {
      const base = y * cols;
      for (let x = 0; x < cols; x++) {
        const g = this.glyph[base + x];
        if (g === 0 || g === 32) continue;
        this.atlas.draw(ctx, g, this.fg[base + x], x * cellW, y * cellH);
        blits++;
      }
    }
    this.blits = blits;
  }
}
