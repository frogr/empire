# EMPIRE://36 — A New York Roguelike
**Product Requirements Document — v0.1 (working title, rename freely)**

---

## 1. Vision

A top-down, glyph-rendered, turn-based roguelike set in New York City, 2036. A new mayor took office in January 2026; the game procedurally simulates the decade that followed — collapses, miracles, cults, leagues, wars between landlords and gods — and drops the player into the wreckage and weird vitality of what the city became. Tone: Blade Runner grime, Dwarf Fortress depth, ADOM lethality, Kenshi indifference, Torncity grind-and-hustle.

**Design pillars (every feature must serve at least one):**

1. **The city is alive without you.** Thousands of simulated residents with homes, jobs, families, faiths, and grudges. The world ticks whether or not the player is watching.
2. **No two decades are alike.** Worldgen simulates 2026→2036 history fresh per world seed. Lore is *discovered as residue* (graffiti, shrines, news clippings, NPC memories), never dumped.
3. **Lethal but maneuverable.** Death is always nearby and frequently hilarious, but a clever player can talk, bribe, sprint, hide, or pray their way out of almost anything.
4. **Reads like fiction.** Message log, chronicles, and dialogue are the primary "graphics." Writing quality is a feature.
5. **Performant or it doesn't ship.** 60fps render, sub-frame turn resolution, instant input. Always.
6. **Pure keyboard.** Every action reachable without a mouse.

**Explicitly out of scope for v1:** multiplayer, real-time anything, mouse-driven UI, runtime LLM calls, mobile, sprite art in the play field.

---

## 2. Locked Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Platform | Web (desktop browsers), deployed publicly | macOS-friendly, zero install, public from day one |
| Map | Real NYC neighborhood skeleton; procgen streets, blocks, interiors | Recognizable ("I died in Bushwick") + infinite variety |
| Run structure | Permadeath; world persists per account; dead PCs leave corpses, graves, legends, and unfinished business for successors | ADOM lethality + Kenshi continuity |
| Run length | 1–30 real hours; sessions resumable anytime (server-side saves) | Pick-up-and-play |
| Combat | Turn-based, bump-to-attack + verb keys, body-part-lite injuries | Simple keys, deep consequences |
| Score | Net worth (cash + assets). Leaderboard API stubbed, shipped later | Torncity DNA |
| Auth | Username + password only. Login == access to your saves. No OAuth, no email verification in v1 | Simplest possible |
| AI usage | Build-time content generation (agents author content packs). Runtime LLM hooks designed but disabled in v1 | Cost, latency, determinism |
| Real people | Real public figures appear only as dateline references in chronicle text ("in the second year of the new administration..."). Every actor with simulated behavior, dialogue, or invented deeds is fictional | Taste + liability |
| Real brands/teams | None. All teams, corporations, and franchises are fictional successors/parodies | IP safety |
| Real religions | Exist as grounded, respectfully-rendered backdrop (parishes, shuls, mosques, temples endure). Invented faiths carry the strange content | Tone + taste |

---

## 3. Technical Architecture

### 3.1 Stack

