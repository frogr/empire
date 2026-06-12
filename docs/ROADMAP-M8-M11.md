# EMPIRE://36 — M8–M11: Agency ("GTA for Dwarf Fortress")

This is the execution spec for the next four milestones. It is written to be
self-contained: an agent with no prior session context should be able to build
from this document plus the codebase. Read `CLAUDE.md` and `docs/PRD.md` first;
this document extends them and does not repeal anything in them.

## 0. Why this exists (the audit, condensed)

After M0–M7 the game is legible (hint bar, real city map, tabbed help) and
alive (street director, scenes, directed encounters, surfaced sim). But agency
is **wide and shallow — nothing the player does compounds**:

- **Money dead-ends at ~$500.** Shop ceiling is the $90 stab vest. The item
  pool already contains a $400 `pawnshop_carbine`, $320 `revolver`, $280
  `pipe_shotgun` — none are reachable through any shop, stash table, or loot
  list. Net worth is only a score.
- **Stats are frozen at creation. No traits, no perks.** Skills (8,
  use-trained) are the only growth. Favor matters once (boon at 3); standing
  matters once (checkpoint pass at 2); both accumulate meaninglessly after.
- **Origins are flavor after minute one.** `originId` is read at death and on
  the char sheet, nowhere else. There is no educated/white-collar origin.
- **The player cannot change the world.** Neighborhood stats, faction control,
  and faith spread move only via `CitySim.tier3Daily` drift. Quests, kills,
  tithes — nothing writes back. The chronicle records the simulated decade and
  player deaths, never player deeds.
- **One z-layer.** No sewers, tunnels, or rooftops. The `rooftop_key` relic
  opens nothing. Interiors are shells.

M8–M11 fix this in order of impact-per-effort: money → position (M8),
character → biography (M9), institutions → careers and arcs (M10), the
vertical city → the underground and the consequence ledger (M11).

---

## 1. Ground rules (do not erode)

Everything in `CLAUDE.md` "Architecture" holds. Specifically for this work:

- **Determinism.** Every new mechanic draws from `Rand(seed, stream)`. New
  streams introduced here: `'fence:{hood}'`, `'property'`, `'traits'`,
  `'career'`, `'arcs'`, `'under:{hood}'`. Never `Math.random()` in `src/sim/`.
  Replay tests (two instances, identical action scripts, identical message
  streams) must keep passing.
- **Perf budgets** (PRD §3.3): render <4ms, player turn <8ms typical,
  worldgen <6s, save <2MB, memory <400MB. Undermaps (M11) count against the
  same `hoodCache` (LRU 6) and the perf smoke tests.
- **Beat cadence band.** `city.test.ts` asserts 25–220 surfaced messages per
  600 idle turns. New message sources (salaries, rent, arcs, collectors) must
  keep the suite green — tune probabilities, don't delete the test.
