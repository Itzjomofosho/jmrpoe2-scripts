# EXPLORE-REDESIGN — the full figuring-out (planner, 2026-07-11, user: "no more bandaids")

## 1. What exists today (the accretion)
Pre-boss "where do I go" is decided by SEVEN mechanisms that each re-run every ~2s and feed each other:
1. `pickUnexploredHeading` — fog-bucket scorer (count-weight + phantom filter + trail bias + forward bias + TASK-20 partial-route ban).
2. `pickRouteNearestBucket` — route-nearest mass picker (2.5s cache, own phantom skip, own trail term, `_routePickMass`).
3. `getExploreLandmark` — quest-marker stepping stones, carrying SIX patch layers (sticky commit, 240u directional
   legs, route-verify top-5, reveal-value gate, backtrack gate, partial-route ban) — each layer a dated reaction
   to a specific live complaint, per its own comments.
4. `macroPathTo` / `macroWaypointToward` — the fog-independent whole-map tile-graph router (C++, knows real connectivity).
5. JS BFS (`navTo`/jsBfsPath) — fog-gated fine pathing.
6. `frontierTowardTarget` — fog-edge hop along a bearing.
7. `resolveBossBearing`/boss-direct + [BossDirect] wedge crawl + arena centroid + BossRoom marker.
Plus cross-cutting state: trail wf, forward bearing, `_unexpFailed` TTL bans, `_exLmSeen`, soft-blocks,
stuck/dislodge watchdogs, per-picker caches. The landmark layer FEEDS the boss bearing (conf 0.7) which feeds the
bucket picker's rejects which feeds back into landmark choice — a circular authority loop the comments themselves
document ("the whole explore ping-pong").

## 2. Failure catalog (all from this week's logs — every one is the SAME root)
- Yoyo/backwards walks (Spring_ x3, Willow, map-1) — headings flip; routes thread cleared corridors because
  nothing owns "progress toward the objective".
- Corner/edge picks (Excavation, Willow, Pit) — phantom buckets; patched twice (coverage guard, TASK-20), still
  leaked once more at (2846,51): a partial-but-close route passes every gate, walk-ban 26s later.
- Landmark churn — "landmark reached -> next" every few seconds; each re-pick recomputes markers+routes.
- Discovered facts EVAPORATE — a dead-end learned by walking becomes a 3-5min TTL ban keyed to one bucket, not a
  connectivity fact; the same wall is re-learned from a different bucket/landmark/heading.
- Pick-burst perf — 25-101ms mapper frames exactly at pick moments (route calls × candidates × pickers).
- Reload resume gaps (boss hints lost) — state scattered across 10+ variables, sidecar chases them one by one.

## 3. Root cause (the actual diagnosis)
**There is no plan. There are only opinions.** Every ~2s, three pickers with three different world-models
(fog buckets / terrain graph / marker list) each re-derive a destination from scratch, biased by four overlays,
vetoed by five guards, and the walker executes one leg of whichever spoke last. Nothing persists a ROUTE; nothing
integrates discovered connectivity into a model; the objective (boss) is a bias term instead of a destination.
Every patch so far (trail bias, forward bias, phantom filters, partial-route bans, sticky commits, backtrack
gates) is the same correction — "stop re-deciding so naively" — applied to one symptom at a time.

## 4. The redesign: ONE NAVIGATOR (navigator.js — also the first module of the planned split)
One loop: **model -> objective -> plan -> execute legs -> event-driven re-plan.**
- **WORLD MODEL** (per map, THE sidecar payload): the macro tile-graph (already in C++) + overlays:
  revealed/visited (subsumes trail), POI set (quest markers + the map-wide sleeping-entity classification —
  the user's entity-informed exploration lands HERE for free), boss belief (arena centroid / BossRoom marker /
  bearing hints — persists across reload by construction), and BLOCKED-EDGE facts: a stuck leg or partial route
  writes a graph edit ("edge A-B impassable"), permanent for the map — never a TTL ban re-learned thrice.
- **OBJECTIVE**: exactly one committed destination at a time, chosen by ONE scoring function over
  {boss belief, POIs, frontier mass}, with hysteresis. Replaces heading+landmark+bucket authority trio.
  CHUNK EXPLORE (user 2026-07-11): frontier objectives are REGIONS, not buckets — partition unexplored mass into
  connected components, commit to ONE region, explore it until its remaining mass drops below a threshold, THEN
  pick the next (forward/nearest). "Finish a decent chunk, pick the next chunk" — kills bucket-flitting by
  construction.
- **FIRST CONFIRMED ROOT-CAUSE (2026-07-11, fixed inline ahead of the redesign)**: the boss-direct layer was BLIND
  on every map whose arena tiles use a separator — default pattern 'Arena\d' missed 'SpringArena_01' -> centroid
  cached false -> explore had authority it should never have had. Fixed to 'Arena[_-]?\d' (live-verified: 81 tiles
  -> centroid (3611,437), 35-leg route). Lesson for the navigator: boss belief must LOG what it found and why
  (`[Nav] boss belief: arena tiles=81 centroid=(x,y)` / 'NONE — patterns matched 0 of N tile keys') so a blind map
  is visible in one log line instead of a week of yoyo forensics.
- **PLAN**: a waypoint route computed ONCE on commit (macro graph + frontier extension across fog). The walker
  executes legs (existing senders/stepPathWalker/dodge/MB/OB untouched). RE-PLAN ONLY ON EVENTS: leg stuck
  (record blocked edge first), objective invalidated/completed, major reveal contradicting the plan, preemption
  end. No per-tick re-derivation -> the pick-burst perf cost disappears with the churn.
- **CONSUMERS**: FINDING_BOSS explore, post-boss discover, coverage sweep all call the same navigator with
  different objective filters — three phases, one brain. The seven mechanisms + their guards COLLAPSE into model
  properties (trail=visited overlay, forward-bias=objective choice, phantom/partial=plan-time graph checks,
  landmarks=POIs, frontier-crawl=plan legs).

## 5. Migration (staged, each reviewable, no big-bang)
- **26A — navigator skeleton, SHADOW**: navigator.js with world model + objective + plan + event log; runs
  alongside the live stack, logs `[Nav] would-go (x,y) via N legs (reason)` each re-plan event. Zero behavior
  change. Sidecar persists the model. ~2 sessions of shadow logs calibrate scoring vs live behavior.
- **26B — flip FINDING_BOSS explore** to the navigator (const NAV_ON). Legacy explore stack stays flag-off.
- **26C — discover + coverage onto the navigator** (same flag).
- **26D — DELETE the legacy stack** (pickers, biases, guards, ban maps) = the promised cleanup, arriving as the
  natural last step instead of a separate risky pass. Module split continues from here (navigator.js is module #1).
- Interim: TASK-25 (persist boss hints) is SUBSUMED by 26A's model persistence — not run separately.

## 6. What this does NOT touch
Content runners (abyss/breach/stone/sweep/hive), OB/MB brokers, the opener/pickit yield system, dodge, boss
fight — all consumers of movement, unchanged. The navigator replaces only "where to walk when exploring."
