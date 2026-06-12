// Render-thread entry: owns the canvas, input, HUD, message log, and overlays.
// All simulation happens in the worker; this thread only draws and reacts.

import { Renderer } from './render/renderer';
import type { Action, FrameMeta, MainMsg, Msg, WorkerMsg } from './bridge/protocol';

const STATUS_FG = 0x6fa8b8;
const STATUS_DIM = 0x47616e;
const SEP_FG = 0x2a3138;
const LOG_FADE = [1.0, 0.85, 0.7, 0.58, 0.48, 0.4];
const LOG_ROWS = 6;

interface LogEntry { text: string; fg: number; count: number }
interface TextOverlay { title: string; lines: Msg[]; scroll: number }

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new Renderer(canvas);

const seed =
  new URLSearchParams(location.search).get('seed') ||
  Math.random().toString(36).slice(2, 10);

const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (m: MainMsg, transfer?: Transferable[]) =>
  worker.postMessage(m, transfer ?? []);

const view = {
  w: 0,
  h: 0,
  glyph: new Uint16Array(0),
  fg: new Uint32Array(0),
  bg: new Uint32Array(0),
};
let meta: FrameMeta | null = null;
let progressText = 'WAKING THE CITY…';
const log: LogEntry[] = [];
let helpOpen = false;
let perfOpen = false;
let textOverlay: TextOverlay | null = null;

let renderMsEma = 0;
let fps = 0;
let frameCount = 0;
let lastFpsAt = performance.now();

const mapTop = 1;
const mapH = () => renderer.rows - mapTop - LOG_ROWS - 1;

function pushLog(text: string, fg: number): void {
  const last = log[log.length - 1];
  if (last && last.text === text && last.fg === fg) {
    last.count++;
    return;
  }
  log.push({ text, fg, count: 1 });
  if (log.length > 200) log.splice(0, log.length - 200);
}

worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
  const m = e.data;
  if (m.t === 'progress') {
    progressText = m.text.toUpperCase();
    return;
  }
  if (m.t === 'text') {
    textOverlay = { title: m.title, lines: m.lines, scroll: 0 };
    return;
  }
  const n = m.w * m.h;
  if (view.glyph.length !== n) {
    view.glyph = new Uint16Array(n);
    view.fg = new Uint32Array(n);
    view.bg = new Uint32Array(n);
  }
  view.w = m.w;
  view.h = m.h;
  view.glyph.set(new Uint16Array(m.glyph));
  view.fg.set(new Uint32Array(m.fg));
  view.bg.set(new Uint32Array(m.bg));
  send({ t: 'ret', glyph: m.glyph, fg: m.fg, bg: m.bg }, [m.glyph, m.fg, m.bg]);
  meta = m.meta;
  for (const msg of m.meta.msgs) pushLog(msg.text, msg.fg);
};

send({ t: 'init', seed, viewW: renderer.cols, viewH: mapH() });

// --- input ---------------------------------------------------------------------

