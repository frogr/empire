// Game state + turn resolution. Lives entirely in the sim worker.
// Actors are structure-of-arrays (PRD §3.3); the render thread never sees them,
// only the composited view buffers.

import { computeFOV } from './fov';
import { generateMap, GameMap, T, AK } from './map';
import { Rand } from './rng';
import { AMBIENT, PED_BARKS, BUMP_PED, INTRO } from './flavor';
import type { Action, FrameMeta, Msg } from '../bridge/protocol';

const FOV_RADIUS = 13;
const MAX_ACTORS = 160;

export const MSG_DEFAULT = 0xb8b8b8;
const MSG_SYSTEM = 0x6fd4c0;
const MSG_AMBIENT = 0x76869a;
const MSG_BARK = 0xc9b458;

const PED_COLORS = [0x8c8c94, 0x7d8a99, 0x99887d, 0x8a7d99, 0x7d997f, 0xa09078];
const PED_GLYPH = '☺'.charCodeAt(0);
const ACTOR_GLYPH: Record<number, number> = {
  [AK.Ped]: PED_GLYPH,
  [AK.Rat]: 'r'.charCodeAt(0),
  [AK.Pigeon]: '^'.charCodeAt(0),
  [AK.Cat]: 'c'.charCodeAt(0),
};

const BLOCK_MSG: Partial<Record<T, string>> = {
  [T.Wall]: 'Brick.',
  [T.Sign]: 'The neon buzzes at eye level. Solid wall behind it.',
  [T.GraffitiWall]: 'A tagged wall. The paint is newer than the brick.',
  [T.Window]: "A window. You could break it. Not tonight.",
  [T.Car]: 'A parked car blocks the way.',
  [T.Tree]: 'A street tree stands its ground.',
  [T.Shelf]: 'Shelving blocks the aisle.',
  [T.Counter]: 'The counter is in the way.',
  [T.Pew]: 'A pew blocks the way.',
  [T.Altar]: 'You stop short of the altar.',
  [T.Bench]: 'A park bench.',
  [T.Monument]: 'The monument is not going anywhere.',
  [T.Lamp]: 'A lamppost. You walked into a lamppost.',
  [T.Hydrant]: 'A hydrant, knee-high and smug.',
  [T.Shrine]: 'You step carefully around the shrine.',
};

// Tiles each actor kind is willing to walk on.
const PED_TILES = new Set<T>([T.Sidewalk, T.Crosswalk, T.Road, T.Alley, T.Path]);
const PIGEON_TILES = new Set<T>([T.Road, T.Sidewalk, T.Crosswalk, T.Grass, T.Path, T.Scrub]);

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

export class Game {
  readonly seed: string;
  readonly map: GameMap;
  player: { x: number; y: number; money: number };
  turn = 0;
  private clockMin = 19 * 60 + 12; // 6 in-game seconds per turn
  private visible: Uint8Array;
  private msgs: Msg[] = [];
  private mode: 'play' | 'look' = 'play';
  private lookX = 0;
  private lookY = 0;
  private lookText = '';
  private lastAmbient = 0;
  private rTurn: Rand;

  // Actors, structure-of-arrays.
  private aCount = 0;
  private aKind = new Uint8Array(MAX_ACTORS);
  private aX = new Int16Array(MAX_ACTORS);
  private aY = new Int16Array(MAX_ACTORS);
  private aHomeX = new Int16Array(MAX_ACTORS);
  private aHomeY = new Int16Array(MAX_ACTORS);
  private aColor = new Uint32Array(MAX_ACTORS);
  private aDir = new Uint8Array(MAX_ACTORS);
  private aAlive = new Uint8Array(MAX_ACTORS);
  private occ: Int32Array; // tile index -> actor index, -1 if empty

