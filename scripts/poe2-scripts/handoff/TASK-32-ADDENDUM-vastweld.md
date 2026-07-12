# TASK-32 ADDENDUM — second one-shot (Vastweld, Forge 13:24) + unique path-gate (windy-map yoyo)

Read AFTER TASK-32-boss-catchall-promote-reachhold-scope.md. Same session as that brief or as a follow-up
mini-task if 32 already shipped — say which in the report. Adds evidence + three items.

## Evidence (Forge 13:24:02-13:24:15, C:\tmp\log.txt)
"Vastweld, the Colossal Guardian" (5.1M): targetable seen from 82u -> the melee-entry walk closed to 29u and
PARKED ~9s (zero rotation casts 13:24:02-13:24:11 — the 'Boss Melee Route Up' target suggests an
elevation/LoF gate; instrument, don't assume) -> first damage 13:24:11.9 -> FIGHTING_BOSS -> ONE catchall
roll (anim_1086 — THIRD boss in a row opening with a 1086 roll: Rootgrasp, Frostborn, Vastweld; it is a
generic id, not a slam signal) -> 6 IceShots standing PLANTED -> slam ~13:24:14 -> one-shot dead, 2s after
engagement. No chicken window. Identical signature to the Frostborn death in the main brief.

## H. Fresh-boss entry posture (extends item C — "prepare for it")
A boss's FIRST action after engagement is routinely its biggest slam. FIX: for the first
`BOSS_ENTRY_MOBILE_MS = 5000` of FIGHTING_BOSS, the fight controller keeps the char MOVING — strafe arc at
current range via the existing kite/moveAngle machinery, no planting; casts continue (bow casts while
repositioning between packets). Same non-negotiables as C: MB dodge holds outrank it, aborts on death
routing. Const rides `UNHITTABLE_EVADE_ON` or its own `BOSS_ENTRY_MOBILE_ON = true`.

## I. Ranged standoff — stop PARKING in slam range
The melee-entry machinery exists to RESOLVE the arena (boss-arena-resolution ruling) — it must not become
the fight position. Once the boss is targetable AND we have line-of-fire, a ranged profile holds
`BOSS_STANDOFF_U = 60` (do not keep closing to <30u; back out to standoff if entry left us inside it).
Melee-entry still walks in as today when the boss is NOT yet resolved/targetable. If the existing opt-in
kiteBoss flag already implements the standoff loop, wire this as: kiteBoss forced ON while
`BOSS_STANDOFF_ON = true` for this build profile — reuse, don't duplicate.
ALSO instrument the 9s cast-gap: one throttled line naming the auto-attack gate reason while a targetable
boss is in range but casts hold (LoF raycast? awake gate? melee-walk cast-hold?) — feeds the D diag.

## J. Unique engage must be PATH-gated (TASK-31 C defect, planner's spec gap — windy-map yoyo)
Live (Forge ~13:20): [Engage] unique Ulfred at 177u committed across a maze wall — euclidean-close,
path-far/unpathable -> walker ground against the wall, 12s cap burned, timeout, re-commit on next sighting.
FIX in the TASK-31 C eligibility (nearestRareToClear): a unique beyond ROT_RARE_RANGE is eligible ONLY if
`jsBfsPath` to it (or its walkableApproachPoint cell) EXISTS and path length <= `UNIQUE_ENGAGE_PATH_MAX =
250`; re-check throttled ~2s (it becomes eligible the moment exploration opens the corridor). Plus early
bail: engaged unique + no net progress toward it for 4s -> release + blacklist 60s (un-blacklist early if
its distance shrinks or its hp drops). Rares (<=62u) unchanged.

## K. Capture-run constraint on the D diag (main brief)
The planned capture run is: mapper ON (walks in, FIGHTING_BOSS, dodge live) + entity_actions AUTO-ATTACK
OFF, so the boss survives long enough to show its whole kit while the user pilots/observes. Therefore the
[BossFight] diag MUST run whenever FIGHTING_BOSS is active regardless of auto-attack state — do not gate
it on the rotation/aa loop or on having a current attack target. (Reading boss anims needs no target lock;
the dodge core already scans boss-rarity entities.)

## Hard limits (additive to the main brief's)
- Same three files. H/I must not fight the dodge or the boss-approach cooldown machinery; J stays inside
  the existing engage/blacklist plumbing. Every item flag-gated, flag-off parity.
