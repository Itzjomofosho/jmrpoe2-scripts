# TASK-01 — Visited Trail: record + shadow scoring (roadmap steps 4+5, bias OFF)

Read `HOUSE_RULES.md` first. Full design context: `..\MAPPER_ROADMAP.md` section "### Visited Trail" plus the
step-4/step-5 entries and the "Visited-trail" bullets in the conflicts section. This brief is the contract; the
roadmap is the rationale. File to edit: `..\mapper.js` only.

## Problem (user's words)
"You are literally in a map that goes ONLY 1 direction and u proceed to run backwards" — the explore pickers have
no memory of ground already WALKED (fog-revealed is not the same thing), so they re-pick corridors we came from,
and the post-boss sweep re-walks the exact inbound path.

## What ships in this task
A per-map coarse occupancy grid of actually-traversed ground + walked-fraction queries + scoring hooks in the
four explore consumers. Everything observable in logs, nothing behavior-changing yet: new setting `trailBias`
defaults FALSE, and with it false every consumer computes + LOGS walked-fractions but picks exactly what it picks
today (byte-parity). Flipping `trailBias` to true (a later one-line task after live validation) activates the bias.

## Spec

### 1. Trail structure + recording (always on — inert, no flag)
- `const visitedTrail = new Map()` keyed `cx * 4096 + cy` where `cx = Math.floor(gridX/16)`, `cy = Math.floor(gridY/16)`
  (16u cells), value = `Date.now()` of last walk. Hard cap 4096 entries; on overflow drop the oldest HALF in one
  O(n) pass. Cleared in `resetMapper` (find the per-map reset block that clears `contentQueue`).
- Record once per logic pass: locate the mapper's ~7Hz logic-pass site (search `lastMapperLogicTime`) and, with the
  player in scope, stamp the SEGMENT from the previously recorded position to the current one (Bresenham-lite over
  cell space, <=6 cell steps covers a dodge roll between passes), stamping a 3x3 cell neighborhood per step
  (~one corridor width). Track the previous recorded position in module state; reset it per map.
- Budget: <=54 Map.set per pass worst case, typical ~9. No entity reads, no terrain reads — positions only.
- Note (roadmap conflict #3): recording pauses during the opener/pickit moveLock yield early-return — acceptable,
  the player is near-stationary there. Do not try to fix that.

### 2. Queries
- `trailHas(gx, gy)` -> boolean (cell lookup).
- `trailLineFrac(x0, y0, x1, y1)` -> fraction of <=12 evenly spaced samples on walked cells.
- `trailWalkedFrac(route)` -> same over a waypoint array, sampled at stride `max(1, len/32)` (<=32 lookups).
  Route points may be `{x,y}` objects (that is what `macroPathTo`/`findPathBFS` return — verify the shape where
  each consumer already consumes them).

### 3. Consumer hooks (ALL gated: compute + log always when in the code path; BIAS applied only if `currentSettings.trailBias === true` — which stays false)
Scoring rule everywhere (the anti-backtrack invariant): penalties are SOFT and RELATIVE — candidates are compared
by walkedFrac and the LEAST-walked candidate is never penalized, so on a dead-end map where every candidate is
walked-heavy the relative penalty cancels and the bot still backtracks. Never hard-exclude on wf alone.
1. BUCKET COMMIT loop (search `pickUnexploredHeading` / the `[Explore] unexplored heading` log): today it commits
   the first routable candidate. Evaluate up to 3 routable candidates; log
   `[Trail] bucket wf(chosen)=X.XX alts=[...]` (throttle ~1/4s). With bias ON (not this task's default): defer a
   candidate with wf>0.7 while a lower-wf routable one exists; commit the walked-heavy fallback if all 3 are heavy.
   CRITICAL (roadmap conflict #2): wf is a COMMIT-TIME-ONLY input — the sticky keep-committed branch
   (`_unexpCache`) must be completely untouched. No mid-walk re-evaluation.
2. ROUTE-NEAREST picker (search `pickRouteNearestBucket`): score becomes
   `mass/(routeLen+20) - K*(wf - minWfAmongCands)` with K sized so it reorders near-ties only (start K=0.35 of the
   typical score magnitude you observe in that function; state your chosen K in the report). Bias OFF: compute + log only.
3. FRONTIER FAN (search `frontierTowardTarget`): per-ray `score -= trailLineFrac(p, rayEnd) * 90` (stays well under
   the existing ~220 reach + ~120 boss-ward terms so a lone backward corridor still wins). Bias OFF: compute + log only.
4. DISCOVER PATROL spokes (search `tryDiscoverListedContent` / its spoke/heading picker): skip spokes with
   lineFrac>0.6 for one full rotation, then accept the least-walked. Bias OFF: compute + log only.
DO NOT touch the landmark/macro-corridor layer (roadmap rejected consumer 5) and DO NOT feed trail stamps into the
frontier-reveal visited grid (`markFrontierVisited`) — they are separate structures by design (conflict #1).

### 4. Setting
`trailBias` in the mapper settings (default false). Add the UI checkbox next to the other explore toggles if a
natural spot exists (search `drawLines` for the settings UI section); persisting via `saveSetting` like siblings.

## Acceptance
- `node --check mapper.js` passes.
- With the plugin loaded and a map running, `[Trail]` lines appear at bucket commits / route picks showing wf
  values; routes and behavior otherwise IDENTICAL to today (trailBias false).
- No new per-frame log spam (all `[Trail]` logs throttled).
- Report per HOUSE_RULES, including the K you chose for consumer 2 and any shape mismatches you found in route
  point arrays.