- **Client:** TypeScript, Vite, Canvas 2D (WebGL post-FX pass optional, M4+). No framework for the game surface; Preact or vanilla for menus/auth screens.
- **Simulation:** Runs in a **Web Worker**. Render thread only draws and captures input. State crosses the boundary via transferable `ArrayBuffer`s (no structured-clone of big objects, ever).
- **Server:** Node + **Hono**, **SQLite** (better-sqlite3). Single small box (Fly.io / Railway / home rig behind Tailscale Funnel — operator's choice).
- **Auth:** argon2id password hashing, opaque session tokens in httpOnly cookies, rate-limited login. That's it.
- **Saves:** versioned, gzipped JSON blobs, server-side, written on autosave (every N turns + on quit). Client keeps a localStorage fallback copy for offline resilience.

### 3.2 Renderer (non-negotiables)

- **Glyph atlas:** rasterize the chosen monospace font (+ extended glyphs) once to an offscreen canvas; the frame loop is pure `drawImage` blits from the atlas. Target grid ~100×40 visible cells; full-grid redraw at 60fps is trivial with an atlas (~4,000 blits/frame).
- Map state in **typed arrays**: `Uint16Array` glyph ids, `Uint32Array` fg/bg packed RGBA, per loaded chunk. No per-tile objects.
- Color is a first-class storytelling tool: faction colors, blood, neon signage, light/dark cycle tinting.
- Optional M4 polish: WebGL pass for CRT curvature, scanlines, bloom on neon glyphs. Off by default, `F10` toggle.

### 3.3 Performance budgets (hard targets)

| Thing | Budget |
|---|---|
| Render frame | < 4 ms |
| Player turn resolution (Tier 1 sim) | < 8 ms typical, < 16 ms worst |
| Tier 2 tick (amortized across turns) | < 2 ms per player turn |
| Tier 3 daily tick | < 30 ms, runs in worker during player idle |
| Worldgen incl. 10-year history sim | < 6 s with progress UI ("Simulating 2031…") |
| Save blob | < 2 MB gzipped |
| Memory | < 400 MB |

Entities use **structure-of-arrays** layouts in hot paths. Pathfinding: JPS or flow-fields per chunk with a per-turn node budget; NPCs that exceed budget defer movement one turn (reads as hesitation — free flavor).

### 3.4 Simulation LOD (the heart of the game)

- **Tier 1 — The Bubble** (≈ 96×96 tiles around the player): full per-turn simulation. Pathfinding, FOV, schedules, combat, dialogue, item interactions. Cap ~300 active agents; overflow demotes lowest-relevance agents.
- **Tier 2 — Loaded Neighborhoods** (player's neighborhood + neighbors): agents are records, not actors. Coarse tick every 100 turns (≈10 in-game minutes). State-machine transitions: at_home → commuting → working → worship → socializing → hospital/jail/dead. Crimes, encounters, deaths resolved by dice + stats, logged to the chronicle and rumor pool.
- **Tier 3 — The City**: per-neighborhood aggregates only: population, faction control %, crime rate, prosperity, cult penetration, rent index, infrastructure health, sports standings. Daily tick. Feeds the news/rumor system.
- **Promotion/demotion:** entering a neighborhood *instantiates* Tier 3 stats into concrete Tier 2 records (deterministic from seed + stats), and Tier 2 records within the bubble inflate to Tier 1 actors. Leaving compresses them back. A high-crime district literally spawns muggings around you; a cult-heavy one spawns processions.
- **Determinism:** one seeded PRNG (e.g., sfc32) per subsystem, all derived from the world seed. Same seed + same inputs ⇒ same world. Seeds are visible and shareable.

### 3.5 Time model

- 1 turn = 6 in-game seconds. ~600 turns = 1 hour. Day/night cycle changes lighting, NPC schedules, crime spawn tables, ritual timing.
- Waiting/resting fast-forwards turns with interrupt-on-event. Travel between neighborhoods offers fast-travel (subway, if your line still runs) consuming in-game hours and a random-encounter roll.

---

## 4. The World

### 4.1 Geography

- Macro layer: the five boroughs as a graph of ~150 named **neighborhoods** (curated real list with real adjacency, bridges, tunnels, subway lines — hand-authored data file `neighborhoods.json`).
- Each neighborhood lazily generates a **local map** from (world seed + neighborhood id + 2036 stats): street grid template per area type (Manhattan grid, Brooklyn brownstone blocks, industrial waterfront, projects, park), then lots, buildings, interiors. Landmarks (hand-listed per neighborhood: e.g., the Garden, a great park, a famous bridge — fictionalized names where trademarked) are guaranteed placements.
- History residue pass: worldgen chronicle events stamp physical evidence — burn scars, shrines, memorial walls, flooded blocks (the waterline of '31), checkpoint barricades, renamed streets.
- Verticality-lite: buildings have enterable floors as stacked sub-maps (stairs `<` `>`), rooftops for rituals, races, and escapes.

### 4.2 History simulation (worldgen)

Pipeline, run once per world in the worker:

1. **Seed 2026:** load `era_seed.json` — neighborhood baseline stats, founding institutions, the real-world anchor (a new mayor inaugurated Jan 2026, referenced only as dateline).
2. **Yearly loop 2026→2036:** draw 3–8 events from weighted `event_template` pools, gated by preconditions on city state. Each event: mutates neighborhood stats, may found/destroy factions, religions, leagues, institutions; emits a chronicle entry (template-grammar prose); queues physical residue directives.
3. **Faction & faith emergence:** origin rules (e.g., a blackout event can found a signal-worship church; a flood founds a millenarian sect and a levee authority; a housing war births tenant militias and landlord syndicates).
4. **Outputs:** `chronicle.json` (the readable history, browsable in-game via the Library / `J`ournal), faction/religion rosters with relations matrix, 2036 neighborhood stats, residue directives, notable-NPC roster (founders, prophets, bosses, champions — all fictional).

### 4.3 Institutions (the lived-in layer)

All data-driven, all simulated at Tier 2/3:

- **Families & homes:** Tier 2 NPCs belong to households; children attend schools; deaths create funerals (events the player can stumble into).
- **Schools, hospitals, jails, courts:** real locations with schedules. The hospital is where you (and NPCs) wake up after near-death — Torncity-style timer paid in turns and dollars. Jail likewise, with bail, sentence-serving, or escape.
- **Religions:** congregations meet on schedule at holy sites; processions, festivals, schisms. Old faiths grant community and sanctuary; new faiths grant strange boons and stranger obligations. Player can join one faith, gaining a favor track.
- **Sports:** fictional leagues, old and new — a basketball franchise at the Garden, borough drone-racing circuits, the Subway Parkour Cup, rooftop foot-race seasons, augmented boxing in Queens. Standings simulated at Tier 3; games are attendable events with betting; champions are notable NPCs.
- **Economy & crime:** shops with inventories and hours, jobs (legit and not), rent on safehouses, a black market per borough, fences, loan sharks with memorable collection policies. Heat (wanted level) per borough; police successor forces and private security factions respond on different rules.

---

## 5. Player Systems

### 5.1 Character

- Origins (procedural + template): e.g., laid-off doorman, defrocked priest of a new faith, drone-league washout, fresh arrival off the Dragon Express bus. Origin sets starting neighborhood, stats, contacts, debt.
- **Stats:** STR, AGI, END, WIT, CHA, NRV (nerve). **Skills** (use-trained, Kenshi-style): melee, firearms, sneak, streetwise, tech, theology, athletics, trade, medicine.
- **Needs (light-touch):** food, sleep, and **heat** (law attention). Hunger and exhaustion impose penalties before death; the game is lethal through *violence and misadventure*, not nutrition spreadsheets.
- **Money is score.** Net worth tracked continuously; on death, the run is recorded (for the future leaderboard API).

### 5.2 Death & legacy

Permadeath. On death: an obituary is generated, the corpse and stash persist in-world, the chronicle records the cause ("torn apart by hounds beneath the BQE while carrying $14,205 in counterfeit relics"). The next character spawns in the **same world**, can find the grave, loot the stash (if no one beat them to it), hear rumors about the deceased, and even meet NPCs who remember them. New world = new seed, any time.

### 5.3 Combat

- Turn-based. **Bump to attack.** `f` = ranged/targeted mode (tab targets, then choose body part: head/torso/arms/legs).
- Body-part-lite injuries: bleeding, concussion, dropped weapon, limp — statuses, not full DF tissue sim. Injuries persist and require treatment (street medic, hospital, faith healing of dubious reliability).
- Escape verbs are first-class: sprint (stamina), shove through crowds, vault (`v`), play dead, bribe mid-fight, dive into a subway entrance. The game rewards running away.
- Noise/light stealth model: actions emit noise radii; darkness and crowds conceal.

### 5.4 Keybindings (complete, v1)

```
WASD / arrows  move (bump = attack/interact)     i  inventory        m  city map
.  / space     wait one turn                     g  pick up          M  neighborhood map
e              interact / enter / use            t  talk             J  journal & chronicle
f              fire / throw / target             x  look/examine     c  character sheet
v              vault / climb                     r  rest/wait-until  N  news & rumors
< >            stairs                            q  quaff/consume    ?  help (full ref)
1-9            hotbar                            Esc  menu/cancel    F10  CRT shader
```
Every menu is list-based, navigated with WASD/arrows + e/Esc. No mouse required anywhere, including auth screens (tab/enter).

---

## 6. Content Pack System (WHERE THE AGENTS GO HAM)

All flavor and most game data live in JSON **content packs** under `/content/`, validated by JSON Schema (`/content/schemas/`), hot-loaded at worldgen. Agents author packs in parallel; the engine recombines them procedurally. **Every pack file must validate in CI.** Grammar strings use a tracery-style syntax: `#slot#` expands from `grammars/*.json`; `{npc.name}`, `{neighborhood}`, `{year}` interpolate sim state.

### 6.1 `religion.schema.json`
```json
{
  "id": "church_of_the_last_signal",
  "name": "Church of the Last Signal",
  "era": "new",
  "founded_by_event_tags": ["blackout", "comms_collapse"],
  "doctrine_summary": "God spoke once through the towers and went silent; the faithful keep antennas tuned for the second broadcast.",
  "tenets": ["Silence is holy bandwidth", "Repair is prayer", "Every dish points somewhere"],
  "clergy_titles": ["Receiver", "Antenna", "Static Deacon"],
  "ritual_templates": [
    {"name": "The Tuning", "location_type": "rooftop", "schedule": "weekly_dusk", "crowd": [8, 40],
     "observable_text": "#congregation# stand among dead satellite dishes, humming a carrier tone."}
  ],
  "holy_site_types": ["rooftop", "radio_shop", "transmission_tower"],
  "iconography": {"glyph": "ψ", "color": "#00FFD0",
    "sigil_prompt": "a stylized satellite dish haloed in static, flat single-color emblem on black"},
  "boons": [{"id": "white_noise", "effect": "stealth_bonus_near_electronics", "favor_cost": 3}],
  "obligations": ["tithe_salvaged_electronics_weekly"],
  "member_archetype_weights": {"technician": 3, "widow": 2, "ex_trader": 1},
  "greeting_grammar": ["#static_blessing#, stranger. Are you listening?"],
  "rumor_grammar": ["They say the Receivers heard something over {neighborhood} last #weekday#."]
}
```

### 6.2 `faction.schema.json`
```json
{
  "id": "verrazano_combine",
  "name": "The Verrazzano Combine",
  "kind": "syndicate",
  "founded_by_event_tags": ["port_collapse", "smuggling_boom"],
  "home_boroughs": ["staten_island", "brooklyn"],
  "ideology_summary": "Everything that crosses water pays the Combine.",
  "rank_titles": ["Associate", "Tollman", "Bridgekeeper", "The Narrows"],
  "colors": {"primary": "#8C1D1D", "glyph": "≡"},
  "activities": ["smuggling", "protection", "union_muscle"],
  "asset_types": ["dock", "warehouse", "toll_checkpoint"],
  "relations_bias": {"police_successor": -60, "tenant_militias": -10, "new_faiths": 0},
  "job_templates": ["courier_run", "lean_on_shopkeeper", "boat_night_watch"],
  "member_archetype_weights": {"dockworker": 4, "enforcer": 2, "accountant": 1},
  "bark_grammar": ["The bridge sees everything, friend."]
}
```

### 6.3 `event_template.schema.json` (history + live city events share one schema)
```json
{
  "id": "evt_grid_blackout",
  "scope": "citywide",
  "phase": ["history", "live"],
  "weight": 4,
  "preconditions": {"year_min": 2027, "stat": {"infrastructure_health": {"lt": 0.5}}},
  "duration_days": [2, 14],
  "effects": {
    "neighborhood_stats": {"crime_rate": "+0.15", "prosperity": "-0.1", "cult_penetration": "+0.05"},
    "may_found": ["religion:blackout", "faction:generator_cartel"],
    "spawn_tables": {"looting_encounter": "+50%"}
  },
  "residue": [
    {"type": "graffiti", "text_grammar": "#blackout_graffiti#", "density": "high"},
    {"type": "shrine", "where": "intersection", "desc": "candles fused into the asphalt in a ring"}
  ],
  "chronicle_grammar": "In {year}, the grid failed for #duration#. #blackout_consequence#",
  "news_grammar": "GRID DOWN AGAIN IN {neighborhood} — #tabloid_blackout_headline#"
}
```

### 6.4 `npc_archetype.schema.json`
```json
{
  "id": "street_medic",
  "name_banks": ["nyc_general"],
  "age_range": [22, 70],
  "stats_bias": {"WIT": 2, "NRV": 1},
  "skills": {"medicine": [3, 7], "streetwise": [1, 4]},
  "schedule_template": "night_shift_roamer",
  "workplace_types": ["clinic", "back_room", "ambulance_husk"],
  "inventory_table": "medic_kit_t1",
  "personality_ranges": {"aggression": [0, 2], "greed": [1, 6], "piety": [0, 8], "courage": [3, 9]},
  "services": [{"id": "patch_up", "price_grammar": "#haggle_medical#"}],
  "bark_grammar": ["Sit still or bleed, your call.", "I don't ask how. I ask where it hurts."],
  "rumor_grammar": ["A medic on #street# swears the {religion} healers are stealing her patients."]
}
```

### 6.5 Other required schemas (same pattern; full definitions in `/content/schemas/`)
- `item.schema.json` — glyph, color, slots, effects, value, flavor grammar, era tags
- `sidequest_template.schema.json` — giver archetype, objective grammar (fetch/escort/sabotage/witness/deliver/pilgrimage), twist table, fail states, reward table
- `neighborhood_seed.json` — per-real-neighborhood: adjacency, subway lines, area type, 2026 baseline stats, landmark list
- `league.schema.json` — sport rules summary, season structure, team name grammar, venue types, betting odds model
- `rumor_grammar.json`, `news_grammar.json`, `obituary_grammar.json`, `graffiti.json`, `name_banks/*.json`, `barks/*.json`
- `origin.schema.json` — player starts

### 6.6 Content volume targets for v1 (agents, go)
12 new religions, 5 old-faith presence packs, 20 factions, 120 event templates, 60 NPC archetypes, 40 sidequest templates, 300 items, 8 leagues, 150 neighborhood seeds, 2,000+ grammar strings (barks, rumors, graffiti, headlines, obituaries). Style guide for all prose: terse, concrete, darkly funny, no purple sludge; reads like a great message log, not a novel.

---

## 7. Backend Spec

```
POST /api/register   {username, password}        -> 201 | 409
POST /api/login      {username, password}        -> session cookie
POST /api/logout
GET  /api/saves                                  -> [{slot, updated_at, char_name, networth, alive}]
GET  /api/saves/:slot                            -> gzipped blob
PUT  /api/saves/:slot                            -> 204 (autosave target; last-write-wins)
POST /api/runs                                   -> record finished run {seed, char, networth, died_at, cause}  // leaderboard later
GET  /api/leaderboard                            -> 501 in v1 (stub, documented)
```
SQLite tables: `users(id, username UNIQUE, pwhash, created_at)`, `sessions(token, user_id, expires_at)`, `saves(user_id, slot, version, blob, updated_at)`, `runs(id, user_id, seed, char_name, networth, cause_of_death, turns, started_at, ended_at)`. Rate limit auth endpoints. Usernames are the only PII; say so on the register screen.

Save blob = `{version, seed, world_diff, chronicle, player, tier2_records, settings}` — world geometry regenerates from seed; only diffs persist.

---

## 8. Milestones

- **M0 — Walking Skeleton (the proof):** Vite app, glyph-atlas renderer at 60fps, one procgen neighborhood, WASD movement, turn loop, FOV, message log. *Exit criteria: feels instant; 10k glyphs drawn without sweat.*
- **M1 — The Decade:** worldgen pipeline, history sim 2026→2036, chronicle viewer, residue stamping, neighborhood travel + subway, day/night.
- **M2 — People & Violence:** Tier 1 NPCs with schedules, dialogue/barks, combat, injuries, death, hospital/jail loops, player death + obituary + legacy persistence.
- **M3 — The Living City:** Tier 2/3 sim, factions, religions + rituals + favor, crime & heat, economy/jobs/shops, sidequests, leagues + betting, news & rumors.
- **M4 — Public:** auth + server saves, autosave, settings, CRT shader, onboarding ("how to read the screen"), content packs at full volume, deploy, runs recording.

Each milestone is independently demoable. Content-pack authoring (Section 6) runs in parallel with M1+ — schemas are frozen at end of M1.

---

## 9. Art Asset List (GPT imagen2)

ASCII purity in the play field; full-bleed art only at menus, chapter cards, and death. All images get a heavy dark grade and dim behind UI. **Sigils wait until the agent-generated faiths/factions are locked**, then batch-generate from each pack's `sigil_prompt`.

Generate now:
1. **Title key art** — "Rain-drowned lower Manhattan at night, 2036, dense fog, broken neon signage in many languages reflecting on flooded streets, brutalist towers patched with scaffolding and satellite dishes, lone figure with umbrella, cinematic Blade Runner color grade, teal and sodium orange, film grain, no text"
2. **Death plate** — "Empty NYC intersection at 4am in the rain, police tape, a single chalk outline glowing faintly, steam from a manhole, distant neon cross, oppressive dark cinematic grade, no text"
3. **CRT bezel/frame texture** — "Worn retro-futuristic CRT terminal bezel, matte black plastic with scratches and a small engraved municipal seal, subtle screen glow from within, straight-on, symmetrical, no text"
4. (After lore lock) 5 borough mood plates + 12–20 sigils from pack prompts.

---

## 10. Open Questions

1. Final title. (EMPIRE://36 is a placeholder.)
2. Hosting: Fly/Railway vs the home rig. (Public game → managed host recommended.)
3. Font: candidate set to taste-test in M0 (e.g., a clean terminal mono vs something CP437-flavored).
4. How loud should real-world 2026 references be in the chronicle? Current stance: dateline-only, one notch above zero.
5. Subway map of 2036 — how degraded? (Great lore lever: which lines survived says everything about a neighborhood.)
