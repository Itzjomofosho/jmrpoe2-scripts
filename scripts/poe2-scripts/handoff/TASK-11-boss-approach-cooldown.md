# TASK-11 — Boss-approach cooldown + abyss mid-node TTL hold

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-11\`. File: `..\mapper.js` only.
Two items: A (the cooldown, below) and B (a two-line follow-up from the TASK-05 review).

## B. Abyss mid-node TTL hold (TASK-05 open question 2, planner-adjudicated YES)
TASK-05's grace-finish exempts the mid-node abyss entry from the objective-complete gates via `abyssMidNode()`,
but the arbiter's hard TTL eviction (search `arbTerminated` -> the `arbCommittedTtl` branch) can still evict a
mid-node dwell: a long walk + the 45s clear + loot can exceed the 60s abyss TTL, releasing the commitment
mid-dwell — the same chest-loss class through a different door. Fix: in that TTL branch, while
`abyssMidNodeEntry(e)` is true, HOLD (advance `arbCommittedSince` so the TTL re-arms rather than fires) — the
runner's own dwell caps are the bound, and they always terminate. Do not touch the TTL for any other type.

## Problem (live, LoftySummit 21:34-21:36, user manually rescued)
Checkpoint REACHED (`gate=checkpoint-confirmed`), melee mode committed `Boss Melee Approach at (3304,1177)` —
and the interior point is disconnected from the arena mouth: `findPathTerrain` returns 2-3-wp stubs, the macro
router returns the same dead 5-wp answer, frontier reads wf=1.00 (nothing local left to reveal). The net-progress
watchdog fired 8x in 2 minutes (`No net progress toward Boss Melee Approach for 8s at ~165u`), each time
dislodging + re-picking the SAME point. Every escalation works; nothing bans the target. The 10-min stale
failsafe is the only exit and it is far too slow for a proven-unreachable loop.

## Fix (the checkpoint watchdog's shape, applied to the melee approach)
1. New state: `bossMeleeApproachFailN`, `bossApproachCooldownUntil` (reset in `resetMapper`; FailN also resets on
   entering WALKING_TO_BOSS_MELEE and whenever the approach target moves >40u).
2. In the melee-approach loop's stuck handling (search `bossMeleeExploreNoPathCount` — the branch where
   `bossApproachStep === 'stuck'`): count `bossMeleeApproachFailN++` on each watchdog/stuck verdict. At >= 3:
   - `bossApproachCooldownUntil = now + 45000`
   - also set the existing fog-block: `fogBlockedAnchorX/Y` = the arena centroid if `getBossArenaCentroid()`
     returns one, else `bossGridX/Y`; `fogBlockedAnchorUntil = now + 45000; fogBlockedAnchorConf = 0.9`
   - log `Boss approach (x,y) unreachable x3 -> 45s cooldown, explore-to-reveal another way in`
   - `setState(STATE.FINDING_BOSS)` and reset FailN.
3. Honor the cooldown at EVERY boss-approach entry so FINDING_BOSS can't instantly re-enter the loop:
   - FINDING_BOSS's arena-terrain fast path (search `Boss arena (terrain) at`) — skip while
     `now < bossApproachCooldownUntil` (fall through to explore/strategy-5, which chases elites + reveals).
   - FINDING_BOSS's checkpoint-entity fast path (search `Boss checkpoint entity at`) — same skip.
   - The WALKING_TO_BOSS_CHECKPOINT reached->melee transition (search `switching to melee engagement`) — if the
     cooldown is active, go FINDING_BOSS instead (defensive; the fast-path skips should make this unreachable).
4. While the cooldown runs, normal exploration/rare-clear continues — that IS the mechanism that reveals the real
   route up on summit/cliff arenas. Expiry retries the approach fresh with better map knowledge. Repeated cycles
   are fine: each is bounded (3 verdicts ~30s + 45s cooldown), and the 10-min stale failsafe plus strict-finish
   remain the outer bounds.

## Hard limits
- Do NOT touch the watchdog itself, the advance-cycles ladder, the arena shell, the checkpoint gate logic, or
  the engage detector. This is ONLY: count -> cooldown -> skip-while-cooling.
- No new settings.

## Acceptance
- `node --check mapper.js`.
- Report per HOUSE_RULES; live-test checklist: on a disconnected-interior arena, after ~3 watchdog verdicts the
  log shows the cooldown line, the bot demonstrably explores/fights elsewhere for 45s (no `Boss Melee Approach`
  lines during it), then retries; no manual rescue needed.
