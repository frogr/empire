// Render-thread entry: title/auth/settings shell around the game, plus HUD,
// message log, overlays, autosave, and the CRT pass. All simulation happens in
// the worker; this thread draws, captures input, and talks to the server.

import { Renderer } from './render/renderer';
import { CrtPass } from './render/crt';
import type { Action, FrameMeta, MainMsg, Msg, SaveMeta, WorkerMsg } from './bridge/protocol';

const STATUS_FG = 0x6fa8b8;
const STATUS_DIM = 0x47616e;
const SEP_FG = 0x2a3138;
const LOG_FADE = [1.0, 0.85, 0.7, 0.58, 0.48, 0.4];
const LOG_ROWS = 6;
const LS = {
  save: 'empire36.save0',
  saveMeta: 'empire36.save0.meta',
  crt: 'empire36.crt',
  onboarded: 'empire36.onboarded',
};

interface LogEntry { text: string; fg: number; count: number }
interface TextOverlay { title: string; lines: Msg[]; scroll: number }

type Shell = 'title' | 'auth' | 'settings' | 'game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const crt = new CrtPass(canvas);
crt.setEnabled(localStorage.getItem(LS.crt) === '1');

// --- shell state -----------------------------------------------------------------
let shell: Shell = 'title';
let titleSel = 0;
let settingsSel = 0;
let authMode: 'login' | 'register' = 'login';
let authField = 0; // 0 username, 1 password
let authUser = '';
let authPass = '';
let authError = '';
let authBusy = false;
let username: string | null = null;
let onboarding = false;

let worker: Worker | null = null;
let seed = new URLSearchParams(location.search).get('seed') || '';
const view = { w: 0, h: 0, glyph: new Uint16Array(0), fg: new Uint32Array(0), bg: new Uint32Array(0) };
let meta: FrameMeta | null = null;
let progressText = '';
const log: LogEntry[] = [];
let helpOpen = false;
let perfOpen = false;
let textOverlay: TextOverlay | null = null;
let lastSavedTurn = -1;
let saveBusy = false;

let renderMsEma = 0;
let fps = 0;
let frameCount = 0;
let lastFpsAt = performance.now();

const mapTop = 1;
const mapH = () => renderer.rows - mapTop - LOG_ROWS - 1;