const MOVE_KEYS: Record<string, [number, number]> = {
  w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0],
  W: [0, -1], A: [-1, 0], S: [0, 1], D: [1, 0],
  ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowRight: [1, 0],
};

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'F9') {
    perfOpen = !perfOpen;
    e.preventDefault();
    return;
  }
  // Scrollable text overlay (journal / news) captures input while open.
  if (textOverlay) {
    const mv = MOVE_KEYS[e.key];
    if (e.key === 'Escape' || e.key === 'J' || e.key === 'N' || e.key === 'q') {
      textOverlay = null;
    } else if (mv && mv[1] !== 0) {
      const pageRows = renderer.rows - 8;
      const maxScroll = Math.max(0, textOverlay.lines.length - pageRows);
      textOverlay.scroll = Math.max(0, Math.min(maxScroll, textOverlay.scroll + mv[1] * 3));
    }
    e.preventDefault();
    return;
  }
  if (e.key === '?') {
    helpOpen = !helpOpen;
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape' && helpOpen) {
    helpOpen = false;
    e.preventDefault();
    return;
  }
  if (helpOpen) return;

  let action: Action | null = null;
  const mv = MOVE_KEYS[e.key];
  if (mv) action = { k: 'move', dx: mv[0], dy: mv[1] };
  else if (e.key === '.' || e.key === ' ' || e.key === 'Enter') action = { k: 'wait' };
  else if (e.key === 'e') action = { k: 'interact' };
  else if (e.key === 'g') action = { k: 'pickup' };
  else if (e.key === 'i') action = { k: 'inventory' };
  else if (e.key === 'c') action = { k: 'char' };
  else if (e.key === 'r') action = { k: 'rest' };
  else if (e.key === 't') action = { k: 'talk' };
  else if (e.key === 'f') action = { k: 'fire' };
  else if (e.key === 'v') action = { k: 'vault' };
  else if (e.key === 'x') action = { k: 'look' };
  else if (e.key === 'm' || e.key === 'M') action = { k: 'citymap' };
  else if (e.key === 'J' || e.key === 'j') action = { k: 'journal' };
  else if (e.key === 'N' || e.key === 'n') action = { k: 'news' };
  else if (e.key === 'Escape') action = { k: 'cancel' };
  if (action) {
    e.preventDefault();
    send({ t: 'act', a: action });
  }
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    renderer.layout();
    send({ t: 'resize', viewW: renderer.cols, viewH: mapH() });
  }, 120);
});

// --- composition -----------------------------------------------------------------

function dimmed(c: number, f: number): number {
  const r = ((c >>> 16) & 255) * f, g = ((c >>> 8) & 255) * f, b = (c & 255) * f;
  return (r << 16) | (g << 8) | b | 0;
}

function drawStatus(): void {
  const m = meta;
  renderer.fillBg(0, 0, renderer.cols - 1, 0, 0x0c1116);
  if (!m) return;
  if (m.mode === 'look' || m.mode === 'citymap' || m.mode === 'target') {
    const label = m.mode === 'look' ? 'LOOK' : m.mode === 'target' ? 'TARGET' : 'TRAVEL';
    renderer.write(1, 0, `${label}: ${m.lookText}`.slice(0, renderer.cols - 2), m.mode === 'target' ? 0xff7060 : 0xd8c850);
    return;
  }
  if (m.mode === 'menu') {
    renderer.write(1, 0, ' EMPIRE://36', STATUS_FG);
    return;
  }
  const hpFrac = m.maxHp > 0 ? m.hp / m.maxHp : 1;
  const hpBar = '▓'.repeat(Math.max(0, Math.round(hpFrac * 5))).padEnd(5, '░');
  const hpColor = hpFrac > 0.6 ? 0x70c070 : hpFrac > 0.3 ? 0xd8c850 : 0xc05a50;
  const left = ` EMPIRE://36 │ ${m.loc}`;
  const right = `$${m.money} (Σ$${m.worth}) │ ${m.clock} │ T${m.turn} `;
  const hpText = `HP ${hpBar} `;
  renderer.write(0, 0, left.slice(0, renderer.cols - right.length - hpText.length - 3), STATUS_FG);
  renderer.write(renderer.cols - right.length - hpText.length, 0, hpText, hpColor);
  renderer.write(renderer.cols - right.length, 0, right, STATUS_DIM);
}

function drawLog(): void {
  const sepY = renderer.rows - LOG_ROWS - 1;
  for (let x = 0; x < renderer.cols; x++) renderer.set(x, sepY, '─'.charCodeAt(0), SEP_FG);
  const tail = log.slice(-LOG_ROWS);
  for (let i = 0; i < tail.length; i++) {
    const entry = tail[i];
    const age = tail.length - 1 - i;
    const f = LOG_FADE[Math.min(age, LOG_FADE.length - 1)];
    const text = entry.count > 1 ? `${entry.text} (x${entry.count})` : entry.text;
    const y = renderer.rows - tail.length + i;
    renderer.write(1, y, text.slice(0, renderer.cols - 2), dimmed(entry.fg, f));
  }
}

