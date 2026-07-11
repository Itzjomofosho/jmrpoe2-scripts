# TASK-23 — Half-state map RESUME (persist per-map state across reload) + forward-biased explore

USER RULING (2026-07-11, hard requirement): "U HAVE TO BE ABLE TO RESUME HALF STATE MAP." A mid-map
Uninject->Inject reload currently wipes all JS per-map state: the anti-backtrack trail, bans, registries, sweep
sites. Live result (Spring_ 19:18): trail read wf=0.08 everywhere -> explore walked BACK across the map. Also:
the "exploring backwards" complaint PREDATES the reload (map-1) -> fix the heuristic too, not just persistence.

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\opener.js` into `handoff\pre\TASK-23\`.

## A. Per-map state sidecar (mapper.js + a small opener.js export/import)
Persist ONE file, `map_state.json` (fs.writeFile — the map_audit.log precedent; same data dir), holding the
CURRENT map's resumable state. Envelope: `{ areaId, terrainW, terrainH, savedAt, ...state }`.
- WRITE: throttled every ~15s while in a map state (cheap JSON of bounded structures), plus once on mapper
  disable. NEVER write during HIDEOUT_/IDLE.
- RESTORE: at map-entry detection (the [MapStart]/audit-START site), read the file; restore ONLY if areaId AND
  terrain dims match AND savedAt < 3h old (a re-rolled same-name map regenerates terrain -> dims mismatch ->
  fresh). Log `[Resume] map state restored (trail=N, bans=..., beacons=...)`; audit line says RESUME not a bare
  second START.
- DELETE/blank the file at MAP END (logMapSummary flush / hideout reset) so a finished map never leaks state.
- WHAT PERSISTS (bounded, serializable): `visitedTrail` (Map int->ts), the frontier-visited reveal grid,
  `energisedBeacons` + `beaconChestDwellDone`, `abyssSweepSites`/`abyssSweepLooted`/`abyssSweepCnt`/`abyssSweepDone`,
  `stoneBlacklist`, `ignoredUtilityTargets` + `_utContestedCount`, `_unexpFailed`, `deliriumBlacklist`, and the
  opener's `openBlacklist` (export a serialize/restore pair from opener.js — banned entries + attempt records).
- WHAT MUST NOT PERSIST: any live commitment/target (OB records, arb keys, utilityActiveTarget, stoneKey,
  abyssId, breach state, paths) — those recompute; restoring them would resurrect stale pointers. State only,
  never goals. Say the exact restored-field list in the report.
- Failure-safe: unreadable/corrupt file -> log once, run fresh (today's behavior). Const `MAP_RESUME_ON = true`.

## B. Forward-biased explore (mapper.js) — the actual "backwards" fix
Bias the explore bucket choice DIRECTIONALLY toward a FORWARD BEARING; a candidate whose bearing from the player
is >90° off it gets a score penalty (soft — NOT a hard filter: a map whose only unexplored mass is behind must
still route there eventually). The forward bearing, in priority order:
  1. LIVE BOSS HINT/anchor (bossTgt/arena cache — the walker's own anchors): player->boss bearing.
  2. NO HINT YET (user screenshot, corridor map): the MASS-WEIGHTED CENTROID of getUnexploredBuckets — "the only
     way to go is northeast" is just arithmetic when all remaining mass sits northeast; computed from the bucket
     list the pickers already fetch (no new reads), cached with the picker's own throttle.
Rear pockets left behind are the POST-BOSS coverage sweep's job now (mass-driven since TASK-14) — pre-boss
explore pushes toward the boss/the mass. Apply in pickUnexploredHeading's scoring (and the route picker's score
if trivially compatible with the trail-bias term — do not fight TRAIL_ROUTE_K, compose with it: trail says
"not where I've walked", forward says "toward where the map still is"; on this screenshot both point northeast).
Tunable `EXPLORE_FWD_K`; separate const `EXPLORE_FWD_ON = true` (independent rollback from part A).

## Hard limits
- Files: mapper.js + opener.js only. No OB/arb changes. Writes throttled (>=15s) + bounded (trail can be large:
  cap serialization at ~20k entries, drop oldest). No new native reads.
- Flag-off parity per const. Restore never runs mid-map (only at the entry-detect site).

## Acceptance
- `node --check` both; parity walks.
- Report per HOUSE_RULES + live-test checklist: mid-map Uninject->Inject -> `[Resume] map state restored` with
  non-zero trail; explore does NOT walk back across cleared ground; a used shrine/banned target is not re-tried;
  energised beacons stay done; audit shows RESUME; a FRESH map (no file / mismatch) starts clean; pre-boss
  explore picks buckets toward the boss hint (log the bias when it flips a pick).
