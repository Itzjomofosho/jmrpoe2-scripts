# MAPPER DECOMPOSITION PLAN (planner, 2026-07-13) — carve 19.4k-line mapper.js into modules, delicately

## Goal + preconditions
mapper.js is 19,437 lines / 430 top-level functions. Split it into subsystem modules using the PROVEN
navigator recipe (module #1 of this split), without changing ONE byte of behavior per step.
PRECONDITIONS: the 44/46/43/38 batch is live-tested and COMMITTED (clean baseline); no other task in flight
against mapper.js during an extraction. One extraction per task per commit — never two seams in one diff.

## The recipe (what navigator.js proved)
1. PURE MOVE: functions + their consts + their module-level state move verbatim. No renames, no "while I'm
   here" fixes. A behavior change found mid-extraction becomes a NOTE in the report, never an edit.
2. BUS PATTERN: the module NEVER imports mapper. mapper imports the module and hands it accessors via a
   configure({...}) call (see navConfigure) OR passes ctx args per call. No circular imports, ever.
3. SERIALIZATION HOOK: a module owning per-map state exports its own serialize()/restore()/reset() and rides
   mapper's existing resume envelope (see navSerialize/navRestore in saveMapState).
4. VERIFY: node --check both; grep proves the moved symbols exist exactly once; a live smoke map before
   commit (TEST BEFORE COMMIT). Rollback = git (each step is its own commit).
5. ROUTING: extractions are mechanical -> Opus 4.8 implements, planner reviews each diff for drift.
   A seam that turns out entangled (walker, arbiter) escalates to Fable or gets planner-implemented.

## The map (subsystem -> approx lines today -> entanglement)
Banners are LOOSE — each extraction task's FIRST act is delimiting its true seam (callers via grep).
| # | module | lines (approx) | entanglement |
|---|--------|------|------|
| 1 | targets_db.js — TARGETS_DB, densestClusterCenter, arena-centroid tile matching | 96-259 + helpers ~14174-14252 | LOW (poe2 reads only) |
| 2 | visited_trail.js — visitedTrail set, trailHas/trailLineFrac/patrol-angle | 1982-2079 | LOW (pure fns + own state) |
| 3 | movement_broker.js — MB | 1409-1456 | LOW (tiny, clean API already) |
| 4 | map_audit.js — audit-file IO + mapAudit | ~805-830 | LOW |
| 5 | posture.js — TASK-35 ranged posture | 2577-2903 | MED (gated senders, POE2Cache buses) |
| 6 | stone_circle.js — runStoneCircle | 3308-3748 | MED (runner shape: contentQueue, walker calls) |
| 7 | abyss.js — runAbyssRun + chest sweep | 3749-4271 | MED (walker, opener bans, loot) |
| 8 | verisium.js — runExpedition2 + exp2 state | 4386-5102 | MED (packets, DAT reads, walker) |
| 9 | objective_model.js — readMapObjectiveState/mapObjectiveExists/Complete + required-names | 4272-4384 (+scattered) | MED (MANY consumers, read-only) |
| 10 | breach.js — runWalkToBreach/runBreachRoam + hive (hiveArrivalDwell ~6041) | 2904-3307 + hive | MED |
| 11 | incursion.js — chest/beacon runners + vaal-beacon registry + terrain discovery + strongbox hold | 2187-2401, 8714-9137 | MED |
| 12 | utility.js — openable/loot candidates, hv anchors, route-insertion detours | 9452-12005 | MED-HIGH (2.3k lines, walker + settings) |
| 13 | explore_legacy.js — discover/coverage/pickUnexploredHeading/pickRouteNearestBucket/content rotation | 6605-8324 | HIGH (walker globals, _unexpFailed shared with sweep) |
| 14 | arbiter.js — OB registry + arbiter v2 + weighting + revisit/cleanup holds | 1457-1981, 5153-6604 | HIGH (touches every runner's engaged signals) |
| 15 | walker.js — currentPath/targetName/startWalkingTo/stepPathWalker + BFS primitives | 1008-1408, 8325-8666 | HIGHEST — extract LAST via a walker-context object |
| — | SPINE (stays in mapper.js): STATE consts, settings, resume envelope, state machine, processMapper, boss-fight chain, hideout flow, UI | ~8-9k after all phases | — |

## Shared-state inventory (the danger list — every extraction must declare which of these it touches and HOW)
currentState/setState, statusMessage, currentPath/targetName/targetGridX/Y/lastRepathTime (the walker),
contentQueue, revisitSkip, currentSettings, visitedTrail, log(), MB, POE2Cache buses (one-way), the resume
envelope, _unexpFailed (shared by discover/coverage/sweep/completed-memory). A module that WRITES any of
these gets it via an explicit bus setter, never a direct import of mapper state.

## Phases (order = least entangled first; the pattern hardens before the hard seams)
- PHASE 1 (leaf, 1 task each, can be same-day): targets_db, visited_trail, movement_broker, map_audit.
  ~600 lines out; proves the recipe on trivial seams. UI (drawUI, 18291-19410, ~1.1k) may also go here —
  it only READS state (needs a getter bus).
- PHASE 2 (content runners, 1 task each): stone_circle -> abyss -> verisium -> breach+hive -> incursion.
  Each is already runner-shaped (own state block + run fn + bans). ~3.5k lines out.
- PHASE 3 (read-model + utility): objective_model, then utility.js. ~2.7k out.
- PHASE 4 (the hard seams, Fable or planner): explore_legacy, then arbiter. Arbiter LAST of the two —
  by then every runner it reads lives behind a module API, so its bus is explicit.
- PHASE 5 (walker, hardest): introduce a walker-context object first (one task: no move, just thread the
  ctx), THEN move it. processMapper + boss chain + state machine STAY — mapper.js remains the orchestrator.
- Live smoke after every task; commit after every pass; a phase may pause indefinitely without debt.

## End state
mapper.js ~8-9k lines (spine: state machine, boss chain, processMapper, resume, settings); ~10 modules with
explicit buses. Boss-fight chain extraction is deliberately OUT of scope until the telegraph RE lands
(it is under active tuning — moving it would churn every diff).
