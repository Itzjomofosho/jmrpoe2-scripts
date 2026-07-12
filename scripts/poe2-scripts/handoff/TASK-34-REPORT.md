# TASK-34 REPORT — Essence survival bundle

Pre-snapshot: `handoff\pre\TASK-34\` (mapper.js, auto_dodge_core.js, opener.js, **pickit.js** — see Deviations).
`node --check` PASS: mapper.js, auto_dodge_core.js, pickit.js. opener.js **not edited** (see A).

## Files touched + symbols

### mapper.js
- **A — plant-hold re-keyed to the opener's real click band**
  - `REACH_HOLD_PLANT_R` 15 → **36**, `REACH_HOLD_COMMIT_R` 25 → **36** (consts near `REACH_HOLD_PLANT_SCOPE`, ~line 561).
  - NEW `_reachOpenerLockAt` — stamped inside the reach-hold publish site whenever `moveLock.source === 'opener'`.
  - Plant branch (search `REACH_HOLD_PLANT_SCOPE)` in the dodge publish block, ~13980): plant now additionally requires
    `_openerBusy` = `lastEssenceOpen` fresh (<2.5s, `REACH_HOLD_COMMIT_MS`) **OR** opener move-lock seen <2.5s ago.
    Commit branch unchanged except the 36u radius. Flag-off else-branch (legacy 90/60u) untouched.
  - **Opener-active signal chosen: reused `POE2Cache.lastEssenceOpen` (stamped by opener.js on every essence click)
    plus the opener movement lock. The bus lacked nothing → opener.js NOT edited.**
- **B — essence fight posture**
  - Consts `ESSENCE_FIGHT_STANDOFF_ON=true`, `ESSENCE_FIGHT_HOSTILE_R=70`, `ESSENCE_FIGHT_STANDOFF_R=57`,
    `ESSENCE_FIGHT_CLEAR_R=60`, `ESSENCE_FIGHT_LOOT_HOLD_R=40`; state `essFightKey/essFightPhase/essFightLootAt/essFightChk*`/`essFightN60/N70`.
  - NEW `essenceGuardProbe(cx, cy, now, key)` — hostiles around the **crystal** (lightweight Monster scan, maxDistance 140,
    500ms throttle, only while the posture runs). NEW `essenceFightStep(player, now)` — the posture (both directly above
    `runUtilityNavigationStep`).
  - Hook: the `utilityOpenableConsumed` branch calls `essenceFightStep` first (essences only); posture true = session held.
  - Posture reuses: `hiveKiteTarget` (back out to the 57u ring; plants on the ring; drifts back if shoved >82u),
    the **shared `_utFrz*` 20s fight-through freeze** (same accumulator + key → pre-open fight-through and post-open posture
    share ONE 20s cap per target; session clocks frozen the same way), and `sweepLootStep` (15s-bounded post-clear sweep
    anchored at the crystal, radius 60). Cap exhausted or swept → falls through to today's consumed-finish exactly.
  - `resetMapper`: clears `essFight*` + zeroes the loot-hold bus.
- **Bus fields published (one-way, mapper → pickit)**: `POE2Cache.lootHoldX`, `POE2Cache.lootHoldY`,
  `POE2Cache.lootHoldR` (=40), `POE2Cache.lootHoldUntil` (rolling `now+1200`, renewed each posture pass —
  auto-expires ≤1.2s after anything kills the posture; explicitly zeroed on loot-phase entry, cap-exhaust, and resetMapper).

### pickit.js  (DEVIATION — see below)
- `processAutoPickup`: `_lootHold` read once per scan; item loop skips any item within `lootHoldR` of
  (`lootHoldX`,`lootHoldY`) while `lootHoldUntil > now`. Skipped items burn **no** pickup attempts. Bus absent/expired
  = gate never fires (byte-parity).

### auto_dodge_core.js
- **C — PANIC egress**: consts `PANIC_EGRESS_ON=true`, `PANIC_DROP_PCT=25`, `PANIC_WINDOW_MS=2000`, `PANIC_HOLD_MS=1500`;
  state `_panicUntil`. NEW `_tryPanicEgress(player, now)` (right after `_tryBlindEgress`) — reads the TASK-33
  `_blindHpHist` ring (narrower 2s window), heads via `chooseBlindEgressHeading` away from `_blindKillZone`, drives the
  shared `walkEgress` + `_eg*` progress watchdog (rotate on wedge, 14s stand-down).
- Call site in `runAutoDodge` sits AFTER hazard collection/kill-zone update and BEFORE `atRisk`/all holds → overrides
  the channel-hold, interact-lock hold, reach-hold, and rolls-in-place, regardless of the hazard list. The
  `'already dodging'` bail still runs first → a roll in flight is never cancelled (frame taken next scan, per brief).
- Sampling gates widened to `(BLIND_EGRESS_ON || PANIC_EGRESS_ON)` (ring + kill-zone) — identical when both off.

## Settings / flags
| Flag | Default | Effect when off |
|---|---|---|
| `REACH_HOLD_PLANT_SCOPE` (existing) | true | legacy 90/60u reach-hold (pre-32B), unchanged |
| `ESSENCE_FIGHT_STANDOFF_ON` | true | consumed essence finishes immediately (today's flow) |
| `PANIC_EGRESS_ON` | true | no panic override; TASK-33 blind egress only |
All are consts (house pattern), no UI settings added.

## LIVE-TEST CHECKLIST
1. **A (essence open, guards imprisoned):** during the click sequence (`[Opener] Opened Essence: ... Dist: 27-35`),
   **ZERO** `[AutoDodge] ROLL ... why=boss_telegraph:BossOpener` lines between clicks. Broken = the 32B death pattern:
   ROLL lines interleaving `Opened Essence` at 27-35u, 4+ click attempts.
2. **A (32B walk-in scoping still holds):** approaching an essence through bad ground from >36u, the dodge still rolls
   (no 90u face-tank). Watch: rolls during the approach, hold only once clicks start landing.
3. **B (posture):** the moment the essence reads consumed with guards up:
   `[Essence] opened -> falling back to bow range (N hostiles)` → char walks OUT to ~57u of the crystal and fights from
   there (status `Essence fight: N guard(s), standoff XXu`), **no pickit line** for drops near the crystal meanwhile.
   Then `[Essence] guards dead -> looting` → loot sweep/pickit collect. Broken = char stays at ~24u in the spawn, or
   `[Pickit] Picking up:` for the essence drop while guards live.
4. **B (bounds):** if guards outlast the shared 20s freeze: `[Essence] guards persist past the 20s cap -> session ends
   as today` and the map continues (no wedge at the crystal).
5. **C (any burst-drain fight):** `[AutoDodge] PANIC egress: hp -NN% in 2s -> leaving the fight` followed by an
   immediate committed walk-out (movement within the same second, MB dodge p1). Broken = the line prints but the char
   stays planted, or no line during a >25%-in-2s drain while hazards are visible.

## Risks / deviations
- **DEVIATION (file list): pickit.js edited.** The brief's hard-limits list omits it, but B explicitly requires
  "pickit consumes it" for the loot-hold bus and pickit had no existing bus consumer. The edit is 2 lines, read-only on
  the bus, parity when unpublished. Pre-snapshot taken before editing. If rejected, reverting only pickit.js leaves the
  rest functional (drops would just be pickit-grabbed mid-fight from ≤ its pickup range again).
- A's opener-active signal is NOT target-specific: any opener move-lock within 2.5s arms `_openerBusy` (the brief's own
  definition). A nearby unrelated chest open could arm the plant window for ≤2.5s while within 36u of the committed
  openable — considered harmless (the hold still only bites while at-risk and healthy).
- B guard probe fail-open: a throw inside the 500ms probe zeroes the counts → posture would read "clear" and loot.
  Same failure mode as the existing `_utFrzNearVal` probe; accepted for parity of style.
- B geometry: `n60` counts hostiles near the **crystal** — a guard that chases us out past 60u of the crystal lets the
  loot phase start while it's on our heels (dodge + rotation stay live; the sweep is 15s-bounded).
- B session interplay: if `utilityOpenableConsumed` briefly flips unknown/false mid-posture (crystal de-streamed in a
  chaotic fight), the normal utility walk resumes toward the crystal until it reads consumed again (probe radius covers
  the 57u ring, so this should be rare and self-correcting).
- C inherits two pre-existing gates by placement: the `hpGateEnabled` user setting (dodge-only-below-X% — OFF in our
  config) and the shared `_egCoolUntil` 4s stand-down after a 14s wedged escape. Also, the mapper's walkEgress sender
  skips frames where opener/pickit hold the movement lock (pre-existing TASK-33 behavior; locks are ≤2s and their
  auto-walk itself moves us). None of these were changed to avoid regressing TASK-33.
- C only runs when the dodge runs (dodgeMode boss/rare) — same scope as every dodge feature; a drain while dodge is
  'off' (pure exploration, no rare near) is not covered, matching TASK-33.

## Open questions
- None blocking. If the planner wants PANIC to also pierce the opener/pickit movement-lock gate on the mapper's
  walkEgress sender, that is a one-line change but touches TASK-33 behavior — left out on purpose.
