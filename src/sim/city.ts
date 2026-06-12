// The living city: Tier 2 (loaded-neighborhood records, coarse tick every 100
// turns) and Tier 3 (citywide daily tick) from PRD §3.4. The player never sees
// these directly — they surface as rumors, news, stat drift, and what the
// street looks like when you arrive.

import { Rand } from './rng';
import { Grammar } from './content/grammar';
import { ARCHETYPES, EVENTS, FACTIONS, GRAMMAR_RULES, LEAGUES, NAMES, RELIGIONS } from './content';
import type { NeighborhoodSeed, StatKey, WorldState } from './content/types';

export interface Rumor {
  text: string;
  day: number;
  hood: string; // where it happened
  fg: number;
}

export interface LeagueGame {
  league: string;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  day: number;
}

export interface Bet {
  league: string;
  team: string;
  stake: number;
  odds: number; // payout multiplier
  day: number; // resolves on this day's games
}

// Tier 2: one record is an abstract resident of a loaded neighborhood.
interface T2Record {
  name: string;
  arch: number;
  state: 'home' | 'commuting' | 'working' | 'worship' | 'social' | 'hospital' | 'jail' | 'dead';
}

const T2_PER_HOOD = 36;

export class CitySim {
  private seed: string;
  private world: WorldState;
  private seeds: NeighborhoodSeed[];
  private byId: Map<string, NeighborhoodSeed>;
  private grammar: Grammar;
  private r: Rand;
  rumors: Rumor[] = [];
  fixtures: LeagueGame[] = [];
  standings = new Map<string, Map<string, { w: number; l: number }>>();
  private t2: Map<string, T2Record[]> = new Map();
  private firedLive = new Set<string>();

  constructor(seed: string, world: WorldState, seeds: NeighborhoodSeed[]) {
    this.seed = seed;
    this.world = world;
    this.seeds = seeds;
    this.byId = new Map(seeds.map((s) => [s.id, s]));
    this.grammar = new Grammar(GRAMMAR_RULES);
    this.r = new Rand(seed, 'city');
    for (const l of world.leagues) {
      const table = new Map<string, { w: number; l: number }>();
      for (const team of l.teams) table.set(team, { w: 0, l: 0 });
      this.standings.set(l.packId, table);
    }
  }

  private pushRumor(text: string, hood: string, day: number, fg = 0x9aa8d0): void {
    this.rumors.push({ text, day, hood, fg });
    if (this.rumors.length > 60) this.rumors.splice(0, this.rumors.length - 60);
  }

  /** Tier 2 records for a neighborhood, instantiated deterministically from
   *  seed + 2036 stats on first demand (PRD: promotion). */
  records(hoodId: string): T2Record[] {
    let recs = this.t2.get(hoodId);
    if (recs) return recs;
    const rr = new Rand(this.seed, `t2:${hoodId}`);
    const state = this.world.neighborhoods[hoodId];
    recs = [];
    for (let i = 0; i < T2_PER_HOOD; i++) {
      // Archetype mix skews with the stats, mirroring mapgen.
      let arch = rr.int(0, ARCHETYPES.length - 1);
      const a = ARCHETYPES[arch];
      if ((a.id === 'hustler' || a.id === 'enforcer') && !rr.chance(0.3 + state.stats.crime)) arch = 0;
      if (a.id === 'preacher' && !rr.chance(0.2 + state.stats.cult * 2)) arch = 0;
      recs.push({
        name: `${rr.pick(NAMES.first)} ${rr.pick(NAMES.last)}`,
        arch,
        state: 'home',
      });
    }
    this.t2.set(hoodId, recs);
    return recs;
  }

