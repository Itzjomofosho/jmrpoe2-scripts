# TASK-67 — Un-activated breach must not expire while its claim is paused; owned=0ms claims must never release as "complete"

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-67\`. mapper.js ONLY. USE OPUS 4.8.
No bridge needed (log-diagnosed; the failure is deterministic in the claim/queue state machine).

## Evidence (C:\tmp\log.txt, Oasis 13:56, 2026-07-14 — all three lines the SAME millisecond)
13:56:08 arb commits breach:235 (204u, reachable), MI breach preempts nav, walk starts. 13:56:12 a rare
steals the window: `[OB] pause content:breach:235 by=rare` (11.6s fight). Then 13:56:23.722:
  `[OB] complete rare:1589 (released)`
  `[OB] resume content:breach:235 (paused 11652ms, from stack)`
  `[OB] complete content:breach:235 (arb-release) owned=0ms paused=11652ms frozen=648ms`
  `[ArbShadow] pick=boss committed=-`
NO [Breach] runner line ever fired for 235 (never TOUCHED/STABILISED) — the runner NEVER OWNED A FRAME
(owned=0ms), yet the claim released as "complete" and the bot walked to the boss. USER: "didnt go to the
breach rares for long enuff, then left it and started looking for boss." Root: breach is timeSensitive in
CONTENT_POLICY — the ENTRY expired/pruned during the pause; the resume found a dead entry and the arb
release path mislabels that "complete".

## Fix (flag `CLAIM_EXPIRY_FIX_ON = true`, off = today byte-parity)
1. PAUSE FREEZES EXPIRY: a queue entry whose claim is COMMITTED (incl. paused/frozen spans) has its
   expireAt extended by the paused span on resume (the TASK-47 owned-clocks principle applied to the QUEUE
   clock — stolen time never ages the entry). Simplest correct shape: stamp pause-start; on resume,
   expireAt += (now - pauseStart) BEFORE eligibility re-check.
2. UN-ACTIVATED BREACH DOES NOT EXPIRE: expiry semantics for breach = post-ACTIVATION only (the breach
   window). Pre-touch, the hand stands forever — gate the expireAt assignment (or its enforcement) on the
   activated signal the runner already tracks. Verify the same reasoning for other timeSensitive types and
   list them in the report (fix breach only unless another is proven identical).
3. NEVER "complete" AT owned=0ms: the arb-release path, when the claim was never driven (owned==0) and the
   completion source is entry-death (not a runner/flip-watch/objective signal), must (a) log honestly
   `released (entry expired while paused, never driven)`, (b) NOT mark the content completed/done (no
   noteContentCompleted, no done-latch), and (c) leave/re-add the entry eligible so populate re-spots and
   the arb can re-commit next pass (the entity/registry still knows the position).

## Hard limits
No arbiter re-ordering, no new movement — this is claim/queue lifecycle only. The rare interlude itself is
CORRECT (rares get fought); the bug is only that the breach didn't survive it. node --check. TEST BEFORE
COMMIT.

## Acceptance
Live repro class: breach spotted -> rare fight en route (>=10s) -> after the rare, the bot RESUMES walking
to the breach, activates, runs it (TOUCHED/STABILISED/white-tail chain in the log); no owned=0ms
"complete" lines anywhere in the map. Report handoff\TASK-67-REPORT.md: the expiry table for timeSensitive
types, exact gate sites, flag-off parity confirmation.
