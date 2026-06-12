// Game state + turn resolution. Lives entirely in the sim worker.
// Owns the world (2026→2036 history output), the active neighborhood map,
// travel, day/night, the player character, and the actor pool.

import { computeFOV } from './fov';
import { GameMap, T, AK } from './map';
import { generateLocalMap, GenResult } from './mapgen';
import { simulateHistory } from './worldgen/history';
import { CitySim, T2Incident } from './city';
import { Director } from './director';
import { Rand } from './rng';
import { Grammar } from './content/grammar';
import { GRAMMAR_RULES, RELIGIONS, FACTIONS, ORIGINS, NAMES, ITEM_BY_ID, ARCHETYPES, LEAGUES, CITYMAP, QUEST_TEMPLATES } from './content';
import { PlayerChar, SKILLS, STATS, INJURY_LABEL, ItemStack } from './player';
import {
  PED_BARKS, BUMP_PED, INTRO, TRAVEL_WALK, TRAVEL_SUBWAY, ARRIVE,
} from './flavor';
import type { Action, FrameMeta, Hint, Msg, PulseCell } from '../bridge/protocol';
import type {
  ChronicleEntry, Grave, NeighborhoodSeed, NeighborhoodState, OriginDef, QuestKind, QuestTemplateDef, StreetSceneDef, WorldState,
} from './content/types';

export interface SaveData {
  version: number;
  seed: string;
  turn: number;
  clockMin: number;
  hoodId: string;
  px: number;
  py: number;
  pc: Record<string, unknown>;
  hoods: Record<string, Pick<NeighborhoodState, 'stats' | 'population' | 'flooded' | 'subway' | 'faiths' | 'control'>>;
  chronicle: ChronicleEntry[];
  graves: Grave[];
  faith: string | null;
  favor: Record<string, number>;
  quest?: { kind: string; itemId: string; targetHood?: string; reward: number; giver: string } | null; // v1 legacy
  quests?: Quest[];                    // v2
  questSerial?: number;                // v2
  standing?: Record<string, number>;   // v2
  bets: { league: string; team: string; stake: number; odds: number; day: number }[];
  heat: number;
  heatByBorough: Record<string, number>;
  lastDay: number;
  lastT2: number;
  lastPulse?: number;          // v2
  lastEditionBand?: number;    // v2
  pendingHeadlines?: string[]; // v2
  director?: { lastBeat: number; lastEncounter: number };  // v2
  searched?: Record<string, number[]>; // v2 — dug-through tiles per hood
  lastRitual: number;
  city: unknown;
  maps: Record<string, { explored: string; items: [number, { id: string; qty: number }[]][]; doors: number[] }>;
}

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const MAX_ACTORS = 160;
const MAP_CACHE_CAP = 6;

export const MSG_DEFAULT = 0xb8b8b8;
const MSG_SYSTEM = 0x6fd4c0;
const MSG_AMBIENT = 0x76869a;
const MSG_BARK = 0xc9b458;
const MSG_TRAVEL = 0x9aa8d0;
const MSG_GOOD = 0x70c070;
const MSG_BAD = 0xc05a50;

const PED_COLORS = [0x8c8c94, 0x7d8a99, 0x99887d, 0x8a7d99, 0x7d997f, 0xa09078];
const ACTOR_GLYPH: Record<number, number> = {
  [AK.Ped]: '☺'.charCodeAt(0),
  [AK.Rat]: 'r'.charCodeAt(0),
  [AK.Pigeon]: '^'.charCodeAt(0),
  [AK.Cat]: 'c'.charCodeAt(0),
  [AK.NPC]: '☻'.charCodeAt(0),
};
const ARCH_COLOR: Record<string, number> = {
  resident: 0x9a9aa4, vendor: 0xc8a050, dockworker: 0x8a7a5a, technician: 0x5aa89a,
  street_medic: 0xd07070, preacher: 0xb8a0d8, hustler: 0xb070b0, enforcer: 0xc05a50,
  watchman: 0x5a8ac0, drifter: 0x7a8068,
};

// Actor states.
const ST_SCHEDULE = 0, ST_HOSTILE = 1, ST_FLEE = 2, ST_PANIC = 3, ST_SCENE = 4, ST_BRAWL = 5;
const AF_QUESTGIVER = 8; // joins AF_DISARMED/AF_LIMP/AF_BLEED below
// Actor flag bits.
const AF_DISARMED = 1, AF_LIMP = 2, AF_BLEED = 4;

type BodyPart = 'head' | 'torso' | 'arms' | 'legs';
const PART_MOD: Record<BodyPart, number> = { head: -22, torso: 0, arms: -12, legs: -12 };

const BLOCK_MSG: Partial<Record<T, string>> = {
  [T.Wall]: 'Brick.',
  [T.Sign]: 'The lettering buzzes at eye level. Solid wall behind it.',
  [T.GraffitiWall]: 'A tagged wall. The paint is newer than the brick.',
  [T.Window]: 'A window. You could break it. Not tonight.',
  [T.Car]: 'A parked car blocks the way.',
  [T.Tree]: 'A street tree stands its ground.',
  [T.Shelf]: 'Shelving blocks the aisle.',
  [T.Counter]: 'The counter is in the way.',
  [T.Pew]: 'A pew blocks the way.',
  [T.Altar]: 'You stop short of the altar.',
  [T.Bench]: 'A bench.',
  [T.Monument]: 'The monument is not going anywhere.',
  [T.Lamp]: 'A lamppost. You walked into a lamppost.',
  [T.Hydrant]: 'A hydrant, knee-high and smug.',
  [T.Shrine]: 'You step carefully around the shrine.',
  [T.Water]: 'Harbor water. You are not that kind of desperate yet.',
  [T.Fence]: 'Chain-link. It leans away from you, unhelpfully intact.',
  [T.Container]: 'A shipping container, locked.',
  [T.Barricade]: 'Checkpoint concrete. Climbing it would be a statement.',
  [T.StationDead]: 'The gate is welded. The downstairs dark has the tunnel smell anyway.',
  [T.DoorLocked]: 'Locked. The kind of locked that means it. [e] to argue.',
};

const PED_TILES = new Set<T>([T.Sidewalk, T.Crosswalk, T.Road, T.Alley, T.Path, T.Pier]);
const VAULTABLE = new Set<T>([T.Car, T.Fence, T.Bench, T.Barricade, T.Counter, T.Hydrant]);
const PIGEON_TILES = new Set<T>([T.Road, T.Sidewalk, T.Crosswalk, T.Grass, T.Path, T.Scrub, T.Pier]);
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

// One-off relics found behind locked doors (defs in content/packs/items_relics.json).
const RELIC_IDS = [
  'ferry_token_31', 'waterline_photo', 'transit_map_old', 'sermon_tape',
  'campaign_button', 'rooftop_key',
];

// Staged when a Tier-2 death lands on the block you're standing in.
const BODY_DISCOVERED: StreetSceneDef = {
  id: 'body_discovered',
  weight: 1,
  behavior: 'vigil',
  spawn: { count: [3, 5] },
  duration: [30, 50],
  text: {
    start: 'A crowd is knotting up around something at the curb. Nobody is talking loudly.',
    tick: 'Someone lights a candle at the curb. Someone else makes a call they have been dreading.',
    end: 'A van takes the body away. The crowd unknots. The block exhales, ashamed of itself.',
  },
};

const BOROUGH_COLOR: Record<string, number> = {
  manhattan: 0xb8b8c8, brooklyn: 0xd0a040, queens: 0x5a9ad0,
  bronx: 0xc05a50, staten_island: 0x5ab070,
};
const BOROUGH_LABEL: Record<string, string> = {
  manhattan: 'Manhattan', brooklyn: 'Brooklyn', queens: 'Queens',
  bronx: 'The Bronx', staten_island: 'Staten Island',
};

interface CachedHood {
  gen: GenResult;
  lastUsed: number;
}

interface ActiveScene {
  def: StreetSceneDef;
  x: number;
  y: number;
  actors: number[];
  endsAt: number;
  lastTick: number;
}

interface Encounter {
  kind: 'mugger' | 'watchman' | 'toll' | 'recruiter';
  idx: number; // actor index, or -1
  toll?: number;
  faction?: string;
  dest?: string; // toll: travel destination
  faith?: string;
}

interface Menu {
  kind: 'origin' | 'inventory' | 'item' | 'bodypart' | 'shop' | 'bet' | 'altar' | 'encounter';
  title: string;
  entries: { label: string; sub?: string; fg?: number; data?: string }[];
  sel: number;
  itemId?: string; // for item action menus
  targetIdx?: number; // for body-part menus
}

interface Quest {
  id: string;          // instance id, unique per run
  kind: QuestKind;
  desc: string;        // journal line
  itemId: string;      // what you carry / collect ('' for collect)
  qty: number;         // scavenge target (1 otherwise)
  targetHood?: string; // where it resolves (deliver/collect/errand/task)
  reward: number;
  giver: string;
  faction?: string;    // task: standing on completion
  faith?: string;      // errand: favor on completion
  twist?: boolean;     // deliver: it was bait
}

const QUEST_CAP = 3;

export class Game {
  readonly seed: string;
  readonly world: WorldState;
  private seeds: NeighborhoodSeed[];
  private seedById: Map<string, NeighborhoodSeed>;
  map!: GameMap;
  hoodId = '';
  pc!: PlayerChar;
  px = 0;
  py = 0;
  turn = 0;
  private clockMin = (12 * 24 + 19) * 60 + 12; // Oct 13 2036, 19:12 (day 0 = Oct 1)
  private visible!: Uint8Array;
  private msgs: Msg[] = [];
  outbox: { kind: 'journal' | 'news'; title: string; lines: Msg[] }[] = [];
  private mode: 'play' | 'look' | 'citymap' | 'menu' | 'target' = 'menu';
  private menu: Menu | null = null;
  private lookX = 0;
  private lookY = 0;
  private lookText = '';
  private selectedHood = '';
  private lastAmbient = 0;
  private rTurn: Rand;
  private grammar: Grammar;
  private hoodCache = new Map<string, CachedHood>();
  private pendingVault = false;
  private heat = 0; // law attention in the current borough
  private heatByBorough: Record<string, number> = {};
  private targets: number[] = [];
  private targetSel = 0;
  private pulseCells: PulseCell[] = []; // rebuilt by fillView/fillCityMap, shipped in meta
  private city!: CitySim;
  private lastDay = -1;
  private lastT2 = 0;
  private lastPulse = 0;
  private lastEditionBand = -1; // day*3 + (0 night / 1 daytime / 2 evening)
  private pendingHeadlines: string[] = [];
  private pendingIncidents: T2Incident[] = []; // local T2 incidents awaiting staging
  private director: Director;
  private scene: ActiveScene | null = null; // transient; ends on travel
  private encounter: Encounter | null = null;
  private searched = new Map<string, Set<number>>(); // hoodId → dug-through tiles
  private quests: Quest[] = [];
  private questSerial = 0;
  private standing: Record<string, number> = {}; // faction goodwill, earned by work
  private faith: string | null = null; // joined religion pack id
  private favor: Record<string, number> = {};
  private lastRitual = 0;
  private bets: { league: string; team: string; stake: number; odds: number; day: number }[] = [];

  // Actors, structure-of-arrays, rebuilt per neighborhood.
  private aCount = 0;
  private aKind = new Uint8Array(MAX_ACTORS);
  private aX = new Int16Array(MAX_ACTORS);
  private aY = new Int16Array(MAX_ACTORS);
  private aHomeX = new Int16Array(MAX_ACTORS);
  private aHomeY = new Int16Array(MAX_ACTORS);
  private aWorkX = new Int16Array(MAX_ACTORS);
  private aWorkY = new Int16Array(MAX_ACTORS);
  private aColor = new Uint32Array(MAX_ACTORS);
  private aDir = new Uint8Array(MAX_ACTORS);
  private aAlive = new Uint8Array(MAX_ACTORS);
  private aArch = new Uint8Array(MAX_ACTORS);
  private aHp = new Int16Array(MAX_ACTORS);
  private aState = new Uint8Array(MAX_ACTORS);
  private aFlags = new Uint8Array(MAX_ACTORS);
  private aStun = new Uint8Array(MAX_ACTORS);
  private aBarkCd = new Uint16Array(MAX_ACTORS);
  private aTarget = new Int16Array(MAX_ACTORS).fill(-1); // brawl opponent
  private occ!: Int32Array;
  private tilesInterior: number[] = [];
  private tilesCorner: number[] = [];
  private tilesAltar: number[] = [];

  constructor(seed: string, seeds: NeighborhoodSeed[], onProgress?: (text: string) => void) {
    this.seed = seed;
    this.seeds = seeds;
    this.seedById = new Map(seeds.map((s) => [s.id, s]));
    this.world = simulateHistory(seed, seeds, (year) => onProgress?.(`Simulating ${year}…`));
    onProgress?.('Pouring concrete…');
    this.rTurn = new Rand(seed, 'turns');
    this.grammar = new Grammar(GRAMMAR_RULES);
    this.director = new Director(seed);
    // Boot into origin selection; the world waits.
    this.menu = {
      kind: 'origin',
      title: 'WHO WERE YOU, BEFORE TONIGHT?',
      entries: ORIGINS.map((o) => ({ label: o.name, sub: o.blurb })),
      sel: 0,
    };
  }

  private say(text: string, fg = MSG_DEFAULT): void {
    this.msgs.push({ text, fg });
  }

  private hoodName(): string {
    return this.seedById.get(this.hoodId)?.name ?? this.hoodId;
  }

  private hourOfDay(): number {
    return (this.clockMin / 60) % 24;
  }

  private daylight(): number {
    const h = this.hourOfDay();
    if (h >= 7 && h < 18) return 1;
    if (h >= 18 && h < 21) return 1 - (h - 18) / 3;
    if (h >= 5 && h < 7) return (h - 5) / 2;
    return 0;
  }

  // --- character creation ------------------------------------------------------

  private chooseOrigin(origin: OriginDef): void {
    const rp = new Rand(this.seed, 'player');
    const name = `${rp.pick(NAMES.first)} ${rp.pick(NAMES.last)}`;
    this.pc = new PlayerChar(name, origin, rp);
    if (!this.city) this.city = new CitySim(this.seed, this.world, this.seeds);
    const startHood = this.pickStartHood(origin.start_pref, rp);
    this.menu = null;
    this.mode = 'play';
    this.enterHood(startHood, 'spawn');
    this.selectedHood = startHood;
    this.say(`EMPIRE://36 — ${this.hoodName()}, October 2036.`, MSG_SYSTEM);
    this.say(`You are ${name}, ${origin.name.toLowerCase()}. World seed: ${this.seed}`, 0x5a6a78);
    for (const line of INTRO) this.say(line, MSG_DEFAULT);
    this.say('[?] help  [i] inventory  [c] you  [m] city map  [J] chronicle', 0x5a6a78);
  }

  private pickStartHood(pref: string, r: Rand): string {
    const ns = (id: string) => this.world.neighborhoods[id];
    const byArea = (area: string) => this.seeds.filter((s) => s.area_type === area && !ns(s.id).flooded);
    let pool: NeighborhoodSeed[] = [];
    if (pref === 'cult') {
      pool = [...this.seeds].sort((a, b) => ns(b.id).stats.cult - ns(a.id).stats.cult).slice(0, 5);
    } else if (pref === 'crime') {
      pool = [...this.seeds].sort((a, b) => ns(b.id).stats.crime - ns(a.id).stats.crime).slice(0, 5);
    } else if (pref === 'poor') {
      pool = [...this.seeds].sort((a, b) => ns(a.id).stats.prosperity - ns(b.id).stats.prosperity).slice(0, 5);
    } else {
      pool = byArea(pref);
    }
    if (!pool.length) pool = this.seeds.filter((s) => !ns(s.id).flooded);
    if (!pool.length) pool = this.seeds;
    const brooklyn = pool.filter((s) => s.borough === 'brooklyn');
    return r.pick(brooklyn.length ? brooklyn : pool).id;
  }

  // --- neighborhood entry / travel ----------------------------------------------

  private localGen(id: string): GenResult {
    const cached = this.hoodCache.get(id);
    if (cached) {
      cached.lastUsed = this.turn;
      return cached.gen;
    }
    const hood = this.seedById.get(id)!;
    const state = this.world.neighborhoods[id];
    const gen = generateLocalMap(this.seed, {
      hood,
      state,
      religions: this.world.religions
        .map((f) => ({ pack: RELIGIONS.find((p) => p.id === f.packId)!, presence: state.faiths[f.packId] ?? 0 }))
        .filter((x) => x.pack),
      factions: this.world.factions
        .map((f) => ({ pack: FACTIONS.find((p) => p.id === f.packId)!, control: state.control[f.packId] ?? 0 }))
        .filter((x) => x.pack),
    });
    // Lock a few doors over whatever somebody left behind (M7 stashes).
    const rs = new Rand(this.seed, `stash:${id}`);
    const doorIdx: number[] = [];
    for (let i = 0; i < gen.map.terrain.length; i++) if (gen.map.terrain[i] === T.DoorClosed) doorIdx.push(i);
    rs.shuffle(doorIdx);
    for (const di of doorIdx.slice(0, Math.min(doorIdx.length, 1 + rs.int(0, 2)))) {
      const x = di % gen.map.w, y = Math.floor(di / gen.map.w);
      gen.map.set(x, y, T.DoorLocked, '+'.charCodeAt(0), 0xb08a40, gen.map.bg[di]);
    }
    if (this.hoodCache.size >= MAP_CACHE_CAP) {
      let evict: string | null = null;
      let oldest = Infinity;
      for (const [k, v] of this.hoodCache) {
        if (k !== this.hoodId && v.lastUsed < oldest) { oldest = v.lastUsed; evict = k; }
      }
      if (evict) this.hoodCache.delete(evict);
    }
    this.hoodCache.set(id, { gen, lastUsed: this.turn });
    return gen;
  }

  private hasBoon(effectId: string): boolean {
    if (!this.faith || (this.favor[this.faith] ?? 0) < 3) return false;
    const pack = RELIGIONS.find((p) => p.id === this.faith);
    return pack?.boon.id === effectId;
  }

  private enterHood(id: string, via: 'spawn' | 'walk' | 'subway'): void {
    // Heat is tracked per borough; carry it across the right ledger.
    if (this.hoodId) {
      const oldB = this.seedById.get(this.hoodId)?.borough;
      if (oldB) this.heatByBorough[oldB] = this.heat;
    }
    const newB = this.seedById.get(id)?.borough;
    this.heat = newB ? this.heatByBorough[newB] ?? 0 : 0;
    const gen = this.localGen(id);
    this.hoodId = id;
    this.map = gen.map;
    this.applyMapDiff(id, gen.map);
    this.visible = new Uint8Array(this.map.w * this.map.h);
    this.occ = new Int32Array(this.map.w * this.map.h).fill(-1);
    // Candidate tiles for NPC homes, posts, and worship.
    this.tilesInterior = [];
    this.tilesCorner = [];
    this.tilesAltar = [];
    for (let i = 0; i < this.map.terrain.length; i++) {
      const t = this.map.terrain[i] as T;
      if (t === T.Floor) this.tilesInterior.push(i);
      else if (t === T.Crosswalk) this.tilesCorner.push(i);
      else if (t === T.Altar) this.tilesAltar.push(i);
    }
    // Graves of past lives leave their mark even on regenerated maps.
    for (const grave of this.world.graves) {
      if (grave.hood !== id) continue;
      const gi = this.map.idx(grave.x, grave.y);
      if (!this.map.desc.has(gi)) {
        this.map.desc.set(gi, `${grave.name} died here. ${grave.cause}. Someone chalked the outline and somebody else added a halo.`);
      }
    }
    if (via === 'subway' && gen.map.station) {
      this.px = gen.map.station.x;
      this.py = gen.map.station.y + 1;
      if (!this.map.walkable(this.px, this.py)) {
        this.px = gen.spawn.x;
        this.py = gen.spawn.y;
      }
    } else {
      this.px = gen.spawn.x;
      this.py = gen.spawn.y;
    }
    this.spawnActors(gen);
    this.computeVision();
    this.pendingIncidents = [];
    this.scene = null; // scenes don't follow you across the river
    this.encounter = null;
    this.director.blackoutUntil = 0;
    if (via !== 'spawn') {
      this.sayArrival(id);
      // The neighborhood has been talking while you weren't here.
      if (this.city) {
        const word = this.city.rumors.filter((r) => r.hood === id).slice(-2);
        for (const r of word) this.say(`Word on the street: ${this.city.expandRumor(r.text)}`, r.fg);
      }
    }
  }