  /** Coarse tick over the player's neighborhood + adjacents. Budget < 2ms. */
  tier2Tick(currentHood: string, hour: number, day: number): void {
    const hood = this.byId.get(currentHood);
    if (!hood) return;
    const loaded = [currentHood, ...hood.adjacent];
    for (const id of loaded) {
      const st = this.world.neighborhoods[id];
      if (!st) continue;
      const recs = this.records(id);
      for (const rec of recs) {
        if (rec.state === 'dead') continue;
        // State machine by hour, with stat-weighted incidents.
        if (rec.state === 'hospital' && this.r.chance(0.2)) rec.state = 'home';
        else if (rec.state === 'jail' && this.r.chance(0.05)) rec.state = 'home';
        else if (hour >= 7 && hour < 9) rec.state = 'commuting';
        else if (hour >= 9 && hour < 17) rec.state = 'working';
        else if (hour >= 17 && hour < 19 && this.world.religions.some((f) => (st.faiths[f.packId] ?? 0) > 0.2) && this.r.chance(0.3)) rec.state = 'worship';
        else if (hour >= 17 && hour < 23) rec.state = 'social';
        else rec.state = 'home';
      }
      // Dice-resolved incidents, logged to the rumor pool.
      if (this.r.chance(st.stats.crime * 0.18)) {
        const victim = this.r.pick(recs);
        const name = this.byId.get(id)!.name;
        if (victim.state !== 'dead' && this.r.chance(0.12)) {
          victim.state = 'dead';
          st.population = Math.max(500, st.population - 1);
          this.pushRumor(`They found ${victim.name} under the scaffolding on #street# in ${name}. Nobody is asking questions out loud.`, id, day, 0xc05a50);
        } else if (this.r.chance(0.4)) {
          victim.state = 'hospital';
          this.pushRumor(`${victim.name} got jumped on #street# in ${name} ${hour < 6 ? 'before dawn' : 'in broad daylight'}. The clinic took them in.`, id, day);
        } else {
          this.pushRumor(`Somebody cleaned out a place on #street# in ${name}. Through the window, neat as a dentist.`, id, day);
        }
      }
      if (this.r.chance(st.stats.cult * 0.1)) {
        this.pushRumor(`A procession went down #street# in ${this.byId.get(id)!.name} at ${hour < 12 ? 'dawn' : 'dusk'}. Candles. Humming. The usual now.`, id, day, 0xb8a0d8);
      }
    }
  }

  /** Citywide daily tick: stat drift, live events, league fixtures. <30ms. */
  tier3Daily(day: number): { headlines: string[] } {
    const headlines: string[] = [];
    // Stat drift, gentler than the history sim's yearly version.
    for (const s of this.seeds) {
      const n = this.world.neighborhoods[s.id];
      n.stats.crime = clamp01(n.stats.crime + (0.45 - n.stats.prosperity) * 0.004 + (this.r.float() - 0.5) * 0.01);
      n.stats.prosperity = clamp01(n.stats.prosperity + (this.r.float() - 0.5) * 0.008);
      n.stats.infrastructure = clamp01(n.stats.infrastructure + (n.stats.prosperity - 0.55) * 0.003);
    }
    // Live events from the shared template pool.
    const liveCount = this.r.int(0, 2);
    for (let e = 0; e < liveCount; e++) {
      const candidates = EVENTS.filter((t) => t.phase.includes('live') && !(t.once && this.firedLive.has(t.id)));
      if (!candidates.length) break;
      const t = this.r.pick(candidates);
      const target = this.r.pick(this.seeds);
      if (t.preconditions?.coastal && !target.coastal) continue;
      this.firedLive.add(t.id);
      const n = this.world.neighborhoods[target.id];
      if (t.effects?.stats) {
        for (const [k, d] of Object.entries(t.effects.stats)) {
          n.stats[k as StatKey] = clamp01(n.stats[k as StatKey] + d * 0.5);
        }
      }
      const text = this.grammar.expand(t.news ?? t.chronicle, this.r, {
        year: 2036, neighborhood: target.name, borough: target.borough,
      });
      headlines.push(text);
      this.pushRumor(text, target.id, day, 0xc9b458);
    }
    // Leagues: every team plays roughly every other day.
    for (const l of this.world.leagues) {
      if (l.teams.length < 2 || !this.r.chance(0.6)) continue;
      const pack = LEAGUES.find((p) => p.id === l.packId)!;
      const shuffled = this.r.shuffle([...l.teams]);
      const home = shuffled[0], away = shuffled[1];
      const hs = this.r.int(pack.sport === 'basketball' ? 78 : 1, pack.sport === 'basketball' ? 124 : 9);
      const as_ = this.r.int(pack.sport === 'basketball' ? 78 : 1, pack.sport === 'basketball' ? 124 : 9);
      const game: LeagueGame = {
        league: l.packId, home, away,
        homeScore: hs === as_ ? hs + 1 : hs, awayScore: as_, day,
      };
      this.fixtures.push(game);
      if (this.fixtures.length > 40) this.fixtures.splice(0, this.fixtures.length - 40);
      const table = this.standings.get(l.packId)!;
      const winner = game.homeScore > game.awayScore ? home : away;
      const loser = winner === home ? away : home;
      table.get(winner)!.w++;
      table.get(loser)!.l++;
      this.pushRumor(`${pack.name}: ${home} ${game.homeScore}, ${away} ${game.awayScore}. ${winner} faithful are insufferable today.`, '', day, 0x70a0c0);
    }
    // Faction friction occasionally moves territory.
    if (this.world.factions.length >= 2 && this.r.chance(0.3)) {
      const s = this.r.pick(this.seeds);
      const n = this.world.neighborhoods[s.id];
      const ids = Object.keys(n.control);
      if (ids.length) {
        const f = this.r.pick(ids);
        n.control[f] = clamp01((n.control[f] ?? 0) + (this.r.float() - 0.45) * 0.1);
        const pack = FACTIONS.find((p) => p.id === f);
        if (pack && this.r.chance(0.3)) {
          this.pushRumor(`${pack.name} ${this.r.chance(0.5) ? 'put new marks up' : 'lost a corner'} in ${s.name}. ${this.grammar.expand(this.r.pick(pack.rumor), this.r, { neighborhood: s.name })}`, s.id, day, 0xc0a890);
        }
      }
    }
    // Faith presence creeps along adjacency.
    for (const f of this.world.religions) {
      const pack = RELIGIONS.find((p) => p.id === f.packId);
      if (!pack || !this.r.chance(0.25)) continue;
      const sources = this.seeds.filter((s) => (this.world.neighborhoods[s.id].faiths[f.packId] ?? 0) > 0.25);
      if (!sources.length) continue;
      const from = this.r.pick(sources);
      const toId = this.r.pick(from.adjacent);
      const to = this.world.neighborhoods[toId];
      if (to) {
        to.faiths[f.packId] = clamp01((to.faiths[f.packId] ?? 0) + 0.05);
        to.stats.cult = clamp01(to.stats.cult + 0.01);
      }
    }
    return { headlines };
  }

