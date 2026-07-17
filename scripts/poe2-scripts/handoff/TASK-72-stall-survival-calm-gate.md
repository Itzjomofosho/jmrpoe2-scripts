# TASK-72 — Stall-aware survival, content-activation calm gate, valve combat-freeze, chicken slam

Read `handoff/HOUSE_RULES.md` FIRST. Pre-snapshot (FIRST ACT): copy `mapper.js`, `entity_actions.js`,
`auto_dodge_core.js`, `rotation_builder.js`, `chicken.js` into `handoff/pre/TASK-72/` before ANY edit.

## Incident (evidence — tmp log rotates, quoted here verbatim)

Death on Backwash 2026-07-17 ~10:01:19, mid breach+incursion-corruption overlap. Two-part cause:

**(1) Client graphics stall froze the bot brain at the burst moment.** PoE2 recreated its swap chain
mid-fight; our JS runs in the Present/draw path, so every plugin went dark ~1.5s, then ticked through a
~40s PSO recompile storm (PSO count 24,000→34,000 in <60s vs ~300/min baseline):

```
[10:01:17.937] [Rotation] Used IceShot (target) - success=true          <- last normal tick
[10:01:18.232] Renderer::CreateSwapChainForHwnd: hWnd=0x190256 ...      <- game recreates swap chain
[10:01:18.235] Renderer::ResizeBuffers: POE2 is resizing swap chain     (VRAM read 128MB = evicted)
[10:01:19.329] Renderer::Present: swap chain re-init #2
[10:01:19.400] [Chicken] Health potion used at 85% threshold            <- wake-up: all in the SAME 40ms
[10:01:19.423] [Rotation] Used EmpowerBarrage (target) - success=true   <- cast fired BEFORE egress
[10:01:19.438] [AutoDodge] PANIC egress: hp -77% in 2s -> leaving the fight
[10:01:19.438] [Survival] HP-yield 36% -> content/nav/boss stand down
[10:01:35.390] [Rotation] hp flat 5s on It That Grasps but 0 casts sent (dead)
```
Three independent systems firing in one frame = none of them ticked during the damage window.
The reaction stack WORKED; it was blind.

**(2) Decision layer walked a shaky character into fresh density.** In the 20s BEFORE committing the
breach, the char needed three emergency escapes vs the previous pack:

```
[10:00:10.797] [AutoDodge] PANIC egress: hp -25% in 2s -> leaving the fight
[10:00:20.313] [AutoDodge] blind egress: hp -16% in 2.5s ... walking out NE
[10:00:28.866] [AutoDodge] blind egress: hp -15% in 2.5s ... walking out SW
[10:00:31.005] [ArbShadow] pick=breach:77 ... committed=breach:77       <- 2s after the 3rd egress
[10:00:43.306] [Breach] TOUCHED (13u) -> activated at (1392,426)        <- new wave on a bleeding char
```
BlindGround at death showed BloodBather (incursion corruption) mobs at 17–21u INSIDE the breach ring —
the same two-source overlap as the Grimhaven death, one decision earlier.

**Related finding (same session, Steppe):** the arb release valve burns while COMBAT holds movement.
Committed verisium:2831 released `undrivable -> released (no runner, no progress)` after 6 effective
seconds in which the char stood still fighting (`[MB] BLOCK: nav(p5) vs holder content(p3)`, continuous
rotation casts). Freeze the valve on combat frames (Part D).

**User request (chicken):** "check every 100ms and smash the hp pot at least ONCE per configured time."
Chicken already checks EVERY FRAME (onDraw, no throttle) — the gap is the `isHealthFlaskActive()`
suppression: one pot, then nothing while HP keeps dropping (Part E). Frame-starvation during stalls is
Parts A/C; nothing JS-side can tick without frames.

## Scope

