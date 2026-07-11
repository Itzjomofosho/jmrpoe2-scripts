# TASK-19 — Abyss chests as first-class objectives: sweep NOW not post-boss, stop whiff-burning bans (Pit 2026-07-11)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\opener.js` into `handoff\pre\TASK-19\`.

## Live evidence (C:\tmp\log.txt, MapPit ~15:11-15:13) + user ruling
User: "not opening abyss chests again, ABYSSAL chests NEED to be objectives too n completes."
What the log shows:
- `[AbyssSweep] ... pruned on objective-complete -> chest site queued` x4 at 15:12:22 — TASK-08's site collection
  WORKS, and the bot was STANDING right there when the sites queued.
- But `tryAbyssChestSweep` is only called from MAP_COMPLETE Phase 3.8 (~15259) — mid-map nothing drives it, so the
  bot walked off toward the remaining objective/boss.
- Meanwhile the opener drive-by-clicked the spawned chests at range while the mapper walked:
  `AbyssChestCurrency 0xD3C` at 32.9u -> 39.7u -> 48.1u (same chest, distance INCREASING = whiffs; an interact
  from 40u+ while the mapper owns movement never lands), `AbyssChestRareWeapons 0xD19` twice. Those whiffs burn
  the chest's free-retries/3-attempt budget -> the chest can be opener-BANNED before the post-boss sweep ever
  stands next to it, and then the sweep waits at a site whose chest the opener refuses to click (25s cap wasted,
  chest stays shut). That is the recurring "not opening abyss chests".

## What ships
### mapper.js — drive the sweep when the sites appear (pre-boss), keep post-boss as the sweeper-up
1. Add a PRE-BOSS hook for the existing runner: in the pre-switch content chain (beside `runStoneCircle`, same
   state gate `FINDING_BOSS || WALKING_TO_BOSS_CHECKPOINT`, below breach/hive/stone so it never preempts a live
   runner): `if (ABYSS_SWEEP_ON && abyssSweepSites.length && runAbyssRunIdle() && tryAbyssChestSweep(player, now)) return;`
   — where the idle guard means no abyss wave and no breach roam currently own the frame (`abyssId === 0 &&
   rotBreachActivatedAt === 0`; verify exact symbols). The sites queue at the moment the objective bit flips —
   the bot is USUALLY STANDING AT THEM (this log proves it); sweeping immediately is a ~zero-walk detour.
   The MAP_COMPLETE Phase 3.8 call stays untouched (post-boss leftovers). The shared BUDGET/caps already prevent
   double-spending (one budget anchor, `abyssSweepLooted` dedupes sites across both hooks).
2. OB narrative: register the pre-boss sweep with a dedicated-layer adapter mirroring `obStoneClaim`/`obStoneRelease`
   (layer 'sweep', pri `OB_PRI.optional`, anchor = current site) — claim on first pre-boss sweep frame, complete on
   sites-drained/budget. MAP_COMPLETE hook stays unregistered (cleanup owns that phase), exactly like stone.
3. Visibility + completes (the user's "objectives n completes"): count sweep sites in the `[Queue]` heartbeat line
   (`abyss-chest:N`) and add an `abyss-chest d/t` tally to MAP SUMMARY content (d = sites looted or probed-empty,
   t = total ever queued; track two counters beside the existing sweep state, reset per map). The user must be able
   to SEE chests were done (or why not) in the audit line.
### opener.js — stop the whiff-burn + let the sweep actually open
4. Range-gate abyss-chest sends: a target whose name matches `/abysschest/i` only FIRES within **25u** (user:
   40 still whiffs — the log's one clean open was 24.4u and 0xD3C whiffed at 32.9u; below ~25u the interact
   lands without a long auto-walk to cancel). The collect/candidate path keeps seeing it; just don't send beyond.
5. Export `clearOpenBansNear(x, y, r, nameRe)` (walk `openBlacklist`, delete/unban entries whose key position is
   within r and name matches). mapper's sweep calls it ON ARRIVAL at each site:
   `clearOpenBansNear(site.x, site.y, ABYSS_SWEEP_CHEST_R, /abysschest/i)` — a chest that got ban-burned by
   drive-bys opens anyway once we are actually standing there. One call per site arrival, not per frame.
### mapper.js — GENERAL walkable-approach (user: "like we did with essences and runed monoliths")
6. Lift TASK-13's `stoneApproachPoint` ring-probe into a shared helper `walkableApproachPoint(tx, ty, px, py)`
   (same algorithm: rings 2..16, innermost walkable cell nearest the player; keep `stoneApproachPoint` as a
   thin alias or call site of it — do NOT change stone's behavior). Apply it at TWO call sites, both with the
   TASK-17 fog rule (`poe2.isWalkable` is FOG-GATED — only compute the cell when the player is within ~45u of
   the target; farther out keep walking at the raw coords via the existing route):
   a. The abyss-chest sweep site walk: when within 45u of a site whose own cell reads unwalkable, walk to the
      approach cell instead (pit-edge chests sit on/next to unwalkable node cells — the wall-slide stucks).
   b. The utility OPENABLE walk (`runUtilityNavigationStep`): when dist <= 45u AND the target's cell reads
      unwalkable AND owned no-progress is accruing (>1.5s), re-target the approach cell once (cache it per key;
      recompute only if it too proves unwalkable on arrival). Strongboxes/shrines/essences sit on props — this
      replaces wall-slide thrash + dislodge with one clean sidestep. Loot targets are UNTOUCHED (drops lie on
      walkable ground).

## Hard limits
- Const-gated: reuse `ABYSS_SWEEP_ON` for 1-3 (no new flag); `OPENER_ABYSS_RANGE_ON = true` for 4-5. Flag-off =
  byte-parity each.
- Never preempt: live abyss wave, breach roam, hive defense, stone circle, boss-melee/fight states.
- No new scans: the sweep's existing probe covers chest presence; the queue-line/summary counters are arithmetic.
- Do not touch the prune logic, `abyssSweepAdd`, the runner's wave/loot-dwell machinery, or the sweep's 5 bounds.

## Acceptance
- `node --check` both files; flag-off parity.
- Report per HOUSE_RULES + live-test checklist: on an abyss map, when the objective bit flips the bot sweeps the
  queued sites IMMEDIATELY (`[AbyssSweep] site ...` lines pre-boss, chests OPEN — chestIsOpened/de-stream, loot
  picked), no drive-by `Opened Chest: AbyssChest*` beyond 40u, a previously-banned chest opens after arrival
  (unban line), MAP SUMMARY shows `abyss-chest d/t` with d==t on a clean run.
