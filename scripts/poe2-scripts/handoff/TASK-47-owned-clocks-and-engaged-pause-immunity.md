# TASK-47 — Runner ban-clocks tick through preemption (unjust skip-bans) + engaged content strangled by rare/utility pauses

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-47\`. File: mapper.js ONLY. USE FABLE
(arbiter/runner-subtle). Evidence: C:\tmp\log.txt (FrozenFalls, 2026-07-13 11:11 + 11:16-11:17).

## Why now: TASK-43-B made ban-justice LOAD-BEARING
The arbiter now honors runner skip-bans (correct). But a runner ban earned on UNOWNED frames is unjust, and
where the old thrash would eventually stumble back to the target, the fixed arbiter properly walks away.
So the clocks that EARN bans must only tick while the runner actually owned the pursuit.

## BUG 1 (live-proven): breach walk-clock ticked through an 18s rare pause -> instant unjust ban
- 11:11:00 claim=content:breach:52; walk reaches 37u
- 11:11:17.909 [OB] pause content:breach:52 by=rare  (rare pri 3 legally preempts optional content pri 4)
- 11:11:35.944 [OB] resume (paused 18036ms)
- 11:11:35.946 (+2ms!) [Breach] Brequel 52 no progress (closest 37u) -> skip  -> 60s ban -> arb-release
- The OB release line PROVES the knowledge existed: `owned=2222ms paused=18858ms frozen=6260ms`.
ROOT: runWalkToBreach (~2915): `(now - rotBreachClosestAt > 11000) || (now - rotBreachStart > 50000)` — raw
wall-clock. The 11s no-progress window elapsed entirely inside the rare pause. The 50s backstop is equally
blind (a 45s utility pause nearly exhausts it on its own).

## FIX A — OWNED-FRAMES RUNNER CLOCKS (flag `OWNED_RUNNER_CLOCKS_ON = true`)
The commitment-discipline module already exists (trackOwnedProgress ~2402, "a target may only be BANNED for
unreachability measured while WE owned the frames") and the OB already accounts owned/paused/frozen ms per
commitment. Wire the runners' WALK/no-progress clocks to it:
- runWalkToBreach (~2904-2916) — PRIMARY. The closest-approach clock (rotBreachClosestAt) and the 50s
  backstop must FREEZE (advance their anchors) while the pursuit is not owned: OB reports the committed
  content paused/frozen, OR now < dodgeMoveSuppressUntil, OR targetName isn't the breach walk's. Simplest
  robust shape: advance rotBreachClosestAt/rotBreachStart by the frame delta whenever un-owned (mirror
  trackOwnedProgress), or convert to trackOwnedProgress outright.
- AUDIT the same class (report a table, fix where raw): abyss Phase A (~3838 — partially guarded by the
  physically-moving test), verisium walk legs, incursion chest/beacon runners, StoneCircle pursuit. Fix any
  that can be starved by a pause the same way; leave well-guarded ones alone (say why).
- The runner DWELL caps (breach roam 120s, abyss 45s node cap, exp2 fight caps) are NOT in scope — those own
  their frames by definition. Only the REACH/walk clocks that can be starved by preemption.

## BUG 2 (live-proven): engaged verisium paused 45s by utility/rares -> user had to kill the mobs himself
- verisium:1320 committed + ENGAGED (opened, clear-mobs live); rare-surround fight + Armourer's Strongbox
  utility detour (whose guard-wave event hold keeps holding while guards live -- near a verisium mob field
  they don't die) steal the frames: 11:17:15 `[OB] resume content:verisium:1320 (paused 45222ms)`.
- User: "well it IS active and I went back to kill the mobs" -- the char wandered off an engaged verisium.

## FIX B — ENGAGED-CONTENT PAUSE IMMUNITY (flag `ENGAGED_NO_PAUSE_ON = true`)
The CONTENT_POLICY lockOnEngage intent (breach/verisium time-sensitive once engaged) exists as scaffold
(~5157) but is NOT enforced in the frame-stealing paths. Enforce it: while the committed content is ENGAGED
-- rotBreachActivatedAt>0 / (exp2Phase!=='idle' && exp2CurId) / abyss mid-node dwell / hive defense live --
the RARE-chase layer and the UTILITY detour layer may not take the frame from it:
- Rares INSIDE the content's working radius (~90u of the content anchor) are part of the content fight --
  the runner/attack chain kills them anyway. Rares OUTSIDE it WAIT (defer, don't ban -- commitment
  discipline). Dodge/PANIC/blind-egress and pickit's instant grabs keep their priority untouched.
- Utility detours (openable/loot walks, incl. strongboxes and their TASK-29B guard-wave hold) do not START
  while committed content is engaged; an already-holding strongbox event releases its hold if the committed
  content becomes engaged (the guards near a mob field never die -- the hold must not transfer the map).
- Where: the legacy priority chain that lets rare/utility drive over content (the paths that produce
  `[OB] pause content:* by=rare/utility`) -- gate at the STEAL POINT, not inside OB bookkeeping (OB pause
  records must keep reflecting reality). State in the report exactly which call sites got the gate.

## Hard limits
- mapper.js only. No new state machines; reuse trackOwnedProgress, the OB owned/paused accounting, and the
  existing engaged signals (same ones FIX-A/43-B read). Both fixes independently flagged; flags off =
  today's behavior byte-parity. `node --check`; parity walk. TEST BEFORE COMMIT.
- Do NOT change the OB priority ladder numbers (required content pri 2 / rare 3 / optional content 4 /
  utility 5) -- B is an ENGAGED-state override at the steal point, not a re-ranking.

## Acceptance
- Live breach: a rare pause mid-walk does NOT age the breach's no-progress clock (resume -> pursuit
  continues; no `no progress -> skip` within seconds of a resume); the OB release line's owned= must
  roughly match the clock that banned.
- Live verisium/breach engaged: no `[OB] pause content:* by=rare/utility` spans >~5s while engaged; the
  strongbox detour never starts mid-engagement; user never has to finish content mobs manually.
- Deferred rares OUTSIDE the radius are re-picked after the content completes (defer, not ban).
