# TASK-47 REPORT — Owned runner clocks (FIX A) + engaged-content pause immunity (FIX B)

Pre-snapshot: `handoff\pre\TASK-47\mapper.js` (taken before any edit). File touched: `mapper.js` ONLY.
`node --check mapper.js` = PASS. New-symbol grep = PASS (all references consistent, list below).

⚠ FOREIGN HUNK IN THE DIFF: `COVERAGE_SWEEP_ON` flipped `true -> false` with a "USER RULING 2026-07-13" comment
(~line 6847). That change is NOT mine — it landed concurrently during this session (after my pre-snapshot).
I did not touch or revert it; diff-review should attribute it to its own author.

## Settings added (both const kill-switches, per brief)
| Flag | Default | Off = |
|---|---|---|
| `OWNED_RUNNER_CLOCKS_ON` (~2446) | `true` | no anchor advances → today's wall-clock reach budgets, byte-parity |
| `ENGAGED_NO_PAUSE_ON` (~5244) | `true` | `engagedContentAnchor()` returns null → every FIX-B gate inert, byte-parity |

## FIX A — owned-frames runner clocks
New shared primitives:
- `obContentPausedFor(type, id)` (~1728) — is the committed-content OB record for this runner target paused
  (shadow-tracked, works with `objBroker` off).
- `runnerSpanStolen(gap, now, type, id)` (~2450) — a span is STOLEN if: call-gap > 1s (hook wasn't running —
  the pause class from the live log), OR dodge suppression, OR a strictly-stronger MB writer holds the send
  window (`!MB.avail('content',3)`, the same signal the breach-chase hold at ~3087 already uses), OR OB reports
  the commitment paused. Stolen spans ADVANCE the runner's clock anchors by the span (all anchors are <= the
  last tick ts, so an advance can never push one past `now`).

