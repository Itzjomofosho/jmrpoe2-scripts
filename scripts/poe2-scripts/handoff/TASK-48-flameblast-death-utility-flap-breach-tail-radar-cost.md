# TASK-48 — Flameblast death (classify + beacon-miss + checkpoint/utility flap) + breach white-tail + radar-validate cost

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\auto_dodge_core.js` into `handoff\pre\TASK-48\`.
Files: auto_dodge_core.js (A) + mapper.js (B/C/D). USE FABLE for B (state-commitment); A/C/D are mechanical.
SEQUENCING: fire AFTER TASK-47 lands (same mapper.js). Evidence: C:\tmp\log.txt (Backwash 11:50-11:53,
2026-07-13) — USER DIED. Standing ruling: no DC/chicken-exit; the fix is FIGHT/DODGE BETTER.

## THE DEATH (11:52:34.226)
[AutoDodge] PANIC egress: hp -35% in 2s; the [BlindGround] dump names the killers:
- AnchoriteMother/m_flameblast_01_01.ao d=1u, _05_01 d=2u, _01_01 d=6u, _03_01 d=8u  (FOUR overlapping blasts)
- monster_mods/lightning/explode_on_death/ao/lightning_beacons.ao d=5u                 (TASK-41's own asset!)
One pot fired (11:52:34.475), char died before the egress cleared the overlap. Second panic of the map
(11:50:57 -32% + blind egress E survived). Death-sit is MANUAL (ruling) — user sat + disabled the mapper.

## A. GROUND CLASSIFY: flameblast family = AVOID + investigate the silent beacon (auto_dodge_core.js)
1. Add to GROUND_CLASS_TABLE (TASK-41 whitelist): /flameblast/i under Metadata/Effects/Spells/
   monsters_effects/ -> AVOID (charged large AoE; the danger-zone radius from the .ao bounds b=32 like the
   other carpets). Generic on purpose: every act's AnchoriteMother variant + any other flameblast re-skin.
2. WHY was explode_on_death/lightning_beacons at 5u SILENT? That path is the exact TASK-41 LETHAL class.
   Reproduce the classify call on the dump line (name match? host=1 filter? state gate?) and fix the miss —
   report the root cause explicitly (this is the more important half: the whitelist is only as good as the
   matcher that reads it).
3. No [AutoDodge] hazard line fired between 11:52:12 and the 11:52:34 panic — verify the ground scan was
   actually running during WALKING_TO_BOSS_CHECKPOINT/WALKING_TO_UTILITY (not gated to combat states).

## B. CHECKPOINT<->UTILITY STATE FLAP: 4 flips in 40s marched the char through the pack that killed it
11:51:35 ckpt->utility, 11:51:44 ->ckpt, 11:51:53 ->utility, 11:52:12 ->ckpt (Backwash). Each flip re-crosses
the same skeleton/AnchoriteMother pack. The utility detour re-claims mid-checkpoint-walk, then the checkpoint
walk re-claims mid-utility-walk — no commitment between the pair. FIX (commitment discipline, the house
rule): once a utility detour is taken from a checkpoint walk, it COMMITS (finish/timeout/ban the utility,
THEN resume the checkpoint — the detourReturn anchor pattern); while a utility is committed the checkpoint
walk may not steal the frame back, and after resuming the checkpoint the SAME utility may not re-claim
(consumed-or-banned). Reuse the existing utility commit/ban structures — no new state machines. Log each
transition once: `[Utility] detour committed ...` / `resume checkpoint`. Flag `UTIL_CKPT_COMMIT_ON = true`.

## C. BREACH WHITE-TAIL: inert leftover breach mobs hold the roam to its full cap (user report + screenshot)
runBreachRoam DONE = no ALIVE /Monsters/Breach/ mob pinged for CLEAR_MS (~3029); bestBreachMob counts ANY
white within ROT_BREACH_MOB_R. Post-close leftover whites (visually present, effectively inert) keep
rotBreachLastMobAt fresh -> the roam burns to ROT_BREACH_DWELL every time. USER FIX (encode as given): after
STABILISED (rares spawned), once NO rare/unique breach mob is in the ring for BREACH_WHITE_TAIL_MS = 6000,
the breach is DONE — lingering whites don't hold it (they die in passing or don't matter). Pre-stabilise
behavior unchanged (whites are the wave). Flag `BREACH_WHITE_TAIL_ON = true`. Keep the loot-dwell exit as is.

## D. RADAR-VALIDATE COST: 1551ms mapper frame (Riverhold 11:47:33, live-correlated)
The 46-F upfront validation runs radarFindPath on up to 8 bucket candidates in ONE pass — the three
`radar-unroutable -> banned upfront` lines at 11:47:14/:32/:42 bracket a [DrawProf] mapper 1551.18ms frame.
FIX: validate LAZILY — run the macro pick exactly as pre-46F, then radar-validate ONLY the winning bucket
(1 call per 2.5s pass); a failed winner is banned upfront (same log) and the NEXT pass re-picks. Net effect
identical (unroutable buckets still get banned before any walk-probe), worst-case one radar call per pass.
Also log any radarFindPath call that takes >100ms: `[Discover] radar route slow NNNms` (visibility for the
C++-side BFS cost; RadarV2 logged `RebuildOverlayPaths took 235ms - BFS cache miss` at 11:53:02).

## Hard limits
- auto_dodge_core.js: table + matcher fix only (A). mapper.js: the checkpoint/utility pair (B), runBreachRoam
  done-condition (C), pickRouteNearestBucket validation placement (D). All four independently flagged;
  flags off = today byte-parity. No priority-ladder changes; B must not touch TASK-47's engaged-content
  gates (it's the checkpoint<->utility pair specifically). node --check both; TEST BEFORE COMMIT.

## Acceptance
- Live: a flameblast telegraph gets an AVOID danger zone + pre-emptive dodge (no standing in overlaps);
  the explode-on-death beacon miss is root-caused and fires the LETHAL path; no ckpt<->utility flip-chains
  (one detour, one resume); breach ends within ~6s of the last rare/unique despite leftover whites;
  no >100ms discover frames from radar validation (no 1s+ mapper frames in DrawProf during discover).
