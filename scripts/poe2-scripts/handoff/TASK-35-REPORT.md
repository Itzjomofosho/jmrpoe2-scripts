# TASK-35 REPORT — GENERIC ranged combat posture (2026-07-12)

Pre-snapshot: `handoff\pre\TASK-35\` (mapper.js, rotation_builder.js, auto_dodge_core.js).
`node --check` passes on all three edited files. Symbol grep clean (no `_po*` / `CHANNEL_THREAT*` /
`RANGED_*` collisions with pre-existing code; the only pre-existing `_po` symbols are `_portal*`).

## Files touched + symbols

### mapper.js
- **NEW block "TASK-35 — RANGED COMBAT POSTURE (A/B/C)"** (placed just above `runClearNearbyRares`):
  - `combatWalkHold(player, tx, ty, d, key, name)` — A. True = stop the combat walk: target ≤55u with
    line-of-fire (`lineWalkable`, throttled 250ms per target key), or ≤26u regardless of LoF
    (`RANGED_MELEE_FLOOR_U` — entity_actions casts need no LoF inside 28u, so stopping there always fights).
    LoF blocked → keeps approaching until the line opens. Logs `[Posture] holding 55u vs <name>` once per
    committed target.
  - `fightHoldPostureStep(player, now, ax, ay, leash, tag)` — B+C, one call per fight-holding frame; true =
    a posture step took the frame's movement (caller skips its plant/stop). Honors the exceptions in order:
    live channel (bounded `POE2Cache.channelHoldActive/Until` read) → no step, no idle clock; player
    hard-CC → no movement, no clocks, throttled `player CC'd` line. Steps go through `moveTowardGridPos`
    (MB-gated + dodge-suppression-gated), so dodge p1 stays senior.
  - `_postureThreatScan` — 300ms-throttled pass over `POE2Cache.getSharedEntities()` (the per-frame list
    auto-attack already builds in combat; no new native scan): nearest un-CC'd presser ≤30u + nearest
    hostile ≤70u.
  - `_poHardCCd(m)` — `getCatchallCcVerdict` (dodge-core cache) when fresh, else the buffs already on the
    shared-list entity. `_playerHardCCd(player, now)` — 250ms-cached player frozen/electrocuted read.
  - Committed-step machinery (`_poStepWpX/Y`, `_poStepUntil`): a fired back-step/nudge is re-steered for
    ~650ms then expires (rate limit 900ms between new steps). See "deviations" — a single heading pulse
    would be truncated to one frame by the caller's next-frame stop.
- **Call sites wired** (each: A-hold and/or B/C step, flag-off = byte-identical):
  - `runClearNearbyRares` — rare/unique engage: holds at the ring instead of walking onto the target;
    status shows `Engage <sub> (<d>u, holding)`.
  - abyss clear-phase close chase (`runAbyssRun`) — the ≤55u dead-reckon leg now holds at the ring;
    posture leash **60u to the committed node** (wave progress needs presence).
  - elite walk (STRATEGY-5) — hold at the ring once LoF exists instead of closing to 24u; posture step runs
    before the pre-existing pack step-out (which is preserved as fallback).
  - breach standoff hold (`runBreachRoam` ≤55u branch) — B/C only, leash `ROT_BREACH_MOB_R` (230u ring).
  - verisium wave stand (`exp2` fighting phase) — B/C only, leash 60u to the stone (completion flip needs
    proximity).
  - strongbox event hold plant (`sboxEventHoldStep`) — B/C, leash **50u** so a step can never trip the 60u
    displaced-abandon.
  - essence-fight ring plant (TASK-34 `essenceFightStep`) — B/C, leash **75u** to the crystal (inside the
    TASK-34 drift-back band at standoff+25=82u, so the two never fight).

### rotation_builder.js (D)
- `_channelThreatNear()` + consts — reads the bus (`POE2Cache.channelThreatD/channelThreatAt`), fresh <250ms,
  threat ≤ `CHANNEL_THREAT_R` 35u.
- `channelArbiterTick` — new release branch after perfect-window, before timeout: armed + elapsed>300ms +
  fresh threat ≤35u → `sendStopAction()` (armed + pre-timeout = genuinely mid-channel, same reasoning as the
  perfect-window stop) + `[Rotation] Channel released: <skill> (threat at <d>u)`.
- `executeRotation` skill loop — arm-guard right after the cooldown skip: a `channelUntilBuff` skill is
  skipped (`continue`) when the bus reads a threat ≤35u, so the priority loop falls through to filler this
  tick. Skipped BEFORE the throttle claim (no cast-interval burn).

