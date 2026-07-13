# TASK-49 — Path-order content on linear maps (no walk-backs) + post-complete discover hunts done content

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-49\`. File: mapper.js ONLY. USE FABLE
(arbiter route-order + discover internals). Evidence: C:\tmp\log.txt (Ravine, 2026-07-13 13:44-13:57).

## A. GREEDY-NEAREST LEAVES A TRAIL OF PASSED CONTENT (user: "this map was just one long wind — WHY GO BACK")
Timeline (all live): breach:1 queued 13:48:10, breach:2 13:48:41 — both spotted while committed to abyss:825
(deferral correct). Abyss finishes -> the picker takes verisium:860 at ins=1 (nearest NOW). Verisium chain
runs to 13:51:26 -> ONLY THEN breach:43 claimed at **OFFROUTE ins=1706** — a 1700u walk BACK up the wind.
ROOT: on commit-completion the arbiter re-picks by current ins/bud — newly-spotted near items always beat
items passed minutes ago, whose insertion cost GROWS as the path winds on. Nothing remembers "you walked
PAST this; it is next in path order."
FIX (flag `ARB_PATH_ORDER_ON = true`): when a candidate is first seen NEAR/ONROUTE (small ins) while another
content commit holds, INSERT it into the pending order right after the current commit (the arbRouteOrder
machinery exists — verify what it currently does and why it didn't order breach:43 next). On completion, the
next pick must PREFER the pending passed-item (its ins measured when spotted / re-measured now) over a fresh
nearest-now candidate unless the fresh one is strictly on the way to it. Retreat-distance cap: a passed item
whose CURRENT ins exceeds ~800u falls back to today's scoring (never force a mega-backtrack; post-boss
cleanup still owns leftovers). State in the report exactly how arbRouteOrder computes today vs after.
Acceptance shape: on a linear map, content is claimed in path order (each claim's ins at commit is SMALL);
no claim with ins > ~700 for content that was previously NEAR.

## B. POST-COMPLETE DISCOVER: hunts types the UI shows DONE + patrol-spokes a revealed map + dual-target thrash
Live (13:55:43-13:57+, map objective COMPLETE, every content icon checked in the game UI):
- `[Discover] listed content unfound -> exploring` for breach+verisium (their markers get skipped as
  done/completed — the marker-skip works; the GATE that started the hunt is what's wrong).
- `no fog frontier -> patrol spoke toward (...)` cycling spokes + stall-blacklists + radar-unroutable bans on
  a fully-revealed map — the corner-ping pattern the coverage-kill was supposed to end.
- WALK THRASH: `Walking to Content Discover at (3471,885)` alternating with a DRIFTING near target
  ((3249,711)->(3247,717)->(3240,709)...) every ~150ms — TWO writers inside the discover lane fight the walk.
FIX (three parts):
1. GATE: instrument + root-cause `hasUnfoundListedContent` on this state — log per-type `exists/complete/
   queued` ONCE when discover opens post-complete (`[Discover] gate: breach exists=1 complete=0 queued=0`).
   If the base-game bit genuinely reads incomplete while the UI shows done, that's an offset/read bug —
   capture the raw objState values in the log line for the RE follow-up. If it's our accounting (e.g. purged
   entries), fix the accounting.
2. REVEALED-MAP CONCEDE: when the map has no fog frontier AND pickRouteNearestBucket has no routable mass,
   the patrol-spoke fallback must NOT run post-complete — concede discover instead (spokes exist for the
   mid-map "reveal the wing" case; post-complete on a revealed map they are pure corner-ping). Bound: this
   makes the 13:55:50-13:57 tail a single concede line.
3. DUAL WRITER: find the second startWalkingTo caller producing the alternating drifting target (suspect:
   the fog-crawl clamp / patrol endpoint recomputed per pass vs the sticky discoverTgt) — ONE writer per the
   movement discipline; the sticky target owns the walk until reached/stalled.

## Hard limits
- mapper.js only. A rides the EXISTING arbRouteOrder/route-insertion model (no new pathfinding); B changes
  gate/fallback/writer logic in tryDiscoverListedContent + its picker only. Both flagged (`ARB_PATH_ORDER_ON`,
  `DISC_POSTCOMPLETE_FIX_ON`); flags off = today byte-parity. node --check; TEST BEFORE COMMIT.
- Do NOT touch: the white-tail exit (proven live 2x this map), the engaged gates (proven), the completed-
  instance marker skip (working — it's the gate that's wrong, not the skip).

## Acceptance
- Linear map: content claimed in path order, no ins>700 walk-backs for previously-NEAR content.
- Post-complete on a done map: discover either names a REAL unfound type (with the gate log proving it) and
  hunts routable ground only, or concedes in one line — no patrol spokes, no alternating walk targets, tail
  <=10s from MAP_COMPLETE to portal phases when nothing remains.