  constructor(seed: string) {
    this.seed = seed;
    const gen = generateMap(seed);
    this.map = gen.map;
    this.rTurn = new Rand(seed, 'turns');
    const rp = new Rand(seed, 'player');
    this.player = { x: gen.spawn.x, y: gen.spawn.y, money: rp.int(180, 260) };
    this.visible = new Uint8Array(this.map.w * this.map.h);
    this.occ = new Int32Array(this.map.w * this.map.h).fill(-1);

    for (const s of gen.actors) {
      if (this.aCount >= MAX_ACTORS) break;
      if (!this.map.walkable(s.x, s.y)) continue;
      const ti = this.map.idx(s.x, s.y);
      if (this.occ[ti] !== -1) continue;
      const i = this.aCount++;
      this.aKind[i] = s.kind;
      this.aX[i] = s.x; this.aY[i] = s.y;
      this.aHomeX[i] = s.x; this.aHomeY[i] = s.y;
      this.aDir[i] = rp.int(0, 3);
      this.aAlive[i] = 1;
      this.aColor[i] =
        s.kind === AK.Ped ? rp.pick(PED_COLORS) :
        s.kind === AK.Rat ? 0x8a6f52 :
        s.kind === AK.Pigeon ? 0x9a9aa2 : 0xd49a3a;
      this.occ[ti] = i;
    }

    this.say(`EMPIRE://36 — Bushwick, October 2036.`, MSG_SYSTEM);
    this.say(`World seed: ${seed}`, 0x5a6a78);
    for (const line of INTRO) this.say(line, MSG_DEFAULT);
    this.say('[?] help   [x] examine   [e] interact', 0x5a6a78);
    this.computeVision();
  }

  private say(text: string, fg = MSG_DEFAULT): void {
    this.msgs.push({ text, fg });
  }

  act(a: Action): void {
    if (this.mode === 'look') {
      this.actLook(a);
      return;
    }
    switch (a.k) {
      case 'move': this.tryMove(a.dx, a.dy); break;
      case 'wait': this.endTurn(); break;
      case 'interact': this.interact(); break;
      case 'look':
        this.mode = 'look';
        this.lookX = this.player.x;
        this.lookY = this.player.y;
        this.lookText = 'You. Still standing. Net worth: modest.';
        break;
      case 'cancel': break;
    }
  }

  private actLook(a: Action): void {
    if (a.k === 'cancel' || a.k === 'look') {
      this.mode = 'play';
      this.lookText = '';
      return;
    }
    if (a.k !== 'move') return;
    const nx = this.lookX + a.dx, ny = this.lookY + a.dy;
    if (!this.map.inBounds(nx, ny)) return;
    this.lookX = nx; this.lookY = ny;
    const i = this.map.idx(nx, ny);
    if (nx === this.player.x && ny === this.player.y) {
      this.lookText = 'You. Still standing.';
    } else if (this.visible[i]) {
      const ai = this.occ[i];
      this.lookText = ai >= 0 && this.aAlive[ai]
        ? this.describeActor(ai)
        : this.map.describe(nx, ny);
    } else if (this.map.explored[i]) {
      this.lookText = `${this.map.describe(nx, ny)} (from memory)`;
    } else {
      this.lookText = "You can't see that from here.";
    }
  }

  private describeActor(i: number): string {
    switch (this.aKind[i]) {
      case AK.Ped: return 'A stranger with somewhere to be.';
      case AK.Rat: return 'A rat. Confident. Local.';
      case AK.Pigeon: return 'A pigeon, auditing the street.';
      default: return 'A bodega cat. It owns this establishment and everyone in it.';
    }
  }

  private tryMove(dx: number, dy: number): void {
    const nx = this.player.x + dx, ny = this.player.y + dy;
    if (!this.map.inBounds(nx, ny)) {
      this.say('The neighborhood ends here. The rest of the city is out there somewhere.');
      return;
    }
    const ti = this.map.idx(nx, ny);
    const ai = this.occ[ti];
    if (ai >= 0 && this.aAlive[ai]) {
      this.bumpActor(ai);
      this.endTurn();
      return;
    }
    const t = this.map.t(nx, ny);
    if (t === T.DoorClosed) {
      this.map.openDoor(nx, ny);
      this.say('You push the door open.');
      this.endTurn();
      return;
    }
    if (this.map.walkable(nx, ny)) {
      this.player.x = nx; this.player.y = ny;
      this.stepFlavor(t);
      this.endTurn();
      return;
    }
    this.say(BLOCK_MSG[t] ?? 'Something solid blocks the way.');
  }

  private stepFlavor(t: T): void {
    if (t === T.Trash && this.rTurn.chance(0.3)) this.say('Glass crunches underfoot.');
    else if (t === T.Vent && this.rTurn.chance(0.5)) {
      this.say('Steam wraps around you, smelling of laundry and the underworld.');
    } else if (t === T.Rubble && this.rTurn.chance(0.15)) this.say('Brick dust puffs up with each step.');
  }

  private bumpActor(i: number): void {
    switch (this.aKind[i]) {
      case AK.Ped:
        this.say(this.rTurn.pick(BUMP_PED));
        if (this.rTurn.chance(0.35)) this.say(this.rTurn.pick(PED_BARKS), MSG_BARK);
        break;
      case AK.Rat:
        this.say('The rat holds its ground for one insolent second, then flows away.');
        break;
      case AK.Pigeon:
        this.removeActor(i);
        this.say('The pigeon decides against all of this and leaves.');
        break;
      default:
        this.say('The bodega cat permits the interruption. Barely.');
    }
  }

