# TASK-33 REPORT — Blind-damage egress ("bleeding with no visible hazard -> LEAVE")

## Files touched
- `auto_dodge_core.js` (RUNTIME dir) — ONLY file edited. Pre-snapshot: `handoff\pre\TASK-33\auto_dodge_core.js`.
- `node --check auto_dodge_core.js` → SYNTAX_OK.

## What was added

### Consts (all flag-off = byte-parity)
| const | default | effect |
|---|---|---|
| `BLIND_EGRESS_ON` | `true` | master flag for part A. `false` → byte-identical control flow (all new code is flag-gated or defined-but-uncalled). |
| `BLIND_EGRESS_DROP_PCT` | `15` | pooled hp+es drop (percentage points, max-in-window − current) that arms egress. |
| `BLIND_EGRESS_WINDOW_MS` | `2500` | rolling window for the drop, and freshness bound for the kill-zone. |
| `BLIND_EGRESS_HOLD_MS` | `1500` | committed walk-out per arm; re-armed (fresh window) each scan the drain continues. |
| `BLIND_GROUND_DUMP_ON` | `true` | part B TEMP diag flag (independent of A; remove with the other TEMP diags in the cleanup task). |
| `BLIND_GROUND_DUMP_RANGE_U` | `30` | grid units around the player to dump (see assumption note). |
| `BLIND_GROUND_DUMP_THROTTLE_MS` | `5000` | one-shot-per-arm throttle for the `[BlindGround]` dump. |

### Symbols added
- State: `_blindHpHist`, `_blindEgressUntil`, `_blindGroundDumpAt`, `_blindKillZone` (module-level, next to the existing `_eg*` escape-watchdog vars).
- Functions: `_tryBlindEgress(player, enemies, now)`, `chooseBlindEgressHeading(player, awayX, awayY)`, `_dumpBlindGround(player, now)`, `_blindDirName(dx,dy)` (+ `_BLIND_COMPASS`).

### Wiring in `runAutoDodge` (3 flag-gated inserts, no parity path touched)
1. After the CATCHALL_TAME hp block: push `{pct,at}` of pooled hp+es into `_blindHpHist` each scan (reuses the player read already in hand — **no new entity scan**), pruned to the window.
2. After `const enemies = result.enemies;`: update `_blindKillZone` = nearby-enemy centroid (world coords) — the "away from where mobs die/explode" prior. Reuses the already-collected `enemies` list.
3. At the existing `if (hazards.length === 0 && !atRisk)` bail (the exact spot the char stood and died): if `BLIND_EGRESS_ON`, call `_tryBlindEgress`; if it returns true, `return false` with `walkEgress` held so the mapper walks us out; else fall through to the original `'no hazards'` bail.

### How A works (damage-driven, type-blind)
- Fires **only** at the "nothing visible to dodge, no proximity net" bail — when a hazard IS visible or a net fires, the normal dodge owns the frame (hard-limit satisfied; this is a backstop, not a competitor).
- Trigger = pooled hp+es dropped ≥ `BLIND_EGRESS_DROP_PCT` within `BLIND_EGRESS_WINDOW_MS` (max-in-window − current).
- Heading = the 8 world-bearings scored by **most OPEN WALKABLE ground** via the existing `isPathWalkable` + `clearancePenalty` helpers (same dx/dy convention as `chooseDodgeDirection`), **tie-broken away from the kill-zone** (tie-break weight 8 < the 16 openness step, so openness dominates).
- Reuses the **existing** `walkEgress` + `_eg*` progress-watchdog (moved >15w = progress; wedged >2.2s → rotate the held heading 90°; continuously active >14s → 4s pathfinder stand-down). **No second escape mechanism.**
- Re-arms (fresh 1.5s window) each scan the drain continues; a new heading is chosen only at a fresh arm (prior hold lapsed) so a continuous drain walks one straight line out (no per-scan ping-pong).
- Bounds (steps aside, lets the explicit owner hold): channel-hold above its hp floor (`_chHoldActive && _playerHpPct >= CATCHALL_HOLD_HP_FLOOR`), `CFG.reachHoldActive` (opener plant — its own hp floor bails), and the egress cooldown (`_egCoolUntil`).
- Per-arm log: `[AutoDodge] blind egress: hp -<pct>% in 2.5s, no visible hazard -> walking out <DIR>`.

