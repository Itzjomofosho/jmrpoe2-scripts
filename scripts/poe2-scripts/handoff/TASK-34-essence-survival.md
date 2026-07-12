# TASK-34 — Essence survival bundle (SinterRift essence DEATH 15:04-15:05, 2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\auto_dodge_core.js` AND `..\opener.js` into
`handoff\pre\TASK-34\`.
Evidence: C:\tmp\log.txt (SinterRift 15:04:42-15:05:02). Death chain: 4 commit-clicks on a Monolith from
27-35u with a dodge ROLL after EVERY click (the per-click yoyo TASK-15 killed is BACK — see A), essence
opens 15:04:58, juiced rares (Perfect Essence) spawn on the crystal, char STAYS at 24u and even pickit-loots
the essence drop mid-fight (15:04:59.8), ONE potion 15:05:02.7, dead ~2s later from near-full hp.

## A. Plant-hold radii don't match the opener's REAL click band (TASK-32B spec bug — planner's)
32B scoped reachHoldActive to <=REACH_HOLD_PLANT_R (15u) or commit-click <=REACH_HOLD_COMMIT_R (25u). The
opener actually clicks essences from 27-35u (log: Dist 35.1/28.6/27.9/28.7) -> the hold NEVER armed -> the
dodge rolled between clicks (ROLL why=boss_telegraph:BossOpener at :52.9/:54.4/:56.0 interleaving the
clicks) -> 4 attempts, prolonged exposure.
FIX: the plant window must be keyed to the opener's actual behavior, not a distance guess:
`REACH_HOLD_PLANT_R = 36` and `REACH_HOLD_COMMIT_R = 36` (covers the observed click band + jitter), AND the
plant condition additionally requires the opener to be ACTIVE on that target (an opener MB/OB freeze within
the last 2.5s or lastEssenceOpen fresh) so the widened radius does not resurrect the 90u walk-in tank that
32B correctly removed. The walk-in (>36u) keeps normal dodge. Flag stays REACH_HOLD_PLANT_SCOPE.

## B. Post-open essence fight = BACK OUT to bow range, loot only when clear
The guards spawn ON the crystal; standing at 24u in the spawn is the death spot, and pickit looting
mid-fight anchors the char there.
FIX (mapper.js): the moment the committed essence reads opened/consumed (the existing 'essence skip:
untargetable (opened or guarded)' / consumed path), if hostiles remain within ~70u of the crystal: enter an
ESSENCE FIGHT posture — back out to ~55-60u from the crystal (reuse the kite/standoff step machinery; bow
range) and let the rotation kill the guards from there; the utility session stays owned (clocks frozen as
today, 20s cap unchanged). Loot (the existing loot-dwell / sweepLootStep) only starts when no hostile is
within ~60u of the crystal. Log edges: `[Essence] opened -> falling back to bow range (N hostiles)` /
`[Essence] guards dead -> looting`. Const `ESSENCE_FIGHT_STANDOFF_ON = true`.
Pickit gate: while the essence-fight posture is active, suppress pickit pickups within the crystal's 40u
(the drop is not going anywhere) — publish the existing one-way-bus pattern (POE2Cache flag + until), pickit
consumes it. Name it `lootHoldUntil`/similar; list the exact bus fields in the report.

## C. PANIC egress — heavy drain overrides everything (extends TASK-33 A)
TASK-33's blind egress requires the hazard list EMPTY -> it is structurally blind during fights, which is
where the essence deaths happen. A drain fast enough is proof the current tactic is failing regardless of
what is visible.
FIX (auto_dodge_core.js): `PANIC_EGRESS_ON = true`: pooled hp+es drop >= `PANIC_DROP_PCT = 25` within 2000ms
(same ring buffer as TASK-33 — reuse) -> arm the egress walk-out REGARDLESS of the hazard list, heading =
most-open ground away from the enemy centroid (the TASK-33 heading chooser — reuse), for 1500ms committed,
re-armed while the drain continues. This OVERRIDES rolls-in-place, the channel-hold, and the reach-hold
(a plant is already lethal at that drain; the hp floors agree — this just reacts faster). It does NOT
override an MB dodge hold mid-roll (let the roll finish; take the frame next tick). Log
`[AutoDodge] PANIC egress: hp -NN% in 2s -> leaving the fight`.

## Hard limits
- Files: mapper.js + auto_dodge_core.js + opener.js (only if A's opener-active signal needs a stamp the bus
  lacks — prefer reusing lastEssenceOpen/openCommitAt, say which in the report). Reuse the named machinery
  (kite step, sweepLootStep, TASK-33 ring/heading, one-way bus pattern). All flag-gated, flag-off parity.
- B must not deadlock: the 20s fight-through cap + the utility session bounds stay; if guards persist past
  the cap the session defers exactly as today (posture just changes WHERE we stand while it runs).

## Acceptance
- `node --check` all three; parity walks.
- Report per HOUSE_RULES + live checklist: an essence open shows ZERO rolls between clicks (hold armed at
  27-35u), then `falling back to bow range`, guards killed from ~55u+, `guards dead -> looting`, loot
  collected; a burst-drain fight (any content) shows the PANIC egress line + immediate walk-out; the 32B
  walk-in scoping still holds (no 90u tank on approach).