// --- server api --------------------------------------------------------------------
const api = {
  async me(): Promise<string | null> {
    try {
      const r = await fetch('/api/me');
      if (!r.ok) return null;
      return (await r.json()).user ?? null;
    } catch {
      return null;
    }
  },
  async auth(kind: 'login' | 'register', user: string, pass: string): Promise<string | null> {
    const r = await fetch(`/api/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    if (r.ok) return null;
    const body = await r.json().catch(() => ({}));
    return body.error ?? `error ${r.status}`;
  },
  async logout(): Promise<void> {
    await fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
  },
  async getSave(): Promise<ArrayBuffer | null> {
    try {
      const r = await fetch('/api/saves/0');
      if (!r.ok) return null;
      return await r.arrayBuffer();
    } catch {
      return null;
    }
  },
  async putSave(data: ArrayBuffer, m: SaveMeta): Promise<void> {
    await fetch('/api/saves/0', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-save-version': String(m.version),
        'x-save-char': m.charName,
        'x-save-networth': String(m.networth),
        'x-save-alive': m.alive ? '1' : '0',
      },
      body: data,
    }).catch(() => undefined);
  },
  async recordRun(m: SaveMeta): Promise<void> {
    await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: m.seed, char_name: m.charName, networth: m.networth, cause: 'session', turns: m.turn }),
    }).catch(() => undefined);
  },
};

void api.me().then((u) => { username = u; });

// --- local save helpers --------------------------------------------------------------
function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

function b64ToBuf(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function localSaveMeta(): SaveMeta | null {
  try {
    return JSON.parse(localStorage.getItem(LS.saveMeta) ?? 'null');
  } catch {
    return null;
  }
}

// --- worker lifecycle ------------------------------------------------------------------
function send(m: MainMsg, transfer?: Transferable[]): void {
  worker?.postMessage(m, transfer ?? []);
}

function pushLog(text: string, fg: number): void {
  const last = log[log.length - 1];
  if (last && last.text === text && last.fg === fg) {
    last.count++;
    return;
  }
  log.push({ text, fg, count: 1 });
  if (log.length > 200) log.splice(0, log.length - 200);
}

function bootWorker(): Worker {
  const w = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<WorkerMsg>) => {
    const m = e.data;
    if (m.t === 'progress') {
      progressText = m.text.toUpperCase();
      return;
    }
    if (m.t === 'text') {
      textOverlay = { title: m.title, lines: m.lines, scroll: 0 };
      return;
    }
    if (m.t === 'saved') {
      try {
        localStorage.setItem(LS.save, bufToB64(m.data));
        localStorage.setItem(LS.saveMeta, JSON.stringify(m.meta));
      } catch { /* quota — server copy still goes out */ }
      if (username) void api.putSave(m.data, m.meta);
      saveBusy = false;
      return;
    }
    if (m.t === 'loaderr') {
      progressText = '';
      shell = 'title';
      authError = `save did not load: ${m.error.slice(0, 60)}`;
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
  return w;
}

function startNewGame(): void {
  seed = seed || Math.random().toString(36).slice(2, 10);
  meta = null;
  log.length = 0;
  progressText = 'WAKING THE CITY…';
  worker?.terminate();
  worker = bootWorker();
  shell = 'game';
  send({ t: 'init', seed, viewW: renderer.cols, viewH: mapH() });
  if (!localStorage.getItem(LS.onboarded)) onboarding = true;
}

async function continueGame(): Promise<void> {
  progressText = 'FINDING YOUR SAVE…';
  shell = 'game';
  meta = null;
  log.length = 0;
  let data: ArrayBuffer | null = null;
  if (username) data = await api.getSave();
  if (!data) {
    const local = localStorage.getItem(LS.save);
    if (local) data = b64ToBuf(local);
  }
  if (!data) {
    shell = 'title';
    authError = 'no save found anywhere';
    return;
  }
  worker?.terminate();
  worker = bootWorker();
  send({ t: 'load', data, viewW: renderer.cols, viewH: mapH() }, [data]);
}

function requestSave(): void {
  if (!worker || !meta || saveBusy || shell !== 'game') return;
  if (meta.turn === lastSavedTurn) return;
  lastSavedTurn = meta.turn;
  saveBusy = true;
  send({ t: 'save' });
}

setInterval(requestSave, 40_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') requestSave();
});

// --- input -----------------------------------------------------------------------------
const MOVE_KEYS: Record<string, [number, number]> = {
  w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0],
  W: [0, -1], A: [-1, 0], S: [0, 1], D: [1, 0],
  ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowRight: [1, 0],
};

const TITLE_ITEMS = () => [
  { label: 'Continue', enabled: !!localSaveMeta() || !!username },
  { label: 'New world', enabled: true },
  { label: username ? `Logged in as ${username}` : 'Login / register', enabled: !username },
  { label: 'Settings', enabled: true },
  { label: 'How to read the screen', enabled: true },
];

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'F9') { perfOpen = !perfOpen; e.preventDefault(); return; }
  if (e.key === 'F10') {
    const on = !crt.enabled;
    crt.setEnabled(on);
    localStorage.setItem(LS.crt, on ? '1' : '0');
    e.preventDefault();
    return;
  }
  switch (shell) {
    case 'title': return handleTitleKeys(e);
    case 'auth': return handleAuthKeys(e);
    case 'settings': return handleSettingsKeys(e);
    case 'game': return handleGameKeys(e);
  }
});

function handleTitleKeys(e: KeyboardEvent): void {
  const items = TITLE_ITEMS();
  e.preventDefault();
  const mv = MOVE_KEYS[e.key];
  if (mv && mv[1] !== 0) {
    do {
      titleSel = (titleSel + mv[1] + items.length) % items.length;
    } while (!items[titleSel].enabled);
    return;
  }
  if (e.key === 'e' || e.key === 'Enter' || e.key === ' ') {
    authError = '';
    switch (titleSel) {
      case 0: void continueGame(); break;
      case 1: startNewGame(); break;
      case 2: shell = 'auth'; authUser = ''; authPass = ''; authField = 0; break;
      case 3: shell = 'settings'; settingsSel = 0; break;
      case 4: onboarding = true; break;
    }
  }
}

function handleAuthKeys(e: KeyboardEvent): void {
  e.preventDefault();
  if (authBusy) return;
  if (e.key === 'Escape') { shell = 'title'; return; }
  if (e.key === 'Tab' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    authField = 1 - authField;
    return;
  }
  if (e.key === 'F2') {
    authMode = authMode === 'login' ? 'register' : 'login';
    authError = '';
    return;
  }
  if (e.key === 'Enter') {
    if (!authUser || !authPass) { authError = 'both fields, please'; return; }
    authBusy = true;
    authError = 'talking to the city…';
    void api.auth(authMode, authUser, authPass).then(async (err) => {
      authBusy = false;
      if (err) { authError = err; return; }
      username = await api.me();
      authError = '';
      shell = 'title';
      titleSel = 0;
    });
    return;
  }
  if (e.key === 'Backspace') {
    if (authField === 0) authUser = authUser.slice(0, -1);
    else authPass = authPass.slice(0, -1);
    return;
  }
  if (e.key.length === 1 && /[\x20-\x7e]/.test(e.key)) {
    if (authField === 0 && authUser.length < 24 && /[a-z0-9_]/.test(e.key.toLowerCase())) {
      authUser += e.key.toLowerCase();
    } else if (authField === 1 && authPass.length < 64) {
      authPass += e.key;
    }
  }
}

function handleSettingsKeys(e: KeyboardEvent): void {
  e.preventDefault();
  const count = username ? 3 : 2;
  if (e.key === 'Escape') { shell = 'title'; return; }
  const mv = MOVE_KEYS[e.key];
  if (mv && mv[1] !== 0) {
    settingsSel = (settingsSel + mv[1] + count) % count;
    return;
  }
  if (e.key === 'e' || e.key === 'Enter' || e.key === ' ') {
    if (settingsSel === 0) {
      const on = !crt.enabled;
      crt.setEnabled(on);
      localStorage.setItem(LS.crt, on ? '1' : '0');
    } else if (settingsSel === 1) {
      shell = 'title';
    } else if (settingsSel === 2 && username) {
      void api.logout().then(() => { username = null; shell = 'title'; });
    }
  }
}

function handleGameKeys(e: KeyboardEvent): void {
  if (textOverlay) {
    const mv = MOVE_KEYS[e.key];
    if (e.key === 'Escape' || e.key === 'J' || e.key === 'N' || e.key === 'q') textOverlay = null;
    else if (mv && mv[1] !== 0) {
      const pageRows = renderer.rows - 8;
      const maxScroll = Math.max(0, textOverlay.lines.length - pageRows);
      textOverlay.scroll = Math.max(0, Math.min(maxScroll, textOverlay.scroll + mv[1] * 3));
    }
    e.preventDefault();
    return;
  }
  if (onboarding) {
    onboarding = false;
    localStorage.setItem(LS.onboarded, '1');
    e.preventDefault();
    return;
  }
  if (e.key === '?') { helpOpen = !helpOpen; e.preventDefault(); return; }
  if (e.key === 'Escape' && helpOpen) { helpOpen = false; e.preventDefault(); return; }
  if (helpOpen) return;
  if (e.key === 'Q' && e.shiftKey) {
    // Quit to title; the autosave keeps the city where you left it.
    requestSave();
    shell = 'title';
    e.preventDefault();
    return;
  }

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
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    renderer.layout();
    if (shell === 'game') send({ t: 'resize', viewW: renderer.cols, viewH: mapH() });
  }, 120);
});

// --- drawing ----------------------------------------------------------------------------
function dimmed(c: number, f: number): number {
  const r = ((c >>> 16) & 255) * f, g = ((c >>> 8) & 255) * f, b = (c & 255) * f;
  return (r << 16) | (g << 8) | b | 0;
}

const TITLE_ART = [
  '▄████▄ ██▄  ██▄ ██▄▄▄▄ ██ ▄████▄ ▄████▄    ██  ██  ▄█▄ ▄████▄',
  '██▄▄   ██ █ █ █ ██   █ ██ ██  ██ ██▄▄      ██  ██   █  ██  ██',
  '██▀▀   ██ ▀█▀ █ ██▀▀▀▀ ██ ██▀██▀ ██▀▀  ▄▄  ▀█▄▄█▀  ▄█▄ ██▄▄██',
  '▀████▀ ██  ▀  █ ██     ██ ██  ██ ▀████▀ ██   ▀▀    ▀█▀ ▀████▀',
];

function drawTitle(): void {
  const cx = renderer.cols >> 1;
  let y = Math.max(2, (renderer.rows >> 1) - 12);
  for (const line of TITLE_ART) {
    renderer.write(cx - (line.length >> 1), y++, line, 0x2f8a8a);
  }
  y++;
  renderer.write(cx - 17, y++, 'A NEW YORK ROGUELIKE · OCTOBER 2036', 0x6fa8b8);
  renderer.write(cx - 21, y++, 'the decade happened. you live in what is left.', 0x47616e);
  y += 2;
  const items = TITLE_ITEMS();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const selected = i === titleSel;
    const color = !it.enabled ? 0x3a4148 : selected ? 0xffe9a0 : 0xb8c4cc;
    renderer.write(cx - 12, y + i, `${selected ? '▶ ' : '  '}${it.label}`, color, selected ? 0x14181f : 0);
  }
  y += items.length + 2;
  if (authError) renderer.write(cx - (authError.length >> 1), y++, authError, 0xc05a50);
  const ver = localSaveMeta();
  if (ver?.charName) {
    const line = `last save: ${ver.charName}, net worth $${ver.networth}${ver.alive ? '' : ' (deceased)'} — T${ver.turn}`;
    renderer.write(cx - (line.length >> 1), y++, line, 0x47616e);
  }
  const foot = 'w/s move · e select · F10 CRT · username is the only thing we know about you';
  renderer.write(cx - (foot.length >> 1), renderer.rows - 2, foot, 0x39434c);
}

function drawAuth(): void {
  const cx = renderer.cols >> 1;
  let y = (renderer.rows >> 1) - 6;
  renderer.write(cx - 10, y, authMode === 'login' ? 'LOGIN' : 'REGISTER', 0x6fd4c0);
  renderer.write(cx + 2, y, '[F2 switches]', 0x47616e);
  y += 2;
  const userLine = `username  ${authUser}${authField === 0 ? '▌' : ' '}`;
  const passLine = `password  ${'•'.repeat(authPass.length)}${authField === 1 ? '▌' : ' '}`;
  renderer.write(cx - 14, y, userLine, authField === 0 ? 0xffe9a0 : 0xb8c4cc);
  renderer.write(cx - 14, y + 2, passLine, authField === 1 ? 0xffe9a0 : 0xb8c4cc);
  y += 5;
  renderer.write(cx - 14, y++, 'Tab switches fields · Enter submits · Esc backs out', 0x47616e);
  if (authMode === 'register') {
    renderer.write(cx - 14, y++, 'a-z 0-9 _ only · your username is the only PII we hold', 0x47616e);
  }
  if (authError) renderer.write(cx - 14, y + 1, authError, authBusy ? 0x6fa8b8 : 0xc05a50);
}

function drawSettings(): void {
  const cx = renderer.cols >> 1;
  let y = (renderer.rows >> 1) - 5;
  renderer.write(cx - 10, y, 'SETTINGS', 0x6fd4c0);
  y += 2;
  const rows = [
    `CRT shader        ${crt.enabled ? 'ON ' : 'off'}   (also F10 anywhere)`,
    'Back',
  ];
  if (username) rows.push(`Log out (${username})`);
  for (let i = 0; i < rows.length; i++) {
    const selected = i === settingsSel;
    renderer.write(cx - 14, y + i, `${selected ? '▶ ' : '  '}${rows[i]}`, selected ? 0xffe9a0 : 0xb8c4cc, selected ? 0x14181f : 0);
  }
}

function drawOnboarding(): void {
  const lines = [
    'HOW TO READ THE SCREEN',
    '',
    '@  is you. Everything else is New York.',
    '☻  people with names, jobs, opinions. t talks. Most are not your problem.',
    '☺  crowds passing through. r rats. ^ pigeons. c a bodega cat (do not fight it).',
    '▒  spray paint — x examines it; the walls remember the decade.',
    '+  doors (bump to open) · > a subway entrance, if the line survived',
    '†  streetlamps · Ω hydrants · ☼ shrines · ♥ memorials. People died here. You can too.',
    '',
    'The top line is where and when you are. The bottom lines are what is happening.',
    'Money is your score. Death is permanent. The city is not waiting for you.',
    '',
    'press any key',
  ];
  const w = Math.max(...lines.map((l) => l.length)) + 6;
  const h = lines.length + 2;
  const x0 = Math.max(0, (renderer.cols - w) >> 1);
  const y0 = Math.max(0, (renderer.rows - h) >> 1);
  renderer.fillBg(x0, y0, x0 + w - 1, y0 + h - 1, 0x10151c);
  for (let x = x0; x < x0 + w; x++) {
    renderer.set(x, y0, '─'.charCodeAt(0), STATUS_FG, 0x10151c);
    renderer.set(x, y0 + h - 1, '─'.charCodeAt(0), STATUS_FG, 0x10151c);
  }
  for (let i = 0; i < lines.length; i++) {
    renderer.write(x0 + 3, y0 + 1 + i, lines[i], i === 0 ? 0x6fd4c0 : 0xb8c4cc, 0x10151c);
  }
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
    'EMPIRE://36 — keys',
    '',
    'WASD / arrows   move · bump opens doors · bump hostiles to brawl',
    '. or space      wait one turn · r rest awhile',
    'e               interact (doors, counters, altars, stations)',
    'g               pick up · i inventory · c who you are',
    't               talk · f fight (target, then body part) · v vault',
    'x               examine · m city map & travel · J chronicle · N news',
    'shift+Q         save and quit to title',
    '?               this help · F9 perf · F10 CRT',
    '',
    `world seed: ${seed} — share with ?seed=${seed}`,
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
  switch (shell) {
    case 'title': drawTitle(); break;
    case 'auth': drawAuth(); break;
    case 'settings': drawSettings(); break;
    case 'game': {
      if (meta) {
        renderer.blit(view, 0, mapTop);
        drawStatus();
        drawLog();
      } else {
        const msg = progressText || 'WAKING THE CITY…';
        renderer.write((renderer.cols - msg.length) >> 1, renderer.rows >> 1, msg, STATUS_FG);
      }
      if (textOverlay) drawTextOverlay(textOverlay);
      if (helpOpen) drawHelp();
      if (onboarding) drawOnboarding();
      break;
    }
  }
  if (perfOpen) drawPerf();
  renderer.render();
  crt.render();

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
