# TASK-17 REPORT — StoneCircle partial-stream hardening

**Status: IMPLEMENTED, `node --check` PASS, NOT committed** (runtime-only edits in
`c:\Games\jmr-poe2\scripts\poe2-scripts\mapper.js`; awaiting the planner diff-review vs `handoff/pre/TASK-17/`,
then the user live-tests, then the user commits). Single file, all changes inside the existing STONECIRCLE block.

## Pre-snapshot (FIRST ACT)
`handoff/pre/TASK-17/mapper.js` — byte-identical copy taken BEFORE any edit (md5 `417bc2eb…`, verified equal to the
source at snapshot time). This is the diff base. Diff now: **+68 / −14**, entirely within lines ~2478–2783 (the
STONECIRCLE block); nothing outside it changed.

## Verify-first result (one live bridge read, per HOUSE_RULES rule 0)
The brief said "verify the exposed field/values via one bridge read". I did. Two findings changed item D's field choice:
- **`lightweight:true` does NOT project `rarity`** (`hasRarityKey:false`, zero rarity-defined entities). A `m.rarity===3`
  check on a lightweight scan would match nothing.
- **`entitySubtype` IS projected in lightweight mode** (the probe returned `sub:"PlayerOther"`), and
  `entitySubtype === 'MonsterUnique'` is exactly the rarity-UNIQUE tier (`RARITY.UNIQUE === 3` in entity_actions.js)
  and the established unique check already used by `isUniqueNearBossArena` (mapper.js). The server-side `subtype`
  filter is NOT a hard guarantee (in an empty hideout it passed a `PlayerOther` through), so I gate client-side on
  `entitySubtype`. See deviation #1.

## Files touched — `mapper.js` ONLY

| Symbol | What |
|---|---|
| `STONE_COMMIT_NEAR_R` (NEW const, `60`) | Item A: a group with `<2` rocks only commits within this of its anchor. |
| `STONE_BAN_NEAR_R` (NEW const, `60`) | Item B: a live ban within this of a candidate anchor bans it (bridges key drift). |
| `STONE_APPROACH_NEAR_R` (NEW const, `40`) | Item C: compute/trust the walkable approach cell only within this. |
| `stoneRockApRe` (NEW state `let`) | Item C: approach-cell recompute-once latch (reset in `stoneReset` + at rock-pick). |
| `stoneUniqueNear(cx,cy,now)` (NEW helper) | Item D: throttled (320ms) `entitySubtype==='MonsterUnique'` hostile-near-centre probe; same lightweight scan shape as `stoneHostileNear`. |
| `stoneCircleBanned(g,now)` (NEW helper) | Item B: exact-key ban OR a live ban decoded within `STONE_BAN_NEAR_R` of the group anchor. Runs only while uncommitted. |
| `stoneScan` (MOD) | Item A: pre-boss `scanDist` `150 -> 90`; MAP_COMPLETE `320` unchanged. |
| `stoneReset` (MOD) | resets `stoneRockApRe`. |
| commit loop in `runStoneCircle` (MOD) | Item A+B: ban check now `stoneCircleBanned(g,now)`; added the `g.rocks.length < 2 && d > STONE_COMMIT_NEAR_R` partial-stream skip. |
| FIGHT phase in `runStoneCircle` (MOD) | Item D: split `live` (any hostile, existing) from `uniqueLive` (new, unique-rarity); `stoneUniqueSeen`/`stoneUniqueLastAt` now driven by `uniqueLive`. The `uniqueDead` verdict keeps `!live` (any-hostile hold) — since a unique is itself a hostile, `!live` implies the unique is gone, and `stoneUniqueSeen` now requires a real unique to have been present. |
| rock-pick block in `runStoneCircle` (MOD) | Item C: no longer computes the approach cell at pick time — sets `stoneRockApX/Y = NaN`, `stoneRockApRe = false` (deferred). |
| walk block in `runStoneCircle` (MOD) | Item C: `rd > 40u` -> `ax/ay = rock coords` (fog-independent 'boss' route, no cell trusted); `rd <= 40u` -> compute the walkable cell once; if the cached cell reads unwalkable within 6u of it, recompute once. |

`STONECIRCLE_ON` is unchanged and remains the ONLY kill-switch. `stoneApproachPoint` (the TASK-19 shared
`walkableApproachPoint` alias) is REUSED, not duplicated.

## Settings added
None (no `Settings.*` key, no UI). Per house convention `STONECIRCLE_ON` (const, default `true`) is the sole
kill-switch; `false` = byte-parity rollback (the two hooks short-circuit on it, so `runStoneCircle` is never called
and every new symbol is unreachable — the new consts/`let` are inert declarations).

## LIVE-TEST CHECKLIST (`[StoneCircle]` tag; watch `C:\tmp\log.txt`)

**A — no far partial-stream commits (the core fix):**
- GOOD: NO `commit sc:<k> (1 rocks) ... <d>u` line where `<d> > 60`. A `(1 rocks)` commit may still appear but ONLY at
  `<=60u` (a legit last-remaining rock, close). Multi-rock commits (`(2 rocks)`/`(3 rocks)`) may appear at any range up
  to the new 90u scan cap.
- BROKEN: a `commit ... (1 rocks) ... 69u`/`... 135u` line like the Willow log (a lone streamed rock committed from far).

