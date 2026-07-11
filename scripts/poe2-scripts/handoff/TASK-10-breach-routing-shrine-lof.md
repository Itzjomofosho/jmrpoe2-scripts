# TASK-10 — Breach-mob routing (P5) + shrine line-of-fire gate (the solved skip mystery)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\opener.js` into `handoff\pre\TASK-10\`.
Two independent items, one session.

## A. Breach roam: route to mobs, don't dead-reckon (mapper.js)
User P5: "BREACH RARES other side of mountain, U cant get there — why aren't u walking back properly!?"
Mechanism (planner-diagnosed): in `runBreachRoam`, the chase is `if (mob.dp > 55) moveTowardGridPos(player, mob)`
— a straight-line push with NO pathfinding. A stabilised rare across a wall/chasm = push into the wall until the
5s chase clock blacklists it (8s), then the next unreachable mob, round-robin.
Fix: mirror the ABYSS chase pattern (search the abyss `wedged` logic in `runAbyssRun` — `abyssChaseMoveAt` /
`macroWaypointToward` / `navTo(am.gridX …)`):
- Track physical movement while chasing (position-delta anchor, the abyss shape). WEDGED (~2.2s no movement while
  chasing) → `macroWaypointToward(player, mob)` and walk that corridor waypoint; fall back to
  `navTo(mob.gridX, mob.gridY, 'Breach Mob', now)` when the router has nothing.
- FAR mob (`mob.dp > 55`) → `navTo(...)` (fog-gated BFS routes around local walls) instead of the blind
  dead-reckon; CLOSE (<55) keeps today's behavior (standoff logic untouched, `sendStopMovementLimited` hold
  untouched).
- The 5s unreachable blacklist and the dodge/MB chase-clock hold (search `rotBreachTgtSince`) stay exactly as-is —
  they are the bounds; you are only upgrading the movement between them.

## B. Opener shrine line-of-fire gate (opener.js)
Solved mystery (planner + TASK-08 live probe): `opener.js` ~line 475 relaxes the line-of-fire gate for shrines
only within 34u. A shrine's own tile is NON-WALKABLE, so `hasLineOfFire` to a shrine is STRUCTURALLY FALSE at any
range — a targetable Resistance Shrine at 39u (well inside the 80u reach) was skipped every tick, forever.
Fix: for SHRINE targets, drop the line-of-fire requirement entirely (any range within reach) — LoF is meaningless
against a structurally-false signal. Keep LoF gating for every other target type. Locate by searching the shrine
LoF relax (`34` near `hasLineOfFire` / the Shrine bucket) and verify your change against the comment history there.
Acceptance test IS the falsifiable prediction inverted: a targetable shrine at 35-80u now gets interacted without
the player first standing within 34u.

## Hard limits
- No changes to breach touch/clear/dwell timers, swarmStandoffPoint, MB, or the opener's ban machinery.
- No new settings (both are correctness fixes).

## Acceptance
- `node --check` on both files.
- Report per HOUSE_RULES; live-test checklist: (A) a stabilised breach rare behind terrain gets ROUTED to
  (`Breach Mob` nav paths in the log) instead of wall-humping, and the 5s blacklist now fires only for the truly
  unreachable; (B) shrines between 35-80u get opened on approach — watch for the previously-impossible
  `[Opener] Opened Shrine` at >34u distances.