Runtime JS only (HOUSE_RULES). Part C consumes a C++ binding the PLANNER will add separately — you write
the typeof-guarded consumer only; binding absent = byte-parity. NO edits to pickObjective's commitment
short-circuit and NEVER fold new signals into `engagedContentAnchor` (a prior task did → CONFIRMED
CRITICAL regression). All parts flag-gated, defaults ON, flag-off = byte-identical control flow.

---

## Part A — Stall-aware wake-up (flag `STALL_WAKE_ON`, mapper setting; shared const default 600ms gap)

Per-module wall-clock gap detectors (no cross-module plumbing; each module keeps its own `_lastTickAt`):

**A1. rotation_builder.js — no attack-rooting on wake.** In `executeRotation` (top, after the existing
dead gate): module-level `_rotTickAt`; compute `gap = now - _rotTickAt` then stamp. If flag on AND
`gap > 600` AND player hpFrac < 0.90 → set `_rotStallHoldUntil = now + 1500`. While `now <
_rotStallHoldUntil` AND hpFrac < 0.90: `_lastNoFireReason = 'stall-wake'; return false`. Covers ALL
casters (entity_actions + QOL bot both route through here). Recovery to ≥90% HP ends the hold early
(the hpFrac condition re-checks each call). Log ONCE per hold via a throttled
`console.log('[Rotation] stall-wake ' + gap + 'ms -> casts held 1.5s')`.

**A2. auto_dodge_core.js — wake = instant emergency.** In its main tick: gap detector as above. If flag
on AND `gap > 600` AND hpFrac < 0.75 → arm the SAME egress path the PANIC trigger uses, immediately
(do not wait for the -X%/2s delta windows to accumulate post-wake samples), and reset the delta-window
baselines so pre-stall samples can't double-fire. Log `[AutoDodge] stall-wake Xms at Y% -> PANIC egress`.

**A3. mapper.js — stall spans don't burn clocks + feed the calm gate.** In the main mapper tick: gap
detector. If flag on AND `gap > 600`:
- Stamp `stallWakeAt = now`, `stallGapMs = gap` (module globals).
- Runner/watchdog clocks: treat the span as STOLEN via the existing `runnerSpanStolen` /
  `OWNED_RUNNER_CLOCKS_ON` idiom (grep its call sites; add a stall-gap contribution the same way the
  dodge/stolen spans already feed it). Do NOT invent a parallel mechanism.
- Survival leniency: for 3s after `stallWakeAt`, `survivalYieldActive()` uses threshold 0.70 instead of
  `SURVIVAL_YIELD_HP` (0.45) — same egress-live requirement as today.
- The wake counts as an EMERGENCY event for Part B (see `lastEmergencyAt`).

## Part B — Calm gate on content activation (flag `ACT_CALM_GATE_ON`, `CALM_GATE_MS = 25000`, `CALM_GATE_HP = 0.70`)

**Signal:** auto_dodge_core.js exports `lastEgressAt` (stamp on PANIC egress, blind egress, walkEgress
arm) through the existing `autoDodgeStatus()` object. mapper.js computes
`lastEmergencyAt = max(autoDodgeStatus().lastEgressAt || 0, stallWakeAt || 0, gfxStormLastReinitAt || 0)`.

**Gate predicate** `activationCalm(player, now)` (mapper.js): returns false (NOT calm) when flag on AND
(`now - lastEmergencyAt < CALM_GATE_MS` OR hpFrac < `CALM_GATE_HP`).
**Starvation cap:** if a runner has been gate-held >60s continuously AND hpFrac ≥ 0.85 AND
`now - lastEgressAt > 10000` → proceed anyway (log it).

**Gated sites (activation = the moment new mobs spawn; gate ONLY the final activation approach, never
the queue/commit/pick):**
1. **Breach touch** — `runBreachRoam`: before the leg that closes inside ~25u of the un-activated breach
   center (the one that produces `[Breach] TOUCHED`): if not calm → hold at ≥40u (posture/hold idiom,
   `MI.hold(MOV.breach)` or the runner's existing hold), status `Breach: calm gate (recovering)`, freeze
   the runner's own clocks via the stolen-span idiom. Activated breaches are NOT gated (leaving mid-ring
   is its own death sentence — the existing survival yield owns that).
