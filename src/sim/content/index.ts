// Content pack registry. JSON packs under /content are bundled at build time
// and typed against types.ts. (PRD: "hot-loaded at worldgen".)

import eventsJson from '../../../content/events.json';
import religionsJson from '../../../content/religions.json';
import factionsJson from '../../../content/factions.json';
import leaguesJson from '../../../content/leagues.json';
import grammarsJson from '../../../content/grammars.json';
import namesJson from '../../../content/names.json';
import type {
  EventTemplate, FactionPack, LeaguePack, ReligionPack,
} from './types';
import type { GrammarRules } from './grammar';

export const EVENTS = eventsJson.events as unknown as EventTemplate[];
export const RELIGIONS = religionsJson.religions as unknown as ReligionPack[];
export const FACTIONS = factionsJson.factions as unknown as FactionPack[];
export const LEAGUES = leaguesJson.leagues as unknown as LeaguePack[];
export const GRAMMAR_RULES = grammarsJson as GrammarRules;
export const NAMES = namesJson as { first: string[]; last: string[]; epithet: string[] };