### How B works (TEMP diag)
On each fresh arm, one-shot (5s throttle) `[BlindGround]` dump of non-monster entities within `BLIND_GROUND_DUMP_RANGE_U` grid of the player, from the **shared per-frame lightweight list** (`POE2Cache.getSharedEntities()` — no new scan), nearest first: `baseEntityPath`, `entityType/entitySubtype`, `isHostile`, `boundsX×Y`, entity `id`, dist.

## LIVE-TEST CHECKLIST
Watch `C:\tmp\log.txt` (or the console) while clearing a map with on-death/explosion mobs (Mire-class), dodge in `rare`/`boss` mode.

**Working:**
- Standing in an invisible damaging ground (potion firing, no `why=ground` roll) now emits, within ~2.5s of the drain starting:
  - `[AutoDodge] blind egress: hp -NN% in 2.5s, no visible hazard -> walking out <DIR>` (NN ≥ 15), and the character **visibly walks out** (mapper `sendMoveGridLimited` under `MB.set('dodge',1)`), instead of potion-chaining stationary.
  - one `[BlindGround] <n> non-monster within 30u (nearest first):` block naming the culprit entity class (path/type/id) — feed this to a follow-up to classify it as a real ground hazard.
- The line re-appears (fresh arm) if the drain restarts after the 1.5s hold; the character keeps moving out, not dancing in place.

**Unchanged (parity):**
- Normal **classified** grounds (Vortex/Smoke/Ignited/Caustic/abyss-crack) still produce ordinary `why=ground` rolls / walk-outs — no behavior change there (blind egress only fires when the hazard list is EMPTY).
- Boss/rare telegraphs, projectiles, melee cones, proximity nets — all unchanged.

**Broken (report back):**
- A blind-egress line firing while a hazard IS on the floor (should be impossible — gated on `hazards.length === 0`).
- Walking out during an opener plant / active channel while healthy (should be suppressed by the bounds).
- Repeated `[BlindGround]` spam faster than 5s.

## Assumptions / deviations (planner: please sanity-check)
1. **"within 30u" interpreted as grid units** (the codebase's usual meaning of "u"; the shared list carries `gridX/gridY`). 30 grid ≈ 326 world — wide enough to capture the overlapping-circle cluster the char stood in. If world units were meant, change `BLIND_GROUND_DUMP_RANGE_U` (it's compared in grid).
2. **"stop the instant the drain stops" implemented as a committed 1.5s hold per arm** (ends ≤1.5s after the last drain trigger; instant hand-off when a real hazard appears). A literal per-scan stop would make `BLIND_EGRESS_HOLD_MS` meaningless and could halt us mid-field the moment a potion tick masks the drop — the failure mode here is *stopping too early*, so I biased toward finishing the exit. Easy to make it stop on the first sub-threshold scan if you prefer.
3. **Kill-zone prior = nearby-enemy centroid** (there is no attack-target position published to the dodge core; `lastTargetId` is module-local to entity_actions). The centroid is the freshest in-hand proxy for "where we've been shooting", persisted for the window so it survives the pack dying. When no enemies were recently near, there's no tie-break and the pick is pure openness.
4. **Part B reports `boundsX/Y` (not the +0x48 groundEffect radius)**: the lightweight shared payload carries no `hasGroundEffect`/`groundEffectRadiusGrid` (verified via a live bridge read). The hard limit forbids a new scan, so bounds is the footprint proxy and the dumped `id` lets a follow-up re-read the full entity for the radius.

## Open question / known limit (outside this file's scope)
- The backstop only engages while the dodge core is actually running, i.e. the mapper set `dodgeMode` to `boss`/`rare`/content (`rareUniqueNear` = a Rare/Unique within 75u, or a content fight, or `hazardTerrainNear`). A **purely-normal** pack exploding with no rare/unique/content nearby would leave `dodgeMode='off'` and `runAutoDodge` uncalled — this fix can't fire there. The Mire evidence (rotation firing, sustained clear) almost certainly had a rare in the pack, but if live testing shows the blind death recurs with the dodge OFF, the follow-up is a **mapper-side `dodgeMode` gate** (out of `auto_dodge_core.js` scope, so not touched here).
