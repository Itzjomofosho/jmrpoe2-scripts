# TASK-01 REPORT — Visited Trail: record + shadow scoring (roadmap steps 4+5, bias OFF)

Status: IMPLEMENTED, syntax-clean (`node --check mapper.js` passes), self-verified for flag-off parity, and run
through a 5-dimension adversarial multi-agent review (per-consumer parity + module correctness + global house-rules,
each finding then adversarially verify-refuted) that returned **0 confirmed findings**. Awaiting user live-test.
No commit (TEST-BEFORE-COMMIT).

## Files touched
- `c:\Games\jmr-poe2\scripts\poe2-scripts\mapper.js` (runtime only). Nothing else. No C++, no baseline, no repo.

## What shipped
A per-map coarse occupancy grid of actually-walked ground + walked-fraction queries, wired into the four explore
consumers. Recording is always on but behavior-inert. All bias behavior sits behind the new setting `trailBias`
(default **false**); with it false every consumer **computes + LOGS** walked-fractions but picks exactly what it
picks today (byte-parity). Flipping `trailBias` true (a later one-line validation task = roadmap step 5) activates
the soft/relative bias — that code is present and gated, not yet the default.

## Symbols added (searchable)
Trail module (inserted right after `lineWalkable`):
- `visitedTrail` (Map, key `cx*4096+cy`, value `Date.now()`), consts `TRAIL_CELL=16`, `TRAIL_CAP=4096`,
  `TRAIL_ROUTE_K=1.0`.
- module state `_trailPrevCX`/`_trailPrevCY` (segment anchor, reset per map); log throttles
  `_trailBucketLogAt`/`_trailRouteLogAt`/`_trailFrontierLogAt`/`_trailPatrolLogAt`.
- functions `_trailKey`, `_trailStampCell`, `_trailEvict`, `trailRecord(gx,gy)`, `trailHas(gx,gy)`,
  `trailLineFrac(x0,y0,x1,y1)`, `trailWalkedFrac(route)`, and `trailNextPatrolAng(player,now,ang)` (consumer-4 helper,
  defined just above `tryDiscoverListedContent`).

Wiring:
- Recording: `trailRecord(player.gridX, player.gridY)` immediately after `lastMapperLogicTime = now;` (the ~7Hz logic
  pass; player is guarded non-null a few lines up at the `if (!player || player.gridX === undefined) return;` site).
- Reset: `visitedTrail.clear(); _trailPrevCX = NaN; _trailPrevCY = NaN;` on the `contentQueue.clear()` line in `resetMapper`.
- Consumer 1: `pickUnexploredHeading` — the ROUTE-VERIFIED PICK commit loop (+ `pickBest` gained an optional `excl` set).
- Consumer 2: `pickRouteNearestBucket` — the router loop restructured into Pass-1 (route+ban) / Pass-2 (select).
- Consumer 3: `frontierTowardTarget` — per-ray `_wf` term.
- Consumer 4: `tryDiscoverListedContent` — the patrol-spoke angle picker via `trailNextPatrolAng`.

## Setting added
- `trailBias` in `DEFAULT_SETTINGS` (default **false**), placed next to `bossReachV2`.
- UI checkbox: **"Anti-backtrack: bias explore away from already-walked ground"** rendered next to the other explore
  toggles (right under "Draw content MARKERS…"), with a tooltip, persisted via `saveSetting('trailBias', …)` exactly
  like its siblings. Read everywhere as `currentSettings.trailBias === true` (opt-in; never `!== false`).

## Design decisions the brief asked me to record

### K for consumer 2 (route-nearest)
`TRAIL_ROUTE_K = 1.0`. The base score is `mass/(routeLen+20)`; structurally `mass` is a sum of unexplored-bucket
counts (tens to low hundreds) over `routeLen+20` (~30–80), so the base runs roughly **~1–6**. Per the brief
(K ≈ 0.35 × typical score magnitude), 0.35 × ~3 ≈ **1.0**. Since `(wf − minWf) ∈ [0,1]`, a fully-rewalked candidate
is shifted down by at most 1.0, i.e. K reorders only candidates whose base scores are within ~1.0 of each other
(near-ties) — the intended effect. **This is an estimate, not a live-observed magnitude.** To let step 5 calibrate it
without guessing, the route-nearest shadow log emits the real numbers every ~1s:
`[Trail] routeNearest base=X.XX wf=Y.YY minWf=Z.ZZ K=1 (shadow)`. If those base values come in much larger/smaller
than ~1–6 on real maps, retune K before flipping `trailBias` on.

### Route point-array shape (brief asked me to verify)
`macroPathTo`/`findPathBFS` routes are arrays of **`{x, y}` objects** (confirmed at `macroRouteCache[i].x`,
`route[route.length-1].x`, `_re.x`, and the bucket routing in both pickers). No shape mismatch found. `trailWalkedFrac`
reads `p.x`/`p.y` behind a `Number.isFinite` guard, so a malformed/empty entry is skipped rather than NaN-poisoning.

