// Local map generation: one neighborhood, deterministic from (world seed +
// neighborhood id + 2036 state). Area-type templates share a road-grid
// skeleton; 2036 stats parameterize decay, graffiti, vacancy, and crowd
// density; history residue stamps physical evidence (PRD §4.1).

import { Rand } from './rng';
import { AK, ActorSpawn, GameMap, MAP_H, MAP_W, T, ch } from './map';
import {
  AVENUE_NAMES, STREET_NAMES, BODEGA_NAMES, GRAFFITI, SHRINE_DESCS,
} from './flavor';
import { ARCHETYPES } from './content';
import type {
  FactionPack, NeighborhoodSeed, NeighborhoodState, ReligionPack,
} from './content/types';

// --- palette -----------------------------------------------------------------
const ASPHALT_BG = 0x17171c, ASPHALT_FG = 0x36363e;
const SIDEWALK_BG = 0x101014, SIDEWALK_FG = 0x6c6c74;
const LANE_FG = 0x6f662a;
const CROSS_FG = 0x84848c;
const WALL_FG = 0x8a6450, WALL_BG = 0x140f0c;
const CONCRETE_FG = 0x8a8a96, CONCRETE_BG = 0x101016;
const STEEL_FG = 0x6a7a86, STEEL_BG = 0x0d1014;
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
const LAMP_DEAD_FG = 0x4a4a50;
const HYDRANT_FG = 0xa83232;
const CAR_FG = [0x4a4f55, 0x5c4a45, 0x3f4a5c, 0x55554a, 0x6b3a3a];
const NEON = [0x00ffd0, 0xff3df0, 0x39ff5a, 0xffb52e, 0x44aaff, 0xff5544];
const SIGN_BG = 0x16081a;
const ALTAR_FG = 0xffd060;
const WOOD_FG = 0x7a5c34;
const WATER_FG = 0x2a5a7a, WATER_BG = 0x06101a;
const SHALLOW_FG = 0x3a6a82, SHALLOW_BG = 0x0a141c;
const PIER_FG = 0x8a7a5c, PIER_BG = 0x0f0d0a;
const FENCE_FG = 0x5a5a62;
const BURN_FG = 0x4a4038, BURN_BG = 0x0a0808;
const STATION_FG = 0x50d0a0;
const BARRICADE_FG = 0xb0a060;

export interface LocalCtx {
  hood: NeighborhoodSeed;
  state: NeighborhoodState;
  religions: { pack: ReligionPack; presence: number }[];
  factions: { pack: FactionPack; control: number }[];
}

export interface GenResult {
  map: GameMap;
  spawn: { x: number; y: number };
  actors: ActorSpawn[];
}

interface Params {
  avStep: [number, number];
  stStep: [number, number];
  block: 'rowhouse' | 'dense' | 'industrial' | 'projects' | 'suburban' | 'parkland' | 'civic';
  carDensity: number;
  pedBase: number;
}

const AREA_PARAMS: Record<string, Params> = {
  rowhouse: { avStep: [21, 27], stStep: [16, 20], block: 'rowhouse', carDensity: 0.5, pedBase: 40 },
  grid_dense: { avStep: [17, 21], stStep: [12, 15], block: 'dense', carDensity: 0.6, pedBase: 60 },
  industrial: { avStep: [32, 40], stStep: [24, 30], block: 'industrial', carDensity: 0.25, pedBase: 12 },
  projects: { avStep: [30, 36], stStep: [24, 30], block: 'projects', carDensity: 0.3, pedBase: 30 },
  suburban: { avStep: [22, 28], stStep: [12, 15], block: 'suburban', carDensity: 0.55, pedBase: 18 },
  parkland: { avStep: [34, 42], stStep: [26, 34], block: 'parkland', carDensity: 0.2, pedBase: 20 },
  waterfront: { avStep: [28, 36], stStep: [20, 26], block: 'industrial', carDensity: 0.3, pedBase: 16 },
  civic: { avStep: [20, 26], stStep: [14, 18], block: 'civic', carDensity: 0.4, pedBase: 35 },
};

