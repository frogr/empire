// Content pack + world state types (PRD §6). JSON packs under /content/ are
// typed against these; schemas freeze at the end of M1.

export type Borough = 'manhattan' | 'brooklyn' | 'queens' | 'bronx' | 'staten_island';

export type AreaType =
  | 'grid_dense' | 'rowhouse' | 'industrial' | 'projects'
  | 'parkland' | 'waterfront' | 'civic' | 'suburban';

/** Tier 3 neighborhood stats, all 0..1 except population. */
export type StatKey = 'prosperity' | 'crime' | 'infrastructure' | 'faith' | 'cult';

export interface Landmark {
  id: string;
  name: string;
  kind: string;
}

export interface NeighborhoodSeed {
  id: string;
  name: string;
  borough: Borough;
  area_type: AreaType;
  pos: [number, number]; // 0-100 city grid, for the city map screen
  adjacent: string[];
  subway: string[];
  coastal?: boolean;
  stats_2026: {
    population: number;
    prosperity: number;
    crime: number;
    infrastructure: number;
    faith: number;
  };
  landmarks?: Landmark[];
}

// --- event templates (history + live share one schema) ----------------------

export type ResidueKind =
  | 'graffiti' | 'shrine' | 'memorial' | 'burn' | 'flood' | 'barricade' | 'banner';

export interface ResidueDirective {
  type: ResidueKind;
  density?: 'low' | 'med' | 'high';
  grammar?: string; // expanded at stamp time, e.g. '#blackout_graffiti#'
}

export interface EventTemplate {
  id: string;
  scope: 'citywide' | 'borough' | 'neighborhood';
  phase: ('history' | 'live')[];
  weight: number;
  /** tags this event emits into world state; founding rules match on these */
  tags?: string[];
  /** if true, can fire at most once per world */
  once?: boolean;
  preconditions?: {
    year_min?: number;
    year_max?: number;
    coastal?: boolean; // target neighborhood must be coastal
    area_type?: AreaType[];
    /** stat bounds on the target neighborhood (citywide: on the city average) */
    stat?: Partial<Record<StatKey, { lt?: number; gt?: number }>>;
    requires_tag?: string[]; // world tags that must already exist
    forbids_tag?: string[];
  };
  effects?: {
    /** stat deltas applied to affected neighborhoods, clamped to 0..1 */
    stats?: Partial<Record<StatKey, number>>;
    /** fraction of the stat deltas that bleeds into adjacent neighborhoods */
    spread?: number;
    /** population delta as a fraction (e.g. -0.05 = 5% leave) */
    population?: number;
    /** chance per surviving subway line through the target that it dies */
    kill_subway?: number;
    /** permanently floods the target (coastal only) */
    flood?: boolean;
    found?: { kind: 'religion' | 'faction'; chance: number }[];
  };
  residue?: ResidueDirective[];
  chronicle: string; // grammar template; ctx: {year}, {neighborhood}, {borough}...
  news?: string;
}

// --- religions & factions ----------------------------------------------------

export interface ReligionPack {
  id: string;
  name: string;
  era: 'old' | 'new';
  /** new faiths found when a history event emits one of these tags */
  founded_by_event_tags: string[];
  doctrine: string;
  tenets: string[];
  clergy_titles: string[];
  glyph: string;
  color: string; // '#RRGGBB'
  holy_site: 'storefront' | 'rooftop' | 'park' | 'basement' | 'pier' | 'parish';
  ritual: { name: string; schedule: 'dawn' | 'noon' | 'dusk' | 'midnight'; text: string };
  greeting: string[];
  rumor: string[];
  boon: { id: string; name: string; desc: string };
  obligation: string;
}

export interface FactionPack {
  id: string;
  name: string;
  kind: 'syndicate' | 'militia' | 'cartel' | 'order' | 'authority' | 'crew';
  founded_by_event_tags: string[];
  ideology: string;
  rank_titles: string[];
  glyph: string;
  color: string;
  home_boroughs: Borough[];
  activities: string[];
  barks: string[];
  rumor: string[];
  /** relations bias vs other faction kinds / ids, -100..100 */
  relations_bias?: Record<string, number>;
}

