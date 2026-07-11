# TASK-10 REPORT — Breach-mob routing (A) + shrine line-of-fire gate (B)

Pre-snapshot: `handoff\pre\TASK-10\mapper.js`, `handoff\pre\TASK-10\opener.js` (copied BEFORE any edit;
md5 verified identical to the live files at copy time). Diff base for the planner review.

## Files touched
- `mapper.js` — item A only.
- `opener.js` — item B only.
No other files. No C++, no repo (`jmrpoe2-scripts`) writes, no git, no memory writes, no new packets, no new settings.

## A. Breach far-mob chase now routes (mapper.js)

Symbols added:
- `rotBreachChaseMoveAt`, `rotBreachChasePX`, `rotBreachChasePY`, `rotBreachWedgeLogAt` (declared next to
  `rotBreachTgtId` / `rotBreachTgtSince`).

Symbols modified (all inside `runBreachRoam`):
- target-change line `if (rotBreachTgtId !== mob.id)` — also zeroes `rotBreachChaseMoveAt` (new mob = fresh anchor).
- swarm-standoff early return (`const _so = swarmStandoffPoint(...)`) — zeroes `rotBreachChaseMoveAt`.
- the chase block: `if (mob.dp > 55) moveTowardGridPos(...)` → wedge-detected route (`navTo(..., 'Breach Mob', now)`,
  escalating to `macroWaypointToward` when wedged).
- `statusMessage` in the mob branch now reports the movement mode (`kill` / `running to` / `routing around ->` /
  `wedged, routing ->`) instead of always `kill`.

Behavior, exactly mirroring the abyss chase (`runAbyssRun`, `abyssChaseMoveAt` / `macroWaypointToward` / `navTo`):
- FAR (`mob.dp > 55`): `navTo(mob.gridX, mob.gridY, 'Breach Mob', now)` — the fog-gated BFS routes around local walls
  instead of dead-reckoning into them.
- WEDGED (position moved <8u for >2.2s while on the FAR branch): `macroWaypointToward(player → mob)` and walk that
  corridor waypoint; if the macro router returns nothing, fall back to `navTo`.
- CLOSE (`<= 55`): unchanged — `sendStopMovementLimited()`. The wedge anchor is zeroed here so deliberately holding
  at bow range can never accrue wedge time.

Untouched, as required: `swarmStandoffPoint` and its early return path, the `sendStopMovementLimited` hold, the 5s
`rotBreachTgtSince` chase clock, its dodge/MB hold (`now < dodgeMoveSuppressUntil || !MB.avail('content', 3)`), the
8s `rotBreachMobBL` blacklist, `bestBreachMob`, and every breach touch/clear/dwell timer.

Rule compliance:
- MOVEMENT (rule 3): only `moveTowardGridPos`, `navTo` (→ `startWalkingTo` + `stepPathWalker`) and
  `sendStopMovementLimited`. No raw senders.
- PERF (rule 4): `navTo` self-throttles repaths (`lastRepathTime > 500` + an 18u target-move gate);
  `macroWaypointToward` is internally cached (1.5s TTL / 60u target-move) and only runs on wedged frames.
  No new entity scans — `bestBreachMob`'s existing 320ms-throttled scan is the only source of mob positions.
- LOGGING (rule 5): one new line, `[Breach] wedged chasing ... -> macro route around|BFS route`, throttled to 3s.
- COMMITMENT (rule 1): the wedge detector changes only *how* we move to the already-committed mob. It never bans,
  never re-picks a target, and cannot advance the 5s ban clock.

### Considered and rejected: a dead-reckon last resort
When BFS has no path AND the macro router returns null, the bot now stands still until the 5s clock bans the mob
(previously it wall-humped). I did *not* add a `moveTowardGridPos` fallback:
1. `navTo` returns `stepPathWalker()`'s **status string** (`'no_path'`, `'stuck'`, `'arrived'`, …) — all truthy —
   so the obvious `if (!moved) deadReckon()` guard would silently never fire, and a string-matched version is
   behavior beyond the brief.
2. Standing still for 5s then banning IS the brief's acceptance criterion ("the 5s blacklist now fires only for the
   truly unreachable"), and `runAbyssRun` accepts the same idle case.
Flagging it because it is the one case where the new code moves *less* than the old code. If the planner wants the
wall-hump preserved as a last resort, it belongs behind an explicit `=== 'no_path'` check.

## B. Shrine line-of-fire gate dropped (opener.js)

In `collectOpenTargets`, the shrine bucket (`if (openShrines.value)`):
- REMOVED: `if (!allowBlockedVisibility && !passesVisibilityCheck(player, entity, maxDist) && dist > 34) continue;`
- Shrines are now pushed to `targetsToOpen` on `isShrineEntity(entity) && entity.isTargetable === true` alone,
  at any range within `maxDist`.

Verified against the rest of the open path (this is why the fix is safe and why 34u was the *only* blocker):
- The open-side WALKABLE GATE in `processAutoOpen` already exempts shrines: it computes
  `cellWalkable = poe2.isWalkable(tx, ty)` and only runs `isWithinLineOfSight` when the target's own cell is
  walkable. Its comment records the same live-RE fact (`shrineCellWalkable=false`). So a shrine that passes
  collection is *not* re-gated on LoS before `sendOpenPacket`. Confirms the planner's structural-falsity diagnosis
  from the other end of the pipe.
