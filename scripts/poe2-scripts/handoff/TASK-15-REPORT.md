# TASK-15 REPORT — Utility walk: contested ≠ unreachable (+ full essence-opening pipeline)

## STATUS: DONE — essence opened + looted LIVE (MapPit, 14:43, user "u opened the seence, call it done")
`essence committed (d=159) -> Opened Essence x4 (24/37.5/27.7/9.2u) -> untargetable -> Gold-Melted Shambler
released & killed -> Pickit: Perfect Essence of the Mind + Essence of the Breach -> resumed boss flow.` The
opportunistic reach-hold, 100ms opener cadence, and `_hvOpen` objective side-step all fired correctly. Earlier full
success: Savanna 12:18 (open+loot). TASK-15 proper (contested defer) proven Savanna 11:17.

**Scope note:** the assigned brief was `mapper.js`-only (contested verdict). It expanded — at the USER's live
direction across ~10 rounds — into a full essence-opening pipeline touching `mapper.js`, `auto_dodge_core.js`, and
`opener.js`. All runtime-only, UNCOMMITTED, syntax-clean. The consolidated changelist is at the BOTTOM
(`## DONE — consolidated changelist`); the chronological rounds below are the how-we-got-here.

**Unrelated death (handed to orchestrator, NOT this task):** the 100-min Willow soak death was a stale
`getLocalPlayer` (invalid from 12:56) that silenced mapper/dodge/chicken/death-detect — a silent-frame bug, its own
TASK-16, nothing to do with the essence changes (reach-hold only runs in WALKING_TO_UTILITY or ≤2.5s of an essence
click, never in the boss fight).

---

Original brief: `handoff/TASK-15-utility-contested-verdict.md`. No commit/push (user live-tests first).
Pre-snapshot: `handoff/pre/TASK-15/mapper.js` (md5 verified against runtime before first edit).

## Files touched
- `mapper.js` — TASK-15 contested verdict (utility-walk path), PLUS a user-directed reach-through-ground signal
  (see "BEYOND TASK-15" below). Pre-snapshot: `handoff/pre/TASK-15/mapper.js`.
- `auto_dodge_core.js` — user-directed opener-reach hold (see "BEYOND TASK-15" below). Pre-snapshot:
  `handoff/pre/TASK-15/auto_dodge_core.js`. NOT part of the original TASK-15 brief; added live at the user's
  direction during testing.

## Setting added
- **`UT_CONTEST_ON`** (const, mapper.js ~587). Default **`true`**. Kill-switch for the whole feature.
  Flip to `false` → **byte-identical control flow to today**: the freeze radius reverts to 45u, the dodge-recency
  exclusion + per-key accrual are skipped (`_utDodgeExcl` stays `false`), the verdict skips the contested branch
  and runs the original `failed:no-net-progress` ban, and `startUtilityState` skips the commit-distance record.
  (Not a user-facing `currentSettings` toggle — a code const, as the brief specified.)

## Symbols added / modified (searchable)
- `UT_CONTEST_ON` — kill-switch const.
- `_utLastDodgeAt` — ts of the last frame the MB dodge hold was live (roll + ~1.2s recovery window).
- `_utDodgeExcl` — per-frame bool: this frame is dodge-excluded (roll/recovery) → NOT an owned walk.
- `_utDodgeKey`, `_utDodgeMs`, `_utDodgeAccrAt` — per-key dodge-excluded-ms accumulator (contested signal).
- `_utCommitD` — player→target distance recorded at claim (shove-away signal), `Infinity` until a claim.
- `_utContestedCount` — `Map(key → contested-verdict count this map)`; escalation ledger, cleared in `resetMapper`.
- Modified: `startUtilityState` (records commit dist + resets accrual), `resetMapper` (clears the new ledger),
  the `_utCombatFrz` probe (radius `45 → UT_CONTEST_ON ? 60 : 45`) and its engage log/comment, `_utOwned`
  (`&& !_utDodgeExcl`), and the no-net-progress verdict (contested-defer split).

## What each piece does (maps to brief A/B/C)
**A — dodge hole closed + freeze widened**
- Freeze probe radius `45u → 60u` (flag-gated) so a rare/telegraph at 46-47u actually arms the freeze. The 20s
  per-target cap (`_utFrzUsed < 20000`) is UNTOUCHED. Log fixed to player-centred wording:
  `hostiles nearby -> fighting through`.
