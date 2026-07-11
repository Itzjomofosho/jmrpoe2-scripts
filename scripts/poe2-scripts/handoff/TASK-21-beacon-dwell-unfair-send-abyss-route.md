# TASK-21 — Combined-test round 1 fixes: beacon chest dwell, opener unfair-send hold, abyss node routing

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` AND `..\opener.js` into `handoff\pre\TASK-21\`.
Evidence: C:\tmp\log.txt (Spring_, 17:36-17:40, combined-test map 1) — planner-verified timestamps below.

## A. Post-energise vaal-chest dwell (mapper.js) — "ran passed vaal chest, no stop"
Live: beacon fight ended -> `[OB] complete content:incursion-beacon:tgt-104x21 (arb-release)` at 17:37:18, then
`[Incursion] Vaal Beacon (1254,251) marked ENERGISED (sticky) -> 1 done` at 17:37:25 — the arbiter released
BEFORE the energise flip registered, so the post-energise chest dwell had no owner and the bot walked off as the
vaal chest spawned. FIX: hook the STICKY ENERGISED mark event (the `marked ENERGISED` site): if the player is
within 80u of the beacon coords when a beacon is FIRST marked energised, run a bounded chest dwell — stand at/near
the beacon (walk back <=80u with the 'boss' route if displaced), hold ~8s (opener + pickit service the spawned
vaal chest; verify the chest name passes LEAGUE_CHEST_RE / the opener whitelist and say so in the report), then
release. Bounds: one dwell per beacon (keyed on the sticky registry entry), 15s hard cap, never fires in boss
states, dodge-held frames freeze the clock (house idiom). Const `BEACON_CHEST_DWELL_ON = true`.

## B. Opener unfair-send hold (opener.js) — "shrine NEXT TO ME didnt go"
Live: `Opened Shrine: Shrine (ID: 0x1CD, Dist: 45.3)` then `38.1u`, both while the mapper owned movement
(`Walking to Breach Mob` lines between them) — sends that can never land, burning free-retries/attempts; the
shrine was left unopened. The abyss-chest 25u gate (TASK-19) fixed one name; generalize the MECHANISM:
- A NON-essence send is HELD (not fired, nothing charged, target stays a candidate) when it has no fair window:
  `distance > OPEN_FAIR_RANGE (30u)` AND a NON-opener movement lock/walk owns the character (reuse the exact
  `_fairWindow` computation from markOpenAttempt's call site). In range OR movement free -> send as today.
- Essences keep their lane untouched (the reach-hold plants for them). RuneRocks untouched (parked by the stone
  handler). The abyss-chest 25u hard gate stays (it is stricter and proven).
- This REPLACES burning free retries on unfair sends: the free-retry lane still exists for sends that fired fair
  but didn't land (server ate it). State the final send-decision table in the report.
- COMMIT-TO-CLICK (user 2026-07-11: "get closer to it and commit to clicking things for ~800ms"): when a held
  target is within 50u AND no dodge/fight hold is live (MB dodge owner check + not FIGHTING_BOSS/boss-melee), the
  opener EARNS the fair window instead of waiting for luck: claim its OWN movement lock (the existing 'opener'
  lock machinery), `sendStopMovementLimited()`, fire the interact, and HOLD the lock ~800ms (const
  `OPEN_COMMIT_MS = 800`) for the landing check — the interact auto-walk completes instead of being stomped by
  the mapper's walk. One commit per target per 2.5s (the existing anti-repeat gap); dodge may steal the hold at
  any time (never fight the dodge). This is how a human opens things: step up, stop, click, beat. The mapper's
  clocks already freeze on opener-lock frames (utilityLastServicedAt idiom) — verify that stamp fires here too.
  Const `OPEN_UNFAIR_HOLD_ON = true` gates BOTH the hold and the commit-to-click.
- ARCHITECTURE CONSTRAINT (user 2026-07-11): this is NOT a new hold mechanism. It must ride the EXISTING
  walk->yield architecture end to end: the mapper WALKS to the target (using the walkable-approach cell when the
  target's own cell is unwalkable — that sidestep is part of the mapper's walking leg, TASK-19's helper), then
  the opener YIELDS the mapper via its existing movement lock (`POE2Cache` claim/lock, source 'opener') for the
  commit window, mapper clocks freeze on yielded frames exactly as they do for pickit/opener today
  (utilityLastServicedAt / _lockTickAt idioms), then movement returns to the mapper — "going to X, yielding to
  opener for 0.8s, back to X". If any piece needs a mechanism the yield system doesn't already provide, STOP and
  report instead of building a parallel one.

## C. Abyss node walk = fog-independent route (mapper.js) — "abyss had to walk around"
Live: `Walking to Abyss Node at (2105,368) [pathType=none]` stalled at closest 41u for ~50s (17:38:10->17:39:00)
-> `[Abyss] node 1226 no progress -> skip` (owned=159ms frozen=8716ms — the verdict crawled because almost no
frames were owned). The node sat behind terrain the fog-gated JS path can't route. FIX, mirroring the sweep/stone
walks: the abyss node approach uses `startWalkingTo(..., 'boss')` (fog-independent macro route) instead of the
default path; within 45u, if the node's own cell reads unwalkable (pit-edge — known true for abyss geometry),
walk to `walkableApproachPoint` (shared helper, TASK-19) instead. Keep every existing bound (no-progress skip,
caps) unchanged — the route fix should make the 50s stall mostly vanish, not loosen the verdicts.
Also verify the runner's walk-target re-issue site respects the same target so the two don't fight.
Const: reuse WALK_APPROACH_ON for the approach-cell part; the 'boss' routing is unconditional (routing choice,
not behavior gamble — say so in the report if you disagree with reasons).

## Hard limits
- Files: mapper.js + opener.js only. No arbiter/OB surgery (A hooks the sticky-mark event, not the release path).
- All new dwells/holds bounded + dodge-freeze idiom; flag-off parity for A and B.

## Acceptance
- `node --check` both; parity walks for A/B.
- Report per HOUSE_RULES + live-test checklist: beacon energise -> `[Incursion] chest dwell` line + vaal chest
  opened/looted before leaving; a shrine near a busy walk gets NO >30u sends, then opens when the bot is actually
  close/parked; abyss node walks show `pathType=boss` + no 40u+ multi-10s stalls; the skipped-node class from
  map 1 reaches its node.
