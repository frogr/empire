// The Decade: simulates 2026→2036 once per world (PRD §4.2). Pure function of
// (seed, neighborhood seeds, content packs). Emits the chronicle, founded
// faiths/factions/leagues, notable NPCs, residue directives, and 2036 stats.

import { Rand } from '../rng';
import { Grammar, sentence } from '../content/grammar';
import { EVENTS, FACTIONS, GRAMMAR_RULES, LEAGUES, NAMES, RELIGIONS } from '../content';
import type {
  EventTemplate, NeighborhoodSeed, NeighborhoodState, StatKey, WorldState,
} from '../content/types';

const SCOPE_SCALE = { neighborhood: 1.0, borough: 0.6, citywide: 0.45 } as const;

const BOROUGH_NAMES: Record<string, string> = {
  manhattan: 'Manhattan', brooklyn: 'Brooklyn', queens: 'Queens',
  bronx: 'the Bronx', staten_island: 'Staten Island',
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function simulateHistory(
  seed: string,
  seeds: NeighborhoodSeed[],
  onProgress?: (year: number) => void,
): WorldState {
  const r = new Rand(seed, 'history');
  const grammar = new Grammar(GRAMMAR_RULES);
  const byId = new Map(seeds.map((s) => [s.id, s]));

  const world: WorldState = {
    seed,
    year: 2036,
    neighborhoods: {},
    chronicle: [],
    religions: [],
    factions: [],
    leagues: LEAGUES.filter((l) => l.era === 'old').map((l) => ({
      packId: l.id,
      teams: Array.from({ length: l.team_count }, () => grammar.expand(l.team_grammar, r)),
    })),
    notables: [],
    tags: [],
  };

  for (const s of seeds) {
    world.neighborhoods[s.id] = {
      id: s.id,
      stats: {
        prosperity: s.stats_2026.prosperity,
        crime: s.stats_2026.crime,
        infrastructure: s.stats_2026.infrastructure,
        faith: s.stats_2026.faith,
        cult: 0.03,
      },
      population: s.stats_2026.population,
      flooded: false,
      subway: [...s.subway],
      residue: [],
      faiths: {},
      control: {},
    };
  }

  const fired = new Set<string>(); // ids of once-events that already happened
  const tagSet = new Set<string>();
  const foundedReligions = new Set<string>();
  const foundedFactions = new Set<string>();
  const foundedLeagues = new Set(world.leagues.map((l) => l.packId));

  const notableName = (): string => {
    let name = `${r.pick(NAMES.first)} ${r.pick(NAMES.last)}`;
    if (r.chance(0.25)) name += ` ${r.pick(NAMES.epithet)}`;
    return name;
  };

  const cityAvg = (key: StatKey): number => {
    let sum = 0;
    for (const id in world.neighborhoods) sum += world.neighborhoods[id].stats[key];
    return sum / seeds.length;
  };

  const meetsPre = (t: EventTemplate, year: number, target?: NeighborhoodSeed): boolean => {
    const p = t.preconditions;
    if (!p) return true;
    if (p.year_min && year < p.year_min) return false;
    if (p.year_max && year > p.year_max) return false;
    if (p.requires_tag && !p.requires_tag.every((tag) => tagSet.has(tag))) return false;
    if (p.forbids_tag && p.forbids_tag.some((tag) => tagSet.has(tag))) return false;
    if (t.scope === 'neighborhood') {
      if (!target) return false;
      if (p.coastal !== undefined && !!target.coastal !== p.coastal) return false;
      if (p.area_type && !p.area_type.includes(target.area_type)) return false;
      if (p.stat) {
        const st = world.neighborhoods[target.id].stats;
        for (const [k, bound] of Object.entries(p.stat)) {
          const v = st[k as StatKey];
          if (bound.lt !== undefined && !(v < bound.lt)) return false;
          if (bound.gt !== undefined && !(v > bound.gt)) return false;
        }
      }
    } else if (p.stat) {
      for (const [k, bound] of Object.entries(p.stat)) {
        const v = cityAvg(k as StatKey);
        if (bound.lt !== undefined && !(v < bound.lt)) return false;
        if (bound.gt !== undefined && !(v > bound.gt)) return false;
      }
    }
    return true;
  };

  const applyStats = (n: NeighborhoodState, deltas: Partial<Record<StatKey, number>>, scale: number) => {
    for (const [k, d] of Object.entries(deltas)) {
      n.stats[k as StatKey] = clamp01(n.stats[k as StatKey] + d * scale);
    }
  };

  const foundOrg = (
    kind: 'religion' | 'faction',
    event: EventTemplate,
    home: NeighborhoodSeed,
    year: number,
  ): void => {
    const tags = event.tags ?? [];
    if (kind === 'religion') {
      const candidates = RELIGIONS.filter(
        (p) => !foundedReligions.has(p.id) && p.founded_by_event_tags.some((t) => tags.includes(t)),
      );
      if (!candidates.length) return;
      const pack = r.pick(candidates);
      foundedReligions.add(pack.id);
      const founder = notableName();
      world.religions.push({ packId: pack.id, founded: year, home: home.id, founder });
      world.notables.push({ name: founder, role: 'prophet', org: pack.id, home: home.id, alive: r.chance(0.7) });
      const ns = world.neighborhoods[home.id];
      ns.faiths[pack.id] = 0.35;
      for (const adj of home.adjacent) {
        const an = world.neighborhoods[adj];
        if (an) an.faiths[pack.id] = Math.max(an.faiths[pack.id] ?? 0, 0.12);
      }
      world.chronicle.push({
        year,
        text: `${pack.name} was founded in ${byId.get(home.id)?.name ?? home.id} by ${founder}. ${sentence(pack.doctrine)}`,
        tags: ['founding', 'religion'],
        neighborhoods: [home.id],
      });
    } else {
      const candidates = FACTIONS.filter(
        (p) => !foundedFactions.has(p.id) && p.founded_by_event_tags.some((t) => tags.includes(t)),
      );
      if (!candidates.length) return;
      const pack = r.pick(candidates);
      foundedFactions.add(pack.id);
      const founder = notableName();
      world.factions.push({ packId: pack.id, founded: year, home: home.id, founder });
      world.notables.push({ name: founder, role: 'boss', org: pack.id, home: home.id, alive: r.chance(0.75) });
      const ns = world.neighborhoods[home.id];
      ns.control[pack.id] = 0.4;
      for (const adj of home.adjacent) {
        const an = world.neighborhoods[adj];
        if (an && byId.get(adj) && pack.home_boroughs.includes(byId.get(adj)!.borough)) {
          an.control[pack.id] = Math.max(an.control[pack.id] ?? 0, 0.15);
        }
      }
      world.chronicle.push({
        year,
        text: `${pack.name} rose out of ${byId.get(home.id)?.name ?? home.id} under ${founder}. ${sentence(pack.ideology)}`,
        tags: ['founding', 'faction'],
        neighborhoods: [home.id],
      });
    }
  };

  const applyEvent = (t: EventTemplate, year: number, target?: NeighborhoodSeed): void => {
    if (t.once) fired.add(t.id);
    for (const tag of t.tags ?? []) tagSet.add(tag);

    // Which neighborhoods feel it.
    let affected: NeighborhoodSeed[];
    let borough = target?.borough ?? r.pick(seeds).borough;
    if (t.scope === 'neighborhood' && target) affected = [target];
    else if (t.scope === 'borough') affected = seeds.filter((s) => s.borough === borough);
    else affected = seeds;
    const scale = SCOPE_SCALE[t.scope];

    const fx = t.effects;
    if (fx) {
      for (const s of affected) {
        const n = world.neighborhoods[s.id];
        if (fx.stats) applyStats(n, fx.stats, scale);
        if (fx.population) n.population = Math.max(500, Math.round(n.population * (1 + fx.population * scale)));
        if (fx.kill_subway && t.scope === 'neighborhood') {
          n.subway = n.subway.filter(() => !r.chance(fx.kill_subway!));
        }
        if (fx.flood && s.coastal && t.scope === 'neighborhood') {
          n.flooded = true;
          n.floodedYear = year;
        }
      }
      if (fx.spread && target && fx.stats) {
        for (const adj of target.adjacent) {
          const an = world.neighborhoods[adj];
          if (an) applyStats(an, fx.stats, scale * fx.spread);
        }
      }
      if (fx.found) {
        const home = target ?? r.pick(affected);
        for (const f of fx.found) {
          if (r.chance(f.chance)) foundOrg(f.kind, t, home, year);
        }
      }
    }

    // New leagues found by tags.
    for (const lp of LEAGUES) {
      if (foundedLeagues.has(lp.id)) continue;
      if ((lp.founded_by_event_tags ?? []).some((tag) => tagSet.has(tag))) {
        foundedLeagues.add(lp.id);
        world.leagues.push({
          packId: lp.id,
          teams: Array.from({ length: lp.team_count }, () => grammar.expand(lp.team_grammar, r)),
        });
      }
    }

    // Residue stamps onto affected neighborhoods (text expanded now, stable forever).
    if (t.residue) {
      const stampTargets = t.scope === 'neighborhood' && target ? [target] : affected.filter(() => r.chance(0.3));
      for (const s of stampTargets) {
        for (const rd of t.residue) {
          world.neighborhoods[s.id].residue.push({
            type: rd.type,
            density: rd.density ?? 'low',
            year,
            text: rd.grammar
              ? grammar.expand(rd.grammar, r, { year, neighborhood: s.name })
              : undefined,
          });
        }
      }
    }

    // Chronicle entry.
    const ctx = {
      year,
      yy: String(year % 100).padStart(2, '0'),
      neighborhood: target?.name ?? r.pick(affected).name,
      borough: BOROUGH_NAMES[borough],
    };
    world.chronicle.push({
      year,
      text: grammar.expand(t.chronicle, r, ctx),
      tags: t.tags ?? [],
      neighborhoods: t.scope === 'citywide' ? [] : affected.map((s) => s.id),
    });
  };

  // --- the decade ------------------------------------------------------------
  for (let year = 2026; year <= 2036; year++) {
    onProgress?.(year);
    const eventCount = r.int(3, 8);
    const firedThisYear = new Set<string>();
    for (let e = 0; e < eventCount; e++) {
      // Build candidate (template, target) pairs.
      const candidates: { t: EventTemplate; target?: NeighborhoodSeed; w: number }[] = [];
      for (const t of EVENTS) {
        if (!t.phase.includes('history')) continue;
        if (t.once && fired.has(t.id)) continue;
        if (firedThisYear.has(t.id)) continue;
        if (t.scope === 'neighborhood') {
          // Sample a handful of possible targets rather than scanning all 150.
          for (let k = 0; k < 10; k++) {
            const target = r.pick(seeds);
            if (meetsPre(t, year, target)) {
              candidates.push({ t, target, w: t.weight });
              break;
            }
          }
        } else if (meetsPre(t, year)) {
          candidates.push({ t, w: t.weight });
        }
      }
      if (!candidates.length) continue;
      let total = 0;
      for (const c of candidates) total += c.w;
      let roll = r.float() * total;
      let chosen = candidates[0];
      for (const c of candidates) {
        roll -= c.w;
        if (roll <= 0) { chosen = c; break; }
      }
      firedThisYear.add(chosen.t.id);
      applyEvent(chosen.t, year, chosen.target);
    }

    // Yearly drift: poverty breeds crime, prosperity rebuilds, cults seep along adjacency.
    for (const s of seeds) {
      const n = world.neighborhoods[s.id];
      n.stats.crime = clamp01(n.stats.crime + (0.45 - n.stats.prosperity) * 0.02 + (r.float() - 0.5) * 0.02);
      n.stats.infrastructure = clamp01(n.stats.infrastructure + (n.stats.prosperity - 0.55) * 0.015);
      n.stats.prosperity = clamp01(n.stats.prosperity + (r.float() - 0.5) * 0.03);
      let adjCult = 0;
      for (const a of s.adjacent) adjCult += world.neighborhoods[a]?.stats.cult ?? 0;
      adjCult /= Math.max(1, s.adjacent.length);
      n.stats.cult = clamp01(n.stats.cult + (adjCult - n.stats.cult) * 0.15);
    }
  }

  world.tags = [...tagSet];
  return world;
}