- New dodge-recency block (openable-only, flag-gated): stamps `_utLastDodgeAt` on any frame within the recent-dodge
  window, using the FULL stepPathWalker-watchdog idiom (mapper.js ~6532): `now < dodgeMoveSuppressUntil ||
  (MB.hold && MB.hold.owner === 'dodge' && now - MB.hold.at < MB.WINDOW)`. A frame is NOT owned while
  `now - _utLastDodgeAt < 1200` (roll + re-path/re-accelerate recovery), ANDed into `_utOwned`. Same block accrues
  `_utDodgeMs` (capped 250ms/frame) per committed key.
  - **NOTE (live-test round 1 fix):** my first cut used only the `MB.hold.owner === 'dodge'` half of the idiom.
    That FAILED live — the utility walker sends a move every unlocked frame, and `MB.hold` is (re)written by
    `MB.gate()` on every send, so it was clobbered back to `'utility'` before my block read it. The reliable term
    is `dodgeMoveSuppressUntil` (what OB's `by=dodge` freeze uses, line ~1600). See "Live-test round 1" below.

**B — contested verdict = short defer with escalation**
- `_utCommitD` recorded at claim (`selected.distance`; `Infinity` if not finite → shove clause is inert).
- At the verdict, `contested = _utFrzUsed > 0 || _utDodgeMs > 1500 || (finite _utCommitD && dist > _utCommitD + 15)`.
  Openable-only, flag-gated.
- contested → `addIgnoredUtilityTarget(target, 'defer:contested', ttl)` with per-key escalation:
  **1st = 25s, 2nd = 90s, 3rd+ = falls through to the standard long ban** (undefined ttl = 600s). Counter is
  per-key, cleared per map in `resetMapper` — so a genuinely unreachable target guarded by a respawn loop still
  converges to the long ban in ≤3 verdicts.
- NOT contested → the original `failed:no-net-progress` line + ban, **byte-identical** (walled-Trunk anti-yoyo
  discipline untouched).
- Distinct audit line: `... contested (... frz=Xs dodge=Ys d0=Zu) -> defer 25s (contested #1)`.

**C — no new scans**: reused the existing `_utFrz` probe (one radius change), MB.hold reads, and the tracker.
The 5s threshold, `trackOwnedProgress`, and every non-openable utility path are unchanged. `getUtilityTargetKey`
(pure string builder, no scan) is called a couple extra times — negligible.

## Flag-off parity (verified by reasoning over the diff)
Every behavioral change sits under `UT_CONTEST_ON`:
- radius `UT_CONTEST_ON ? 60 : 45`; dodge block `if (UT_CONTEST_ON && …openable)` with `_utDodgeExcl=false` default;
  `_utOwned` gains `&& !_utDodgeExcl` (=`&& true` when off); verdict `if (UT_CONTEST_ON && …)` → `_deferred=false`
  → original branch runs verbatim; `startUtilityState` writes gated.
- `resetMapper` extra clears touch only the new vars (read only under the flag) → harmless when off.
- **One acknowledged non-gated change**: the freeze engage LOG string `hostiles at target → hostiles nearby`
  (the brief explicitly asked to fix it). It's cosmetic — same call site, same firing condition, no control-flow
  or ban/movement effect. Flag-off log wording differs by that one word; behavior is identical.

## `node --check`
`node --check mapper.js` → PASS. New-symbol grep → all consistent, no half-renames/typos.

## LIVE-TEST CHECKLIST
Setup: commit an essence (or any openable) with a monster pack en route so AutoDodge rolls during the approach
(the 2026-07-11 Savanna case: essence committed at d~103, rare telegraphing from ~46u).

WORKING looks like ONE of:
1. **Freeze arms** — as you approach with hostiles ≤60u:
   `[Mapper] [M:<map>] Utility openable: hostiles nearby -> fighting through (clocks frozen, cap 20s)`
   → the old `Utility openable unreachable (owned no-progress 5s …) -> blacklist + skip` does **not** fire; after
   the pack dies you finish the walk and open the essence.
2. **Dodge-recency covers it** (freeze didn't arm, e.g. hostile sat 60-75u but kept rolling you) — no verdict fires
   during the roll storm; the no-progress clock only advances on genuinely-owned walk frames.
3. **Contested defer fires** (walk truly stalled 5s of owned no-progress but it was a shove, not a wall):
   `[Mapper] [M:<map>] Utility openable contested (owned no-progress 5s at 140u; frz=3.2s dodge=2.1s d0=103u) -> defer 25s (contested #1)`
   → then, after the fight clears, the bot **RE-COMMITS** to the essence (a fresh `Utility select: openable …`
   within ~25s) instead of `IGNORED (utility blacklist)` for 10 minutes. A 2nd stall on the same object logs
   `defer 90s (contested #2)`; a 3rd falls through to `unreachable … -> blacklist + skip` (600s).

BROKEN looks like:
- `Utility openable unreachable (owned no-progress 5s …) -> blacklist + skip` firing **while dodge-rolling a pack**
  (no `fighting through` and no `defer … (contested)` beforehand) → the dodge hole is still open; capture the
  console + the hostile distance at the time.
- The bot deferring a genuinely **walled** openable (no pack, no dodges, stuck on collision) with `defer 25s
  (contested)` and re-committing forever → the shove-away clause is misfiring (check the `d0=` vs the final `at Nu`
  in the line: contested should need `dist > d0 + 15`, or `frz>0`, or `dodge>1.5s`).
- Any change in behavior with `UT_CONTEST_ON=false` vs the pre-snapshot (should be nil aside from the one log word).

Sanity reads while testing (optional, bridge): `frz=` should be >0 only if the freeze log appeared; `dodge=`
should be >0 only if AutoDodge actually rolled during the walk; `d0=` should equal the `d=` in the preceding
`Utility select: openable` line.

## Check-and-report item — imprisoned rare near an un-opened essence (rare:1083)
**Where rare:1083's candidacy came from:** the rare-engage candidate filter is `nearestRareToClear(player, now)`
(mapper.js ~2116), driven by `runClearNearbyRares` (~2170) which sets `rotRareId`. Its filters: subtype
includes `Rare`/`Unique`, `isHostileAlive`, not `BossCannon`, not `metadata/npc/`, not the map boss (if Unique),
not in `rotRareBlacklist`. **That's the whole filter.** `obRareTick` (~1516) then MIRRORS `rotRareId` into the
OB shadow as `rare:<id>` — so "OB claimed rare:1083" is OB reflecting whatever `nearestRareToClear` picked; OB
does not originate rare candidacy.

**Does the exclusion exist? NO.** There is no guard for a rare standing within ~12u of an un-opened essence
Monolith, and no `cannotBeDamaged`/invulnerability guard in the rare filter at all (unlike the boss-melee
scorers, which check `cannotBeDamaged`). An essence's imprisoned rare (alive, hostile, `Rare` subtype) passes
`nearestRareToClear` cleanly and becomes `rotRareId` — matching the incident (3.5s burned on "Rattling Gibbet
(unhittable from here)"). The only backstops today are (a) `runClearNearbyRares`' `ROT_RARE_TIMEOUT` (12s of
OWNED engage → 20s `rotRareBlacklist`) and (b) `entity_actions.js`' hp-frozen 5s ban (not touched this task).

**Why I did NOT ship the one-liner (deliberate, per brief "no edit unless it's a one-liner"):**
- A correct exclusion needs, inside `nearestRareToClear`'s scope, (1) the positions of essence Monoliths and
  (2) their un-opened state, then a ≤12u proximity test. There is **no cheap essence-Monolith source in that
  scope** — essences are only surfaced as openable UTILITY candidates (`openableType === 'Essence'`, excluding
  RuneRock/StoneCircle) via `getOpenableUtilityCandidates`; `POE2Cache.lastEssenceOpen` is a single last-open
  coordinate, not a live list. Building a list there = a new scan → needs a throttle + budget (violates the
  no-new-scans discipline for a one-liner).
- The alternative — a blanket `if (e.cannotBeDamaged) continue;` — is **unsafe**: the codebase intentionally
  still engages/dodges rares that are briefly untargetable (burrowing/emerging/spawn-invuln), and I cannot
  confirm from static code that an imprisoned essence rare even sets `cannotBeDamaged` (the incident predates a
  live probe). Skipping all `cannotBeDamaged` rares would regress those cases.
- I also cannot VERIFY that rare:1083 was in fact the essence's imprisoned rare without a live read during such
  a fight (the brief itself hedges "IF that was …"). Guessing beyond the brief is out of scope.

**Recommended follow-up task (needs a live confirm first):** during a live essence fight, bridge-read the
imprisoned rare — does it carry `cannotBeDamaged` (or another stable invuln flag), and is it co-located (≤12u)
with the essence's Monolith openable? If yes, the clean fix is a proximity guard in `nearestRareToClear` fed by
a throttled essence-Monolith list (reuse the openable-candidate essence classification, ~1s cache), skipping any
rare within ~12u of an un-opened one. TASK-13 item A (opener firing mid-roll) is the adjacent lane.

## Risks / deviations
- **Log-string change is non-gated** (documented above) — cosmetic, per the brief's explicit instruction.
- **`_utDodgeMs` accrues only on frames the utility step actually runs** (unlocked, non-arrival, openable). During
  a hard movement lock the step is skipped, so accrual relies on the recovery/unlocked frames within the 1200ms
  window catching the dodge hold — which they do (rolls repeat < MB.WINDOW apart). Combined with the freeze and
  the shove-away clause, contested detection has three independent triggers, so a missed accrual alone won't
  misclassify a real shove as walled.
- **`_utFrzUsed`/`_utDodgeMs` carry into a re-commit of the SAME key** after a defer expires (freeze budget is
  per-target-per-map by design — brief says don't touch the 20s cap). Effect: if the same object stalls again it
  is more likely to re-classify contested, which is the intended escalation path (25s→90s→ban), so it stays
  bounded. No unbounded loop.
- No change to `entity_actions.js`, `trackOwnedProgress`, the 5s threshold, or any non-openable utility path.

## Live-test round 1 (2026-07-11, MapSavanna — user retest, pre-report)
**Scenario (screenshot + console):** committed essence walk to a Monolith at d=132 ("Blood Priest", a Rare
**imprisoned** by *Perfect Essence of Command*). The path crossed a large patch of **ignited ground** (floor fire).
AutoDodge rolled repeatedly (many `[OB] freeze … by=dodge`), the player was shoved 132u → 147u, and at +10s:
`Utility openable unreachable (owned no-progress 5s at 147u) -> blacklist + skip` → `failed:no-net-progress` (600s),
then `IGNORED (utility blacklist)`. The contested-defer branch did **not** fire. User: "its close but over ignited
ground … didnt even go to essence."

**Why v1 missed all three contested triggers:**
1. `_utFrzUsed = 0` — the freeze probes for hostile **Monsters** within 60u. The hazard here is **ground fire**
   (no Actor/Monster) and the rare is **imprisoned** (not a valid engage). Correctly no freeze — so the dodge-ms
   signal had to carry it, and it didn't.
2. `_utDodgeMs` never reached 1500 — root cause: I read `MB.hold.owner === 'dodge'`, but `MB.hold` is rewritten by
   `MB.gate()` on **every** movement send, and the utility walker sends every unlocked frame → `MB.hold.owner` was
   `'utility'` on the frames my block ran. The dodges were real (OB saw them via `dodgeMoveSuppressUntil`) but my
   probe was blind to them, so the dodge frames counted as **owned** and fed the 5s clock.
3. shove clause `dist > _utCommitD + 15` = `147 > 147` = **false** (exact boundary miss).

**Fix applied (this session, mapper.js ~8512):** the stamp now uses the full watchdog idiom —
`now < dodgeMoveSuppressUntil || (MB.hold && MB.hold.owner === 'dodge' && now - MB.hold.at < MB.WINDOW)`. With the
reliable `dodgeMoveSuppressUntil` term, dodge+recovery frames are now excluded (owned clock pauses during active
dodging) and `_utDodgeMs` accrues, so the 5s verdict is either avoided outright (the bot keeps trying to reach the
essence — and ignited ground burns out within seconds) or, if it fires, is classified **contested → defer 25s** and
re-committed. `node --check` re-passed. **Flag-off parity preserved** (whole block still under `UT_CONTEST_ON`,
`dodgeMoveSuppressUntil` was already in scope).

**Expected on re-test (same scenario):** NO immediate `-> blacklist + skip` while dodge-rolling on the fire; instead
either the walk completes once the fire clears, or `Utility openable contested (… dodge=Xs …) -> defer 25s
(contested #1)` followed by a re-commit within ~25s. Worst case is the 15s monolith session cap → `failed:timeout`
with a 30s ttl (still a retry, not the 10-min ban). A genuine wall with NO dodging still bans long (owned clock runs
normally → not contested).

**Out of scope (noted, not fixed):** the bot won't PATH ACROSS ignited ground and AutoDodge shoves it off the fire
edge — a nav/dodge interaction, separate from the ban verdict TASK-15 owns. If the essence stays unreached after the
fire burns out, that's the follow-up (candidate: treat ignited-ground like the boss synthetic-hazard so nav routes
around it, or damp AutoDodge when committed to a utility openable). Flagging for the planner.

## Live-test round 2 (2026-07-11, MapSavanna — user retest #2)
**Result — TASK-15 core deliverable PROVEN:**
`Utility openable contested (owned no-progress 5s at 97u; frz=0.9s dodge=0.0s d0=77u) -> defer 25s (contested #1)`
— the 600s `failed:no-net-progress` ban is now a 25s contested defer. This is exactly the acceptance line. The
freeze also armed correctly this run (`Utility openable: hostiles nearby -> fighting through`, `frz=0.9s`), so the
`_utFrzUsed > 0` trigger carried the classification.

**Two findings from this run:**
1. **`dodge=0.0s` — the dodge accrual was still dead, deeper root cause found.** `runUtilityNavigationStep` calls
   `MB.request('utility', 4)` at its TOP; a dodge holds the broker at prio 1 and DENIES utility (prio 4), so the
   function returns early (~line 8279) BEFORE reaching the owned-test/dodge block far below. The roll frames were
   never observed there, so `_utLastDodgeAt` never stamped and the ~1s recovery frames (MB granted back, player
   re-pathing, not yet progressing) still counted as owned. **Fixed this session:** moved the dodge stamp to the
   FIRST statement of `runUtilityNavigationStep` (before the `MB.request` gate), so the roll frames are seen and
   the following recovery frames are held un-owned for 1200ms. The lower block now only computes the exclusion +
   accrual off that stamp. `node --check` re-passed; still flag-gated. Expected next run: `dodge=Xs` non-zero, and
   the owned clock pauses through roll+recovery (so on the pure ground-fire case — no monster, freeze=0 — the
   dodge signal now classifies it contested instead of walled).
2. **The essence still isn't OPENED.** Even deferred+retried, the bot cannot reach/service this Monolith. Console
   shows why: `[Opener] essence skip (Monolith): LoF-blocked at 49u (>40u)` — the opener needs ≤40u AND line-of-
   fire, but the target cell sits on/behind ignited ground so the walker can't close and LoF is blocked. This is a
   **reachability** problem, outside TASK-15's verdict scope, and is the user's actual blocker.

## User's proposed fix (approach-point) — RECOMMENDED NEXT TASK (not built here, per HOUSE_RULES one-task/session)
User: *"like the stone circle — you can't MOVE to the actual part, but you should find a walkable point within a
10-15u radius, go there, and let the opener do the rest."* This is correct and matches the existing StoneCircle/
RuneRock owner (`runStoneCircle`), which already stands at an offset from an unwalkable rock. Concretely the new
task should: when an openable's own cell is unreachable (no path / repeated no-progress), search the walkable grid
(the fog-independent vertex grid, [[poe2-nav-vertex-grid-spec]]) for the nearest cell that is BOTH within opener
range (≤40u, ideally ≤15u) AND has line-of-fire to the target, commit the walk to THAT cell, dwell, and let the
opener fire. Caveats to brief: (a) the LoF check is the real gate here (49u failed LoF, not just distance), so the
approach-point must be LoF-validated, not just distance-picked; (b) it must respect commitment discipline (one
owner, sticky point); (c) ignited ground is transient — a short retry may simply succeed once it burns out, so the
approach-point search should be the fallback after a defer, not a first resort. TASK-15's contested-defer already
gives the clean retry hook this feature would slot into. **Flagged for the planner as the next brief.**

## Live-test round 3 + REVERT (2026-07-11)
Round 3 (the recovery-exclusion relocated to the top of `runUtilityNavigationStep`) made the owned clock too sticky:
the clean 5s contested-defer stopped firing and the generic **8s wall-slide detour** (`stepPathWalker`, line ~6535)
took over instead → visible detour-yoyo. Per user ("revert your worse to watch") I **reverted round 3 back to the
round-2 state**: the dodge stamp lives inside the lower dodge block again (naturally inert during the MB-denied roll
frames, since `runUtilityNavigationStep` returns early at the `MB.request('utility',4)` gate). Net TASK-15 behavior =
the round-2 proven state (`defer 25s (contested)` fires cleanly via the freeze trigger; no 8s detour-yoyo). `node
--check` passes.

## Live bridge read (the decisive probe — MapSavanna essence, mapper off)
Read via `poe2.isWalkable` + `getEntities` at the Monolith cell (985,566):
- `cellWalkable: true`, full 5×5 grid around it walkable → **the cell is NOT an unwalkable wall.** The approach-point
  idea (StoneCircle-style) would NOT help — nearest walkable = the cell itself.
- rare `id:1083` (MonsterRare, the imprisoned essence rare) sits AT the cell (dCell 1), alive+targetable; a live white
  pack (ids 1072/1076 ~17-20u, 1074/1078 ~32u) around it; + the ignited ground from the screenshot.
- **Root cause of "won't reach the essence": AutoDodge fleeing the ignited ground (and pack) before the walker can
  close** — not reachability. This flipped the plan away from an approach-point (which the live read proved useless)
  toward damping the dodge's DoT-ground walk-out.

## BEYOND TASK-15 — user-directed "reach the opener through bad ground" (this session)
User spec across the session: *"walk through bad ground of any kind but don't STAY past 2-3 sec"* + *"keep
survivability, but after clearing what's around, if we can get to an opener/strongbox/essence, give the opener a
chance."* Implemented as a bounded, flag-gated hold. **This is outside the original TASK-15 brief** (touches
`auto_dodge_core.js`); flagging for the planner.

Mechanism (the yoyo source): for DoT ground (ignited/caustic/chilled/shock), `auto_dodge_core.js` does NOT roll — it
exports a goal-biased `walkEgress` that drags the player OUT of the field (`_dotGroundRisk && _insideField`, line
~1295; comment there records a prior IgnitedGround death). Since the essence sits IN the fire, that walk-out fights
the utility walk = the yoyo.

Round-3/4 live result: with the DoT-ground-only hold, the essence DID open (`[Opener] Opened Essence … Dist: 11.1`)
— proof the reach-hold works — but only after ~19s of dancing, because the guard is an **imprisoned CASTER** ("Blood
Priest", shock spells) whose *casts* (hard telegraphs) still drove AutoDodge to dance during the approach; the user
saw "no mobs, why is it dodging around it." So the hold was **broadened** to cover the casts too.

Change (final):
- `auto_dodge_core.js`: new `CFG.reachHoldActive` (default false). When the mapper publishes it true AND the player is
  at-risk, the core HOLDS against **all** risks — soft proximity nets, hard cast telegraphs, projectiles, AND DoT
  ground (clears `walkEgress`, no roll) so the walker plants and the opener clicks. **Self-capped ~2.5s continuous,
  then a 3.5s cooldown** (module state `_reachHeldSince`, `_reachHoldCool`). It **stands down while the opener-blast
  guard is armed** (`now >= _openerGuardUntil`) so the on-open essence explosion is ALWAYS dodged.
- `mapper.js`: consts `REACH_THRU_GROUND_ON = true`, `REACH_THRU_GROUND_MAXD = 50`. Publishes
  `autoDodgeCfg.reachHoldActive = true` only when: committed to an openable (`WALKING_TO_UTILITY`, `type==='openable'`),
  within 50u, and HP ≥ 60% (survivability floor). Flag off → always false → dodge behaves exactly as the pre-snapshot
  (byte-parity).

Survivability bounds (four, all active): (1) HP floor 60% on the mapper side — a real burst that drops HP re-arms the
dodge within ~1 scan; (2) 2.5s self-cap + 3.5s cooldown in the core; (3) 50u range gate; (4) the opener-blast guard
override always rolls the player out of the on-open explosion. The trade this makes explicit: while committed and
healthy within 50u, the bot will TANK the imprisoned rare's casts + ground for up to ~2.5s to land the click — which
is the user's stated intent ("walk through bad ground, don't stay past 2-3s; give the opener a chance").

### LIVE-TEST CHECKLIST — reach-through-ground (broadened)
WORKING: committing an essence guarded by its imprisoned rare, the bot beelines in (dodge log shows `opener-reach
hold` instead of repeated rolls/`walk-out`), the opener fires and opens it, THEN `ROLL … why=boss_telegraph:BossOpener`
rolls out of the on-open blast. No 19s dance.
BROKEN / watch for: (a) player dying / HP cratering during approach — raise the 60% floor or shorten the 2.5s cap
(both single constants in the two files). (b) It holding through the on-open explosion (should NOT — the
`_openerGuardUntil` stand-down covers it; report if `opener-reach hold` appears at the same time as an essence open).
(c) It tanking a genuine adjacent PACK (not just the imprisoned rare) — the HP floor should release it, but if a pack
is common at essences we may need a "pack cleared" gate. (d) Flag-off parity vs the pre-snapshot.

## Round 6 (AzmerianRanges) — essence SKIPPED for a distant abyss + high-value side-step rule
Live log: essence at **77u** logged `-> committing walk` then instantly
`Utility skip: openable -> live abyss objective in reach (objective wins)` — the OBJECTIVE-OVER-UTILITY guard
(`hasLiveObjectiveNear`, node-radius **600u**) vetoed it because a second abyss node existed elsewhere on the map;
post-abyss the bot walked to boss and never returned. Chest-era logic applied to an essence.

USER DIRECTIVE: *"GO AND DO essences and strongboxes nearby objectives, DON'T forget to return to the objective."*
The return path is already live-proven in the same log (content queue re-picked abyss:1468 after each loot detour,
finished it, moved to abyss:1412), and obTick freezes the committed content's clocks while the utility state owns
the frame — the objective's budget doesn't burn during the side-step.

Changes (mapper.js, `tryStartUtilityNavigation`):
- `_hvOpen(c)` predicate: openable AND ≤**120u** AND (Strongbox OR real Essence (not RuneRock/StoneCircle)).
- **Objective-wins veto**: `_hvOpen(selected)` is exempt (shrines already were). Far chests still vetoed.
- **Loot-only degrade** (committed objective / boss drive / OB deny): the candidate pass now APPENDS `_hvOpen`
  candidates from `getOpenableUtilityCandidates` (rides the opener's cached scan — no new entity scan), and an
  ACTIVE hv-openable walk survives lootOnly flipping true mid-walk (`!lootOnly || activeIsLoot || _hvOpen(active)`).
- Boss-approach distance caps unchanged (checkpoint/melee approach still cap openables at 80u — boss discipline
  intact; the 77u incident case passes).

LIVE-TEST: essence/strongbox within ~120u of an abyss/delirium run → `Utility select: openable` fires (no
`objective wins` skip), the open completes, then the objective is re-claimed (`[OB] claim=content:...` again) and
finishes. WATCH FOR: utility ping-pong between two objectives (if seen, the 120u cap or a per-map hv budget is the
knob), and OB `pause utility` bookkeeping lines while content is committed (cosmetic — the walk still runs).

**Abyss observations — round-8 CORRECTION (user diagnosed it, confirmed live):**
1. ~~Stale abyss re-commit after toggle reset~~ **WRONG — the abyss was legitimately active.** The abyss objective
   mob (rare:1310) was the IMPRISONED rare inside the nearby essence: the clearing pass found the area "mob-free"
   because its mob was locked in the crystal 60u away, invisible to the abyss clearer. Once the essence opened and
   the rare was engaged/killed (round 8, 12:38), the abyss completed and "the abyss is operational" (user). The
   USER called this two rounds earlier ("an essence may very well be something to complete the ABYSS"). Design
   note for the planner: content completion can DEPEND on a nearby essence — one more reason essences must never
   be deferred/skipped near objectives (the `_hvOpen` rule is therefore load-bearing, not just loot greed).
2. **Content fog-drive stomps the stuck-dislodge** (12:29 at 132u AND 12:37 at 58u, both `wall-slide` toward an
   abyss node): the drive re-issues `startWalkingTo('Content Explore')` every ~1.5s; at 12:37:54 the dislodge fired
   and was overridden 152ms later, so a wedged walk can never unwedge — the arbiter release (8-15s) is the only
   escape. The re-issue should respect an active dislodge/detour window. Own brief — still open.

## Round 8 (12:38) — per-click blast-guard roll-away on OPPORTUNISTIC essence opens + fix
Log: opener clicked essence 0x511 five times (24-33u) during a rare engage (`FINDING_BOSS`, OB rare:1310) and after
EVERY click `ROLL why=boss_telegraph:BossOpener` shoved the player ~40u out — the per-click essence-blast guard
(`noteBossEngaged` armed from `POE2Cache.lastEssenceOpen`, 2.2s hazard per click) re-armed faster than the walk-back.
The reach-hold did NOT cover it because it only engaged during `WALKING_TO_UTILITY`; this open was opportunistic.
**Fix (mapper.js, reach-hold publish):** a second trigger — `lastEssenceOpen` within 2.5s AND within 60u AND HP≥50%
→ `reachHoldActive=true` in ANY mapper state. While clicks are landing the player PLANTS; 2.5s after the last click
everything reverts. HP floor still bails a real blast; the core's 5s cap + 1.5s cooldown backstop stays.

## AFK soak test (user, from ~12:40)
User is letting the mapper run unattended. Post-soak triage list, in order: (a) essence encounters — expect plant +
rapid `Opened Essence` burst + fight, no BossOpener roll-loops, no `objective wins` skips within 120u; (b) any
`defer 25s (contested)` lines and whether re-commits followed; (c) the fog-drive/dislodge stomp (item 2 above) on
abyss maps; (d) HP dips during reach-holds (chicken potion lines during plants) — if deaths, tighten the 50% floor
or the core's 5s cap.

## Open questions
- The reach-through-ground feature is user-directed and beyond TASK-15's brief — the planner should decide whether to
  keep it as a code const or promote it to a UI setting, and whether the 2.5s/55% bounds want tuning after live use.
- The imprisoned-rare exclusion (`rare:1083` from `nearestRareToClear`, no essence-proximity guard) remains a parked
  follow-up; live read confirms 1083 IS the essence's imprisoned rare (dCell 1, alive), so the exclusion is warranted
  — brief it as its own task.
- TASK-15 itself (contested defer) is complete and proven; nothing blocking there.

---

## DONE — consolidated changelist (for the planner's tail review)
Three runtime files, all uncommitted. Flag/const-gated where noted; RuneRock/StoneCircle logic untouched.

### mapper.js
- **`UT_CONTEST_ON`** (const, default true) — TASK-15 contested verdict. Dodge-hole closed in `_utOwned`
  (freeze probe `UT_CONTEST_ON ? 60 : 45`u; `_utDodgeExcl` 1200ms recency off `dodgeMoveSuppressUntil`; per-key
  `_utDodgeMs`). Verdict splits: contested (`_utFrzUsed>0 || _utDodgeMs>1500 || dist>_utCommitD+15`) ->
  `defer:contested` 25s -> 90s -> 600s via `_utContestedCount` (cleared in `resetMapper`); else walled = original ban.
  State: `_utLastDodgeAt/_utDodgeKey/_utDodgeMs/_utDodgeAccrAt/_utCommitD/_utContestedCount`.
- **Essence subclassing** (`_isEssence` = `openableType==='Essence'` & not RuneRock; `_isMonolith` = RUNED only,
  `&& !_isEssence`). Essence gets: 30s session cap, EXEMPT from no-progress + no-path bans while targetable,
  `arriveDist` 42u (plant/dwell from opener reach), NO 5s stand. `utilityOpenableConsumed` extended to Essence
  (isTargetable false = opened -> retire instantly).
- **`REACH_THRU_GROUND_ON`** (const, default true), **`REACH_THRU_GROUND_MAXD=50`**. Publishes
  `autoDodgeCfg.reachHoldActive` when: (a) `WALKING_TO_UTILITY` + openable + ≤(essence 90u / other 50u) + HP≥50%;
  OR (b) OPPORTUNISTIC — `POE2Cache.lastEssenceOpen` within 2.5s + ≤60u + HP≥50%, ANY state.
- **`_hvOpen`** (essence/strongbox ≤120u): exempt from the objective-wins veto, offered during loot-only degrade
  (rides opener's cached scan), and survives lootOnly flipping mid-walk. `essence persisting` log replaces the ban.

### auto_dodge_core.js
- **`reachHoldActive`** cfg (default false). When set + `atRisk`: HOLD against ALL risks (casts/projectiles/fire/
  per-click blast), clear `walkEgress`, no roll. Self-cap 5s + 1.5s cooldown (`_reachHeldSince/_reachHoldCool`).
  The mapper's HP<50% gate is the real bail; NO opener-blast stand-down (tanks the per-click blast so clicks land).

### opener.js
- **`ESSENCE_FAST_RANGE=40 / ESSENCE_RETRY_FAST_MS=100 / ESSENCE_CLAIM_FAST_MS=80`**: within 40u the essence
  multi-click fires at ~100ms/tick (retry gap + own-claim both distance-aware); farther out keeps the 250ms gap.
- **`ESSENCE_MAX_ATTEMPTS` 9 -> 15** (headroom at the faster cadence).

### Flag-off parity
`UT_CONTEST_ON=false` -> TASK-15 byte-identical to pre-snapshot. `REACH_THRU_GROUND_ON=false` -> `reachHoldActive`
never true -> dodge behaves as pre-snapshot. Essence subclass / `_hvOpen` / opener cadence are behavioral (essences
were previously mis-served as RuneRocks / skipped); they are the fix, not gated.

### Pre-snapshots (diff base): `handoff/pre/TASK-15/{mapper,auto_dodge_core,opener}.js`

### Handoff / still-open (separate briefs, NOT in this task)
1. Content fog-drive re-issues `startWalkingTo` every ~1.5s and STOMPS the stuck-dislodge (2 abyss occurrences).
2. Imprisoned-rare exclusion in `nearestRareToClear` (rare within ~12u of an un-opened essence).
3. RuneRock essence-skip log spam (opener treats RuneRock as `openableType Essence` -> 56x `essence skip` in one
   soak; cosmetic, 5s-throttled, bounded to while the spent rock is streamed).
4. Silent-frame death (stale `getLocalPlayer`) = TASK-16, orchestrator-owned.
Planner: review this tail vs `handoff/baseline/`, then user live-verdict -> commit whole tail.

## Round 9 (post-DONE tweaks, MapPit 14:45)
- **opener.js cadence 100ms -> 200ms** (`ESSENCE_RETRY_FAST_MS` 200, `ESSENCE_CLAIM_FAST_MS` 150). Observed real
  click cadence was ~800ms (opener scan-throttle + game per-interact processing gate it), so 100ms was just firing
  wasted interacts between the real clicks; 200ms is cleaner (user request).
- **Essence/strongbox as a GO-TO target, not a boss-drive-capped detour** (user: "if the essence location is KNOWN
  it should be an OBJECTIVE to go to"). Root of the 14s commit delay: the essence was a candidate from d=245 but the
  80u checkpoint openable cap held SELECTION until it walked to d=79. Fix: `_hvOpen(selected)` (essence/strongbox
  <=120u) now also exempt from the three boss-drive gates — the far-drive skip (`_hvOpenable` regex lacked essence),
  the FINDING_BOSS `findingBossSelectedCap`, and the checkpoint/melee `selectedDistCap`. So a known essence within
  120u is diverted-to during the boss drive instead of held. Trash chests still capped (only `_hvOpen` exempt).
- **NOT done (proper new brief): essence as a FIRST-CLASS content-queue objective** (routed by the arbiter like
  abyss regardless of distance, with its own populateContentQueue entry / runner / completion / priority). That is a
  real change to the arbiter+queue system and would need to class essence as OPTIONAL content (else it over-drives
  the boss for a far essence). The `_hvOpen` distance-cap exemption above gets the practical "go do the known
  essence within 120u" behavior without that risk. Recommend briefing the full version separately if the ≤120u
  reach isn't enough in practice.