- **Save compatibility.** Current save version is **2**. This work bumps to
  **3** once, at the start of M8. Every new field restores with a default so
  v1/v2 saves load; extend the roundtrip test in `city.test.ts` ("save v2
  roundtrips...") rather than replacing it. Keep a checked-in fixture test.
- **Tile enum is append-only** (`src/sim/map.ts` `T` — see the `DoorLocked`
  comment). Same for `AK`.
- **Content packs are self-contained.** New JSON sections go through
  `src/sim/content/types.ts` → `packs.ts` (`ContentPack`) → `index.ts`
  (merged registry). Any `#slot#` a pack references must ship in that pack's
  own `grammars` section — `history.test.ts` enforces slot coverage.
- **Prose style** per CLAUDE.md: terse, concrete, darkly funny.
- **Delegation.** Orchestrate with the strongest model; author content packs,
  test scaffolding, and well-specified self-contained modules with smaller
  models (pass an explicit `model` on every Agent launch). Instruct content
  agents to keep any single file under ~450 lines and split into multiple
  packs if needed — one past agent hung trying to write a giant file in one
  Write call.

### 1.1 Where things live (anchors, as of commit `6eea153`)

- `src/sim/game.ts` (~2700 lines) — everything player-facing. Key methods:
  `enterHood`, `endTurn` (surfacing + director + editions), `interact`,
  `talk`, `maybeOfferQuest`/`completeQuest`/`completableAt`, `openShop`/
  `runDataAction` (menu verb strings, e.g. `'buy:beans'`, `'enc:pay'`),
  `directorTick`/`startScene`/`sceneTick`, `startMuggerEncounter` etc. +
  `resolveEncounter`, `forceLock`/`searchTile`, `spawnHostiles`,
  `contextHints`/`interactablesNear` (hint bar), `fillView`/`fillCityMap`,
  `serialize`/`applySave`/`applyMapDiff`, `barkPool`.
- `src/sim/director.ts` — beat pacing (`BEAT_COOLDOWN=8`, `BEAT_CHANCE=0.1`),
  scene selection. Owns the `'director'` stream.
- `src/sim/city.ts` — `tier2Tick` (returns `T2Incident[]`), `tier3Daily`,
  `districtPulse`, rumors, leagues, `dump()`/`load()`.
- `src/sim/player.ts` — `PlayerChar`: `stats` (STR/AGI/END/WIT/CHA/NRV,
  currently immutable), `skillXp` (use-trained via `train()`), `inventory`,
  `injuries`, `netWorth()`.
- `src/sim/mapgen.ts` — `generateLocalMap(worldSeed, ctx)`, `AREA_PARAMS` per
  area type, residue stamping. Locked stash doors are added as a post-pass in
  `game.ts localGen` (stream `'stash:{hood}'`) — follow that pattern for
  light map post-processing instead of surgery inside mapgen.
- Menus: `Menu` interface in game.ts (`kind: 'origin'|'inventory'|'item'|
  'bodypart'|'shop'|'bet'|'altar'|'encounter'`), driven by `actMenu` →
  `runDataAction(data)`. Encounter menus can't be Esc'd. Add new kinds to the
  shared `runDataAction` case group.
- Tests: `sim.test.ts` (perf + determinism), `city.test.ts` (sim systems;
  `type AnyGame = any` pattern for private access; `boot(seed)` helper),
  `director.test.ts`, `citymap.test.ts`, `testutil.ts` (`fixtureSeeds()` —
  8-hood ring, all area types, `bushwick` first).
- Chrome verification: dev server :5136, `?seed=x` pins a world. Keyboard
  events reach the worker async — **screenshots race keypresses; screenshot
  one batch later than the keys you want to observe.** F9 = perf overlay.

---

## 2. M8 — CAPITAL: money becomes position

Goal: every dollar band from $100 to $5,000 has something the player wants,
and spending creates state that changes how the city treats them.

### 8.1 The fence (black market)

- **Access:** at any bodega counter in a hood with `stats.crime > 0.5`, the
  shop menu gains an entry `Ask about the other inventory` (data
  `'fence:open'`). Gate: `streetwise >= 2` OR any faction `standing >= 1`;
  otherwise the counterman "doesn't know what you mean."
- **Stock tiers** (deterministic per hood per day, stream `'fence:{hood}'`):
  - Tier 1 (always, once inside): `knuckle_dusters`, `machete`,
    `flare_pistol`, `moto_jacket`, `bullets`.
  - Tier 2 (`streetwise >= 4` or `standing >= 2`): `zip_pistol`,
    `riot_pads_old`, `freezer_suit`, `fire_axe`.
  - Tier 3 (`streetwise >= 6` or `standing >= 3`): `revolver`,
    `pipe_shotgun`, `pawnshop_carbine`.
  3–5 items rolled per visit-day from the unlocked tiers, priced
  `value × (1.4 − 0.04×streetwise)`, never below ×1.1.
- **Selling:** fence pays ×1.3 the bodega rate for `valuable`/`junk`, and
  buys weapons/guns (bodegas don't). Fencing a relic prints a Ledger line the
  next edition ("a piece of the decade changed hands in {hood}").
- **Heat:** buying tier 3 adds +1 heat. Selling 3+ items in one visit: +0.5.
- New `runDataAction` verbs: `fence:open`, reuse `buy:`/`sell:` with a
  `fence` flag on the Menu (or `fbuy:`/`fsell:` — implementer's choice).

### 8.2 The property ladder

New game state `property: PropertyState[]` (save v3):
`{ kind: 'cot'|'apartment'|'shop', hood: string, tile: number, paidThrough: number /* day */, income?: number }`.

- **SRO cot — $40 for 7 days.** Offered via counter menu (`Ask about the back
  room`) in hoods with `prosperity < 0.55`. One cot at a time; renting a new
  one releases the old. Benefit: **safe rest** — a `rest` within 3 tiles of
  your cot tile runs to full stamina, heals 2 HP, and cannot be interrupted
  by encounters (director suppressed while resting at home).
- **Apartment — $600 + $25/7 days.** Hoods with `0.35 < prosperity < 0.75`.
  Adds a **stash**: a Furniture tile in your unit; `[e]` on it opens a
  deposit/withdraw menu (new Menu kind `'stash'`; contents in `PropertyState`
  — do NOT rely on map item piles for owned storage, they're lootable by
  design). Heat in your home borough decays at 2× while you're in that hood.
- **The shop — $2,500, one per run.** Any bodega counter in a hood where you
  have `standing >= 1` with the controlling faction, or `crime < 0.4`.
  Effects:
  - Income: `$Math.round((20 + prosperity*60) ± 25%)` per day, collected by
    `[e]` at your counter (accrues up to 5 days, then stops — forces visits).
  - Your counter buys/sells at cost (no spread) and becomes a quest-giver
    magnet: one guaranteed quest offer per day at your counter.
  - **You become a target:** shakedown scenes preferentially anchor at your
    shop; the toll/shakedown encounter gains a `Pay them off ($X)` /
    `This is my place` (fight) / `Negotiate` (CHA, standing) branch. Refusing
    twice flags a `feud` with that faction: their hoods' tolls always fire
    for you until you fix it (task quest or $).
- **Rent lapse:** `paidThrough < day` → cot/apartment lost with a message; a
  third of stash contents "walk away" (rolled per item, 33%).
- Surfacing: rent-due warning at the dawn edition two days out; income and
  lapse lines in editions.

### 8.3 Hiring people

- **Muscle — $60 up front + $15/day** (auto-deduct at dawn; quits with a
  message if unpaid). Hire via fence menu or your own shop. Implements the
  deferred **follower AI**: new actor state `ST_FOLLOW` — steps toward the
  player when >2 tiles, attacks the player's current attacker (reuse
  `aTarget` from brawls), persists across travel (re-spawned beside you in
  `enterHood` — store `hired: { archId, name, hp, paidThrough } | null` in
  save v3, not an actor index). Cap: 1. They can die. They stay dead.
- **Lookout — $30/7 days per hood.** Halves mugger/watchman encounter
  trigger chance in that hood and prints one warning line when an encounter
  would have fired ("Your lookout whistles twice. You take the long way.").
  Stored as `lookouts: Record<hood, paidThrough>`.

### 8.4 Profile (visibility cost)

Derived, not stored: `profile()` = 0 + (netWorth > 400) + (netWorth > 1200)
+ (owns shop) + (gun wielded) + (trait Known Face, M9). Range 0–5.
- Mugger demand scales: `(20 + rTurn.int(0,60)) × (1 + profile×0.3)`.
- `bark_rich` triggers at profile ≥ 2 instead of money ≥ 800.
- Fence tier gates treat `profile ≥ 3` as +1 standing equivalent.
- Shakedown scene preconditions include profile ≥ 2 when no shop is owned.

### M8 content (delegate)

`content/packs/economy.json`: fence barks + menu flavor (grammar slots
`fence_greeting`, `fence_refusal`, `landlord_lines`, `rent_due`,
`income_lines`, `muscle_barks`, `lookout_warnings`), each 5–8 variants.

### M8 done when

- A fresh character can: earn to $500 by quests/loot, unlock the fence, buy a
  zip pistol, rent a cot, then an apartment with a working stash, then buy a
  shop, collect income, survive (or pay off) a shakedown targeting it, hire
  muscle and watch it fight for them. All verified in Chrome.
- Save v3 roundtrips property/stash/hired/lookouts; rent lapses correctly
  across save-load; v2 fixture still loads.
- Tests: fence gating (streetwise/standing), price math, property lifecycle
  (rent→lapse→loss), follower joins/fights/dies deterministic on a pinned
  seed, income accrual cap. Beat-band and perf suites green.

---

## 3. M9 — SCAR TISSUE: character becomes biography

Goal: who you've been changes who you are, mechanically and visibly.

### 9.1 Traits (earned, permanent)

- New pack section `traits` (`content/packs/traits.json`), schema in
  `content/types.ts`:
  ```jsonc
  { "id": "hard_target", "name": "Hard Target",
    "desc": "Muggers read you and reconsider.",
    "counter": "muggings_survived", "threshold": 3,
    "flavor": "The third one backs off mid-sentence. Word gets around." }
  ```
  Effects are **engine-side** keyed by id (like religion boons — see
  `hasBoon` call sites), NOT data-driven; the pack carries identity + trigger.
- Engine: `counters: Record<string, number>` and `traits: string[]` on
  `PlayerChar` (save v3). `bump(counter)` helper checks trait defs and awards
  at threshold: message + journal. Traits survive… until death (they're the
  character, not the world).
- **Launch set (≥12; effects at existing call sites):**
  - `hard_target` (3 muggings survived): mugger trigger ×0.5, talk-down +0.15.
  - `iron_stomach` (25 dumpster dives): no rat bites, food +1 effect.
  - `known_face` (2 witnessed kills): bribes ×1.5, fence prices −15%,
    recruiters skip you, +1 profile.
  - `tunnel_rat` (15 subway rides): subway minutes ×0.7; M11: +2 light radius
    underground.
  - `flinch` (first time downed): permanent; −1 damage taken from the first
    hit of any fight (you saw it coming).
  - `silver_tongue` (5 successful talk-downs/negotiations): CHA checks +10%.
  - `pack_mule` (fence 20 items): carry… we have no weight system — instead:
    scavenge quests need −1 item.
  - `night_shift` (200 turns active 00:00–05:00): night vision radius +2.
  - `regular` (30 purchases): bodega prices −10%, shopkeeps bark your name.
  - `bleeder` (lose 30 HP total to bleeding): bleeding stops one tick sooner.
  - `landlord_friend` (pay rent 4 times on time): rent −20%.
  - `god_fearing` (attend 10 rituals): favor gain ×2 on rituals.
- Char sheet (`openCharSheet`) gains a TRAITS section; hint-bar unaffected.

### 9.2 Stat drift (slow, bounded)

- `statDrift: Record<StatId, number>` on PlayerChar, each clamped to
  [−2, +2] from origin baseline; effective stat = base + drift.
- Earned at the **dawn edition** (daily check, deterministic): vault/run
  events that day → AGI progress; forced locks/brawls → STR; a day at
  hunger ≥ 90 → END −progress; books? no. Each stat needs 5 "progress days"
  per point. Messages: "Your shoulders are different now." Decay: none —
  drift is a ratchet both directions, that's the point.
- `maxHp`/`maxStamina` recompute when END changes (preserve damage taken).

### 9.3 Origin doors

Hardcode origin checks at door sites (the boon pattern), one real hook per
origin, surfaced in the journal under WHO YOU ARE:

- `clinic_dropout`: clinics treat you at half price; `[e]` at a clinic
  counter offers a **moonlight shift** (once/day: 60 turns pass, $35–60,
  medicine trains; M10: counts as clinic-institution work).
- `defrocked_priest`: start with favor 1 in the seed faith of your spawn
  hood; altars offer `Preach` (CHA check → small favor/crowd scene/heat).
- `night_courier`: delivery quests +25% pay, twist chance −50% (you check).
- `drone_washout`: drone-league bets show true odds; salvage finds +1 tier.
- `laid_off_doorman`: locked doors in `grid_dense`/`civic` open on STR check
  without stamina cost (you know the trick), forceLock odds +0.2.
- `fresh_arrival`: quest cap 4 (hungry), all standing/favor gains +0 (no
  history here works against you: bribes +10%).
- **New origin `disbarred_associate`** (add to `content/origins.json`):
  "Disbarred Associate — Columbia Law, class of '29. The firm survived the
  decade; your license didn't." Stats: WIT 8, CHA 7, NRV 6, STR 4, AGI 5,
  END 5. Start: $120, `court_suit` (new armor item, value 80, light),
  `phone_dead`. Hook: the **law firm** (M10) hires them two ranks up, and
  `Comply` outcomes in watchman stops cost half (you do your own paperwork).

### M9 done when

- Playing a normal hour of game organically surfaces ≥1 trait award and the
  char sheet/journal show traits + drifted stats with origin hook lines.
- Trait effects measurably fire (tests pin each call site with a seeded run).
- Stat drift ratchets and clamps correctly across save/load; v2 saves load
  with empty counters.
- New origin selectable, hooks verified; every origin has ≥1 functioning door.

---

## 4. M10 — THE LADDER: institutions, careers, arcs

Goal: organizations you can join, rise in, and be betrayed by — and arcs that
run city-wide whether or not you're in them. This is the law-firm / mob-
takeover milestone.

### 4.1 Institution framework

- Pack `content/packs/institutions.json`, schema in types.ts:
  ```jsonc
  { "id": "calder_voss", "name": "Calder & Voss LLP", "kind": "firm",
    "hq": { "areaTypes": ["civic", "grid_dense"], "minProsperity": 0.6 },
    "join": { "origin": ["disbarred_associate"], "orStat": { "WIT": 7 },
              "blurb": "They need people who can read. Still." },
    "ranks": [
      { "title": "Runner",    "salary": 30,  "questsToAdvance": 3 },
      { "title": "Paralegal", "salary": 60,  "questsToAdvance": 4 },
      { "title": "Associate", "salary": 110, "questsToAdvance": 5 },
      { "title": "Partner",   "salary": 200, "questsToAdvance": 0 }
    ],
    "perks": { "1": ["bribe_discount"], "2": ["lawyered_up"], "3": ["rainmaker"] },
    "questTags": ["legal"], "grammars": { } }
  ```
  Ship 5 institutions: **firm** (Calder & Voss), **clinic network** (Mutual
  Aid Dispensary), **transit authority remnant** (Metropolitan Salvage &
  Service), **one faith hierarchy** (binds to the player's joined faith),
  **one crew** (binds to a world faction at runtime — pick the strongest
  faction in the spawn borough).
- **HQ placement:** one hood per institution per world, deterministic
  (stream `'career'`): the best-fitting hood by `hq` criteria; HQ is that
  hood's civic building / clinic / depot / church / faction block — mark the
  building's counter tile as the institution desk (post-pass like stash
  doors). City map panel shows "HQ: {institution}" for that hood.
- Game state (save v3): `career: { instId, rank, questsDone, hiredDay,
  perksSeen } | null`, one career at a time; quitting or expulsion keeps a
  `careerHistory: string[]` (institutions don't rehire).
- **Joining:** `[e]` at the desk → join menu if requirements met (origin OR
  stat path; crew requires standing ≥ 2 with that faction). `disbarred_
  associate` joins the firm at rank index 2 directly.
- **Work:** the desk offers institution quests (quest templates tagged via
  `questTags`, new templates in the pack — reuse the M7 quest engine,
  filtered by tag instead of giver arch when offered at a desk). Rank-up at
  `questsToAdvance` completions: title line, salary bump, perk unlock,
  chronicle entry.
- **Salary:** every 7 days at the dawn edition, `salary` × rank deposited
  with a line. Missing 7 consecutive days of any institution quest activity
  docks rank progress by 1 (institutions notice absence).
- **Perks (engine-side, boon pattern):** `bribe_discount` (×0.6),
  `lawyered_up` (once per 7 days, a watchman stop auto-resolves: "My
  counsel's on the way." heat −2), `rainmaker` (legal quests pay ×1.5),
  `free_care` (clinic heals at $0), `meds_at_cost`, `free_fare` +
  `tunnel_pass` (M11 access), `ritual_anywhere`, `favor_x2`, `fence_plus`
  (fence tier +1), `toll_immunity_crew`, `crew_muscle_discount`.

### 4.2 Arcs (the world has plot)

- New module `src/sim/arcs.ts`, stream `'arcs'`, state saved:
  `arcs: { id, stage, nextDay, data: Record<string,string> }[]`.
- Arcs are multi-stage city events advanced from `tier3Daily` (cadence in
  days), surfaced through Ledger editions, district pulses, scenes, and —
  when the player is a member of the affected institution — a **summons**: a
  messenger NPC spawned near the player ("A kid finds you with a folded
  note…") opening an encounter-style choice menu.
- **Launch arcs (≥5):**
  - `mob_takeover` — the crew's faction absorbs a rival: 4 stages over
    6–10 days (provocation → street war week: brawl/shakedown scene weights
    ×3 in contested hoods → the push: `control` rewrites across 3–6 hoods →
    consolidation). Member choices at stage 2: pick a side (tasks for either,
    standing/feud outcomes); rank ≥2 crew members get a cut ($150–400) or, on
    the losing side, expulsion + feud.
  - `firm_raid` — the firm is raided (stage 1 rumor, stage 2 raid scene at
    HQ, stage 3 outcome): members are summoned: `Testify` (career ends,
    +$300, heat 0, trait Paper Trail), `Stonewall` (rank +1 if firm survives
    [60%], expelled if not), `Shred all night` (WIT check; failure: heat +3).
  - `faith_schism` — the player's faith splits; favor halves into two
    branches; `defrocked_priest` (or favor ≥ 5) may `Lead the breakaway`:
    becomes rank 2 of a NEW faith institution; city `faiths` rewrites.
  - `transit_reopen` — Metropolitan Salvage reopens one dead line segment
    over 8 days (institution quests feed it): **`subway` arrays of 2–4 hoods
    gain a line; the city map changes.** Transit members get the ribbon-
    cutting scene; everyone gets the Ledger headline. This is the flagship
    "the world visibly changed" moment.
  - `clinic_strike` — clinics close for 3–5 days (no nerve-save revival —
    downs are deaths during the strike, telegraphed loudly in editions; the
    clinic institution can end it early via quests).
- Arc eligibility from world state (factions exist, faiths exist, dead lines
  exist); at most 1 active arc + 1 brewing; ~1 arc starts per 4–7 game days.

### 4.3 The consequence ledger (player writes to the world)

Implement in M10 (arcs need it):

- Bounded world-writes at existing call sites, all clamped and rate-limited
  (max one write per stat per hood per day):
  - Kill a faction's enforcer: that faction `control[hood] −0.02`.
  - Complete a faction task: `+0.03` in the target hood; completing against a
    feuded faction: −0.02 theirs.
  - Tithe ≥ $50 / lead a ritual: `faiths[faith][hood] +0.02`, `cult +0.005`.
  - Own a shop: hood `prosperity +0.01` per 7 days; abandoned (lapsed) shop:
    `crime +0.01` once.
  - End a blackout scene by … (no mechanic; skip), heat ≥ 4 sustained 200
    turns in a borough: that borough's hoods `crime +0.005` (you are the
    crime wave).
- **Chronicle in-year entries** (tag `'player'`): first kill, shop purchase,
  each rank-up, arc outcomes, trait `known_face`. `openJournal` shows 2036
  entries; successors inherit a chronicle that remembers the previous run's
  deeds (already true for obituaries; now for works).

### M10 done when

- A `disbarred_associate` can walk into Calder & Voss rank 2, do legal work,
  draw salary, hit Partner, and survive (or not) a firm raid — in Chrome.
- A crew member experiences `mob_takeover` from inside (side-picking menu,
  payout or expulsion) AND a non-member sees the same arc reshape checkpoint
  tolls and the city map's turf colors from outside.
- `transit_reopen` visibly adds a line to the city map mid-run.
- Consequence writes verified: a seeded test kills 3 enforcers and asserts
  control drops; a tithe test asserts faith spread; chronicle gains tagged
  player entries; successor run can read them.
- All institutions joinable behind correct gates; salaries/absence/expulsion
  lifecycle tested; arc state roundtrips through save v3.

---

## 5. M11 — BELOW: the vertical city and the fall

Goal: a second map layer with different rules, the existing "useless" items
become keys, and failure routes downward instead of only to the grave.

### 5.1 The undermap (sewers + dead tunnels)

- `generateUnderMap(worldSeed, hood)` in mapgen (stream `'under:{hood}'`):
  ~90×90, mostly `Wall`/new tiles `SewerWater` (walkable, slow-ish via
  stamina drain), `Ledge`, `TunnelRail`; structure: a sewer grid under the
  street plan + one dead subway tube if the hood has/had a station; 2–4
  exits: manholes (paired with surface `Manhole` tiles), the dead station,
  collapsed sections.
- **Entry:** `[e]` on a surface `Manhole` (needs `crowbar`, or STR check, or
  transit `tunnel_pass` perk); `[e]` on `StationDead` with `tunnel_pass` or
  forceLock. Hint bar: `[e] go below`.
- **Below rules:** light radius 4 (street is 9–14); `blackout_candle` /
  `flare_pistol` wielded → +3; `tunnel_rat` trait +2. No law, no heat decay,
  no editions (you hear nothing down there — surfacing dumps the backlog,
  which is a great moment). Encounters: rat swarms ×3, **tunnel folk** (3
  new archetypes via pack: `mole_hermit`, `track_walker`,
  `pale_congregant`), the M6 scene engine works below with a small
  `under`-tagged scene set.
- **Why go:** undercrossings between adjacent hoods with no toll and no
  checkpoint (tunnels ignore faction borders); salvage density ×2 (`Rubble`
  everywhere); 1–2 sealed `Container` caches per undermap (crowbar; stash-
  table loot + guaranteed relic at 25%); transit-institution quests live here.
- Travel plumbing: undermaps join `hoodCache` keyed `under:{hood}`;
  `enterHood` gains a `via: 'below'` mode; the city map panel shows a `▼`
  when you're under ("FIVE BOROUGHS — BENEATH").

### 5.2 Rooftops (scoped tight)

- No full roof layer. Instead: buildings in `grid_dense`/`rowhouse` with a
  roof door get a **roof interior** room stamped at mapgen (small,
  unreachable except via `DoorLocked` roof-access doors in stairwells).
  `rooftop_key` opens ANY roof door (that's its whole identity), parkour
  (`vault` + athletics ≥ 4) reaches fire-escape tiles from alleys.
  Contents: stash spots, drone salvage (`drone_pads`, `salvage_battery`),
  pigeon coops (flavor + eggs=food), one `vista` desc tile per roof
  ("The city from up here still looks like the postcard. The postcard lies.")
  Escape hook: `Bolt` in an encounter while adjacent to a fire escape:
  auto-success, ends on a roof.

### 5.3 The fall (failure routes down)

- **Debt:** borrow at the fence: cap `$100 × (standing+1)`, 7-day term,
  ×1.5 repay. Miss it → collector encounters (mugger-style, but they take
  items at `value` toward the debt). Two missed cycles → **the drop**.
- **The drop replaces some deaths:** when downed with (debt active) OR
  (heat ≥ 5), the nerve-save (game.ts ~line 860) routes to the undermap
  instead of the clinic: wake on a `Ledge` with $0 cash (items kept),
  half HP, debt cleared ("They took it out of you another way."), two
  hoods from home. Climb out. The Ledger runs a line: "{name} hasn't been
  seen since Thursday."
- The drop writes a chronicle entry and bumps a `survived_the_drop`
  counter → trait `basement_graduate`: tunnel-folk encounters start
  non-hostile — the below remembers you.

### M11 done when

- Manhole → undermap → cross under a toll checkpoint → surface in the next
  hood, all in Chrome, with light rules and the edition-backlog dump working.
- A debt spiral ends in the drop, the climb out, and the chronicle line; a
  seeded test drives the full loop deterministically.
- Roof doors open with the key, fire-escape bolt works, drone salvage spawns.
- Perf: undermap gen < the existing per-hood budget; turn <8ms below; save
  roundtrips under-position + debt + roof/under map diffs; suite green.

---

## 6. Cross-cutting checklist (applies to every milestone)

- [ ] Save v3 bump happens ONCE (start of M8); all later fields are optional-
      with-default on that version. v1+v2 fixtures keep loading. Roundtrip
      test extended each milestone.
- [ ] Every new probability/cadence: justify against the beat band test.
- [ ] Every new menu: hint bar entries via `contextHints` (mode `'menu'`
      already generic) + can't-Esc rules decided explicitly.
- [ ] Every new content pack: self-contained grammars, <450 lines/file,
      validated JSON, written by a smaller-model agent with the style rules
      from CLAUDE.md in the prompt.
- [ ] Every milestone: `npm run check`, full `npm test`, manual Chrome pass
      (remember the screenshot race), perf overlay check, commit with a
      milestone-prefixed message, update README feature list + CLAUDE.md
      status line.
- [ ] New Rand streams documented in CLAUDE.md's determinism bullet.
- [ ] Update `?` help (THE CITY tab) and onboarding only when a system is
      player-facing on minute one (property and careers qualify; arcs don't).

## 7. Suggested order & rough effort

| Milestone | Core engine work | Content (delegate) | Feel unlocked |
|---|---|---|---|
| M8 Capital | fence menus, property state, follower AI, profile | economy.json | money matters |
| M9 Scar Tissue | counters/traits/drift, origin hooks, new origin | traits.json | *you* matter |
| M10 Ladder | institutions, arcs module, consequence writes | institutions.json, arc text | the world answers |
| M11 Below | undermap gen, light rules, debt/drop, roofs | under scenes/archetypes | the city has a basement |

M8 → M9 → M10 → M11 strictly: 9 needs 8's money sinks to make drift/traits
visible; 10's crew gates on 8's standing economy and 9's origin doors; 11's
drop needs 8's debt and 10's transit perks to be fair rather than arbitrary.

Public deploy remains parked until the owner says otherwise.