  standingsLines(): { text: string; fg: number }[] {
    const lines: { text: string; fg: number }[] = [];
    for (const l of this.world.leagues) {
      const pack = LEAGUES.find((p) => p.id === l.packId);
      if (!pack) continue;
      lines.push({ text: pack.name.toUpperCase(), fg: 0x6fd4c0 });
      const table = [...this.standings.get(l.packId)!.entries()]
        .sort((a, b) => b[1].w - a[1].w || a[1].l - b[1].l);
      for (const [team, rec] of table) {
        lines.push({ text: `  ${team.padEnd(28)} ${String(rec.w).padStart(2)}–${rec.l}`, fg: 0xa8a8b0 });
      }
      lines.push({ text: '', fg: 0 });
    }
    return lines;
  }

  /** Odds multiplier for betting on a team, from current form. */
  odds(league: string, team: string): number {
    const table = this.standings.get(league);
    if (!table) return 2;
    const rec = table.get(team);
    if (!rec) return 2;
    const games = rec.w + rec.l;
    const winRate = games > 0 ? rec.w / games : 0.5;
    return Math.max(1.2, Math.min(5, Math.round((1 / Math.max(0.15, winRate)) * 10) / 10));
  }

  expandRumor(text: string): string {
    return this.grammar.expand(text, this.r);
  }

  // --- persistence ------------------------------------------------------------

  dump(): unknown {
    return {
      rumors: this.rumors,
      fixtures: this.fixtures,
      standings: [...this.standings].map(([k, v]) => [k, [...v]]),
      firedLive: [...this.firedLive],
    };
  }

  load(d: unknown): void {
    const data = d as {
      rumors: Rumor[]; fixtures: LeagueGame[];
      standings: [string, [string, { w: number; l: number }][]][];
      firedLive: string[];
    };
    this.rumors = data.rumors ?? [];
    this.fixtures = data.fixtures ?? [];
    this.standings = new Map((data.standings ?? []).map(([k, v]) => [k, new Map(v)]));
    this.firedLive = new Set(data.firedLive ?? []);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
