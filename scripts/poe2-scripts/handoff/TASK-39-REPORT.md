# TASK-39 REPORT — THE NAVIGATOR (EXPLORE-REDESIGN 26A+26B, one flag)

Status: IMPLEMENTED, runtime dir only, `node --check` clean on both files, NOT committed, awaiting live test.
Pre-snapshot: `handoff\pre\TASK-39\mapper.js` (diff base; navigator.js is NEW, no pre).

## Files touched

### NEW `navigator.js` (~620 lines) — module #1 of the split
Exports (all consumed by mapper.js only):
- `navConfigure(bus)` — receives mapper accessors (bus pattern; navigator never imports mapper).
- `navCurrentWaypoint(player, now)` — THE interface: refresh model -> evaluate objective -> serve current
  plan leg. Returns `{x, y, ox, oy, status}` (leg to walk + committed destination) or null.
- `navOnLegStuck(player, now)` — walker's stuck/dislodge feed: records the blocked-edge fact, then replans.
- `navSerialize()` / `navRestore(payload)` — sidecar payload (boss belief, blocked edges/cells, unroutable
  facts, poiDone, committed objective, last heading).
- `navReset(reason)` — per-map wipe (called from resetMapper; area-change self-guard also inside).
- `navAddPoi(gx, gy, kind, key)` — the TASK-38 sleeping-entity insertion point (unused for now).
Internal: `_refreshBossBelief/_refreshRegions/_refreshPois/_refreshModel`, `_candidates`,
`_incumbentScore`, `_regionRemainingMass`, `_regionEntryPoint`, `_buildPlan`, `_commit`, `_dropObjective`,
`_evaluate`, `_recordBlocked`, `_routeCrossesBlocked`, `_suppressBoss/_bossSuppressed`.

### `mapper.js` (integration + persistence; 53 insertions, 3 lines modified)
1. import navigator (top).
2. `const NAV_ON = true` (after the EXPLORE_FWD flag cluster, ~line 2060).
3. FINDING_BOSS Strategy-5 explore branch: new `} else if (NAV_ON) {` arm BEFORE the legacy explore
   else-block (the legacy block is byte-untouched inside the final else). The arm: navCurrentWaypoint ->
   `startWalkingTo(..., 'Nav Explore', 'boss')` -> `stepPathWalker()`; `'stuck'` -> softblock + clear path +
   `navOnLegStuck`. Publishes the committed destination into `exploreTgtX/Y` so the S5 backward-mob guard
   keeps filtering against it. No-objective -> stop + PAUSED status + throttled `[Nav] no objective` line.
4. `serializeMapState`: `nav: navSerialize()` field (try-wrapped). `applyMapState`: `navRestore(env.nav)`,
   summary gains `nav(edges=…, facts=…, obj=…)`.
5. `resetMapper`: `navReset(reason)`.
6. `getBossArenaCentroid`: cache object gains `size: cl.size` (tile count; densestClusterCenter already
   computed it and it was being dropped) — feeds the mandated `tiles=N` belief log. Additive, no reader breaks.
7. Utility far-boss-drive openable cap regex: `Nav Explore` added alongside `Boss Explore`
   (tryStartUtilityNavigation ~10024). Parity-safe: the name cannot occur when NAV_ON=false.
8. `navConfigure({...})` bus wiring at module end: log, getBossArenaCentroid, getBossRoomMarker,
   getRadarBossTarget, stored bossCkpt, bucketTouchesRevealed, trailLineFrac, contentQueue.

## Settings added
- `NAV_ON` (const in mapper.js, default **true**). Flip to false in-file = full rollback: the `else if` arm
  is never entered, the legacy explore stack runs byte-identically. No UI toggle (matches the
  CORRIDOR_LATCH_ON / TRAIL_BIAS_ON const-flag idiom).

## Objective scoring (acceptance requirement)
ONE function, one scale, evaluated ONLY on nav-owned explore frames:
- **boss** (belief conf >= 0.7): `900 + 100*conf` — structurally dominates everything. Suppressed 45s after
  reached / corridor-exhausted / 3x-stuck, lifted early if the belief moves >120u.
