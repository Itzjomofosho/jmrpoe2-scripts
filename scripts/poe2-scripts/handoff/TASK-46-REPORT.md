# TASK-46 REPORT — Abyss-chest servicing: opener convergence + post-boss starvation + second-instance discover

Pre-snapshot: `handoff\pre\TASK-46\` (mapper.js @ 2026-07-13 08:07, opener.js @ 2026-07-11 19:35 — post-TASK-44
files, per the sequencing note). `node --check` passes on both edited files. All edits runtime dir only, no
commits, no memory writes, no new packets/bindings.

## Files touched + symbols

### mapper.js
- **A** `abyssChestNear` — now returns the NEAREST-to-player unopened chest `{x,y,d}` (truthy) or `false`.
  Same 500ms cache (`_abSwChestAt/_abSwChestKey/_abSwChestVal`). All 4 existing call sites are truthiness
  contexts, so flag-off behavior is unchanged (see Risks 1).
- **A** `tryAbyssChestSweep` wait branch — behind `ABYSS_SWEEP_CHEST_WALK_ON`: after sweepLootStep (ordering
  kept, one movement writer), chest >12u from PLAYER → `startWalkingTo(walkableApproachPoint(chest), 'Abyss
  Chest Sweep', 'boss')` with the same repath discipline as the site-walk leg (1.5s throttle + 20u target
  drift + stuck→softblock); ≤12u → stand for the opener as today. One log per distinct chest (`s._cwLog`).
  HOLD_MS spawn phase untouched; site cap/ceiling unchanged.
- **A** `tryAbyssChestSweep` arrival leg — behind the same flag: the `unreachable (no progress...)` retire at
  d≤30u with a chest up tries the chest-walk ONCE before retiring (`s.chestTried` latch): enters the dwell with
  `s.arriveAt = now - ABYSS_SWEEP_HOLD_MS` (spawn hold skipped — chest already exists), fresh `_abSwTrack`,
  `clearOpenBansNear` like a normal arrival. Bounded by the existing site cap/ceiling.
- **C** `OB_COMPLETE_RELEASE_ON` (new const, near the OB consts) + two release sites: the flip-watch
  incidental-completion path (`abyssFlipWatch`) and the breach runner-done path (`[Breach] done` block) call
  `arbRelease(now)` when the completing entry IS the arb-committed one. `arbRelease` is exactly the arb path's
  own release (obArbRelease → `[OB] complete content:<key> (arb-release)` + clears `arbCommittedKey`).
- **D1** MAP_COMPLETE Phase 3.75 — behind `ABYSS_SWEEP_POSTBOSS_FIX_ON`: `tryAbyssChestSweep` attempt inserted
  after `tryCleanupContent` returns false and BEFORE `tryDiscoverListedContent`/`tryCoverageSweep`, holding via
  `break` like its neighbors. Phase 3.8 kept (services the sweep when the 3.75 gate is closed).
- **D2** `tryAbyssChestSweep` budget block — behind the same flag: (a) the pre-boss budget-defer `return false`
  now zeroes the head site's `startAt`/`arriveAt` + `_abSwTrack.key`; (b) belt-and-suspenders: the FIRST
  post-boss call (the `abyssSweepPostStartAt` seed) does the same reset, covering a defer whose pre-boss hook
  never ran again (boss engaged the same frame the budget expired).
- **E** `DISC_COMPLETED_SKIP_ON` (new const) + `_discCompletedPos` (per-drive-type completed positions, ≤64,
  reset per map in `resetMapper`) + `noteContentCompleted(e, now)` (records position + 10min `_unexpFailed`
  bucket ban) called at ALL SIX queue-completion sites (breach runner-done, abyss flip-watch, hive dwell-done,
  hive prune markerGone, beacon energised, generic id-signal done) + `hasConfirmedUnfoundContent(now)` (unfound
  listed type with ≥1 completed instance = CONFIRMED remaining instance).
  - marker-first pick: skips markers within 60u of any completed position (throttled `[Discover] skipping
    marker ... -- completed <type> instance there`).
  - discover window: `_discWindow` = full `DISCOVER_EXPLORE_MS` when `_unfound===2` OR confirmed-unfound (the
    40s phantom hedge now applies only to the zero-instances-ever-seen case, per the user ruling). The
    existing post-window "concede only when no routable mass" check + F = do-not-concede-while-routable.
  - `logMapSummary`: a type with all found instances done but the objective bit still incomplete logs
    `<type> d/t found (game lists more, unfound)` (skipped on LEFT flushes where the objective read is the
    new area, mirroring the boss= handling).