  private sayArrival(id: string): void {
    const state = this.world.neighborhoods[id];
    const seed = this.seedById.get(id)!;
    this.say(`${seed.name}, ${BOROUGH_LABEL[seed.borough]}.`, MSG_SYSTEM);
    const bank = state.flooded ? ARRIVE.flooded
      : state.stats.cult > 0.3 ? ARRIVE.cult
      : state.stats.crime > 0.62 ? ARRIVE.crime
      : state.stats.prosperity > 0.68 ? ARRIVE.prosperity
      : state.stats.prosperity < 0.32 ? ARRIVE.poor
      : ARRIVE.default;
    this.say(this.rTurn.pick(bank), MSG_AMBIENT);
  }

  private spawnActors(gen: GenResult): void {
    this.aCount = 0;
    this.aAlive.fill(0);
    this.aState.fill(ST_SCHEDULE);
    this.aFlags.fill(0);
    this.aStun.fill(0);
    const rp = new Rand(this.seed, `actors:${this.hoodId}`);
    const pickTile = (list: number[], fallbackX: number, fallbackY: number): [number, number] => {
      if (!list.length) return [fallbackX, fallbackY];
      const ti = list[rp.int(0, list.length - 1)];
      return [ti % this.map.w, Math.floor(ti / this.map.w)];
    };
    for (const s of gen.actors) {
      if (this.aCount >= MAX_ACTORS) break;
      if (!this.map.walkable(s.x, s.y)) continue;
      const ti = this.map.idx(s.x, s.y);
      if (this.occ[ti] !== -1 || (s.x === this.px && s.y === this.py)) continue;
      const i = this.aCount++;
      this.aKind[i] = s.kind;
      this.aX[i] = s.x; this.aY[i] = s.y;
      this.aDir[i] = rp.int(0, 3);
      this.aAlive[i] = 1;
      this.aBarkCd[i] = rp.int(0, 60);
      if (s.kind === AK.NPC) {
        const arch = ARCHETYPES[s.arch ?? 0];
        this.aArch[i] = s.arch ?? 0;
        this.aHp[i] = rp.int(arch.hp[0], arch.hp[1]);
        this.aColor[i] = ARCH_COLOR[arch.id] ?? 0x9a9aa4;
        const [hx, hy] = pickTile(this.tilesInterior, s.x, s.y);
        this.aHomeX[i] = hx; this.aHomeY[i] = hy;
        let wx = s.x, wy = s.y;
        if (arch.schedule === 'worker') [wx, wy] = pickTile(this.tilesInterior, s.x, s.y);
        else if (arch.schedule === 'corner') [wx, wy] = pickTile(this.tilesCorner, s.x, s.y);
        else if (arch.schedule === 'worship' && this.tilesAltar.length) [wx, wy] = pickTile(this.tilesAltar, s.x, s.y);
        this.aWorkX[i] = wx; this.aWorkY[i] = wy;
      } else {
        this.aHomeX[i] = s.x; this.aHomeY[i] = s.y;
        this.aHp[i] = s.kind === AK.Rat ? 2 : 4;
        this.aColor[i] =
          s.kind === AK.Ped ? rp.pick(PED_COLORS) :
          s.kind === AK.Rat ? 0x8a6f52 :
          s.kind === AK.Pigeon ? 0x9a9aa2 : 0xd49a3a;
      }
      this.occ[ti] = i;
    }
    // Mark 2-3 NPCs as people with work to hand out (gold on the street).
    const rq = new Rand(this.seed, `qgiver:${this.hoodId}`);
    const giverArchs = new Set(QUEST_TEMPLATES.flatMap((t) => t.givers));
    const candidates: number[] = [];
    for (let i = 0; i < this.aCount; i++) {
      if (this.aAlive[i] && this.aKind[i] === AK.NPC && giverArchs.has(ARCHETYPES[this.aArch[i]].id)) candidates.push(i);
    }
    rq.shuffle(candidates);
    for (const i of candidates.slice(0, 2 + rq.int(0, 1))) this.aFlags[i] |= AF_QUESTGIVER;
  }

  private npcName(i: number): string {
    const r = new Rand(this.seed, `npcname:${this.hoodId}:${this.aHomeX[i]}:${this.aHomeY[i]}:${i}`);
    return `${r.pick(NAMES.first)} ${r.pick(NAMES.last)}`;
  }

  private archOf(i: number) {
    return ARCHETYPES[this.aArch[i]];
  }

  private tryTravel(): void {
    if (this.selectedHood === this.hoodId) {
      this.say("You're already here. It's not so bad.");
      return;
    }
    const cur = this.seedById.get(this.hoodId)!;
    const dst = this.seedById.get(this.selectedHood)!;
    const curState = this.world.neighborhoods[cur.id];
    const dstState = this.world.neighborhoods[dst.id];
    if (cur.adjacent.includes(dst.id)) {
      // Crossing into somebody else's turf can cost you at the barricade (M6.3).
      const curTop = Object.entries(curState.control).sort((a, b) => b[1] - a[1])[0];
      const dstTop = Object.entries(dstState.control).sort((a, b) => b[1] - a[1])[0];
      if (!this.encounter && dstTop && dstTop[1] > 0.25 && dstTop[0] !== curTop?.[0]
          && (this.standing[dstTop[0]] ?? 0) < 2 && this.rTurn.chance(0.25)) {
        const pack = FACTIONS.find((p) => p.id === dstTop[0]);
        if (pack) {
          const toll = 10 + this.rTurn.int(0, 30);
          this.encounter = { kind: 'toll', idx: -1, toll, faction: dstTop[0], dest: dst.id };
          this.mode = 'menu';
          this.say(`Concrete and chain-link across the avenue into ${dst.name}. ${pack.name} colors on every block of it.`, MSG_BAD);
          this.menu = {
            kind: 'encounter',
            title: `${pack.name.toUpperCase()} CHECKPOINT`,
            entries: [
              { label: `Pay the toll ($${toll})`, sub: 'Commerce. Of a kind.', data: 'enc:toll_pay' },
              { label: 'Push through', sub: 'They will take it personally. And follow.', data: 'enc:toll_fight' },
              { label: 'Turn back', sub: 'The long way exists for a reason.', data: 'enc:toll_back' },
            ],
            sel: 0,
          };
          return;
        }
      }
      this.walkTravel(dst.id);
      return;
    }
    const shared = curState.subway.filter((l) => dstState.subway.includes(l));
    if (shared.length) {
      const [ax, ay] = cur.pos, [bx, by] = dst.pos;
      const dist = Math.hypot(bx - ax, by - ay);
      let minutes = Math.round(12 + dist * 1.2 + this.rTurn.int(0, 8));
      if (this.hasBoon('tunnel_grace')) minutes = Math.max(6, minutes >> 1);
      this.clockMin += minutes;
      this.turn += minutes * 10;
      this.mode = 'play';
      if (this.pc.money >= 2) {
        this.pc.money -= 2;
        this.say(`$2 fare. You catch the ${shared[0]} train.`, MSG_TRAVEL);
      } else {
        this.heat += 0.5;
        this.say(`You hop the gate — broke is broke — and catch the ${shared[0]} train.`, MSG_TRAVEL);
      }
      this.say(this.rTurn.pick(TRAVEL_SUBWAY), MSG_TRAVEL);
      this.enterHood(dst.id, 'subway');
      this.say(`${minutes} minutes underground.`, 0x5a6a78);
      this.passiveRecover(minutes * 10);
      return;
    }
    this.say('No way there from here: not adjacent, and no line still runs between you.', 0xc08050);
  }

  private walkTravel(dstId: string): void {
    const minutes = 22 + this.rTurn.int(0, 18);
    this.clockMin += minutes;
    this.turn += minutes * 10;
    this.mode = 'play';
    this.say(this.rTurn.pick(TRAVEL_WALK), MSG_TRAVEL);
    this.enterHood(dstId, 'walk');
    this.say(`${minutes} minutes on foot.`, 0x5a6a78);
    this.passiveRecover(minutes * 10);
  }

  private passiveRecover(turns: number): void {
    this.pc.stamina = Math.min(this.pc.maxStamina, this.pc.stamina + turns * 0.5);
    this.pc.hunger = Math.min(100, this.pc.hunger + turns / 120);
  }

  // --- actions ---------------------------------------------------------------------

  act(a: Action): void {
    if (this.mode === 'menu') { this.actMenu(a); return; }
    if (a.k === 'journal') { this.openJournal(); return; }
    if (a.k === 'news') { this.openNews(); return; }
    if (a.k === 'char') { this.openCharSheet(); return; }
    if (this.mode === 'citymap') { this.actCityMap(a); return; }
    if (this.mode === 'look') { this.actLook(a); return; }
    if (this.mode === 'target') { this.actTarget(a); return; }
    if (this.pendingVault) {
      this.pendingVault = false;
      if (a.k === 'move') { this.tryVault(a.dx, a.dy); return; }
      this.say('You decide against acrobatics.');
      return;
    }
    switch (a.k) {
      case 'move': this.tryMove(a.dx, a.dy); break;
      case 'wait': this.endTurn(); break;
      case 'rest': this.rest(); break;
      case 'interact': this.interact(); break;
      case 'pickup': this.pickup(); break;
      case 'inventory': this.openInventory(); break;
      case 'talk': this.talk(); break;
      case 'fire': this.enterTargeting(); break;
      case 'vault':
        this.pendingVault = true;
        this.say('Vault which way?', 0x9aa8d0);
        break;
      case 'look':
        this.mode = 'look';
        this.lookX = this.px;
        this.lookY = this.py;
        this.lookText = 'You. Still standing.';
        break;
      case 'citymap':
        this.mode = 'citymap';
        this.selectedHood = this.hoodId;
        this.updateCityInfo();
        break;
      case 'cancel': break;
    }
  }

  // --- combat ------------------------------------------------------------------------

  private gunReady(): boolean {
    const w = this.pc.weaponDef();
    return !!w && w.kind === 'gun' && this.pc.inventory.some((s) => s.id === 'bullets' && s.qty > 0);
  }

  private enterTargeting(): void {
    const ranged = this.gunReady();
    const maxDist = ranged ? 8 : 1;
    this.targets = [];
    for (let i = 0; i < this.aCount; i++) {
      if (!this.aAlive[i]) continue;
      if (this.aKind[i] === AK.Pigeon || this.aKind[i] === AK.Cat) continue;
      const d = Math.max(Math.abs(this.aX[i] - this.px), Math.abs(this.aY[i] - this.py));
      if (d > maxDist) continue;
      if (!this.visible[this.map.idx(this.aX[i], this.aY[i])]) continue;
      this.targets.push(i);
    }
    if (!this.targets.length) {
      this.say(ranged ? 'Nothing in range worth a bullet.' : 'Nothing within arm\'s reach. [f] needs an adjacent target — or a gun.');
      return;
    }
    this.targets.sort((a, b) =>
      Math.abs(this.aX[a] - this.px) + Math.abs(this.aY[a] - this.py) -
      (Math.abs(this.aX[b] - this.px) + Math.abs(this.aY[b] - this.py)));
    this.targetSel = 0;
    this.mode = 'target';
    this.updateTargetInfo();
  }

  private updateTargetInfo(): void {
    const i = this.targets[this.targetSel];
    const label = this.aKind[i] === AK.NPC ? `${this.npcName(i)}, ${this.archOf(i).label}` : this.describeActor(i);
    this.lookText = `${label} — [e] attack · [f/wasd] next target · Esc never mind`;
  }

  private actTarget(a: Action): void {
    if (a.k === 'cancel') { this.mode = 'play'; this.lookText = ''; return; }
    if (a.k === 'move' || a.k === 'fire') {
      this.targetSel = (this.targetSel + 1) % this.targets.length;
      this.updateTargetInfo();
      return;
    }
    if (a.k !== 'interact' && a.k !== 'wait') return;
    const idx = this.targets[this.targetSel];
    this.lookText = '';
    this.menu = {
      kind: 'bodypart',
      title: 'AIM FOR—',
      entries: [
        { label: 'Torso', sub: 'center mass; honest work' },
        { label: 'Head', sub: 'harder to hit, harder to forget' },
        { label: 'Arms', sub: 'spoil their grip' },
        { label: 'Legs', sub: 'nobody chases on a bad knee' },
      ],
      sel: 0,
      targetIdx: idx,
    };
    this.mode = 'menu';
  }

  private resolveAttack(idx: number, part: BodyPart): void {
    this.mode = 'play';
    const pc = this.pc;
    const dist = Math.max(Math.abs(this.aX[idx] - this.px), Math.abs(this.aY[idx] - this.py));
    const ranged = this.gunReady() && dist > 1;
    if (dist > 1 && !ranged) {
      this.say('Too far to swing, and you have nothing to shoot with.');
      return;
    }
    const w = pc.weaponDef();
    const usingGun = ranged || (w?.kind === 'gun' && this.gunReady());
    if (usingGun) pc.spend('bullets', 1);
    const skillId = usingGun ? 'firearms' : 'melee';
    const skill = pc.skill(skillId);
    const acc = 55 + skill * 5 + (pc.stats.AGI - 5) * 3 + PART_MOD[part] - (usingGun ? dist * 3 : 0)
      - (pc.has('concussion') ? 15 : 0);
    const target = this.aKind[idx] === AK.NPC ? this.npcName(idx) : this.describeActor(idx).replace(/\..*$/, '').toLowerCase();
    const noiseVerb = usingGun ? 'The shot slaps off every wall on the block.' : '';
    if (this.rTurn.int(0, 99) >= acc) {
      this.say(usingGun ? `You fire at ${target} and the street takes the bullet instead. ${noiseVerb}` : `You swing at ${target} and hit October air.`);
      if (pc.train(skillId, 1)) this.say(`You learn more from the miss than they did. ${skillId} improves.`, MSG_SYSTEM);
      this.afterViolence(idx, usingGun);
      this.endTurn();
      return;
    }
    let dmg = usingGun || w?.kind === 'weapon'
      ? this.rTurn.int(w!.damage![0], w!.damage![1]) + (usingGun ? 0 : Math.floor(pc.stats.STR / 3))
      : this.rTurn.int(1, 2) + Math.floor(pc.stats.STR / 3);
    if (part === 'head') dmg = Math.round(dmg * 1.4);
    this.hurtActor(idx, dmg, part, w?.bleed ?? 0, usingGun);
    if (pc.train(skillId, 2)) this.say(`${skillId === 'melee' ? 'Melee' : 'Firearms'} improves. The city is a harsh tutor with a generous curriculum.`, MSG_SYSTEM);
    this.afterViolence(idx, usingGun);
    this.endTurn();
  }

  private hurtActor(idx: number, dmg: number, part: BodyPart, bleedChance: number, gun: boolean): void {
    this.aHp[idx] -= dmg;
    const isNpc = this.aKind[idx] === AK.NPC;
    const name = isNpc ? this.npcName(idx) : this.describeActor(idx).split('.')[0].toLowerCase();
    if (this.aHp[idx] <= 0) {
      this.killActor(idx, gun);
      return;
    }
    const bits: string[] = [];
    if (part === 'head' && this.rTurn.chance(0.4)) { this.aStun[idx] = 2; bits.push('they reel'); }
    if (part === 'arms' && this.rTurn.chance(0.5)) { this.aFlags[idx] |= AF_DISARMED; bits.push('their grip goes'); }
    if (part === 'legs' && this.rTurn.chance(0.5)) { this.aFlags[idx] |= AF_LIMP; bits.push('their knee buckles'); }
    if (bleedChance && this.rTurn.chance(bleedChance)) { this.aFlags[idx] |= AF_BLEED; bits.push('they start leaking'); }
    this.say(`You ${gun ? 'shoot' : 'hit'} ${name} in the ${part} (${dmg})${bits.length ? ' — ' + bits.join(', ') : ''}.`);
    if (isNpc) {
      const arch = this.archOf(idx);
      if (this.aHp[idx] < (arch.hp[0] + arch.hp[1]) / 4 && arch.courage < 7) {
        this.aState[idx] = ST_FLEE;
        this.say(`${name} has had enough of this transaction.`);
      } else {
        this.aState[idx] = ST_HOSTILE;
      }
    }
  }

  private killActor(idx: number, gun: boolean): void {
    const isNpc = this.aKind[idx] === AK.NPC;
    const x = this.aX[idx], y = this.aY[idx];
    const name = isNpc ? `${this.npcName(idx)}, ${this.archOf(idx).label},` : this.describeActor(idx).split('.')[0];
    this.removeActor(idx);
    const ti = this.map.idx(x, y);
    const pile = this.map.items.get(ti) ?? [];
    if (isNpc) {
      pile.push({ id: 'corpse', qty: 1 });
      const arch = this.archOf(idx);
      for (const [itemId, chance] of arch.loot) {
        if (this.rTurn.chance(chance)) pile.push({ id: itemId, qty: 1 });
      }
      const cash = this.rTurn.int(0, 8 + arch.greed * 6);
      if (cash > 0) pile.push({ id: 'cash', qty: cash });
      this.say(`${name} drops and doesn't argue about it. The street is suddenly very interested in being elsewhere.`, MSG_BAD);
      this.panicWitnesses(x, y, gun ? 12 : 6);
      this.heat += gun ? 3 : 2;
    } else {
      this.say(`The ${name.toLowerCase()} dies. It was not a fair fight, and you both knew it.`);
      if (this.aKind[idx] === AK.Rat) pile.push({ id: 'scrap_metal', qty: 1 });
    }
    if (pile.length) this.map.items.set(ti, pile);
  }

  private panicWitnesses(x: number, y: number, radius: number): void {
    for (let i = 0; i < this.aCount; i++) {
      if (!this.aAlive[i]) continue;
      if (this.aKind[i] !== AK.NPC && this.aKind[i] !== AK.Ped) continue;
      const d = Math.abs(this.aX[i] - x) + Math.abs(this.aY[i] - y);
      if (d > radius) continue;
      if (this.aKind[i] === AK.NPC) {
        const arch = this.archOf(i);
        if (arch.law || (arch.id === 'enforcer' && this.rTurn.chance(0.7))) this.aState[i] = ST_HOSTILE;
        else if (arch.courage < 6) this.aState[i] = ST_PANIC;
      } else {
        this.aState[i] = ST_PANIC;
      }
    }
  }