export function generateLocalMap(worldSeed: string, ctx: LocalCtx): GenResult {
  const { hood, state } = ctx;
  const r = new Rand(worldSeed, `map:${hood.id}`);
  const map = new GameMap();
  map.hoodName = hood.name;
  const actors: ActorSpawn[] = [];
  const p = AREA_PARAMS[hood.area_type] ?? AREA_PARAMS.rowhouse;

  const decay = 1 - state.stats.infrastructure;
  const crime = state.stats.crime;
  const prosperity = state.stats.prosperity;

  const vacantChance = 0.05 + decay * 0.3;
  const graffitiChance = 0.015 + crime * 0.1;
  const trashChance = 0.005 + decay * 0.035;
  const lampDeadChance = decay * 0.55;

  // 0. Scrub base.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      map.set(x, y, T.Scrub, ch(r.chance(0.3) ? '"' : ','), r.pick(SCRUB_FG), SCRUB_BG);
    }
  }

  // 1. Road skeleton.
  const avenueNames = r.shuffle([...AVENUE_NAMES]);
  const streetNames = r.shuffle([...STREET_NAMES]);
  const avenueXs: number[] = [];
  for (let x = r.int(7, 10); x < MAP_W - 8; x += r.int(p.avStep[0], p.avStep[1])) avenueXs.push(x);
  const streetYs: number[] = [];
  for (let y = r.int(6, 9); y < MAP_H - 7; y += r.int(p.stStep[0], p.stStep[1])) streetYs.push(y);
  map.avenues = avenueXs.map((x, i) => ({ pos: x, name: avenueNames[i % avenueNames.length] }));
  map.streets = streetYs.map((y, i) => ({ pos: y, name: streetNames[i % streetNames.length] }));

  const sidewalkAt = (x: number, y: number) => {
    if (!map.inBounds(x, y)) return;
    map.set(x, y, T.Sidewalk, ch(r.chance(0.12) ? ',' : '.'), SIDEWALK_FG, SIDEWALK_BG);
  };
  const roadAt = (x: number, y: number) => {
    if (!map.inBounds(x, y)) return;
    map.set(x, y, T.Road, r.chance(0.06) ? ch('·') : 32, ASPHALT_FG, ASPHALT_BG);
  };
  for (const ax of avenueXs) for (let y = 0; y < MAP_H; y++) { sidewalkAt(ax - 3, y); sidewalkAt(ax + 3, y); }
  for (const sy of streetYs) for (let x = 0; x < MAP_W; x++) { sidewalkAt(x, sy - 2); sidewalkAt(x, sy + 2); }
  for (const ax of avenueXs) for (let y = 0; y < MAP_H; y++) for (let dx = -2; dx <= 2; dx++) roadAt(ax + dx, y);
  for (const sy of streetYs) for (let x = 0; x < MAP_W; x++) for (let dy = -1; dy <= 1; dy++) roadAt(x, sy + dy);

  for (const ax of avenueXs) {
    for (let y = 0; y < MAP_H; y++) {
      if (y % 3 === 0 || streetYs.some((sy) => Math.abs(y - sy) <= 2)) continue;
      if (map.t(ax, y) === T.Road) map.set(ax, y, T.RoadMark, ch('¦'), LANE_FG, ASPHALT_BG);
    }
  }
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

  // 2. Street furniture, decay-aware.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (map.t(x, y) !== T.Road) continue;
      if (r.chance(0.004)) map.set(x, y, T.Manhole, ch('o'), 0x46464e, ASPHALT_BG);
      else if (r.chance(0.002)) map.set(x, y, T.Vent, ch('≈'), 0x7a7a82, ASPHALT_BG);
    }
  }
  const lampAt = (x: number, y: number) => {
    if (!map.inBounds(x, y) || map.t(x, y) !== T.Sidewalk) return;
    if (r.chance(lampDeadChance)) {
      map.set(x, y, T.Lamp, ch('†'), LAMP_DEAD_FG, SIDEWALK_BG);
      map.lamps.pop(); // dead lamps don't glow
      map.desc.set(map.idx(x, y), 'A dead streetlamp. Copper thieves or budget, hard to say.');
    } else {
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
    for (let y = r.int(8, 20); y < MAP_H; y += 31) hydrantAt(ax - 3, y);
  }
  for (const sy of streetYs) {
    for (let x = r.int(2, 8); x < MAP_W; x += 11) { lampAt(x, sy - 2); lampAt(x + 5, sy + 2); }
    for (let x = r.int(10, 24); x < MAP_W; x += 37) hydrantAt(x, sy + 2);
  }
  const tryCar = (x: number, y: number) => {
    if (map.inBounds(x, y) && map.t(x, y) === T.Road) {
      map.set(x, y, T.Car, ch('■'), r.pick(CAR_FG), ASPHALT_BG);
    }
  };
  for (const ax of avenueXs) {
    for (const cx of [ax - 2, ax + 2]) {
      let y = r.int(1, 4);
      while (y < MAP_H - 2) {
        if (r.chance(p.carDensity)) { tryCar(cx, y); tryCar(cx, y + 1); y += 2 + r.int(1, 3); }
        else y += r.int(2, 5);
      }
    }
  }
  for (const sy of streetYs) {
    for (const cy of [sy - 1, sy + 1]) {
      let x = r.int(1, 4);
      while (x < MAP_W - 2) {
        if (r.chance(p.carDensity * 0.9)) { tryCar(x, cy); tryCar(x + 1, cy); x += 2 + r.int(1, 3); }
        else x += r.int(2, 5);
      }
    }
  }

  // 3. Blocks.
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

  let bodegaCount = 0;
  const holySites = ctx.religions.filter((rr) => rr.presence > 0.15).slice(0, 3);
  let holyPlaced = 0;
  let shrinePlaced = false;

  const fillYard = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (r.chance(0.04 + decay * 0.06)) map.set(x, y, T.Trash, ch('%'), TRASH_FG, SCRUB_BG);
        else map.set(x, y, T.Scrub, ch(r.chance(0.4) ? '"' : "'"), r.pick(SCRUB_FG), SCRUB_BG);
      }
    }
    if (!shrinePlaced && r.chance(0.15) && x1 > x0 && y1 > y0) {
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
    for (let f = r.int(1, 3); f > 0; f--) {
      const fx = r.int(b.x0 + 1, Math.max(b.x0 + 1, b.x1 - 4));
      const fy = r.int(b.y0 + 1, Math.max(b.y0 + 1, b.y1 - 1));
      for (let k = 0, len = r.int(2, 5); k < len && fx + k <= b.x1; k++) {
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
      if (r.chance(0.5) && map.t(x, my - 1) === T.Grass) map.set(x, my - 1, T.Bench, ch('Π'), WOOD_FG, GRASS_BG);
    }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) map.set(mx + dx, my + dy, T.Path, ch('·'), PATH_FG, PATH_BG);
    map.set(mx, my, T.Monument, ch('▲'), 0x8a8a92, PATH_BG);
    for (let pg = 0; pg < 8; pg++) actors.push({ kind: AK.Pigeon, x: r.int(b.x0, b.x1), y: r.int(b.y0, b.y1) });
  };

  // Convert one house footprint into a holy site for a founded faith.
  const buildHolySite = (hx0: number, hx1: number, sy0: number, sy1: number, faceY: number, pack: ReligionPack) => {
    const color = parseInt(pack.color.slice(1), 16);
    for (let y = sy0 + 1; y < sy1; y++) {
      for (let x = hx0 + 1; x < hx1; x++) {
        if (map.t(x, y) === T.Floor || map.t(x, y) === T.Furniture) {
          map.set(x, y, T.Floor, ch('·'), FLOOR_FG, 0x100d14);
        }
      }
    }
    const doorX = (hx0 + hx1) >> 1;
    map.set(doorX, faceY, T.DoorClosed, ch('+'), DOOR_FG, WALL_BG);
    const altarY = faceY === sy0 ? sy1 - 1 : sy0 + 1;
    map.set(doorX, altarY, T.Altar, pack.glyph.charCodeAt(0), color, 0x100d14);
    map.desc.set(map.idx(doorX, altarY), `An altar of the ${pack.name}. ${pack.tenets[0]}.`);
    for (let py = sy0 + 2; py < sy1 - 1; py += 2) {
      if (py === altarY) continue;
      for (let px = hx0 + 1; px < hx1; px++) {
        if (px === doorX || map.t(px, py) !== T.Floor) continue;
        map.set(px, py, T.Pew, ch('≡'), WOOD_FG, 0x100d14);
      }
    }
    let li = 0;
    const letters = pack.name.toUpperCase().replace(/[^A-Z]/g, '');
    for (let wx = hx0 + 1; wx < hx1 && li < letters.length; wx++) {
      if (map.t(wx, faceY) !== T.Wall) continue;
      map.set(wx, faceY, T.Sign, letters.charCodeAt(li++), color, SIGN_BG);
      map.desc.set(map.idx(wx, faceY), `${pack.glyph} ${pack.name}. ${pack.ritual.name}, at ${pack.ritual.schedule}.`);
    }
  };

  const wall = (x: number, y: number, g: string, fg = WALL_FG, bg = WALL_BG) => map.set(x, y, T.Wall, ch(g), fg, bg);

  const buildStrip = (sx0: number, sx1: number, sy0: number, sy1: number, facing: 'N' | 'S', avenueSide: 'W' | 'E') => {
    for (let x = sx0 + 1; x < sx1; x++) { wall(x, sy0, '─'); wall(x, sy1, '─'); }
    for (let y = sy0 + 1; y < sy1; y++) { wall(sx0, y, '│'); wall(sx1, y, '│'); }
    wall(sx0, sy0, '┌'); wall(sx1, sy0, '┐'); wall(sx0, sy1, '└'); wall(sx1, sy1, '┘');
    for (let y = sy0 + 1; y < sy1; y++) {
      for (let x = sx0 + 1; x < sx1; x++) map.set(x, y, T.Floor, ch('·'), FLOOR_FG, FLOOR_BG);
    }
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
      // Some houses are burnt-out or gutted in poor neighborhoods.
      if (r.chance(vacantChance * 0.35)) {
        for (let y = sy0 + 1; y < sy1; y++) {
          for (let gx = h.x0 + 1; gx < h.x1; gx++) {
            map.set(gx, y, T.Burnt, ch(r.pick(['%', '▪', ','])), BURN_FG, BURN_BG);
          }
        }
        map.set(r.int(h.x0 + 1, h.x1 - 1), faceY, T.DoorOpen, ch("'"), 0x4a4038, WALL_BG);
        map.desc.set(map.idx(r.int(h.x0 + 1, h.x1 - 1), faceY), 'A doorway with no door. The smell of old fire never fully leaves.');
        continue;
      }
      const doorX = r.int(h.x0 + 1, h.x1 - 1);
      map.set(doorX, faceY, T.DoorClosed, ch('+'), DOOR_FG, WALL_BG);
      for (let wx = h.x0 + 1; wx < h.x1; wx++) {
        if (wx !== doorX && r.chance(0.45)) map.set(wx, faceY, T.Window, ch('□'), WINDOW_FG, WALL_BG);
      }
      if (r.chance(0.35)) map.set(r.int(h.x0 + 1, h.x1 - 1), backY, T.DoorClosed, ch('+'), DOOR_FG, WALL_BG);
      for (let f = r.int(0, 2); f > 0; f--) {
        const fx = r.int(h.x0 + 1, h.x1 - 1), fy = r.int(sy0 + 1, sy1 - 1);
        if (map.t(fx, fy) === T.Floor && fx !== doorX) map.set(fx, fy, T.Furniture, ch('Π'), WOOD_FG, FLOOR_BG);
      }
    }

    // Corner bodega with vertical neon.
    if (bodegaCount < 2 + Math.round(prosperity * 5) && r.chance(0.35) && houses.length) {
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
      for (let ax2 = h.x0 + 2; ax2 <= h.x1 - 2; ax2 += 2) {
        for (let y = sy0 + 2; y <= sy1 - 2; y++) {
          if (map.t(ax2, y) === T.Floor) map.set(ax2, y, T.Shelf, ch('≡'), 0x9a8a52, FLOOR_BG);
        }
      }
      const catX = r.int(h.x0 + 1, h.x1 - 1), catY = r.int(sy0 + 1, sy1 - 1);
      if (map.t(catX, catY) === T.Floor) actors.push({ kind: AK.Cat, x: catX, y: catY });
      map.desc.set(map.idx(sideX, doorY), `The door of ${name}. Open late, like always.`);
    }

    // Holy sites for faiths present here.
    if (holyPlaced < holySites.length && houses.length > 1 && r.chance(0.3)) {
      const h = houses[Math.min(1, houses.length - 1)];
      if (h.x1 - h.x0 >= 6) {
        buildHolySite(h.x0, h.x1, sy0, sy1, faceY, holySites[holyPlaced].pack);
        holyPlaced++;
      }
    }
  };

  const buildResidential = (b: Block) => {
    const h = b.y1 - b.y0 + 1;
    fillYard(b.x0, b.y0, b.x1, b.y1);
    const alleyX = r.chance(0.5) ? b.x0 : b.x1;
    const stripX0 = alleyX === b.x0 ? b.x0 + 1 : b.x0;
    const stripX1 = alleyX === b.x1 ? b.x1 - 1 : b.x1;
    for (let y = b.y0; y <= b.y1; y++) map.set(alleyX, y, T.Alley, ch('·'), 0x4a4a50, 0x0c0c0f);
    if (stripX1 - stripX0 < 6) return;
    const side: 'W' | 'E' = alleyX === b.x0 ? 'E' : 'W';
    if (h >= 13) {
      const d = Math.min(6, (h - 3) >> 1);
      buildStrip(stripX0, stripX1, b.y0, b.y0 + d - 1, 'N', side);
      buildStrip(stripX0, stripX1, b.y1 - d + 1, b.y1, 'S', side);
    } else {
      const d = Math.min(7, h - 3);
      if (d >= 4) buildStrip(stripX0, stripX1, b.y0, b.y0 + d - 1, 'N', side);
    }
  };

  // Dense Manhattan-style block: building fills the block, interior courtyard,
  // storefronts along the avenue sides.
  const buildDense = (b: Block) => {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const edge = y === b.y0 || y === b.y1 || x === b.x0 || x === b.x1;
        if (edge) {
          const g = y === b.y0 ? (x === b.x0 ? '┌' : x === b.x1 ? '┐' : '─')
            : y === b.y1 ? (x === b.x0 ? '└' : x === b.x1 ? '┘' : '─')
            : '│';
          wall(x, y, g, CONCRETE_FG, CONCRETE_BG);
        } else {
          map.set(x, y, T.Floor, ch('·'), FLOOR_FG, FLOOR_BG);
        }
      }
    }
    // Interior courtyard.
    const cw = b.x1 - b.x0, chh = b.y1 - b.y0;
    if (cw > 9 && chh > 9) {
      for (let y = b.y0 + 4; y <= b.y1 - 4; y++) {
        for (let x = b.x0 + 4; x <= b.x1 - 4; x++) {
          const edge = y === b.y0 + 4 || y === b.y1 - 4 || x === b.x0 + 4 || x === b.x1 - 4;
          if (edge) wall(x, y, x === b.x0 + 4 || x === b.x1 - 4 ? '│' : '─', CONCRETE_FG, CONCRETE_BG);
          else map.set(x, y, T.Scrub, ch('"'), r.pick(SCRUB_FG), SCRUB_BG);
        }
      }
      // Courtyard access.
      map.set(b.x0 + 4, (b.y0 + b.y1) >> 1, T.DoorClosed, ch('+'), DOOR_FG, CONCRETE_BG);
    }
    // Doors + windows + storefront neon on the perimeter.
    for (const [fy, horiz] of [[b.y0, true], [b.y1, true]] as [number, boolean][]) {
      void horiz;
      for (let x = b.x0 + 2; x < b.x1 - 1; x += r.int(4, 7)) {
        map.set(x, fy, T.DoorClosed, ch('+'), DOOR_FG, CONCRETE_BG);
      }
      for (let x = b.x0 + 1; x < b.x1; x++) {
        if (map.t(x, fy) === T.Wall && r.chance(0.5)) map.set(x, fy, T.Window, ch('□'), WINDOW_FG, CONCRETE_BG);
      }
    }
    for (const fx of [b.x0, b.x1]) {
      for (let y = b.y0 + 2; y < b.y1 - 1; y += r.int(4, 7)) {
        map.set(fx, y, T.DoorClosed, ch('+'), DOOR_FG, CONCRETE_BG);
      }
    }
    // A storefront sign on one face.
    if (r.chance(0.5 + prosperity * 0.3)) {
      const name = r.pick(BODEGA_NAMES);
      const neon = r.pick(NEON);
      let li = 0;
      const letters = name.replace(/ /g, '');
      for (let x = b.x0 + 2; x < b.x1 - 1 && li < letters.length; x++) {
        if (map.t(x, b.y0) !== T.Wall && map.t(x, b.y0) !== T.Window) continue;
        map.set(x, b.y0, T.Sign, letters.charCodeAt(li++), neon, SIGN_BG);
        map.desc.set(map.idx(x, b.y0), `Storefront neon: ${name}.`);
      }
    }
  };

  const buildIndustrial = (b: Block) => {
    fillYard(b.x0, b.y0, b.x1, b.y1);
    // Fence the lot.
    for (let x = b.x0; x <= b.x1; x++) { map.set(x, b.y0, T.Fence, ch('╌'), FENCE_FG, SCRUB_BG); map.set(x, b.y1, T.Fence, ch('╌'), FENCE_FG, SCRUB_BG); }
    for (let y = b.y0; y <= b.y1; y++) { map.set(b.x0, y, T.Fence, ch('¦'), FENCE_FG, SCRUB_BG); map.set(b.x1, y, T.Fence, ch('¦'), FENCE_FG, SCRUB_BG); }
    map.set(r.chance(0.5) ? b.x0 : b.x1, r.int(b.y0 + 2, b.y1 - 2), T.Scrub, ch('·'), 0x4a4a50, SCRUB_BG); // gate gap
    map.set(r.int(b.x0 + 2, b.x1 - 2), r.chance(0.5) ? b.y0 : b.y1, T.Scrub, ch('·'), 0x4a4a50, SCRUB_BG);
    // Warehouse box.
    const wx0 = b.x0 + 2, wx1 = Math.min(b.x1 - 2, wx0 + r.int(14, 22));
    const wy0 = b.y0 + 2, wy1 = Math.min(b.y1 - 2, wy0 + r.int(8, 12));
    if (wx1 - wx0 >= 6 && wy1 - wy0 >= 5) {
      for (let x = wx0; x <= wx1; x++) { wall(x, wy0, '─', STEEL_FG, STEEL_BG); wall(x, wy1, '─', STEEL_FG, STEEL_BG); }
      for (let y = wy0; y <= wy1; y++) { wall(wx0, y, '│', STEEL_FG, STEEL_BG); wall(wx1, y, '│', STEEL_FG, STEEL_BG); }
      wall(wx0, wy0, '┌', STEEL_FG, STEEL_BG); wall(wx1, wy0, '┐', STEEL_FG, STEEL_BG);
      wall(wx0, wy1, '└', STEEL_FG, STEEL_BG); wall(wx1, wy1, '┘', STEEL_FG, STEEL_BG);
      for (let y = wy0 + 1; y < wy1; y++) for (let x = wx0 + 1; x < wx1; x++) {
        map.set(x, y, T.Floor, ch('·'), 0x4a4a52, 0x0c0c10);
      }
      // Big loading door + person door.
      const ldx = r.int(wx0 + 2, wx1 - 3);
      map.set(ldx, wy1, T.DoorClosed, ch('+'), STEEL_FG, STEEL_BG);
      map.set(ldx + 1, wy1, T.DoorClosed, ch('+'), STEEL_FG, STEEL_BG);
      // Pallets/crates inside.
      for (let c = r.int(3, 8); c > 0; c--) {
        const cx = r.int(wx0 + 1, wx1 - 1), cy = r.int(wy0 + 1, wy1 - 1);
        if (map.t(cx, cy) === T.Floor) map.set(cx, cy, T.Container, ch('▦'), 0x6a5a3a, 0x0c0c10);
      }
    }
    // Container yard in the rest.
    for (let c = r.int(2, 6); c > 0; c--) {
      const cx = r.int(b.x0 + 2, Math.max(b.x0 + 2, b.x1 - 4));
      const cy = r.int(Math.min(b.y1 - 1, wy1 + 2), b.y1 - 1);
      if (!map.inBounds(cx + 2, cy)) continue;
      for (let k = 0; k < 3; k++) {
        if (map.t(cx + k, cy) === T.Scrub || map.t(cx + k, cy) === T.Trash) {
          map.set(cx + k, cy, T.Container, ch('■'), r.pick([0x8c4a3a, 0x3a6a5a, 0x5a5a8c, 0x8c8c3a]), SCRUB_BG);
        }
      }
    }
    for (let rt = 4; rt > 0; rt--) actors.push({ kind: AK.Rat, x: r.int(b.x0 + 1, b.x1 - 1), y: r.int(b.y0 + 1, b.y1 - 1) });
  };

  const buildProjects = (b: Block) => {
    fillYard(b.x0, b.y0, b.x1, b.y1);
    const cx = (b.x0 + b.x1) >> 1, cy = (b.y0 + b.y1) >> 1;
    const half = Math.min(6, ((Math.min(b.x1 - b.x0, b.y1 - b.y0)) >> 1) - 2);
    if (half < 4) return;
    const tx0 = cx - half, tx1 = cx + half, ty0 = cy - half + 1, ty1 = cy + half - 1;
    for (let x = tx0; x <= tx1; x++) { wall(x, ty0, '─', CONCRETE_FG, CONCRETE_BG); wall(x, ty1, '─', CONCRETE_FG, CONCRETE_BG); }
    for (let y = ty0; y <= ty1; y++) { wall(tx0, y, '│', CONCRETE_FG, CONCRETE_BG); wall(tx1, y, '│', CONCRETE_FG, CONCRETE_BG); }
    wall(tx0, ty0, '┌', CONCRETE_FG, CONCRETE_BG); wall(tx1, ty0, '┐', CONCRETE_FG, CONCRETE_BG);
    wall(tx0, ty1, '└', CONCRETE_FG, CONCRETE_BG); wall(tx1, ty1, '┘', CONCRETE_FG, CONCRETE_BG);
    for (let y = ty0 + 1; y < ty1; y++) for (let x = tx0 + 1; x < tx1; x++) {
      map.set(x, y, T.Floor, ch('·'), 0x55514d, 0x0e0e12);
    }
    // Lobby door + cross hallways.
    map.set(cx, ty1, T.DoorClosed, ch('+'), DOOR_FG, CONCRETE_BG);
    for (let x = tx0 + 1; x < tx1; x++) if (x !== cx && r.chance(0.6)) map.set(x, ty0, T.Window, ch('□'), WINDOW_FG, CONCRETE_BG);
    // Paths from sidewalks to the tower.
    for (let y = b.y1 + 1 > MAP_H - 1 ? b.y1 : b.y1; y > ty1; y--) map.set(cx, y, T.Path, ch('·'), PATH_FG, PATH_BG);
    for (let x = b.x0; x < tx0; x++) map.set(x, cy, T.Path, ch('·'), PATH_FG, PATH_BG);
    for (let x = b.x1; x > tx1; x--) map.set(x, cy, T.Path, ch('·'), PATH_FG, PATH_BG);
    for (let bn = r.int(1, 3); bn > 0; bn--) {
      const bx = r.int(b.x0 + 1, b.x1 - 1);
      if (map.t(bx, cy + 1) === T.Scrub) map.set(bx, cy + 1, T.Bench, ch('Π'), WOOD_FG, SCRUB_BG);
    }
  };

  const buildSuburban = (b: Block) => {
    fillYard(b.x0, b.y0, b.x1, b.y1);
    for (let hx = b.x0 + 1; hx + 5 <= b.x1 - 1; hx += 7) {
      for (const [hy, faceY] of [[b.y0 + 1, b.y0 + 1], [b.y1 - 4, b.y1 - 1]] as number[][]) {
        if (hy + 3 > b.y1) continue;
        void faceY;
        for (let x = hx; x <= hx + 4; x++) { wall(x, hy, '─'); wall(x, hy + 3, '─'); }
        for (let y = hy; y <= hy + 3; y++) { wall(hx, y, '│'); wall(hx + 4, y, '│'); }
        wall(hx, hy, '┌'); wall(hx + 4, hy, '┐'); wall(hx, hy + 3, '└'); wall(hx + 4, hy + 3, '┘');
        for (let y = hy + 1; y < hy + 3; y++) for (let x = hx + 1; x < hx + 4; x++) {
          map.set(x, y, T.Floor, ch('·'), FLOOR_FG, FLOOR_BG);
        }
        const dy2 = hy === b.y0 + 1 ? hy : hy + 3;
        map.set(hx + 2, dy2, T.DoorClosed, ch('+'), DOOR_FG, WALL_BG);
        if (r.chance(0.6)) map.set(hx + r.pick([1, 3]), dy2, T.Window, ch('□'), WINDOW_FG, WALL_BG);
      }
    }
  };

  const buildCivic = (b: Block) => {
    // Plaza with a monumental building.
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) map.set(x, y, T.Path, ch(r.chance(0.06) ? '·' : ' '), PATH_FG, 0x121118);
    }
    const mx0 = b.x0 + 3, mx1 = b.x1 - 3, my0 = b.y0 + 2, my1 = b.y1 - 3;
    if (mx1 - mx0 < 8 || my1 - my0 < 5) return;
    for (let x = mx0; x <= mx1; x++) { wall(x, my0, '═', 0x9a9aa6, CONCRETE_BG); wall(x, my1, '═', 0x9a9aa6, CONCRETE_BG); }
    for (let y = my0; y <= my1; y++) { wall(mx0, y, '║', 0x9a9aa6, CONCRETE_BG); wall(mx1, y, '║', 0x9a9aa6, CONCRETE_BG); }
    wall(mx0, my0, '╔', 0x9a9aa6, CONCRETE_BG); wall(mx1, my0, '╗', 0x9a9aa6, CONCRETE_BG);
    wall(mx0, my1, '╚', 0x9a9aa6, CONCRETE_BG); wall(mx1, my1, '╝', 0x9a9aa6, CONCRETE_BG);
    for (let y = my0 + 1; y < my1; y++) for (let x = mx0 + 1; x < mx1; x++) {
      map.set(x, y, T.Floor, ch('·'), 0x5a5a64, 0x101018);
    }
    const doorX = (mx0 + mx1) >> 1;
    map.set(doorX, my1, T.DoorClosed, ch('+'), DOOR_FG, CONCRETE_BG);
    map.set(doorX - 1, my1, T.DoorClosed, ch('+'), DOOR_FG, CONCRETE_BG);
    // Columns.
    for (let x = mx0 + 2; x < mx1 - 1; x += 3) map.set(x, my1 + 1, T.Monument, ch('Φ'), 0x8a8a92, 0x121118);
  };

  const parkIdx = blocks.length && (p.block === 'rowhouse' || p.block === 'dense' || p.block === 'suburban')
    ? r.int(0, blocks.length - 1) : -1;

  blocks.forEach((b, i) => {
    if (p.block === 'parkland') {
      if (r.chance(0.8)) buildPark(b); else buildResidential(b);
      return;
    }
    if (i === parkIdx) { buildPark(b); return; }
    if (r.chance(vacantChance)) { buildVacant(b); return; }
    switch (p.block) {
      case 'dense': buildDense(b); break;
      case 'industrial': buildIndustrial(b); break;
      case 'projects': buildProjects(b); break;
      case 'suburban': buildSuburban(b); break;
      case 'civic': r.chance(0.4) ? buildCivic(b) : buildDense(b); break;
      default: buildResidential(b);
    }
  });

  // 4. Coastal water band (waterfront area type, or flooded by history).
  const waterDepth = hood.area_type === 'waterfront' ? r.int(5, 9) : 0;
  const floodDepth = state.flooded ? r.int(10, 18) : 0;
  const band = Math.max(waterDepth, floodDepth);
  if (band > 0 || hood.coastal) {
    const edgeRows = band || 0;
    for (let y = MAP_H - edgeRows; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const deep = y > MAP_H - edgeRows + 2;
        if (deep) map.set(x, y, T.Water, ch(r.chance(0.2) ? '≈' : '~'), WATER_FG, WATER_BG);
        else map.set(x, y, T.Shallow, ch('~'), SHALLOW_FG, SHALLOW_BG);
      }
    }
    if (edgeRows > 0) {
      // Mud line + pier.
      const my = MAP_H - edgeRows - 1;
      for (let x = 0; x < MAP_W; x++) {
        if (map.walkable(x, my) && r.chance(0.5)) {
          map.set(x, my, T.Scrub, ch(','), 0x4a4438, 0x0c0a08);
          if (r.chance(0.1)) map.desc.set(map.idx(x, my), 'The old waterline. Everything below this is on loan from the harbor.');
        }
      }
      const px = r.int(20, MAP_W - 20);
      for (let y = MAP_H - edgeRows - 1; y < Math.min(MAP_H, MAP_H - edgeRows + 6); y++) {
        map.set(px, y, T.Pier, ch('='), PIER_FG, PIER_BG);
        map.set(px + 1, y, T.Pier, ch('='), PIER_FG, PIER_BG);
      }
    }
  }

  // 5. History residue stamps.
  const wallTiles: number[] = [];
  for (let i = 0; i < map.terrain.length; i++) {
    if (map.terrain[i] === T.Wall) wallTiles.push(i);
  }
  const densityCount = { low: 3, med: 7, high: 14 } as const;
  for (const stamp of state.residue) {
    const n = densityCount[stamp.density];
    switch (stamp.type) {
      case 'graffiti':
      case 'banner': {
        for (let k = 0; k < n && wallTiles.length; k++) {
          const i = wallTiles[r.int(0, wallTiles.length - 1)];
          map.terrain[i] = T.GraffitiWall;
          map.glyph[i] = ch('▒');
          map.fg[i] = r.pick(NEON);
          if (stamp.text) map.desc.set(i, `${stamp.type === 'banner' ? 'A weathered banner' : 'Spray paint'}, ${stamp.year}: "${stamp.text}"`);
        }
        break;
      }
      case 'shrine':
      case 'memorial': {
        for (let k = 0; k < Math.ceil(n / 3); k++) {
          for (let tries = 0; tries < 40; tries++) {
            const x = r.int(2, MAP_W - 3), y = r.int(2, MAP_H - 3);
            if (map.t(x, y) === T.Sidewalk || map.t(x, y) === T.Scrub) {
              map.set(x, y, T.Shrine, ch(stamp.type === 'memorial' ? '♥' : '☼'), stamp.type === 'memorial' ? 0xd0d0e0 : ALTAR_FG, map.bg[map.idx(x, y)]);
              if (stamp.text) map.desc.set(map.idx(x, y), `${stamp.text} (${stamp.year})`);
              break;
            }
          }
        }
        break;
      }
      case 'burn': {
        // One charred half-block.
        for (let tries = 0; tries < 20; tries++) {
          const bx = r.int(10, MAP_W - 20), by = r.int(10, MAP_H - 20);
          if (map.t(bx, by) !== T.Floor && map.t(bx, by) !== T.Wall) continue;
          for (let y = by - 4; y <= by + 4; y++) {
            for (let x = bx - 6; x <= bx + 6; x++) {
              if (!map.inBounds(x, y)) continue;
              const t = map.t(x, y);
              if (t === T.Wall || t === T.Floor || t === T.Window || t === T.DoorClosed || t === T.Furniture) {
                map.set(x, y, T.Burnt, ch(r.pick(['%', '▪', ','])), BURN_FG, BURN_BG);
                if (r.chance(0.05)) map.desc.set(map.idx(x, y), `Char from the fire of ${stamp.year}.`);
              }
            }
          }
          break;
        }
        break;
      }
      case 'barricade': {
        // Checkpoint at an intersection.
        if (avenueXs.length && streetYs.length) {
          const ax = r.pick(avenueXs), sy = r.pick(streetYs);
          for (let dx = -2; dx <= 2; dx++) {
            if (r.chance(0.75)) {
              map.set(ax + dx, sy - 3 >= 0 ? sy - 3 : sy + 3, T.Barricade, ch('╬'), BARRICADE_FG, ASPHALT_BG);
            }
          }
          map.desc.set(map.idx(ax, sy - 3 >= 0 ? sy - 3 : sy + 3), `A checkpoint barricade from ${stamp.year}. Unmanned today. Probably.`);
        }
        break;
      }
      case 'flood': break; // handled by the water band
    }
  }

  // 6. Faction territory markings.
  const topFaction = ctx.factions.filter((f) => f.control > 0.2).sort((a, b) => b.control - a.control)[0];
  if (topFaction) {
    const color = parseInt(topFaction.pack.color.slice(1), 16);
    for (let k = 0; k < 6 && wallTiles.length; k++) {
      const i = wallTiles[r.int(0, wallTiles.length - 1)];
      map.terrain[i] = T.GraffitiWall;
      map.glyph[i] = topFaction.pack.glyph.charCodeAt(0);
      map.fg[i] = color;
      map.desc.set(i, `The mark of ${topFaction.pack.name}. ${topFaction.pack.ideology}`);
    }
  }

  // 7. Graffiti + trash ambient pass, stat-driven.
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      const t = map.t(x, y);
      if (t === T.Wall) {
        const facesOut =
          map.t(x, y - 1) === T.Sidewalk || map.t(x, y + 1) === T.Sidewalk ||
          map.t(x - 1, y) === T.Sidewalk || map.t(x + 1, y) === T.Sidewalk;
        if (facesOut && r.chance(graffitiChance)) {
          map.set(x, y, T.GraffitiWall, ch('▒'), r.pick(NEON), WALL_BG);
          map.desc.set(map.idx(x, y), `Spray paint, fresh over old: "${r.pick(GRAFFITI)}"`);
        }
      } else if (t === T.Sidewalk && r.chance(trashChance)) {
        map.set(x, y, T.Trash, ch('%'), TRASH_FG, SIDEWALK_BG);
      }
    }
  }

  // 8. Subway station (or its welded corpse).
  if (hood.subway.length || state.subway.length) {
    const ax = avenueXs[Math.floor(avenueXs.length / 2)] ?? 40;
    const sy = streetYs[Math.floor(streetYs.length / 2)] ?? 40;
    const sx2 = ax + 3, sy2 = sy + 2;
    const alive = state.subway.length > 0;
    for (const [dx, dy] of [[1, 1], [2, 1]]) {
      const x = sx2 + dx, y = sy2 + dy;
      if (!map.inBounds(x, y)) continue;
      if (alive) {
        map.set(x, y, T.Station, ch('>'), STATION_FG, 0x0a1410);
        map.desc.set(map.idx(x, y), `Subway entrance — ${state.subway.join(', ')} train${state.subway.length > 1 ? 's' : ''} still run here. (e to ride)`);
      } else {
        map.set(x, y, T.StationDead, ch('>'), 0x3a4a44, 0x0a0c0a);
      }
    }
    if (alive) map.station = { x: sx2 + 1, y: sy2 + 1 };
  }

  // 9. Ground loot, scaled by decay (ruins are generous, in their way).
  const LOOT_FLOOR = ['beans', 'street_dumpling', 'phone_dead', 'flask', 'bandage', 'painkillers', 'kitchen_knife', 'tallboy', 'watch_old'];
  const LOOT_RUIN = ['scrap_metal', 'copper_coil', 'pipe', 'salvage_battery', 'crowbar', 'blackout_candle'];
  const LOOT_STREET = ['scrap_metal', 'tallboy', 'umbrella', 'box_cutter', 'phone_dead'];
  const dropLoot = (x: number, y: number, table: string[], rare = 0.1) => {
    const id = r.chance(rare) ? table[table.length - 1] : r.pick(table.slice(0, -1));
    const i = map.idx(x, y);
    const pile = map.items.get(i) ?? [];
    pile.push({ id, qty: 1 });
    map.items.set(i, pile);
  };
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      const t = map.t(x, y);
      if (t === T.Floor && r.chance(0.006 + decay * 0.006)) dropLoot(x, y, LOOT_FLOOR);
      else if ((t === T.Rubble || t === T.Burnt) && r.chance(0.012)) dropLoot(x, y, LOOT_RUIN);
      else if ((t === T.Alley || t === T.Trash) && r.chance(0.02)) dropLoot(x, y, LOOT_STREET);
    }
  }

  // 10. Spawn + actors, scaled by stats.
  let spawn = { x: MAP_W >> 1, y: MAP_H >> 1 };
  outer: for (let rad = 0; rad < 70; rad++) {
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
  const popScale = Math.min(1.6, Math.max(0.3, state.population / 80000));
  const crowd = Math.round(p.pedBase * popScale);
  spawnOn(AK.Ped, Math.round(crowd * 0.45), (t) => t === T.Sidewalk || t === T.Crosswalk);
  spawnOn(AK.Rat, Math.round(8 + decay * 16), (t) => t === T.Rubble || t === T.Scrub || t === T.Alley || t === T.Burnt);
  spawnOn(AK.Pigeon, 8, (t) => t === T.Road || t === T.Sidewalk || t === T.Grass);

  // Named NPCs with lives: archetype mix driven by area + 2036 stats.
  const archWeights = ARCHETYPES.map((a) => {
    let w = a.weight;
    if (a.id === 'hustler' || a.id === 'enforcer') w *= 0.5 + crime * 2.2;
    if (a.id === 'watchman') w *= 0.4 + (1 - crime) * 1.2 + prosperity;
    if (a.id === 'preacher') w *= 0.4 + state.stats.cult * 4;
    if (a.id === 'dockworker') w *= hood.area_type === 'industrial' || hood.area_type === 'waterfront' ? 3 : 0.4;
    if (a.id === 'technician') w *= hood.area_type === 'industrial' ? 2.5 : 0.8;
    if (a.id === 'drifter') w *= 0.5 + decay * 2;
    if (a.id === 'vendor') w *= 0.5 + popScale;
    return w;
  });
  const totalW = archWeights.reduce((s, w) => s + w, 0);
  const pickArch = (): number => {
    let roll = r.float() * totalW;
    for (let i = 0; i < archWeights.length; i++) {
      roll -= archWeights[i];
      if (roll <= 0) return i;
    }
    return 0;
  };
  let npcCount = Math.round(crowd * 0.55);
  let tries = 0;
  while (npcCount > 0 && tries++ < 2000) {
    const x = r.int(1, MAP_W - 2), y = r.int(1, MAP_H - 2);
    const t = map.t(x, y);
    if (t !== T.Sidewalk && t !== T.Crosswalk && t !== T.Floor && t !== T.Path) continue;
    actors.push({ kind: AK.NPC, x, y, arch: pickArch() });
    npcCount--;
  }

  return { map, spawn, actors };
}
