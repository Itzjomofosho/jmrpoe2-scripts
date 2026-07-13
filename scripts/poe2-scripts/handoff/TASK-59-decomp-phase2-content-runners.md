# TASK-59 — Decomposition PHASE 2: extract the five content-runner modules (~3.5k lines, pure moves)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-59\`. READ handoff/MAPPER-DECOMP-PLAN.md
AND handoff/TASK-52-REPORT.md FIRST — 52's report is the proven recipe (pure move, bus seams via
xConfigure({log,...}), per-module verification protocol); repeat it five times. USE OPUS 4.8.
SEQUENCING: only after the user's TASK-52 smoke map passes. One module at a time IN THIS ORDER, node --check
after each; a seam that resists a pure move gets the 52 treatment (leave the resisting function in mapper,
document) — never force it.

## The five modules (order = least entangled first)
1. `stone_circle.js` — runStoneCircle + its state block + consts (the plan's map: ~3308-3748 region, plus
   the StoneCircle helpers/bans). Cleanest runner shape; sets the Phase-2 pattern.
2. `abyss.js` — runAbyssRun + abyssNodeStatus + the chest sweep (tryAbyssChestSweep, abyssSweepAdd/retire/
   probe, abyssChestNear, flip-watch + FLIP_TRUST_R hotfix + counters) + abyss blacklists/state. The sweep
   and runner share state — they move TOGETHER.
3. `verisium.js` — the full exp2 block: _runExpedition2/runExpedition2, remnant scan, reward
   ranking/select/hammer, anchor tracking (TASK-50), stale-far tick (53-C), loot ladder, exp2 state/consts.
   Biggest single block (~1k+); its POE2Cache bus reads stay as-is (they are already module-safe).
4. `breach.js` — nearestBreachPoint/runWalkToBreach/runBreachRoam/bestBreachMob + white-tail + breach state,
   PLUS the hive block (getBreachHives, runHiveDefense, hiveArrivalDwell, hive state) — they share the
   Brequel/breach2 domain.
5. `incursion.js` — chest/beacon runners, the vaal-beacon registry + terrain discovery, the strongbox event
   hold (TASK-29B + 47-B release), incursion state/bans.

## Seam rules (beyond 52's)
- These runners READ/WRITE spine state the leaf modules didn't: contentQueue entries (state flips),
  revisitSkip, the walker (startWalkingTo/stepPathWalker/navTo/currentPath/targetName), sendStop*/MB,
  statusMessage, log, engaged signals consumed by mapper (engagedContentAnchor reads exp2Phase etc.).
  Pattern: each module gets ONE xConfigure({...}) bus carrying the walker/queue/status accessors it needs
  (list each in the report); ENGAGED-SIGNAL reads go the other way — the module EXPORTS a small state-read
  API (e.g. exp2Engaged(), breachActivatedAt()) and mapper's engagedContentAnchor consumes those exports.
  NO module imports mapper; NO mapper state is reached except through the bus.
- Serialization: abyss sweep sites/counters and any persisted runner state export serialize/restore/reset
  and ride the envelope exactly like visited_trail did (byte-identical envelope keys).
- The arbiter/rotation call sites in mapper (arbRunnerFor, runContentRotation dispatch, pre-arbTick hooks)
  keep their exact call shapes — only the import source changes.
- TASK-56/53/47 flags and gates move WITH their runner code, verbatim, comments intact.

## Verification (per module, then whole)
- node --check all files; every moved symbol defines exactly once; moved bodies byte-identical to the
  pre-snapshot except documented bus-seam tokens (list every token change in the report, 52-style).
- After all five: mapper.js line count reported (expect ~20.2k -> ~16.5-17k); the full mapper diff contains
  only import lines, bus wiring, and deletions.
- Live smoke (user): one map with an abyss + any second content type — runner behavior identical, engaged
  gates fire, sweep services chests, resume envelope round-trips (mid-map toggle off/on).

## Rollback
Copy handoff\pre\TASK-59\mapper.js back + delete the five module files.
