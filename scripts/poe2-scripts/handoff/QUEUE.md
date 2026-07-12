# Task queue — one task per Opus session, planner reviews each diff, then ONE COMBINED LIVE TEST at the end
#
# 2026-07-12 (Greenhouse live pass on 29): 27/28/29 all live-exercised — flip-watch+sweep PERFECT (5 sites,
# all visited, 2 chests), breach adopt-on-touch PASS, known1000 budget live in [ArbShadow], [Ckpt] yields
# firing. NEW TRIAGE -> TASK-30 (CRITICAL: stale Snipe channel wedge = 28s+48s standstill, "nuking without
# stop" never stops the real channel; + stationary watchdog + fog-anchor yoyo latch), TASK-31 (junk
# openable filter, HV-utility [Ckpt] insertion during content — fixes essence walk-past + shrine-during-
# abyss, unique-engage 200u ruling (Taua), leave-verdict gate, breach loot-wait pos), TASK-32 (catchall
# promote-on-hit — boss cone hit at 21% after mute; reach-hold plant-scope — tanked lightning x5).
# Wave 27+28+29 commit: awaiting user's word (29's exercised items passed; B/D/F/G unexercised, no regressions).

USER DIRECTIVE (2026-07-10): no more point fixes between maps. Execute the tasks below back-to-back
(implement -> planner review -> next), then test everything together in one session of maps.