export interface LeaguePack {
  id: string;
  name: string;
  sport: string;
  era: 'old' | 'new'; // old leagues exist from 2026; new ones found via event tags
  founded_by_event_tags?: string[];
  venue_kind: string; // landmark kind where games happen
  team_count: number;
  team_grammar: string; // expands to a team name
  season_games: number;
}

// --- items & origins ----------------------------------------------------------

export type ItemKind = 'weapon' | 'gun' | 'ammo' | 'armor' | 'food' | 'medical' | 'valuable' | 'junk';

export interface ItemDef {
  id: string;
  name: string;
  glyph: string;
  color: string;
  kind: ItemKind;
  damage?: [number, number];
  bleed?: number; // chance to inflict bleeding on hit
  stun?: number;
  armor?: number;
  agi?: number;
  heal?: number;
  stopBleed?: boolean;
  food?: number;
  stamina?: number;
  nerve?: number;
  qtyRange?: [number, number];
  value: number;
  desc: string;
}

export type SkillId =
  | 'melee' | 'firearms' | 'sneak' | 'streetwise' | 'tech'
  | 'theology' | 'athletics' | 'trade' | 'medicine';

export type StatId = 'STR' | 'AGI' | 'END' | 'WIT' | 'CHA' | 'NRV';

export interface OriginDef {
  id: string;
  name: string;
  blurb: string;
  stats: Record<StatId, number>;
  skills: Partial<Record<SkillId, number>>;
  money: [number, number];
  items: { id: string; qty: number }[];
  /** start neighborhood preference: an area type or 'cult' | 'crime' | 'poor' */
  start_pref: string;
}

// --- NPC archetypes -------------------------------------------------------------

export type ScheduleKind = 'worker' | 'stall' | 'roamer' | 'worship' | 'corner';

export interface ArchetypeDef {
  id: string;
  label: string;
  weight: number;
  hp: [number, number];
  damage: [number, number];
  skill: number; // 0..5 fighting competence
  aggression: number; // 0..10
  courage: number;
  greed: number;
  piety: number;
  schedule: ScheduleKind;
  loot: [string, number][]; // item id, drop chance
  barks: string[];
  mugger?: boolean;
  law?: boolean;
  service?: string;
}

// --- world state (output of the 2026→2036 history sim) -----------------------

export interface ResidueStamp {
  type: ResidueKind;
  text?: string;
  year: number;
  density: 'low' | 'med' | 'high';
}

export interface NeighborhoodState {
  id: string;
  stats: Record<StatKey, number>;
  population: number;
  flooded: boolean;
  floodedYear?: number;
  subway: string[]; // surviving lines in 2036
  residue: ResidueStamp[];
  /** religionId -> presence 0..1 */
  faiths: Record<string, number>;
  /** factionId -> control 0..1 */
  control: Record<string, number>;
}

export interface ChronicleEntry {
  year: number;
  text: string;
  tags: string[];
  neighborhoods: string[]; // ids, empty = citywide
}

export interface FoundedOrg {
  packId: string;
  founded: number; // year
  home: string; // neighborhood id
  founder: string; // notable NPC name
}

export interface Notable {
  name: string;
  role: string; // 'prophet' | 'boss' | 'founder' | 'champion'...
  org?: string; // religion/faction pack id
  home: string;
  alive: boolean;
}

export interface Grave {
  hood: string;
  x: number;
  y: number;
  name: string;
  origin: string;
  cause: string;
  day: number; // in-game day of death
  worth: number;
}

export interface WorldState {
  seed: string;
  year: number;
  neighborhoods: Record<string, NeighborhoodState>;
  chronicle: ChronicleEntry[];
  religions: FoundedOrg[];
  factions: FoundedOrg[];
  leagues: { packId: string; teams: string[] }[];
  notables: Notable[];
  tags: string[];
  /** dead player characters, in this world, in this session+save */
  graves: Grave[];
}
