// Content pack registry. JSON packs under /content are bundled at build time
// and typed against types.ts. (PRD: "hot-loaded at worldgen".)

import eventsJson from '../../../content/events.json';
import religionsJson from '../../../content/religions.json';
import factionsJson from '../../../content/factions.json';
import leaguesJson from '../../../content/leagues.json';
import grammarsJson from '../../../content/grammars.json';
import namesJson from '../../../content/names.json';
import itemsJson from '../../../content/items.json';
import originsJson from '../../../content/origins.json';
import archetypesJson from '../../../content/archetypes.json';
import citymapJson from '../../../content/citymap.json';
import type {
  ArchetypeDef, EventTemplate, FactionPack, ItemDef, LeaguePack, OriginDef, QuestTemplateDef, ReligionPack, StreetSceneDef,
} from './types';
import type { GrammarRules } from './grammar';

import { loadPacks } from './packs';

const packs = loadPacks();

function merged<T>(base: T[], pick: (p: ReturnType<typeof loadPacks>[number]) => T[] | undefined): T[] {
  const out = [...base];
  for (const p of packs) {
    const extra = pick(p);
    if (extra) out.push(...extra);
  }
  return out;
}

export const EVENTS = merged(eventsJson.events as unknown as EventTemplate[], (p) => p.events);
export const RELIGIONS = merged(religionsJson.religions as unknown as ReligionPack[], (p) => p.religions);
export const FACTIONS = merged(factionsJson.factions as unknown as FactionPack[], (p) => p.factions);
export const LEAGUES = leaguesJson.leagues as unknown as LeaguePack[];
export const GRAMMAR_RULES: GrammarRules = (() => {
  const rules: GrammarRules = { ...(grammarsJson as GrammarRules) };
  for (const p of packs) {
    if (!p.grammars) continue;
    for (const [k, v] of Object.entries(p.grammars)) {
      rules[k] = rules[k] ? rules[k].concat(v) : [...v];
    }
  }
  return rules;
})();
export const NAMES = namesJson as { first: string[]; last: string[]; epithet: string[] };
export const ITEMS = merged(itemsJson.items as unknown as ItemDef[], (p) => p.items);
export const ORIGINS = originsJson.origins as unknown as OriginDef[];
export const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));
export const ARCHETYPES = merged(archetypesJson.archetypes as unknown as ArchetypeDef[], (p) => p.archetypes);
// Street scenes and quest templates live entirely in packs; the base game ships none.
export const SCENES = merged([] as StreetSceneDef[], (p) => p.scenes);
export const QUEST_TEMPLATES = merged([] as QuestTemplateDef[], (p) => p.quests);
// The hand-tuned NYC silhouette behind the city map screen (scripts/gen_citymap.py).
// Chars: '~' water · 'm/b/q/x/s' = manhattan/brooklyn/queens/bronx/staten_island land.
export const CITYMAP = citymapJson as { w: number; h: number; rows: string[] };
