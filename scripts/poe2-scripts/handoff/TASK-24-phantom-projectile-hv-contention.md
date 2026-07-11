# TASK-24 — Phantom projectile rolls (no mobs, still dodging) + hv-sidestep vs REQUIRED-runner contention

FIRST ACT (HOUSE_RULES): copy `..\auto_dodge_core.js` AND `..\mapper.js` into `handoff\pre\TASK-24\`.
Evidence: C:\tmp\log.txt (Spring_ 20:01-20:06) — 25 of 36 rolls were `why=projectile-path`, most with NO hostiles
anywhere near (user watched); strongbox select/deny churn 20:02:52->20:03:24.

## A. Phantom projectile lanes (auto_dodge_core.js)
Root cause (the code documents its own hole): the projectile branch's FIRST-SIGHT rotation fallback (~417-423)
fabricates an 800-speed lane along a stationary 'shot/arrow'-named entity's rotationZ before two samples exist.
The 2026-06 fix stopped it for KNOWN-slow entities (second sample onward) but kept first-sight fabrication "for
a real spear". Every stationary shot-named entity that streams in facing the player = one phantom roll
(own deployables not named tornado, stuck/spent projectiles, arrow-named ground objects). 25 phantom-class rolls
in 4.5min.
FIX — a projectile needs a SHOOTER: gate the ROTATION FALLBACK (fabricated lane) on live hostile presence —
`enemies`-scan from the PREVIOUS pass (cache the count; same-pass ordering makes the current array incomplete)
having >=1 hostile within ~120u of the entity (or of the player — pick the cheaper with data in hand; say which).
MEASURED-velocity projectiles are untouched (a real off-screen spear has velocity by sample 2; sample 1 of a
real volley usually has a visible shooter anyway — and the risk window is bounded by the next scan).
Const `PROJ_FALLBACK_NEEDS_SHOOTER = true`; flag-off = today's behavior byte-for-byte.

## B. NODE-LOCAL SERVICE WINDOW (mapper.js) — the user's flow, verbatim ruling
User (2026-07-11): "in near the abyss node: I clear; any essences or any utility, I take care of it; ok closed?
go to the node and wait 5s — chest? no/yes. And repeat."
Live failure it replaces: `Utility select (Large Strongbox) d=66` -> `[OB] deny ... vs content:abyss:1048 pri=2`
churn — the _hvOpen side-step (correct vs OPTIONAL content) fought a REQUIRED abyss runner mid-drive; two writers
contended, box<->abyss yoyo ~32s (CONTENT-MATRIX row #4 was only verified vs optional).
FIX — give the abyss runner a per-node rhythm with a FORMAL tidy-up gap:
1. MID-WAVE / node-walk: the runner owns the frame exclusively. The _hvOpen side-step DEFERS (candidate stays
   offered; tryStartUtilityNavigation does not start/steal the walk). Log once:
   `[Utility] hv side-step deferred: required <key> mid-drive`.
2. NODE DONE -> TIDY-UP WINDOW: before committing the NEXT node, if an _hvOpen-class target (essence/strongbox)
   or an unopened chest sits within ~90u of the just-finished node, the runner HOLDS (does not advance) and the
   normal utility/opener machinery services them — bounded by a `NODE_TIDY_BUDGET_MS = 20000` per node (clock
   freezes on dodge-held frames, house idiom). This is where the strongbox/essence get done — cleanly, not
   mid-fight.
3. CHEST PROBE: stand AT the node ~5s (the existing loot-dwell/abyssChestNear machinery — verify it already
   covers this and extend the dwell to a 5s minimum with the chest probe if short) — chest spawned? opener takes
   it (within its 25u gate). Then advance to the next node. Repeat.
Vs OPTIONAL/rare/no commitment: side-step behavior unchanged (the proven path). All existing runner caps stay;
the tidy-up budget is additive and bounded. Const `HV_DEFER_REQUIRED_ON = true` gates 1+2 (3's dwell-minimum
rides the same flag).

## Hard limits
- Files: auto_dodge_core.js + mapper.js only. No OB ladder changes — B is a consumer-side defer, not a priority
  edit. No new scans (A caches a count from the existing pass; B reads existing runner state).
- Measured-velocity projectile dodging, homing detection, all other dodge classes untouched.

## Acceptance
- `node --check` both; flag-off parity per const.
- Report per HOUSE_RULES + live-test checklist: a quiet map segment (no hostiles) produces ZERO projectile-path
  rolls while loot/deployables stream; a real ranged pack still gets dodged (measured lanes unaffected); a
  strongbox/essence <=120u during a REQUIRED abyss shows ONE defer log then a clean open in the runner's idle gap
  (no box<->abyss flailing); optional-content side-steps unchanged.
