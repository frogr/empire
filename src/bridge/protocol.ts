// Messages crossing the render-thread <-> sim-worker boundary.
// Big state crosses as transferable ArrayBuffers only (PRD §3.1).

export interface Msg {
  text: string;
  fg: number; // 24-bit RGB
}

export interface FrameMeta {
  turn: number;
  clock: string; // "HH:MM"
  money: number;
  loc: string; // nearest intersection, e.g. "Troutman St & Knickerbocker Ave"
  mode: 'play' | 'look';
  lookText: string;
  turnMs: number; // worker-side resolution time for the last turn
  msgs: Msg[];
  seed: string;
}

export type WorkerMsg = {
  t: 'frame';
  w: number;
  h: number;
  glyph: ArrayBuffer; // Uint16Array w*h, 0 = unexplored (skip)
  fg: ArrayBuffer;    // Uint32Array w*h, 24-bit RGB
  bg: ArrayBuffer;    // Uint32Array w*h, 0 = default clear color
  meta: FrameMeta;
};

export type Action =
  | { k: 'move'; dx: number; dy: number }
  | { k: 'wait' }
  | { k: 'interact' }
  | { k: 'look' }
  | { k: 'cancel' };

export type MainMsg =
  | { t: 'init'; seed: string; viewW: number; viewH: number }
  | { t: 'resize'; viewW: number; viewH: number }
  | { t: 'act'; a: Action }
  | { t: 'ret'; glyph: ArrayBuffer; fg: ArrayBuffer; bg: ArrayBuffer };
