// Messages crossing the render-thread <-> sim-worker boundary.
// Big state crosses as transferable ArrayBuffers only (PRD §3.1).

export interface Msg {
  text: string;
  fg: number; // 24-bit RGB
}

export interface FrameMeta {
  turn: number;
  clock: string; // "Oct 14 · 19:12"
  money: number;
  hp: number;
  maxHp: number;
  worth: number; // net worth — the score
  loc: string; // "Bushwick — Troutman St & Knickerbocker Ave"
  mode: 'play' | 'look' | 'citymap' | 'menu' | 'target';
  lookText: string;
  turnMs: number; // worker-side resolution time for the last turn
  msgs: Msg[];
  seed: string;
}

export type WorkerMsg =
  | {
      t: 'frame';
      w: number;
      h: number;
      glyph: ArrayBuffer; // Uint16Array w*h, 0 = unexplored (skip)
      fg: ArrayBuffer;    // Uint32Array w*h, 24-bit RGB
      bg: ArrayBuffer;    // Uint32Array w*h, 0 = default clear color
      meta: FrameMeta;
    }
  | { t: 'progress'; text: string }
  | { t: 'text'; kind: 'journal' | 'news'; title: string; lines: Msg[] };

export type Action =
  | { k: 'move'; dx: number; dy: number }
  | { k: 'wait' }
  | { k: 'rest' }
  | { k: 'interact' }
  | { k: 'pickup' }
  | { k: 'inventory' }
  | { k: 'char' }
  | { k: 'talk' }
  | { k: 'fire' }
  | { k: 'vault' }
  | { k: 'look' }
  | { k: 'citymap' }
  | { k: 'journal' }
  | { k: 'news' }
  | { k: 'cancel' };

export type MainMsg =
  | { t: 'init'; seed: string; viewW: number; viewH: number }
  | { t: 'resize'; viewW: number; viewH: number }
  | { t: 'act'; a: Action }
  | { t: 'ret'; glyph: ArrayBuffer; fg: ArrayBuffer; bg: ArrayBuffer };