- `targetsToOpen.sort((a, b) => a.distance - b.distance)` runs before target selection, so a newly-eligible 70u
  shrine cannot preempt a nearer chest.
- The chest, essence, special-object and door buckets keep their `passesVisibilityCheck` gates verbatim
  (4 call sites remain, unchanged).
- `isWarpOrPortalEntity` / `shouldSkipOpenTarget` / `markOpenAttempt` / `OPEN_MAX_ATTEMPTS` untouched — an
  unreachable shrine is still bounded by the attempt blacklist.

## Settings added
None. Both are correctness fixes (brief: "No new settings"). Flag-off parity (rule 2) therefore does not apply;
no new behavior sits behind a toggle because none was requested. Item B's behavior still respects the existing
`openShrines` setting.

## Verification performed
- `node --check mapper.js` → OK.
- `node --check opener.js` → OK.
- Symbol grep: all 4 new mapper globals resolve at their declaration + use sites; `'Breach Mob'` label present;
  `passesVisibilityCheck` still referenced by exactly the 4 non-shrine buckets.
- `diff -u` vs `handoff\pre\TASK-10\` shows only the two intended hunks (1 + 3 in mapper.js, 1 in opener.js) with
  no collateral edits.
- NOT run: the live game. No agent fleets used (rule 0) — solo, no workflows.

## LIVE-TEST CHECKLIST

### A — breach rare behind terrain
Setup: any breach; wait for `[Breach] STABILISED -- rares spawned`, with a rare across a wall/chasm/mountain.

WORKING:
- Status line reads `Breach: running to Rare 90u [stab]` (not `Breach: kill ...`) while >55u out, and the player
  visibly walks a *corridor*, not into the wall.
- If it does jam: within ~2.2s, `[Breach] wedged chasing Rare at 87u -> macro route around` (or `-> BFS route`),
  followed by `Macro route: N wp around the fog toward (x,y)`, and the player peels off around the obstacle.
- The 5s ban (`rotBreachMobBL`) fires **rarely** now, and only for mobs that are genuinely sealed off.
- Close range unchanged: at <55u the status returns to `Breach: kill ...` and the player STOPS and shoots.

BROKEN — report these:
- `[Breach] wedged ...` repeating every 3s with no movement → both routers have nothing; the mob is sealed and the
  5s ban should end it. If the ban does *not* fire, the chase-clock hold regressed.
- Player walks past/around the mob and never stops to shoot, or oscillates between routing and standing at ~55u →
  hysteresis needed at the 55u boundary.
- `Breach: standoff (N in melee press)` no longer appearing when a pack presses in → standoff regressed (it must
  still win over the chase).
- Any movement while `dodgeMoveSuppressUntil` is live, or the breach ending sooner than before.

### B — shrine at 35–80u
Setup: walk toward any targetable shrine (Resistance/Diamond/etc.) and stop the approach past 34u.

WORKING:
- `[Opener] Opened Shrine: <name> (ID: 0x..., Dist: 39.4)` at a distance **> 34** — the previously impossible line.
  The game auto-walks the player to it and the buff lands.
- Chests behind walls are still skipped (no `0xC0` walled-chest open spam), and no
  `[Opener] Opened Essence: MultiplexPortal`.

BROKEN — report these:
- `[Opener] Blacklisted Shrine: <name> after N attempts` on a shrine that is plainly reachable → the open packet is
  firing from too far and burning attempts; a distance cap would then be needed (essence uses 40u).
- The opener repeatedly targeting a far shrine while a nearer chest sits unopened (would mean the nearest-first sort
  is not doing what I read it to do).

## Risks / deviations
- No deviations from the brief. One judgement call recorded above (no dead-reckon last resort) and one cosmetic
  addition: the breach `statusMessage` now names the movement mode, which is what makes the (A) live test readable.
- `navTo('Breach Mob')` writes the SHARED path-walker state (`currentPath`, `targetGridX/Y`, `targetName`,
  `lastRepathTime`), exactly as `navTo('Abyss Mob')` already does. `runBreachRoam` owns the frame
  (`MB.set('content', 3)`) while a breach is active, so this is the established pattern, not a new hazard.
- `stepPathWalker`'s 8s net-progress watchdog can fire a random dislodge burst on any `targetName` under 250u.
  During a breach chase the 5s mob ban fires first, and the watchdog's key is quantized to the (moving) mob's
  position, so it should not trip. Same exposure as the abyss chase. Worth an eye during the live test.
- Item B widens shrine eligibility from 34u to `maxDistance.value`. Every shrine open still costs an attempt against
  `OPEN_MAX_ATTEMPTS`, so a shrine the game refuses to auto-walk to would be banned after a few tries rather than
  retried forever.

## Open questions
None blocking. One for the planner's judgement: item A's brief says the 5s blacklist "now fires only for the truly
unreachable" — with routing in place, 5s may be *short* for a rare 150-210u out at the ring edge that we now walk a
longer corridor to reach. I did not touch the timer (hard limit says the bounds stay as-is), but if the live test
shows rares getting banned mid-route, that timer is the next thing to look at.
