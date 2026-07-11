# TASK-17 — StoneCircle partial-stream hardening (Willow 2026-07-11 log evidence)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-17\`. File: `..\mapper.js` ONLY.
Context: TASK-13's handler works end-to-end (Excavation/Savanna proven). Willow exposed 4 partial-stream defects.
Boss note that raises the stakes: Connal carried `stone_circle_killing_potency` — botched circles appear to BUFF
the map boss, so half-done circles are worse than skipped ones.

## Live evidence (C:\tmp\log.txt)
1. `commit sc:55x101 (1 rocks) at (660,1214) 69u` and `commit sc:33x89 (1 rocks) ... 135u` — 1-rock commits.
   Circles are 3-rock; a far group with 1 streamed rock is a PARTIAL STREAM, not a 1-rock circle.
2. sc:33x89 (135u commit): rock unreachable-skipped, then `lost (de-streamed 15s) -> ban`; the SAME circle
   immediately re-committed as `sc:32x89 (3 rocks) ... 16u` — the /12 CENTROID key moved as rocks streamed in
   (401,1065 -> 380,1070), so bans/handled marks don't stick across streaming. (Here it luckily gave a second
   chance; the same instability lets a HANDLED circle be re-done, or a fresh one inherit nothing.)
3. `rock 510 unreachable (no approach 7s at 20u)` / `rock 471 ... at 30u` + the walker's own wall-slide stuck
   lines — approach cells failing close-in. `poe2.isWalkable` is FOG-GATED (memory: nav-jsbfs), so
   `stoneApproachPoint` computed at commit time from across the map returns bad cells (or the rock cell) when
   the ring is still fogged.
4. `sc:55x101 fight done (unique dead)` after a 1-rock skip -- on a swarming breach map `stoneHostileNear`
   (ANY hostile monster within 45u of centre) instantly sets uniqueSeen; a passing pack then reads as
   "unique dead". False handled + 10min position ban.

## What ships (inside the existing STONECIRCLE block; keep `STONECIRCLE_ON` as the only kill-switch)
**A. Commit gate vs partial streams:** only commit a group when `(rocks.length >= 2) OR (distance <= 60u)`.
   A legit 1-remaining-rock circle still commits once close (<=60u); a far 1-rock ghost never does.
   Also drop the pre-boss scan/commit radius 150u -> **90u** (TASK-13's own open question; Willow proves it:
   135u commit de-streamed mid-walk and burned 25s).
**B. Stable keys:** when a controller is present, key the circle on the CONTROLLER's position (controllers do
   not move; centroids do). Centroid keying remains only for the no-controller fallback — and combined with A,
   a far fallback group can no longer commit. On commit, if a controller-keyed ban exists within 60u of the
   group anchor, treat the group as banned (bridges old centroid bans).
**C. Approach cell re-computed near, not far:** while `dAp > 40u`, walk toward the ROCK's coordinates with the
   'boss' macro route (fog-independent) and do NOT trust/lock the approach cell; compute `stoneApproachPoint`
   only when within 40u (fog lifted, isWalkable meaningful). Re-compute once if the cached cell reads
   unwalkable on arrival.
**D. Unique detection = rarity, not any-hostile:** in the FIGHT phase, `stoneUniqueSeen` requires a monster of
   UNIQUE rarity (verify the exposed field/values via one bridge read or existing usage — BossDiag prints `r3`
   for rares; use the same field) within STONE_FIGHT_R of centre. Any-hostile still gates the "fight is live"
   hold (adds), but the DEAD verdict keys on the unique. No unique ever seen -> the existing 6s no-unique grace
   ends it (unchanged).

## Hard limits
- No new scans beyond the existing stoneScan/stoneHostileNear throttles. Movement via gated senders. All
  existing caps/clock-freeze unchanged. Flag-off parity via STONECIRCLE_ON stays byte-exact.

## Acceptance
- `node --check mapper.js`. Report per HOUSE_RULES + live-test checklist: no `commit ... (1 rocks)` at >60u;
  no immediate re-commit of a just-banned circle under a shifted key; approach logs only fire <=40u; a swarm
  map's circle no longer ends `unique dead` without a unique-rarity monster having been seen.
