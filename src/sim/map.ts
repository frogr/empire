// Tile layer: terrain ids, flags, descriptions, and the GameMap typed-array
// container. Generation lives in mapgen.ts.

export const MAP_W = 168;
export const MAP_H = 168;

export enum T {
  Scrub = 0, Road, RoadMark, Crosswalk, Manhole, Vent, Sidewalk, Alley,
  Wall, Sign, GraffitiWall, DoorClosed, DoorOpen, Window,
  Floor, Shelf, Counter, Pew, Altar, Furniture,
  Grass, Tree, Path, Bench, Monument, Shrine,
  Rubble, Trash, Lamp, Hydrant, Car,
  Water, Shallow, Pier, Fence, Container, Barricade,
  Station, StationDead, Burnt,
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
  [T.Water]: [false, false], [T.Shallow]: [true, false], [T.Pier]: [true, false],
  [T.Fence]: [false, false], [T.Container]: [false, true], [T.Barricade]: [false, false],
  [T.Station]: [true, false], [T.StationDead]: [false, true], [T.Burnt]: [true, false],
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
  [T.Wall]: 'Brick wall.',
  [T.Sign]: 'Lettering, still legible. Still lit, some of it.',
  [T.GraffitiWall]: 'A tag, layered over older tags.',
  [T.DoorClosed]: 'A door, shut against the evening.',
  [T.DoorOpen]: 'An open door.',
  [T.Window]: 'A window. Curtains, or the memory of curtains.',
  [T.Floor]: 'Worn floorboards.',
  [T.Shelf]: 'Shelving: canned goods, candles, lottery hope.',
  [T.Counter]: 'A scuffed counter with a plexiglass ghost.',
  [T.Pew]: 'A wooden pew, polished by decades of sitting.',
  [T.Altar]: 'An altar crowded with candles. Some are lit.',
  [T.Furniture]: "Somebody's furniture, surviving.",
  [T.Grass]: 'Park grass, longer than the city used to allow.',
  [T.Tree]: 'A street tree, older than every government it has outlived.',
  [T.Path]: 'A gravel path.',
  [T.Bench]: 'A bench with one new plank and three ancient ones.',
  [T.Monument]: 'A stone monument. The plaque has been pried off.',
  [T.Shrine]: 'A street shrine.',
  [T.Rubble]: 'Rubble. Brick, rebar, drywall snow.',
  [T.Trash]: 'A drift of garbage, sorted by wind.',
  [T.Lamp]: 'A streetlamp.',
  [T.Hydrant]: 'A fire hydrant, painted and repainted.',
  [T.Car]: 'A parked car. Possibly abandoned. Possibly home.',
  [T.Water]: 'Harbor water, the color of old coins.',
  [T.Shallow]: 'Standing water over old asphalt. The street is still down there.',
  [T.Pier]: 'Pier planking, salt-bleached and soft in places.',
  [T.Fence]: 'Chain-link, leaning but committed.',
  [T.Container]: 'A shipping container. Locked, dented, painted over.',
  [T.Barricade]: 'A checkpoint barricade of concrete and accumulated signage.',
  [T.Station]: 'A subway entrance. Warm air and old electricity breathe up the steps.',
  [T.StationDead]: 'A welded subway gate. The MTA successor calls this "service adjustment."',
  [T.Burnt]: 'Char and ash, rained on and dried a hundred times.',
};

export const ch = (s: string) => s.charCodeAt(0);

export interface NamedRoad { pos: number; name: string }
export interface ActorSpawn { kind: number; x: number; y: number; arch?: number }
export enum AK { Ped = 0, Rat = 1, Pigeon = 2, Cat = 3, NPC = 4 }

export class GameMap {
  readonly w: number;
  readonly h: number;
  terrain: Uint8Array;
  glyph: Uint16Array;
  fg: Uint32Array;
  bg: Uint32Array;
  flags: Uint8Array;
  explored: Uint8Array;
  desc = new Map<number, string>(); // tile-specific examine text overrides
  items = new Map<number, { id: string; qty: number }[]>(); // ground loot per tile
  avenues: NamedRoad[] = [];
  streets: NamedRoad[] = [];
  lamps: number[] = []; // tile indices, for night glow
  station: { x: number; y: number } | null = null;
  hoodName = '';

  constructor(w = MAP_W, h = MAP_H) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.terrain = new Uint8Array(n);
    this.glyph = new Uint16Array(n);
    this.fg = new Uint32Array(n);
    this.bg = new Uint32Array(n);
    this.flags = new Uint8Array(n);
    this.explored = new Uint8Array(n);
  }

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
    if (t === T.Lamp) this.lamps.push(i);
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
    const i = this.idx(x, y);
    this.set(x, y, T.DoorOpen, ch("'"), this.fg[i], this.bg[i]);
  }

  closeDoor(x: number, y: number): void {
    const i = this.idx(x, y);
    this.set(x, y, T.DoorClosed, ch('+'), this.fg[i], this.bg[i]);
  }

  nearestIntersection(x: number, y: number): string {
    const nearest = (roads: NamedRoad[], p: number) =>
      roads.reduce((a, b) => (Math.abs(b.pos - p) < Math.abs(a.pos - p) ? b : a));
    if (!this.streets.length || !this.avenues.length) return this.hoodName;
    return `${nearest(this.streets, y).name} & ${nearest(this.avenues, x).name}`;
  }
}