- **F** `PICKER_RADAR_ROUTE_ON` (new const) — `pickRouteNearestBucket` pass 1 validates each candidate with
  `poe2.radarFindPath` (feature-detected) BEFORE the macroPathTo call: no route or route ending >150u short
  (the existing macro partial-route tolerance) → 5min `_unexpFailed` ban + throttled `[Discover] bucket (x,y)
  radar-unroutable -> banned upfront`. ≤8 radar calls per 2.5s (the existing candidate cap). Once nothing
  routable survives, the picker returns null → discover's existing concede latch fires (replaces
  cycle-until-budget).

### opener.js (log-only)
- **B** `logChestSkip` (mirrors `logEssenceSkip`, own 5s throttle `_chestSkipLogAt`) at the three silent chest
  gates: (a) abyss 25u send gate → `abyss-range at NNu`, (b) LoF collect gate in the chest bucket →
  `LoF-blocked at NNu`, (c) walkable-LoS send gate (Chest/Strongbox only) → `walk-LoS-blocked at NNu`.
  Format: `[Opener] chest skip (<shortname>): <reason> at NNu`. Zero gate behavior changes.

## Settings added (all code consts, default ON; flip to `false` in-file to disable)
| Flag | Covers | Off = |
|---|---|---|
| `ABYSS_SWEEP_CHEST_WALK_ON` (mapper.js ~3947) | A | stand-at-centroid dwell exactly as today |
| `ABYSS_SWEEP_POSTBOSS_FIX_ON` (mapper.js ~3948) | D1+D2 | Phase 3.75 order + leg clocks as today |
| `OB_COMPLETE_RELEASE_ON` (mapper.js ~1492) | C | release waits for the next arb pick as today |
| `DISC_COMPLETED_SKIP_ON` (mapper.js ~6400) | E (all parts incl. summary tail) | no tracking/skips/window change |
| `PICKER_RADAR_ROUTE_ON` (mapper.js ~8072) | F | macro-graph-only validation as today |

B is unflagged (log-only breadcrumb, mirrors the unflagged `logEssenceSkip`).

## LIVE-TEST CHECKLIST (abyss + breach map)
- **A working**: after a chest site's hold, `[AbyssSweep] chest NNu from stand point -> walking to it` followed
  by the opener actually opening it (`Opened ...`), chest-to-chest until `retired: chests cleared`; NO
  `retired: 45s ceiling` while a reachable unopened chest stands. On a stuck site walk:
  `[AbyssSweep] site unreachable at NNu but chest up -> chest-walk before retire`.
  **Broken**: alternating `chest NNu -> walking` lines ping-ponging between two chests (nearest-first should
  prevent it; the site ceiling bounds it regardless).
- **B working**: any refused chest prints ONE `[Opener] chest skip (<name>): abyss-range|LoF-blocked|
  walk-LoS-blocked at NNu` line ≤5s after the refusal — this names which gate blocked the 9.2u chest.
- **C working**: `[OB] complete content:<key> (arb-release)` appears in the SAME second as `[Abyss] node N
  completed incidentally` / `[Breach] done`; ArbShadow lines stop carrying the stale `committed=`; no more
  `shadow-deny sweep:... vs content:...` storms against a dead claim.