  private afterViolence(idx: number, gun: boolean): void {
    this.heat += gun ? 1 : 0.4;
    if (this.aAlive[idx] && this.aKind[idx] === AK.NPC && this.aState[idx] === ST_SCHEDULE) {
      this.aState[idx] = ST_HOSTILE;
    }
    if (this.aAlive[idx] && this.aKind[idx] === AK.Rat) {
      // rats flee, in their way
      this.aState[idx] = ST_FLEE;
    }
    if (gun) this.panicWitnesses(this.px, this.py, 10);
  }

  private damagePlayer(dmg: number, source: string, kind: 'blunt' | 'blade' | 'gun'): void {
    const pc = this.pc;
    const taken = Math.max(1, dmg - pc.armorValue());
    pc.hp -= taken;
    this.say(`${source} (${taken}).`, MSG_BAD);
    if (taken >= 5) {
      const roll = this.rTurn.float();
      if (kind === 'blade' && roll < 0.5) { pc.injure('bleeding'); this.say('You are cut and it is not closing on its own.', MSG_BAD); }
      else if (kind === 'blunt' && roll < 0.3) { pc.injure('concussion'); this.say('The world rings like a struck pipe.', MSG_BAD); }
      else if (roll < 0.2) { pc.injure('limp'); this.say('Something in your leg files for workers\' comp.', MSG_BAD); }
    }
    if (pc.hp <= 0) this.playerDown(source, kind);
  }

  private playerDown(source: string, kind: 'blunt' | 'blade' | 'gun'): void {
    const pc = this.pc;
    // Nerve save: the city occasionally hands you back, at a price.
    const save = pc.stats.NRV + this.rTurn.int(0, 10);
    if (save > 12) {
      this.say('The street tilts up to meet you. Voices. Hands in your pockets, then hands under your arms.', MSG_BAD);
      const fee = Math.min(pc.money, 60 + this.rTurn.int(0, 120));
      pc.money -= fee;
      this.clockMin += 10 * 60;
      this.turn += 6000;
      pc.hp = Math.max(8, Math.round(pc.maxHp * 0.35));
      pc.stamina = pc.maxStamina;
      pc.hunger = Math.min(100, pc.hunger + 25);
      pc.injuries = pc.injuries.filter((i) => i.kind === 'limp');
      this.heat = Math.max(0, this.heat - 2);
      const gen = this.localGen(this.hoodId);
      this.px = gen.spawn.x;
      this.py = gen.spawn.y;
      this.spawnActors(gen);
      this.computeVision();
      this.say('You wake on a cot in a clinic that smells of iodine and candle smoke. Ten hours gone.', MSG_SYSTEM);
      this.say(fee > 0 ? `The medic kept $${fee} for services rendered. Fair, probably.` : 'Nobody charged you. Someone left a religious pamphlet on your chest instead.', MSG_TRAVEL);
      return;
    }
    this.die(source, kind);
  }

  private die(source: string, kind: 'blunt' | 'blade' | 'gun'): void {
    const pc = this.pc;
    const origin = ORIGINS.find((o) => o.id === pc.originId)!;
    const worth = pc.netWorth();
    const day = Math.floor(this.clockMin / (24 * 60));
    const causeBank = kind === 'gun' ? '#death_cause_gun#' : kind === 'blade' ? '#death_cause_blade#' : '#death_cause_beating#';
    const cause = `${this.grammar.expand(causeBank, this.rTurn)} ${source.replace(/ (hits|shoots|cuts).*/, '')} in ${this.hoodName()}`;
    // The body and the stash stay where they fell.
    const ti = this.map.idx(this.px, this.py);
    const pile = this.map.items.get(ti) ?? [];
    pile.push({ id: 'corpse', qty: 1 });
    for (const s of pc.inventory) pile.push({ ...s });
    this.map.items.set(ti, pile);
    this.world.graves.push({
      hood: this.hoodId, x: this.px, y: this.py,
      name: pc.name, origin: origin.name, cause, day, worth,
    });
    this.world.chronicle.push({
      year: 2036,
      text: `${this.grammar.expand('#obit_open#', this.rTurn)} ${pc.name}, ${origin.name.toLowerCase()}, ${cause} — carrying a net worth of $${worth}. ${this.grammar.expand('#obit_close#', this.rTurn)}`,
      tags: ['obituary'],
      neighborhoods: [this.hoodId],
    });
    const lines: Msg[] = [
      { text: `${pc.name.toUpperCase()} — ${origin.name}`, fg: 0xc05a50 },
      { text: '', fg: 0 },
      { text: this.world.chronicle[this.world.chronicle.length - 1].text, fg: 0xb8b8b8 },
      { text: '', fg: 0 },
      { text: `Final net worth: $${worth} · survived ${this.turn} turns`, fg: 0xd8c850 },
      { text: 'The world keeps the body, the stash, and the story.', fg: 0x76869a },
      { text: '', fg: 0 },
      { text: 'Press e to go again. Same city. Same wounds. Different you.', fg: 0x6fd4c0 },
    ];
    this.outbox.push({ kind: 'journal', title: 'AN OBITUARY', lines });
    this.heat = 0;
    this.menu = {
      kind: 'origin',
      title: 'WHO COMES NEXT?',
      entries: ORIGINS.map((o) => ({ label: o.name, sub: o.blurb })),
      sel: 0,
    };
    this.mode = 'menu';
  }

  private talk(): void {
    for (const [dx, dy] of DIRS) {
      const nx = this.px + dx, ny = this.py + dy;
      if (!this.map.inBounds(nx, ny)) continue;
      const ai = this.occ[this.map.idx(nx, ny)];
      if (ai < 0 || !this.aAlive[ai]) continue;
      if (this.aKind[ai] === AK.NPC) {
        const arch = this.archOf(ai);
        if (this.aState[ai] === ST_HOSTILE) {
          this.say(`${this.npcName(ai)} is not in a talking mood. Demonstrably.`, MSG_BAD);
          return;
        }
        this.say(`${this.npcName(ai)}, ${arch.label}:`, 0x8a9ab0);
        this.say(this.rTurn.pick(arch.barks), MSG_BARK);
        if (this.maybeOfferQuest(ai)) {
          this.endTurn();
          return;
        }
        // Sometimes they pass along something from the rumor pool — the Tier 2
        // sim speaking through the people who live in it.
        if (this.city && this.city.rumors.length && this.rTurn.chance(0.35)) {
          const rumor = this.rTurn.pick(this.city.rumors);
          this.say(`"${this.city.expandRumor(rumor.text)}"`, MSG_BARK);
          if (this.pc.train('streetwise', 1)) this.say('Streetwise improves.', MSG_SYSTEM);
          this.endTurn();
          return;
        }
        // Sometimes the street tells you something true.
        if (this.rTurn.chance(0.3)) {
          const state = this.world.neighborhoods[this.hoodId];
          const faiths = Object.entries(state.faiths).filter(([, v]) => v > 0.1);
          const gangs = Object.entries(state.control).filter(([, v]) => v > 0.15);
          const pool: string[] = [];
          for (const [fid] of faiths) {
            const pack = RELIGIONS.find((p) => p.id === fid);
            if (pack) pool.push(...pack.rumor);
          }
          for (const [fid] of gangs) {
            const pack = FACTIONS.find((p) => p.id === fid);
            if (pack) pool.push(...pack.rumor);
          }
          if (pool.length) {
            this.say(`"${this.grammar.expand(this.rTurn.pick(pool), this.rTurn, { neighborhood: this.hoodName() })}"`, MSG_BARK);
          }
        }
        if (this.pc.train('streetwise', 1)) this.say('Streetwise improves. You nod like you already knew that.', MSG_SYSTEM);
        this.endTurn();
        return;
      }
      if (this.aKind[ai] === AK.Cat) {
        this.say('The cat regards you. You are briefly, accurately appraised.');
        this.endTurn();
        return;
      }
    }
    this.say('Nobody close enough to talk to. The city hears you anyway.');
  }

  private tryVault(dx: number, dy: number): void {
    const ox = this.px + dx, oy = this.py + dy;
    const lx = this.px + dx * 2, ly = this.py + dy * 2;
    if (!this.map.inBounds(ox, oy) || !this.map.inBounds(lx, ly)) {
      this.say('Nothing to vault there.');
      return;
    }
    const over = this.map.t(ox, oy);
    if (!VAULTABLE.has(over)) {
      this.say('Nothing vaultable that way.');
      return;
    }
    if (!this.map.walkable(lx, ly) || this.occ[this.map.idx(lx, ly)] >= 0) {
      this.say('No landing on the far side. Physics holds.');
      return;
    }
    const pc = this.pc;
    if (pc.stamina < 8) {
      this.say('Your legs decline. Stamina first.');
      return;
    }
    pc.stamina -= 8;
    const odds = 0.5 + pc.stats.AGI * 0.04 + pc.skill('athletics') * 0.06 - (pc.has('limp') ? 0.2 : 0);
    if (this.rTurn.chance(Math.min(0.95, odds))) {
      this.px = lx; this.py = ly;
      this.say('Over and down, clean. A pigeon judges your form: acceptable.');
      if (pc.train('athletics', 2)) this.say('Athletics improves.', MSG_SYSTEM);
    } else {
      this.say('You catch your foot and arrive on the same side, but with less dignity.', MSG_BAD);
      if (this.rTurn.chance(0.25)) { pc.hp = Math.max(1, pc.hp - 2); this.say('And a barked shin. (-2)', MSG_BAD); }
    }
    this.endTurn();
  }

  // --- menus -------------------------------------------------------------------------

  private actMenu(a: Action): void {
    const m = this.menu;
    if (!m) { this.mode = 'play'; return; }
    if (a.k === 'move') {
      if (a.dy !== 0) {
        m.sel = (m.sel + a.dy + m.entries.length) % m.entries.length;
      }
      return;
    }
    if (a.k === 'cancel') {
      if (m.kind === 'origin') return; // you must have been someone
      if (m.kind === 'encounter') return; // and this is not optional
      this.menu = null;
      this.mode = 'play';
      return;
    }
    if (a.k !== 'interact' && a.k !== 'wait') return;
    switch (m.kind) {
      case 'origin':
        this.chooseOrigin(ORIGINS[m.sel]);
        break;
      case 'inventory': {
        const stack = this.pc.inventory[m.sel];
        if (!stack) { this.menu = null; this.mode = 'play'; break; }
        this.openItemMenu(stack);
        break;
      }
      case 'item':
        this.runItemAction(m);
        break;
      case 'bodypart': {
        const part = (['torso', 'head', 'arms', 'legs'] as BodyPart[])[m.sel];
        const idx = m.targetIdx!;
        this.menu = null;
        this.mode = 'play';
        if (this.aAlive[idx]) this.resolveAttack(idx, part);
        else this.say('They are no longer available for that.');
        break;
      }
      case 'shop':
      case 'bet':
      case 'altar':
      case 'encounter': {
        const data = m.entries[m.sel]?.data;
        if (data) this.runDataAction(data);
        else { this.menu = null; this.mode = 'play'; }
        break;
      }
    }
  }

  private openInventory(): void {
    if (!this.pc.inventory.length) {
      this.say('You are carrying nothing but consequences.');
      return;
    }
    this.menu = {
      kind: 'inventory',
      title: `CARRYING — $${this.pc.money} cash · net worth $${this.pc.netWorth()}`,
      entries: this.pc.inventory.map((s) => {
        const def = ITEM_BY_ID.get(s.id)!;
        const tags: string[] = [];
        if (this.pc.weapon === s.id) tags.push('wielded');
        if (this.pc.armor === s.id) tags.push('worn');
        return {
          label: `${s.qty > 1 ? `${s.qty}× ` : ''}${def.name}${tags.length ? ` [${tags.join(', ')}]` : ''}`,
          sub: `${def.desc} ($${def.value})`,
          fg: parseInt(def.color.slice(1), 16),
        };
      }),
      sel: 0,
    };
    this.mode = 'menu';
  }

  private openItemMenu(stack: ItemStack): void {
    const def = ITEM_BY_ID.get(stack.id)!;
    const actions: string[] = [];
    if (def.kind === 'weapon' || def.kind === 'gun') actions.push(this.pc.weapon === stack.id ? 'Lower it' : 'Wield it');
    if (def.kind === 'armor') actions.push(this.pc.armor === stack.id ? 'Take it off' : 'Wear it');
    if (def.kind === 'food') actions.push('Eat it');
    if (def.kind === 'medical') actions.push('Use it');
    actions.push('Drop it', 'Never mind');
    this.menu = {
      kind: 'item',
      title: def.name.toUpperCase(),
      entries: actions.map((label) => ({ label, sub: label === 'Never mind' ? undefined : def.desc })),
      sel: 0,
      itemId: stack.id,
    };
  }

  private runItemAction(m: Menu): void {
    const id = m.itemId!;
    const def = ITEM_BY_ID.get(id)!;
    const choice = m.entries[m.sel].label;
    this.menu = null;
    this.mode = 'play';
    switch (choice) {
      case 'Wield it':
        this.pc.weapon = id;
        this.say(`You heft the ${def.name}. It agrees with you.`);
        break;
      case 'Lower it':
        this.pc.weapon = null;
        this.say('Fists, then.');
        break;
      case 'Wear it':
        this.pc.armor = id;
        this.say(`You put on the ${def.name}.`);
        break;
      case 'Take it off':
        this.pc.armor = null;
        this.say(`You shrug off the ${def.name}.`);
        break;
      case 'Eat it': {
        this.pc.spend(id, 1);
        this.pc.hunger = Math.max(0, this.pc.hunger - (def.food ?? 10));
        if (def.stamina) this.pc.stamina = Math.min(this.pc.maxStamina, this.pc.stamina + def.stamina);
        this.say(`You eat the ${def.name}. ${this.pc.hunger < 25 ? 'Better.' : 'It helps.'}`, MSG_GOOD);
        this.endTurn();
        break;
      }
      case 'Use it': {
        const bleeding = this.pc.has('bleeding');
        this.pc.spend(id, 1);
        const healed = Math.min(this.pc.maxHp - this.pc.hp, def.heal ?? 0);
        this.pc.hp += healed;
        if (def.stopBleed && bleeding) {
          this.pc.injuries = this.pc.injuries.filter((i) => i.kind !== 'bleeding');
          this.say('You tie off the bleeding. The street stops getting your share.', MSG_GOOD);
        }
        if (healed > 0) this.say(`Patched. (+${healed} HP)`, MSG_GOOD);
        else if (!def.stopBleed || !bleeding) this.say('You were already as whole as this stuff gets you.');
        if (this.pc.train('medicine', 2)) this.say('Your hands are learning. Medicine improves.', MSG_SYSTEM);
        this.endTurn();
        break;
      }
      case 'Drop it': {
        this.pc.spend(id, 1);
        const ti = this.map.idx(this.px, this.py);
        const pile = this.map.items.get(ti) ?? [];
        const existing = pile.find((s) => s.id === id);
        if (existing) existing.qty++;
        else pile.push({ id, qty: 1 });
        this.map.items.set(ti, pile);
        this.say(`You set the ${def.name} down. The street will decide what it's worth.`);
        break;
      }
      default:
        break;
    }
  }

  private pickup(): void {
    const ti = this.map.idx(this.px, this.py);
    const pile = this.map.items.get(ti);
    if (!pile || !pile.length) {
      this.say('Nothing here worth the bend.');
      return;
    }
    for (const s of pile) {
      if (s.id === 'cash') {
        this.pc.money += s.qty;
        this.say(`You take the $${s.qty}. The dead don't tip.`, MSG_GOOD);
        continue;
      }
      const def = ITEM_BY_ID.get(s.id)!;
      this.pc.gain(s.id, s.qty);
      this.say(`Taken: ${s.qty > 1 ? `${s.qty}× ` : ''}${def.name}.`, MSG_GOOD);
    }
    this.map.items.delete(ti);
    this.endTurn();
  }

  private rest(): void {
    let rested = 0;
    for (; rested < 100; rested++) {
      this.endTurn(true);
      if (this.mode !== 'play') break; // something demanded your attention
      if (this.actorNear(3)) {
        this.say('Something moves nearby. You come back up to street-alert.', MSG_BAD);
        break;
      }
    }
    this.pc.stamina = Math.min(this.pc.maxStamina, this.pc.stamina + rested * 0.6);
    if (rested >= 100) this.say('You rest ten minutes in a doorway, watching the street watch you back.');
    this.computeVision();
  }

  private actorNear(dist: number): boolean {
    for (let i = 0; i < this.aCount; i++) {
      if (!this.aAlive[i]) continue;
      if (this.aKind[i] !== AK.Ped) continue;
      if (Math.abs(this.aX[i] - this.px) + Math.abs(this.aY[i] - this.py) <= dist) return true;
    }
    return false;
  }

  // --- economy, faith, quests -------------------------------------------------------

  private shopPrice(base: number, buying: boolean): number {
    const prosperity = this.world.neighborhoods[this.hoodId].stats.prosperity;
    let mult = buying ? 0.9 + prosperity * 0.5 : 0.45 + this.pc.skill('trade') * 0.03 + (this.pc.stats.CHA - 5) * 0.01;
    if (buying && this.hasBoon('fair_price')) mult *= 0.85;
    return Math.max(1, Math.round(base * mult));
  }

  private openShop(): void {
    const STOCK = ['bacalao_roll', 'beans', 'street_dumpling', 'coffee', 'tallboy', 'bandage', 'blackout_candle'];
    // Stock follows the money: better blocks carry better shelves.
    const stats = this.world.neighborhoods[this.hoodId].stats;
    if (stats.prosperity > 0.5) STOCK.push('medkit');
    if (stats.prosperity > 0.6) STOCK.push('work_jacket', 'bat');
    if (stats.prosperity > 0.72) STOCK.push('stab_vest');
    if (stats.crime > 0.6) STOCK.push('box_cutter');
    const entries: Menu['entries'] = [];
    for (const id of STOCK) {
      const def = ITEM_BY_ID.get(id)!;
      entries.push({
        label: `Buy ${def.name} — $${this.shopPrice(def.value, true)}`,
        sub: def.desc, fg: parseInt(def.color.slice(1), 16), data: `buy:${id}`,
      });
    }
    for (const s of this.pc.inventory) {
      const def = ITEM_BY_ID.get(s.id)!;
      if (def.kind !== 'valuable' && def.kind !== 'junk') continue;
      if (def.value <= 0) continue;
      entries.push({
        label: `Sell ${def.name}${s.qty > 1 ? ` (have ${s.qty})` : ''} — $${this.shopPrice(def.value, false)}`,
        sub: def.desc, fg: 0xc0a890, data: `sell:${s.id}`,
      });
    }
    if (this.world.leagues.length) {
      entries.push({ label: 'Put money on a game', sub: 'The counterman keeps a book. Everyone knows. Nobody says.', data: 'bets' });
    }
    entries.push({ label: 'Leave', data: 'leave' });
    this.menu = { kind: 'shop', title: `THE COUNTER — you have $${this.pc.money}`, entries, sel: 0 };
    this.mode = 'menu';
  }

  private openBetMenu(): void {
    const entries: Menu['entries'] = [];
    for (const l of this.world.leagues) {
      const pack = LEAGUES.find((p) => p.id === l.packId);
      if (!pack) continue;
      for (const team of l.teams.slice(0, 4)) {
        const odds = this.city.odds(l.packId, team);
        entries.push({
          label: `${team} (${pack.sport}) — pays ${odds}×`,
          sub: `$25 on ${team} to win their next game.`,
          data: `bet:${l.packId}:${team}:${odds}`,
        });
      }
    }
    entries.push({ label: 'Never mind', data: 'leave' });
    this.menu = { kind: 'bet', title: `THE BOOK — $25 a ticket, cash only`, entries, sel: 0 };
    this.mode = 'menu';
  }

