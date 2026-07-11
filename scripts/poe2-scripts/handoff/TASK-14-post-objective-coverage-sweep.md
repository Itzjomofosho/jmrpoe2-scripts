# TASK-14 — Post-objective coverage sweep: clear the map, don't corner-ping (user ruling 2026-07-11)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-14\`. File: `..\mapper.js` only.

## Problem (live, MapExcavation re-entered already-complete)
Audit proves the map entered `main="Map Completed" required=[]` (boss killed a prior run). Correctly MAP_COMPLETE.
But then, with only an unreachable/banned incursion-beacon left, the post-complete discover-explore walked to
map-EDGE coordinate guesses (`(1186,159)`,`(323,159)`,`(755,159)` — the y=159 top row, patrol spokes), never
routed to the actual unexplored mass, never cleared packs, and was slow to concede/portal — ~75s of "doing fuck
all while there's so much map to explore." User ruling: on an objective-complete map, do a bounded COVERAGE-CLEAR
(explore the real unexplored mass + kill packs + do reachable listed content), then portal — concede fast on
unreachable content, never corner-ping.

## ALSO in this task — default the Objective Broker ON (user ruling 2026-07-11: "fix-forward")
Flip `DEFAULT_SETTINGS.objBroker` from `false` to `true` (search `objBroker:` in DEFAULT_SETTINGS). OB is now the
committed default, not a shadow opt-in — it is already live in the user's session (`[OB] ... flag=on` in logs).
The `OB_SHADOW` const + the UI checkbox stay as the rollback path (fix-forward, not revert-to-shadow). NOTE in the
report: a saved settings file with an EXPLICIT `objBroker:false` will still override the default — the user's
current profile already has it true, so no action needed, but a fresh profile now gets OB on. Do NOT change
`OB_SHADOW` or any OB behavior — only the default.

## What ships (mapper.js, MAP_COMPLETE flow; const kill-switch, no user setting)
`const COVERAGE_SWEEP_ON = true;` — flag-off restores today's discover/portal behavior byte-for-byte.
`COVERAGE_SWEEP_BUDGET_MS = 180000` (per-map, anchored at first coverage frame; reset in resetMapper).

Order inside MAP_COMPLETE (keep the existing pieces; insert coverage between cleanup and portal):
1. `tryCleanupContent` (reachable listed content) stays FIRST and unchanged — a reachable incursion/breach still
   gets done exactly as today.
2. COVERAGE SWEEP (new, replaces the discover-patrol corner-guessing as the "nothing reachable" driver): when
   cleanup drives nothing, drive `pickRouteNearestBucket(player, now)` — the fog-independent ROUTE-nearest
   unexplored-MASS picker (NOT the discover patrol spokes) — toward the largest routable unexplored mass. Walk it
   via the gated senders; entity_actions clears packs en route automatically; revealing the map feeds cleanup
   (a revealed incursion beacon becomes reachable → step 1 drives it next frame). Sticky commit per bucket (no
   re-pick mid-walk), owned-progress bounded, macro-routed like the pre-boss walker.
3. CONCEDE + PORTAL when ANY of: coverage budget spent; OR `getUnexploredBuckets` returns no mass above a small
   threshold (map substantially revealed) AND the only queued content is banned/unreachable
   (`revisitSkip`/`_unexpFailed`); OR the existing cleanup concede fires. Do NOT wait out 60s bans on unreachable
   OPTIONAL content — if coverage has revealed the map and the beacon still can't be reached, portal.

## Also fix (the slow-concede half)
The discover-for-unfound-listed-content path (search `tryDiscoverListedContent` / `hasUnfoundListedContent`)
currently keeps the cleanup gate open on a banned/unreachable listed type for its full window. When the listed
type's queue entry is `revisitSkip`-banned AND coverage has revealed the local area (no adjacent unexplored mass),
concede it fast (~15s) instead of the 40-90s discover window — the coverage sweep is now the map-reveal mechanism,
so discover no longer needs the long patrol.

## Hard limits
- Applies ONLY when the map objective is COMPLETE (MAP_COMPLETE). Never touches the pre-boss flow, the
  strict-finish never-leave-incomplete gates, the boss-approach chain, or the abyss/breach runners.
- Coverage MUST always terminate to portal — the budget + revealed-map exit are the guarantees; no unbounded state.
- Gated senders only; no new entity scans beyond the existing bucket/cleanup reads. Reuse
  `pickRouteNearestBucket`, `getUnexploredBuckets`, `tryCleanupContent`, the portal phase.
- Trail bias already steers bucket picks away from walked ground — coverage inherits it for free; don't re-implement.

## Acceptance
- `node --check mapper.js`. Flag-off (`COVERAGE_SWEEP_ON=false`): byte-parity with today.
- Report per HOUSE_RULES + live-test checklist: on an objective-complete map with unexplored mass, the bot routes
  to the big unexplored areas (`[Coverage] -> mass (x,y)` style log, NOT y=edge patrol spokes), clears packs,
  reveals + does any reachable content, and portals within the budget instead of corner-pinging. An unreachable
  banned beacon concedes fast, not after 60s.
