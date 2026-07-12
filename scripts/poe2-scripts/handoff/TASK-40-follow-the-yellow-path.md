# TASK-40 — FOLLOW THE YELLOW PATH: expose RadarV2's real pathfinder to the navigator (2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\navigator.js` AND `..\mapper.js` into `handoff\pre\TASK-40\`. C++ edits
are staged for the user's rebuild per cpp-commit-discipline (repo c:\Games\jmrpoe2) — list every C++ file
touched in the report; nothing committed.
USE OPUS 4.8 with the live bridge for verification.

## The revelation (user screenshot, Cliffside 19:35)
RadarV2 DRAWS the correct route — the yellow dashed overlay path — from the char through the stair/roof
maze to the far POI, on its OWN pathfinder grid: fog-INDEPENDENT, HEIGHT-AWARE, full-map
(`[RadarV2] Path grid built: 4140x828 (area ..., height grid ok)` / downsampled `Pathfinder grid built`).
Meanwhile the navigator plans with `macroPathTo` (the tile graph), which is BLIND to elevation breaks —
on Cliffside it insists the south corridor connects (it does not), so every plan threads a dead end, the
char wall-slides, and the whole objective machinery starves. Two pathfinders disagree; the radar's is
right and already computes routes to checkpoints/transitions it caches per map
(`[RadarV2] Cached N transitions/POIs: checkpoint 'Checkpoint' @ ...`). The fix is to make the RADAR's
pathfinder the navigator's route engine, and its cached checkpoints first-class anchors ("what do we have
nearby: CHECKPOINTS (nearest) in UNEXPLORED area (proven)" — user).

## A. C++ — expose the radar pathfinder + POI cache to JS (poe2_wrap bindings)
1. `poe2.radarFindPath(fromX, fromY, toX, toY)` -> Array<{x,y}> (grid coords) | null — a route on
   MapRevealPlugin's pathfinder grid (the SAME machinery RebuildOverlayPaths uses, map_reveal_plugin.cc
   ~1935). Read-only, no overlay side effects. Bound the per-call cost (its own BFS cache / iteration cap —
   the overlay rebuild logs 250-750ms cache-miss costs; the binding must reuse the plugin's cache, not
   recompute per call — say in the report what the worst-case call costs).
2. `poe2.getRadarPois()` -> Array<{x, y, kind, name}> — the plugin's cached transitions/POIs (checkpoints,
   waypoints, area transitions) in grid coords.
3. Thread-safety per the existing plugin API patterns (these reads run on the JS tick; the radar rebuilds
   on area change). Follow the existing binding conventions in poe2_wrap.cc.
STOP-AND-REPORT if the radar grid is not reachable from the wrap layer without major surgery — describe
the coupling instead of forcing it.

## B. navigator.js — plan on the radar route, tile graph demoted to fallback
- `_buildPlan` uses `poe2.radarFindPath` as the PRIMARY router when available (feature-detect), macroPathTo
  as fallback (keeps working on an old DLL — flag-off/absent = current behavior).
- Blocked-cell checks and facts apply to radar routes exactly as today (a radar route can still be wrong
  about dynamic obstruction; facts stay).
- Leg spacing/downsampling unchanged (the radar route is finer-grained — downsample to ~80u legs as today).

## C. navigator.js — checkpoints as PROVEN anchors
- Feed `getRadarPois()` checkpoints/transitions into the model (a `poi` kind 'checkpoint', excluded from
  the content-marker filter — they are infrastructure, but PROVEN-walkable network nodes).
- Region entry selection: when a region has a checkpoint/transition inside its disc (or within ~150u),
  prefer it as the ENTRY target over raw fog buckets — the game guarantees a real path to a checkpoint.
- Do NOT teleport (checkpoint travel is a later feature); these are walk targets only.

## Hard limits
- C++: additive bindings only — no changes to the radar's own rebuild/draw logic. JS: navigator.js (+ the
  mapper bus line if getRadarPois needs plumbing). Feature-detect everything: the JS must run unchanged on
  a DLL without the new bindings (macroPathTo path). Flags: `NAV_RADAR_ROUTE_ON = true`,
  `NAV_CKPT_ANCHOR_ON = true`.
- Verify LIVE via the bridge before writing the report: one radarFindPath call from the char's position on
  Cliffside toward the east region, confirm the returned route follows the yellow overlay (up the NE), not
  the south dead end.

## Acceptance
- `node --check navigator.js mapper.js`; C++ builds (user rebuild); parity with bindings absent.
- Report per HOUSE_RULES + live checklist: on Cliffside from the stuck spot, the committed region's plan
  follows the radar route up the NE (legs visibly matching the yellow line); checkpoint-anchored entries
  logged (`[Nav] entry checkpoint@(x,y)`); no route through the south dead end; the walk reaches the east
  unexplored area.
