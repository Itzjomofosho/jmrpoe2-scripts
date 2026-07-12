# TASK-41 REPORT — Ground-hazard classification (2026-07-12)

Pre-snapshot: `handoff\pre\TASK-41\` holds **auto_dodge_core.js AND mapper.js** (the brief said dodge core
only, but HOUSE_RULES' FIRST ACT requires every edited file, and part C needed the mapper consumer).

## Files touched + symbols

### auto_dodge_core.js
- **A — classifier**: `GROUND_CLASSIFY_ON` (flag), `GROUND_CLASSIFY_RANGE_U` (45), `GROUND_LETHAL_MARGIN_U` (15),
  `GROUND_CLASS_FLOOR_W` (12u→world), `GROUND_CLASS_CAP_W` (350w), `GROUND_CLASS_TABLE` (const array of
  `{re, sev, radiusMul}` — one line per new class), `classifyGroundPath()`, `_groundClassCache`
  (Map id → entry|0, pattern-tested ONCE per id).
- **B — scan**: new block at the end of `collectHazardsAndEnemies()` (search `TASK-41: whitelist-classified`):
  `POE2Cache.getSharedEntities()` (the exact read the [BlindGround] dump uses, ≤128 entities, already built
  per frame — no new native scan), gates in order: `entityType !== 'Monster' && isHostile` → within 45u →
  verdict cache → regex only on cache miss. Matches push `kind:'ground'` hazards (world coords,
  `radius = clamp(maxBounds/2 * radiusMul, 130w, 350w)`, `score` 13 LETHAL / 8 AVOID, `sev` stamped, `name` =
  path tail) into the normal list → existing rolls, walk-egress, sticky heading, and the danger-zone overlay
  handle them like any Vortex. No new dodge mechanics.
- **LETHAL semantics** in `runAutoDodge()`: `_lethalHaz` — any sev-2 hazard within `radius + 15u` forces
  `atRisk = hardRisk = true` (search `TASK-41: a LETHAL classified hazard`). Being HARD, the channel
  protection and interact/combat holds (soft-only) never hold it; the catchall tamer only touches
  `~catchall`-named hazards so it can't mute these; the **opener reach-hold got an explicit `!_lethalHaz`
  bypass** (search ``TASK-41: `!_lethalHaz` ``). `riskWhy` names the class as `lethal:<tail>` with precedence
  over the containing-hazard loop — deliberate: in the autopsy stack (shocked carpet + beacon pile) naming the
  carpet would route into the walk-only DoT path while the pile detonates; `lethal:` never matches the
  `ground:` DoT test, so the roll fires.
- **Soft-ground traversal strip**: sev-2 exempted (`out[i].sev !== 2`) — beacons detonate with the pack already
  dead, so the no-hostile-near strip must not eat them. AVOID carpets stay strippable (grd_Shocked01 matches
  `/shock/`): an amp carpet only matters under fire, and stripping keeps Slick-style traversal intact.
- **Bus publish** after `lastHazards =` (search `TASK-41: publish`): `POE2Cache.groundHazards` =
  `[{gx, gy, r, sev, cls}]` (GRID coords) + `POE2Cache.groundHazardsAt`, every scan, empty included.
- **Per-map clear**: `resetCatchallPromotions()` now also clears `_groundClassCache` (mapper already calls it
  in `resetMapper`; entity ids are per map-instance — same reasoning as the promotions registry).

### mapper.js (part C — the one bus consumer)
- `fightHoldPostureStep()`: new block after the committed-step re-steer, before the pressed back-step (search
  `TASK-41: never PLANT`). If the bus is fresh (<1.2s) and the player's cell is inside any published hazard
  (AVOID or LETHAL), it takes a posture step to `hazard radius + 8u` via the existing
  `pickRadialRetreatWaypoint` + `_clampLeash` + committed-step machinery and returns true → the caller skips
  its `sendStopMovementLimited`. This one edit covers ALL plant sites — engage, elite, breach, abyss, essence,
  sbox, verisium — they all route through this function. Log (2s throttle): `[Posture] standing in <class> ->
  stepping out`. New state: `_poGhLogAt`.

## Settings
- `GROUND_CLASSIFY_ON = true` (const, top of auto_dodge_core.js next to the other TASK flags). Off = byte-parity:
  no sev-carrying hazards exist, `_lethalHaz` stays null (all its guards reduce to today's conditions), the bus
  is never published, and the mapper block's freshness gate is permanently false. The mapper consumer has no
  flag of its own — the dodge-side flag kills the whole feature (brief: "keep it to ONE bus flag").

## Verification done
- `node --check` passes on both edited files.
- Symbol grep over the runtime dir: all new symbols resolve, no half-renames, no prior `groundHazards`
  collision on POE2Cache.
- Parity walk (flag off) written out above.

## LIVE-TEST CHECKLIST
1. **Overlay**: enable "Draw danger zones" — red circles must appear on explode-on-death beacons and on
   grd_ carpets during fights. Working = circles sit on the glowy floor things; broken = beacons visible on
   screen with no red ring (then run a [BlindGround]-style path check — the table regex may not match the
   real path; paste the dump line).
2. **Beacon roll-out**: kill a pack with explode-on-death mods and stand near the leftovers. Working =
   `[AutoDodge] ROLL ... why=lethal:fire_beacons` (or `why=ground:fire_beacons` when already inside) BEFORE
   the detonation lands; char visibly leaves the pile. Broken = detonation hits with no roll line, or the
   roll line fires but the char returns instantly (then the fight-hold owner is walking us back — send the log).
3. **No standing fights on carpets**: during essence/sbox/engage holds on shocked ground, expect
   `[Posture] standing in grd_Shocked01 -> stepping out` and a short step, casts continuing between steps.
   Broken = the line spams every ~1s without net movement (leash-boxed — see risks) or never appears while
   the char sits on a visible carpet.
4. **Reach-hold override**: opening an essence with beacons underfoot must NOT log `opener-reach hold` while
   `why=lethal:` risks are live — the dodge takes the frame.
5. **No over-dodge**: weather/breach attachments and Scatterers must produce zero hazards (no new red
   circles on ambient effects); traversal across empty shocked/ignited floors must NOT re-introduce
   roll-thrashing (the soft strip still applies to AVOID).
6. **[BlindGround] dumps become rare**: a dump firing now means a genuinely unknown class — paste it and it
   becomes one table line.

## Deviations from the brief (with why)
- **Radius floor "12" read as GRID units** (12u ≈ 130w): the hazard list stores world radii; 12 world ≈ 1.1u —
  smaller than any entity's own bounds and useless as a floor, while every other number in the brief (45u,
  15u, 7-8u) is grid. Beacons killed from 7-8u, so a 12u blast circle covers the observed kill range.
- **radiusMul values** (brief left them unstated): beacons 1.5 (blast out-reaches the model), all AVOID
  classes 1.0. The 130w floor dominates for small-bounds entities either way.
- **AVOID rolls**: grd_ carpets get the walk-out-only DoT handling (their names match the existing DoT/soft
  regexes — exactly "like a classified GroundEffect" per the brief); acidic_ground/quill/ice/puddle don't
  match those regexes and may roll like a Vortex. That's the existing machinery's split, not new logic.
- **Verdict-cache map-clear** rides `resetCatchallPromotions()` instead of a new export — mapper already
  calls it on map change, and the ids expire on the same per-map-instance boundary.
- **Part C sits inside `fightHoldPostureStep`**, i.e. behind `RANGED_POSTURE_ON` (on) and AFTER the
  live-channel / player-CC early returns. Mid-channel a carpet stand is tolerated for the channel's own
  ≤2.5s bound (user ruling: standing mid-channel IS the fight); a LETHAL pile still breaks it via the dodge
  core's hard risk, which is senior to the mapper.

## Risks / open questions
- **Bounds units on Renderable ground entities are unverified** (the rotated logs no longer hold the three
  dumps). The clamp (130w floor / 350w cap) bounds the damage a junk read can do in both directions, but if a
  carpet's bounds read tiny, its circle is floor-sized (12u) and the char could stand on the carpet's rim
  untriggered. If live shows rim-standing, raise the floor or the class's radiusMul — one line.
- **Leash-boxed step-out**: when a hazard swallows the whole content leash (essence ring fully carpeted),
  `_clampLeash` pulls the waypoint back inside the hazard — the step fires every 900ms without escaping. The
  dodge core's own egress is senior and unleashed, so the char still leaves on the dodge side; the posture log
  may repeat meanwhile. Accepted for now (the alternative — unleashed posture steps — breaks the essence-reach
  contract).
- **Beacon detonation timing is unmodeled**: the classifier treats a beacon as live from first sight to
  despawn. If beacons linger long after their real detonation, we'll over-avoid dead beacons; the dumps don't
  say. Live logs will (`why=lethal:` rolls with no damage anywhere near = linger).