  private interact(): void {
    const { x, y } = this.player;
    for (const [dx, dy] of [[0, 0], ...DIRS] as number[][]) {
      const nx = x + dx, ny = y + dy;
      if (!this.map.inBounds(nx, ny)) continue;
      const t = this.map.t(nx, ny);
      if (t === T.DoorClosed) {
        this.map.openDoor(nx, ny);
        this.say('You push the door open.');
        this.endTurn();
        return;
      }
      if (t === T.DoorOpen) {
        this.map.closeDoor(nx, ny);
        this.say('You pull the door shut behind you.');
        this.endTurn();
        return;
      }
      if (t === T.Shrine) {
        this.say('You straighten one of the rain-curled photographs. Someone will notice.');
        this.endTurn();
        return;
      }
      if (t === T.Altar) {
        this.say("You light a candle. It can't hurt. Probably it can't hurt.");
        this.endTurn();
        return;
      }
      if (t === T.Counter) {
        this.say("No one's behind the counter. The cat is watching you, though.");
        return;
      }
      if (t === T.Monument) {
        this.say('Whatever this commemorated, somebody sold the plaque.');
        return;
      }
    }
    this.say('Nothing here to use.');
  }

  private endTurn(): void {
    this.turn++;
    this.clockMin += 0.1;
    this.actorsAct();
    if (this.turn - this.lastAmbient > 25 && this.rTurn.chance(0.035)) {
      this.say(this.rTurn.pick(AMBIENT), MSG_AMBIENT);
      this.lastAmbient = this.turn;
    }
    this.computeVision();
  }

  private removeActor(i: number): void {
    this.aAlive[i] = 0;
    this.occ[this.map.idx(this.aX[i], this.aY[i])] = -1;
  }

  private moveActor(i: number, nx: number, ny: number): void {
    this.occ[this.map.idx(this.aX[i], this.aY[i])] = -1;
    this.aX[i] = nx; this.aY[i] = ny;
    this.occ[this.map.idx(nx, ny)] = i;
  }

  private canStep(nx: number, ny: number, allowed?: Set<T>): boolean {
    if (!this.map.walkable(nx, ny)) return false;
    if (allowed && !allowed.has(this.map.t(nx, ny))) return false;
    if (nx === this.player.x && ny === this.player.y) return false;
    return this.occ[this.map.idx(nx, ny)] === -1;
  }

  private actorsAct(): void {
    const r = this.rTurn;
    const px = this.player.x, py = this.player.y;
    for (let i = 0; i < this.aCount; i++) {
      if (!this.aAlive[i]) continue;
      const x = this.aX[i], y = this.aY[i];
      const dist = Math.abs(x - px) + Math.abs(y - py);
      const seen = this.visible[this.map.idx(x, y)] === 1;
      switch (this.aKind[i]) {
        case AK.Ped: {
          if (seen && dist <= 2 && r.chance(0.04)) this.say(r.pick(PED_BARKS), MSG_BARK);
          if (!r.chance(0.85)) break;
          const d = this.aDir[i];
          const [fdx, fdy] = DIRS[d];
          if (r.chance(0.75) && this.canStep(x + fdx, y + fdy, PED_TILES)) {
            this.moveActor(i, x + fdx, y + fdy);
          } else {
            const order = r.shuffle([0, 1, 2, 3]);
            for (const nd of order) {
              const [dx, dy] = DIRS[nd];
              if (this.canStep(x + dx, y + dy, PED_TILES)) {
                this.aDir[i] = nd;
                this.moveActor(i, x + dx, y + dy);
                break;
              }
            }
          }
          break;
        }
        case AK.Rat: {
          if (seen && dist === 1 && r.chance(0.15)) this.say('A rat darts over your boot.');
          if (!r.chance(0.6)) break;
          const [dx, dy] = r.pick(DIRS);
          if (this.canStep(x + dx, y + dy)) this.moveActor(i, x + dx, y + dy);
          break;
        }
        case AK.Pigeon: {
          if (seen && dist <= 2) {
            this.removeActor(i);
            this.say('Pigeons burst skyward, all wing and panic.', MSG_AMBIENT);
            break;
          }
          if (!r.chance(0.5)) break;
          const [dx, dy] = r.pick(DIRS);
          if (this.canStep(x + dx, y + dy, PIGEON_TILES)) this.moveActor(i, x + dx, y + dy);
          break;
        }
        default: { // Cat stays near its bodega.
          if (!r.chance(0.25)) break;
          const [dx, dy] = r.pick(DIRS);
          const nx = x + dx, ny = y + dy;
          if (Math.abs(nx - this.aHomeX[i]) + Math.abs(ny - this.aHomeY[i]) > 3) break;
          if (this.canStep(nx, ny) && this.map.t(nx, ny) === T.Floor) this.moveActor(i, nx, ny);
        }
      }
    }
  }

