# TASK-66 — Split-map fog concede: verify before radar-banning fog buckets; never claim "map revealed" while required content + big fog remain

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\navigator.js` into `handoff\pre\TASK-66\`. USE OPUS 4.8.
BRIDGE required for Phase A (single-client pipe — fire only when TASK-65's session is closed). THE USER WILL
RESTART AT THE EXACT FAILURE SPOT (Sandspit boss room) — Phase A probes that live instance first.

## Evidence (C:\tmp\log.txt 10:37, Sandspit + screenshots)
Sandspit = two long parallel paths joined at the start, separated by mid-map cliffs. Bot in the boss room
(east path end), WEST HALF ENTIRELY UNEXPLORED, gate honest: `Abyss exists=1 complete=0`. Then:
`[Discover] bucket (517,862) radar-unroutable -> banned upfront` + same for (517,517) — the buckets sit
~230u west ACROSS THE CLIFF; the true route is the long walk back through the start. Then the killer:
`[Discover] no fog frontier + no routable mass -> conceded (map revealed, no patrol)` — banning the only
two frontier buckets ERASED the frontier (deep fog buckets have no revealed-adjacent representative), so
the concede claimed "map revealed" with half the map dark. MAP_COMPLETE sat "content remains, nothing
reachable" on a 72s budget. USER: "a proper, reliable, reviewed way to fix this."

## Phase A — prove WHY radarFindPath nulled (bridge, user parked at the failure spot)
From the boss room, radarFindPath to: (517,862), (517,517), each ± walkable-snapped offsets (try 3-4 snaps
within the bucket), a deep-west point, and the MAP START (the join). Hypotheses to separate:
(a) route-length/iteration cap in the A* (start reachable but far buckets null),
(b) 8x-downsampled grid pinches the join (start ALSO null),
(c) target-cell snap-miss (bucket center on cliff; snapped neighbors route fine),
(d) true foot-disconnect (everything west nulls, start routes fine, join provably walled).
Also dump the frontier state there (getUnexploredBuckets / bucketTouchesRevealed inputs): confirm the
banned-bucket->erased-frontier mechanism. Deliver a verdict table; the (a)-(d) answer decides B1's shape.
PLANNER PRE-PROBES (2026-07-14, live at the parked spot (806,553) — inherit, don't repeat):
- getMinimapIcons: 10 icons, ALL east-path/start; ZERO abyss icons (no 888/889/891), ZERO west-half icons
  -> the icon store does NOT know never-approached content; B2a (icon walk) is DEAD, B2b fog-walk is PRIMARY.
- getAllEntities at (806,553): 9230 entities, ZERO with gridX<620 and ZERO /Abyss/ anywhere -> the west
  path NEVER streams from the east path even at the closest latitude (answers the user's "should've marked
  it walking past": it never could — nothing west ever entered the client's entity list).
- radarFindPath (806,553)->(517,862): NULL confirmed live. Remaining for YOU: route to the map START
  (~1818,2523 — checkpoint icon, known-walkable; tests the length-cap hypothesis), walkable-snapped
  variants of both banned buckets (snap-miss hypothesis), and progressive west-path targets from the join
  northward (find where routing dies). ONE radarFindPath PER PROBE — a 40-call batch hit the frame
  drain-timeout during TASK-65 and likely cogwheeled the game. NEVER batch radar calls.

## Phase B — layered fix (flags `DISC_VERIFY_BAN_ON = true`, `CLEANUP_FOG_FALLBACK_ON = true`; off = today)
1. VERIFY-THEN-BAN: a radar-null toward a FOG bucket is UNKNOWN, not unreachable. Ban only after N(=3)
   distinct walkable-snapped targets in that bucket all null, AND log the ban with the snap count:
   `[Discover] bucket (x,y) radar-unroutable (3 snaps) -> banned`. If Phase A finds a length cap, raise/
   parameterize it C++-side ONLY if trivial — otherwise treat cap-nulls as UNKNOWN too (never ban on them).
2. CONCEDE GATE HARDENING: the `no fog frontier + no routable mass` concede may NOT fire while
   (gate lists missing required/on content) AND (total unexplored fog mass > threshold). In that state:
   a. PRIMARY (if Phase A finds the far abyss in the icon store): walk the un-done abyss ICON directly —
      the breach-hand pattern repeated for abyss (icons 888/889/891 + any pit type Phase A identifies,
      dedup vs completed positions, radar-validated with B1's verify-then-ban semantics).
   b. FALLBACK — now PRIMARY (planner pre-probe killed (a): the icon store knows nothing of the west
      half). USER RULING 2026-07-14: "i want you to EXPLORE man. since u know a LOT is unexplored here and
      stuff left" — while the gate lists missing content AND big fog remains, the bot KEEPS RUNNING
      nav-explore legs toward fog centroids (navigator owns them — frontier-walk reveals incrementally;
      the walker's stuck machinery owns recovery), leg after leg, re-evaluating discover between legs
      (fresh reveals un-ban buckets naturally). Bounded ONLY by the cleanup budget + a no-reveal-progress
      concede (2 consecutive legs adding ~zero revealed mass -> honest concede). Determined, not one-shot.
3. LOG HONESTY: the concede line must print the measured fog mass, never assert "map revealed" unmeasured:
   `[Discover] conceded: fog-mass=N routable=0 (gate: Abyss missing)`.

## Explicitly OUT
Checkpoint-TELEPORT capability (if Phase A proves a true foot-disconnect, REPORT it as the finding and
stop — teleport is its own task). No walkable-grid/nav rewrites; the navigator drives the fallback leg
through its existing API. No dodge/combat changes.

## Hard limits
Phase A before any edit. No per-frame radar calls (bucket verification only at discover-time, snaps
counted per bucket per map). node --check both files. TEST BEFORE COMMIT.

## Acceptance (the user's restart)
On the live Sandspit instance from the boss room: discover does NOT concede; the bot takes the long route
(or the fallback leg chain) into the west half, finds + completes the abyss, MAP SUMMARY honest. On normal
maps: zero behavior change (flags' paths only fire in the missing-content + big-fog state).
Report handoff\TASK-66-REPORT.md: Phase A verdict table, chosen B1 shape, gate sites, thresholds.