### Consumer 3 penalty is absolute, by the brief's own formula
Consumer 3 uses `score -= trailLineFrac(p,rayEnd)*90` (the brief's explicit per-consumer formula), not a
min-subtracted relative term. The soft/relative guarantee ("a lone backward corridor still wins") is delivered by
**bounding**: 90 sits well under the reach (≤220) + boss-ward (120) terms, so the only open corridor keeps winning
even when fully walked. Consumers 1/2/4 use their own relative rules (defer-vs-least-walked / `wf−minWf` / skip-then-
least-walked) as specified.

## Deviations / risks
1. **Eviction uses a median via sort, not a strict single O(n) pass.** `_trailEvict` collects the ≤4096 timestamps,
   sorts, and deletes everything ≤ median (drops ~half). It runs *only* on overflow, which is rare (~1500 entries/map
   typical), so the O(n log n) sort of ≤4096 numbers is microseconds and off the hot path. Faithful to the intent
   ("drop the oldest HALF"); mildly looser than the literal "one O(n) pass" wording. Flagging per house-rules.
2. **`_trailKey = cx*4096+cy`** is the brief's exact formula. Safe for PoE2 grid coords (non-negative, `/16` keeps
   `cx,cy` well under 4096). A stray negative coord could alias one cell — benign for a *soft* scoring grid (no
   correctness path depends on trail exactness), so I kept the brief's formula verbatim rather than widening the key.
3. **Consumer 1 bias-ON cost:** to evaluate up to 3 routable candidates it issues up to ~2 extra `macroPathTo` calls
   per pick (throttled to one pick / 2s by `_unexpAt`). Bias-OFF issues **zero** extra router calls — the `trailBias
   === true` branch is skipped entirely and the `else` is the original first-routable-wins loop verbatim (I verified
   `best=cand` is set in both the route-ok and macroPathTo-absent cases, and the `&& !best` stop is preserved), so no
   candidate the original wouldn't have touched ever gets banned. This was the single biggest parity trap; it is clean.
4. **Recording pauses during the opener/pickit moveLock yield** (the early `return` above the 7Hz site). Accepted per
   the brief — the player is near-stationary there; the next pass's segment-stamp bridges the gap.

## Flag-off parity summary (the #1 house rule)
With `trailBias` false/absent, every consumer is byte-identical to before:
- C1: sticky `_unexpCache` branch **untouched**; the `else` loop reproduces the original bans/commit exactly; only a
  throttled shadow log added. `pickBest()` (no arg) behaves as before (`excl` undefined → the `&&` short-circuits).
- C2: Pass-1 bans are identical in set + order; Pass-2 selects on `s.base` (== the old `score`) in survivor order with
  the same strict-`>` first-max tie-break; `discRouteBest` null-init unchanged.
- C3: the `_wf*90` term is subtracted **only** under `trailBias === true`; off = `score` unchanged → same ray wins.
- C4: `trailNextPatrolAng` returns exactly `ang + 1.7` when off, so `_discPatrolAng` and the downstream blacklist/
  concede path are unchanged; only a throttled shadow log added.
Trail stamps are **not** fed into `markFrontierVisited` / the reveal grid (kept a separate structure, per conflict #1);
the landmark/macro-corridor layer (rejected consumer 5) is untouched. No movement sends, no memory writes, no packets.

## Recording budget
`trailRecord` Bresenham-lite: `steps = min(6, max(|ddx|,|ddy|))`, 3×3 (9) cells per step → worst case **6×9 = 54**
`Map.set`/pass; typical 1–2 steps → ~9–18. No entity/terrain reads (positions only). Query cost: consumer 3 computes
`trailLineFrac` (≤12 lookups) only on scored rays (a handful) at ≤7Hz; consumer 2 computes `trailWalkedFrac` (≤32
lookups) per survivor (≤8) throttled to 2.5s; consumer 1 similar, throttled 2s. All well within the stated envelope.

## LIVE-TEST CHECKLIST
Run one full map with the plugin loaded, `trailBias` left **OFF** (default). Watch the console:

**Expect to SEE (working):**
- `[Trail] bucket wf(chosen)=X.XX (shadow)` at bucket commits during FINDING_BOSS exploration.
- `[Trail] routeNearest base=X.XX wf=Y.YY minWf=Z.ZZ K=1 (shadow)` when the route-nearest picker runs (post-boss
  discovery / far-bucket picks).
- `[Trail] frontier wf=X.XX (shadow)` during frontier-crawl walks (steer/discover fallback).
- `[Trail] discover patrol wf=X.XX (shadow)` only in the MAP_COMPLETE discover-patrol path (no fog frontier left).
- `wf` values should be ~0.0 early in a map and climb toward ~1.0 on ground you've re-crossed.
- Routes and every movement decision **identical to today** — the map should clear exactly as it did before this diff.
- No FPS delta on juiced/high-entity maps.

**Signs of BROKEN (report back):**
- Any `[Trail]` line repeating every frame / many times per second (throttles are 250ms–4s — spam = a throttle bug).
- The bot exploring **differently** than before with `trailBias` OFF (that would be a parity break — this must not happen).
- A `wf` that is always exactly 0.00 for the whole map after you've clearly re-walked corridors (recording not firing).
- Any `ReferenceError`/`TypeError` mentioning a `trail*` symbol.

**Optional bias-ON smoke (only if you want to preview step 5):** tick the new checkbox. On a loop-shaped map the
post-boss sweep should prefer a corridor *different* from the inbound path; on a linear/dead-end map the bot must still
turn around (the relative rule cancels when every candidate is walked-heavy). `[Trail] bucket … alts=[…]` will show the
alternative wfs it weighed. This is NOT this task's default and is not required for sign-off.

## Open questions
None blocking. The bias-ON tuning constants (K=1.0, the 0.7 bucket-defer threshold, the frontier ×90 weight, the 0.6
patrol skip threshold) are first estimates; the shadow logs above capture exactly the data needed to calibrate them
before `trailBias` is flipped on in step 5.
