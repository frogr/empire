// Procgen for one Brooklyn rowhouse neighborhood (M0). All map state lives in
// flat typed arrays — no per-tile objects (PRD §3.2). Deterministic from seed.

import { Rand } from './rng';
import {
  AVENUE_NAMES, STREET_NAMES, BODEGA_NAMES, CHAPEL_NAME, GRAFFITI, SHRINE_DESCS,
} from './flavor';

export const MAP_W = 168;
export const MAP_H = 168;

export enum T {
  Scrub = 0, Road, RoadMark, Crosswalk, Manhole, Vent, Sidewalk, Alley,
  Wall, Sign, GraffitiWall, DoorClosed, DoorOpen, Window,
  Floor, Shelf, Counter, Pew, Altar, Furniture,
  Grass, Tree, Path, Bench, Monument, Shrine,
  Rubble, Trash, Lamp, Hydrant, Car,
}

export const FLAG_WALK = 1;
export const FLAG_OPAQUE = 2;

// [walkable, opaque]
const TILE_PROPS: Record<T, [boolean, boolean]> = {
  [T.Scrub]: [true, false], [T.Road]: [true, false], [T.RoadMark]: [true, false],
  [T.Crosswalk]: [true, false], [T.Manhole]: [true, false], [T.Vent]: [true, false],
  [T.Sidewalk]: [true, false], [T.Alley]: [true, false],
  [T.Wall]: [false, true], [T.Sign]: [false, true], [T.GraffitiWall]: [false, true],
  [T.DoorClosed]: [false, true], [T.DoorOpen]: [true, false], [T.Window]: [false, false],
  [T.Floor]: [true, false], [T.Shelf]: [false, false], [T.Counter]: [false, false],
  [T.Pew]: [false, false], [T.Altar]: [false, false], [T.Furniture]: [false, false],
  [T.Grass]: [true, false], [T.Tree]: [false, true], [T.Path]: [true, false],
  [T.Bench]: [false, false], [T.Monument]: [false, false], [T.Shrine]: [false, false],
  [T.Rubble]: [true, false], [T.Trash]: [true, false],
  [T.Lamp]: [false, false], [T.Hydrant]: [false, false], [T.Car]: [false, false],
};

export const TILE_DESC: Record<T, string> = {
  [T.Scrub]: 'Weeds through broken concrete.',
  [T.Road]: 'Cracked asphalt, patched with newer cracks.',
  [T.RoadMark]: 'A faded lane line nobody negotiates with anymore.',
  [T.Crosswalk]: 'Crosswalk stripes, worn to a rumor.',
  [T.Manhole]: 'A manhole cover. Warm.',
  [T.Vent]: 'A grate breathing steam from somewhere older than the street.',
  [T.Sidewalk]: 'Concrete slab sidewalk, gum-blackened.',
  [T.Alley]: 'A narrow alley. It smells decisive.',
  [T.Wall]: 'Brick rowhouse wall.',
  [T.Sign]: 'Dead-channel neon lettering, still lit.',
  [T.GraffitiWall]: 'A tag, layered over older tags.',
  [T.DoorClosed]: 'A door, shut against the evening.',
  [T.DoorOpen]: 'An open door.',
  [T.Window]: 'A window. Curtains, or the memory of curtains.',
  [T.Floor]: 'Worn floorboards.',
  [T.Shelf]: 'Shelving: canned goods, candles, lottery hope.',
  [T.Counter]: 'A scuffed counter with a plexiglass ghost.',
  [T.Pew]: 'A wooden pew, polished by decades of sitting.',
  [T.Altar]: 'An altar crowded with candles. Some are lit. Nobody is here.',
  [T.Furniture]: 'Somebody\'s furniture, surviving.',
  [T.Grass]: 'Park grass, longer than the city used to allow.',
  [T.Tree]: 'A street tree, older than every government it has outlived.',
  [T.Path]: 'A gravel path through the park.',
  [T.Bench]: 'A park bench with one new plank and three ancient ones.',
  [T.Monument]: 'A stone monument. The plaque has been pried off.',
  [T.Shrine]: 'A street shrine.',
  [T.Rubble]: 'Rubble. Brick, rebar, drywall snow.',
  [T.Trash]: 'A drift of garbage, sorted by wind.',
  [T.Lamp]: 'A streetlamp, flickering its dim opinion.',
  [T.Hydrant]: 'A fire hydrant, painted and repainted.',
  [T.Car]: 'A parked car. Possibly abandoned. Possibly home.',
};

