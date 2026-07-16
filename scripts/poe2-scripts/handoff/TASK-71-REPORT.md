# TASK-71 REPORT — Global survival HP-yield + posture retreat from fast melee

Status: IMPLEMENTED in the runtime tree. `node --check mapper.js` = SYNTAX-OK. NOT committed (test-before-commit).
Pre-snapshot: `handoff\pre\TASK-71\mapper.js` (taken before any edit).

## Files touched
- `mapper.js` ONLY. (rotation_builder.js / pickit.js / auto_dodge_core.js untouched — the brief's per-runner
  backstops were left exactly as they are.)

## Symbols added / modified (grep-able)

### FIX #1 — global survival HP-yield
- `SURVIVAL_YIELD_ON` (const, **true**) + `SURVIVAL_YIELD_HP` (const, **0.45**) + `let _survivalYieldLogAt` +
  `function survivalYieldActive(player, now)` — all defined immediately ABOVE `function processMapper()`
  (~L16422-16446). Helper yields only when HP frac < 0.45 AND survival is actively moving us
  (`now < dodgeMoveSuppressUntil` OR `autoDodgeStatus().walkEgress` OR MB hold owner `dodge` within `MB.WINDOW`)
  — the same three signals the mapper already trusts at the dodge block and the commitClickSafe block.
- Guard inserted in `processMapper` (~L16794-16807): AFTER the `runAutoDodge`/walk-egress re-send block and the
  `commitClickSafe` publish, BEFORE the `moveLock` enforcement block and everything below it (beacon dwell, sbox
  hold, logic throttle, state machine, `arbTick` dispatch). On a yield frame it logs `[Survival] HP-yield ...`
  (3s throttle), sets `statusMessage = SURVIVING (hp NN%)`, stamps `lastPositionChangeTime` (stuck-watchdog
  suppression, same idiom as the moveLock yield), and `return`s — the frame ends with only the dodge having acted.

### FIX #2 — posture retreat from fast melee (Rare/Unique tier)
- `POSTURE_ELITE_RETREAT_ON` (const, **true**) + `RANGED_PRESS_ELITE_U` (const, **40**) — added under
  `POSTURE_PRESS_MAGIC_PLUS` in the posture constants block (~L2652-2653).
- `_postureThreatScan` (~L2739-2741): presser tier captured — `_tier` = Unique→3, Rare→2, else 1 (forced 1 when
  flag off); `_tierBoU` = tier>=2 ? (`_hpFrac<0.75` ? `RANGED_ENGAGE_STOP_U`(55) : `RANGED_PRESS_ELITE_U`(40))
  : `_boU` (unchanged Magic path: 20 healthy / 42 hurt). `_poPress` now carries `tier`.
