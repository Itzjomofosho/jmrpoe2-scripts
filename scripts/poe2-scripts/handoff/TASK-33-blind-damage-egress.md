# TASK-33 — Blind-damage egress + breach done-dequeue (Mire + SinterRift deaths/standstill 2026-07-12)

FIRST ACT (HOUSE_RULES): copy `..\auto_dodge_core.js` AND `..\mapper.js` into `handoff\pre\TASK-33\`.
Evidence: C:\tmp\log.txt — TWO deaths from the same blindness: Mire 14:32 (~30 on-death explosive ground
circles, zero hazards seen, potion every ~3s, died) and SinterRift 14:42-14:43 (rares + IGNITED ground
during an essence approach, zero ground hazards seen, potions 14:42:51/:54/14:43:12/:13, died). Plus the
SinterRift standstill 14:39:29-14:39:51 (item C).

## The failure
14:32:08-14:32:22: health potion at 90% threshold every ~2-3s (sustained heavy drain), rotation firing the
whole time, an Exalted Orb picked up MID-BURN — and ZERO dodge lines in the window. The whole log has TWO
`why=ground` rolls. These on-death explosion circles never enter the hazard list at all (the classified
GroundEffect types — Vortex/Smoke — dodge fine). The dodge cannot dodge what it cannot see, and per-type
classification will ALWAYS lag new content. The fix is damage-driven, type-blind.

## A. Blind-damage egress (the fix)
In the dodge core (it already tracks pooled hp+es per scan for the damage-unmute — REUSE that plumbing, no
new reads): when pooled hp+es has dropped >= `BLIND_EGRESS_DROP_PCT = 15`% within `BLIND_EGRESS_WINDOW_MS =
2500` AND the current scan's actionable hazard list is EMPTY (nothing visible to dodge away from) -> the
char is standing in something invisible: arm the EXISTING walkEgress escape (reuse the heading + progress
watchdog machinery) for `BLIND_EGRESS_HOLD_MS = 1500`.
Heading: no hazard geometry exists to flee, so pick the direction with the most OPEN WALKABLE ground
(probe the 8 bearings a short ray, reuse the egress helpers), tie-broken AWAY from the current/most-recent
attack-target position — on-death explosions spawn where mobs die, which is where we have been shooting;
away-from-the-kill-zone is the best type-blind prior.
Re-arm while the drain continues (fresh window each trigger, new heading each time so we do not ping-pong);
stop the instant the drain stops or a real hazard appears (normal dodge takes over). Bounds: never while
`_chHoldActive` below the hp floor rules already in place, never during the opener plant hold (reach-hold's
OWN hp floor still bails), respects the existing egress cooldown state. Log per arm:
`[AutoDodge] blind egress: hp -<pct>% in <s>s, no visible hazard -> walking out <dir>`.
Const `BLIND_EGRESS_ON = true`; off = byte-parity.

## B. Unknown-ground capture (TEMP diag — removed with the other TEMP diags in the cleanup task)
The moment A triggers, ONE-SHOT (per trigger, throttled 5s) dump the non-monster entities within 30u of the
player from the shared list: path, type/subtype, and the groundEffect radius field where present -> so the
next occurrence NAMES the explosion-circle entity class and we can classify it as a real ground hazard in a
follow-up. Log lines prefixed `[BlindGround]`. Const `BLIND_GROUND_DUMP_ON = true`.

## C. Breach runner exits done but the QUEUE ENTRY survives -> arbiter re-commits it forever (standstill)
Live (SinterRift): `[Breach] done -> leaving (resumed pre-breach heading)` 14:39:29 — but the contentQueue
entry breach:32 stayed ACTIVE: `[ArbShadow] pick=breach:32 NEAR ins=9 ... committed=breach:32` +
`[Ckpt] yielding to route-gated breach:32 (ins=9u)` re-fired every ~10s with the runner having nothing to
do -> the checkpoint walk never got a frame -> the char STOOD (user restarted the mapper; breach was 1200u
behind by then... i.e. the bot stood AT the dead breach). Same stale-entry family as the old verisium
phantom (fixed then via an objectiveTypeComplete gate).
FIX (mapper.js): the breach runner's done/leave exit marks its contentQueue entry completed (dequeue --
completionSource 'runner-done') so the arbiter cannot re-commit a breach the runner already finished. Check
the OTHER breach exits (timer-expired, abandon) for the same leak and close them the same way — list each
exit + its handling in the report.

## Hard limits
- Files: auto_dodge_core.js (A/B) + mapper.js (C only). A reuses the pooled-hp tracking + walkEgress
  machinery (a second escape mechanism is an auto-reject). No new entity scans (B reads the shared per-frame
  list). All consts flag-off parity; C is a bug fix on the runner exit path (say so in the report).
- The trigger MUST require the hazard list empty — when hazards ARE visible the normal dodge owns the frame
  (this is a backstop, not a competitor).

## Acceptance
- `node --check` both; parity walks.
- Report per HOUSE_RULES + live checklist: standing in an invisible damaging ground (explosion circles,
  ignited ground) produces the blind-egress line + visible walk-out within ~2.5s of the drain starting (no
  more potion-chains while stationary); a [BlindGround] dump identifying the ground entity class; normal
  classified grounds still produce ordinary `why=ground` rolls; a finished breach never re-appears as the
  arbiter's committed pick after `[Breach] done -> leaving`.