| # | Task | Status | Brief |
|---|------|--------|-------|
| 06 | Openable done-detection ("is opened" suspicion) | DONE — ACCEPTED (2026-07-10); planner also applied the phantom-hostile fix (isHostileAlive excludes Metadata/Shrines/) | TASK-06-shrine-openable-done-detection.md |
| 03 | Arena shell shadow | ACCEPTED + BASELINED; live logs confirm compute + would-penalize lines | TASK-03-arena-shell.md |
| 04 | Objective broker: SHADOW registry | ACCEPTED (2026-07-10: +290/−4 vs pre-snapshot, do-not-touch clean, live narrative coherent). Adjudications for 05: stack cap → 1; regTimer → direct freeze list; dual deny+pause stays | TASK-04-objective-broker-shadow.md |
| 07 | Dodge efficiency (P1 frozen-anim + P9 catch-all scoping) | ACCEPTED (2026-07-10: +37/−3 dodge +4 mapper vs pre-snapshot; deviation ruled CORRECT — planner's brief had the else-branch trap) | TASK-07-dodge-efficiency.md |
| 09 | Small directives (P3a/P4/P6a/P7) | ACCEPTED (2026-07-10; strongbox chestIsOpened root-cause fix + league-chest rescue; NOTE: user profile openCooldownMs=795 caps essence cadence — lower to <=400 for the test) | TASK-09-small-directives-bundle.md |
| 08 | Abyss chest sweep (P2/P8) | ACCEPTED (2026-07-10; live-proven bit-flip timing + runner-gate half of the bug; sweep bounded 5 ways; AbyssDepths tripwire noted for backlog) | TASK-08-abyss-required-chest-sweep.md |
| **10** | **Breach-mob routing (P5) + shrine LoF gate (solved skip mystery)** | **READY — FIRE NEXT (small, closes two live pains)** | TASK-10-breach-routing-shrine-lof.md |
| 05 | Objective broker ON (+ grace-finish, map-start hold) | ACCEPTED (2026-07-10: +304/−71 vs pre-snapshot; either/or freeze swap verified at both guards; all 4 deviations ruled correct; per-source freeze anchors exceed spec) | TASK-05-objective-broker-on.md |
| **11** | **Boss-approach cooldown (A) + abyss mid-node TTL hold (B, from 05's open question)** | **READY — FIRE NEXT** | TASK-11-boss-approach-cooldown.md |
| 12 | Essences skipped altogether | ACCEPTED (2026-07-11: H2 confirmed — essence object lost the walk auction to its own pack's loot; +24 bias, user-specced 250ms/9/200 cadence, skip-logs both sides) | TASK-12-essence-skip-investigation.md |
| 13 | StoneCircle handler + interrupt-aware opener retry | ACCEPTED (2026-07-11: +341 mapper +52 opener vs pre-snapshot; all 6 deviations ruled CORRECT/ACCEPT — 'stone' OB layer avoids obReconcile churn, 2-skip ban removal live-evidenced, RuneRock 3-cap = user ask; live-tested 4 runs incl. juiced swarm 0-skipped). Watch: stone clock-freeze doesn't cover MB dodge holds (same class as TASK-15's finding; bounded by skip-doesn't-block + 90s cap); "Opened Essence: RuneRock" label cosmetic | TASK-13-stonecircle-handler.md |
| 15 | Utility contested-verdict fix + user-directed essence pipeline (8 live rounds) | ACCEPTED (2026-07-11 planner tail-review vs pre/TASK-15: 135+/28- mapper, +14 dodge, +20/-4 opener; contested lane = brief-exact; essence ban-exemptions bounded by 30s session cap->timeout ban; claim<retry invariant holds; reach-hold bounded 5s+HP-floor+flag-off parity. Watch: opportunistic reach-hold can plant mid-boss-fight ≤5s (TASK-18 reduces exposure); "self-caps ~2.5s" comment vs 5s actual = cosmetic. Diffs frozen in session scratchpad before 18 started; baseline refresh DEFERRED until 18 closes) | TASK-15-utility-contested-verdict.md |
| 16 | Silent-frame visibility + stuck-dead cleanup (mapper-only, NO DC) | ACCEPTED + PLANNER FIX (2026-07-11: +78/-1 vs pre-snapshot, guard placement/parity/instrumentation all brief-exact. Planner-applied fix post-review: cleanup now sends the release packets WITHOUT resetMapper — the reset dropped to IDLE which disarmed the guard mid-blind-streak, spending the one release while alive and leaving a later death undetected (exact Willow replay); packets re-fire each 120s, area gate resets on the first VALID read. Open question ruled: HIDEOUT_ exclusion stays — those states only exist after a valid hideout area read) | TASK-16-death-failsafe-silent-frame.md |
| 14 | Coverage sweep + objBroker default ON | ACCEPTED + PLANNER FIX (2026-07-11: +153/-6 incl. third-party logbook block; deviation #1 ruled CORRECT — phantom-margin buckets retro-explain the Excavation corner-ping, coverage-local guard right, shared-picker fix queued as TASK-20; open question RULED mass-driven → planner widened the cleanup gate with a self-limiting coverage arm; flag-off parity re-walked incl. the new arm) | TASK-14-post-objective-coverage-sweep.md |
| 3P | Logbook/Grand-Expedition atlas block (third-party session) | ACCEPTED (contentSet STRING at node+0x300 row+0x6c — follows the statid-drift lesson, no row numbers; heap-guarded, fails open; live-verified 93 logbook nodes, 60 pickable survive) | — |
| 20 | Shared picker phantom + pick-time routability | ACCEPTED (2026-07-11: +45; root-cause improvement — both log failures = ONE partial-route bug, ported the shared picker's 150u end-distance guard into pickUnexploredHeading (both paths) + getExploreLandmark with ZERO new router calls; phantom skip pre-scoring; all 3 deviations ruled correct. ALL TASKS DRAINED — test remainder then COMMIT) | TASK-20-shared-picker-phantom-routability.md |
| 21 | Round-1 fixes: beacon chest dwell + unfair-send hold + abyss 'boss' route | ACCEPTED (2026-07-11: +97/-11 mapper +16 opener; A choke-hooked/bounded/reset-clean, C mirrors sweep/stone with shared approach cell. B-hold ruled correct-but-INSUFFICIENT: only foreign-lock frames — the live shrine case was a plain mapper walk, unreadable from opener; commit-to-click STOP-and-report ruled CORRECT per brief constraint → both close via TASK-22's movement-state bus. Baseline refreshed) | TASK-21-beacon-dwell-unfair-send-abyss-route.md |
| 22 | Commit-to-click bus + imprisoned-rare exclusion | ACCEPTED (2026-07-11: +47/-2 mapper +40/-9 opener; bus stamps at both move chokes on if(sent), commitClickSafe post-dodge-block, commit lane gate-exempt justified (game-pathfinder auto-walk), 800ms-vs-2000ms lock reasoning sound, MultiplexPortal exclusion caught; planner verified getSharedEntities = no type filter @500u so crystals appear (128-cap swarm miss = hp-frozen backstop). Matrix rows #3/#5/#12 now CLOSED pending live proof. Baseline refreshed) | TASK-22-commit-click-bus-imprisoned-rare.md |
| 17 | StoneCircle partial-stream hardening | ACCEPTED (2026-07-11: +68/-14 all in stone block; commit gate + 90u scan + ban-bridge (key decode verified vs stoneCircleKey, ±6u quantization inside 60u) + near-only approach w/ recompute-once + entitySubtype 'MonsterUnique' verdict (deviation #1 = live-verified field correction, rarity not projected lightweight); !live any-hostile hold retained. QUEUE DRAINED — combined live test next) | TASK-17-stonecircle-partial-stream.md |
| 18 | Catchall tame (fight better: CC'd boss = no rolls, per-anim budget, channel-hold) | ACCEPTED (2026-07-11: +107/-4 dodge +14 rotation vs pre-snapshot; all 4 deviations ruled CORRECT — POE2Cache transport avoids circular import, pooled hp+es, inert unconditional publish, both branches budgeted; planner verified getSharedEntities exists + buffs are .name objects + double-bounded hold expiry; baseline refreshed) | TASK-18-catchall-tame-channel-hold.md |
| 19 | Abyss chests = objectives (pre-boss sweep hook, 25u send-gate, unban-on-arrival, d/t tally, shared walkableApproachPoint for sweep+utility) | ACCEPTED (2026-07-11: +119/-18 mapper +32/-1 opener; _miss-aging sweep reconcile ruled CORRECT (site list survives boss engage), tally honest (fails don't count as d), stone alias behavior-neutral, 3-flag parity walked; baseline refreshed) | TASK-19-abyss-chest-objective.md |
| — | **COMBINED LIVE TEST** (pre-steps: openCooldownMs≤400, objBroker ON) → then COMMIT the full runtime tail | — | — |
| 02 | Trail bias K recalibration from live [Trail] logs | folded into the combined test analysis | — |
| 01 | Visited trail record+bias | DONE (accepted; bias hard-on per user) | TASK-01-visited-trail.md |
| — | Backlog: opener "3 attempts" theory (UNVERIFIED: arrival dwell's sendStopMovementLimited at <=20u may cancel the interact auto-walk -> 3 failed clicks -> hard ban; needs ONE live trace with opener ON: three `[Opener] Opened Shrine` lines then a 3-attempt blacklist = confirmed, fix opener-side interact range) | after combined test | — |
| — | After combined test: commit the full runtime tail; then arena shell 'on', module split (step 9), backlog (P2 breach arms, P8 breach-rare middle, stash flow, P1b) | — | — |
| 24 | Phantom projectile gate + node-local tidy-up (user's clear→tidy→probe→advance flow) | ACCEPTED (2026-07-11: +23/-1 dodge +78/-4 mapper; shooter cache at pass-end w/ correct grid→world units; _hvRaw/_hvOpen split preserves committed walks; tidy window owned-time bounded, node-exempt from mid-drive, candidate-policy-scoped chests; optional-abyss side-step byte-unchanged. Baseline refreshed) | TASK-24-phantom-projectile-hv-contention.md |
| 23 | Half-state map resume + forward-biased explore | ACCEPTED (2026-07-11: +269/-5 mapper +37/-1 opener; restore-once latch w/ decided-vs-applied split, envelope validation, write-never-clobbers-pending-restore, zero goal leakage verified, opener blacklist newer-record-wins merge, JSON round-trip unit-tested; fwd bias = cached-anchors-only bearing + centroid fallback, penalty-only scaled to candidate's own value, [FwdExplore] flip-log for K tuning; deviation-1 fallback probe ruled CORRECT+required. Baseline refreshed) | TASK-23-map-state-resume-forward-explore.md |
| **30** | **Stale-channel movement wedge (THE bug of the Greenhouse run) + stationary watchdog + fog-anchor latch** | **READY — FIRE NEXT** | TASK-30-channel-wedge-standstill.md |
| **31** | **Utility value filter + HV-utility [Ckpt] insertion + unique-engage 200u + leave gate** | READY (after 30) | TASK-31-utility-value-and-unique-engage.md |
| **32** | **Catchall promote-on-hit (boss cone) + reach-hold plant-scope (essence lightning)** | READY (after 31) | TASK-32-boss-catchall-promote-reachhold-scope.md |
| — | POST-CLEANUP (user 2026-07-11, deliberate order): (a) mapper.js CLEANUP — rip dead legacy branches/superseded runners, then module split; (b) THEN entity-informed exploration — bias explore/coverage bucket picks toward far POIs (essence/monolith/strongbox) read from the map-wide sleeping entity list (existing read, new consumer; see memory poe2-entity-informed-explore) | PARKED | — |

RULE UPDATE (user 2026-07-10): NO agent fleets of any kind in implementer sessions — reviews AND investigations
(HOUSE_RULES rule 0). One live bridge read beats N agents deducing runtime state.

## How to run a task (user) — single-writer rules per INCIDENT-2026-07-10-baseline.md
1. ONE implementer session at a time; tell the planner when it starts and when it's done.
2. New terminal: `cd c:\Games\jmr-poe2\scripts\poe2-scripts`, start Claude Code, `/model opus`.
3. Prompt: `Read handoff/HOUSE_RULES.md, then handoff/TASK-0X-....md, then any MAPPER_ROADMAP.md sections it references. Implement the task.` (Its FIRST ACT is snapshotting its edit set to handoff/pre/TASK-XX/.)
4. While a task is out: the PLANNER makes zero runtime edits and zero baseline refreshes — live findings get
   queued, not hot-fixed.
5. Tell the planner "review task 0X". It diffs against handoff/pre/TASK-XX/ (fallback: handoff/baseline/),
   reviews once inline, then — only after the implementer session is confirmed closed — refreshes the baseline
   and unblocks the next task. No live test until the queue is drained.

## Combined live test (after 06+03+04+05 land)
One session, 2-3 maps, audit file on. The planner reads map_audit.log + a console paste and judges everything at
once: strict-finish/objective counts, trail bias routes, [OB] narrative, arena shell shadow lines, shrine
re-offer fix, watchdog/latch behavior. Fix rounds happen AFTER that, prioritized by what the audit shows.
