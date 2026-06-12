// Expansion pack loader: every JSON file in /content/packs is merged into the
// base registries. Packs are self-contained — any grammar slots they reference
// must ship in their own "grammars" section (CI validates coverage).

import type {
  ArchetypeDef, EventTemplate, FactionPack, ItemDef, ReligionPack, StreetSceneDef,
} from './types';
import type { GrammarRules } from './grammar';

export interface ContentPack {
  events?: EventTemplate[];
  religions?: ReligionPack[];
  factions?: FactionPack[];
  items?: ItemDef[];
  archetypes?: ArchetypeDef[];
  scenes?: StreetSceneDef[];
  grammars?: GrammarRules;
}

const modules = import.meta.glob('../../../content/packs/*.json', { eager: true }) as Record<
  string,
  { default?: ContentPack } & ContentPack
>;

export function loadPacks(): ContentPack[] {
  return Object.values(modules).map((m) => (m.default ?? m) as ContentPack);
}
