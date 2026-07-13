# TASK-45 REPORT — hp-frozen ban: ES-blind false positives + zero-cast bans (the "banning a mob shooting at my face" bug)

Runtime-only edit (untracked `c:\Games\jmr-poe2\scripts\poe2-scripts\entity_actions.js`). NOT committed.
Pre-snapshot in `handoff\pre\TASK-45\entity_actions.js`. `node --check` passes.

## The two confirmed faults (evidence: "retard no attack #2.txt", 21:45-21:51, Utzaal zealot packs)

1. **ES-blind damage detection.** The stale guard tracked `healthCurrent + esCurrent` against an
   **all-time-low anchor** (`_thp < aaStaleHp - 1` = "made a new low"). Bannerbearing/Gelid/Fiery zealots
   grant + regenerate ES on the pack, so the summed pool never revisits its old trough even while every
   arrow lands → verdict "unhittable from here" → 5s/30s ban + 25u cluster sweep on mobs point-blank,
   mid-exchange (Vaal Axeman banned between two IceShots 21:46:24; Vaal Guard banned during a
   ShearingBolts barrage 21:49:37).
2. **Bans with zero casts sent.** The 3.5s clock ran from target *selection*, not from firing — any
   upstream cast-path blocker converted into escalating bans of everything nearby (the log-#1 carousels:
   17 bans / 2min10s / zero `Used` lines, perfect 33.5s per-mob periodicity).

## Changes (all in the stale-guard block, entity_actions.js)

- **Per-tick damage detection** replaces the trough anchor: `aaStaleHp` is now *last tick's* pool
  (updated unconditionally each tick). A drop ≥2 between consecutive ticks (~100ms) = hit landed → reset.
  Regen/grants can no longer mask sustained damage (hits land every ~420ms; each produces an inter-tick
  drop unless regen within 100ms exceeds the hit).
- **Rising pool resets the clock** (`_thp > aaStaleHp + 1`): ES grant/recharge/ally heal means the mob is
  being *supported*, not walled off — keep shooting, never ban on it.
- **Window 3.5s → 5s**: `AA_STALE_WINDOW_MS = 5000` (user: 3.5 too twitchy). Ban + no-ban logs print the
  const.
- **Zero-cast guard**: `aaStaleCasts` counts actual fires at the current stale target since the last
  observed damage (incremented at the `fired` site; reset on target switch / damage). Window expiry with
  `< AA_STALE_MIN_CASTS (2)` fires → **NO ban**; instead a throttled (2s) diag names the real blocker:
  `[Rotation] hp flat 5s on X but N casts sent (<lastNoFireReason>) -> NO ban, cast path blocked`.
  This is also the breadcrumb that will name the log-#1 zero-cast outage (suspected `_isOnCd` garbage
  under the recycled-slab AV storm) next time it happens.
- **Escalation decay**: `aaStaleRepeat` now stores `{ n, at }`; a repeat older than
  `AA_STALE_REPEAT_TTL_MS (90s)` restarts at offense #1 (5s ban) instead of jumping to 30s forever.
  Existing `.clear()` / `.delete()` sites unaffected.
- Ban log now includes the cast count: `hp frozen 5s over N casts on X ...` — a future false positive is
  immediately distinguishable from a cast-path outage.

## Knock-on behavior (intentional)

- Read-glitch flicker (esCurrent momentarily 0 under AV storm) produces a fake drop+rise → resets the
  clock → *suppresses* bans during storms. Chosen direction: a delayed ban on a true wall is cheap; a
  false ban on a live attacker is what the user is screaming about.
- Rare+ bans unchanged (4s, non-escalating). Mapper's unhittable-boss detection via
  `POE2Cache.rotationBan` unchanged (consec logic intact), just ~1.5s slower per verdict.

## Live checklist (user)

1. Reload scripts (END) so the session picks this up.
2. Fight a banner-zealot pack: mobs actively hit should NOT get `hp frozen ... unhittable` bans while ES
   visibly recharges; genuine cross-river/ledge mobs should still ban (now after 5s, with casts>=2).
3. If dead-air recurs, look for the new `NO ban, cast path blocked (<reason>)` line — it names the gate.
