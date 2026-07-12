# TASK-37 REPORT — Committed-content far-walk wedge + idle-detector false positives

Pre-snapshot: `handoff\pre\TASK-37\` (mapper.js + entity_actions.js, taken before any edit).
`node --check` passes on both edited files. All new symbols grep-verified (no half-renames).

## A1. TRACE — the call chain that owned the 17:11:53+ frames

- Per logic pass, the pre-switch content hook (mapper.js, the `!inBossEngage` block gating `arbTick`) ran
  `arbTick` → `pickObjective` → R1 committed hold → `arbGoal(committed)` for `breach:61`.
- `arbGoal` (non-coord, non-fogged lane) built the drive as `run || (() => false)` with
  `run = arbRunnerFor('breach')` = **null**, because `nearestBreachPoint` scans LIVE entities
  (`getEntities nameContains BrequelInitiator`) and the Brequel at ~2100u is out of the stream.
  So the committed drive was the bare `() => false` — `arbTick` returned false every pass.
- The frame then fell into `STATE.WALKING_TO_BOSS_CHECKPOINT`, whose TASK-26 yield
  (`ckptYieldContentActive` true: goal.key == arbCommittedKey, ONROUTE ins=0 ≤ bud) ran
  `sendStopMovementLimited()` + `break` — every pass. That is the `[Ckpt] yielding to route-gated breach:61`
  line followed by silence: the yield lane cedes the frame to a drive that cannot drive.
- The REVISIT (~`tryRevisitNearbyContent`) and CLEANUP (`tryCleanupContent`) switches both have a
  "PHASE 1: out of stream → WALK to the remembered pos" fallback; the arbiter's `arbGoal` lane — the one the
  [Ckpt] yield cedes to — did not. That asymmetry is the whole bug.
- Why no TTL rescue: `arbTerminated` charges the 45s commit TTL against `obContentOwnedMs` (owned
  progress-stall ms under OB, wall-clock in shadow) — ≥45s of standing either way before eviction, and the
  eviction path just bans + re-picks. The user watched the stand and intervened first.

## A2/A3. FIX — far-walk + release valve (mapper.js)

- **`arbFarWalk(key, e, player, now)`** (new, next to `arbCoordDrive`): PHASE-1 walk to the entry's
  remembered gridX/Y, exact revisit/cleanup commit-latch idiom (repath only on new target / >60u drift /
  empty path / 1.5s gate), `startWalkingTo(..., 'Content Farwalk', 'boss')` (fog-independent macro route)
  + `stepPathWalker()`. Returns false inside `ARB_FARWALK_NEAR_D` (120u — entity expected in-stream there;
  the runner owns it). Includes the cleanup FOREIGN-PATH hold (a renamed walk frame is not our verdict).
- **`arbGoal`** now builds (flag-on): `drive = () => ((runT && runT()) || arbFarWalk(...))` for non-coord
  types (coord types keep `arbCoordDrive`), where `runT` wraps the phase-2 runner and stamps
  `arbValveRunnerAt` whenever the runner actually held a frame. Every committed lane (R1 hold, the
  out-of-cands walk at ~`pickObjective` tail, R4 fresh pick) builds through `arbGoal`, so all of them get
  the same phase-1 treatment — the unify the brief asked for. Flag-off branch is byte-identical to today.
- **`arbValveTick(goal, player, now)`** (new): runs once per arbTick drive pass on the committed goal.
  Progress (resets the 6s clock) = phase-2 runner held a frame within 500ms, OR >14u real displacement from
  the valve anchor, OR distance-to-entry improved >2u, OR standing at the entry (≤60u — dwells/openers own
  that wait under their own caps). Preempted stretches (gap >400ms between drive passes) advance the clock
  forward (checkpoint-watchdog idiom) so only drive-owned time counts. At 6s:
  `[Arb] committed <key> undrivable -> released (no runner, no progress)` → short `revisitSkip` ban
  (15s required / 60s optional — the arbCoordDrive idiom) → `arbRelease(now)`. Entry stays `active`.
- `arbTick` invokes the drive once, then the valve, then returns as before. Valve state reset in `arbReset()`.

Note on the displacement-based progress test: pure distance-improvement would false-release a far macro leg
routing AROUND without closing (documented at stepPathWalker's own watchdog), and pure "walker returned
walking" would never release the railing wall-slide class. Anchor displacement >14u catches both correctly.

## B. Idle-detector cast bus

- **entity_actions.js**: `const IDLE_DETECT_BUS_ON = true` (near INVULN_GATE_ON) + in `processAutoAttack`,
  at `const fired = executeRotationOnTarget(...)`: `if (fired) ... POE2Cache.lastRotationCastAt = now`.
  One-way, publish-only.
  - DEVIATION (why not the literal `Used <skill>` log site): that log lives in **rotation_builder.js**
    (`[Rotation] Used ...`), which the brief's hard limits exclude. `executeRotation` returns true exactly
    and only on the code path that prints that log (all other paths return false), so `fired === true` at the
    entity_actions call site is the same signal, inside the allowed file.
- **mapper.js**: `IDLE_DETECT_BUS_ON = true` + `IDLE_BUS_FRESH_MS = 1500` (near the RANGED_* consts).
  `fightHoldPostureStep`'s `_acting` is now `(now - (POE2Cache.lastRotationCastAt || 0)) < 1500` (flag on;
  player action fields not consulted — proven dead by the Vastweld capture). Flag off = the old field read,
  verbatim. The dodge-window check and channel-hold exemption are untouched.
- **resetMapper**: `_poIdleSince/_poGapLogAt/_poBackLogAt/_poCcLogAt/_poReasonAt/_poReason/_poLofBad` +
  step state `_poStepAt/_poStepWpX/_poStepWpY/_poStepUntil/_poScanAt/_poPress/_poNear/_poHoldLogKey` all
  zeroed (the 74.7s stale-clock). Unconditional per the brief (state zeroing only).

## C. Macro-corridor commit-latch (STOPGAP; navigator 26A/B is the structural fix)

- New block after `macroWaypointToward`: `CORRIDOR_LATCH_ON = true`, `COR_LATCH_STALL_MS = 10000`,
  state `_corRoute/_corHX/_corHY/_corBestD/_corProgAt/_corTickAt`, helpers `_corLatchRelease`,
  `_corLookahead`, `corridorLatchTick` (per-explore-pass stall/arrival releases, gap-advanced clock),
  `corridorLatchHop` (the latch itself: own `macroPathTo` route copy per heading — the shared
  `macroRouteCache` is not touched while latched).
- At the explore corridor-hop site: `const _mw = (CORRIDOR_LATCH_ON ? corridorLatchHop(player, exTarget.x,
  exTarget.y, now) : null) || macroWaypointToward(...)` — flag off or no latch possible → today's call
  exactly. `corridorLatchTick(player, now)` runs at the top of the explore-target section each pass.
- Logs: `[Explore] corridor latched toward (x,y) for heading (hx,hy)`;
  `[Explore] corridor latch released (<reason>) for heading (hx,hy)` with reason ∈
  `heading reached` (<60u of H) / `heading changed` (>30u) / `progress stalled` (10s of explore-owned time,
  net distance to H) / `corridor spent` (route end consumed) / `hop unwalkable` (`poe2.isWalkable` false).
- Latch reset in `resetMapper` (silent — a map change is not a release event).

## D. S5 mob-hold LoF gate

- Landed at the S5 white-mob chase arm site (the `if (nearMob && nearMobD > 18)` branch head in the
  FINDING_BOSS explore lane, right after the branch-switch throttle): a candidate that is NOT already held
  (`!_s5MobId`), beyond the melee band (`> RANGED_MELEE_FLOOR_U` = 26u, casts need no LoF inside it), and
  fails the LoF raycast is banned outright (`_s5MobBanId/_s5MobBanUntil = now + 10000`) and nulled — the
  walk continues to the heading. Log: `[S5] mob Nu no line-of-fire -> skip hold (ban 10s)`.
- `_s5MobLofOk` = the posture `lineWalkable` raycast idiom, throttled 300ms per mob id.
- DEVIATION: the brief named no flag for D; house rule 2 requires one → `S5_HOLD_LOF_GATE_ON = true`
  (flag off = today's arm-always behavior).

## Settings added (all default ON; off = byte-identical control flow)

| Setting | File | What it gates |
|---|---|---|
| `COMMITTED_FARWALK_ON = true` | mapper.js | A: phase-1 far-walk fallback in `arbGoal` + the 6s release valve |
| `ARB_FARWALK_NEAR_D = 120` / `ARB_UNDRIVABLE_RELEASE_MS = 6000` | mapper.js | A tunables |
| `IDLE_DETECT_BUS_ON = true` | entity_actions.js | B: publish `POE2Cache.lastRotationCastAt` per rotation cast |
| `IDLE_DETECT_BUS_ON = true` / `IDLE_BUS_FRESH_MS = 1500` | mapper.js | B: `_acting` reads the bus instead of the player fields |
| `CORRIDOR_LATCH_ON = true` / `COR_LATCH_STALL_MS = 10000` | mapper.js | C: corridor latch at the explore macro-route choice |
| `S5_HOLD_LOF_GATE_ON = true` | mapper.js | D: LoF arm-gate on the S5 mob hold |

To fully revert B, flip BOTH files' `IDLE_DETECT_BUS_ON` (publisher + consumer are per-file kill switches).

## Symbols added / modified (searchable)

- Added (mapper.js): `arbFarWalk`, `arbValveTick`, `arbValveKey/arbValveSince/arbValveBestD/arbValveAnchorX/arbValveAnchorY/arbValveTickAt/arbValveRunnerAt`, `corridorLatchTick`, `corridorLatchHop`, `_corLatchRelease`, `_corLookahead`, `_corRoute/_corHX/_corHY/_corBestD/_corProgAt/_corTickAt`, `_s5MobLofOk`, `_s5LofId/_s5LofAt/_s5LofVal`, consts above.
- Added (entity_actions.js): `IDLE_DETECT_BUS_ON`, the `POE2Cache.lastRotationCastAt` stamp.
- Modified (mapper.js): `arbGoal` (drive construction), `arbTick` (drive+valve invocation), `arbReset`, `fightHoldPostureStep` (`_acting`), `resetMapper` (posture + corridor resets), the S5 mob-arm site, the explore corridor-hop site.
- New walker target name: `Content Farwalk` (pathType `boss`).
- New bus field: `POE2Cache.lastRotationCastAt` (ms timestamp; entity_actions writes, mapper reads).

## LIVE-TEST CHECKLIST

**A — far-walk (the Spring_ wedge):** commit a far breach during a checkpoint walk.
- WORKING: `[Ckpt] yielding to route-gated breach:N` followed **within ~2s** by
  `Walking to Content Farwalk at (x, y) [pathType=boss]` and visible movement; when the Brequel streams in
  (<~120u) the breach runner's own lines take over (`[Breach] TOUCHED ...`). If the walk genuinely can't
  progress: within ~6s `[Arb] committed <key> undrivable -> released (no runner, no progress)` then
  `[Ckpt] content released -> resuming checkpoint walk`.
- BROKEN: a [Ckpt] yield line with no Walking-to line and the char standing >6s, or any commitment holding
  the frame >6s with zero movement and no release line.

**B — cast-gap:** fight normally.
- WORKING: zero `[Posture] cast-gap ...` lines while `[Rotation] Used ...` lines are landing; after a
  mid-map mapper off/on toggle, no cast-gap line reporting a >60s clock. Gap lines still appear (with a
  reason) during genuine no-cast standing.
- BROKEN: a cast-gap line sandwiched between two `Used` lines <1.5s apart, or a `74.7s`-class gap right
  after a re-enable.

**C — corridor latch (Cliffside-class explore):**
- WORKING: per stable `[Explore] unexplored heading -> (hx,hy)`, ONE
  `[Explore] corridor latched toward (x,y) for heading (hx,hy)`, stable walking along it, and any release
  names its reason. `Macro route ... toward` no longer alternates targets every ~8s under a fixed heading.
- BROKEN: alternating corridor first-legs / the staircase yoyo, or `progress stalled` releases firing while
  the char is visibly advancing (would mean the 10s/3u thresholds are too tight — report it).

**D — ledge mobs:**
- WORKING: `[S5] mob Nu no line-of-fire -> skip hold (ban 10s)` on fence/ledge strays and the walk
  continues; no more `[S5] mob hold expired (5s, unkilled)` bursts on unhittable mobs. Reachable mobs latch
  and get chased exactly as before.

## Risks / deviations (summary)

1. B1 publish site is entity_actions' `fired` return, not rotation_builder's log line (file limit) — same
   signal, see B above. Casts fired via SpikenQOL's own rotation calls don't stamp the bus (that bot doesn't
   run with the mapper).
2. A valve adds a short ban on release (15s/60s) — the brief said "entry stays active"; it does (state
   untouched), the ban only hides it from the picker briefly to prevent the documented release→instant
   re-commit livelock (same guard the TTL evict uses).
3. A valve also bounds the fogged-commit lane (`arbExploreToward`): a fog detour with <14u net displacement
   over 6s of drive-owned time releases. Unlikely while actually walking; watch for spurious
   `undrivable -> released` on fogged commits.
4. D flag added beyond the brief (house rule 2): `S5_HOLD_LOF_GATE_ON`.
5. C heading identity tolerance is 30u; a heading jittering more than that re-tosses the corridor (logged as
   `heading changed`).

## Open questions

None blocking.