  private openAltarMenu(ax: number, ay: number): void {
    const desc = this.map.desc.get(this.map.idx(ax, ay)) ?? '';
    const pack = RELIGIONS.find((p) => desc.includes(p.name));
    if (!pack) {
      this.say("You light a candle. It can't hurt. Probably it can't hurt.");
      if (this.pc.train('theology', 1)) this.say('Theology improves.', MSG_SYSTEM);
      this.endTurn();
      return;
    }
    const entries: Menu['entries'] = [];
    if (this.faith === pack.id) {
      entries.push({ label: 'Pray', sub: pack.doctrine, data: `pray:${pack.id}` });
      entries.push({ label: 'Tithe a valuable', sub: pack.obligation, data: `tithe:${pack.id}` });
    } else if (!this.faith) {
      entries.push({ label: `Join the ${pack.name}`, sub: `${pack.doctrine} (You may keep one faith.)`, data: `join:${pack.id}` });
      entries.push({ label: 'Light a candle, no commitments', data: `pray:${pack.id}` });
    } else {
      entries.push({ label: 'Light a candle (your faith lies elsewhere)', data: `pray:${pack.id}` });
    }
    entries.push({ label: 'Step back', data: 'leave' });
    const favor = this.favor[pack.id] ?? 0;
    this.menu = {
      kind: 'altar',
      title: `${pack.glyph} ${pack.name.toUpperCase()}${this.faith === pack.id ? ` — favor ${favor}` : ''}`,
      entries, sel: 0,
    };
    this.mode = 'menu';
  }

  private runDataAction(data: string): void {
    const [verb, a, b, c] = data.split(':');
    this.menu = null;
    this.mode = 'play';
    switch (verb) {
      case 'leave': break;
      case 'enc':
        this.resolveEncounter(a);
        break;
      case 'buy': {
        const def = ITEM_BY_ID.get(a)!;
        const price = this.shopPrice(def.value, true);
        if (this.pc.money < price) { this.say('The counterman looks at your money and shakes his head kindly.'); break; }
        this.pc.money -= price;
        this.pc.gain(a, 1);
        this.say(`Bought: ${def.name}. ($${price})`, MSG_GOOD);
        if (this.pc.train('trade', 1)) this.say('Trade improves.', MSG_SYSTEM);
        this.openShop();
        break;
      }
      case 'sell': {
        const def = ITEM_BY_ID.get(a)!;
        const price = this.shopPrice(def.value, false);
        if (!this.pc.spend(a, 1)) break;
        this.pc.money += price;
        this.say(`Sold: ${def.name}. ($${price})`, MSG_GOOD);
        if (this.pc.train('trade', 1)) this.say('Trade improves.', MSG_SYSTEM);
        this.openShop();
        break;
      }
      case 'bets':
        this.openBetMenu();
        break;
      case 'bet': {
        const stake = 25;
        if (this.pc.money < stake) { this.say('Cash only, and you are short.'); break; }
        this.pc.money -= stake;
        this.bets.push({ league: a, team: b, stake, odds: parseFloat(c), day: this.dayOf() });
        this.say(`Ticket written: $${stake} on ${b} at ${c}×. Results with the morning edition.`, MSG_TRAVEL);
        break;
      }
      case 'join': {
        this.faith = a;
        this.favor[a] = (this.favor[a] ?? 0) + 1;
        const pack = RELIGIONS.find((p) => p.id === a)!;
        this.say(`${this.grammar.expand(this.rTurn.pick(pack.greeting), this.rTurn)}`, 0xb8a0d8);
        this.say(`You are received into the ${pack.name}. Obligation: ${pack.obligation.toLowerCase()}`, MSG_SYSTEM);
        this.pc.train('theology', 3);
        this.endTurn();
        break;
      }
      case 'pray': {
        this.say("You light a candle. The wax joins a decade of wax.");
        if (this.pc.train('theology', 1)) this.say('Theology improves.', MSG_SYSTEM);
        this.endTurn();
        break;
      }
      case 'tithe': {
        const valuable = this.pc.inventory.find((s) => ITEM_BY_ID.get(s.id)?.kind === 'valuable');
        if (!valuable) { this.say('You have nothing the faith would count.'); break; }
        const def = ITEM_BY_ID.get(valuable.id)!;
        this.pc.spend(valuable.id, 1);
        this.favor[a] = (this.favor[a] ?? 0) + 1;
        this.say(`You leave the ${def.name} at the altar. (favor ${this.favor[a]})`, 0xb8a0d8);
        if (this.favor[a] === 3) {
          const pack = RELIGIONS.find((p) => p.id === a)!;
          this.say(`${pack.boon.name}: ${pack.boon.desc}`, 0xb8a0d8);
        }
        this.endTurn();
        break;
      }
    }
  }

