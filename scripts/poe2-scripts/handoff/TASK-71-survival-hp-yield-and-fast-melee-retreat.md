# TASK-71 — Global survival HP-yield + posture retreat from fast melee (ONE task, two coupled fixes)

USE FABLE. NO bridge / no live game needed to implement (pure JS logic on mapper.js + rotation-adjacent posture).
Read handoff/HOUSE_RULES.md first. Runtime tree = c:\Games\jmr-poe2\scripts\poe2-scripts (edit + test here; sync to
c:\Games\jmrpoe2-scripts before commit). Baseline: scripts @37a516d + the uncommitted 2026-07-16 stack already on top.

## WHY (4 deaths, same disease)
A squishy Ice-Shot Deadeye keeps dying because CONTENT/COMBAT anchors the character in danger while REACTIVE survival
(posture "hold 55u", PANIC egress, 85% life flask) loses to BURST. Deaths: LoftySummit (meteor zealot on unreachable
ground), AridPlains (verisium leftover-mob burst in the loot dwell), Port (a UNIQUE **Spiked Scuttler** — fast melee —
that stayed at 29u while posture "held 55u" and never moved away; collapsed to MeleeBow-only, no ranged distance).
Per-runner HP-yields were bolted onto pickit / verisium / breach one at a time = whack-a-mole. This task replaces that
with ONE global gate (#1) + makes the posture actually RETREAT from fast melee so it never reaches the critical state
(#2). HOUSE RULE HOLDS: no DC / no chicken-exit / no portal-flee ([[poe2-local-player-read-stale]]); "fight better"
= step out of danger + kite, NOT disconnect. Both fixes MOVE the char to safety and keep fighting; neither exits.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────
## FIX #1 — GLOBAL SURVIVAL HP-YIELD (one gate replaces the per-runner ones)

### Where the frame drives (anchors, mapper.js — verify line #s, the file shifts)
- Survival dodge runs FIRST each frame: `runAutoDodge(autoDodgeCfg)` ~L16709. It sets `walkEgress`
  (`autoDodgeStatus().walkEgress`) + `dodgeMoveSuppressUntil`, and the mapper RE-SENDS the egress every frame at
  ~L16714-16717 (`if (_we && ...) sendMoveGridLimited(...)`). So by the time content/nav/boss drive, the egress
  packet for THIS frame has already gone.
- Content/nav/boss drive dispatch is BELOW that, inside the state branches: `arbTick(player, now)` ~L16959;
  legacy `runContentRotation/tryRevisitNearbyContent/tryPreBossContentPass` ~L16960; `WALKING_TO_BOSS_MELEE`
  branch (`runBreachRoam` etc.) ~L16962+; `FIGHTING_BOSS` is boss-only below that.

### Design
Add a single helper + a single guard, ABOVE the state-branch drive dispatch and BELOW the dodge/egress block
(recommended insertion: right after the `commitClickSafe` block ~L16755-16760, before the `moveLock` block / state
machine). It yields the FRAME's content+nav+boss driving to survival — it does NOT touch the dodge (already ran) or
the flask (separate plugin).

```js
const SURVIVAL_YIELD_ON = true;          // master gate; false = byte-parity (helper returns false, nothing skipped)
const SURVIVAL_YIELD_HP = 0.45;          // <-- content/nav/boss stop DRIVING below this HP frac while survival is live
// Yield ONLY when actually escaping (a dodge/egress is live OR a hostile is close) -- a low-but-SAFE char must keep
// acting (recovering while frozen-in-place is its own death). Reads the same walkEgress/dodgeMoveSuppressUntil the
// mapper already trusts, so no new signal.
function survivalYieldActive(player, now) {
  if (!SURVIVAL_YIELD_ON || !player || !(player.healthMax > 0)) return false;
  if (player.healthCurrent / player.healthMax >= SURVIVAL_YIELD_HP) return false;
  const _egLive = now < dodgeMoveSuppressUntil
    || (autoDodgeStatus && autoDodgeStatus().walkEgress)
    || (MB.hold && MB.hold.owner === 'dodge' && now - MB.hold.at < MB.WINDOW);
  return !!_egLive;   // low HP AND survival is actively moving us -> nothing else may drive this frame
}
```
Guard (single insertion, above the state machine):
```js
if (survivalYieldActive(player, now)) {
  if (now - _survivalYieldLogAt > 3000) { _survivalYieldLogAt = now; log(`[Survival] HP-yield ${(100*player.healthCurrent/player.healthMax)|0}% -> content/nav/boss stand down, dodge/egress owns movement`); }
  statusMessage = `SURVIVING (hp ${(100*player.healthCurrent/player.healthMax)|0}%)`;
  lastPositionChangeTime = now;   // don't let the stuck-watchdog fire while we're deliberately egress-driven
  return;                          // skip ALL content/nav/boss/utility driving this frame; dodge already fired
}
```
Add `let _survivalYieldLogAt = 0;` near the other posture/log-throttle lets.

### Guardrails / gotchas
- Place the guard so it CANNOT skip the survival dodge (it must be AFTER ~L16749) and BEFORE any content/nav/boss
  drive (before ~L16943 state machine). Do NOT skip the chicken/flask (separate plugin, runs regardless).
- `return` (not `return false`) — this is the top-level processMapper frame handler; returning ends the frame after
  the dodge already acted. Confirm the enclosing function is processMapper's per-frame body (the same one that holds
  the moveLock block ~L16762). If the structure differs, gate each drive-return path instead of one early return.
- The three EXISTING per-runner yields are now BACKSTOPS (different thresholds): pickit.js ~L643 (HP<55%),
  verisium loot dwell mapper.js ~L5545 (HP<60% freezes loot clocks), breach runBreachRoam mapper.js ~L3135 (HP<45%).
  LEAVE THEM — they cover their own state before the global gate would trip, and the verisium one also FREEZES loot
  clocks (the global gate can't). Just confirm no double-drive conflict (all return true / stand down, none send
  competing movement).
- Flag-off (`SURVIVAL_YIELD_ON=false`) MUST be byte-identical to today.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────
## FIX #2 — POSTURE RETREAT FROM FAST MELEE (prevention: never reach critical HP)

### The bug (Port Spiked Scuttler)
`_postureThreatScan` (mapper.js ~L2706) classifies a "presser" only if `d <= _boU` where `_boU = _hpFrac < 0.75 ? 42 :
RANGED_BACKOUT_U(20)` (~L2715, 2731). A fast melee UNIQUE sat at **29u** -> at healthy HP 29 > 20 -> NOT a presser ->
no back-out -> posture just logs "holding 55u vs X (29u)" and STANDS while it gets hit. Only after HP drops <75% does
`_boU` widen to 42 and it starts kiting -- by then it's taking burst. Also the back-out (section B ~L2831) is
rate-limited to `RANGED_BACKOUT_STEP_MS`(900ms) and steps ONCE to the 55u ring -- a FAST enemy re-closes to 29u before
the next step, so the char never gains distance.

### Design — tier the back-out by monster rarity; retreat CONTINUOUSLY from Rare/Unique
Rarity is already read at ~L2730 (`m.entitySubtype` matches `/Magic|Rare|Unique/i`). Extend `_poPress` to carry the
tier, widen `_boU` for Rare/Unique even when healthy, and drop the rate-limit gap for a Rare/Unique presser so the
retreat re-issues every frame (the `_poStepUntil` 650ms re-steer already exists; the gap is the 900ms between NEW
back-outs).

In `_postureThreatScan` (~L2731) — capture the presser's tier:
```js
// tier the presser: RARE/UNIQUE hit hard + are often faster -> a wider back-out floor even at full HP, and a
// continuous (un-rate-limited) retreat so a fast unique can't sit in melee while posture "holds". Magic keeps the
// existing tight floor (user ruling: don't over-retreat from trash; dodge covers). Whites never press (L2730).
const _tier = /Unique/i.test(m.entitySubtype || '') ? 3 : /Rare/i.test(m.entitySubtype || '') ? 2 : 1;
const _tierBoU = _tier >= 2 ? (_hpFrac < 0.75 ? RANGED_ENGAGE_STOP_U : RANGED_PRESS_ELITE_U) : _boU;
if (d <= _tierBoU && d < pd && !_poHardCCd(m)) { pd = d; _poPress = { x: m.gridX, y: m.gridY, d, tier: _tier }; }
```
Add constant near the posture block (~L2639):
```js
const RANGED_PRESS_ELITE_U = 40;   // Rare/Unique presser back-out floor at HEALTHY hp (fast melee elites hit hard); hurt -> full 55u ring
```
In the back-out (section B ~L2831) — let a Rare/Unique presser bypass the rate-limit so the retreat is continuous:
```js
const _eliteRetreat = _poPress && _poPress.tier >= 2;
if (_poPress && !_reachHeldPress && (_eliteRetreat || now - _poStepAt >= RANGED_BACKOUT_STEP_MS) && now >= dodgeMoveSuppressUntil) {
  ... (unchanged body) ...
}
```
(The `_poStepUntil = now + 650` re-steer inside the body already keeps a single retreat heading alive between scans;
the change is only that a NEW elite retreat can start without waiting 900ms.)

### Optional stretch (only if time) — "can't kite it" disengage
If a Rare/Unique presser stays inside `RANGED_MELEE_FLOOR_U` for >~4s of continuous retreat attempts (the char is
NOT gaining distance -> it's faster than us), stop force-kiting: let the dodge cover and the rotation trade (a bow
build fires while stepping). Do NOT add a portal/skip here (house rule). Park this if it risks the happy path.

### Guardrails
- Preserve the user's rulings: whites/normal NEVER press (keep the L2730 Magic+ filter); "stop running when you fire"
  stays for Magic-only pressers (tight floor). Only RARE/UNIQUE get the wider+continuous treatment.
- Everything stays LEASH-CLAMPED (`_clampLeash`) and goes through the gated movers (MI.direct MOV.posture) so dodge
  (p1) stays senior -- do not bypass `dodgeMoveSuppressUntil`.
- No new flag needed if you keep it inside RANGED_POSTURE_ON; if you want a kill-switch, gate the elite-tier widening
  behind a `POSTURE_ELITE_RETREAT_ON = true` const and make false = today's behavior.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────
## HOW #1 AND #2 WORK TOGETHER
#2 is PREVENTION (kite the fast elite early so HP never craters). #1 is the NET (if HP still craters — a burst, a
pack — content/nav/boss stand down and only the dodge/egress moves the char until it recovers). Neither exits the
map. If the char genuinely cannot survive a fight, it will egress + recover + re-approach (bounded by the existing
commit TTLs), which is the correct "fight better", not a flee.

