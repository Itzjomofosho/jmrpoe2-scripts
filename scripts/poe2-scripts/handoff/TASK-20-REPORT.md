# TASK-20 REPORT — Shared picker phantom filter + pre-boss explore routability

Implementer session. `..\mapper.js` ONLY. Pre-snapshot: `handoff\pre\TASK-20\mapper.js` (copied FIRST, before any edit).
TASK-21 confirmed ACCEPTED/closed in QUEUE.md before starting (single-writer rule).

## Setting added
- `PICKER_PHANTOM_ON` (const, **default `true`**), defined next to `TRAIL_BIAS_ON` (~line 1786). One-token rollback.
  - `false` => all three changes vanish, **byte-identical control flow** to the pre-snapshot (verified by `diff -u`: every
    behavioral hunk sits inside `if (PICKER_PHANTOM_ON)` / `if (PICKER_PHANTOM_ON && …)`; the only unguarded additions are the
    inert const + comments).
  - NOTE (per brief): ON deliberately changes flag-*independent* discover/coverage behavior. That is the point of the task.

## Files touched
`mapper.js` only. Net: +52 lines, −0 (pure additions, all guarded). No existing line removed or altered.

## What changed (by symbol/site — searchable)

### 1. Phantom filter in the shared picker — `pickRouteNearestBucket` (grep `PHANTOM-MARGIN FILTER (TASK-20)`)
Inside the candidate-collection loop, immediately after the `_unexpFailed` ban check and **before** the mass-scoring
loop, added:
```js
if (PICKER_PHANTOM_ON && !bucketTouchesRevealed(b.x || 0, b.y || 0)) continue;
```
So a phantom-margin bucket (no revealed neighbor) never enters `cands`, never contributes to the `mass` sum, and can
never be returned. Mirrors the filter `pickUnexploredHeading`'s `pickBest` already carries (line 6558). Ordering matches
`pickBest` (phantom check *after* the distance + ban skips, so banned/near buckets don't pay the ~17 `isWalkable` probes).
- **Coverage's local guard LEFT IN PLACE** (`tryCoverageSweep`, `PHANTOM-MARGIN GUARD`, ~line 5527): now redundant-but-
  harmless (defense in depth), NOT refactored out — per brief hard-limit.

### 2. Routability at pick time — partial-route ban ported into the two pickers that lacked it
**Root cause (grounded in C:\tmp\log.txt 17:36–17:38, Spring_):** both evidenced failures are the SAME bug — a *partial*
macro route (length≥2 but dead-ending far short of the target). `pickRouteNearestBucket` already bans this (the
`_re`/`>150u` end-distance guard, ~line 6733), but `pickUnexploredHeading` and `getExploreLandmark` accepted it, so the
bad target was committed and only banned by a *walk* backstop:
- `(776,465)`: `[Explore] unexplored heading -> (776,465)` @17:36:44 → `bucket (776,465) unreachable -> blacklist 3min`
  @17:37:19 = the **20s walk backstop** (line 6668), ~35s wasted.
- `(2277,552)`: committed as landmark, walked as "Boss Explore" → `landmark (2277…,552…) no progress 25s -> ban, next`
  @17:38:36 = the **25s no-progress backstop** (getExploreLandmark line 12395), ~1m52s wasted.

Fix = port the existing end-distance guard (route end must be within 150u of the target, matching `pickRouteNearestBucket`)
into the three pick-time probe sites, banning at PICK and letting each site's existing loop re-pick:

- `pickUnexploredHeading` **bias path** (grep `PARTIAL ROUTE (TASK-20)` #1): after the `!_r || _r.length < 2` block →
  `_unexpFailed.set(bkey(cand), now + 300000)` + `[Explore] bucket (x,y) partial route Nu short -> banned at pick`; the
  `_try < 6` loop `continue`s to the next candidate.
- `pickUnexploredHeading` **non-bias path** (grep `PARTIAL ROUTE (TASK-20)` #2): identical guard, `_try < 3` loop.
- `getExploreLandmark` **fresh-pick loop** (grep `PARTIAL ROUTE (TASK-20)` #3): after `!_route || _route.length < 2` →
  `_exLmSeen.add(c.m.key)` (the landmark's existing map-local ban) + `[Explore] landmark (x,y) partial route -> banned at
  pick, next`; the `_lmCands.slice(0,5)` loop `continue`s.

**No new `macroPathTo` calls.** Each guard reuses the route the picker *already fetched* one line above — so the "≤2 router
probes per pick pass" budget is satisfied by construction (0 added). Existing per-pass probe counts (6 / 3 / 5) unchanged.
Existing walk-based backstops (line 6668, line 12395) untouched — they remain the backstop, per brief.

### 3. Verify `pickUnexploredHeading`'s phantom filter (part 3, no blind edit)
**CONFIRMED present and COMPLETE.** The filter is `if (!bucketTouchesRevealed(b.x||0, b.y||0)) continue;` inside `pickBest`
(line 6558). Every fresh-pick path routes through `pickBest`: the bias loop `pickBest(_seen)`, the non-bias loop
`pickBest()`, and the progress-guard re-pick (`best = pickBest()` ~line 6670). The only path that skips it is the sticky
`_unexpCache` hold — correct, because that bucket was vetted by `pickBest` when first committed and re-vetting a held
commitment mid-walk would violate commitment discipline. No extension needed.

## Deviations from the brief (with why)
1. **Probe site = inside the pickers, not at external consumer call sites.** The brief phrased part 2 as "`pickUnexploredHeading`
   consumers + the landmark commit site." The log proves both bad commits originated *inside* the pickers (which already run
   `macroPathTo` but accept partial routes), so the surgical fix is to strengthen that existing pick-time acceptance test.
   Fixing inside the pickers covers **all** consumers at once (the FINDING_BOSS explore at ~14152 and the fog-blocked
   `tryCleanupContent` reveal at ~5150 both consume `pickUnexploredHeading`), reuses the already-fetched route (0 new probes),
   and re-picks correctly via the pickers' own loops. Probing at a consumer would double-probe and — because
   `pickUnexploredHeading` is 2s-cached — couldn't actually re-pick within the pass.
2. **Ban TTL = 300000ms (5min), not the brief's "3min".** My new bucket bans sit directly beside the existing pick-time
   graph-unreachable bans, which use `now + 300000`; a partial route is the same failure class, so it gets the same TTL for
   code consistency ("read like the surrounding code"). The 3min TTL the brief cites is the *walk-backstop* ban (line 6668),
   a different site. Flag-off makes this moot (no ban fires from new code).
3. **Farthest-marker fallback left unprobed.** In the FINDING_BOSS explore, if `getExploreLandmark` returns null the code
   falls back to the farthest boss/quest marker (~line 14133) and commits it without a router pre-check. I deliberately did
   NOT add a probe there: neither evidenced failure came from it, adding a probe into that already-delicate explore/crawl-clamp
   block risks regression, and the walk backstop still covers it. Flagged for the planner in case broader coverage is wanted.

## Live-test checklist
Run a normal session (a few maps, a fogged/maze map ideally). Watch `[Explore]` / `[Discover]` / `[Coverage]` lines.

WORKING looks like:
- **Pick-time partial-route bans appear BEFORE any long walk:** new lines like
  `[Explore] bucket (x,y) partial route <N>u short -> banned at pick` and `[Explore] landmark (x,y) partial route -> banned
  at pick, next` — emitted at the moment of the pick, NOT after a 25–35s walk.
- **The old walk-backstop bans become rare/absent for partial routes:** you should see far fewer
  `[Explore] bucket (x,y) unreachable -> blacklist 3min, exploring elsewhere` (line 6668) and
  `[Explore] landmark (x,y) no progress 25s -> ban, next` (line 12395) — those now fire only for the genuinely-pathological
  leftover, not for reachable-looking partial routes.
- **No constant-y map-edge picks** in `[Discover]`/`[Coverage]`/`[Explore]` across the session (e.g. no repeated y=159-type
  edge rows, no Excavation-style corner-pings). Discover on a freshly-fogged map should route to real interior mass on the
  first pass.
- The `[Coverage] mass (x,y) has no revealed neighbor (margin phantom) -> banned` line should now be **hit far less often**
  (the shared picker no longer *serves* phantoms; the coverage guard is now a redundant safety net).

BROKEN looks like:
- Bot stalls / stops exploring on a real map, or `[Explore]`/`[Discover]` goes quiet with unexplored mass remaining → the
  150u end-distance threshold may be over-banning legitimate long corridors (unlikely — same constant `pickRouteNearestBucket`
  has used in production). First remedy: set `PICKER_PHANTOM_ON = false` (instant rollback to today's behavior) and report.
- A flood of new `partial route … banned at pick` lines for buckets that were actually reachable → same over-ban signature.

## Verification performed
- `node --check mapper.js` → **SYNTAX OK**.
- Symbol grep: `PICKER_PHANTOM_ON` at 1 def + 4 use sites; 3 new `partial route` logs; `bucketTouchesRevealed` new call
  site present alongside the two pre-existing ones.
- `diff -u handoff/pre/TASK-20/mapper.js mapper.js` → all behavioral changes guarded by `PICKER_PHANTOM_ON`; flag-off byte-parity.

## Open questions for the planner
- Ban TTL: keep 5min (matches the adjacent pick-time bans) or force 3min per the brief's literal wording? (behavior-neutral
  while flag-off; both outlast a map's explore window).
- Do you want the farthest-marker fallback (~14133) probed too, or is the walk backstop acceptable there?