- **D working**: post-boss, a deferred site logs `[AbyssSweep] post-boss resume -> fresh walk leg` (or arrives
  with fresh clocks via the defer-time reset) and gets WALKED before any `[Discover]`/`[Coverage]` line;
  **broken** = the old signature: `[Cleanup] budget ... spent` then `retired: walk cap` within ~1ms.
- **E working**: no `[Discover] <type> marker at (x,y) -> walking straight to it` toward a completed instance's
  position (instead: `skipping marker ... -- completed breach instance there`); with breach 1 done + bit
  incomplete, discover keeps hunting past 40s; MAP SUMMARY says `breach 1/1 found (game lists more, unfound)`
  when #2 stayed unfound (or `breach 2/2` when it got done).
- **F working**: `[Discover] bucket (x,y) radar-unroutable -> banned upfront` instead of 9-15s stall→blacklist
  cycles; picks converge on walkable fog.
  **Broken**: a burst of radar-unroutable bans followed by an early `[Discover] ... conceded` while obviously
  walkable fog remains → radar false-negatives (see Risks 2) → flip `PICKER_RADAR_ROUTE_ON` off.

## Risks / deviations from the brief
1. `abyssChestNear` now returns `{x,y,d}|false` UNCONDITIONALLY (not flag-gated). All existing call sites use
   it as a boolean, so control flow is identical with the flag off — but it is a value-shape change, not
   byte-parity in the strictest sense. Gating the return shape itself would have needed a second cache.
2. **F radar false-negatives**: navigator.js deliberately treats a null/short radar answer as NOT an
   unroutability fact (grid mid-build, flood cap, endpoint snap miss) and falls back to macro. The brief
   directs radar as the upfront validator here, so a radar miss BANS the bucket for 5min. Fog-bucket centers
   are arbitrary points and may snap-miss more than entity targets do. Mitigations: 150u end tolerance, 5min
   (not 10min) ban, per-map `_unexpFailed` clear, kill-switch const. Watch for the "broken" signature above.
3. **D1 addition**: the inserted sweep call also honors the existing `now - _cleanupDriveAt > 5000` one-writer
   gate (not in the brief's wording). Without it, a cleanup returning false for one hiccup frame would let the
   sweep interleave walk targets with it — the exact livelock that gate exists to prevent. The requirement
   ("sweep serviced before ANY reveal-explore") still holds: discover/coverage sit behind the same gate, below
   the sweep.
4. **C flag**: the brief names no flag for C; house rule 2 requires one, so `OB_COMPLETE_RELEASE_ON` was added
   (default true). Also, the release used is `arbRelease` (clears `arbCommittedKey` too, not just the OB
   record) — that IS "the same release the arb path uses", and the live evidence (`committed=breach:34`
   persisting in ArbShadow lines) shows the key itself was the zombie.
5. **D2 addition**: the brief asked for the reset at the pre-boss defer `return false`; I additionally reset at
   the first post-boss call (the `abyssSweepPostStartAt` seed) because the defer branch only runs if the
   pre-boss hook is called again after budget expiry — a boss engage that same frame would have skipped it and
   reproduced the bug. Both resets are idempotent (gated on `startAt` being set).
6. **E marker skip radius (60u)**: a genuine second instance spawning within 60u of a completed one's position
   would be skipped by the marker-first pick — it would still be found by fog-reveal (bucket ban is only the
   one 64-cell bucket). Considered acceptable; radius is inline if it needs tuning.
7. `noteContentCompleted` also fires for beacon/hive/verisium/incursion completions (the brief's E text says
   "when a queue content entry COMPLETES", so all six sites were instrumented, not just breach). Effect is a
   marker-skip + one bucket ban at positions we already stood at — no reveal-mass is lost there.
8. Chest-walk beyond the 90u site radius: the chest scan is player-centric (90u), so walking chest-to-chest
   keeps the remainder in view; a pathological >90u spread could still retire `chests cleared` early — same
   exposure as today's fixed-stand version, just less likely.

## Open questions
None blocking. TEST BEFORE COMMIT applies — nothing was committed.