  private computeVision(): void {
    this.visible.fill(0);
    const m = this.map;
    computeFOV(
      this.player.x, this.player.y, FOV_RADIUS,
      (x, y) => m.opaque(x, y),
      (x, y) => {
        if (!m.inBounds(x, y)) return;
        const i = m.idx(x, y);
        this.visible[i] = 1;
        m.explored[i] = 1;
      },
    );
  }

  // --- view compositing ------------------------------------------------------

  fillView(viewW: number, viewH: number, glyph: Uint16Array, fg: Uint32Array, bg: Uint32Array): void {
    const m = this.map;
    const camX = Math.max(0, Math.min(this.player.x - (viewW >> 1), m.w - viewW));
    const camY = Math.max(0, Math.min(this.player.y - (viewH >> 1), m.h - viewH));
    for (let vy = 0; vy < viewH; vy++) {
      const my = camY + vy;
      const inY = my >= 0 && my < m.h;
      for (let vx = 0; vx < viewW; vx++) {
        const vi = vy * viewW + vx;
        const mx = camX + vx;
        if (!inY || mx < 0 || mx >= m.w) {
          glyph[vi] = 0; fg[vi] = 0; bg[vi] = 0;
          continue;
        }
        const i = my * m.w + mx;
        if (!m.explored[i]) {
          glyph[vi] = 0; fg[vi] = 0; bg[vi] = 0;
        } else if (this.visible[i]) {
          glyph[vi] = m.glyph[i]; fg[vi] = m.fg[i]; bg[vi] = m.bg[i];
        } else {
          glyph[vi] = m.glyph[i]; fg[vi] = dimFg(m.fg[i]); bg[vi] = dimBg(m.bg[i]);
        }
      }
    }
    // Actors render only when visible.
    for (let i = 0; i < this.aCount; i++) {
      if (!this.aAlive[i]) continue;
      const x = this.aX[i], y = this.aY[i];
      if (!this.visible[m.idx(x, y)]) continue;
      const vx = x - camX, vy = y - camY;
      if (vx < 0 || vy < 0 || vx >= viewW || vy >= viewH) continue;
      const vi = vy * viewW + vx;
      glyph[vi] = ACTOR_GLYPH[this.aKind[i]];
      fg[vi] = this.aColor[i];
    }
    // Player.
    {
      const vx = this.player.x - camX, vy = this.player.y - camY;
      if (vx >= 0 && vy >= 0 && vx < viewW && vy < viewH) {
        const vi = vy * viewW + vx;
        glyph[vi] = 64; // '@'
        fg[vi] = 0xffffff;
      }
    }
    // Examine cursor inverts its cell.
    if (this.mode === 'look') {
      const vx = this.lookX - camX, vy = this.lookY - camY;
      if (vx >= 0 && vy >= 0 && vx < viewW && vy < viewH) {
        const vi = vy * viewW + vx;
        if (glyph[vi] === 0 || glyph[vi] === 32) glyph[vi] = 215; // '×'
        fg[vi] = 0x101010;
        bg[vi] = 0xc8b820;
      }
    }
  }

  meta(turnMs: number): FrameMeta {
    const msgs = this.msgs;
    this.msgs = [];
    const mins = Math.floor(this.clockMin) % (24 * 60);
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    return {
      turn: this.turn,
      clock: `${hh}:${mm}`,
      money: this.player.money,
      loc: this.map.nearestIntersection(this.player.x, this.player.y),
      mode: this.mode,
      lookText: this.lookText,
      turnMs,
      msgs,
      seed: this.seed,
    };
  }
}

function dimFg(c: number): number {
  const r = (c >>> 16) & 255, g = (c >>> 8) & 255, b = c & 255;
  return (((r * 70) >> 8) << 16) | (((g * 74) >> 8) << 8) | Math.min(255, ((b * 96) >> 8) + 10);
}

function dimBg(c: number): number {
  const r = (c >>> 16) & 255, g = (c >>> 8) & 255, b = c & 255;
  return (((r * 100) >> 8) << 16) | (((g * 104) >> 8) << 8) | Math.min(255, ((b * 128) >> 8) + 5);
}