function drawTextOverlay(o: TextOverlay): void {
  const x0 = 2, y0 = 1;
  const w = renderer.cols - 4;
  const h = renderer.rows - 3;
  renderer.fillBg(x0, y0, x0 + w - 1, y0 + h - 1, 0x0c0f15);
  for (let x = x0; x < x0 + w; x++) {
    renderer.set(x, y0, '─'.charCodeAt(0), STATUS_FG, 0x0c0f15);
    renderer.set(x, y0 + h - 1, '─'.charCodeAt(0), STATUS_FG, 0x0c0f15);
  }
  renderer.write(x0 + 2, y0, ` ${o.title} `, 0xd8c850, 0x0c0f15);
  const pageRows = h - 2;
  const visible = o.lines.slice(o.scroll, o.scroll + pageRows);
  for (let i = 0; i < visible.length; i++) {
    renderer.write(x0 + 2, y0 + 1 + i, visible[i].text.slice(0, w - 4), visible[i].fg || 0xa8a8b0, 0x0c0f15);
  }
  const more = o.lines.length > o.scroll + pageRows;
  const hint = `${o.scroll > 0 ? '↑' : ' '} w/s scroll · Esc close ${more ? '↓' : ' '}`;
  renderer.write(x0 + w - hint.length - 2, y0 + h - 1, ` ${hint} `, STATUS_DIM, 0x0c0f15);
}

function drawHelp(): void {
  const lines = [
    'EMPIRE://36 — how to read the street',
    '',
    'WASD / arrows   move · bump opens doors',
    '. or space      wait one turn · r rest awhile',
    'e               interact (doors, shrines, stations)',
    'g               pick up what you are standing on',
    'i               inventory · c who you are',
    't               talk to whoever is beside you',
    'f               fight: pick a target, pick a body part',
    'v               vault fences, cars, barricades',
    'x               examine (move cursor, x/Esc exits)',
    'm               city map & travel (e to go)',
    'J               the chronicle — what happened 2026-2036',
    'N               news & rumors',
    '?               toggle this help',
    'F9              performance overlay',
    '',
    `world seed: ${seed}`,
    'share this world: add ?seed=' + seed + ' to the URL',
  ];
  const w = Math.max(...lines.map((l) => l.length)) + 4;
  const h = lines.length + 2;
  const x0 = Math.max(0, (renderer.cols - w) >> 1);
  const y0 = Math.max(0, (renderer.rows - h) >> 1);
  renderer.fillBg(x0, y0, x0 + w - 1, y0 + h - 1, 0x10151c);
  for (let x = x0; x < x0 + w; x++) {
    renderer.set(x, y0, '─'.charCodeAt(0), STATUS_FG, 0x10151c);
    renderer.set(x, y0 + h - 1, '─'.charCodeAt(0), STATUS_FG, 0x10151c);
  }
  for (let i = 0; i < lines.length; i++) {
    renderer.write(x0 + 2, y0 + 1 + i, lines[i], i === 0 ? STATUS_FG : 0xb8c4cc, 0x10151c);
  }
}

function drawPerf(): void {
  const turnMs = meta ? meta.turnMs.toFixed(2) : '—';
  const text = ` render ${renderMsEma.toFixed(2)}ms │ turn ${turnMs}ms │ ${fps}fps │ ${renderer.blits} blits `;
  renderer.write(renderer.cols - text.length, 1, text, 0x50d0a0, 0x0c1410);
}

function frame(): void {
  const t0 = performance.now();
  renderer.clearGrid();
  if (meta) {
    renderer.blit(view, 0, mapTop);
    drawStatus();
    drawLog();
  } else {
    const msg = progressText;
    renderer.write((renderer.cols - msg.length) >> 1, renderer.rows >> 1, msg, STATUS_FG);
  }
  if (textOverlay) drawTextOverlay(textOverlay);
  if (helpOpen) drawHelp();
  if (perfOpen) drawPerf();
  renderer.render();

  const dt = performance.now() - t0;
  renderMsEma = renderMsEma === 0 ? dt : renderMsEma * 0.92 + dt * 0.08;
  frameCount++;
  const now = performance.now();
  if (now - lastFpsAt >= 1000) {
    fps = Math.round((frameCount * 1000) / (now - lastFpsAt));
    frameCount = 0;
    lastFpsAt = now;
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
