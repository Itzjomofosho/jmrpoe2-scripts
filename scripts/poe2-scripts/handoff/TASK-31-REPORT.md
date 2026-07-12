# TASK-31 REPORT — Utility value filter + HV-utility route-insertion + unique-engage 200u

Status: IMPLEMENTED (runtime-only, UNCOMMITTED). Awaiting user live-test.
File edited: `c:\Games\jmr-poe2\scripts\poe2-scripts\mapper.js` ONLY.
Pre-snapshot: `handoff\pre\TASK-31\mapper.js` (copied before any edit).
`node --check mapper.js` → PASS. All new symbols grepped → each declared once, no half-renames.

---

## Settings added (all default ON; flag off/absent = byte-parity to today)

| Const | Default | Part | What it flips |
|---|---|---|---|
| `UTILITY_OPENABLE_VALUE_ONLY` | `true` | A | Plain Chest/Urn (even magic-rarity) OUT of utility WALK selection; only strongboxes + league/special containers earn a walk. |
| `HV_UTIL_INSERT_ON` | `true` | B | HV openable (essence/shrine/strongbox) on the content/checkpoint route yields the walk to utility within route-insertion budget. |
| `HV_UTIL_INS_MAX` | `150` | B | Max route-insertion (detour cost, grid units) an HV openable may add to the committed walk. |
| `UNIQUE_ENGAGE_ON` | `true` | C | Non-boss UNIQUE-rarity monsters engaged out to `UNIQUE_ENGAGE_R` (rares keep `ROT_RARE_RANGE`=62). |
| `UNIQUE_ENGAGE_R` | `200` | C | Unique engage radius. |
| `LEAVE_CLOSES_UTILITY_ON` | `true` | D | After the leave verdict (`mapCompleteCleanupDone`), the map-complete utility window closes — no NEW claims. |
| `BREACH_LOOT_ANCHOR_ON` | `true` | E | Post-collapse 10s loot-stand anchors at the last-kill spot, not wherever the roam parked us. |

---

## Files touched — functions/symbols added or modified

**A — value-only openable selector** (`getOpenableUtilityCandidates`, the `t.type === 'Chest'` branch):
- New const `UTILITY_OPENABLE_VALUE_ONLY` (next to `LEAGUE_CHEST_RE`).
- The Chest admit test now: value-only → `isStrongbox || isLeagueChest`; flag off → `isMagicOrHigher || isLeagueChest` (today). A magic-rarity urn/chest no longer buys a walk. Normal-white filter is unchanged (opener still opens in passing ≤25-30u).

**B — HV-utility route-insertion** (new block after `gatherUtilityCandidates`, one call site before `arbTick`):
- Consts `HV_UTIL_INSERT_ON`, `HV_UTIL_INS_MAX`.
- `isHvUtilOpenable(c)` — value classes (Strongbox / Shrine / Essence-not-runerock).
- `hvUtilInsertionCost(player,ox,oy,dx,dy)` — extra route length via the openable toward the destination; NaN dest → pure leg.
- `hvUtilInsertTarget(player,now)` — nearest eligible HV openable within `HV_UTIL_INS_MAX`; dest = committed content (`arbCommittedKey`→`contentQueue`) else boss anchor; gated by `lootYieldSuppressed` (no mid-wave) + `abyssRequiredMidDrive` + `isUtilityTargetIgnored` (one yield/key). Rides `getOpenableUtilityCandidates`' cached feed — **no new entity scan**.
- `tryHvUtilInsert(player,now)` — the yield: guards mirror `tryStartUtilityNavigation`'s entry (state ∈ {FINDING_BOSS, WALKING_TO_BOSS_CHECKPOINT}, `canInterruptForUtility`, `MB.avail('utility',4)`, `mapStartHoldActive`, `utilitySessionGiveUpUntil`, no active target), logs `[Ckpt] yielding to hv-utility …`, then hands off to the EXISTING utility state via `startUtilityState` → `WALKING_TO_UTILITY` → `finishUtilityState` resumes the walk. Call site: `if (HV_UTIL_INSERT_ON && tryHvUtilInsert(player, now)) return;` immediately before the `arbTick` drive.

**C — unique-engage 200u** (`nearestRareToClear`, `runClearNearbyRares`):
- Consts `UNIQUE_ENGAGE_ON`, `UNIQUE_ENGAGE_R` (next to `ROT_RARE_RANGE`).
- `nearestRareToClear`: per-entity `cap` = `UNIQUE_ENGAGE_R` for a Unique subtype (flag on), else `ROT_RARE_RANGE`. Uniques already flow through this function and the map-boss exclusion (`isEntityLikelyMainObjectiveBoss`) is unchanged — only the radius widens for uniques. Reuses the existing 12s-owned engage cap + blacklist + rare-mode dodge (no new engage state machine).
- `runClearNearbyRares`: logs `[Engage] unique <name> at <d>u -> committing (unique ruling)` on a fresh commit to a unique beyond `ROT_RARE_RANGE`.

**D — leave-verdict closes utility** (`isMapCompleteUtilityWindow`):
- Const `LEAVE_CLOSES_UTILITY_ON`, one-shot log latch `_leaveUtilClosedLogged` (reset per map in `resetMapper`).
- When `currentState === MAP_COMPLETE && mapCompleteCleanupDone`, the window predicate returns `false` (blocks new claims; logs once `[Cleanup] leave verdict -> utility selection closed`). Scoped to `currentState === MAP_COMPLETE` so an in-flight `WALKING_TO_UTILITY` session still finishes (its window-close caller at `runUtilityNavigationStep` already gates on `!utilityActiveTarget`).

