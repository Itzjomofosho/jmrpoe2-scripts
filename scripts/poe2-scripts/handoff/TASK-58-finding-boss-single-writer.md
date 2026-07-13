# TASK-58 — FINDING_BOSS single-writer: the legacy Boss Explore runs ALONGSIDE the navigator (opposite-direction yoyo)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-58\`. File: mapper.js ONLY. USE OPUS 4.8.
SEQUENCING: after TASK-56 (and 57 if fired first) — never concurrent. Evidence: C:\tmp\log.txt (Sandspit
18:52:56-18:53:51, 2026-07-13) + user screenshot (hairpin walk path, NO mobs).

## THE FAILURE: seven walk-writers in 55 seconds; Nav Explore <-> Boss Explore alternate in OPPOSITE directions
Live: `Walking to Nav Explore (1553,1346)` and `Walking to Boss Explore (1498,1450)` swap every ~1.5s
(18:53:02-:16) — the navigator's boss corridor (replan -> 14 legs to boss@(2737,667) via radar) vs the
LEGACY explore block (~17275-17330: crawl clamp / boss-direct / corridor hop, startWalkingTo 'Boss
Explore'), BOTH live in FINDING_BOSS. Interleaved: Elite chase walks (1.5s retargets), Breach/Content
Farwalk, Boss Checkpoint, Abyss Node, Utility loot. On a clear map with a clear goal the char walked
backwards to go forwards (user screenshot).
Also: 3x `[Nav] replan (off-route (preemption end))` within 400ms (18:52:59.218/.383/.560) — the replan is
not debounced after a preemption ends.

## FIX (DIAGNOSIS CORRECTED by the planner 2026-07-13 evening — read this before coding)
The planner's code-read DISPROVED the "legacy explore runs alongside nav" theory: the legacy explore block
is the `else` of `else if (NAV_ON)` (~17185) and cannot co-run. The alternating 'Boss Explore' writer was
the S5 MOB-CHASE branch (~17171, startWalkingTo labeled 'Boss Explore') flickering against the nav corridor
on WHITE packs. The planner hotfixed the white case (S5_CHASE_MAGIC_PLUS, grep 'PLANNER HOTFIX ... 58-core':
whites never chase-walk; kill in passing). YOUR scope is what remains:
1. VERIFY the hotfix live-shape + close the residual flicker: a MAGIC+ chase still alternates with nav legs
   at the dot-gate/latch boundaries (the 3s branch-switch throttle + 5s hold cap are the existing bounds —
   confirm they suffice with whites gone, tighten only with log evidence).
2. Map the FINDING_BOSS branch table anyway (which sub-branches call startWalkingTo, under what conditions)
   — it is the decomposition's Phase-4 input and the review artifact for any future writer bug.
2. REPLAN DEBOUNCE: 'off-route (preemption end)' replans debounce to one per ~1.5s (three in 400ms churns
   the corridor for nothing).
3. ELITE-CHASE RETARGET DWELL: the rare-chase retargeted (1542,1448)->(1540,1436)->(1762,1232)->(1759,1251)
   across seconds. Give the chase target a minimum dwell (~2.5s or dead/gone) before switching mobs — same
   commitment shape as everything else. (The planner's Magic+ posture hotfix is separate and already in.)

## Hard limits
- mapper.js only. The navigator itself is NOT edited (its corridor already works — the log shows clean legs).
  No changes to MB priorities. Flag off = today. node --check; TEST BEFORE COMMIT. Map-the-branches FIRST;
  if the exclusivity turns out to need navigator.js knowledge, STOP and report rather than half-gating.

## Acceptance
- Sandspit-class map: ONE explore writer at a time ([Nav] legs OR Boss Explore, never interleaved); walk
  targets change only on leg advance / real preemption; no opposite-direction pairs within 5s; no replan
  bursts; elite chases hold a target >=2.5s.
