# TASK-72 REPORT — Stall-aware survival, calm gate, valve combat-freeze, chicken slam

Pre-snapshot: `handoff/pre/TASK-72/` (all 5 files, taken before any edit).
`node --check` passes on all 5; `entity_actions.js` needed **no edits** (A1 covers both casters inside
rotation_builder) — its snapshot is unchanged-vs-runtime by design.

## Files touched / symbols

### rotation_builder.js (Part A1)
- New module state near the cast gates: `STALL_WAKE_ON` (true), `STALL_WAKE_GAP_MS` (600),
  `STALL_WAKE_HOLD_MS` (1500), `STALL_WAKE_HP_FRAC` (0.90), `_rotTickAt`, `_rotStallHoldUntil`, `_rotStallLogAt`.
- `channelArbiterTick()` (top): gap detector + hold arm. Player read only on a stall frame.
- `executeRotation()` (after the channelArbiterTick call): while `now < _rotStallHoldUntil` AND hpFrac < 0.90
  → `_lastNoFireReason = 'stall-wake'; return false`. Recovery ≥90% clears the hold early.

### auto_dodge_core.js (Part A2 + B signal)
- New state near the PANIC consts: `STALL_WAKE_ON` (true), `STALL_WAKE_GAP_MS` (600), `STALL_WAKE_HP_FRAC`
  (0.75, **pooled hp+es** — the module's convention, same pool the delta windows sample), `_dodgeTickAt`,
  `_stallWakeLogAt`, `_lastEgressAt`.
- `runAutoDodge()`: gap computed at the scan gate (baseline cadence 100/160ms); after the hp-gate check, a
  qualifying wake clears `_blindHpHist` and sets `_panicUntil = now + PANIC_HOLD_MS` — `_tryPanicEgress`'s
  committed-hold path then arms `walkEgress` the same scan (the SAME egress path, no second mechanism).
- `_lastEgressAt` stamped on: blind-egress active pass, PANIC-egress active pass, field walk-out arm/re-arm,
  stall-wake arm. Exported as `autoDodgeStatus().lastEgressAt` (new field; existing consumers unaffected).

### mapper.js (Parts A3, B, C, D)
- `runnerSpanStolen()`: +2 rules — span containing a stall wake is stolen (`now - gap <= stallWakeAt`);
  a calm-gate-held runner's spans are stolen (`_cgHoldType === type && now - _cgHoldAt < 1200`).
- New block after `runnerSpanStolen` — A3: `STALL_WAKE_ON`, `STALL_WAKE_GAP_MS`, `_mapperTickAt`,
  `stallWakeAt`, `stallGapMs`, `_stallWakeLogAt`. B: `ACT_CALM_GATE_ON` (true), `CALM_GATE_MS` (25000),
  `CALM_GATE_HP` (0.70), `CALM_GATE_STARVE_MS` (60000), `_cgHeldSince/_cgLogAt/_cgBypassUntil` maps,
  `_cgHoldType/_cgHoldAt`, `activationCalm(player, now)`, `calmGateHold(type, player, now)`.
  C: `GFX_STORM_YIELD_ON` (true), `GFX_STORM_WINDOW_MS` (15000), `gfxStormLastReinitAt`, `gfxStormActive(now)`
  (typeof-guarded on `poe2.gfxLastSwapReinitAgoMs`; 140ms result cache ≈ the 7Hz logic pass).
- `processMapper()` top (above the player-validity bail, so load screens keep ticking it and can't fake a
  wake on map entry): stall detector stamping `stallWakeAt/stallGapMs` + throttled `[StallWake]` line.
- `survivalYieldActive()`: gfx-storm + hpFrac<0.75 → yield **without** the egress-live requirement (Part C
  reuses the same yield path — no fork); threshold 0.70 instead of 0.45 for 3s after `stallWakeAt` (A3).
- Gate sites (each: `calmGateHold(...)` → `MI.hold(MOV.x)` + status `X: calm gate (recovering)` + return true):
  - `runWalkToBreach` — after the closest-approach track, band `d <= 48` (before the leg producing
    `[Breach] TOUCHED`). Activated breaches (`runBreachRoam`) never gate.
  - `runAbyssRun` Phase A (`!abyssDwell`), band `dist <= 48`. Mid-abyss never gates.
  - `runIncursionBeaconRun` — after done-detection, before the 25s budget, band `dist <= 48`.
  - `_runExpedition2` — (1) the `!exp2ClearAt` reached-entry, band `dist <= 38`; (2) the Phase-3 open ladder
    (before `exp2OpenApAt`), no band (the OPEN interact is the activation). Post-open phases never gate.
  - NOT gated (per brief): shrines, chests/openers, pickit, checkpoints, boss walk, hive, stone, essence.
- `arbValveTick()` (Part D): `else if` on the ≤400ms branch — rotation cast <1.5s ago AND
  `arbValveCombatCreditMs < 45000` → `arbValveSince += gap; arbValveCombatCreditMs += gap`. Credit resets at
  every `arbValveKey` assignment site + `arbReset()`. New: `ARB_VALVE_COMBAT_FREEZE_ON` (true),
  `ARB_VALVE_COMBAT_CREDIT_CAP_MS` (45000), `arbValveCombatCreditMs`.
- `resetMapper()`: clears calm-gate maps/holds + `stallWakeAt/stallGapMs/gfxStormLastReinitAt/_gfxStormOn`
  (emergencies don't cross a map change).

### chicken.js (Part E)
- `DEFAULT_SETTINGS.slamMode: true` (persisted via the normal saveSetting path).
- `updateHealth()`: `healthPercent < threshold && (slamMode !== false || !isHealthFlaskActive())` →
  `useHealthPotion()` every frame; its existing `potionCooldown` (1.5s) is the rate limiter. `slamMode: false`
  restores today's exact flask-active suppression. Missing key (old settings file) reads as ON.
- UI: "Slam mode (repot every cooldown while low)" checkbox under the potion-threshold controls (`_slamModeRef`).

## Settings / flags (all module consts unless noted; all default ON)
| Flag | File | Off = |
|---|---|---|
| `STALL_WAKE_ON` | rotation_builder / auto_dodge_core / mapper (per-module, no cross-module plumbing) | byte-parity |
| `ACT_CALM_GATE_ON` | mapper | byte-parity (gates + stolen-rule short-circuit) |
| `GFX_STORM_YIELD_ON` | mapper | byte-parity; also inert while the C++ binding is absent |
| `ARB_VALVE_COMBAT_FREEZE_ON` | mapper | byte-parity |
| `slamMode` | chicken (persisted **setting**, UI checkbox) | today's flask-active suppression |

## LIVE-TEST CHECKLIST
1. **Stall wake** (any client hitch >600ms while hp is down — alt-tab fullscreen flip can force one):
   - `[Rotation] stall-wake NNNms -> casts held 1.5s` and (if pooled hp <75%)
     `[AutoDodge] stall-wake NNNms at NN% -> PANIC egress` followed by the normal
     `[AutoDodge] PANIC egress: hp -0% ... leaving the fight` arm line.
   - WORKING: no `[Rotation] Used ...` line between the wake and the egress lines. BROKEN: a cast lands in
     that window (the Backwash sequence), or stall-wake lines appear during normal play with no hitch.
   - `[StallWake] NNNms frame gap -> clocks frozen ...` from the mapper on the same hitch.
2. **Calm gate**: within 25s after any `[AutoDodge] ... egress` line, commit a breach/verisium/abyss/beacon →
   `[CalmGate] breach held Ns (hp NN%, last egress Ns ago)` (5s cadence) with status
   `Breach: calm gate (recovering)`, and NO `[Breach] TOUCHED` / `[Exp2] ... OPENED` while held.
   - WORKING: once calm (25s clean + hp≥70%) the same run proceeds (`TOUCHED` fires). BROKEN: gate never
     releases (watch for the `[CalmGate] ... starvation cap ... proceeding` backstop at 60s), or an activation
     fires while held.
3. **Valve combat-freeze** (Steppe verisium:2831 repro — committed target, standing still fighting,
   continuous `[Rotation] Used ...`): no `[Arb] committed ... undrivable -> released` within 6s anymore;
   a genuinely-wedged commit with no combat still releases at ~6s, and an endless fight releases after ~45s+6s.
4. **Chicken slam**: sustain hp under the threshold (a DoT map mod works) →
   `[Chicken] Health potion used at NN% threshold` repeats every ~1.5s (was: once, then silence while
   the flask buff was active). Toggle the new checkbox OFF → old single-pot behavior returns.
5. **Gfx storm** (needs the planner's C++ binding first): on a swap-chain re-init,
   `[GfxStorm] swap re-init detected -> activations gated 15s` once per storm; with hp <75% the
   `[Survival] HP-yield` stand-down engages without waiting for an egress. Until the binding ships, NO
   `[GfxStorm]` lines should ever appear (typeof guard).

## Deviations from the brief (with why)
1. **A1 gap detector lives in `channelArbiterTick`, not `executeRotation`** (brief said executeRotation-top).
   Two reasons: (a) `executeRotation` is only called while a combat target exists, so its call gaps are FIGHT
   gaps — the letter of the brief would arm a 1.5s cast hold at every fight entry with hp<90%; (b) frame
   ordering — entity_actions calls `channelArbiterTick` before `processAutoAttack` every frame, so any stamp
   there makes an executeRotation-local detector blind (gap always ~0). The brief's own hold gate, threshold,
   duration, log line and early-release are implemented exactly as specified; only the stamp point moved to
   the module's true per-frame entry. In a QOL-bot-only setup (entity_actions disabled) the stamp degrades to
   executeRotation's own call cadence — the brief's letter — and the stamp-before-gate order prevents a
   re-arm loop there.
2. **Part B "runBreachRoam" gate is in `runWalkToBreach`** — that's where the `[Breach] TOUCHED` leg lives
   (located by search string per HOUSE_RULES; `runBreachRoam` is the post-activation roamer and never gates).
3. **Clock freeze during gate holds** reuses `runnerSpanStolen` (one added condition, the same idiom the
   MI-denied rule uses) rather than per-runner anchor arithmetic — "stolen-span idiom, no parallel mechanism".
4. **Starvation cap adds a 15s `_cgBypassUntil` window** after proceeding — without it the very next pass
   re-holds (still not calm) and the cap would be a one-frame no-op instead of an actual proceed.
5. **`lastEmergencyAt` is computed inline** in `activationCalm` (`Math.max(egress, stallWakeAt,
   gfxStormLastReinitAt)`) rather than as a named variable — same computation, one call site.
6. **`[AutoDodge] stall-wake` log throttled 3s** (brief specified no throttle; a 40s PSO storm re-fires the
   arm ~1/s and the house logging rule says throttle). The ARM itself still re-fires on every qualifying gap.

## Risks
- **Map-entry false wake (A1/A2):** if the draw path does NOT tick during loading screens, the first frame in
  a map sees the load as a >600ms gap. Consequence when entering with hp already low: one 1.5s cast hold
  (hp<90%), one 1.5s PANIC walk-out near spawn (pooled hp<75%), and a calm-gate window from entry. The mapper
  A3 detector is placed above the player-validity bail specifically to avoid this, but rotation/dodge tick
  only in-game. If live logs show `stall-wake` lines on every map entry, the fix is an upper bound on the gap
  (e.g. `gap < 8000` = stall, larger = load/state change) — deliberately NOT added since the brief specified
  only `> 600`.
- **Verisium open-gate budget:** the 3-min `EXP2_TOTAL_TIMEOUT` is only frozen on the pre-reach walk leg (the
  existing clock block's scope); a gate hold at the OPEN step burns it (worst case ~85s of 180s). Expiry
  done-bans the remnant for just 60s, so nothing is lost permanently.
- **Master-toggle re-enable** after a pause reads as a stall in the mapper (gap spans the off time) → one
  25s calm-gate window + 3s survival leniency after manual re-enable. Judged harmless-to-mildly-good.
- **'stall-wake' as a `lastNoFireReason` value:** entity_actions treats unknown reasons like 'ready-gated'
  (no idle-stop sent), so a pre-stall game-side attack repeat isn't explicitly stopped during the hold — the
  egress movement cancels it in practice. Flagging in case the planner wants 'stall-wake' added to the
  idle-stop branch.
- **Part D scope:** the combat credit keys off `POE2Cache.lastRotationCastAt`, which only entity_actions
  stamps — casts from other senders won't freeze the valve (same signal set the posture/idle systems use).

## Open questions
- None blocking. The C++ `poe2.gfxLastSwapReinitAgoMs` binding name is consumed exactly as the brief spells
  it; if the planner ships a different name/shape (property vs function, or absolute ts instead of ago-ms),
  `gfxStormActive` needs the one-line read adjusted.