### auto_dodge_core.js (D publish)
- Enemy record in `collectHazardsAndEnemies` gains `id` (inert for all existing readers).
- `runAutoDodge` — after the enemies list is in hand: publish `POE2Cache.channelThreatD` = nearest UN-CC'd
  hostile distance (grid units) + `channelThreatAt = now`, per scan pass. Nearest-first with `_ownerHardCCd`
  (the cached CC verdicts) probed only inside `CHANNEL_THREAT_PROBE_U` 50u — beyond that a hostile can't flip
  the reader's ≤35u verdict, so it's taken as-is. Id-less entries count as threats (conservative).
  No un-CC'd hostile in list → publishes `Infinity`.

## Settings added (all consts, per brief — the flags ARE the ranged/melee profile switch for now)
| Const | File | Default | Effect when flipped off |
|---|---|---|---|
| `RANGED_POSTURE_ON` | mapper.js | `true` | every A/B/C call site byte-identical to today (drive to the cell / plant) |
| `RANGED_ENGAGE_STOP_U` / `RANGED_BACKOUT_U` / `RANGED_BACKOUT_STEP_MS` / `RANGED_MELEE_FLOOR_U` / `RANGED_IDLE_GAP_MS` / `RANGED_IDLE_HOSTILE_R` | mapper.js | 55 / 30 / 900 / 26 / 1500 / 70 | tunables |
| `CHANNEL_THREAT_INTERRUPT_ON` | rotation_builder.js | `true` | interrupt + arm-guard dead (byte-parity) |
| `CHANNEL_THREAT_R` / `CHANNEL_THREAT_FRESH_MS` | rotation_builder.js | 35 / 250 | tunables |
| `CHANNEL_THREAT_INTERRUPT_ON` | auto_dodge_core.js | `true` | bus never published (byte-parity) |
| `CHANNEL_THREAT_PROBE_U` | auto_dodge_core.js | 50 | CC-probe band |

Melee profile = `RANGED_POSTURE_ON=false` (mapper) + `CHANNEL_THREAT_INTERRUPT_ON=false` (both files) →
byte-parity with today everywhere.

## Per-content constraints (verified)
- **ABYSS**: back-out/nudge leashed to 60u of the committed node (`abyssNodeX/Y`). The A-hold only stops
  earlier on the chase leg — it never moves us away from the node.
- **BREACH**: NO change to the chase legs — the pre-existing code already ends each leg at 55u
  (`mob.dp > 55` routes, else stop) and already has the N-mob swarm standoff; blacklist clocks, closest-D
  tracking, wedge detection untouched. Only the ≤55u standing hold gained B/C.
- **STONE CIRCLE / consume walks**: untouched (walks to rocks/objects are not combat walks).
- **VAAL BEACON**: deliberately NOT wired — pre-existing user ruling in code: the centre must be held for
  proximity-energise ("NO swarm stand-off here"). **HIVE defense**: already kites (never plants) — untouched.
- **Verisium**: the wave chase already stepped in only beyond 72u (outside the 55u ring) — left unchanged;
  only the stand branch gained B/C.
- **Boss fights**: untouched — 32B standoff/kite-floor machinery not modified; the posture helpers are only
  called from the non-boss holds listed above.

## LIVE-TEST CHECKLIST
Watch for (all `[Mapper]`-prefixed except `[Rotation]`):
1. `[Posture] holding 55u vs <name> (<d>u)` — once per engage target; the char visibly stops ~55u out on
   rare/unique/elite/abyss-mob walks and casts from there. **Broken**: still walks into melee contact on an
   engage, or the line spams (>1 per target).
2. `[Posture] back-out: hostile at <d>u (<tag>) -> step to 55u ring` — a mob closing inside 30u produces a
   visible back-step (~0.65s hop) while casts continue between steps. **Broken**: no step while being
   face-tanked, or constant scurrying (rate limit failed), or stepping away from FROZEN mobs (CC filter
   failed — frozen at 20u must be sniped, not fled).
3. `[Posture] cast-gap <s>s: <reason> -- <name> <d>u (<tag>)` with reason ∈ `no-target-selected` /
   `not-targetable` / `banned(hp-frozen)` / `LoF-blocked` — any >1.5s standing beat in a fight-hold names its
   gate, then the char nudges toward the hostile's ring. **Broken**: silent standing mid-fight (the exact
   TASK-35 C complaint), or the line fires while the char is actually casting.