**E — breach loot anchor** (`runBreachRoam`, the `_bDwelt < 10000` stand-still):
- Const `BREACH_LOOT_ANCHOR_ON`.
- If the last-kill spot (`rotBreachLastMobPX/PY`, already tracked) is walkable and we drifted >15u off it, walk back to it; else `sendStopMovementLimited()` (today). Reuses the fight-end tracking the later loot-sweep already uses.

---

## LIVE-TEST CHECKLIST

**A — value-only openables**
- WORKING: on a full map, **zero** `Utility select: openable (Chest…)` / `(Urn…)` / `(Vase…)` lines all map. `Utility select: openable (…)` should only name shrines/strongboxes/essence-Monoliths/league chests.
- BROKEN: any `Utility select: openable (Chest)` or `(Urn)` line reappears → magic-container leak (check the admit test).

**B — HV-utility route-insertion (the headline fix)**
- WORKING: an essence Monolith / Resistance Shrine near a **pre-boss content walk** produces `[Ckpt] yielding to hv-utility <name> (ins=<N>u) -> resume after` **before** the boss dies, then a `Utility select: openable (…)` for it, then the content/boss walk resumes. No more "walked past the essence at ~100u going to incursion".
- WORKING: during an ACTIVE breach/abyss/verisium wave, **no** hv-utility yield (the runner keeps the frames) — the yield only appears on the walk between engagements.
- BROKEN: a yield log fires mid-wave (bot abandons a breach/abyss fight to open an essence) → `lootYieldSuppressed` gate regressed. Or repeated `[Ckpt] yielding to hv-utility <same key>` with no progress → dedupe/blacklist not catching (should be one yield per key).

**C — unique engage ≤200u**
- WORKING: a non-boss unique (rogue exile e.g. Taua the Ruthless) within 200u logs `[Engage] unique <name> at <d>u -> committing (unique ruling)` and the bot deviates to kill it. The MAP BOSS never logs this (still excluded).
- BROKEN: the map boss gets the `[Engage] unique` line (boss exclusion regressed), or the bot chases a unique >200u, or a unique 63-200u is still ignored (flag/ cap wrong).

**D — leave verdict actually leaves**
- WORKING: after `[Cleanup] … -> leaving anyway`, exactly one `[Cleanup] leave verdict -> utility selection closed`, then **no new** `Utility select:` lines, and the portal fires promptly (no 30s+ hang on a straggler urn).
- BROKEN: a new `Utility select:` claim appears after the leave verdict → the window is still re-opening.

**E — breach loot spot**
- WORKING: after `[Breach] cleared … -> stand still + collect loot 10s`, the bot stands/returns to where the fight ENDED (last drops), not the breach center. Status may briefly show `Breach: returning to loot spot`.
- BROKEN: the bot runs to the breach center to stand (drifts away from the drops) → anchor not applied.

---

## Design notes / deviations (review points)

1. **B reuses the utility yield machinery, not the literal `[Ckpt]` block.** The brief said "ride the EXISTING [Ckpt]/route-gate yield machinery … do NOT build a parallel mechanism." The literal `[Ckpt]` content-yield block lives inside `case WALKING_TO_BOSS_CHECKPOINT` and only runs when `arbTick` returns FALSE — so it **cannot** cover the headline case (a **content walk**, where `arbTick` drives content and returns true, bypassing the whole utility path before line ~13878). The only correct interjection point for the content-walk case is right before the `arbTick` drive. My `tryHvUtilInsert` sits there and funnels into the ONE existing detour system (`startUtilityState`/`finishUtilityState`/`utilityResumeState` + the route-insertion concept from `classifyObjective`) — it is **not** a second detour/hold/resume state machine, and it does **not** change the OB/MB ladder (utility stays pri 5; it works "above" content via a yield, exactly like the `[Ckpt]`/verisium far-walk yields). The log is `[Ckpt] yielding to hv-utility …` as specified. If the reviewer intended a different mechanical seam, this is the spot to redirect.

2. **B is not ARBITER-gated** (matches the un-gated `exp2FarWalkYield` precedent + the utility system itself). ARBITER is live, so this is moot in practice; flag-off (`HV_UTIL_INSERT_ON=false`) is a hard no-op regardless.

3. **B supersedes the older `_hvRaw` ≤120u side-step** for FINDING_BOSS/CHECKPOINT (it fires first, and is a superset: shrines + 150u route-insertion). The `_hvRaw` path is left untouched (flag-off parity for it; still a fallback for melee-approach, which `tryHvUtilInsert` deliberately does not cover). Both funnel to `startUtilityState` and dedupe via `utilityActiveTarget` + the blacklist, so no double-drive.

4. **C flag-off:** `bestD` seed changed `ROT_RARE_RANGE → Infinity` unconditionally, with a per-entity `cap`. When `UNIQUE_ENGAGE_ON=false`, `cap===ROT_RARE_RANGE` and the loop returns the identical `best` (same entity, same `._d`) as today — behavior-neutral (only the un-observable local `bestD` seed differs).

5. **E** anchors to `rotBreachLastMobPX/PY` = player pos at last mob seen (already tracked, already the loot-sweep's fallback anchor). Only applied when that cell is walkable; else unchanged.

## Open questions
- None blocking. B's mechanical seam (note 1) is the one place worth a reviewer glance before the parity walk.
