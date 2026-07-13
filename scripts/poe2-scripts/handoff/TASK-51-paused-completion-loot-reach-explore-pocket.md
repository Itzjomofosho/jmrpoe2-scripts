# TASK-51 — Paused-completion strands loot/chests + pickit false-unreachable on web terrain + explore pocket

FIRST ACT (HOUSE_RULES): copy `..\mapper.js`, `..\pickit.js`, `..\navigator.js` into `handoff\pre\TASK-51\`.
Files: mapper.js (A) + pickit.js (B) + navigator.js (C, small). USE OPUS 4.8.
SEQUENCING: fire AFTER TASK-53 (planner reordered: 53 wedges whole maps, this one is loot-loss) and BEFORE
the decomposition phase-1 task; never concurrently with either.
Evidence: C:\tmp\log.txt (Mire, 2026-07-13 15:02-15:08) + user map screenshots (stranded abyss chest,
unlooted Chaos Orb, unexplored strongbox pocket).

## A. COMPLETED-WHILE-PAUSED = BARE RELEASE, NO COMPLETION WORK (the stranded abyss chest)
Live chain: committed abyss:724, AT the node clearing under heavy pressure; 15:03:18.9 `[OB] pause
content:abyss:724 by=rare`; the node flipped SPENT during the pause (the fight killed the wave; the runner
wasn't ticking); 15:03:20.758 `[OB] complete content:abyss:724 (arb-release, consumed while paused)`.
Because the flip-watch EXCLUDES runner-committed nodes (that's "the runner's job") and the runner was
paused, NOBODY ran the completion work: no loot dwell, no abyssSweepAdd chest site, no sweep. The chest sat
stranded (user's screenshot; user looted manually). ALSO: the second entry (abyss:753) left the queue
SILENTLY between 15:03:26 and 15:04:41 (`[Discover] gate: Abyss ... queued=0`) with no completion/abandon/
skip log — find and name that exit (second deliverable).
FIX (flag `PAUSED_COMPLETION_ON = true`): completion-while-paused must run the same post-completion work the
runner would have: for abyss — abyssSweepAdd(node pos) + the loot-dwell handoff (the sweep machinery already
does dwell+opener at sites; queueing the site is the minimum). Generalize where cheap: the flip-watch's
committed-node exclusion should queue the chest site WHENEVER the committed runner didn't get to (runner not
in its loot-dwell for that node), not skip on "committed" alone. Breach/verisium equivalents: state in the
report whether their paused-completion paths have the same hole (breach roam-end and exp2 loot are runner-
internal — likely safe, but VERIFY and say so).

## B. PICKIT FALSE-UNREACHABLE ON WEB TERRAIN (the Chaos Orb left on the ground)
`[Pickit] Item Chaos Orb may not be reachable - will retry after delay` x3 over 3 minutes (also GoldCoin x4)
— then the map was left. The reachability probe is a STRAIGHT-LINE walkable test; on Mire's bridge-weave an
item across a chasm gap reads unreachable while a walk-around route exists (the whole day's lesson: straight
lines lie on web terrain).
FIX (flag `PICKIT_ROUTE_REACH_ON = true`): when the straight-line probe says unreachable for an item whose
rule matched (i.e. we WANT it), before giving up: probe a real route — poe2.radarFindPath player->item (end
within ~20u of the item = reachable) — and if routable, hand the item to the mapper's loot-sweep walk
(sweepLootStep pattern / walkableApproachPoint) instead of the pickit straight grab. Cache the radar verdict
per item id (30s) — never per-frame radar calls. Items that radar also can't reach keep today's retry/skip.
Bound: one radar call per unreachable item per 30s, only for rule-matched items within the loot radius.

## C. EXPLORE POCKET: region declared done with an unwalked pocket holding a strongbox (user: "probably hard")
User screenshot: a dark unexplored pocket containing a strongbox + the trail dots showing the bot explored
all around it. Suspects (investigate, pick the cheapest real fix):
1. The region done-check (disc remaining-mass < max(120, 20% initial)) — a pocket smaller than
   NAV_REGION_DONE_MASS=120 inside an otherwise-drained disc is BY DESIGN left; on weave maps pockets are
   small but contain content. Option: when a drained region's disc still contains a KNOWN content/utility
   POI (hv anchor, strongbox candidate from the opener feed), require the pocket visited (the POI lane
   already handles this if the anchor exists — check why no anchor: strongboxes are deliberately NOT hv
   anchors per TASK-38; consider adding strongboxes to the anchor types as the cheap fix, they're exactly
   the "known thing in an unexplored pocket" case).
2. The rvisit lattice (96u pitch) can miss a pocket smaller than ~2 cells — verify against this pocket's
   size on the screenshot scale; if that's the miss, note it (pitch change = cost, needs planner sign-off,
   do NOT change it unilaterally).
State which suspect was real in the report. Minimum shipped fix: strongboxes (openStrongboxes-gated) join
the hv-anchor feed (`hv-strongbox`), so a spotted-then-passed strongbox pulls exploration like an essence
does. Flag: rides NAV_HV_ANCHORS_ON.

## Hard limits
- All three independently flagged; flags off = today byte-parity. No new entity scans (B reuses pickit's
  existing feed; C rides the TASK-38 opener-feed hook). node --check all three; TEST BEFORE COMMIT.
- Do NOT touch: the amnesty/steal-guard (proven live on Mire), the discover gate (its forensics just proved
  the bitfield honest), posture/dodge.

## Acceptance
- A: a node completing while its runner is paused still queues its chest site (sweep services it); no bare
  `consumed while paused` release without follow-up work; abyss:753-class silent exits named + fixed.
- B: a rule-matched item across a web gap gets a route probe + a walk, not 3 retries and abandonment.
- C: a spotted strongbox in an unexplored pocket becomes an anchor -> the pocket gets walked.