4. `[Posture] cast-gap: player CC'd (<tag>)` while frozen — and NO movement packet on unfreeze-yank.
5. `[Rotation] Channel released: <skill> (threat at <d>u)` — a melee closing to ≤35u mid-Snipe releases the
   channel early (partial-stage shot) instead of face-tanking. **Broken**: channels releasing constantly at
   range (bus too hot → check CC filtering / raise nothing before reporting), or never releasing with a mob
   in your face.
6. Arm-guard is silent by design: observable as filler casts (not Snipe) while something is inside 35u.
7. Essence: open → `[Essence] opened -> falling back to bow range` (TASK-34) → straight into the guard fight,
   no standing beat; a guard chasing to <30u triggers a back-step that never leaves the crystal >75u.
8. Breach clear rate unaffected; abyss nodes still progress; boss fights unchanged.

## Risks / deviations from the brief
1. **Committed-step window (650ms) instead of a literal single step**: heading movement needs per-tick
   re-sends and the hold branches send a (300ms-throttled) stop the very next frame — a one-pulse step would
   move ~one frame's distance. The fired step is re-steered to the SAME waypoint for ≤650ms (arrival/expiry/
   dodge ends it), then the 900ms rate limit spaces the next. No new movement mechanism — it reuses
   `pickRadialRetreatWaypoint` + `moveTowardGridPos` exactly like the swarm-standoff callers re-steer.
2. **A at the "shared choke"**: there is no combat-only shared choke — `moveTowardGridPos` carries ALL mapper
   movement (loot sweeps, center walks, delirium push), so clamping inside it would break non-combat walks.
   Implemented as the brief's fallback: `combatWalkHold` applied at each combat call site (rare engage,
   abyss close-chase, elite walk); breach/verisium already stopped at ≥55u pre-task.
3. **C's "rotation has no eligible target"** is inferred mapper-side from the player's action read
   (`hasActiveAction` + action name not move/walk/run/idle), since entity_actions may not be modified (hard
   limit). Reason naming is also mapper-side: `banned(hp-frozen)` matches only `POE2Cache.rotationBan` (the
   LAST published ban) — under-reports on multi-banned packs; `LoF-blocked` uses `lineWalkable` (walkability
   raycast, the mapper's LoF idiom — elevation gaps read as blocked, same as the boss-flow probe).
4. **Utility fight-through (pre-open essence/strongbox walk) not clamped**: that walk targets the OBJECT
   (must reach it to open) — not a walk at a hostile. Survival there is owned by TASK-34's opener plant-hold
   + panic egress. The post-open guard fights ARE covered (essence ring, strongbox event hold).
5. **D bus freshness = dodge-core scanning**: the bus is only fresh while `runAutoDodge` passes run (dodge
   mode boss/rare, scan gates 100/160ms). In a pure white-trash fight with dodge mode 'off' the bus is stale
   → no interrupt/arm-guard (fails safe: channel behaves exactly as today).
6. **D bus counts `cannotBeDamaged` hostiles** (the dodge enemies-list threat definition — no such filter
   there). An imprisoned essence rare could read as a threat, but every essence flow stands ≥36u (plant) /
   ~57u (standoff) from the crystal, outside the 35u radius.
7. **Breach cadence interaction to watch**: a back-out while a chased mob presses extends the time-to-kill of
   that mob; its 5s unreachable-clock keeps running on our owned frames. A tanky presser could get
   blacklisted alive (8s) mid-back-out. Not observed logic-side (a ≤30u presser is in full rotation range);
   flagging for the live test.
8. **Threat-scan cost**: `_postureThreatScan` iterates the shared per-frame list 1/300ms only on fight-hold
   frames; CC probes are verdict-cache-first, buffs-in-hand fallback. `combatWalkHold`'s LoF raycast is
   250ms-throttled per target; the cast-gap reason raycast 400ms-throttled. No new native scan patterns.

## Open questions
- Should the FINDING_BOSS "SEE MOBS -> GO TO THEM" explore-walk (below the elite branch) also A-clamp? It is
  a walk toward visible hostiles, but it's an explore-continuation, so I read it as "mid-runner-walk to
  elsewhere" and left it. Cheap to add if the live test shows melee contact there.
- If live tests show melee-inbound channel deaths during dodge-off trash fights (risk 5), the bus publish
  could gain a mapper-side fallback publisher — separate task.