**B — a just-banned circle does not re-commit under a shifted key:**
- GOOD: after `sc:<k> lost (de-streamed 15s) -> ban` (or any `-> ban + done`), NO `commit sc:<k'>` at nearly the same
  spot within the next seconds (the Willow `sc:33x89 -> ban` then `sc:32x89 (3 rocks) 16u` re-commit must NOT recur).
- BROKEN: two commits of the same physical circle under keys that differ by 1–2 in the `/12` bucket.

**C — approach logs only fire near, no far wall-slide:**
- GOOD: `-> rock <d>u via (x,y)` shows the `via` cell ONLY once we are within ~40u (fog lifted); while far, we walk on
  the 'boss' macro route toward the rock coords. No repeated walker "no net progress"/wall-slide lines from a bad
  cross-map cell. A pit-/wall-adjacent rock that whiffs its first cell recovers (recompute-once).
- BROKEN: `rock <id> unreachable (no approach 7s at 20u)` / wall-slide spam at close range because the cell was computed
  from across the map.

**D — a swarm map's circle never ends `unique dead` without a real unique:**
- GOOD: `fight done (unique dead) -> handled` appears ONLY on a circle where an actual `MonsterUnique` was present at
  the centre. On a breach/swarm map, a passing normal/rare pack crossing the centre no longer produces a false
  `unique dead` + 10-min position ban. If no unique ever spawns, it still ends via `fight done (no unique)` after the
  6s grace (unchanged).
- BROKEN: `fight done (unique dead)` on a circle where only trash packs passed through (no unique-rarity monster).

**Flag-off parity:** set `STONECIRCLE_ON = false` -> ZERO `[StoneCircle]` lines, identical control flow to before this
task (the whole feature is gated out at both hook sites).

## Risks / deviations from the brief (with why)
1. **Item D field = `entitySubtype === 'MonsterUnique'`, not the `rarity` numeric field.** The brief nudged toward the
   rarity field ("BossDiag prints `r3`; use the same field"). A live bridge read proved `rarity` is NOT in the
   `lightweight:true` projection (so a `rarity===3` check would silently match nothing), while `entitySubtype` IS
   projected and `'MonsterUnique'` is precisely the rarity-UNIQUE tier — the same check `isUniqueNearBossArena` uses.
   Semantically identical to the brief's intent, and it keeps the probe on the cheap lightweight scan (no
   `lightweight:false` cost). Full-mode `rarity===3` was the alternative but costs a heavier projection per fight frame.
2. **`uniqueDead` keeps `!live` (not `!uniqueLive`).** Because a unique is itself a hostile, `stoneHostileNear` (`live`)
   is a superset of `stoneUniqueNear` (`uniqueLive`), so `!live` already implies the unique is gone. Keeping `!live`
   is what implements "any-hostile still gates the fight-is-live hold" — we don't declare the unique dead while adds
   remain. The ONLY behavioral change is that `stoneUniqueSeen`/`stoneUniqueLastAt` are now set by `uniqueLive`
   (unique-rarity) instead of `live` (any hostile) — which is exactly the false-positive the brief targets. Minimal,
   surgical, and both bounded by the existing 20s fight cap / 6s no-unique grace.
3. **Item B keying was already correct; only the ban-bridge is new.** `stoneScan` already keys controller groups on the
   controller position and only falls back to the centroid when no controller streamed (the drift source). So item B's
   "key on the controller" requirement needed no change; the new part is `stoneCircleBanned`'s proximity arm, which
   decodes banned keys (`sc:<x/12>x<y/12>`) back to grid coords and bans any candidate whose anchor is within
   `STONE_BAN_NEAR_R` — bridging BOTH a drifting centroid key and a centroid→controller key swap for the same circle.
4. **Recompute-once trigger = "within 6u of the cached cell AND it reads unwalkable".** The brief said "re-compute once
   if the cached cell reads unwalkable on arrival". I gate the `isWalkable` recheck to `<=6u` of the cell (genuine
   arrival) so we don't spend an `isWalkable` call every near-frame during the whole approach; the `stoneRockApRe`
   latch bounds it to one recompute per rock.
5. **Constants: three new `STONE_*` at `60/60/40`** rather than reusing `STONE_CLUSTER_R`/`STONE_ANCHOR_R` (both also
   60). Named separately so the commit-gate radius, ban-bridge radius, and fog-lift range can be tuned independently of
   the clustering radius — the brief specifies each of these numbers explicitly.

## Open questions (none blocking)
- **`STONE_APPROACH_NEAR_R = 40` vs the 45u fog-lift heuristic used elsewhere** (`walkableApproachPoint`'s callers in
  TASK-19 use `d <= 45`). I used 40 exactly as the brief specifies. If the planner prefers parity with the sweep/utility
  sidestep, it's a one-number change; 40 is strictly more conservative (fog even more certainly lifted).
- **Multi-rock far commit still allowed up to the 90u scan cap.** Item A intentionally permits a genuinely-streamed
  `>=2`-rock circle to commit at range (it's real content); only lone-rock ghosts are blocked. If a fully-streamed
  multi-rock circle at ~85u still de-streams mid-walk on some maps, the fix would be to also distance-gate the `>=2`
  branch — deferred (not in the brief; the 90u scan already bounds it well below the old 150u).