2. **Verisium open** — `_runExpedition2`: gate the transition that calls `exp2Open` (and the
   `reached -> clear mobs` entry): if not calm → hold at ≥30u from the remnant, status
   `Verisium: calm gate (recovering)`. Post-open phases NEVER gate.
3. **Abyss start** — the abyss runner's initial approach to an un-started crack (proximity-activated):
   if not calm → hold ≥40u. Mid-abyss (started) never gates.
4. **Incursion beacon** — same: un-activated beacon approach holds ≥40u when not calm (temple variant
   proximity-activates).
Do NOT gate: shrines, chests/openers, pickit, checkpoints, boss walk (boss has its own machinery).
Log per gate-hold ONCE per 5s max: `[CalmGate] <type> held Ns (hp NN%, last egress Ns ago)`.

## Part C — Gfx-storm consumer (flag `GFX_STORM_YIELD_ON`; C++ binding is the PLANNER's, not yours)

`function gfxStormActive(now)` in mapper.js: if `typeof poe2.gfxLastSwapReinitAgoMs !== 'function'` →
return false (parity when the binding doesn't exist yet). Else true when the last swap-chain re-init was
< 15000ms ago. Cache the call per logic pass (7Hz), not per frame. Effects:
- Feeds `gfxStormLastReinitAt` into Part B's `lastEmergencyAt` (no activations during a storm).
- If ALSO hpFrac < 0.75 → same stand-down as `survivalYieldActive()` (reuse its yield path, don't fork).
- Log on storm ENTRY once: `[GfxStorm] swap re-init detected -> activations gated 15s`.

## Part D — Release-valve combat freeze (flag `ARB_VALVE_COMBAT_FREEZE_ON`, credit cap 45s)

In the arb release valve (search `undrivable -> released` / the `arbValveSince` block): the existing line
`if (gap > 400) arbValveSince += gap;` exempts preempted frames. Add a second exemption: else-if flag on
AND `now - (POE2Cache.lastRotationCastAt || 0) < 1500` AND `arbValveCombatCreditMs < 45000` →
`arbValveSince += gap; arbValveCombatCreditMs += gap;`. Reset `arbValveCombatCreditMs = 0` wherever the
valve arms/resets (`arbValveKey` assignment sites). Result: standing-and-fighting doesn't burn the 6s
release; a never-ending fight still releases after 45s of credit.

## Part E — Chicken slam (chicken.js, setting `slamMode` default true)

While `healthPercent < threshold`: call `useHealthPotion()` on every tick — the 1.5s `potionCooldown`
inside it is the rate limiter — REGARDLESS of `POE2Cache.isHealthFlaskActive()`. `slamMode: false`
restores today's exact suppression (parity). Keep the existing log line; add nothing per-frame. UI: a
checkbox next to the existing potion controls. (Check cadence is already per-frame — do not add a timer.)

## Verification (per HOUSE_RULES — solo, no fleets)

1. `node --check` on all 5 files.
2. Grep every new symbol once.
3. Flag-off parity: with all five flags off, diff control flow vs `handoff/pre/TASK-72/` — no behavior path change.
4. REPORT (`handoff/TASK-72-REPORT.md`) with the LIVE-TEST CHECKLIST — at minimum:
   - `[Rotation] stall-wake` + `[AutoDodge] stall-wake` appear after any client hitch >600ms, and no cast
     lands between wake and egress.
   - `[CalmGate] Breach held ...` when a breach commit follows an egress within 25s; breach still runs
     after calm.
   - A committed target with continuous rotation casts no longer logs `undrivable -> released` within 6s
     (Steppe verisium:2831 repro).
   - `[Chicken] Health potion used` repeats every ~1.5s during sustained sub-threshold HP (was: once).