// --- palette ---------------------------------------------------------------
const ASPHALT_BG = 0x17171c, ASPHALT_FG = 0x36363e;
const SIDEWALK_BG = 0x101014, SIDEWALK_FG = 0x6c6c74;
const LANE_FG = 0x6f662a;
const CROSS_FG = 0x84848c;
const WALL_FG = 0x8a6450, WALL_BG = 0x140f0c;
const DOOR_FG = 0xb07c46;
const WINDOW_FG = 0x4f7d8c;
const FLOOR_FG = 0x57534b, FLOOR_BG = 0x12101a;
const GRASS_BG = 0x09120a;
const GRASS_FG = [0x3d6b35, 0x356b45, 0x4a7a3a];
const SCRUB_FG = [0x4a5c38, 0x55603e];
const SCRUB_BG = 0x0c100a;
const TREE_FG = 0x2f8a3f;
const PATH_FG = 0x8a7f5c, PATH_BG = 0x11100c;
const RUBBLE_FG = [0x55504a, 0x615a52, 0x47423d];
const TRASH_FG = 0x5d6147;
const LAMP_FG = 0xd8c87a;
const HYDRANT_FG = 0xa83232;
const CAR_FG = [0x4a4f55, 0x5c4a45, 0x3f4a5c, 0x55554a, 0x6b3a3a];
const NEON = [0x00ffd0, 0xff3df0, 0x39ff5a, 0xffb52e, 0x44aaff, 0xff5544];
const SIGN_BG = 0x16081a;
const ALTAR_FG = 0xffd060;
const WOOD_FG = 0x7a5c34;

const ch = (s: string) => s.charCodeAt(0);

export interface NamedRoad { pos: number; name: string }
export interface ActorSpawn { kind: number; x: number; y: number }
export enum AK { Ped = 0, Rat = 1, Pigeon = 2, Cat = 3 }

export class GameMap {
  readonly w = MAP_W;
  readonly h = MAP_H;
  terrain = new Uint8Array(MAP_W * MAP_H);
  glyph = new Uint16Array(MAP_W * MAP_H);
  fg = new Uint32Array(MAP_W * MAP_H);
  bg = new Uint32Array(MAP_W * MAP_H);
  flags = new Uint8Array(MAP_W * MAP_H);
  explored = new Uint8Array(MAP_W * MAP_H);
  desc = new Map<number, string>(); // tile-specific examine text overrides
  avenues: NamedRoad[] = [];
  streets: NamedRoad[] = [];

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  set(x: number, y: number, t: T, glyph: number, fg: number, bg: number): void {
    const i = this.idx(x, y);
    this.terrain[i] = t;
    this.glyph[i] = glyph;
    this.fg[i] = fg;
    this.bg[i] = bg;
    const [walk, opaque] = TILE_PROPS[t];
    this.flags[i] = (walk ? FLAG_WALK : 0) | (opaque ? FLAG_OPAQUE : 0);
  }

  t(x: number, y: number): T {
    return this.terrain[this.idx(x, y)] as T;
  }

  walkable(x: number, y: number): boolean {
    return this.inBounds(x, y) && (this.flags[this.idx(x, y)] & FLAG_WALK) !== 0;
  }

  opaque(x: number, y: number): boolean {
    return !this.inBounds(x, y) || (this.flags[this.idx(x, y)] & FLAG_OPAQUE) !== 0;
  }

  describe(x: number, y: number): string {
    return this.desc.get(this.idx(x, y)) ?? TILE_DESC[this.t(x, y)];
  }

  openDoor(x: number, y: number): void {
    this.set(x, y, T.DoorOpen, ch("'"), DOOR_FG, WALL_BG);
  }

  closeDoor(x: number, y: number): void {
    this.set(x, y, T.DoorClosed, ch('+'), DOOR_FG, WALL_BG);
  }

  nearestIntersection(x: number, y: number): string {
    const nearest = (roads: NamedRoad[], p: number) =>
      roads.reduce((a, b) => (Math.abs(b.pos - p) < Math.abs(a.pos - p) ? b : a));
    if (!this.streets.length || !this.avenues.length) return 'Bushwick';
    return `${nearest(this.streets, y).name} & ${nearest(this.avenues, x).name}`;
  }
}

