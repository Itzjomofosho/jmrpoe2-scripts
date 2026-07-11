# TASK-26 REPORT — Boss-checkpoint walk yields to route-gated content

**Status:** implemented, syntax-clean, UNTESTED (awaiting user live-test per TEST-BEFORE-COMMIT).
**File touched:** `mapper.js` ONLY (runtime dir). Pre-snapshot: `handoff/pre/TASK-26/mapper.js` (md5 matched pre-edit).
**Diff:** +58 lines, purely additive (0 deletions).

---

## What the bug was (confirmed from the code, matches the brief's live evidence)

`arbTick` (the arbiter) **already runs** during `WALKING_TO_BOSS_CHECKPOINT` — it's the pre-switch call at
[mapper.js:13509](../mapper.js#L13509) (`... && arbTick(player, now)) return;`, which gates out only `MAP_COMPLETE`
and `WALKING_TO_UTILITY`). It **commits** the route-gated breach (`[ArbShadow] pick=breach:50 NEAR ins=27`), but its
*inline runner* returns false whenever the breach's `BrequelInitiator` entity isn't currently streamed
(`nearestBreachPoint` → `null` → `arbRunnerFor` → `null` → runner is `() => false`). On those frames `arbTick`
returns false, the switch falls through to the checkpoint case, and `stepPathWalker()` **drifts the player toward the
boss, away from the committed content** → the starve (owned 6s / frozen 42s → `arb-release` → breach never touched).

**Linchpin:** reaching the `WALKING_TO_BOSS_CHECKPOINT` switch case *implies* `arbTick` returned false this frame
(else the pre-switch `return` fired). So the fix acts only on the exact frames where the arbiter wanted content but
its runner couldn't drive it.

## Design decision — WHICH + WHY (the brief delegated the choice: "smaller/safer in the tree")

The brief offered two transitions: **(A) FINDING_BOSS re-entry** or **(B) a `checkpointResumeState` mirror**.