- Back-out section B in `fightHoldPostureStep` (~L2844-2845): `_eliteRetreat` = presser tier>=2; the
  `RANGED_BACKOUT_STEP_MS`(900ms) rate-limit is BYPASSED for an elite presser — a NEW back-out can start the
  moment the prior committed step ends (the existing 650ms `_poStepUntil` re-steer still owns in-flight steps, so
  there is no per-frame waypoint recompute; the packet cadence is the re-steer's, unchanged). Body unchanged.
- The optional stretch ("can't-kite-it disengage") was PARKED per the brief's own guidance — see Risks.

## Settings added
| Setting | Default | Effect when flipped false |
|---|---|---|
| `SURVIVAL_YIELD_ON` | true | helper returns false on its first line → guard never taken → byte-identical frame flow |
| `SURVIVAL_YIELD_HP` | 0.45 | (tunable threshold, not a flag) |
| `POSTURE_ELITE_RETREAT_ON` | true | `_tier` collapses to 1 for every presser → `_tierBoU === _boU` (old selection exactly) and `_eliteRetreat` false → section B gate reduces to the original 900ms condition |
| `RANGED_PRESS_ELITE_U` | 40 | (tunable elite back-out floor at healthy HP) |

Flag-off parity verified by inspection of every touched site: with both flags false the only residue is unused
consts, one unused `let`, one never-true helper, and a `tier` field on `_poPress` that no other reader consumes
(`_poPress` grep: all consumers are inside `fightHoldPostureStep` + the reset at ~L14326 which nulls it).

## LIVE-TEST CHECKLIST (what the user watches)
1. **Fast elite (the Scuttler case)**: vs a Rare/Unique melee sitting ~29-40u at healthy HP, expect
   `[Posture] back-out: hostile at NNu (...) -> step to 55u ring` firing REPEATEDLY (3s log throttle, but the
   character visibly keeps stepping away and kiting). BROKEN (old) looked like `[Posture] holding 55u vs X (29u)`
   with the char standing while being hit.
2. **HP crater**: when HP drops <45% mid-fight with a dodge/egress live, expect
   `[Survival] HP-yield NN% -> content/nav/boss stand down, dodge/egress owns movement` and the char walking OUT
   under the egress (status line shows `SURVIVING (hp NN%)`), then resuming content when HP recovers/egress ends.
   Neither fix ever exits the map.
3. **No regression / happy path**: healthy maps with no elite in melee show NEITHER line. Whites are still pushed
   into (never press); Magic keeps the tight 20u floor and the 900ms-stepped back-out.
4. **Backstops intact**: pickit `DEATH-OVER-LOOT` (hp<55%), verisium `loot dwell YIELDS to survival` (hp<60%,
   freezes loot clocks), breach `[Breach] survival yield` (hp<45%) — all untouched and still expected to fire in
   their own states; no competing movement (all of them stand down rather than send).

## Risks / deviations from the brief
- **Deviation (tiny, hardening)**: `survivalYieldActive` additionally requires `Number.isFinite(player.healthCurrent)`
  (the brief's version would treat a NaN health read as "below threshold"). This matches the file's own idiom at
  `_postureThreatScan` (`_hpFrac` guards the same way) and can only make the gate MORE conservative (no yield on a
  garbage read).
- **Parked**: the optional "can't-kite-it" disengage (elite inside `RANGED_MELEE_FLOOR_U` >4s of retreating). Brief
  says park if it risks the happy path — it needs new gain-distance state and risks re-introducing stand-and-trade
  vs elites, and at a real crater fix #1 takes over anyway. Recommend deciding after live data on the continuous
  retreat.
- **Known interaction (pre-existing, unchanged)**: TASK-53 A reach-yield still holds AGAINST a presser that lies in
  the approach direction of a content reach leg — including an elite one. So an elite directly on the approach line
  is pushed into, not kited, until the leg ends. The dodge + fix #1 cover an HP crater there. Flagging for the
  planner rather than changing TASK-53 semantics unasked.
- **Known interaction (accepted by the brief's design)**: the #1 guard sits ABOVE the moveLock yield, so on a
  locked (opener/pickit) frame that is also a survival frame, the moveLock bookkeeping (collect-timer freezes /
  `OB.freezeTick` / `utilityLastServicedAt`) is skipped for those frames — dwell windows and commit TTLs consume
  during a survival episode. The brief explicitly bounds recovery "by the existing commit TTLs", and the
  `_lockTickAt` delta guard (`<1000ms` else 0) prevents any timer jump when servicing resumes. Note pickit already
  stands down at hp<55% before this gate can trip at 45%, so the overlap window is narrow.
- **Egress-liveness breadth**: `now < dodgeMoveSuppressUntil` counts roll-suppression (520ms) as "survival is
  moving us", not just walk-egress. That is the brief's own signal choice; worst case the yield extends ~0.5s past
  a roll at <45% HP, which is the intended "let survival finish" behavior.

## Open questions
- None blocking. `SURVIVAL_YIELD_HP` (0.45) and `RANGED_PRESS_ELITE_U` (40) are planner-tunable if live data says
  the floor is too eager/too shy.
