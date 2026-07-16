# TASK-65 — Z-aware reachability: cross-layer mobs must not derail MOVEMENT toward objectives

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-65\`. mapper.js ONLY.
USE OPUS 4.8. Bridge needed for Phase A calibration (single-client pipe — planner session closed).
USER SCOPE RULING 2026-07-14: "i dont mind that entity actions attacks retardedly for now, i care about
YOUR movement towards objectives during that time" — the ATTACK-side gate is OUT (see Explicitly OUT).

## Evidence (C:\tmp\log.txt, Stronghold 09:43-09:51 2026-07-14 + user screenshots)
Rampart pocket: mobs on a wall ABOVE the player. The bot: (a) chased an Elite it could never reach
("Walking to Elite ... No net progress 8s at 184u -> stuck + dislodge"), (b) shot arrows into the parapet
(user: "U cant hurt those mobs"), (c) ground the wall toward Breach/Abyss Node/Content Explore — FIVE
stuck-dislodges in ~2min, all the same height discontinuity. The 2D walkable grid has no Z: a mob 50u away
euclidean can be a full story up with the real path 10x longer through the stairs. USER: "Consider Zs?"

## Phase A — calibrate (bridge, live; user parks below rampart mobs when available, else any multi-level map)
1. Confirm which fields the LIGHTWEIGHT entity read carries: worldZ? terrainHeight? (full read has both).
   If lightweight lacks Z, measure the cost of reading it where the gates below need it.
2. Measure dz distributions: same-floor mobs vs rampart/ledge mobs vs stair transitions (player worldZ vs
   entity worldZ and vs terrainHeight at the entity cell). Deliver the threshold with data, not a guess.
3. The reachability oracle: radarFindPath(player -> mob cell) — measure the DETOUR RATIO (path length /
   euclidean) for same-floor vs cross-layer targets. Proposed verdict: UNREACHABLE-NOW = dz > Z_GATE AND
   (no radar path OR detour ratio > ~3). Validate on the log's exact case if the user can reproduce.

## Phase B — wire the gates (flag `Z_REACH_GATE_ON = true`, off = today byte-parity)
Verdicts are CACHED per entity id (~20s) and evaluated ONLY at decision points — never per frame:
1. CHASE START (rare/elite chase pick): unreachable-now -> skip candidate + `[Chase] skip <name>: cross-layer
   (dz=N, detour=R)` (throttled). A 20s per-id ban, re-evaluated after (mob or we may have moved layers).
2. POSTURE THREAT SCAN (_postureThreatScan): cross-layer hostiles don't create hold/back-out pressure —
   a mob that cannot path to us is not a threat driving movement (dodge/packet-level stays untouched).
3. NOTHING ELSE: navigation/walker/dislodge logic untouched — the fix is not STARTING doomed pursuits;
   the existing stuck machinery keeps owning mid-walk recovery.

## Explicitly OUT (user ruling)
- entity_actions / rotation targeting: the bot MAY keep shooting cross-layer mobs — harmless casts are
  accepted; only MOVEMENT ownership matters here. Do not touch entity_actions.js.
- Dodge (packet-level), walkable-grid/nav rewrites (2-tier vertex grid stays PARKED).

## Hard limits
mapper.js only. No per-frame radarFindPath (decision-point + 20s cache only; reuse RADAR_LAZY_VALIDATE
idiom). node --check. TEST BEFORE COMMIT.

## Acceptance
On a rampart map: no chase-start toward cross-layer mobs (skip line instead), posture doesn't orbit under
unreachable hostiles, movement toward Breach/Abyss/Explore proceeds while they plink — stuck-dislodge count
on such pockets drops visibly. Report handoff\TASK-65-REPORT.md: Phase A tables (dz + detour data), gate
sites, threshold values, deviations.
