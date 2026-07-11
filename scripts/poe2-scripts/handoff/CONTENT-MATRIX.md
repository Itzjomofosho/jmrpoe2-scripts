# CONTENT-MATRIX — co-located content decision matrix (planner, 2026-07-11)
Verified against runtime mapper.js/opener.js @ post-TASK-17 baseline (21 in flight). Three columns per case:
EXPECTED (who owns the frame / who defers / who resumes), EVIDENCE (the enforcing code), VERDICT.
Priorities: OB ladder mirror(1) > required(2) > rare(3) > optional(4) > utility(5) > loot(6) > explore(7) [~1213];
Movement Broker dodge(1) > fight(2) > content(3) > utility(4) > nav(5). Two ladders, two questions: OB = "whose
GOAL is it", MB = "whose PACKETS go out this frame".

## The pairs/trios

| # | Situation | Expected | Evidence | Verdict |
|---|---|---|---|---|
| 1 | Breach + Abyss co-located | Breach FIRST, abyss deferred (flagged, not lost); abyss re-picked after breach done | `[Arb] defer <key>: co-located breach first` ~4450; `_brHold` keeps the commit while breach <300u ~4477 | VERIFIED (map-1 test: abyss:1226 + breach at same spot; breach ran clean; abyss stayed queued) |
| 2 | Accidental breach TOUCH while committed elsewhere | Breach is live once touched (timer runs) -> ADOPT it: roam owns, prior commitment pauses, resumes after | `_brIncChkAt` incidental-activation detector ~2051; OB pause/resume narrative | VERIFIED (design + Willow logs); watch: adoption only triggers on the detector's throttle — a touch the detector misses = wasted breach |
| 3 | Shrine near a live breach clear | Breach owns walk (utility pri 5 denied vs content); shrine opened by OPENER when actually in range — NOT walked to mid-fight | OB deny utility ~1549-1551 -> lootOnly degrade 13009; opener click = TASK-21B commit-to-click (park 0.8s) | GAP until 21 lands (map-1: whiff-clicked at 45/38u, shrine lost). Post-21: re-verify live |
| 4 | Essence ≤120u while ANY commitment held (incl. required beacon walk) | Side-step: essence serviced (user ruling — seconds of work), objective re-picked right after | `_hvOpen` punches the lootOnly degrade + all 3 distance caps + objective-wins veto: 8370, 8426, 8448, 8462, 8469 | VERIFIED (TASK-15 live: abyss re-claimed + finished post-detour) |
| 5 | Essence with IMPRISONED rare (may be an abyss/objective mob) | Open the essence FIRST (mob invulnerable until open) — rare-engage must NOT target the imprisoned rare | exclusion in nearestRareToClear: **DOES NOT EXIST** — entity_actions hp-frozen 5s ban is the only backstop | **GAP (known, queued as backlog)** — rotation wastes ~3.5s per encounter (Savanna: Rattling Gibbet). Fix idea: rare within 12u of un-opened essence Monolith -> skip until opened |
| 6 | Strongbox ≤120u during boss drive | Same side-step as essence; guards-alive = WAIT (no attempts burned); 45s loiter until opened | `_hvOpen` (Strongbox arm) + `strongboxGuardsNear` skip in opener + `_isStrongbox` 45s session | VERIFIED (TASK-09/15) |
| 7 | Stone circle + rare swarm | Rare (3) preempts stone (4): pause -> engage -> resume; stone clocks freeze on stolen frames | obStoneClaim pri optional; clock-freeze `gap>1000 \|\| dodgeMoveSuppressUntil`; OB stack | VERIFIED (Savanna juiced: ~5 preemptions, 0 skipped) |
| 8 | Stone circle + breach both present | Breach outranks (hook order: breach roam ABOVE stone in the pre-switch chain); stone commits after | processMapper pre-switch chain order ~12651+ | VERIFIED (Willow: stone committed the frame after `[Breach] done`) |
| 9 | Abyss-chest sweep vs live wave/breach/hive/stone | Sweep only takes IDLE frames (never preempts a live runner) | `abyssSweepIdle()` = abyssId==0 && !breach && !hive && !stoneKey | VERIFIED (TASK-19 review) |
| 10 | Delirium mirror vs everything | Mirror (1) preempts all, never denied, exempt from the stack cap | OB_PRI.mirror + stack exemption ~1283-1288 | VERIFIED (TASK-05) |
| 11 | Dodge vs any walk/dwell | Dodge owns movement (MB p1); ALL committed clocks freeze on dodge-held frames | MB ladder + per-subsystem freeze idioms (the recurring-bug class — audited per task) | VERIFIED subsystem-by-subsystem; TASK-15 closed the utility hole; stone's MB-hold gap = backlog watch-item |
| 12 | Opener/pickit yield vs mapper walk | Lock yields the mapper, mapper clocks freeze, "going to X, yield, return to X" | movement locks + `utilityLastServicedAt`/`_lockTickAt` stamps; 21B extends this to commit-to-click | VERIFIED (architecture); 21B pending |
| 13 | Required abyss/breach2/incursion vs rare engage | Required (2) DENIES rare walk-commit (entity_actions still shoots); rare engaged only after | OB deny `rare pri=3 vs content pri=2` (map-1 log, dozens of lines) | VERIFIED live |
| 14 | Coverage sweep vs anything | MAP_COMPLETE only, nav (5) — bottom of both ladders; required-content check exits it first | tryCoverageSweep guards (state, nearestOutstandingRequiredContent, MB nav) | VERIFIED (TASK-14 review); live [Coverage] data still wanted |
| 15 | Vaal beacon energise -> chest | Dwell at the beacon for the spawned chest before moving on | **was: nobody owned it** (arb released pre-flip) | GAP -> TASK-21A (in flight) |
| 16 | Two same-type instances (2 breaches / 5 abysses) | Sequential: one committed, rest queued; type-completion prunes leftovers (+ sweep sites for abyss) | contentQueue + objectiveTypeComplete prune + abyssSweepAdd at prune | VERIFIED (Willow 2/2 breaches; Pit 5-abyss prune -> 4 sites) |

## Open gaps, ranked
1. **#5 imprisoned-rare exclusion** — only real unhandled interaction; small fix, needs the essence-adjacency check
   in the rare-engage candidate filter. Queue as TASK-22 when the current wave clears.
2. **#3/#12/#15** — TASK-21 (in flight) closes all three; re-verify with live log lines after it lands.
3. **#2 watch-item** — incidental breach adoption depends on the detector throttle; if a "wasted breach" (touched,
   timer ran out, never cleared) ever shows in an audit, that throttle is the suspect.
4. **#11 stone MB-dodge-hold** — stone's clock freeze doesn't see MB dodge holds (bounded by skip-tolerance + 90s
   cap); fold into the cleanup pass.

## How to use this
When you see co-located weirdness live: find the row, check the log against EXPECTED, and if they disagree the
EVIDENCE column names the exact gate to inspect. New content types (ritual? azmeri?) get a new row BEFORE their
handler ships — the row IS the spec.