export interface GenResult {
  map: GameMap;
  spawn: { x: number; y: number };
  actors: ActorSpawn[];
}

export function generateMap(seed: string): GenResult {
  const r = new Rand(seed, 'map');
  const map = new GameMap();
  const actors: ActorSpawn[] = [];

  // 0. Everything starts as scrub — the unbuilt margin.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      map.set(x, y, T.Scrub, ch(r.chance(0.3) ? '"' : ','), r.pick(SCRUB_FG), SCRUB_BG);
    }
  }

  // 1. Road skeleton: vertical avenues, horizontal streets.
  const avenueNames = r.shuffle([...AVENUE_NAMES]);
  const streetNames = r.shuffle([...STREET_NAMES]);
  const avenueXs: number[] = [];
  for (let x = r.int(7, 10); x < MAP_W - 8; x += r.int(21, 27)) avenueXs.push(x);
  const streetYs: number[] = [];
  for (let y = r.int(6, 9); y < MAP_H - 7; y += r.int(16, 20)) streetYs.push(y);
  map.avenues = avenueXs.map((x, i) => ({ pos: x, name: avenueNames[i % avenueNames.length] }));
  map.streets = streetYs.map((y, i) => ({ pos: y, name: streetNames[i % streetNames.length] }));

  const sidewalkAt = (x: number, y: number) => {
    if (!map.inBounds(x, y)) return;
    map.set(x, y, T.Sidewalk, ch(r.chance(0.12) ? ',' : '.'), SIDEWALK_FG, SIDEWALK_BG);
  };
  const roadAt = (x: number, y: number) => {
    if (!map.inBounds(x, y)) return;
    const g = r.chance(0.06) ? ch('·') : 32;
    map.set(x, y, T.Road, g, ASPHALT_FG, ASPHALT_BG);
  };

  for (const ax of avenueXs) {
    for (let y = 0; y < MAP_H; y++) { sidewalkAt(ax - 3, y); sidewalkAt(ax + 3, y); }
  }
  for (const sy of streetYs) {
    for (let x = 0; x < MAP_W; x++) { sidewalkAt(x, sy - 2); sidewalkAt(x, sy + 2); }
  }
  for (const ax of avenueXs) {
    for (let y = 0; y < MAP_H; y++) for (let dx = -2; dx <= 2; dx++) roadAt(ax + dx, y);
  }
  for (const sy of streetYs) {
    for (let x = 0; x < MAP_W; x++) for (let dy = -1; dy <= 1; dy++) roadAt(x, sy + dy);
  }

  // Lane dashes down each avenue, broken at intersections.
  for (const ax of avenueXs) {
    for (let y = 0; y < MAP_H; y++) {
      if (y % 3 === 0) continue;
      if (streetYs.some((sy) => Math.abs(y - sy) <= 2)) continue;
      if (map.t(ax, y) === T.Road) map.set(ax, y, T.RoadMark, ch('¦'), LANE_FG, ASPHALT_BG);
    }
  }

  // Crosswalks at every intersection.
  for (const ax of avenueXs) {
    for (const sy of streetYs) {
      for (let dx = -2; dx <= 2; dx++) {
        for (const y of [sy - 2, sy + 2]) {
          if (map.inBounds(ax + dx, y) && map.t(ax + dx, y) === T.Road) {
            map.set(ax + dx, y, T.Crosswalk, ch('='), CROSS_FG, ASPHALT_BG);
          }
        }
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (const x of [ax - 3, ax + 3]) {
          if (map.inBounds(x, sy + dy) && map.t(x, sy + dy) === T.Road) {
            map.set(x, sy + dy, T.Crosswalk, ch('='), CROSS_FG, ASPHALT_BG);
          }
        }
      }
    }
  }

  // Manholes, steam vents.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (map.t(x, y) !== T.Road) continue;
      if (r.chance(0.004)) map.set(x, y, T.Manhole, ch('o'), 0x46464e, ASPHALT_BG);
      else if (r.chance(0.002)) map.set(x, y, T.Vent, ch('≈'), 0x7a7a82, ASPHALT_BG);
    }
  }

  // Street furniture: lamps and hydrants along sidewalks.
  const lampAt = (x: number, y: number) => {
    if (map.inBounds(x, y) && map.t(x, y) === T.Sidewalk) {
      map.set(x, y, T.Lamp, ch('†'), LAMP_FG, SIDEWALK_BG);
    }
  };
  const hydrantAt = (x: number, y: number) => {
    if (map.inBounds(x, y) && map.t(x, y) === T.Sidewalk) {
      map.set(x, y, T.Hydrant, ch('Ω'), HYDRANT_FG, SIDEWALK_BG);
    }
  };
  for (const ax of avenueXs) {
    for (let y = r.int(2, 6); y < MAP_H; y += 9) { lampAt(ax - 3, y); lampAt(ax + 3, y + 4); }
    for (let y = r.int(8, 20); y < MAP_H; y += 31) { hydrantAt(ax - 3, y); }
  }
  for (const sy of streetYs) {
    for (let x = r.int(2, 8); x < MAP_W; x += 11) { lampAt(x, sy - 2); lampAt(x + 5, sy + 2); }
    for (let x = r.int(10, 24); x < MAP_W; x += 37) { hydrantAt(x, sy + 2); }
  }

  // Parked cars hug the curb lanes.
  const tryCar = (x: number, y: number) => {
    if (map.inBounds(x, y) && map.t(x, y) === T.Road) {
      map.set(x, y, T.Car, ch('■'), r.pick(CAR_FG), ASPHALT_BG);
    }
  };
  for (const ax of avenueXs) {
    for (const cx of [ax - 2, ax + 2]) {
      let y = r.int(1, 4);
      while (y < MAP_H - 2) {
        if (r.chance(0.55)) { tryCar(cx, y); tryCar(cx, y + 1); y += 2 + r.int(1, 3); }
        else y += r.int(2, 5);
      }
    }
  }
  for (const sy of streetYs) {
    for (const cy of [sy - 1, sy + 1]) {
      let x = r.int(1, 4);
      while (x < MAP_W - 2) {
        if (r.chance(0.5)) { tryCar(x, cy); tryCar(x + 1, cy); x += 2 + r.int(1, 3); }
        else x += r.int(2, 5);
      }
    }
  }

  // 2. Blocks between the roads.
  interface Block { x0: number; x1: number; y0: number; y1: number }
  const blocks: Block[] = [];
  for (let i = 0; i < avenueXs.length - 1; i++) {
    for (let j = 0; j < streetYs.length - 1; j++) {
      const b: Block = {
        x0: avenueXs[i] + 4, x1: avenueXs[i + 1] - 4,
        y0: streetYs[j] + 3, y1: streetYs[j + 1] - 3,
      };
      if (b.x1 - b.x0 >= 7 && b.y1 - b.y0 >= 6) blocks.push(b);
    }
  }

  const parkIdx = blocks.length
    ? blocks.reduce<number>((best, b, i) => {
        const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
        const bb = blocks[best];
        return bw * bh > (bb.x1 - bb.x0) * (bb.y1 - bb.y0) && r.chance(0.7) ? i : best;
      }, r.int(0, blocks.length - 1))
    : -1;

  let bodegaCount = 0;
  let chapelPlaced = false;
  let shrinePlaced = false;

  const fillYard = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (r.chance(0.05)) map.set(x, y, T.Trash, ch('%'), TRASH_FG, SCRUB_BG);
        else map.set(x, y, T.Scrub, ch(r.chance(0.4) ? '"' : "'"), r.pick(SCRUB_FG), SCRUB_BG);
      }
    }
    if (!shrinePlaced && r.chance(0.18) && x1 > x0 && y1 > y0) {
      const sx = r.int(x0, x1), sy = r.int(y0, y1);
      map.set(sx, sy, T.Shrine, ch('☼'), ALTAR_FG, SCRUB_BG);
      map.desc.set(map.idx(sx, sy), r.pick(SHRINE_DESCS));
      shrinePlaced = true;
    }
  };

  const buildVacant = (b: Block) => {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        if (r.chance(0.35)) map.set(x, y, T.Rubble, ch(r.pick(['▪', '%', ','])), r.pick(RUBBLE_FG), 0x0d0c0e);
        else map.set(x, y, T.Scrub, ch(r.chance(0.3) ? '"' : ','), r.pick(SCRUB_FG), SCRUB_BG);
      }
    }
    // Remnant wall fragments, heavily tagged.
    const frags = r.int(1, 3);
    for (let f = 0; f < frags; f++) {
      const fx = r.int(b.x0 + 1, Math.max(b.x0 + 1, b.x1 - 4));
      const fy = r.int(b.y0 + 1, Math.max(b.y0 + 1, b.y1 - 1));
      const len = r.int(2, 5);
      for (let k = 0; k < len && fx + k <= b.x1; k++) {
        map.set(fx + k, fy, T.GraffitiWall, ch('▒'), r.pick(NEON), 0x100a12);
        map.desc.set(map.idx(fx + k, fy), `Spray paint on a remnant wall: "${r.pick(GRAFFITI)}"`);
      }
    }
  };

  const buildPark = (b: Block) => {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        if (r.chance(0.1)) map.set(x, y, T.Tree, ch(r.chance(0.85) ? '♣' : '♠'), TREE_FG, GRASS_BG);
        else map.set(x, y, T.Grass, ch(r.pick(['"', "'", ','])), r.pick(GRASS_FG), GRASS_BG);
      }
    }
    const mx = (b.x0 + b.x1) >> 1, my = (b.y0 + b.y1) >> 1;
    for (let x = b.x0; x <= b.x1; x++) map.set(x, my, T.Path, ch('·'), PATH_FG, PATH_BG);
    for (let y = b.y0; y <= b.y1; y++) map.set(mx, y, T.Path, ch('·'), PATH_FG, PATH_BG);
    for (let x = b.x0 + 1; x < b.x1; x += r.int(3, 5)) {
      if (r.chance(0.5) && map.t(x, my - 1) === T.Grass) {
        map.set(x, my - 1, T.Bench, ch('Π'), WOOD_FG, GRASS_BG);
      }
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) map.set(mx + dx, my + dy, T.Path, ch('·'), PATH_FG, PATH_BG);
    }
    map.set(mx, my, T.Monument, ch('▲'), 0x8a8a92, PATH_BG);
    for (let p = 0; p < 8; p++) {
      actors.push({ kind: AK.Pigeon, x: r.int(b.x0, b.x1), y: r.int(b.y0, b.y1) });
    }
  };

  // Rowhouse strip: outer box-drawn walls, party-wall dividers, a door and
  // windows per house on the facing wall.
  const buildStrip = (sx0: number, sx1: number, sy0: number, sy1: number, facing: 'N' | 'S', avenueSide: 'W' | 'E') => {
    const wall = (x: number, y: number, g: string) => map.set(x, y, T.Wall, ch(g), WALL_FG, WALL_BG);
    for (let x = sx0 + 1; x < sx1; x++) { wall(x, sy0, '─'); wall(x, sy1, '─'); }
    for (let y = sy0 + 1; y < sy1; y++) { wall(sx0, y, '│'); wall(sx1, y, '│'); }
    wall(sx0, sy0, '┌'); wall(sx1, sy0, '┐'); wall(sx0, sy1, '└'); wall(sx1, sy1, '┘');
    for (let y = sy0 + 1; y < sy1; y++) {
      for (let x = sx0 + 1; x < sx1; x++) map.set(x, y, T.Floor, ch('·'), FLOOR_FG, FLOOR_BG);
    }

    // Subdivide into houses.
    const bounds: number[] = [sx0];
    let x = sx0;
    while (sx1 - x > 10) { x += r.int(5, 7); bounds.push(x); }
    bounds.push(sx1);
    for (let bi = 1; bi < bounds.length - 1; bi++) {
      const dx = bounds[bi];
      wall(dx, sy0, '┬'); wall(dx, sy1, '┴');
      for (let y = sy0 + 1; y < sy1; y++) wall(dx, y, '│');
    }

    const faceY = facing === 'N' ? sy0 : sy1;
    const backY = facing === 'N' ? sy1 : sy0;
    const houses: { x0: number; x1: number }[] = [];
    for (let bi = 0; bi < bounds.length - 1; bi++) houses.push({ x0: bounds[bi], x1: bounds[bi + 1] });

    for (const h of houses) {
      const doorX = r.int(h.x0 + 1, h.x1 - 1);
      map.set(doorX, faceY, T.DoorClosed, ch('+'), DOOR_FG, WALL_BG);
      for (let wx = h.x0 + 1; wx < h.x1; wx++) {
        if (wx !== doorX && r.chance(0.45)) map.set(wx, faceY, T.Window, ch('□'), WINDOW_FG, WALL_BG);
      }
      if (r.chance(0.35)) {
        map.set(r.int(h.x0 + 1, h.x1 - 1), backY, T.DoorClosed, ch('+'), DOOR_FG, WALL_BG);
      }
      for (let f = r.int(0, 2); f > 0; f--) {
        const fx = r.int(h.x0 + 1, h.x1 - 1), fy = r.int(sy0 + 1, sy1 - 1);
        if (map.t(fx, fy) === T.Floor && !(fx === doorX)) {
          map.set(fx, fy, T.Furniture, ch('Π'), WOOD_FG, FLOOR_BG);
        }
      }
    }

    // Corner bodega on the avenue end of some strips: side door, vertical
    // neon sign spelled letter-by-letter down the avenue-facing wall.
    if (bodegaCount < 6 && r.chance(0.4) && houses.length) {
      bodegaCount++;
      const h = avenueSide === 'W' ? houses[0] : houses[houses.length - 1];
      const sideX = avenueSide === 'W' ? sx0 : sx1;
      const name = r.pick(BODEGA_NAMES);
      const neon = r.pick(NEON);
      const letters = name.replace(/ /g, '');
      const doorY = r.int(sy0 + 1, sy1 - 1);
      let li = 0;
      for (let y = sy0 + 1; y < sy1 && li < letters.length; y++) {
        if (y === doorY) continue;
        map.set(sideX, y, T.Sign, letters.charCodeAt(li++), neon, SIGN_BG);
        map.desc.set(map.idx(sideX, y), `Buzzing neon, vertical: ${name}.`);
      }
      map.set(sideX, doorY, T.DoorClosed, ch('+'), DOOR_FG, WALL_BG);
      // Shelving aisles with a clear lap around them, counter by the door.
      for (let ax2 = h.x0 + 2; ax2 <= h.x1 - 2; ax2 += 2) {
        for (let y = sy0 + 2; y <= sy1 - 2; y++) {
          if (map.t(ax2, y) === T.Floor) map.set(ax2, y, T.Shelf, ch('≡'), 0x9a8a52, FLOOR_BG);
        }
      }
      const cx = avenueSide === 'W' ? sideX + 1 : sideX - 1;
      if (map.t(cx, doorY === sy0 + 1 ? doorY + 1 : doorY - 1) === T.Floor) {
        map.set(cx, doorY === sy0 + 1 ? doorY + 1 : doorY - 1, T.Counter, ch('═'), WOOD_FG, FLOOR_BG);
      }
      const catX = r.int(h.x0 + 1, h.x1 - 1), catY = r.int(sy0 + 1, sy1 - 1);
      if (map.t(catX, catY) === T.Floor) actors.push({ kind: AK.Cat, x: catX, y: catY });
      map.desc.set(map.idx(sideX, doorY), `The door of ${name}. Open late, like always.`);
    }

    // One storefront chapel per map, sign across the facing wall.
    if (!chapelPlaced && houses.length && r.chance(0.25)) {
      const h = r.pick(houses);
      if (h.x1 - h.x0 >= 6) {
        chapelPlaced = true;
        for (let y = sy0 + 1; y < sy1; y++) {
          for (let cx2 = h.x0 + 1; cx2 < h.x1; cx2++) {
            if (map.t(cx2, y) !== T.Floor) continue;
            map.set(cx2, y, T.Floor, ch('·'), FLOOR_FG, 0x100d14);
          }
        }
        const doorX = (h.x0 + h.x1) >> 1;
        map.set(doorX, faceY, T.DoorClosed, ch('+'), DOOR_FG, WALL_BG);
        const altarY = facing === 'N' ? sy1 - 1 : sy0 + 1;
        map.set(doorX, altarY, T.Altar, ch('☼'), ALTAR_FG, 0x100d14);
        const pewStart = facing === 'N' ? sy0 + 2 : sy0 + 1;
        for (let py = pewStart; py < sy1 - 1; py += 2) {
          if (py === altarY) continue;
          for (let px = h.x0 + 1; px < h.x1; px++) {
            if (px === doorX || map.t(px, py) !== T.Floor) continue;
            map.set(px, py, T.Pew, ch('≡'), WOOD_FG, 0x100d14);
          }
        }
        let li = 0;
        const letters = CHAPEL_NAME.replace(/ /g, '');
        for (let wx = h.x0 + 1; wx < h.x1 && li < letters.length; wx++) {
          if (map.t(wx, faceY) !== T.Wall) continue;
          map.set(wx, faceY, T.Sign, letters.charCodeAt(li++), 0xffd9a0, SIGN_BG);
          map.desc.set(map.idx(wx, faceY), `Warm letters over the door: ${CHAPEL_NAME}.`);
        }
      }
    }
  };

  const buildResidential = (b: Block) => {
    const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
    fillYard(b.x0, b.y0, b.x1, b.y1);
    // Alley at one end connects street sidewalk to the backyard.
    const alleyX = r.chance(0.5) ? b.x0 : b.x1;
    const stripX0 = alleyX === b.x0 ? b.x0 + 1 : b.x0;
    const stripX1 = alleyX === b.x1 ? b.x1 - 1 : b.x1;
    for (let y = b.y0; y <= b.y1; y++) map.set(alleyX, y, T.Alley, ch('·'), 0x4a4a50, 0x0c0c0f);
    if (stripX1 - stripX0 < 6 || w < 8) return;

    if (h >= 13) {
      const d = Math.min(6, (h - 3) >> 1);
      buildStrip(stripX0, stripX1, b.y0, b.y0 + d - 1, 'N', alleyX === b.x0 ? 'E' : 'W');
      buildStrip(stripX0, stripX1, b.y1 - d + 1, b.y1, 'S', alleyX === b.x0 ? 'E' : 'W');
    } else {
      const d = Math.min(7, h - 3);
      if (d >= 4) buildStrip(stripX0, stripX1, b.y0, b.y0 + d - 1, 'N', alleyX === b.x0 ? 'E' : 'W');
    }
  };

  blocks.forEach((b, i) => {
    if (i === parkIdx) buildPark(b);
    else if (r.chance(0.12)) buildVacant(b);
    else buildResidential(b);
  });

  // Graffiti pass over exterior walls.
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      if (map.t(x, y) !== T.Wall) continue;
      const facesOut =
        map.t(x, y - 1) === T.Sidewalk || map.t(x, y + 1) === T.Sidewalk ||
        map.t(x - 1, y) === T.Sidewalk || map.t(x + 1, y) === T.Sidewalk;
      if (facesOut && r.chance(0.05)) {
        map.set(x, y, T.GraffitiWall, ch('▒'), r.pick(NEON), WALL_BG);
        map.desc.set(map.idx(x, y), `Spray paint, fresh over old: "${r.pick(GRAFFITI)}"`);
      }
    }
  }

  // Trash drifts along sidewalks.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (map.t(x, y) === T.Sidewalk && r.chance(0.015)) {
        map.set(x, y, T.Trash, ch('%'), TRASH_FG, SIDEWALK_BG);
      }
    }
  }

  // 3. Spawns. Player on a sidewalk near the center.
  let spawn = { x: MAP_W >> 1, y: MAP_H >> 1 };
  outer: for (let rad = 0; rad < 60; rad++) {
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const x = (MAP_W >> 1) + dx, y = (MAP_H >> 1) + dy;
        if (map.inBounds(x, y) && map.t(x, y) === T.Sidewalk) { spawn = { x, y }; break outer; }
      }
    }
  }

  const spawnOn = (kind: AK, count: number, ok: (t: T) => boolean) => {
    let placed = 0, tries = 0;
    while (placed < count && tries++ < count * 60) {
      const x = r.int(1, MAP_W - 2), y = r.int(1, MAP_H - 2);
      if (ok(map.t(x, y)) && !(x === spawn.x && y === spawn.y)) {
        actors.push({ kind, x, y });
        placed++;
      }
    }
  };
  spawnOn(AK.Ped, 44, (t) => t === T.Sidewalk || t === T.Crosswalk);
  spawnOn(AK.Rat, 16, (t) => t === T.Rubble || t === T.Scrub || t === T.Alley);
  spawnOn(AK.Pigeon, 8, (t) => t === T.Road || t === T.Sidewalk);

  return { map, spawn, actors };
}