## VALIDATION (NO BRIDGE — the user runs the live check)
1. `node --check mapper.js` (+ rotation_builder.js if touched) -> SYNTAX-OK. Both files.
2. Flag-off parity: set SURVIVAL_YIELD_ON=false (and POSTURE_ELITE_RETREAT_ON=false if added) -> confirm the guards
   are inert (helper returns false; no lines changed downstream). This is the byte-parity proof.
3. Live log signatures for the USER to watch (tell them exactly these):
   - Fast elite: `[Posture] back-out: hostile at 29u (...)` firing REPEATEDLY vs a Rare/Unique at ~30-40u (was
     "holding 55u vs X (29u)" doing nothing) -> the char visibly steps away and kites.
   - HP crater: `[Survival] HP-yield NN% -> content/nav/boss stand down` when HP<45% mid-fight, and the char walks
     out under egress instead of standing.
   - No regression: normal maps show NEITHER line (healthy HP, no elite in melee) -> the gates don't fire on the
     happy path.
4. DO NOT COMMIT until the user live-tests ([[test-before-commit]]). C++ untouched.

## EXACT ANCHORS (grep these; line #s drift)
- mapper.js: `runAutoDodge(autoDodgeCfg)` | `autoDodgeStatus().walkEgress` | `dodgeMoveSuppressUntil` |
  `commitClickSafe` (insert #1 guard after) | `arbTick(player, now)) return` (drive dispatch, keep BELOW the guard) |
  `function _postureThreatScan` | `const _boU = _hpFrac` | `_poPress = { x: m.gridX` (both scan + back-out sites) |
  `RANGED_ENGAGE_STOP_U = 55` / `RANGED_BACKOUT_U = 20` / `RANGED_BACKOUT_STEP_MS = 900` / `POSTURE_PRESS_MAGIC_PLUS`.
- Existing per-runner yields (LEAVE, they're backstops): pickit.js `DEATH-OVER-LOOT`; mapper.js
  `loot dwell YIELDS to survival`; mapper.js `[Breach] survival yield`.
