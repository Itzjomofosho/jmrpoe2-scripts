# TASK-11 REPORT — Boss-approach cooldown + abyss mid-node TTL hold

Status: **implemented, syntax-clean, NOT tested in game** (per house rule: user live-tests before any commit).

## First act
- `handoff\pre\TASK-11\mapper.js` created before any edit (md5 matched live `mapper.js` at copy time: `15add65e…`).

## Files touched
- `mapper.js` (runtime dir `c:\Games\jmr-poe2\scripts\poe2-scripts\`) — the only file.

## Symbols added / modified (searchable)
New module-level state (2 vars, per brief):
- `bossMeleeApproachFailN` — declared ~L383; melee-approach unreachable-verdict counter.
- `bossApproachCooldownUntil` — declared ~L384; the 45s explore-to-reveal cooldown deadline.

Item A — the cooldown:
- **resetMapper** (`bossMeleeApproachFailN = 0; bossApproachCooldownUntil = 0;`) — per-map reset.
- **setState entry hook** `if (newState === STATE.WALKING_TO_BOSS_MELEE)` — resets `bossMeleeApproachFailN = 0` (cooldown intentionally NOT reset here; entry is gated on it).
- **Melee-approach loop** (`WALKING_TO_BOSS_MELEE`, near `const distToBossTgt`): reset `bossMeleeApproachFailN = 0` when the committed approach target (`targetGridX/Y` vs `bossTgtX/Y`) moves >40u. Uses existing state — no extra vars.
- **Melee-approach stuck handling** (`bossApproachStep === 'stuck'` arm): `++bossMeleeApproachFailN`; at `>= 3` → set `bossApproachCooldownUntil = now + 45000`, set fog-block (`fogBlockedAnchorX/Y` = `getBossArenaCentroid()` if valid else `bossGridX/Y`; `fogBlockedAnchorUntil = now + 45000; fogBlockedAnchorConf = 0.9`), log the cooldown line, reset FailN, `setState(FINDING_BOSS)`.
- **FINDING_BOSS arena-terrain fast path** (`Boss arena (terrain) at`): added `&& now >= bossApproachCooldownUntil` — skip while cooling → falls to explore/strategy-5.
- **FINDING_BOSS checkpoint-entity fast path** (`Boss checkpoint entity at`): new `else if (now < bossApproachCooldownUntil)` before the commit `else` — skip while cooling.
- **Checkpoint→melee transition** (`switching to melee engagement`, at the arrived-block entry, after the ARBITER nearby-objective hold): while cooling → `setState(FINDING_BOSS)` + break instead of entering melee.

Item B — abyss mid-node TTL hold:
- **arbTerminated**, inside the `arbCommittedTtl` HARD-ttl branch: `if (abyssMidNodeEntry(e)) { arbCommittedSince = now; return false; }` — re-arms the TTL instead of evicting/banning while standing on the abyss node mid-dwell. Abyss only; every other type's TTL unchanged. `arbTerminated` has a single caller (`if (arbTerminated(ce, now)) arbRelease(now)`), and the abyss mid-node entry is already exempted from the downstream cand filters (`!abyssMidNodeEntry(e)`), so the re-armed commit is found and held.

## Settings added
- **None** (brief: "No new settings"). Both behaviors are always-on and self-bounding; there is no flag to flip. Flag-off parity is N/A here — the cooldown only alters control flow AFTER 3 proven-unreachable stuck verdicts (a state that previously had no exit but the 10-min failsafe), and the abyss hold only fires when already standing on an abyss node past its TTL.

## Verification done
- `node --check mapper.js` → **SYNTAX OK**.
- Symbol grep: both new symbols resolve at every intended site (decls, resetMapper, state-entry reset, arena skip, checkpoint skip, transition guard, >40u reset, counter/trigger).

## LIVE-TEST CHECKLIST
Scenario A — disconnected-interior arena (LoftySummit-class summit/cliff boss):
- **Working:** after ~3 net-progress watchdog verdicts (`No net progress toward Boss Melee Approach for 8s …`, ~8s apart), you see exactly one:
  `Boss approach (x,y) unreachable x3 -> 45s cooldown, explore-to-reveal another way in`
  Then for ~45s: **no** `Boss Melee Approach`, `Boss arena (terrain) at`, or `Boss checkpoint entity at` lines; the bot demonstrably explores / fights elites elsewhere (biased toward the arena bearing). After ~45s it retries the approach fresh. No manual rescue.
- **Broken:** cooldown line fires almost instantly (sub-second, before ~3 watchdog cycles) → the counter is catching per-frame no-path instead of the throttled stuck verdict. OR the bot keeps re-picking `Boss Melee Approach` / re-committing the arena/checkpoint during the 45s → a skip site is being missed.
- **Also watch:** repeated cooldown cycles are expected and fine (each bounded: ~3 verdicts + 45s). It should NOT need the 10-min stale failsafe to escape.

Scenario B — abyss node with a long walk + full clear + loot (mid-node dwell exceeding the 60s abyss TTL):
- **Working:** the bot finishes looting the abyss chest without the commitment being yanked mid-dwell. No `[Yoyo!]`/re-commit churn on the abyss key while standing on the node; no premature 60s ban of the abyss entry during the dwell.
- **Broken:** the abyss commitment releases mid-loot (chest lost) — same class as the original bug.

## Risks / deviations from the brief
1. **FailN counts only the `'stuck'` arm, not the per-frame `(walking && empty-path)` case.** The brief's search anchor is the whole `bossMeleeExploreNoPathCount` branch, but incrementing on the combined condition would trip the cooldown in <200ms (the empty-path case fires per-frame during the ≥500ms re-path lockout). The `'stuck'` return is throttled to ~8s by `stepPathWalker`'s net-progress watchdog (it resets `_wkProgKey` on fire), which is what makes "3 verdicts ~30s" hold and matches the observed 8x-in-2-min watchdog cadence. Deliberate reading of "on each watchdog/stuck verdict".
2. **Checkpoint→melee guard placed at the arrived-block entry** (after the ARBITER nearby-objective hold), so it covers BOTH sub-branches — `switching to melee engagement` (gate ok) and `forcing melee-forward mode` (gate blocked) — with one check. Stricter than guarding only the named log line; this path is defensive-only anyway (the fast-path skips should keep us out of the checkpoint state while cooling).
3. **>40u reset reuses existing state** (`targetName`/`targetGridX/Y` vs `bossTgtX/Y`) rather than adding a 3rd/4th anchor var, honoring the brief's "New state: `bossMeleeApproachFailN`, `bossApproachCooldownUntil`" (only two).
4. **Log `(x,y)` uses `bossTgtX/bossTgtY`** (the actual unreachable approach point, matching the `Boss Melee Approach at (…)` style), while the fog-block anchor uses arena-centroid-else-`bossGridX/Y` exactly as specified.
5. Untouched per hard limits: the net-progress watchdog, the advance-cycles ladder, the arena shell, the checkpoint gate/engage detector, and the TTL for every non-abyss type.

## Open questions
- None. Both items match the brief as written (with the interpretations above noted for the planner's diff review).
