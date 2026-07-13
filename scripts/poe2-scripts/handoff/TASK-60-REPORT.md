# TASK-60 REPORT — Abyss chests are entities: direct-scan unopened AbyssChest* → sweep sites

Status: IMPLEMENTED (runtime-only, awaiting live test). Model: Opus 4.8.
Pre-snapshot: `handoff\pre\TASK-60\mapper.js` (copied before any edit).

## What was built
A periodic direct entity scan feeds the existing Abyss Chest Sweep. The sweep's coverage model was NODE
positions only; Arsenals/Armouries also spawn along the pearl TRAIL, so a trail chest was left standing after
`all chest sites visited -> done` (Rockpools screenshot). The chest is an entity, so we scan unopened
`AbyssChest*` and queue each as a normal sweep site — the dwell / chest-walk / opener machinery already does
the rest. Positions persist in the site list, so a chest that later de-streams is still visited.

## Files touched
- `mapper.js` ONLY (runtime dir). Nothing else.

## Symbols added (all searchable)
- `const ABYSS_CHEST_SCAN_ON = true` — the feature flag (near the sweep state block, ~L3982).
- `const ABYSS_CHEST_SCAN_MS = 4000` — scan cadence (~4s).
- `let _abyssChestScanAt = 0` — throttle timestamp; reset per-map at the flip-watch reset line.
- `function abyssContentKnown(now)` — abyss-known gate: sweep sites (current OR ever-queued
  `abyssSweepCnt.t`) OR `mapObjectiveExists('Abyss'/'AbyssDepths')` OR any `type:'abyss'` contentQueue entry.
- `function abyssSiteNearby(x, y, r)` — coarse-radius dedup vs queued sites (coords) + looted sites
  (`abyssSweepLooted` keys reconstructed to approx coords).
- `function abyssChestScan(now)` — the scan itself.

## Wiring / call site
- `abyssChestScan(now)` is called once, immediately after `abyssFlipWatch(now)` inside
  `populateContentQueue()` (search `ENTITY DIRECT SCAN`). That pass is itself gated to 800ms (3000ms during
  FINDING_BOSS) and is NOT called during FIGHTING_BOSS/IDLE/HIDEOUT — so the scan rides the same cadence, plus
  its own 4s self-throttle → effective ~4–7s. Post-boss leftovers are still serviced by the existing
  MAP_COMPLETE `tryAbyssChestSweep` path (unchanged).

## Scan logic (exact)
1. `if (!ABYSS_CHEST_SCAN_ON || abyssSweepDone) return;`  (flag off = byte-identical to today; done-latch respected)
2. 4s cadence check, then `_abyssChestScanAt = now` **advances regardless** so the abyss-known gate + scan run
   at most once per cadence (a non-abyss map does one cheap gate check per 4s, never a getEntities scan).
3. `if (!abyssContentKnown(now)) return;`  — zero scan cost / zero new [DrawProf] weight on non-abyss maps.
4. `poe2.getEntities({ nameContains: 'AbyssChest', lightweight: true })` — C++ path-filter, same bounded idiom
   as the breach-/abyss-mob scans.
5. Per hit: **`/AbyssChest/i.test(name)` reject** (see player-fallback below) → `chestIsOpened === true ||
   isTargetable !== true` skip → finite coords → `abyssSiteNearby(x,y,ABYSS_SWEEP_CHEST_R)` dedup →
   `abyssSweepAdd(x, y, now, 'chest entity (direct scan)')`.

## Live-verified facts (bridge, this session)
- Abyss chest metadata path is `Metadata/Chests/Abyss/AbyssChest<Type>` (e.g. `AbyssChestWeapons`,
  `AbyssChestRareArmour`) — contains the contiguous substring `AbyssChest`, so `nameContains:'AbyssChest'`
  matches. Confirmed the CAPPED filtered `getEntities` applies the path-filter (returned only the 2 real chests
  + the fallback, not the whole 1108-entity slab).
- **Player-fallback trap CONFIRMED**: `getEntities({nameContains:'AbyssChest'})` also returns
  `Metadata/Characters/Dex/DexFour` (the local player, `isTargetable:true`, no `chestIsOpened`) at d=0 — the
  documented id-782 trap. Without the name-regex it would be queued as a phantom site AT THE PLAYER. The regex
  rejects it (verified: `wouldQueue:[]`, DexFour → `rejected: name-regex`).
- Opened chests read `chestIsOpened:true, isTargetable:false` (verified) → correctly skipped. An unopened chest
  reads `chestIsOpened:false, isTargetable:true` → queued.

## Settings added
- `ABYSS_CHEST_SCAN_ON` — default **true**. Const kill-switch (no user UI setting; matches `ABYSS_SWEEP_ON`
  style). Set to `false` = byte-identical control flow to today (function returns at the first line; no scan,
  no queue writes).

## LIVE-TEST CHECKLIST (Rockpools-class abyss map)
Watch `C:\tmp\log.txt` for:
- WORKING: a trail chest the node sweep missed produces
  `[AbyssSweep] abyss node (X,Y) chest entity (direct scan) -> chest site queued (N)`, then the normal sweep
  lines `[AbyssSweep] -> chest site (X,Y) …u`, arrival, hold, and `retired: chests cleared`. The MAP SUMMARY
  `abyss-chest` tally should read `d == t` (every queued chest site left clean).
- STILL-BROKEN look: a trail Arsenal/Armoury visibly left standing while the summary already logged
  `all chest sites visited -> done` with `abyss-chest d < t` OR no `(chest entity (direct scan))` queue line
  ever appearing on a map that clearly had an off-node trail chest.
- MUST-NOT-HAPPEN (regression guard): a `chest site queued (chest entity (direct scan))` at the player's own
  position / d≈0 (that would be the DexFour trap leaking past the regex — it should never appear).
- NON-ABYSS map: zero `[AbyssSweep] … (chest entity (direct scan))` lines and no new per-frame cost / DrawProf
  weight (the abyss-known gate short-circuits before any getEntities call).

## Hard-limit compliance
- Opener's 25u send gate: UNTOUCHED (the scan only queues sites; opening is the existing opener/pickit path).
- No per-frame scans: 4s self-throttle + the abyss-known gate + the 800ms populate-pass gate.
- Movement: none sent here (queuing only; the sweep's existing gated senders own all movement).
- Flag off = today. `node --check mapper.js` passes. Symbol grep clean (no typos/half-renames).

## Risks / deviations / open questions
- **Radius dedup merges same-cluster chests** (by design): two unopened chests within ABYSS_SWEEP_CHEST_R (90u)
  of each other collapse to ONE site — the sweep's 90u chest-probe + chest-to-chest walk covers both. This
  matches the brief ("NOT within ABYSS_SWEEP_CHEST_R of an existing/looted/queued site key").
- **Late-streaming chest after the sweep done-latch**: `abyssSweepAdd` (and therefore the scan) is gated on
  `abyssSweepDone`, which latches once the site LIST fully drains. A trail chest that streams in *after* the
  list has drained will NOT re-queue. This is the EXISTING sweep + flip-watch semantics (both feed through the
  same `abyssSweepAdd` done-gate) — not introduced here — but flagging it in case the planner wants the scan to
  be able to re-open a drained sweep. Not changed (out of brief scope; would alter the sweep lifecycle).
- No blocker hit. Brief implemented as written.
