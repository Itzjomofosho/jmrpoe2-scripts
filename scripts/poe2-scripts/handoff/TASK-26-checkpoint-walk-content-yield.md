# TASK-26 — Boss-checkpoint walk must yield to route-gated content (breach skipped on the way to the boss)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-26\`. File: `..\mapper.js` ONLY.

## Live evidence (C:\tmp\log.txt, Spring_ 21:01-21:02)
The arena-centroid fix commits boss-direct AT MAP ENTRY (WALKING_TO_BOSS_CHECKPOINT immediately). The route passed
a breach; the arbiter committed it (`[ArbShadow] pick=breach:50 NEAR ins=27 bud=537` — 27u insertion, the
boss-on-the-way model working) — but NOTHING drives arbiter content during WALKING_TO_BOSS_CHECKPOINT: only
utility detours interleave there (the essence at d=103 did, textbook: fight-through freeze, 4 clicks, loot). The
breach record starved (owned=6051ms frozen=42676ms over ~34s) -> `arb-release` -> boss walk continued -> breach
NEVER TOUCHED. Pre-fix this rarely bit (boss-direct rarely engaged at entry; content ran during FINDING_BOSS
explore, which no longer happens on arena-tile maps).

## What ships (const `CKPT_CONTENT_YIELD_ON = true`)
During WALKING_TO_BOSS_CHECKPOINT (NOT melee/fight): when the ARBITER holds a committed ROUTE-GATED content entry
(`arbCommittedKey` set, its classification NEAR/ONROUTE with insertion within budget — reuse the arbiter's own
route-gating verdict, do NOT re-derive), YIELD the state to the content flow exactly like the utility detour does:
- Transition to the content-driving path (FINDING_BOSS re-entry is acceptable IF the boss re-commit is instant on
  arena-tile maps — it is, the centroid is cached; OTHERWISE mirror the utilityResumeState pattern with a
  checkpointResumeState. Pick whichever is smaller/safer in the tree and SAY WHICH + WHY).
- The content runs through its normal owner (arbGoal walk -> touch -> breach roam / abyss runner / etc).
- On completion/release, resume the checkpoint walk (the arena anchor is stable — re-commit is one frame).
- Bounds: everything the arbiter/runners already have (this adds a yield, not a new driver). Never yield while
  within ~150u of the arena anchor (fight imminence — don't start a breach at the boss door), never in
  WALKING_TO_BOSS_MELEE/FIGHTING_BOSS.
- Log the yield: `[Ckpt] yielding to route-gated <key> (ins=Nu) -> resume checkpoint after`.

## Hard limits
- mapper.js only. No arbiter scoring/OB changes — consume its existing verdicts. No new scans. Flag-off parity.
- The utility interleave, strict-finish gates, and the boss engage detectors stay untouched.

## Acceptance
- `node --check mapper.js`; parity walk.
- Report per HOUSE_RULES + live-test checklist: on an arena-tile map with content near the boss route, the
  checkpoint walk yields (`[Ckpt] yielding...`), the breach/abyss gets DONE, checkpoint walk resumes, boss dies;
  content far off-route still gets skipped pre-boss (post-boss cleanup owns it); no yo-yo between yield and walk
  (the arbiter's own hysteresis/budget governs).