  private completeQuest(q: Quest): void {
    if (q.kind === 'collect') {
      if (this.rTurn.chance(0.3)) {
        this.say('The name on the slip argues the arithmetic. Loudly. Then less loudly.', MSG_BAD);
        this.spawnHostiles('enforcer', 1, 'An associate of the debtor detaches from the doorway across the street.');
      }
      this.pc.money += q.reward;
      this.say(`Debt collected: $${q.reward}. ${q.giver} gets theirs. This is yours.`, MSG_GOOD);
    } else {
      for (let k = 0; k < q.qty; k++) {
        if (!this.pc.spend(q.itemId, 1)) {
          this.say(`You were supposed to have the ${ITEM_BY_ID.get(q.itemId)?.name}. You do not. Awkward.`, MSG_BAD);
          this.quests = this.quests.filter((x) => x !== q);
          return;
        }
      }
      this.pc.money += q.reward;
      this.say(q.kind === 'errand'
        ? `You set it on the altar. Somewhere behind the candles, somebody approves. $${q.reward}, folded small.`
        : `The counterman takes it without looking and slides you $${q.reward}.`, MSG_GOOD);
    }
    this.quests = this.quests.filter((x) => x !== q);
    if (q.faction) {
      this.standing[q.faction] = (this.standing[q.faction] ?? 0) + 1;
      const pack = FACTIONS.find((p) => p.id === q.faction);
      this.say(`${pack?.name ?? 'They'} will remember the work. (standing ${this.standing[q.faction]})`, 0xc0a890);
    }
    if (q.faith) {
      this.favor[q.faith] = (this.favor[q.faith] ?? 0) + 1;
      this.say(`The congregation counts it as devotion. (favor ${this.favor[q.faith]})`, 0xb8a0d8);
    }
    if (this.pc.train('streetwise', 3)) this.say('Streetwise improves.', MSG_SYSTEM);
    if (q.twist) {
      this.say('Outside, somebody peels off a wall to follow you. The package was bait, or you were.', MSG_BAD);
      this.heat += 1;
      this.spawnHostiles('hustler', 1);
    }
    // Work begets work: a fifth of jobs come with a name attached.
    if (this.quests.length < QUEST_CAP && this.rTurn.chance(0.2)) {
      const cur = this.seedById.get(this.hoodId)!;
      const target = this.rTurn.pick(cur.adjacent);
      const targetName = this.seedById.get(target)?.name ?? target;
      const reward = 45 + this.rTurn.int(0, 45);
      const recent = this.world.chronicle[this.world.chronicle.length - 1 - this.rTurn.int(0, Math.min(8, this.world.chronicle.length - 1))];
      this.quests.push({
        id: `chain:${this.questSerial++}`,
        kind: 'deliver',
        desc: `Get the follow-up package to a counter in ${targetName}. No questions — especially not about ${q.giver}.`,
        itemId: 'package', qty: 1, targetHood: target, reward, giver: q.giver,
        twist: this.rTurn.chance(0.25),
      });
      this.pc.gain('package', 1);
      this.say(`Word comes back fast: ${q.giver} has a follow-up. "${recent ? `It's about what happened — ${recent.text.slice(0, 60)}…` : 'Same terms.'}" Another package, ${targetName}, $${reward}.`, 0xd8c850);
    }
    this.endTurn();
  }

  private maybeOfferQuest(npcIdx: number): boolean {
    if (this.quests.length >= QUEST_CAP) return false;
    const marked = (this.aFlags[npcIdx] & AF_QUESTGIVER) !== 0;
    if (!marked && !this.rTurn.chance(0.25)) return false;
    const arch = this.archOf(npcIdx);
    const cur = this.seedById.get(this.hoodId)!;
    // Where faction work and faith errands could point.
    const factionTarget = cur.adjacent.find((id) => {
      const st = this.world.neighborhoods[id];
      return st && Object.values(st.control).some((v) => v > 0.2);
    });
    const faithTarget = [this.hoodId, ...cur.adjacent].find((id) => {
      const st = this.world.neighborhoods[id];
      return st && Object.values(st.faiths).some((v) => v > 0.2);
    });
    const fits = QUEST_TEMPLATES.filter((t) => {
      if (!t.givers.includes(arch.id)) return false;
      if (this.quests.some((x) => x.id.startsWith(`${t.id}:`))) return false;
      if (t.needsFaction && !factionTarget) return false;
      if (t.needsFaith && !faithTarget) return false;
      return true;
    });
    if (!fits.length) return false;
    let total = 0;
    for (const t of fits) total += t.weight;
    let roll = this.rTurn.float() * total;
    let tpl: QuestTemplateDef = fits[fits.length - 1];
    for (const t of fits) { roll -= t.weight; if (roll <= 0) { tpl = t; break; } }
    const name = this.npcName(npcIdx);
    const targetHood = tpl.kind === 'errand' ? faithTarget!
      : tpl.kind === 'task' ? factionTarget!
      : tpl.kind === 'fetch' || tpl.kind === 'scavenge' ? undefined
      : this.rTurn.pick(cur.adjacent);
    const targetName = targetHood ? this.seedById.get(targetHood)?.name ?? targetHood : '';
    const qty = tpl.qty ? this.rTurn.int(tpl.qty[0], tpl.qty[1]) : 1;
    const carried = tpl.kind === 'deliver' || tpl.kind === 'task' || tpl.kind === 'errand';
    const itemId = tpl.itemId ?? (carried ? 'package' : '');
    const reward = this.rTurn.int(tpl.reward[0], tpl.reward[1]);
    const ctx = {
      name, target: targetName, qty, reward,
      item: itemId ? ITEM_BY_ID.get(itemId)?.name ?? itemId : '',
    };
    const faction = tpl.kind === 'task' && targetHood
      ? Object.entries(this.world.neighborhoods[targetHood].control).sort((a, b) => b[1] - a[1])[0]?.[0]
      : undefined;
    const faith = tpl.kind === 'errand' && targetHood
      ? Object.entries(this.world.neighborhoods[targetHood].faiths).sort((a, b) => b[1] - a[1])[0]?.[0]
      : undefined;
    this.quests.push({
      id: `${tpl.id}:${this.questSerial++}`,
      kind: tpl.kind,
      desc: this.grammar.expand(tpl.desc, this.rTurn, ctx),
      itemId, qty, targetHood, reward, giver: name, faction, faith,
      twist: tpl.twist ? this.rTurn.chance(tpl.twist) : false,
    });
    if (carried && itemId) this.pc.gain(itemId, 1);
    this.say(`${name}: ${this.grammar.expand(tpl.offer, this.rTurn, ctx)}`, 0xd8c850);
    this.say('Noted in your journal. [J]', MSG_SYSTEM);
    return true;
  }

  private openCharSheet(): void {
    const pc = this.pc;
    const lines: Msg[] = [];
    const origin = ORIGINS.find((o) => o.id === pc.originId)!;
    lines.push({ text: `${pc.name} — ${origin.name}`, fg: 0x6fd4c0 });
    lines.push({ text: origin.blurb, fg: 0x76869a });
    lines.push({ text: '', fg: 0 });
    lines.push({ text: `HP ${pc.hp}/${pc.maxHp}   Stamina ${Math.round(pc.stamina)}/${pc.maxStamina}   Hunger ${hungerWord(pc.hunger)}`, fg: 0xb8b8b8 });
    lines.push({ text: `Cash $${pc.money}   Net worth $${pc.netWorth()}`, fg: 0xd8c850 });
    lines.push({ text: '', fg: 0 });
    lines.push({ text: 'STATS', fg: 0xc9b458 });
    lines.push({ text: STATS.map((s) => `${s} ${pc.stats[s]}`).join('   '), fg: 0xb8b8b8 });
    lines.push({ text: '', fg: 0 });
    lines.push({ text: 'SKILLS (trained by use)', fg: 0xc9b458 });
    for (const s of SKILLS) {
      const lvl = pc.skill(s);
      if (lvl > 0) lines.push({ text: `  ${s.padEnd(12)} ${'▓'.repeat(lvl)}${'░'.repeat(Math.max(0, 8 - lvl))} ${lvl}`, fg: 0xa8a8b0 });
    }
    if (SKILLS.every((s) => pc.skill(s) === 0)) lines.push({ text: '  nothing yet. The city will teach you.', fg: 0x76869a });
    lines.push({ text: '', fg: 0 });
    const standings = Object.entries(this.standing).filter(([, v]) => v > 0);
    if (standings.length) {
      lines.push({ text: 'STANDING', fg: 0xc0a890 });
      for (const [fid, v] of standings) {
        const pack = FACTIONS.find((p) => p.id === fid);
        lines.push({ text: `  ${(pack?.name ?? fid).padEnd(28)} ${'▓'.repeat(Math.min(8, v))}${v >= 2 ? '  (checkpoints wave you through)' : ''}`, fg: 0xa8a8b0 });
      }
      lines.push({ text: '', fg: 0 });
    }
    if (pc.injuries.length) {
      lines.push({ text: 'INJURIES', fg: 0xc05a50 });
      for (const inj of pc.injuries) {
        lines.push({ text: `  ${INJURY_LABEL[inj.kind]} (${'!'.repeat(inj.severity)})`, fg: 0xc05a50 });
      }
    } else {
      lines.push({ text: 'Unhurt. Statistically temporary.', fg: 0x76869a });
    }
    this.outbox.push({ kind: 'journal', title: 'WHO YOU ARE', lines });
  }

  private actCityMap(a: Action): void {
    if (a.k === 'cancel' || a.k === 'citymap') {
      this.mode = 'play';
      this.lookText = '';
      return;
    }
    if (a.k === 'interact') { this.tryTravel(); return; }
    if (a.k !== 'move') return;
    const cur = this.seedById.get(this.selectedHood)!;
    let best: NeighborhoodSeed | null = null;
    let bestScore = Infinity;
    for (const s of this.seeds) {
      if (s.id === cur.id) continue;
      const dx = s.pos[0] - cur.pos[0];
      // The drawn map compresses y 2:1; match it so w/s feel like they look.
      const dy = (s.pos[1] - cur.pos[1]) * 0.5;
      const dot = dx * a.dx + dy * a.dy;
      if (dot <= 0.1) continue;
      const dist = Math.hypot(dx, dy);
      const off = Math.abs(dx * a.dy) + Math.abs(dy * a.dx);
      const score = dist + off * 1.5;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    if (best) {
      this.selectedHood = best.id;
      this.updateCityInfo();
    }
  }

  private updateCityInfo(): void {
    const s = this.seedById.get(this.selectedHood)!;
    const st = this.world.neighborhoods[s.id];
    const bar = (v: number) => '▓'.repeat(Math.round(v * 4)).padEnd(4, '░');
    const cur = this.seedById.get(this.hoodId)!;
    const curState = this.world.neighborhoods[this.hoodId];
    let route = '';
    if (s.id === this.hoodId) route = 'you are here';
    else if (cur.adjacent.includes(s.id)) route = 'adjacent — [e] walk';
    else {
      const shared = curState.subway.filter((l) => st.subway.includes(l));
      route = shared.length ? `${shared.join('/')} train — [e] ride` : 'no route from here';
    }
    const flood = st.flooded ? ` · flooded '${String(st.floodedYear! % 100)}` : '';
    const lines = st.subway.length ? ` · ${st.subway.join(' ')}` : ' · no service';
    this.lookText = `${s.name} (${BOROUGH_LABEL[s.borough]}) · crime ${bar(st.stats.crime)} · $$ ${bar(st.stats.prosperity)}${lines}${flood} · ${route}`;
  }

  private openJournal(): void {
    const lines: Msg[] = [];
    if (this.quests.length) {
      lines.push({ text: 'ACTIVE BUSINESS', fg: 0xd8c850 });
      for (const q of this.quests) {
        const have = q.itemId ? this.pc.inventory.find((s) => s.id === q.itemId)?.qty ?? 0 : 0;
        const progress = q.kind === 'scavenge' ? ` (${Math.min(have, q.qty)}/${q.qty})` : '';
        lines.push({ text: `• ${q.desc}${progress} — $${q.reward}, for ${q.giver}`, fg: 0xb8b8b8 });
      }
      lines.push({ text: '', fg: 0 });
    }
    let lastYear = 0;
    for (const c of this.world.chronicle) {
      if (c.year !== lastYear) {
        lastYear = c.year;
        if (lines.length) lines.push({ text: '', fg: 0 });
        lines.push({ text: `── ${c.year} ──`, fg: 0x6fd4c0 });
      }
      lines.push({ text: c.text, fg: c.tags.includes('founding') ? 0xc9b458 : 0xa8a8b0 });
    }
    this.outbox.push({ kind: 'journal', title: 'THE DECADE — a chronicle of 2026–2036', lines });
  }

  private openNews(): void {
    const lines: Msg[] = [];
    lines.push({ text: 'THE EMPIRE LEDGER — "All the news that survived."', fg: 0x6fd4c0 });
    lines.push({ text: '', fg: 0 });
    const rumors = this.city ? this.city.rumors.slice(-14).reverse() : [];
    if (rumors.length) {
      lines.push({ text: 'HEARD ON THE STREET (newest first):', fg: 0xc9b458 });
      for (const rumor of rumors) {
        lines.push({ text: `• ${this.city.expandRumor(rumor.text)}`, fg: rumor.fg });
      }
    } else {
      lines.push({ text: 'A quiet news day. Historically, this precedes the other kind.', fg: 0x76869a });
    }
    lines.push({ text: '', fg: 0 });
    if (this.city) {
      for (const line of this.city.standingsLines()) lines.push(line);
    }
    const recent = this.world.chronicle.filter((c) => c.year >= 2036 && c.tags.includes('obituary'));
    if (recent.length) {
      lines.push({ text: 'CLOSED ACCOUNTS:', fg: 0xc05a50 });
      for (const c of recent.slice(-4)) lines.push({ text: `• ${c.text}`, fg: 0x9a8a8a });
    }
    this.outbox.push({ kind: 'news', title: 'NEWS & RUMORS', lines });
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
    if (nx === this.px && ny === this.py) {
      this.lookText = 'You. Still standing.';
    } else if (this.visible[i]) {
      const ai = this.occ[i];
      const pile = this.map.items.get(i);
      this.lookText = ai >= 0 && this.aAlive[ai]
        ? this.describeActor(ai)
        : pile?.length
          ? `On the ground: ${pile.map((s) => ITEM_BY_ID.get(s.id)?.name).join(', ')}.`
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
    const nx = this.px + dx, ny = this.py + dy;
    if (!this.map.inBounds(nx, ny)) {
      this.say('The street keeps going. Use the city map [m] to follow it.', 0x9aa8d0);
      return;
    }
    const ti = this.map.idx(nx, ny);
    const ai = this.occ[ti];
    if (ai >= 0 && this.aAlive[ai]) {
      if (this.aKind[ai] === AK.NPC && this.aState[ai] === ST_HOSTILE) {
        this.resolveAttack(ai, 'torso'); // bump-to-attack; resolveAttack ends the turn
        return;
      }
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
      this.px = nx; this.py = ny;
      this.stepFlavor(t);
      const pile = this.map.items.get(ti);
      if (pile?.length) {
        this.say(`Here: ${pile.map((s) => ITEM_BY_ID.get(s.id)?.name).join(', ')}. [g] take`, 0x9aa8d0);
      }
      this.endTurn();
      return;
    }
    this.say(BLOCK_MSG[t] ?? 'Something solid blocks the way.');
  }

  private stepFlavor(t: T): void {
    if (t === T.Trash && this.rTurn.chance(0.3)) this.say('Glass crunches underfoot.');
    else if (t === T.Vent && this.rTurn.chance(0.5)) this.say('Steam wraps around you, smelling of laundry and the underworld.');
    else if (t === T.Rubble && this.rTurn.chance(0.15)) this.say('Brick dust puffs up with each step.');
    else if (t === T.Shallow && this.rTurn.chance(0.3)) this.say('Cold water over your ankles. The street is still down there, somewhere.');
    else if (t === T.Burnt && this.rTurn.chance(0.2)) this.say('Ash, packed hard by rain. The smell never fully left.');
  }

  private bumpActor(i: number): void {
    switch (this.aKind[i]) {
      case AK.NPC: {
        const arch = this.archOf(i);
        if (this.aBarkCd[i] === 0) {
          this.say(`${this.npcName(i)}, ${arch.label}: ${this.rTurn.pick(arch.barks)}`, MSG_BARK);
          this.aBarkCd[i] = 60;
        } else {
          this.say(this.rTurn.pick(BUMP_PED));
        }
        break;
      }
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

  /** Tiles around (and under) the player that [e] would act on, in interact()'s scan order. */
  private interactablesNear(): { x: number; y: number; t: T }[] {
    const out: { x: number; y: number; t: T }[] = [];
    if (!this.map) return out;
    for (const [dx, dy] of [[0, 0], ...DIRS] as number[][]) {
      const nx = this.px + dx, ny = this.py + dy;
      if (!this.map.inBounds(nx, ny)) continue;
      const t = this.map.t(nx, ny);
      if (t === T.Station || t === T.DoorClosed || t === T.DoorOpen || t === T.DoorLocked
        || t === T.Shrine || t === T.Altar || t === T.Counter) {
        out.push({ x: nx, y: ny, t });
      } else if ((t === T.Trash || t === T.Rubble) && !this.searchedHere().has(this.map.idx(nx, ny))) {
        out.push({ x: nx, y: ny, t });
      }
    }
    return out;
  }

  /** The first quest that can resolve here, by venue. */
  private completableAt(venue: 'counter' | 'altar'): Quest | null {
    if (!this.pc) return null;
    for (const q of this.quests) {
      if (venue === 'altar') {
        if (q.kind === 'errand' && q.targetHood === this.hoodId && this.pc.inventory.some((s) => s.id === q.itemId)) return q;
        continue;
      }
      switch (q.kind) {
        case 'collect':
          if (q.targetHood === this.hoodId) return q;
          break;
        case 'deliver':
        case 'task':
          if (q.targetHood === this.hoodId && this.pc.inventory.some((s) => s.id === q.itemId)) return q;
          break;
        case 'fetch':
        case 'scavenge': {
          const have = this.pc.inventory.find((s) => s.id === q.itemId)?.qty ?? 0;
          if (have >= q.qty) return q;
          break;
        }
        default:
          break;
      }
    }
    return null;
  }

  private questDeliverableHere(): boolean {
    return !!this.completableAt('counter');
  }

  private eHintFor(t: T): string {
    switch (t) {
      case T.Station: return 'subway';
      case T.DoorClosed: return 'open door';
      case T.DoorLocked: return 'force the lock';
      case T.DoorOpen: return 'close door';
      case T.Trash: return 'dig through';
      case T.Rubble: return 'search the rubble';
      case T.Shrine: return 'tend shrine';
      case T.Altar: return this.completableAt('altar') ? 'deliver' : 'worship';
      case T.Counter: return this.questDeliverableHere() ? 'deliver' : 'shop';
      default: return 'interact';
    }
  }

  /** What you can press right now — drawn in the bar above the message log. */
  contextHints(): Hint[] {
    if (this.mode === 'menu') {
      if (!this.menu) return [];
      const h: Hint[] = [{ key: 'w/s', label: 'choose' }, { key: 'e', label: 'confirm' }];
      if (this.menu.kind !== 'origin') h.push({ key: 'Esc', label: 'back' });
      return h;
    }
    if (this.mode === 'citymap') {
      return [
        { key: 'wasd', label: 'pick a neighborhood' },
        { key: 'e', label: 'travel there' },
        { key: 'Esc', label: 'back to the street' },
      ];
    }
    if (this.mode === 'look') return [{ key: 'wasd', label: 'inspect' }, { key: 'Esc', label: 'done looking' }];
    if (this.mode === 'target') {
      return [
        { key: 'e', label: 'attack' },
        { key: 'f/wasd', label: 'next target' },
        { key: 'Esc', label: 'never mind' },
      ];
    }
    if (!this.pc || !this.map) return [];
    if (this.pendingVault) return [{ key: 'wasd', label: 'vault that way' }, { key: 'any', label: 'never mind' }];
    const h: Hint[] = [];
    if (this.map.items.get(this.map.idx(this.px, this.py))?.length) h.push({ key: 'g', label: 'take' });
    let talk: string | null = null;
    let hostile = false;
    for (const [dx, dy] of DIRS) {
      const nx = this.px + dx, ny = this.py + dy;
      if (!this.map.inBounds(nx, ny)) continue;
      const ai = this.occ[this.map.idx(nx, ny)];
      if (ai < 0 || !this.aAlive[ai]) continue;
      if (this.aKind[ai] === AK.NPC) {
        if (this.aState[ai] === ST_HOSTILE) hostile = true;
        else if (!talk) {
          const hasWork = (this.aFlags[ai] & AF_QUESTGIVER) !== 0 && this.quests.length < QUEST_CAP;
          talk = this.npcName(ai).split(' ')[0] + (hasWork ? ' (has work)' : '');
        }
      } else if (this.aKind[ai] === AK.Cat && !talk) {
        talk = 'the cat';
      }
    }
    if (hostile) h.push({ key: 'f', label: 'fight' });
    if (talk) h.push({ key: 't', label: `talk to ${talk}` });
    const near = this.interactablesNear();
    if (near.length) h.push({ key: 'e', label: this.eHintFor(near[0].t) });
    if (h.length < 4) {
      for (const [dx, dy] of DIRS) {
        const ox = this.px + dx, oy = this.py + dy;
        const lx = this.px + dx * 2, ly = this.py + dy * 2;
        if (!this.map.inBounds(ox, oy) || !this.map.inBounds(lx, ly)) continue;
        if (VAULTABLE.has(this.map.t(ox, oy)) && this.map.walkable(lx, ly) && this.occ[this.map.idx(lx, ly)] < 0) {
          h.push({ key: 'v', label: 'vault' });
          break;
        }
      }
    }
    if (!h.length) return [{ key: 'm', label: 'city map' }, { key: 'x', label: 'examine' }, { key: 'i', label: 'bag' }];
    return h.slice(0, 5);
  }

  private interact(): void {
    const { px: x, py: y } = this;
    for (const [dx, dy] of [[0, 0], ...DIRS] as number[][]) {
      const nx = x + dx, ny = y + dy;
      if (!this.map.inBounds(nx, ny)) continue;
      const t = this.map.t(nx, ny);
      if (t === T.Station) {
        this.mode = 'citymap';
        this.selectedHood = this.hoodId;
        this.updateCityInfo();
        this.say('Down the steps, through the gate. Where to?', MSG_TRAVEL);
        return;
      }
      if (t === T.DoorClosed) {
        this.map.openDoor(nx, ny);
        this.say('You push the door open.');
        this.endTurn();
        return;
      }
      if (t === T.DoorLocked) {
        this.forceLock(nx, ny);
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
        const q = this.completableAt('altar');
        if (q) {
          this.completeQuest(q);
          return;
        }
        this.openAltarMenu(nx, ny);
        return;
      }
      if (t === T.Counter) {
        const h = this.hourOfDay();
        if (h >= 0 && h < 6) {
          this.say('The grate is down until six. A cat guards the inventory.');
          return;
        }
        const q = this.completableAt('counter');
        if (q) {
          this.completeQuest(q);
          return;
        }
        this.openShop();
        return;
      }
      if (t === T.Monument) {
        this.say('Whatever this commemorated, somebody sold the plaque.');
        return;
      }
      if ((t === T.Trash || t === T.Rubble) && !this.searchedHere().has(this.map.idx(nx, ny))) {
        this.searchTile(nx, ny, t);
        return;
      }
    }
    this.pickup();
  }

  private searchedHere(): Set<number> {
    let set = this.searched.get(this.hoodId);
    if (!set) { set = new Set(); this.searched.set(this.hoodId, set); }
    return set;
  }

  /** Dumpster diving: every drift of garbage is one roll, once. */
  private searchTile(x: number, y: number, t: T): void {
    this.searchedHere().add(this.map.idx(x, y));
    const r = this.rTurn;
    const roll = r.float();
    if (roll < 0.03) {
      this.pc.hp = Math.max(1, this.pc.hp - 1);
      this.say('Something in there bites back and is gone. (-1)', MSG_BAD);
    } else if (roll < (t === T.Rubble ? 0.12 : 0.08)) {
      const id = r.pick(['copper_coil', 'watch_old', 'salvage_battery']);
      this.pc.gain(id, 1);
      this.say(`Under the top layer: ${ITEM_BY_ID.get(id)!.name}. The block has been holding out on you.`, MSG_GOOD);
    } else if (roll < 0.2) {
      const id = r.pick(['beans', 'tallboy', 'street_dumpling']);
      this.pc.gain(id, 1);
      this.say(`You find ${ITEM_BY_ID.get(id)!.name}. Still sealed. Probably.`, MSG_GOOD);
    } else if (roll < 0.55) {
      const id = r.pick(['scrap_metal', 'phone_dead', 'umbrella', 'flask', 'box_cutter']);
      this.pc.gain(id, 1);
      this.say(`You come up with ${ITEM_BY_ID.get(id)!.name}.`, MSG_GOOD);
    } else {
      this.say(r.chance(0.5) ? 'Wet cardboard all the way down.' : 'Nothing. A rat watches you do it anyway, taking notes.');
    }
    if (this.pc.train('streetwise', 1)) this.say('Streetwise improves.', MSG_SYSTEM);
    this.endTurn();
  }

  /** A locked door is a question. Crowbars are an answer; shoulders are a guess. */
  private forceLock(x: number, y: number): void {
    const pc = this.pc;
    const crowbar = pc.inventory.some((s) => s.id === 'crowbar');
    let opened = false;
    if (crowbar) {
      opened = true;
      this.say('The crowbar asks once. The frame gives.', MSG_GOOD);
    } else {
      if (pc.stamina < 8) {
        this.say('Your shoulder declines the assignment. Stamina first.');
        return;
      }
      pc.stamina -= 8;
      const odds = 0.25 + pc.stats.STR * 0.06 + pc.skill('athletics') * 0.03;
      if (this.rTurn.chance(Math.min(0.9, odds))) {
        opened = true;
        this.say('Wood splinters. The locks hold; the door around them does not.', MSG_GOOD);
      } else {
        this.say('The door takes the hit and keeps its opinion. Your shoulder files a complaint.', MSG_BAD);
      }
    }
    if (opened) {
      this.map.openDoor(x, y);
      const ti = this.map.idx(x, y);
      const rs = new Rand(this.seed, `stashloot:${this.hoodId}:${ti}`);
      const pile = this.map.items.get(ti) ?? [];
      const n = 2 + rs.int(0, 2);
      for (let k = 0; k < n; k++) {
        const roll = rs.float();
        if (roll < 0.12) pile.push({ id: rs.pick(RELIC_IDS), qty: 1 });
        else if (roll < 0.4) pile.push({ id: rs.pick(['copper_coil', 'salvage_battery', 'watch_old', 'medkit', 'bullets']), qty: 1 });
        else pile.push({ id: rs.pick(['blackout_candle', 'flask', 'painkillers', 'scrap_metal', 'bandage']), qty: 1 });
      }
      if (rs.chance(0.5)) pile.push({ id: 'cash', qty: 5 + rs.int(0, 40) });
      this.map.items.set(ti, pile);
      this.say('Inside: somebody\'s whole contingency plan, abandoned. [g] take', 0x9aa8d0);
    }
    this.endTurn();
  }

  private endTurn(silent = false): void {
    this.turn++;
    this.clockMin += 0.1;
    const pc = this.pc;
    // Needs tick.
    if (this.turn % 120 === 0) {
      pc.hunger = Math.min(100, pc.hunger + 1);
      if (pc.hunger === 70) this.say('Your stomach files a formal complaint.', MSG_BAD);
      if (pc.hunger === 90) this.say('You are genuinely starving. The bodega smells follow you like ghosts.', MSG_BAD);
    }
    if (pc.hunger >= 100 && this.turn % 30 === 0) {
      pc.hp = Math.max(1, pc.hp - 1);
      if (!silent) this.say('Hunger is eating you instead.', MSG_BAD);
    }
    pc.stamina = Math.min(pc.maxStamina, pc.stamina + 0.5);
    // Bleeding drains; minor injuries fade.
    const bleeding = pc.has('bleeding');
    if (bleeding && this.turn % 8 === 0) {
      pc.hp -= bleeding.severity;
      if (!silent) this.say('You are leaving a trail.', MSG_BAD);
    }
    for (const inj of pc.injuries) inj.turns++;
    pc.injuries = pc.injuries.filter((inj) => !(inj.severity <= 1 && inj.turns > 600));
    if (pc.hp <= 0) pc.hp = 1; // death arrives with combat (M2); hunger alone won't finish you yet

    this.actorsAct();
    this.directorTick(silent);
    if (this.turn - this.lastAmbient > 18 && this.rTurn.chance(0.05)) {
      if (!silent) this.say(this.grammar.expand('#ambient#', this.rTurn), MSG_AMBIENT);
      this.lastAmbient = this.turn;
    }

    // Tier 2: coarse tick over loaded neighborhoods every 100 turns. What
    // happens on *this* block, you hear happen.
    if (this.city && this.turn - this.lastT2 >= 100) {
      this.lastT2 = this.turn;
      const incidents = this.city.tier2Tick(this.hoodId, this.hourOfDay(), this.dayOf());
      for (const inc of incidents) {
        if (inc.hood !== this.hoodId) continue;
        this.pendingIncidents.push(inc);
        if (silent) continue;
        switch (inc.kind) {
          case 'death': this.say('Shouting, a few blocks over. It stops abruptly.', MSG_BAD); break;
          case 'mugging': this.say('A scuffle echoes out of a side street. Footsteps scatter.', MSG_BAD); break;
          case 'burglary': this.say('Glass tinkles somewhere behind the buildings. Unhurried. Professional.'); break;
          case 'procession': this.say('Candlelight slides between the buildings. Humming, many voices.', 0xb8a0d8); break;
        }
      }
      if (this.pendingIncidents.length > 4) this.pendingIncidents.splice(0, this.pendingIncidents.length - 4);
    }
    // District pulse: every ~40 game-minutes the neighborhood says something
    // to your face instead of burying it in a menu.
    if (this.city && this.turn - this.lastPulse >= 400) {
      this.lastPulse = this.turn;
      const p = this.city.districtPulse(this.hoodId, this.hourOfDay());
      if (p && !silent) this.say(p.text, p.fg);
    }
    // Tier 3: the city turns over daily; the news waits for the editions.
    const day = this.dayOf();
    if (this.city && day !== this.lastDay) {
      const first = this.lastDay === -1;
      this.lastDay = day;
      if (!first) {
        const { headlines } = this.city.tier3Daily(day);
        this.pendingHeadlines.push(...headlines.slice(0, 3));
        this.resolveBets(day - 1);
      }
    }
    // Editions: dawn and dusk, the Ledger finds you.
    {
      const h = this.hourOfDay();
      const band = day * 3 + (h >= 18 ? 2 : h >= 7 ? 1 : 0);
      if (this.lastEditionBand === -1) {
        this.lastEditionBand = band; // booting mid-day shouldn't print stale news
      } else if (band > this.lastEditionBand && this.city) {
        const morning = band % 3 === 1;
        this.lastEditionBand = band;
        if (!silent && (morning || band % 3 === 2)) {
          this.say(`THE LEDGER, ${morning ? 'morning' : 'evening'} edition —`, 0xc9b458);
          const items: string[] = [];
          if (this.pendingHeadlines.length) items.push(...this.pendingHeadlines.splice(0, 2));
          else {
            const fresh = this.city.rumors[this.city.rumors.length - 1];
            if (fresh) items.push(this.city.expandRumor(fresh.text));
          }
          const g = this.city.fixtures[this.city.fixtures.length - 1];
          if (morning && g) items.push(`Late score: ${g.home} ${g.homeScore}, ${g.away} ${g.awayScore}.`);
          if (items.length) for (const it of items) this.say(`  ${it}`, 0xa8a8b0);
          else this.say('  A quiet news day. Historically, this precedes the other kind.', 0x76869a);
        }
      }
    }
    // Worship: standing near a holy altar at ritual hour earns favor.
    if (this.faith && this.turn - this.lastRitual > 80) {
      const h = this.hourOfDay();
      if (h >= 18 && h < 20) {
        for (const ti of this.tilesAltar) {
          const ax = ti % this.map.w, ay = (ti / this.map.w) | 0;
          if (Math.abs(ax - this.px) + Math.abs(ay - this.py) <= 3) {
            this.lastRitual = this.turn;
            this.favor[this.faith] = (this.favor[this.faith] ?? 0) + 1;
            const pack = RELIGIONS.find((p) => p.id === this.faith);
            if (pack) {
              this.say(this.grammar.expand(pack.ritual.text, this.rTurn), 0xb8a0d8);
              this.say(`You stand with them through ${pack.ritual.name}. (favor ${this.favor[this.faith]})`, MSG_SYSTEM);
              if (this.favor[this.faith] === 3) {
                this.say(`${pack.boon.name}: ${pack.boon.desc}`, 0xb8a0d8);
              }
            }
            break;
          }
        }
      }
    }
    this.computeVision();
  }

  private dayOf(): number {
    return Math.floor(this.clockMin / (24 * 60));
  }

  private resolveBets(day: number): void {
    if (!this.bets.length) return;
    const remaining: typeof this.bets = [];
    for (const bet of this.bets) {
      const game = this.city.fixtures.find(
        (g) => g.day >= bet.day && g.league === bet.league && (g.home === bet.team || g.away === bet.team),
      );
      if (!game) {
        if (day - bet.day > 4) {
          this.pc.money += bet.stake;
          this.say(`Your ${bet.team} bet was scratched — no fixture. Stake returned.`, MSG_TRAVEL);
        } else remaining.push(bet);
        continue;
      }
      const winner = game.homeScore > game.awayScore ? game.home : game.away;
      if (winner === bet.team) {
        const payout = Math.round(bet.stake * bet.odds * (this.hasBoon('house_odds') ? 1.2 : 1));
        this.pc.money += payout;
        this.say(`${bet.team} won! The book pays $${payout}. ${game.home} ${game.homeScore}–${game.awayScore} ${game.away}.`, MSG_GOOD);
      } else {
        this.say(`${bet.team} lost (${game.home} ${game.homeScore}–${game.awayScore} ${game.away}). The book keeps your $${bet.stake} with great professionalism.`, MSG_BAD);
      }
    }
    this.bets = remaining;
  }

  // --- the street director (M6): scenes and directed encounters -----------------------

  /** Reuse a dead slot before growing the pool. -1 = the city is full. */
  private allocActor(): number {
    for (let i = 0; i < this.aCount; i++) if (!this.aAlive[i]) return i;
    if (this.aCount < MAX_ACTORS) return this.aCount++;
    return -1;
  }

  private directorTick(silent: boolean): void {
    if (!this.pc) return;
    if (this.scene) this.sceneTick(silent);
    if (this.director.blackoutUntil > 0 && this.turn >= this.director.blackoutUntil) {
      this.director.blackoutUntil = 0;
      if (!silent) this.say('The lights stutter back on, block by block. Nobody cheers anymore.', MSG_AMBIENT);
    }
    if (this.mode === 'menu') return; // beats wait while you're mid-decision
    const hood = this.seedById.get(this.hoodId)!;
    const state = this.world.neighborhoods[this.hoodId];
    const beat = this.director.tick(this.turn, {
      hour: this.hourOfDay(),
      areaType: hood.area_type,
      state,
      sceneActive: !!this.scene,
      encounterReady: this.turn - this.director.lastEncounter > 150 && this.encounterCandidate() !== null,
    });
    if (beat) {
      switch (beat.kind) {
        case 'message':
          if (!silent) {
            const slot = GRAMMAR_RULES.street_beat ? '#street_beat#' : '#ambient#';
            this.say(this.grammar.expand(slot, this.director.r, { neighborhood: this.hoodName() }), MSG_AMBIENT);
          }
          break;
        case 'scene': {
          // A Tier-2 death on this block takes precedence: stage the discovery.
          const di = this.pendingIncidents.findIndex((p) => p.kind === 'death');
          const def = di >= 0 ? BODY_DISCOVERED : beat.scene!;
          if (di >= 0) this.pendingIncidents.splice(di, 1);
          this.startScene(def, silent);
          break;
        }
        case 'encounter':
          this.startEncounter();
          break;
      }
    }
    // Floor: on a hot block, quiet doesn't last 400 turns.
    if (!this.encounter && this.mode === 'play' && state.stats.crime > 0.6
        && this.turn - this.director.lastEncounter > 400 && this.encounterCandidate() !== null) {
      this.director.lastEncounter = this.turn;
      this.startEncounter();
    }
  }

  private startScene(def: StreetSceneDef, silent: boolean): void {
    const r = this.director.r;
    if (def.behavior === 'blackout') {
      this.director.blackoutUntil = this.turn + r.int(60, 120);
      if (!silent) this.saySceneText(def, def.text.start);
      return;
    }
    // Anchor: a walkable spot 8–14 tiles out — close enough to matter.
    let ax = -1, ay = -1;
    for (let tries = 0; tries < 30; tries++) {
      const ang = r.float() * Math.PI * 2;
      const d = 8 + r.float() * 6;
      const x = Math.round(this.px + Math.cos(ang) * d);
      const y = Math.round(this.py + Math.sin(ang) * d);
      if (this.map.inBounds(x, y) && this.map.walkable(x, y)) { ax = x; ay = y; break; }
    }
    if (ax < 0) return;
    if (def.behavior === 'shakedown') {
      // Posted at the nearest counter, if the block has one.
      let best = -1, bestD = 25;
      for (let i = 0; i < this.map.terrain.length; i++) {
        if (this.map.terrain[i] !== T.Counter) continue;
        const cx = i % this.map.w, cy = (i / this.map.w) | 0;
        const d = Math.abs(cx - this.px) + Math.abs(cy - this.py);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) { ax = best % this.map.w; ay = (best / this.map.w) | 0; }
    }
    const actors: number[] = [];
    const isBrawl = def.behavior === 'brawl';
    const archIdx = def.spawn?.arch ? ARCHETYPES.findIndex((a) => a.id === def.spawn!.arch) : -1;
    const want = isBrawl ? 2 : def.spawn ? r.int(def.spawn.count[0], def.spawn.count[1]) : 0;
    for (let k = 0; k < want && actors.length < 12; k++) {
      let sx = -1, sy = -1;
      for (let t = 0; t < 14; t++) {
        const x = ax + r.int(-2, 2), y = ay + r.int(-2, 2);
        if (this.map.inBounds(x, y) && this.canStep(x, y)) { sx = x; sy = y; break; }
      }
      if (sx < 0) continue;
      const i = this.allocActor();
      if (i < 0) break;
      const kind = def.behavior === 'swarm' ? AK.Rat : archIdx >= 0 ? AK.NPC : AK.Ped;
      this.aKind[i] = kind;
      this.aX[i] = sx; this.aY[i] = sy;
      this.aHomeX[i] = ax; this.aHomeY[i] = ay;
      this.aWorkX[i] = ax; this.aWorkY[i] = ay;
      this.aDir[i] = r.int(0, 3);
      this.aAlive[i] = 1;
      this.aStun[i] = 0;
      this.aFlags[i] = 0;
      this.aState[i] = isBrawl ? ST_BRAWL : ST_SCENE;
      this.aTarget[i] = -1;
      this.aBarkCd[i] = r.int(20, 90);
      if (kind === AK.NPC) {
        const arch = ARCHETYPES[archIdx];
        this.aArch[i] = archIdx;
        this.aHp[i] = r.int(arch.hp[0], arch.hp[1]);
        this.aColor[i] = ARCH_COLOR[arch.id] ?? 0x9a9aa4;
      } else if (kind === AK.Rat) {
        this.aHp[i] = 2;
        this.aColor[i] = 0x8a6f52;
      } else {
        this.aHp[i] = 4;
        this.aColor[i] = r.pick(PED_COLORS);
      }
      this.occ[this.map.idx(sx, sy)] = i;
      actors.push(i);
    }
    if (isBrawl && actors.length >= 2) {
      this.aTarget[actors[0]] = actors[1];
      this.aTarget[actors[1]] = actors[0];
    }
    if (def.id === 'body_discovered') {
      const ti = this.map.idx(ax, ay);
      const pile = this.map.items.get(ti) ?? [];
      pile.push({ id: 'corpse', qty: 1 });
      this.map.items.set(ti, pile);
    }
    this.scene = {
      def, x: ax, y: ay, actors,
      endsAt: this.turn + r.int(def.duration[0], def.duration[1]),
      lastTick: this.turn,
    };
    if (!silent) this.saySceneText(def, def.text.start);
  }

  private sceneTick(silent: boolean): void {
    const sc = this.scene!;
    const brawlDone = sc.def.behavior === 'brawl' && sc.actors.filter((i) => this.aAlive[i]).length < 2;
    if (this.turn >= sc.endsAt || brawlDone) {
      for (const i of sc.actors) if (this.aAlive[i]) this.removeActor(i);
      if (!silent && sc.def.text.end) this.saySceneText(sc.def, sc.def.text.end);
      this.scene = null;
      return;
    }
    if (sc.def.text.tick && this.turn - sc.lastTick >= 12 && this.director.r.chance(0.3)) {
      sc.lastTick = this.turn;
      const d = Math.abs(sc.x - this.px) + Math.abs(sc.y - this.py);
      if (!silent && d <= 20) this.saySceneText(sc.def, sc.def.text.tick);
    }
  }

  private saySceneText(def: StreetSceneDef, text: string): void {
    const FG: Record<string, number> = {
      crowd: 0x9aa8d0, vigil: 0xb8a0d8, swarm: 0xa8a290,
      brawl: 0xc08050, blackout: 0xc9b458, shakedown: 0xc08050,
    };
    this.say(this.grammar.expand(text, this.director.r, { neighborhood: this.hoodName() }), FG[def.behavior] ?? MSG_AMBIENT);
  }

  /** What this person might say to you, given what you visibly are right now. */
  private barkPool(arch: { barks: string[]; piety: number }): string[] {
    const pool = [...arch.barks];
    const add = (slot: string) => { if (GRAMMAR_RULES[slot]) pool.push(...GRAMMAR_RULES[slot]); };
    const weapon = this.pc.weapon ? ITEM_BY_ID.get(this.pc.weapon) : null;
    if (weapon?.kind === 'gun') add('bark_sees_gun');
    if (this.pc.has('bleeding') || this.pc.hp < this.pc.maxHp * 0.4) add('bark_sees_blood');
    if (this.heat >= 3) add('bark_high_heat');
    if (this.faith && arch.piety >= 6) add('bark_same_faith');
    if (this.daylight() < 0.25) add('bark_night');
    if (this.pc.money >= 800) add('bark_rich');
    if (this.pc.money < 5) add('bark_broke');
    if (this.rTurn.chance(0.1)) add('bark_rain_omen');
    return pool;
  }

  /** Keep a scene actor orbiting its anchor. */
  private sceneLoiter(i: number): void {
    const r = this.rTurn;
    const x = this.aX[i], y = this.aY[i];
    const d = Math.abs(x - this.aHomeX[i]) + Math.abs(y - this.aHomeY[i]);
    if (d > 2) {
      if (r.chance(0.8)) this.stepToward(i, this.aHomeX[i], this.aHomeY[i]);
    } else if (r.chance(0.2)) {
      const [dx, dy] = r.pick(DIRS);
      if (this.canStep(x + dx, y + dy)
        && Math.abs(x + dx - this.aHomeX[i]) + Math.abs(y + dy - this.aHomeY[i]) <= 2) {
        this.moveActor(i, x + dx, y + dy);
      }
    }
  }

  /** Two people settling it themselves. The player is just weather here. */
  private brawlAct(i: number): void {
    const t = this.aTarget[i];
    if (t < 0 || !this.aAlive[t]) {
      this.aState[i] = ST_SCENE;
      this.aTarget[i] = -1;
      return;
    }
    const d = Math.abs(this.aX[i] - this.aX[t]) + Math.abs(this.aY[i] - this.aY[t]);
    if (d === 1) {
      if (this.rTurn.chance(0.45)) {
        this.aHp[t] -= this.rTurn.int(1, 4);
        const seen = this.visible[this.map.idx(this.aX[i], this.aY[i])] === 1;
        if (this.aHp[t] <= 0) {
          this.dieQuietly(t);
        } else if (seen && this.rTurn.chance(0.15)) {
          this.say(`${this.npcName(i)} and ${this.npcName(t)} trade hits. Neither is good at this. Both are committed.`, 0xc08050);
        }
      }
    } else if (this.rTurn.chance(0.8)) {
      this.stepToward(i, this.aX[t], this.aY[t]);
    }
  }

  /** Someone close enough, with motive. */
  private encounterCandidate(): { idx: number; kind: 'mugger' | 'watchman' } | null {
    if (this.mode !== 'play' || !this.map) return null;
    let mugger = -1, law = -1;
    for (let i = 0; i < this.aCount; i++) {
      if (!this.aAlive[i] || this.aKind[i] !== AK.NPC || this.aState[i] !== ST_SCHEDULE) continue;
      const d = Math.abs(this.aX[i] - this.px) + Math.abs(this.aY[i] - this.py);
      if (d > 8) continue;
      const arch = this.archOf(i);
      if (arch.mugger && mugger < 0) mugger = i;
      if (arch.law && this.heat >= 2 && law < 0) law = i;
    }
    if (law >= 0) return { idx: law, kind: 'watchman' };
    if (mugger >= 0) return { idx: mugger, kind: 'mugger' };
    return null;
  }

  private startEncounter(): void {
    if (this.encounter || this.mode !== 'play') return;
    const state = this.world.neighborhoods[this.hoodId];
    // A recruiter sometimes gets to you before the predators do.
    if (!this.faith && state.stats.cult > 0.3 && this.director.r.chance(0.25)) {
      const faiths = Object.entries(state.faiths).filter(([, v]) => v > 0.15);
      if (faiths.length) {
        this.startRecruiterEncounter(this.director.r.pick(faiths)[0]);
        return;
      }
    }
    const cand = this.encounterCandidate();
    if (!cand) return;
    this.director.lastEncounter = this.turn;
    if (cand.kind === 'watchman') this.startWatchmanEncounter(cand.idx);
    else this.startMuggerEncounter(cand.idx);
  }

  private startMuggerEncounter(i: number): void {
    const name = this.npcName(i);
    this.encounter = { kind: 'mugger', idx: i };
    this.say(`${name} steps out ahead of you. "Wallet. Easy way or the other way."`, MSG_BAD);
    this.menu = {
      kind: 'encounter',
      title: `${name.toUpperCase()} WANTS YOUR MONEY`,
      entries: [
        { label: 'Hand over some cash', sub: 'Money is replaceable. Allegedly.', data: 'enc:pay' },
        { label: 'Talk them down', sub: 'CHA and streetwise against their nerve.', data: 'enc:talk' },
        { label: 'Run for it', sub: 'AGI and athletics. Costs stamina either way.', data: 'enc:run' },
        { label: 'Fight', sub: 'You move first. After that, who knows.', data: 'enc:fight' },
      ],
      sel: 0,
    };
    this.mode = 'menu';
  }

  private startWatchmanEncounter(i: number): void {
    const name = this.npcName(i);
    const bribe = 25 + Math.floor(this.heat) * 15;
    this.encounter = { kind: 'watchman', idx: i, toll: bribe };
    this.say(`${name} marks you across the street. "Hold it right there."`, MSG_BAD);
    this.menu = {
      kind: 'encounter',
      title: `${name.toUpperCase()} HAS QUESTIONS`,
      entries: [
        { label: `Settle it here ($${bribe})`, sub: 'The oldest civic institution.', data: 'enc:bribe' },
        { label: 'Comply', sub: 'A fine, a lecture, half an hour of your night.', data: 'enc:comply' },
        { label: 'Bolt', sub: 'Heat goes up. So does your pulse.', data: 'enc:bolt' },
      ],
      sel: 0,
    };
    this.mode = 'menu';
  }

  private startRecruiterEncounter(faithId: string): void {
    const pack = RELIGIONS.find((p) => p.id === faithId);
    if (!pack) return;
    this.encounter = { kind: 'recruiter', idx: -1, faith: faithId };
    this.say('Someone falls into step beside you, holding pamphlets like a winning hand.', 0xb8a0d8);
    this.menu = {
      kind: 'encounter',
      title: `THE ${pack.name.toUpperCase()} WOULD LIKE A WORD`,
      entries: [
        { label: 'Take the pamphlet', sub: `${pack.name}: it's this or nothing, they say.`, data: 'enc:pamphlet' },
        { label: 'Keep walking', sub: 'The city respects a straight line.', data: 'enc:decline' },
      ],
      sel: 0,
    };
    this.mode = 'menu';
  }

  private resolveEncounter(choice: string): void {
    const enc = this.encounter;
    this.encounter = null;
    if (!enc) return;
    const i = enc.idx;
    const name = i >= 0 ? this.npcName(i) : '';
    switch (choice) {
      case 'pay': {
        const ask = Math.min(this.pc.money, 20 + this.rTurn.int(0, 60));
        this.pc.money -= ask;
        if (i >= 0) this.aState[i] = ST_FLEE;
        this.say(ask > 0
          ? `You hand over $${ask}. ${name} melts back into the scaffolding shadows.`
          : `Your pockets are honestly empty. ${name} looks almost sorry for you, and leaves.`, MSG_BAD);
        this.endTurn();
        break;
      }
      case 'talk': {
        const arch = i >= 0 ? this.archOf(i) : null;
        const odds = 0.3 + this.pc.stats.CHA * 0.045 + this.pc.skill('streetwise') * 0.06 - (arch ? arch.courage * 0.02 : 0);
        if (this.rTurn.chance(Math.max(0.1, Math.min(0.9, odds)))) {
          if (i >= 0) this.aState[i] = ST_FLEE;
          this.say(`You talk like you have nothing worth taking and friends worth knowing. ${name} buys it.`, MSG_GOOD);
          if (this.pc.train('streetwise', 2)) this.say('Streetwise improves.', MSG_SYSTEM);
        } else {
          if (i >= 0) this.aState[i] = ST_HOSTILE;
          this.say(`${name} is not in the market for a story.`, MSG_BAD);
        }
        this.endTurn();
        break;
      }
      case 'run': {
        this.pc.stamina = Math.max(0, this.pc.stamina - 15);
        const odds = 0.45 + this.pc.stats.AGI * 0.04 + this.pc.skill('athletics') * 0.05 - (this.pc.has('limp') ? 0.2 : 0);
        if (this.rTurn.chance(Math.max(0.1, Math.min(0.95, odds)))) {
          if (i >= 0) {
            // You break away; they lose the angle.
            this.stepAwayPlayer(i);
            this.aStun[i] = 3;
          }
          this.say('You go. Corners help. By the second one, nobody is behind you.', MSG_GOOD);
          if (this.pc.train('athletics', 2)) this.say('Athletics improves.', MSG_SYSTEM);
        } else {
          if (i >= 0) { this.aState[i] = ST_HOSTILE; this.npcAttack(i); }
          this.say('You stumble on the first step. Bad start.', MSG_BAD);
        }
        this.endTurn();
        break;
      }
      case 'fight':
        if (i >= 0) this.aState[i] = ST_HOSTILE;
        this.say('You square up first. Sometimes that decides it.', MSG_BAD);
        break;
      case 'bribe': {
        const cost = enc.toll ?? 25;
        if (this.pc.money >= cost) {
          this.pc.money -= cost;
          this.heat = Math.max(0, this.heat - 2);
          if (i >= 0) this.aState[i] = ST_SCHEDULE;
          this.say(`$${cost} changes hands inside a handshake. ${name} remembers an appointment elsewhere.`, MSG_TRAVEL);
        } else {
          this.say('Your pockets disappoint everyone. It goes on your record instead.', MSG_BAD);
          this.heat = 0;
          this.advanceTime(30);
        }
        this.endTurn();
        break;
      }
      case 'comply': {
        const fine = Math.round(this.pc.money * 0.1);
        this.pc.money -= fine;
        this.heat = 0;
        this.advanceTime(30);
        this.say(`Half an hour of questions and a $${fine} 'administrative recovery'. The street feels longer after.`, MSG_BAD);
        this.endTurn();
        break;
      }
      case 'bolt':
        this.heat += 2;
        if (i >= 0) this.aState[i] = ST_HOSTILE;
        this.say('You bolt. The whistle behind you is almost flattering.', MSG_BAD);
        this.endTurn();
        break;
      case 'pamphlet': {
        if (enc.faith) {
          this.favor[enc.faith] = (this.favor[enc.faith] ?? 0) + 1;
          const pack = RELIGIONS.find((p) => p.id === enc.faith);
          this.say(`You take the pamphlet. ${pack?.name ?? 'They'} will remember that you listened. (favor ${this.favor[enc.faith]})`, 0xb8a0d8);
        }
        this.endTurn();
        break;
      }
      case 'decline':
        this.say('You keep walking. The pamphlet finds a less committed pocket.', MSG_AMBIENT);
        this.endTurn();
        break;
      case 'toll_pay': {
        const cost = enc.toll ?? 20;
        this.pc.money = Math.max(0, this.pc.money - cost);
        this.say(`$${cost} for the privilege of the sidewalk. The barricade swings open.`, MSG_BAD);
        if (enc.dest) this.walkTravel(enc.dest);
        break;
      }
      case 'toll_fight':
        this.say('You walk through their checkpoint like it isn\'t one. They notice.', MSG_BAD);
        if (enc.dest) {
          this.walkTravel(enc.dest);
          this.spawnHostiles('enforcer', 2);
        }
        break;
      case 'toll_back':
        this.say('Not tonight. You turn around; the barricade pretends not to gloat.');
        break;
      default:
        break;
    }
  }

  /** Push the player directly away from actor i, if the tile allows it. */
  private stepAwayPlayer(i: number): void {
    const dx = Math.sign(this.px - this.aX[i]), dy = Math.sign(this.py - this.aY[i]);
    for (const [mx, my] of [[dx, dy], [dx, 0], [0, dy]]) {
      const nx = this.px + mx * 2, ny = this.py + my * 2;
      if (this.map.inBounds(nx, ny) && this.map.walkable(nx, ny) && this.occ[this.map.idx(nx, ny)] < 0) {
        this.px = nx; this.py = ny;
        return;
      }
    }
  }

  private advanceTime(minutes: number): void {
    this.clockMin += minutes;
    this.turn += minutes * 10;
    this.passiveRecover(minutes * 10);
  }

  private spawnHostiles(archId: string, count: number, msg?: string): void {
    const archIdx = ARCHETYPES.findIndex((a) => a.id === archId);
    if (archIdx < 0) return;
    let spawned = 0;
    for (let k = 0; k < count; k++) {
      const i = this.allocActor();
      if (i < 0) return;
      let sx = -1, sy = -1;
      for (let t = 0; t < 16; t++) {
        const x = this.px + this.rTurn.int(-5, 5), y = this.py + this.rTurn.int(-5, 5);
        if (Math.abs(x - this.px) + Math.abs(y - this.py) >= 3 && this.map.inBounds(x, y) && this.canStep(x, y)) { sx = x; sy = y; break; }
      }
      if (sx < 0) return;
      const arch = ARCHETYPES[archIdx];
      this.aKind[i] = AK.NPC;
      this.aArch[i] = archIdx;
      this.aX[i] = sx; this.aY[i] = sy;
      this.aHomeX[i] = sx; this.aHomeY[i] = sy;
      this.aWorkX[i] = sx; this.aWorkY[i] = sy;
      this.aHp[i] = this.rTurn.int(arch.hp[0], arch.hp[1]);
      this.aColor[i] = ARCH_COLOR[arch.id] ?? 0x9a9aa4;
      this.aAlive[i] = 1;
      this.aStun[i] = 0;
      this.aFlags[i] = 0;
      this.aTarget[i] = -1;
      this.aState[i] = ST_HOSTILE;
      this.aBarkCd[i] = 0;
      this.occ[this.map.idx(sx, sy)] = i;
      spawned++;
    }
    if (spawned > 0) {
      this.say(msg ?? `${spawned > 1 ? 'Sets of boots leave' : 'A set of boots leaves'} the checkpoint behind you, unhurried.`, MSG_BAD);
    }
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
    if (nx === this.px && ny === this.py) return false;
    return this.occ[this.map.idx(nx, ny)] === -1;
  }

  private stepToward(i: number, tx: number, ty: number): void {
    const x = this.aX[i], y = this.aY[i];
    const dx = Math.sign(tx - x), dy = Math.sign(ty - y);
    const order = Math.abs(tx - x) >= Math.abs(ty - y)
      ? [[dx, 0], [0, dy], [0, -dy], [-dx, 0]]
      : [[0, dy], [dx, 0], [-dx, 0], [0, -dy]];
    for (const [mx, my] of order) {
      if (mx === 0 && my === 0) continue;
      const nx = x + mx, ny = y + my;
      if (this.map.inBounds(nx, ny) && this.map.t(nx, ny) === T.DoorClosed) {
        this.map.openDoor(nx, ny); // people open doors; that's most of civilization
        return;
      }
      if (this.canStep(nx, ny)) {
        this.moveActor(i, nx, ny);
        return;
      }
    }
  }

  private stepAway(i: number, fx: number, fy: number): void {
    const x = this.aX[i], y = this.aY[i];
    const dirs = [...DIRS].sort((a, b) =>
      (Math.abs(x + b[0] - fx) + Math.abs(y + b[1] - fy)) -
      (Math.abs(x + a[0] - fx) + Math.abs(y + a[1] - fy)));
    for (const [mx, my] of dirs) {
      if (this.canStep(x + mx, y + my)) {
        this.moveActor(i, x + mx, y + my);
        return;
      }
    }
  }

  /** Where this NPC wants to be right now; [-1,-1] = roam. */
  private scheduleTarget(i: number): [number, number] {
    const arch = this.archOf(i);
    const h = this.hourOfDay();
    const home: [number, number] = [this.aHomeX[i], this.aHomeY[i]];
    const work: [number, number] = [this.aWorkX[i], this.aWorkY[i]];
    switch (arch.schedule) {
      case 'worker': return h >= 8 && h < 17 ? work : h >= 17 && h < 21 ? [-1, -1] : home;
      case 'stall': return h >= 7 && h < 21 ? work : home;
      case 'corner': return h >= 10 || h < 2 ? work : home;
      case 'worship': return h >= 18 && h < 20 && this.tilesAltar.length ? work : h >= 22 || h < 6 ? home : [-1, -1];
      default: return [-1, -1];
    }
  }

  private npcAttack(i: number): void {
    const arch = this.archOf(i);
    const name = this.npcName(i);
    const disarmed = (this.aFlags[i] & AF_DISARMED) !== 0;
    const skill = Math.max(0, arch.skill - (disarmed ? 2 : 0));
    const acc = 50 + skill * 6 - (this.pc.stats.AGI - 5) * 3;
    if (this.rTurn.int(0, 99) >= acc) {
      this.say(`${name} swings at you. The air takes it.`);
      return;
    }
    let dmg = this.rTurn.int(arch.damage[0], arch.damage[1]) + (skill >> 1);
    if (disarmed) dmg = Math.max(1, dmg >> 1);
    const kind: 'blunt' | 'blade' = arch.skill >= 3 && !disarmed ? 'blade' : 'blunt';
    this.damagePlayer(dmg, `${name} ${kind === 'blade' ? 'cuts' : 'clubs'} you`, kind);
    if (arch.mugger && this.pc.money > 0 && this.rTurn.chance(0.3)) {
      const steal = Math.min(this.pc.money, this.rTurn.int(10, 60));
      this.pc.money -= steal;
      this.aState[i] = ST_FLEE;
      this.say(`${name} relieves you of $${steal} and loses all interest in your wellbeing.`, MSG_BAD);
    }
  }

  private dieQuietly(i: number): void {
    const x = this.aX[i], y = this.aY[i];
    const visible = this.visible[this.map.idx(x, y)] === 1;
    const name = this.npcName(i);
    const arch = this.archOf(i);
    this.removeActor(i);
    const ti = this.map.idx(x, y);
    const pile = this.map.items.get(ti) ?? [];
    pile.push({ id: 'corpse', qty: 1 });
    for (const [itemId, chance] of arch.loot) {
      if (this.rTurn.chance(chance)) pile.push({ id: itemId, qty: 1 });
    }
    this.map.items.set(ti, pile);
    if (visible) this.say(`${name} sits down against a wall and does not get up.`, MSG_BAD);
  }

  private actorsAct(): void {
    const r = this.rTurn;
    const px = this.px, py = this.py;
    for (let i = 0; i < this.aCount; i++) {
      if (!this.aAlive[i]) continue;
      const x = this.aX[i], y = this.aY[i];
      const dist = Math.abs(x - px) + Math.abs(y - py);
      const seen = this.visible[this.map.idx(x, y)] === 1;
      switch (this.aKind[i]) {
        case AK.NPC: {
          if (this.aBarkCd[i] > 0) this.aBarkCd[i]--;
          if (this.aStun[i] > 0) { this.aStun[i]--; break; }
          if ((this.aFlags[i] & AF_BLEED) && this.turn % 8 === 0) {
            this.aHp[i]--;
            if (this.aHp[i] <= 0) { this.dieQuietly(i); break; }
          }
          if ((this.aFlags[i] & AF_LIMP) && this.turn % 2 === 0) break;
          const arch = this.archOf(i);
          switch (this.aState[i]) {
            case ST_HOSTILE: {
              if (dist === 1) { this.npcAttack(i); break; }
              if (dist > 16 || (!seen && r.chance(0.04))) { this.aState[i] = ST_SCHEDULE; break; }
              this.stepToward(i, px, py);
              break;
            }
            case ST_FLEE:
            case ST_PANIC: {
              this.stepAway(i, px, py);
              if (dist > 12 && r.chance(0.12)) this.aState[i] = ST_SCHEDULE;
              break;
            }
            case ST_SCENE: {
              if (seen && dist <= 2 && this.aBarkCd[i] === 0 && r.chance(0.05)) {
                this.say(`${this.npcName(i)}: ${r.pick(arch.barks)}`, MSG_BARK);
                this.aBarkCd[i] = 90;
              }
              this.sceneLoiter(i);
              break;
            }
            case ST_BRAWL: {
              this.brawlAct(i);
              break;
            }
            default: {
              // Predators and the law open a conversation, not a swing (M6.3).
              if (this.mode === 'play' && !this.encounter && arch.mugger && dist <= 4 && seen
                  && r.chance((0.012 + (1 - this.daylight()) * 0.02) * (this.hasBoon('white_noise') ? 0.4 : 1))) {
                this.director.lastEncounter = this.turn;
                this.startMuggerEncounter(i);
                break;
              }
              if (this.mode === 'play' && !this.encounter && arch.law && this.heat >= 2 && seen && dist <= 6 && r.chance(0.1)) {
                this.director.lastEncounter = this.turn;
                this.startWatchmanEncounter(i);
                break;
              }
              if (seen && dist <= 2 && this.aBarkCd[i] === 0 && r.chance(0.05)) {
                this.say(`${this.npcName(i)}: ${this.grammar.expand(r.pick(this.barkPool(arch)), r)}`, MSG_BARK);
                this.aBarkCd[i] = 90;
              }
              const [tx, ty] = this.scheduleTarget(i);
              if (tx < 0) {
                if (r.chance(0.5)) {
                  const [dx, dy] = r.pick(DIRS);
                  if (this.canStep(x + dx, y + dy, PED_TILES)) this.moveActor(i, x + dx, y + dy);
                }
              } else {
                const d = Math.abs(x - tx) + Math.abs(y - ty);
                if (d <= 2) {
                  if (r.chance(0.2)) {
                    const [dx, dy] = r.pick(DIRS);
                    if (this.canStep(x + dx, y + dy) && Math.abs(x + dx - tx) + Math.abs(y + dy - ty) <= 2) {
                      this.moveActor(i, x + dx, y + dy);
                    }
                  }
                } else if (r.chance(0.8)) {
                  this.stepToward(i, tx, ty);
                }
              }
            }
          }
          break;
        }
        case AK.Ped: {
          if (this.aState[i] === ST_PANIC) {
            this.stepAway(i, px, py);
            if (r.chance(0.1)) this.aState[i] = ST_SCHEDULE;
            break;
          }
          if (this.aState[i] === ST_SCENE) {
            if (seen && dist <= 2 && r.chance(0.04)) this.say(r.pick(PED_BARKS), MSG_BARK);
            this.sceneLoiter(i);
            break;
          }
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
        default: {
          if (!r.chance(0.25)) break;
          const [dx, dy] = r.pick(DIRS);
          const nx = x + dx, ny = y + dy;
          if (Math.abs(nx - this.aHomeX[i]) + Math.abs(ny - this.aHomeY[i]) > 3) break;
          if (this.canStep(nx, ny) && this.map.t(nx, ny) === T.Floor) this.moveActor(i, nx, ny);
        }
      }
    }
    // Heat cools if you behave; certain congregations help you disappear.
    const cool = this.hasBoon('open_doors') ? 120 : 200;
    if (this.heat > 0 && this.turn % cool === 0) this.heat = Math.max(0, this.heat - 1);
  }

  private computeVision(): void {
    this.visible.fill(0);
    const m = this.map;
    const radius = Math.round(9 + 5 * this.daylight());
    computeFOV(
      this.px, this.py, radius,
      (x, y) => m.opaque(x, y),
      (x, y) => {
        if (!m.inBounds(x, y)) return;
        const i = m.idx(x, y);
        this.visible[i] = 1;
        m.explored[i] = 1;
      },
    );
  }

  // --- view compositing -----------------------------------------------------------------

  fillView(viewW: number, viewH: number, glyph: Uint16Array, fg: Uint32Array, bg: Uint32Array): void {
    this.pulseCells = [];
    if (this.mode === 'menu' && this.menu) {
      this.fillMenu(viewW, viewH, glyph, fg, bg);
      return;
    }
    if (this.mode === 'citymap') {
      this.fillCityMap(viewW, viewH, glyph, fg, bg);
      return;
    }
    const m = this.map;
    const camX = Math.max(0, Math.min(this.px - (viewW >> 1), m.w - viewW));
    const camY = Math.max(0, Math.min(this.py - (viewH >> 1), m.h - viewH));
    const blackout = this.turn < this.director.blackoutUntil;
    const a = blackout ? Math.min(0.18, this.daylight()) : this.daylight();
    const mr = Math.round(256 * (0.58 + 0.42 * a));
    const mg = Math.round(256 * (0.62 + 0.38 * a));
    const mb = Math.round(256 * (0.88 + 0.12 * a));
    const tint = (c: number) => {
      if (a >= 1) return c;
      const r2 = (((c >>> 16) & 255) * mr) >> 8;
      const g2 = (((c >>> 8) & 255) * mg) >> 8;
      const b2 = ((c & 255) * mb) >> 8;
      return (r2 << 16) | (g2 << 8) | b2;
    };
    for (let vy = 0; vy < viewH; vy++) {
      const my = camY + vy;
      const inY = my >= 0 && my < m.h;
      for (let vx = 0; vx < viewW; vx++) {
        const vi = vy * viewW + vx;
        const mx = camX + vx;
        if (!inY || mx < 0 || mx >= m.w) { glyph[vi] = 0; fg[vi] = 0; bg[vi] = 0; continue; }
        const i = my * m.w + mx;
        if (!m.explored[i]) { glyph[vi] = 0; fg[vi] = 0; bg[vi] = 0; }
        else if (this.visible[i]) {
          glyph[vi] = m.glyph[i]; fg[vi] = tint(m.fg[i]); bg[vi] = tint(m.bg[i]);
          const pile = this.map.items.get(i);
          if (pile?.length) {
            const def = ITEM_BY_ID.get(pile[pile.length - 1].id);
            if (def) {
              glyph[vi] = def.glyph.charCodeAt(0);
              fg[vi] = tint(parseInt(def.color.slice(1), 16));
              bg[vi] = blend(bg[vi], 0x2a3650, 0.55); // cool slab — loot reads at a glance
            }
          }
        } else { glyph[vi] = m.glyph[i]; fg[vi] = dimFg(m.fg[i]); bg[vi] = dimBg(m.bg[i]); }
      }
    }
    if (a < 0.7 && !blackout) {
      const warm = 1 - a;
      for (const li of m.lamps) {
        const lx = li % m.w, ly = (li / m.w) | 0;
        if (lx < camX - 2 || lx >= camX + viewW + 2 || ly < camY - 2 || ly >= camY + viewH + 2) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const x = lx + dx, y = ly + dy;
            const vx = x - camX, vy = y - camY;
            if (vx < 0 || vy < 0 || vx >= viewW || vy >= viewH) continue;
            if (!m.inBounds(x, y) || !this.visible[m.idx(x, y)]) continue;
            const fall = 1 - (Math.abs(dx) + Math.abs(dy)) * 0.22;
            if (fall <= 0) continue;
            const vi = vy * viewW + vx;
            bg[vi] = warmAdd(bg[vi], Math.round(26 * warm * fall), Math.round(16 * warm * fall));
            if (dx === 0 && dy === 0) fg[vi] = 0xffe9a0;
          }
        }
      }
    }
    for (let i = 0; i < this.aCount; i++) {
      if (!this.aAlive[i]) continue;
      const x = this.aX[i], y = this.aY[i];
      if (!this.visible[m.idx(x, y)]) continue;
      const vx = x - camX, vy = y - camY;
      if (vx < 0 || vy < 0 || vx >= viewW || vy >= viewH) continue;
      const vi = vy * viewW + vx;
      glyph[vi] = ACTOR_GLYPH[this.aKind[i]];
      const hostile = this.aKind[i] === AK.NPC && this.aState[i] === ST_HOSTILE;
      const giver = this.aKind[i] === AK.NPC && (this.aFlags[i] & AF_QUESTGIVER) !== 0 && this.quests.length < QUEST_CAP;
      fg[vi] = hostile ? 0xff5040 : giver ? 0xd8c850 : tint(this.aColor[i]);
      if (hostile) {
        bg[vi] = 0x200808;
        // Imminent danger breathes: pulse hostiles in arm's reach.
        if (Math.abs(x - this.px) + Math.abs(y - this.py) === 1) {
          this.pulseCells.push({ x: vx, y: vy, bg: 0x401010 });
        }
      }
    }
    if (this.mode === 'play' && this.pc) {
      // Quiet affordance tints (bg only — fillRect layer, atlas untouched):
      // warm = [e] works there, teal = somebody adjacent will talk.
      for (const it of this.interactablesNear()) {
        if (it.x === this.px && it.y === this.py) continue;
        const vx = it.x - camX, vy = it.y - camY;
        if (vx < 0 || vy < 0 || vx >= viewW || vy >= viewH) continue;
        if (!this.visible[m.idx(it.x, it.y)]) continue;
        const vi = vy * viewW + vx;
        bg[vi] = blend(bg[vi], 0x4a4420, 0.45);
      }
      for (const [dx, dy] of DIRS) {
        const nx = this.px + dx, ny = this.py + dy;
        if (!m.inBounds(nx, ny)) continue;
        const ai = this.occ[m.idx(nx, ny)];
        if (ai < 0 || !this.aAlive[ai]) continue;
        const talkable = (this.aKind[ai] === AK.NPC && this.aState[ai] !== ST_HOSTILE) || this.aKind[ai] === AK.Cat;
        if (!talkable) continue;
        const vx = nx - camX, vy = ny - camY;
        if (vx < 0 || vy < 0 || vx >= viewW || vy >= viewH) continue;
        const vi = vy * viewW + vx;
        bg[vi] = blend(bg[vi], 0x1e3a30, 0.5);
      }
    }
    if (this.mode === 'target' && this.targets.length) {
      const ti = this.targets[this.targetSel];
      const vx = this.aX[ti] - camX, vy = this.aY[ti] - camY;
      if (vx >= 0 && vy >= 0 && vx < viewW && vy < viewH) {
        const vi = vy * viewW + vx;
        bg[vi] = 0x803030;
        fg[vi] = 0xffffff;
      }
    }
    {
      const vx = this.px - camX, vy = this.py - camY;
      if (vx >= 0 && vy >= 0 && vx < viewW && vy < viewH) {
        const vi = vy * viewW + vx;
        glyph[vi] = 64;
        fg[vi] = 0xffffff;
      }
    }
    if (this.mode === 'look') {
      const vx = this.lookX - camX, vy = this.lookY - camY;
      if (vx >= 0 && vy >= 0 && vx < viewW && vy < viewH) {
        const vi = vy * viewW + vx;
        if (glyph[vi] === 0 || glyph[vi] === 32) glyph[vi] = 215;
        fg[vi] = 0x101010;
        bg[vi] = 0xc8b820;
      }
    }
  }

  private fillMenu(viewW: number, viewH: number, glyph: Uint16Array, fg: Uint32Array, bg: Uint32Array): void {
    glyph.fill(0);
    fg.fill(0);
    bg.fill(0x07090d);
    const m = this.menu!;
    const write = (x: number, y: number, text: string, color: number, bgc = 0) => {
      for (let k = 0; k < text.length && x + k < viewW; k++) {
        if (x + k < 0 || y < 0 || y >= viewH) continue;
        const vi = y * viewW + x + k;
        glyph[vi] = text.charCodeAt(k);
        fg[vi] = color;
        if (bgc) bg[vi] = bgc;
      }
    };
    const cx = Math.max(2, (viewW >> 1) - 34);
    let y = Math.max(1, (viewH >> 1) - Math.ceil(m.entries.length * 1.5) - 2);
    write(cx, y, m.title, 0x6fd4c0);
    y += 2;
    for (let i = 0; i < m.entries.length; i++) {
      const e = m.entries[i];
      const selected = i === m.sel;
      write(cx, y, `${selected ? '▶ ' : '  '}${e.label}`, selected ? 0xffe9a0 : e.fg ?? 0xb8b8b8, selected ? 0x1a1d24 : 0);
      y++;
      if (selected && e.sub) {
        for (const line of wrap(e.sub, 64)) {
          write(cx + 4, y, line, 0x76869a);
          y++;
        }
      }
    }
  }

  private fillCityMap(viewW: number, viewH: number, glyph: Uint16Array, fg: Uint32Array, bg: Uint32Array): void {
    const WATER_BG = 0x060d16;
    const VOID_BG = 0x04060a;
    glyph.fill(0);
    fg.fill(0);
    bg.fill(VOID_BG);
    const panelW = viewW >= 76 ? 30 : 0;
    const mapW = viewW - panelW;
    // Project the hand-tuned NYC silhouette (2:1 cell aspect baked into the
    // template) into the map area, centered, aspect preserved.
    const tw = CITYMAP.w, th = CITYMAP.h;
    const scale = Math.min((mapW - 2) / tw, (viewH - 2) / th, 1.3);
    const ox = Math.floor((mapW - tw * scale) / 2);
    const oy = Math.floor((viewH - th * scale) / 2);
    const CHAR_BOROUGH: Record<string, string> = { m: 'manhattan', b: 'brooklyn', q: 'queens', x: 'bronx', s: 'staten_island' };
    for (let vy = 0; vy < viewH; vy++) {
      for (let vx = 0; vx < mapW; vx++) {
        const tx = Math.floor((vx - ox) / scale), ty = Math.floor((vy - oy) / scale);
        if (tx < 0 || ty < 0 || tx >= tw || ty >= th) continue;
        const vi = vy * viewW + vx;
        const c = CITYMAP.rows[ty].charAt(tx);
        if (c === '~') {
          bg[vi] = WATER_BG;
          // Sparse wave texture: enough to read as water, cheap to blit.
          if ((tx * 7 + ty * 13) % 11 === 0) { glyph[vi] = '≈'.charCodeAt(0); fg[vi] = 0x16344a; }
        } else {
          const b = CHAR_BOROUGH[c];
          bg[vi] = b ? blend(VOID_BG, BOROUGH_COLOR[b], 0.13) : WATER_BG;
        }
      }
    }
    // pos space → view cells; one shared projection for hoods, lines, cursor.
    const place = (pos: [number, number]) => ({
      x: Math.min(mapW - 1, Math.max(0, ox + Math.round(pos[0] * scale))),
      y: Math.min(viewH - 1, Math.max(0, oy + Math.round((pos[1] / 2) * scale))),
    });
    const lineTo = (a: [number, number], b: [number, number], ch: string, color: number) => {
      const p0 = place(a), p1 = place(b);
      let x0 = p0.x, y0 = p0.y;
      const dx = Math.abs(p1.x - x0), dy = -Math.abs(p1.y - y0);
      const sx = x0 < p1.x ? 1 : -1, sy = y0 < p1.y ? 1 : -1;
      let err = dx + dy;
      for (let guard = 0; guard < 256; guard++) {
        const vi = y0 * viewW + x0;
        if (glyph[vi] === 0 || glyph[vi] === '≈'.charCodeAt(0)) { glyph[vi] = ch.charCodeAt(0); fg[vi] = color; }
        if (x0 === p1.x && y0 === p1.y) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    };
    const cur = this.seedById.get(this.hoodId)!;
    const curState = this.world.neighborhoods[this.hoodId];
    const sel = this.seedById.get(this.selectedHood)!;
    const selState = this.world.neighborhoods[this.selectedHood];
    // Where you could go from the selected hood — and how you'd get to it.
    for (const adjId of sel.adjacent) {
      const adj = this.seedById.get(adjId);
      if (adj) lineTo(sel.pos, adj.pos, '·', 0x2e4250);
    }
    const sharedLines = curState.subway.filter((l) => selState.subway.includes(l));
    if (sel.id !== cur.id && sharedLines.length) lineTo(cur.pos, sel.pos, '∙', 0x3a6ad0);
    // Neighborhood markers.
    for (const s of this.seeds) {
      const { x, y } = place(s.pos);
      const vi = y * viewW + x;
      const st = this.world.neighborhoods[s.id];
      glyph[vi] = st.flooded ? '≈'.charCodeAt(0) : '■'.charCodeAt(0);
      let color = st.flooded ? 0x3a7a9a : BOROUGH_COLOR[s.borough];
      if (st.stats.crime > 0.65 && !st.flooded) color = blend(color, 0xff3030, 0.4);
      const reachable = cur.adjacent.includes(s.id)
        || (s.id !== cur.id && curState.subway.some((l) => st.subway.includes(l)));
      fg[vi] = reachable ? blend(color, 0xffffff, 0.25) : blend(color, 0x000000, 0.25);
    }
    // You, and the cursor.
    const cv = place(cur.pos);
    glyph[cv.y * viewW + cv.x] = 64;
    fg[cv.y * viewW + cv.x] = 0xffffff;
    this.pulseCells.push({ x: cv.x, y: cv.y, bg: 0x2a3a55 });
    const sv = place(sel.pos);
    const svi = sv.y * viewW + sv.x;
    bg[svi] = 0xc8b820;
    fg[svi] = 0x101010;
    this.pulseCells.push({ x: sv.x, y: sv.y, bg: 0xc8b820 });
    const label = sel.name.toUpperCase();
    const lx = sv.x + 2 + label.length > mapW ? sv.x - label.length - 2 : sv.x + 2;
    if (lx >= 0) {
      for (let k = 0; k < label.length && lx + k < mapW; k++) {
        const vi = sv.y * viewW + lx + k;
        glyph[vi] = label.charCodeAt(k);
        fg[vi] = 0xd8c850;
      }
    }
    if (panelW > 0) this.fillCityPanel(viewW, viewH, mapW, glyph, fg, bg, sel, selState, cur, sharedLines);
  }

  private fillCityPanel(
    viewW: number, viewH: number, mapW: number,
    glyph: Uint16Array, fg: Uint32Array, bg: Uint32Array,
    sel: NeighborhoodSeed, selState: NeighborhoodState,
    cur: NeighborhoodSeed,
    sharedLines: string[],
  ): void {
    for (let y = 0; y < viewH; y++) {
      const bi = y * viewW + mapW;
      glyph[bi] = '│'.charCodeAt(0);
      fg[bi] = 0x2a3138;
      for (let x = mapW + 1; x < viewW; x++) bg[y * viewW + x] = 0x070a10;
    }
    const write = (x: number, y: number, text: string, color: number) => {
      if (y < 0 || y >= viewH) return;
      for (let k = 0; k < text.length && x + k < viewW; k++) {
        const vi = y * viewW + x + k;
        glyph[vi] = text.charCodeAt(k);
        fg[vi] = color;
      }
    };
    const px = mapW + 2;
    const bar = (v: number) => '▓'.repeat(Math.max(0, Math.min(6, Math.round(v * 6)))).padEnd(6, '░');
    let y = 1;
    write(px, y++, sel.name.toUpperCase(), 0xd8c850);
    write(px, y++, BOROUGH_LABEL[sel.borough], BOROUGH_COLOR[sel.borough]);
    y++;
    write(px, y++, `~${Math.max(1, Math.round(selState.population / 1000))}k souls`, 0x8a9ab0);
    write(px, y++, `crime  ${bar(selState.stats.crime)}`, selState.stats.crime > 0.6 ? 0xc05a50 : 0x76869a);
    write(px, y++, `money  ${bar(selState.stats.prosperity)}`, 0x76869a);
    write(px, y++, `infra  ${bar(selState.stats.infrastructure)}`, 0x76869a);
    write(px, y++, `faith  ${bar(selState.stats.faith)}`, 0x76869a);
    y++;
    const topControl = Object.entries(selState.control).sort((a, b) => b[1] - a[1])[0];
    if (topControl && topControl[1] > 0.15) {
      const f = FACTIONS.find((p) => p.id === topControl[0]);
      if (f) write(px, y++, `turf: ${f.name}`, 0xc08050);
    }
    const topFaith = Object.entries(selState.faiths).sort((a, b) => b[1] - a[1])[0];
    if (topFaith && topFaith[1] > 0.1) {
      const r = RELIGIONS.find((p) => p.id === topFaith[0]);
      if (r) write(px, y++, `creed: ${r.name}`, 0x9a8ac0);
    }
    write(px, y++, selState.subway.length ? `lines: ${selState.subway.join(' ')}` : 'no service', selState.subway.length ? 0x3a6ad0 : 0x5a6a78);
    if (selState.flooded) write(px, y++, `flooded since '${String((selState.floodedYear ?? 2036) % 100)}`, 0x3a7a9a);
    y++;
    if (sel.id === cur.id) {
      write(px, y++, 'you are here', 0xffffff);
    } else if (cur.adjacent.includes(sel.id)) {
      write(px, y++, 'adjacent — [e] walk ~30min', 0x9aa8d0);
    } else if (sharedLines.length) {
      const minutes = Math.round(12 + Math.hypot(sel.pos[0] - cur.pos[0], sel.pos[1] - cur.pos[1]) * 1.2);
      write(px, y++, `${sharedLines.join('/')} train — [e] ~${minutes}min`, 0x9aa8d0);
    } else {
      write(px, y++, 'no route from here', 0xc08050);
    }
    // Legend.
    let ly = viewH - 9;
    for (const [b, label] of Object.entries(BOROUGH_LABEL)) {
      write(px, ly, '■', BOROUGH_COLOR[b]);
      write(px + 2, ly++, label, 0x5a6a78);
    }
    write(px, ly, '≈', 0x3a7a9a);
    write(px + 2, ly++, 'flooded out', 0x5a6a78);
    write(px, ly, '@', 0xffffff);
    write(px + 2, ly++, 'you', 0x5a6a78);
    write(px, ly, '·', 0x2e4250);
    write(px + 2, ly++, 'connections', 0x5a6a78);
  }

  // --- persistence (PRD §7: world geometry regenerates from seed; only diffs) ---

  serialize(): SaveData {
    const maps: SaveData['maps'] = {};
    for (const [id, cached] of this.hoodCache) {
      const m = cached.gen.map;
      const doors: number[] = [];
      for (let i = 0; i < m.terrain.length; i++) if (m.terrain[i] === T.DoorOpen) doors.push(i);
      maps[id] = {
        explored: b64encode(m.explored),
        items: [...m.items.entries()],
        doors,
      };
    }
    const hoods: SaveData['hoods'] = {};
    for (const [id, n] of Object.entries(this.world.neighborhoods)) {
      hoods[id] = {
        stats: n.stats, population: n.population, flooded: n.flooded,
        subway: n.subway, faiths: n.faiths, control: n.control,
      };
    }
    return {
      version: 2,
      seed: this.seed,
      turn: this.turn, clockMin: this.clockMin, hoodId: this.hoodId, px: this.px, py: this.py,
      pc: { ...this.pc },
      hoods,
      chronicle: this.world.chronicle,
      graves: this.world.graves,
      faith: this.faith, favor: this.favor, quests: this.quests, questSerial: this.questSerial,
      standing: this.standing, bets: this.bets,
      heat: this.heat, heatByBorough: this.heatByBorough,
      lastDay: this.lastDay, lastT2: this.lastT2, lastRitual: this.lastRitual,
      lastPulse: this.lastPulse, lastEditionBand: this.lastEditionBand,
      pendingHeadlines: this.pendingHeadlines,
      director: { lastBeat: this.director.lastBeat, lastEncounter: this.director.lastEncounter },
      searched: Object.fromEntries([...this.searched].map(([k, v]) => [k, [...v]])),
      city: this.city.dump(),
      maps,
    };
  }

  saveMeta(): { charName: string; networth: number; alive: boolean; turn: number } {
    return {
      charName: this.pc?.name ?? '',
      networth: this.pc?.netWorth() ?? 0,
      alive: !!this.pc && this.pc.hp > 0,
      turn: this.turn,
    };
  }

  static restore(data: SaveData, seeds: NeighborhoodSeed[], onProgress?: (text: string) => void): Game {
    const g = new Game(data.seed, seeds, onProgress);
    onProgress?.('Remembering where you left off…');
    g.applySave(data);
    return g;
  }

  private pendingMapDiffs: SaveData['maps'] | null = null;

  private applySave(d: SaveData): void {
    this.city = new CitySim(this.seed, this.world, this.seeds);
    this.city.load(d.city);
    for (const [id, ns] of Object.entries(d.hoods)) {
      const n = this.world.neighborhoods[id];
      if (n) Object.assign(n, ns);
    }
    this.world.chronicle = d.chronicle;
    this.world.graves = d.graves;
    this.pc = Object.assign(Object.create(PlayerChar.prototype) as PlayerChar, d.pc);
    this.turn = d.turn;
    this.clockMin = d.clockMin;
    this.faith = d.faith;
    this.favor = d.favor ?? {};
    this.quests = d.quests ?? (d.quest ? [{
      id: 'legacy:0',
      kind: d.quest.kind as QuestKind,
      desc: d.quest.kind === 'deliver'
        ? `Get the package to a counter in ${this.seedById.get(d.quest.targetHood ?? '')?.name ?? 'the next neighborhood over'}.`
        : `Bring ${d.quest.giver} a ${ITEM_BY_ID.get(d.quest.itemId)?.name ?? d.quest.itemId}.`,
      itemId: d.quest.itemId, qty: 1, targetHood: d.quest.targetHood,
      reward: d.quest.reward, giver: d.quest.giver,
    }] : []);
    this.questSerial = d.questSerial ?? this.quests.length;
    this.standing = d.standing ?? {};
    this.bets = d.bets ?? [];
    this.heat = d.heat;
    this.heatByBorough = d.heatByBorough ?? {};
    this.lastDay = d.lastDay;
    this.lastT2 = d.lastT2;
    this.lastRitual = d.lastRitual;
    this.lastPulse = d.lastPulse ?? d.turn; // v1 saves: start the cadence fresh
    this.lastEditionBand = d.lastEditionBand ?? -1;
    this.pendingHeadlines = d.pendingHeadlines ?? [];
    this.director.lastBeat = d.director?.lastBeat ?? d.turn;
    this.director.lastEncounter = d.director?.lastEncounter ?? d.turn;
    this.searched = new Map(Object.entries(d.searched ?? {}).map(([k, v]) => [k, new Set(v)]));
    this.pendingMapDiffs = d.maps;
    this.menu = null;
    this.mode = 'play';
    this.enterHood(d.hoodId, 'spawn');
    this.px = d.px;
    this.py = d.py;
    this.computeVision();
    this.say('You pick the night back up where it left you.', MSG_SYSTEM);
  }

  /** Re-apply saved per-map diffs after a map regenerates. */
  private applyMapDiff(id: string, m: GameMap): void {
    const diff = this.pendingMapDiffs?.[id];
    if (!diff) return;
    delete this.pendingMapDiffs![id];
    const explored = b64decode(diff.explored);
    if (explored.length === m.explored.length) m.explored.set(explored);
    m.items = new Map(diff.items);
    for (const i of diff.doors) {
      if (m.terrain[i] === T.DoorClosed || m.terrain[i] === T.DoorLocked) m.openDoor(i % m.w, Math.floor(i / m.w));
    }
  }

  meta(turnMs: number): FrameMeta {
    const msgs = this.msgs;
    this.msgs = [];
    const totalMin = Math.floor(this.clockMin);
    const day = Math.floor(totalMin / (24 * 60));
    const mins = totalMin % (24 * 60);
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    const MONTHS = [['Oct', 31], ['Nov', 30], ['Dec', 31], ['Jan', 31], ['Feb', 28], ['Mar', 31]] as const;
    let d = day, mi = 0;
    while (mi < MONTHS.length - 1 && d >= MONTHS[mi][1]) { d -= MONTHS[mi][1]; mi++; }
    const booted = !!this.pc;
    return {
      turn: this.turn,
      clock: `${MONTHS[mi][0]} ${d + 1} · ${hh}:${mm}`,
      money: booted ? this.pc.money : 0,
      hp: booted ? this.pc.hp : 0,
      maxHp: booted ? this.pc.maxHp : 1,
      worth: booted ? this.pc.netWorth() : 0,
      loc: this.mode === 'citymap'
        ? 'FIVE BOROUGHS — 2036'
        : booted
          ? `${this.hoodName()} — ${this.map.nearestIntersection(this.px, this.py)}`
          : 'NEW YORK CITY — 2036',
      mode: this.mode,
      lookText: this.lookText,
      turnMs,
      msgs,
      seed: this.seed,
      hints: this.contextHints(),
      pulse: this.pulseCells,
    };
  }
}

function hungerWord(h: number): string {
  if (h < 25) return 'fed';
  if (h < 50) return 'peckish';
  if (h < 70) return 'hungry';
  if (h < 90) return 'very hungry';
  return 'starving';
}

function wrap(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

function dimFg(c: number): number {
  const r = (c >>> 16) & 255, g = (c >>> 8) & 255, b = c & 255;
  return (((r * 70) >> 8) << 16) | (((g * 74) >> 8) << 8) | Math.min(255, ((b * 96) >> 8) + 10);
}

function dimBg(c: number): number {
  const r = (c >>> 16) & 255, g = (c >>> 8) & 255, b = c & 255;
  return (((r * 100) >> 8) << 16) | (((g * 104) >> 8) << 8) | Math.min(255, ((b * 128) >> 8) + 5);
}

function warmAdd(c: number, dr: number, dg: number): number {
  const r = Math.min(255, ((c >>> 16) & 255) + dr);
  const g = Math.min(255, ((c >>> 8) & 255) + dg);
  return (r << 16) | (g << 8) | (c & 255);
}

function blend(a: number, b: number, t: number): number {
  const r = Math.round(((a >>> 16) & 255) * (1 - t) + ((b >>> 16) & 255) * t);
  const g = Math.round(((a >>> 8) & 255) * (1 - t) + ((b >>> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | bl;
}