- **poi**: `380 − 0.22·dist − 60·trailFrac(player→poi)`.
- **region** (chunk): `0.55·min(mass, 900) − 0.22·dist − 60·trailFrac + rearPenalty`
  (rearPenalty = dot·0.25·massTerm when the region sits behind the last committed heading; soft — a lone
  rear region still wins = "forward/nearest next chunk").
Calibration intent: a real quest-marker destination beats a plain frontier region (350u POI ≈ 292 vs a
400-mass region at 300u ≈ 154); a big close region beats a far POI (900-mass at 200u ≈ 451 vs 700u POI ≈ 226);
boss beats all. Hysteresis: challenger must beat the incumbent by `max(40, 0.3·|incumbent|)` on **2
consecutive evaluations** (2.5s cadence), never within 4s of a commit. Completion/invalidation switches
immediately. Evaluations, model refreshes (buckets 3s / POIs 2s / belief 3s) and route computation (commit +
events only) are all throttled — there is no per-tick picker work left on nav frames.

Chunk explore: regions = connected components of `getUnexploredBuckets` (single-link, link = grid pitch ×1.7,
input capped at 512 largest with a log line). Committed chunk = 350u disc around the region centroid; explore
entry-bucket by entry-bucket (`replan (chunk step)`) until remaining mass < `max(120, 0.2·initialMass)`.

## Blocked-edge facts
- A stuck/dislodged leg records `edge (player)-(leg)` (count-keyed Map, for the log + serialization) **and**
  the midpoint 48u cell into `blockedCells` (the enforceable form — macro-route waypoints never reproduce our
  exact endpoint pair, so plan-time checks sample route segments at half-cell steps against blockedCells).
- A partial macro route (ends >150u short) records the fact at PLAN time — zero walk wasted — and the target
  cell goes into `unroutable` (permanent for the map).
- Both persist in the sidecar; the same wall is never TTL-re-learned. 3 stucks on one plan invalidate the
  objective (boss -> 45s suppression; others -> target cell recorded unroutable).

## Deviations from EXPLORE-REDESIGN.md / the brief (all flagged)
1. **Boss belief is NOT resolveBossBearing.** Tiers used: arena tgt-centroid (0.9) > BossRoom marker (0.85) >
   stored boss-ckpt (0.85) > radar (0.8) — side-effect-free reads via the bus. resolveBossBearing's
   explore-landmark (0.7) / arena-hint (0.5) / fog-anchor (0.3) fallbacks are nav *targets*, not boss
   knowledge; consuming them would let a content marker impersonate the boss destination. The navigator has
   POIs as first-class candidates instead. (resolveBossBearing still runs at the S5 top for the elite
   on-the-way gate — that machinery is unchanged.)
2. **"Major reveal contradicting the plan"** has no dedicated detector in this skeleton; it is covered by
   the region-completion check (mass collapse), the off-route replan (>180u from the next 4 legs — also the
   preemption-end event), and chunk-step replans. Say the word if you want an explicit reveal-diff trigger.
3. **Blocked edges can't re-weight the macro router** (no C++ edge-weight API, and no new bindings allowed):
   a non-boss plan crossing a known blocked cell skips that CANDIDATE for the evaluation (routes around by
   choosing elsewhere); a boss plan keeps its corridor (boss-approach failure is owned by the mapper's
   checkpoint gates/cooldowns, as today).
4. **Walk-target name is 'Nav Explore', not 'Boss Explore'** — deliberately: 'Boss Explore' carries the
   1-strike fast-abandon in stepPathWalker; plan legs want the 3-strike + the (name-independent) 8s
   net-progress dislodge, feeding blocked-edge learning instead of target re-rolls. It still matches the
   `.includes('Explore')` utility gate and the `/Explore|Discover/` owned-progress guard.
5. **mapper.js touches slightly beyond "integration + persistence"**: the `size` field on the arena-centroid
   cache (mandated `tiles=N` log) and 'Nav Explore' in the far-drive openable regex (utility behavior parity
   while nav drives). Both additive; neither reachable with NAV_ON=false.
