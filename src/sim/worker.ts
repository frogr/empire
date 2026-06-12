// Sim worker entry. The render thread sends actions; we resolve turns and ship
// back composited view buffers as transferables. Buffers ping-pong through a
// small pool so steady-state play allocates nothing.

import { Game, SaveData } from './game';
import { loadNeighborhoods } from './content/neighborhoods';
import type { MainMsg, WorkerMsg } from '../bridge/protocol';

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function gunzip(data: ArrayBuffer): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

interface BufSet { glyph: ArrayBuffer; fg: ArrayBuffer; bg: ArrayBuffer }

let game: Game | null = null;
let viewW = 0;
let viewH = 0;
const pool: BufSet[] = [];

const post = (self as unknown as {
  postMessage(m: WorkerMsg, transfer?: Transferable[]): void;
}).postMessage.bind(self);

function sendFrame(turnMs: number): void {
  if (!game || viewW <= 0 || viewH <= 0) return;
  // Journal/news screens requested this action go out before the frame.
  for (const text of game.outbox) {
    post({ t: 'text', kind: text.kind, title: text.title, lines: text.lines });
  }
  game.outbox.length = 0;
  const n = viewW * viewH;
  let bufs = pool.pop();
  if (!bufs || bufs.glyph.byteLength !== n * 2) {
    bufs = {
      glyph: new ArrayBuffer(n * 2),
      fg: new ArrayBuffer(n * 4),
      bg: new ArrayBuffer(n * 4),
    };
  }
  game.fillView(viewW, viewH, new Uint16Array(bufs.glyph), new Uint32Array(bufs.fg), new Uint32Array(bufs.bg));
  post(
    { t: 'frame', w: viewW, h: viewH, glyph: bufs.glyph, fg: bufs.fg, bg: bufs.bg, meta: game.meta(turnMs) },
    [bufs.glyph, bufs.fg, bufs.bg],
  );
}

self.onmessage = async (e: MessageEvent<MainMsg>) => {
  const m = e.data;
  switch (m.t) {
    case 'init': {
      viewW = m.viewW; viewH = m.viewH;
      const t0 = performance.now();
      game = new Game(m.seed, loadNeighborhoods(), (text) => post({ t: 'progress', text }));
      post({ t: 'progress', text: `World ready in ${Math.round(performance.now() - t0)}ms.` });
      sendFrame(0);
      break;
    }
    case 'load': {
      viewW = m.viewW; viewH = m.viewH;
      try {
        const data = JSON.parse(await gunzip(m.data)) as SaveData;
        game = Game.restore(data, loadNeighborhoods(), (text) => post({ t: 'progress', text }));
        sendFrame(0);
      } catch (err) {
        post({ t: 'loaderr', error: String(err) });
      }
      break;
    }
    case 'save': {
      if (!game) break;
      const payload = await gzip(JSON.stringify(game.serialize()));
      const sm = game.saveMeta();
      post(
        { t: 'saved', data: payload, meta: { seed: game.seed, version: 2, ...sm } },
        [payload],
      );
      break;
    }
    case 'resize': {
      viewW = m.viewW; viewH = m.viewH;
      pool.length = 0;
      sendFrame(0);
      break;
    }
    case 'act': {
      if (!game) break;
      const t0 = performance.now();
      game.act(m.a);
      sendFrame(performance.now() - t0);
      break;
    }
    case 'ret': {
      if (m.glyph.byteLength === viewW * viewH * 2 && pool.length < 3) {
        pool.push({ glyph: m.glyph, fg: m.fg, bg: m.bg });
      }
      break;
    }
  }
};
