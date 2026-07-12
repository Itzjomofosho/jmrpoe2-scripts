# TASK-40 REPORT — FOLLOW THE YELLOW PATH (radar pathfinder + POI cache -> navigator)

Status: IMPLEMENTED. JS runtime-only edits live-reloaded; C++ **staged in the working tree, NOT committed**
(cpp-commit-discipline). `cmake --build build --config Release` **compiles and links clean** — the rebuilt
DLL with the new bindings sits at `c:\Games\jmrpoe2\build\Release\jmrpoe2.dll`, ready for the user's inject.
`node --check` clean on navigator.js + mapper.js. Pre-snapshot: `handoff\pre\TASK-40\` (navigator.js + mapper.js).
**mapper.js was NOT modified** (getRadarPois needed no mapper plumbing — the navigator calls `poe2.*` directly,
same as getUnexploredBuckets/macroPathTo).

## A. C++ — files touched (all staged, uncommitted; tree was clean at ad68b90 so this is the whole diff)

1. `src\poe2\plugins\map_reveal_plugin.h`
   - public `static ComputeRadarPath(from_fine_x, from_fine_y, to_fine_x, to_fine_y)` declaration.
   - public `struct RadarPoiInfo { int x, y; std::string kind, name; }` + `static GetRadarPois()`.
2. `src\poe2\plugins\map_reveal_plugin.cc` (implementations placed before `SetExternalPaths`)
   - `MapRevealPlugin::ComputeRadarPath` — EXACTLY the RebuildOverlayPaths pipeline for one arbitrary
     (from,to): `EnsurePathGrid()` (rebuild only on area change) -> `path_grid_.GetOrCreatePathFinder(to)`
     (per-target BFS distance field, **cached in the plugin's own `path_grid_` cache, shared with the
     overlay**) -> `FindPath(from)` -> `SmoothPathLOS`. No overlay side effects, no draw/rebuild logic touched.
   - `MapRevealPlugin::GetRadarPois` — snapshot copy of `cached_transitions_front_` (kind:
     checkpoint | waypoint | transition | door), world->grid via the same 250/23 constant the overlay uses.
3. `src\poe2\poe2_wrap.h` — `RadarFindPath`/`GetRadarPois` declarations + `JS_FN("radarFindPath", …, 4, 0)`
   and `JS_FN("getRadarPois", …, 0, 0)` next to macroPathTo/getRadarPaths.
4. `src\poe2\poe2_wrap.cc` — `POE2Wrap::RadarFindPath` (returns **null** when plugin/grid/route unavailable,
   else Array<{x,y}> in FINE grid coords) and `POE2Wrap::GetRadarPois` (Array<{x,y,kind,name}>), modeled
   byte-for-byte on the MacroPathTo/FindPathTerrain marshaling conventions.

### Worst-case call cost (brief mandated)
- **First call to a NEW target**: one Dijkstra flood over the full-res grid, iteration-capped at 500k pops —
  the same bound behind the overlay's logged 250–750ms cache-miss rebuilds. That cost lands on the frame that
  calls it (one hitch), once per (target-cell, area).
- **Every later call to the same target** (the navigator's replans to its committed destination): cache hit
  in `path_grid_.pathfinders` -> `FindPath` gradient walk + LOS smoothing, O(path length), sub-ms to low-ms.
- **Checkpoint/transition targets are usually pre-flooded**: the overlay routes to the SAME integer grid
  coords getRadarPois returns (identical world->grid conversion), so the TargetKey matches and anchor routes
  are cache hits from the start.
- The navigator only routes at commit/replan EVENTS (throttled by TASK-39 design, <=4 door attempts per
  build), never per-tick.
- Memory: each cached flood on a >10k-cell grid stores a direction field of W×H bytes (~3.4MB on a
  4140×828 Cliffside grid) — same as every overlay target today; a handful of navigator targets per map on
  top; all freed on area change.

### Thread-safety (brief A.3)
No locks needed, and none added: `HandleWindowUpdate` (jmrd2r.cc) runs PluginManager::Tick (native OnTick +
JS onTick), env Tick + the debug-bridge JS drain, and PluginManager::DrawImGui (where DrawOverlay ->
RebuildOverlayPaths/EnsurePathGrid live) **sequentially on the one window thread** — the JS tick can never
overlap the grid rebuild. Same model the existing ComputeTerrainPath/ComputeMacroPath statics already use.
`GetRadarPois` reads `cached_transitions_front_` exactly as RebuildOverlayPaths does on this thread; the
back->front swap runs in HookedEntityDotLoop under the existing atomic-flag pattern (pre-existing, area-rare).

## B/C. navigator.js — symbols added/modified
- Flags (top of tunables): **`NAV_RADAR_ROUTE_ON = true`**, **`NAV_CKPT_ANCHOR_ON = true`**,
  `NAV_CKPT_ENTRY_EXTRA_U = 150`.
- `_viaTag()` NEW — appends ` via radar|macro|line` to commit/replan lines ONLY when the flag is on AND the
  binding exists (old DLL / flag off => TASK-39 log text byte-identical).
- `model.ckptAnchors` NEW field (+ reset in `_resetModel`) — radar checkpoints/waypoints; re-read from the
  radar cache each POI refresh, never persisted.
- `_refreshPois` — feeds getRadarPois **checkpoint + waypoint** kinds as POIs (key `ckpt:x:y`, kind kept),
  deliberately NOT run through the contentQueue filter (infrastructure); also fills `model.ckptAnchors`.
- `_regionEntryPoint` — PROVEN-anchor preference: nearest non-consumed, non-tried anchor within
  `NAV_REGION_DISC_U + 150` of the chunk center wins over raw fog buckets; <55u / poiDone / excluded anchors
  fall through to the bucket logic (unchanged below).
- `_buildPlan` — **radar route primary**: `poe2.radarFindPath` feature-detected; adopted only when it returns
  >=2 points AND ends within `NAV_PLAN_SHORT_U` of the target; otherwise macroPathTo exactly as before.
  Blocked-cell route checks apply to whichever route was adopted. Plan carries `via` + `anchorKey`; adopted
  anchor entries log **`[Nav] entry checkpoint@(x,y) 'name'`** (the mandated line; also fires for waypoint kind).
- `_commit` — committed line gains the `via` suffix.
- `navCurrentWaypoint` — a REACHED anchor entry is consumed (`poiDone.add(anchorKey)`) before the next
  chunk-step; without this the >55u filter re-admits it and the chunk walk ping-pongs (not in the brief —
  correctness addition, flagged).

## Facts semantics (unchanged by design)
macroPathTo remains the SOLE author of `unroutable`/route-short facts. A null/short radar answer is treated
as "radar unavailable for this target" -> macro fallback, NOT a fact: radar-empty can mean grid mid-build or
the 500k flood cap on huge maps, and a false permanent `unroutable` would ban a reachable region forever
(worse than today). Stuck-leg blocked-edge facts apply to radar routes exactly as to macro routes.

## Deviations from the brief (flagged)
1. **Live Cliffside radarFindPath verification could not run pre-report**: the bindings only exist in the
   rebuilt DLL, and the running game has the old one injected (bridge-verified:
   `typeof poe2.radarFindPath === 'undefined'`, macroPathTo present -> the absent-binding parity path is
   live-proven). The compile is verified instead, and the exact one-shot bridge check is step 0 of the live
   checklist below.
2. **'transition' and 'door' kinds are never walk targets** (brief said "checkpoint/transition"): a proximity
   area-transition can zone the char OUT of the map — the brief's own "walk targets only, do NOT teleport"
   constraint cuts against steering onto exits. They still flow through getRadarPois; flipping the one kind
   check in `_refreshPois` re-admits them if the planner disagrees. Waypoints (safe, proven) are included.
3. Radar-short routes fall back to macro instead of being walked as partial corridors (uniform rule, incl.
   boss; macro's partial-corridor boss behavior is unchanged).
4. Log suffix ` via …` on commit/replan lines — additive diagnosis surface for the acceptance ("legs visibly
   matching the yellow line"), suppressed entirely on old DLL/flag-off.
5. Anchor consumption on reach (see above).

## Flag-off / absent parity
- `NAV_RADAR_ROUTE_ON = false` -> route block runs the exact TASK-39 macro call; `_viaTag` returns '' (logs
  byte-identical).
- `NAV_CKPT_ANCHOR_ON = false` -> no radar POI feed, `ckptAnchors` stays empty, `_regionEntryPoint` anchor
  block skipped -> TASK-39 behavior.
- Old DLL + both flags true -> `typeof` gates fail -> macro path, empty anchors, old log text. **Live-verified
  this session** (game running the old DLL took exactly this path after the runtime file hot-reloaded; zero
  JS errors in the log).
- Sidecar payload unchanged (anchors are not persisted; `poiDone` already existed).

## LIVE-TEST CHECKLIST (Cliffside from the stuck spot = acceptance)
0. Inject the freshly built `build\Release\jmrpoe2.dll`. Then ONE bridge smoke test (eval_js):
   ```js
   const p = new POE2(); const lp = p.getLocalPlayer();
   const pois = p.getRadarPois();
   const ck = pois.find(x => x.kind === 'checkpoint') || pois[0];
   const r = ck ? p.radarFindPath(Math.floor(lp.gridX), Math.floor(lp.gridY), ck.x, ck.y) : null;
   return JSON.stringify({ pois: pois.slice(0, 8), route: r && { n: r.length, first: r[0], mid: r[Math.floor(r.length/2)], last: r[r.length-1] } });
   ```
   Working: pois lists the map's checkpoints (log cross-ref: `[RadarV2] Cached N transitions/POIs`), route
   waypoints trace the drawn yellow/colored overlay line (on Cliffside toward the east region: up the NE,
   NOT into the south dead end). null route with the maps closed/terrain unready is legit — retry in-map.
1. `[Nav] objective …@(x,y) committed (score S, over N candidates) via radar` — `via radar` on effectively
   every commit; `via macro` should be RARE (radar grid mid-build) and never sustained.
2. `[Nav] entry checkpoint@(x,y) 'Checkpoint_Endgame'` (or waypoint) when a committed region holds an anchor;
   then legs walk to it FIRST, then chunk-step into the fog buckets.
3. On Cliffside: the committed east-region plan's legs visibly follow the yellow overlay path (NE), and no
   plan threads the south dead end. The walk reaches the east unexplored area.
4. The same anchor never serves as entry twice (`entry checkpoint@` with identical coords repeating =
   consumption failed — paste the lines).
5. All TASK-39 checklist items still hold (named switches/replans only, blocked-edge facts plateau, resume).
6. Perf: a one-off `[RadarV2] RebuildOverlayPaths took Nms` right after a commit to a brand-new far target is
   the known flood cost (250–750ms worst case, once per target). Sustained repeats on one target = bug.
Rollback: `NAV_RADAR_ROUTE_ON = false` / `NAV_CKPT_ANCHOR_ON = false` in navigator.js (independent,
live-reload); the C++ bindings are inert while unreferenced.

## Risks / open questions
- The 500k flood-iteration cap could truncate routes on extreme grids (Cliffside's 4140×828 provably fits —
  the user's screenshot IS that flood reaching a far POI). If a monster map returns null radar routes for far
  targets, the macro fallback covers it; a cap bump would be a one-line follow-up.
- `FindPath` caps at 10000 steps ≈ 10000u of raw path before smoothing — far beyond any map diagonal; noted
  for completeness.
- The transition cache can hold stale entities after de-stream; getRadarPois passes them through (coords
  remain valid — the cache stores positions, not live reads). Reached anchors get consumed anyway.
- Verisium 5-map test + this task's live pass remain the user's commit gates (memory rule) — nothing
  committed anywhere, C++ diff awaits planner review + user rebuild/inject.
