# TASK-05 — Objective Broker ON: owned-ms bans + freeze swap + anchor walk-back (roadmap steps 7+8)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-05\`. File: `..\mapper.js` only.
Read: HOUSE_RULES; this brief; MAPPER_ROADMAP.md steps "### 7." and "### 8.", the "### Objective Broker" design
section, and EVERY "OB vs …" Conflicts bullet; TASK-04-REPORT.md (the shadow you are promoting).

## Planner adjudications to apply FIRST (they change the shadow you inherit)
1. `OB_STACK_MAX` 2 → **1** (roadmap Rejected wins over the TASK-04 brief). A claim against a holder whose stack
   is occupied logs `deny (depth)` — and under the flag it actually defers.
2. **Delete `OB.regTimer`/`timerReg` entirely** (roadmap Rejected: one-consumer indirection). `freezeTick` under
   the flag advances the timer anchors DIRECTLY — the same explicit `if (x) x += dt;` shape as the existing
   opener/pickit delta-advance list, over the set the shadow registered: `deliriumTargetStart`, `rotRareStart`,
   `incursionCurStartAt`, `abyssDwell`, `abyssLootDwellAt`, `arbCommittedSince`. Keep the shadow's would-freeze
   logging shape.
3. The dual `shadow-deny` + `pause` emission stays for flag-OFF; under the flag a deny means the preemptor is
   ACTUALLY deferred, so only the deny line fires (there is nothing to pause).

## Flag contract (the acceptance bar)
`currentSettings.objBroker === true` gates EVERY behavior in this task. Flag off/absent = TASK-04's shadow,
byte-parity — both code paths retained (`if (obOn()) { new } else { legacy }`), the legacy delta-advance list and
`arbFrozeAt` block live in the else. Add the UI checkbox ("Objective broker (one goal at a time)") beside the
other toggles — TASK-04 deliberately deferred it to this task.

## What ships under the flag
### (a) Denial DEFERS (the ladder becomes real)
The instrumented preemptors ask BEFORE running: at the pre-switch chain call sites (rare) and the utility
selector (`startUtilityState` path), a denied `OB.claim` means the caller SKIPS this frame — rare-clear does not
run against a committed required objective (the intended, tested-on-its-own inversion: required(2) > rare(3)),
and the utility detour defers exactly as the existing `_reqCommitted` gate does today (fold that gate into the
OB denial when the flag is on; it remains authoritative when off). Mirror (rank 1) is NEVER denied — assert it:
a mirror deny logs `[OB] BUG mirror-denied` loudly.
Denial = defer-this-frame only: no bans, no state, the caller retries next frame (commitment discipline).

### (b) Owned-ms bans (stolen time never burns a budget)
Convert these progress-budget clocks to fire on `rec.ownedMs` (the shadow already accumulates it via
`trackOwnedProgress`): rare-clear 12s (`ROT_RARE_TIMEOUT` at `rotRareStart`), the delirium runner's 15s reach
budget (`rotDeliriumStart`), and the arbiter commit TTL (`arbCommittedTtl` via `arbCommittedSince`). GAME-REAL
windows stay wall-clock (ABYSS_MIN_LOOT_MS, chest-settle, strongbox event, beacon hold) — they measure the game,
not our effort. The mirror handler's own progress-aware cap (deliriumBestD re-arm) already exists — leave it.
CONFLICT RULE (roadmap): `rotRareStart` is never frozen while rare-clear is itself the ACTIVE preemptor — its
12s cap must still bound the engage.

### (c) Freeze swap (strictly either/or)
Under the flag `OB.freezeTick` (direct advances, adjudication 2) REPLACES the legacy opener/pickit delta-advance
list AND the `arbFrozeAt` block — old code runs ONLY in the else branch. Both live = every window advances twice
and never expires (roadmap conflict; this is the #1 thing the reviewer will check).

### (d) Anchor walk-back (step 8 — abyss/beacon/hive ONLY)
The abyss quiet-reset branch (search the `_ndD > 130` clear of `abyssId`/`abyssDwell`): when OB holds that
commitment and the displacement came from dodge-owned frames, issue a walk-back to `abyssNodeX/Y` at MB content
prio 3 instead of clearing — bounded by owned no-progress (the normal ban path). Same anchor-return contract for
the beacon and hive dwell anchors. Mirror and rare get NO walk-back (they re-acquire by key/id). The boss-state
escape hatch in that branch still bypasses the walk-back.

### (e) Abyss grace-finish (live-proven 2026-07-10, MapHive — NOT flag-gated: this is a correctness fix)
The abyss chest NEVER SPAWNS if the player leaves mid-wave (live: bit flipped at 21:12:01 mid-node, arbiter
released + claimed the breach the same second, sweep returned 649u later to `node=done chest=no`). Fix at both
gates TASK-08 identified: while the runner is MID-NODE (`abyssId !== 0` with its dwell/clear state live),
(1) `arbTerminated` must NOT terminate the abyss commitment on `objectiveTypeComplete` alone, and (2) the
runner's caller gates on `objectiveTypeComplete('abyss')` must stay OPEN until the current node's dwell+loot
completes (the runner's own 45s/dwell caps bound it). The sweep stays for genuinely orphaned sites.

### (f) Map-start hold must also gate the utility selector (live-proven same map)
`[MapStart] content ready (42 entries) after 44595ms` — the 4s hold never engaged because
`tryStartUtilityNavigation` stole frame 1 (a strongbox detour at +200ms) and the FINDING_BOSS gate only ran 44s
later. Make the map-start content hold visible to the utility selector: while the hold is active (same condition
the FINDING_BOSS gate uses), `tryStartUtilityNavigation` returns false. Tiny; the hold stays bounded at 4s.

## Hard limits
- Strict-finish gates, MAP_COMPLETE cleanup ownership, MB, arena shell, TASK-07/08/09 changes: untouched.
- No new entity scans; everything runs on state already in hand.
- Line numbers in the roadmap are stale — locate by symbol.

## Acceptance
- `node --check mapper.js`. Flag OFF: byte-parity with the accepted shadow (same [OB] lines, same behavior).
- Report per HOUSE_RULES + a flag-ON live-test checklist: rare near required content DEFERS (walk continues,
  `[OB] deny rare:… vs content:…`), the deferred rare still dies via entity_actions en route; a mirror walk is
  never denied; an opener vacuum mid-abyss-dwell resumes the dwell intact (single advance — watch for
  double-advance symptoms: windows that never expire); a dodge shove off an abyss node walks BACK
  (`[OB] walk-back content:abyss:…`) and the chest gets looted; the previously-logged `would-ban-suppressed`
  class now manifests as the ban NOT firing.