Per-runner tick anchors + advances (each anchor reset at the runner's adopt line + in `resetMapper`):
| Runner | New anchor | Clocks now owned-only | Verdict |
|---|---|---|---|
| `runWalkToBreach` (~2953) | `rotBreachTickAt` | `rotBreachClosestAt` (11s no-progress), `rotBreachStart` (50s backstop) | **FIXED (primary, BUG 1)** |
| abyss Phase A in `runAbyssRun` (~3885) | `abyssReachTickAt` | `abyssBestAt`, `abyssReachMoveAt`, `abyssStartAt` (50s backstop) | **FIXED** — the physically-moving guard only protects MOVING pauses; a stationary steal (utility arrival wait, opener lock, stand-and-fight) starved both terms, and the 50s backstop was blind |
| `runIncursionChestRun` (~2210) | `incursionTickAt` | `incursionCurStartAt` (25s reach → 30s skip) | **FIXED** |
| `runIncursionBeaconRun` (~2279) | `incBeaconTickAt` | `incBeaconStartAt` (25s reach → 60s ban) | **FIXED** |
| verisium pre-reach walk leg in `_runExpedition2` (~4858) | `exp2WalkTickAt` | `exp2StartAt` (180s total → 60s done-ban) — advanced only while `exp2Phase==='walk' && exp2ClearAt===0` | **FIXED** (walk leg only; post-open phases are fight caps → FIX B protects those instead) |
| StoneCircle pursuit | — | — | **LEFT ALONE** — already fully guarded (`stoneTickAt` gap freeze + `_stUnowned` + combat freeze + dodge exclusion, ~3360-3395) |
| abyss chest sweep walk | — | — | **LEFT** — already `trackOwnedProgress` with an owned flag (~4160) |
| verisium loot-approach walks | — | — | **LEFT** — already restart their window on a stolen/stand span (`exp2LootApWalkAt` 1.5s rule) |
| delirium 15s reach | — | — | **LEFT** — owned tracker exists but only under `objBroker` flag-on; not in the brief's audit list (pre-existing residual if the broker stays off) |
| dwell caps (breach roam 120s, abyss 45s node, exp2 fight, hive 240s) | — | — | out of scope per brief (they own their frames) |

## FIX B — engaged-content pause immunity
`engagedContentAnchor()` (~5246) — the ONE engaged probe (pure var reads, no scans). Engaged =
`rotBreachActivatedAt>0` (anchor: cached center) / verisium `exp2CurId && exp2Phase!=='idle' &&
(exp2Phase!=='walk' || exp2ClearAt>0)` (anchor: `exp2CurX/Y`) / `abyssId && abyssDwell` (anchor: node) /
`hiveDefStart && hiveDefAilith` (anchor: Ailith).

Gated call sites (the exact steal points; OB pause bookkeeping untouched — no theft happens, so no record):
1. **Rare-chase steal point** (`processMapper` ARBITER rare block, ~15191): while engaged the layer stands
   down before `runClearNearbyRares` — re-arms `rotRareStart = now` (mirrors the existing OB-deferral shape so
   the 12s engage cap can't burn) and calls `obRareTick(false, now)` (truthful release/resume bookkeeping).
   This is the sole producer of `[OB] pause content:* by=rare`.
2. **HV on-route openable insert** (~15258): `!engagedContentAnchor()` added to the `tryHvUtilInsert` guard
   (it sits ABOVE `arbTick`, so it could steal from an engaged verisium/abyss drive).
3. **Main utility start** (~15316): the `tryStartUtilityNavigation` call defers entirely while engaged —
   this blocks the full pass AND the loot-only pass **including its ≤120u essence/strongbox hv side-step**
   (the exact route BUG 2's Armourer's Strongbox used). Sole producer of `[OB] pause content:* by=utility`
   via `startUtilityState → obUtilityClaim`.
4. **Strongbox event hold (TASK-29B)**: `sboxEventArmWatch` (~8907) never ARMS mid-engagement; a hold already
   running RELEASES the moment committed content becomes engaged (`sboxEventHoldStep` ~8934, logs
   `[Strongbox] event hold released -- <why> engaged`). It runs above the whole content block, so it was the
   BUG-2 frame thief. The release marks the box done (one hold per box — mirrors the boss/MAP_COMPLETE release).

NOT gated (by design): dodge/PANIC/blind-egress, pickit/opener move-lock grabs (upstream of everything), the
exp2 far-walk shrine yield (~15165 — pre-reach walk is deliberately NOT "engaged"), boss states, delirium
mirror (rank 1). OB priority ladder numbers untouched.

## LIVE-TEST CHECKLIST
FIX A (run a breach+abyss map, let a rare/strongbox interrupt a breach walk):
- After `[OB] pause content:breach:<id> by=rare` → `[OB] resume ... (paused Nms)`: **NO**
  `[Breach] Brequel <id> no progress ... -> skip` within seconds of the resume — the walk continues.
- When a breach IS legitimately skipped, the OB release line's `owned=` should be ≥ the ~11s window
  (not `owned=2222ms` like the 11:11 log).
- Same shape for `[Abyss] node <id> no progress -> skip`, `[Incursion] can't reach ... in 25s`,
  `[Exp2] remnant <id> timeout -> skip` — none should land right after a resume/lock.
- BROKEN looks like: skip lines still landing <5s after a resume, **or** a genuinely walled target never
  skipping (over-freeze — suspect the `MB.avail` term; bisect with `OWNED_RUNNER_CLOCKS_ON=false`).

FIX B (engaged verisium/breach with rares + a strongbox around):
- `[Engaged] rare-chase deferred (verisium|breach|abyss|hive engaged)` when a rare is near mid-engagement;
  the char stays on the content fight (user never finishes the mobs manually).
- `[Strongbox] event hold released -- <why> engaged (held Ns)` if a drive-by box opens near an engagement.
- Occasional `[Engaged] utility start deferred (...)` (10s-throttled).
- **NO** `[OB] pause content:* by=rare/utility` span >~5s while engaged (one-frame pause/resume pairs from
  edge timing are fine; sustained pauses are the bug).
- Deferred rares are re-engaged after `[Breach] done` / `[Exp2] ... retire` (defer, not ban).
- BROKEN looks like: bot ignores a rare that is actively killing it OUTSIDE the content radius for a long
  engagement (rares still die passively via entity_actions + dodge stays armed via `rareUniqueNear`; if
  survival suffers, bisect with `ENGAGED_NO_PAUSE_ON=false`).

## Risks / deviations from the brief
- **No 90u radius test in the rare gate.** The brief's headline rule is "the rare-chase layer may not take the
  frame" — inside-radius rares die to the attack chain the content runner already drives, outside ones wait.
  A radius check would need an extra `nearestRareToClear` scan at the gate and would only change which branch
  logs; the behavior (never steal the frame, never ban, re-pick after) is identical. Auto-dodge's rare mode is
  independent (`rareUniqueNear`) and unaffected.
- **`targetName` was not used as an un-owned signal** (brief listed it as an option): within a pass the runner
  returns true and the tick returns (nothing below can rewrite the walker), and cross-pass theft always
  manifests as a call gap / MB hold / dodge suppression / OB pause — all covered.
- **Verisium "engaged" excludes the pre-reach walk** (brief's literal formula was `exp2Phase!=='idle' &&
  exp2CurId`). BUG 2 itself defines engaged as "opened, clear-mobs live", and the existing far-walk shrine
  yield depends on the pre-reach walk staying preemptible.
- **`incursionCurStartAt` can double-advance** when `objBroker` is enforcing (it is also in `obAdvanceAnchors`'
  freeze list). Effect is extra leniency on a stolen span, never an unjust ban.
- **Residual breach edge:** a re-picked breach keeps its old `rotBreachClosestD` ratchet, so after a very long
  absence the 11s window must beat the previous attempt's closest approach. Today that case insta-skips on the
  wall-clock backstop, so this is strictly better; a full fresh-leg reset on re-pick was not in the brief.
- **Strongbox engaged-release marks the box done** (never re-holds it this map). Mirrors the existing boss/
  MAP_COMPLETE release; nearby drops still get picked in passing.

## Open questions
- None blocking. If the planner wants the deferred-rare case to also *log the rare id*, that needs one extra
  scan at the gate — deliberately omitted for perf.
