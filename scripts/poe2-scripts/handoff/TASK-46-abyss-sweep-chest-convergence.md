# TASK-46 — Abyss-chest servicing: opener convergence + post-boss starvation + second-instance discover

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\opener.js` into `handoff\pre\TASK-46\`.
Files: mapper.js (A/C/D/E/F) + opener.js (B, log-only). SEQUENCING: do NOT run concurrently with TASK-44
(both edit mapper.js) — fire this AFTER 44 lands; snapshot the then-current files.
Evidence: C:\tmp\log.txt, Cenotes 07:45-07:54 2026-07-13. Map DID complete (breach 1/1, boss KILLED,
portal-out 07:54:18) — but abyss-chest ended 1/4 and the post-boss tail wasted ~2.5min yoyoing.

## A. SWEEP DWELL NEVER CONVERGES ON THE CHEST (the 45s "waiting for opener" stall)
Live: site (1185,1185) `chest=YES` 07:47:56.847; AbyssChestCurrency opened instantly (16.3u); then 45s of
`waiting for opener` with ZERO opener activity; `retired: 45s ceiling` 07:48:41.965; 200ms after the char
STARTED WALKING, AbyssChestRareFinalArmour opened at 9.2u (then AbyssChestArmour 24.8u). Position-bound gates.
ROOT: the wait branch (mapper.js ~4130, `tryAbyssChestSweep`) just `sendStopMovementLimited()`s at the SITE
centroid. Wait predicate = unopened /abyss/i chest within ABYSS_SWEEP_CHEST_R=90u of the SITE (~4003). Act
predicate (opener.js) = chest within ABYSS_CHEST_SEND_RANGE=25u of the PLAYER (~821) AND LoF collect gate
(~592, chests have NO close exemption) AND walkable-LoS send gate (~849-863). All three skips SILENT. A chest
26-90u out or line-cut by the abyss fissure is un-openable from the fixed stand point — forever.
FIX (flag `ABYSS_SWEEP_CHEST_WALK_ON = true`): extend `abyssChestNear` (same 500ms cache) to return the
nearest unopened chest {x,y,distToPlayer}. In the wait branch AFTER the untouched HOLD_MS spawn phase: chest
> 12u from PLAYER -> walk to `walkableApproachPoint(chest.x, chest.y, ...)` via startWalkingTo(...,'Abyss
Chest Sweep','boss') with the existing repath discipline (mirror ~4097-4102); <=12u -> stand and let the
opener fire. Opened chest drops from the scan -> next-nearest. Keep sweepLootStep-first ordering (one
movement writer). Site cap/ceiling unchanged. ALSO: the arrival leg's `unreachable (no progress, closest Nu)`
retire (~4079) at d<=30u tries the chest-walk branch ONCE before retiring (live: site (1127,1208) retired at
20u, chest stranded).

## B. OPENER NAMES ITS SILENT CHEST SKIPS (opener.js, LOG-ONLY)
Mirror `logEssenceSkip` (throttled ~5s): when a Chest candidate is dropped by (a) the abyss 25u send gate,
(b) the LoF collect gate, (c) the walkable-LoS send gate -> `[Opener] chest skip (<shortname>): <abyss-range
| LoF-blocked | walk-LoS-blocked> at NNu`. NO gate behavior changes. (Disambiguates which gate blocked the
9.2u chest next live run.)

## C. OB ZOMBIE CLAIM: RELEASE ON INCIDENTAL COMPLETION (mapper.js, small)
`[Abyss] node 663 completed incidentally` 07:47:09.969 while committed=abyss:663 — NO `[OB] complete` ever
follows (684 got `(arb-release)` only because the arbiter happened to re-pick that frame). The dead pri=2
claim shadow-denied `sweep:99x99 pri=4` every ~1-2s for ~95s. Same zombie: `committed=breach:34` persisted
in ArbShadow lines minutes after `[Breach] done` 07:51:05. FIX: when a committed content goal's instance
completes (incidental completion path ~3996, breach-done path), release the OB claim right there (same
release the arb path uses) instead of waiting for a next arb pick that may never come.

## D. POST-BOSS: DISCOVER STARVED THE SWEEP FOR THE WHOLE 150s BUDGET + STALE LEG CLOCKS
Smoking gun: `07:54:17.892 [Cleanup] budget 150s spent -> leaving anyway` then **+1ms**
`07:54:17.893 [AbyssSweep] site (1150,1116) retired: walk cap (0 left)`. The deferred site (known coords,
84u away) never got ONE step.
- D1 ORDER: MAP_COMPLETE Phase 3.75 (~17697-17720) `break`s whenever tryCleanupContent OR
  tryDiscoverListedContent OR tryCoverageSweep drives — Phase 3.8's tryAbyssChestSweep (~17819) sits BELOW
  and starves. The sweep is DETERMINISTIC work (remembered coordinates); discover/coverage are SPECULATIVE.
  FIX: service the sweep before the speculative fallbacks — insert a tryAbyssChestSweep attempt after
  tryCleanupContent returns false (before discover/coverage), or hoist Phase 3.8 above 3.75 with a guard so
  real reachable queued content still wins. Requirement: a live sweep site is serviced before ANY
  reveal-explore gets the frame.
- D2 STALE CLOCKS: the deferred site kept its pre-boss `s.startAt` (07:48:42) + `_abSwTrack` state, so the
  first post-boss frame hit `now - s.startAt > ABYSS_SWEEP_WALK_MS` -> instant `walk cap` retire. FIX: when
  the pre-boss budget defers (the `return false` at ~4059), reset the in-flight site's leg state
  (s.startAt = 0, tracker key cleared) so the post-boss resume starts a FRESH walk leg.

## E. DISCOVER WALKS TO THE *COMPLETED* BREACH INSTEAD OF HUNTING THE REAL SECOND ONE
USER RULING (encode this): the map-objective state is AUTHORITATIVE. Objective bit INCOMPLETE while >=1
instance of that type was FOUND AND COMPLETED = PROOF another instance exists on the map — this is NOT the
"listed-but-maybe-phantom" case. The existing phantom hedge (~6489: optional-unfound gets only a 40s short
window because "the row means possible, not present") applies ONLY when ZERO instances were ever seen.
With >=1 done + bit still incomplete, discover must treat the remaining instance as CONFIRMED: use the full
required-level window (DISCOVER_EXPLORE_MS), and do not concede while radar-routable unexplored mass
remains (F). Live proof: Cenotes had a second breach; queue said `breach 1/1` (found-count only) while the
objective bit truthfully said incomplete.
The bug: the marker-first pick (~6536)
cannot tell a COMPLETED instance's marker from an unfound one (no done-icon — the 994/1000 skip at ~6539
missed it), so it walked to the DONE breach at (1277,817) at 07:52:03 AND 07:53:47 (~104s apart = the 60s
reached-consume ban at ~6517 expiring + re-pick) — burning the window it needed to find breach #2.
FIX: when a queue content entry COMPLETES, long-ban its position bucket in `_unexpFailed` (10min) AND make
the marker-first pick skip markers within ~60u of any COMPLETED queue entry position (track completed
positions per type in a small array if the purged queue doesn't keep them). Result: discover ignores the
done instance and spends its whole window hunting the REAL remaining one. The map summary should also show
this state honestly: when the objective bit says incomplete but all FOUND instances are done, log
`breach 1/1 found (game lists more, unfound)` instead of a clean-looking `1/1`.

## F. DISCOVER NEVER REVEALED THE AREA WHERE BREACH #2 WAS (bucket cycling on unroutable terrain)
07:52:25-07:54:09: every picked fog bucket stalled in ~9-15s (cliff/water islands the fog-crawl can't
reach), blacklist->next cycled far-apart buckets ((1436,754)->(1755,754)->(1755,970)->(1436,1185)->
(798,754)->...) — the on-screen zigzag — and the second breach's area was never revealed, so a REAL listed
content item was left undone. This makes F a completeness fix, not just an anti-yoyo polish.
FIX (directive): validate bucket candidates with `poe2.radarFindPath` (fog-independent, elevation-CORRECT —
already bound) in `pickRouteNearestBucket` and skip unroutable buckets upfront, so the picker spends its
window on ground it can actually walk — including routing AROUND cliffs to reachable fog instead of
9s-stalling into them. Only after radar says NOTHING routable remains may discover concede early (that
replaces today's cycle-until-budget). Do NOT rebuild discover on the navigator here (that's TASK-44+).

## Hard limits
- mapper.js: sweep block (~3920-4140), MAP_COMPLETE phase block (~17650-17825), incidental-completion release
  (C), discover accounting (E/F). opener.js: breadcrumb only. Flags: A=`ABYSS_SWEEP_CHEST_WALK_ON`,
  D1/D2=`ABYSS_SWEEP_POSTBOSS_FIX_ON`, E/F each behind one const; flag-off = today byte-parity. No new
  movement mechanisms — reuse startWalkingTo/stepPathWalker/walkableApproachPoint/trackOwnedProgress.
  TEST BEFORE COMMIT.

## Acceptance
- `node --check` both; parity walk flags-off.
- Live (abyss+breach map): sweep walks chest-to-chest, no 45s ceiling on a reachable chest; any opener
  refusal prints ONE `[Opener] chest skip` line; post-boss a deferred site is serviced BEFORE reveal-explore
  (fresh walk leg, no instant walk-cap retire); no `[Discover]` marker-walk to a COMPLETED instance — the
  window goes to hunting the real remaining one; bucket picks are radar-routable (no 9s stall-cycle); OB
  releases on incidental/instance completion (no zombie committed=).
- MAP SUMMARY target: abyss-chest d == t where sites are physically reachable; a map listing a second
  breach either gets it FOUND+done or logs the honest `game lists more, unfound` tail.