6. Objective has **no TTL by design** (the plan persists — that is the point). The only wall-clock timer is
   the 45s boss suppression, armed exclusively at nav-owned events (reached/exhausted/3x-stuck).
7. The elite/mob-chase branches of Strategy 5 (and everything above them: arena fast-path, fog-latch,
   radar-explore, arena-hint) are **not** flipped — the brief scopes the flip to the explore decision, and
   those are engage/approach behaviors, not explore pickers.

## Flag-off parity notes
`NAV_ON=false`: the new arm is dead code; legacy explore byte-identical. Residual flag-off deltas, all inert:
the sidecar gains a `nav` field (ignored by old readers; navRestore only mutates navigator-internal state),
navReset clears navigator-internal state nobody reads, the centroid cache carries an extra `size` field.

## LIVE-TEST CHECKLIST (Cliffside = acceptance map)
Working looks like:
1. Map entry: exactly one `[Nav] boss belief: <src> centroid=(x,y) conf=C tiles=N`
   — or `[Nav] boss belief: NONE (patterns matched 0/N tile keys)` on a blind map (the SpringArena_ lesson).
2. First explore frame: `[Nav] objective <kind>@(x,y) committed (score S, over N candidates)` then
   `Walking to Nav Explore at (...)` and `[Nav] leg 1/N -> (x,y)`; legs advance in order.
3. **Zero unexplained heading changes**: every objective change has one of —
   `[Nav] objective switch <old> -> <new> (outscored ... on 2 evals)` / `(reached)` / `(marker gone)` /
   `(region explored ...)` / `(3x leg stuck)` / `(boss corridor spent|exhausted)` / `(region residual at feet)`.
   No direction reversals while one objective is committed.
4. Replans ONLY as `[Nav] replan (leg stuck | chunk step | off-route (preemption end) | boss belief moved |
   restored) -> N legs to ...` — named events, never a silent re-derive.
5. Stuck: `[Nav] blocked edge (a)-(b) recorded (leg stuck; N facts)` — N accumulates; the SAME wall never
   produces fresh learning twice (watch: fact count should grow then plateau, not churn).
6. [Ckpt]/content/utility/dodge yields fire exactly as before; on return either no [Nav] line (plan intact —
   the common case) or a single `replan (off-route (preemption end))`.
7. Reload mid-map: `[Resume] map state restored (..., nav(edges=N, facts=M, obj=<kind>))`, then
   `[Nav] boss belief: ... (restored)` and `[Nav] replan (restored)` — walk resumes toward the same objective.
8. Perf: the 25-101ms mapper frames at pick moments should be gone ([DrawProf] spot-check if handy).
9. Boss still found + engaged (arena fast-path/checkpoint/melee flow unchanged upstream).

Broken looks like:
- `objective switch ... (outscored ...)` more often than ~1/min → hysteresis mis-tuned; paste the score lines.
- `PAUSED: navigator has no objective` while the map is visibly unexplored → region/POI model failure; paste
  the preceding `[Nav]` lines.
- `replan (chunk step)` spamming (more than ~1 per 10s sustained) or commit/drop loops on one region.
- Any walk-direction flip with no `[Nav] objective switch` line = the exact disease this task exists to kill.
Rollback: `NAV_ON = false` in mapper.js (live-reload picks it up).

## Risks
- Scoring constants are first-cut calibrations (documented above) — expect one tuning pass from live logs.
- Region completion depends on the C++ reveal grid actually draining bucket counts as we walk; the
  "residual at feet" guard covers the lag case by consuming the chunk.
- A restored objective whose plan can't rebuild drops cleanly to re-evaluation (`restored objective
  unroutable`) — worst case is one fresh pick after reload, never a wedge.

## Open questions / pre-existing finds (not touched — parity)
- `getExploreLandmark` (mapper ~14047) references an undeclared `bestFwd` in its commit log line →
  ReferenceError swallowed by the function's try/catch on EVERY fresh landmark commit: the
  "[Explore] landmark commit" line never prints and the committing call returns null (the held-marker path
  recovers next call, so it half-works). Legacy-only; also means resolveBossBearing's landmark tier misses on
  the first call after each re-pick. Left as-is (byte-parity rule) — planner may want a one-line fix task.