**(A) is NOT viable on arena-tile maps.** The brief's own premise ("boss re-commit is instant, the centroid is
cached") is exactly what breaks it: `getBossArenaCentroid` at [mapper.js:14119](../mapper.js#L14119) re-commits
checkpoint on the *very next* `arbTick`-decline frame ([14125](../mapper.js#L14125)), and STRATEGY 1 does the same
within 3s ([14161](../mapper.js#L14161)/[14286](../mapper.js#L14286)). Yielding to FINDING_BOSS bounces straight back
to checkpoint → checkpoint↔FINDING_BOSS flicker with no content progress. Holding FINDING_BOSS in explore would
require gating **three** boss-find commit paths — invasive and bumps the "boss engage detectors stay untouched" limit.

**I implemented (B) — the `checkpointResumeState` mirror — realized as a HOLD-in-checkpoint.** This is the idiomatic
pattern the codebase already uses: the existing arena-entry hold at [mapper.js:14700](../mapper.js#L14700) `break`s
(stays in checkpoint) so `arbTick` grabs the objective next frame. My change does the same *during the walk*
(dist > ~150u), gated on the arbiter's own committed route-gated verdict. It cedes the frame to `arbTick` (which runs
pre-switch anyway) and sends a stop so the game's click-to-move doesn't carry us onward to the boss. On release, the
checkpoint walk re-issues in one frame (arena anchor unchanged). **Zero boss-find/engage changes, no new scans, no
arbiter/OB changes** — it consumes `arbTick`'s stashed per-frame verdict (`arbLastGoal`), never re-classifies.

This is the smaller/safer of the two viable realizations; a literal state-transition is either flickery (A) or would
need to gate multiple boss-find paths.

## Functions / symbols added or modified (searchable)

| Symbol | Where | Role |
|---|---|---|
| `CKPT_CONTENT_YIELD_ON` (const, `true`) | ~L4523 | master flag; `false` = byte-identical control flow |
| `CKPT_ARENA_HOLD_R` (const, `150`) | ~L4524 | never yield within ~this of the arena anchor (fight imminence) |
| `arbLastGoal`, `arbLastGoalAt` | ~L4525 | `arbTick`'s per-frame verdict (kind/key/dbg), stashed for the consumer; reset in `arbReset` |
| `checkpointResumeState` | ~L612 | resume latch (mirror of `utilityResumeState`); reset in `setState` (boss-approach/engage + MAP_COMPLETE) and `resetMapper` |
| `ckptYieldContentActive(now)` | ~L4839 | consumer: true iff arbiter holds a committed **route-gated** content entry (NEAR or insertion≤budget) this frame |
| stash line in `arbTick` | ~L4824 | `if (CKPT_CONTENT_YIELD_ON) { arbLastGoal = goal; arbLastGoalAt = now; }` |
| hold+resume block in `WALKING_TO_BOSS_CHECKPOINT` case | ~L14699–14726 | the yield itself |

## Settings added

- `CKPT_CONTENT_YIELD_ON` — a module `const` (not a runtime setting), default **`true`** (ships on, per brief).
  Flip to `false` for byte-parity control flow. No `currentSettings` key (matches how `ARBITER`/`STONECIRCLE_ON` etc.
  are done).

## Route-gating verdict consumed (NOT re-derived)

`ckptYieldContentActive` reads `arbLastGoal.dbg` (`{tier, ins, bud}`), which `arbGoal` already computes from
`classifyObjective`. Route-gated = `tier === 'NEAR'` **or** `ins <= bud` (covers `ONROUTE` for known boss and
`INREACH` for unknown boss). `OFFROUTE`/`FAR` content is **not** yielded to → stays for post-boss cleanup. Fogged
content never reaches the hold (its runner is `arbExploreToward`, which returns true → `arbTick` drives it → switch
skipped).

## Flag-off parity (verified by reading)

With `CKPT_CONTENT_YIELD_ON = false`: the stash is skipped (`arbLastGoal` stays `null`), `ckptYieldContentActive`
returns false on its first line, and the entire hold/resume block is wrapped in `if (CKPT_CONTENT_YIELD_ON)` so it's
skipped whole. `checkpointResumeState` is never set → the `setState`/`resetMapper` clears assign `IDLE`→`IDLE`
(no-ops) and no code reads it to any effect. **Control flow is byte-identical to today.**

---

## LIVE-TEST CHECKLIST

Run an **arena-tile map** (goes straight to `WALKING_TO_BOSS_CHECKPOINT` at entry) with `clearBreach` (or another
route-gated content type: abyss/verisium/incursion) enabled, and content sitting near the boss route.

**WORKING looks like:**
1. On the walk to the arena, when the arbiter commits the near-route content you see **once**:
   `[Ckpt] yielding to route-gated breach:<id> (ins=NNu) -> resume checkpoint after`
   (status line reads `Yielding to content breach:<id> (NNNu from arena)`).
2. The content then runs through its normal owner (`[Breach] TOUCHED ... -> activated -> clearing`, or the abyss/
   verisium runner lines). The player does **not** drift on toward the boss while the content is committed.
3. When the content completes/releases: `[Ckpt] content released -> resuming checkpoint walk`, then the normal
   `Walking to Boss Checkpoint... Nu` resumes, boss entry reached, boss dies.
4. **Content > ~150u off-route** (OFFROUTE tier) is **not** yielded to — no `[Ckpt] yielding` for it; it's swept
   post-boss. Confirm the arena approach isn't dragged sideways for it.
5. Content **within ~150u of the arena anchor** is **not** yielded to (fight imminence) — the boss approach proceeds;
   `arbTick`/post-boss cleanup handles it.

**BROKEN looks like:**
- Rapid alternation of `[Ckpt] yielding...` / `[Ckpt] content released...` (a yo-yo). Expected: **one** yield line
  per content commit, one resume line. (The single-log guard + the fact that we stay in checkpoint means this
  shouldn't happen, but watch for it.)
- The bot **stands still for a long time** in `WALKING_TO_BOSS_CHECKPOINT` with status `Yielding to content ...` and
  no content-runner progress (see Risk #1 below). The 60s silent-frame heartbeat will surface it as
  `state=WALKING_TO_BOSS_CHECKPOINT status="Yielding to content ..."`.
- Boss never engaged / map never completes (would indicate the latch leaked — it's cleared on every
  melee/fight/map-complete `setState` and in `resetMapper`, so this shouldn't occur).

Grep the log for `[Ckpt]` to see every yield/resume.

---

## Risks / deviations

1. **(Primary risk) Worst-case hold ≈ the arbiter's breach TTL (90s), per [lockTtlFor](../mapper.js#L4475).** If a
   route-gated breach is committed but its `BrequelInitiator` never streams from the hold point (or its runner hits
   its own 11s no-progress bail and blacklists the Brequel), the hold persists until the arbiter's TTL releases the
   commit, then the boss walk resumes and the content goes to post-boss cleanup. The brief explicitly said "Bounds:
   everything the arbiter/runners already have (this adds a yield, not a new driver)," so I did **not** add a hold-cap
   timer. In practice this tail is narrow: a genuinely unreachable breach classifies `walled` and is never committed
   (so never held); only `reachable`/`fogged` breaches commit, and at ins=27 (on-route) the Brequel is essentially in
   stream range, so the hold is sub-second. **Open question for the planner:** accept the 90s arbiter bound, or add a
   small continuous-hold cap (e.g. ~8s of no content-drive → release to boss)? A cap would be a *new* bound, contrary
   to the brief's directive, so I left it out.

2. **Deviation from the literal "transition":** the brief said "Transition to the content-driving path." I hold
   in-state instead of transitioning, because both named transitions bounce/over-reach on arena-tile maps (see Design
   Decision). The hold is functionally the utility-detour equivalent (it removes the boss-walk contention that starves
   the content) and is the "smaller/safer" choice the brief authorized. The `checkpointResumeState` latch + the
   set/restore + resume-log mirror the `utilityResumeState` pattern as the brief's option (B) asked.

3. **`sendStopMovementLimited()` on hold frames** is the approved gated sender (respects the Movement Broker; the
   dodge, at prio 1, still overrides for survival). It only fires on frames `arbTick` issued no content move (by
   construction), so it never fights an active content walk — it only cancels leftover boss auto-walk momentum.

## Anti-freeze / watchdog interaction (checked)

The hold `break`s before the CHANGE-2 watchdog compensation and `stepPathWalker`. On resume, the existing CHANGE-2
compensation ([mapper.js:14731](../mapper.js#L14731)) advances `bossCheckpointLastImprovementTime` by the elapsed
hold gap (`now - lastCheckpointStepAt`), so a hold cannot age into a FALSE fog-block. The 10-min boss-approach stale
failsafe ([mapper.js:13142](../mapper.js#L13142)) remains the final backstop.

## Untouched (per hard limits)

No arbiter scoring/OB changes (only stashed its existing goal). No new packets/memory writes/C++ bindings. No new
entity scans (one `hypot` per checkpoint frame when the flag is on). The utility interleave, strict-finish gates, and
the boss engage detectors (`detectActiveBossEngagement`, the melee/fight transitions) are untouched. `mapper.js` only.
