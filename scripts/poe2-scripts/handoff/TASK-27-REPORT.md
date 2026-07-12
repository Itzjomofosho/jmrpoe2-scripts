# TASK-27 REPORT — Abyss stale-id clear + node flip-watch chest sites; Stone combat/dodge reach freeze

Implementer session. `mapper.js` ONLY (runtime dir). `node --check mapper.js` PASSES. Pre-snapshot:
`handoff\pre\TASK-27\mapper.js` (copied as FIRST ACT, before any edit). Diff vs snapshot: +~112 lines, 3 items, no
stray changes (verified `diff` — the only touched functions are the ones listed below).

---

## Files touched
`c:\Games\jmr-poe2\scripts\poe2-scripts\mapper.js` — only.

## Symbols added / modified (searchable)

### A — stale-abyssId release (bug fix on the prune path; not flag-gated)
- **Added** an after-the-loop block in `populateContentQueue` (right after the `for (const [key, e] of contentQueue)`
  prune loop, before the terrain-beacon dedup). Guard: `if (abyssId !== 0 && !abyssMidNode())` → scan the queue for an
  ACTIVE abyss entry with `abyssId`; if none survives → `abyssId = 0; abyssDwell = 0; abyssLootDwellAt = 0;
  obWalkBackReset();` + log `[Abyss] committed node <id> pruned (objective-complete, no dwell) -> release stranded
  runner state`. Local: `_abIdQueued`.

### B — node GREEN→GRAY flip-watch
- **Const** `ABYSS_FLIP_WATCH_ON = true` (gates B), `ABYSS_FLIP_WATCH_MS = 1500` (throttle).
- **State** `let _abyssFlipWatchAt = 0`, `let _abyssFlipSt = new Map()` (queue-key → last watched status).
- **Function** `abyssFlipWatch(now)` (defined right after `abyssSweepAdd`). Called from `populateContentQueue` after
  the item-A block: `try { abyssFlipWatch(now); } catch (_) {}`.
- **Modified** `abyssSweepAdd(x, y, now, reason)` — added optional 4th arg `reason` (default `'pruned on
  objective-complete'` → the prune caller's log is BYTE-IDENTICAL) and a boolean return (`true` = queued, `false` =
  deduped/capped). The prune caller (unchanged 3-arg call) ignores the return.
- Per-map reset (near the `abyssSweepSites = []` line): added `abyssLootDwellAt = 0; _abyssFlipSt.clear();
  _abyssFlipWatchAt = 0;`.

### C — stone reach/consume clock combat+dodge freeze
- **Const** `STONE_REACH_FRZ_R = 60`, `STONE_REACH_FRZ_CAP_MS = 20000`, `STONE_DODGE_EXCL_MS = 1200`.
- **State** `let _stFrzUsed = 0, _stFrzRockId = 0, _stFrzLogged = false;` (per-rock combat freeze), `let _stLastDodgeAt
  = 0;` (dodge recency), `let _stFrzScanAt = 0, _stFrzScanVal = false;` (probe cache).
- **Function** `stoneReachCombatNear(px, py, now)` — throttled (500ms) bounded lightweight Monster-proximity probe
  (hostile within 60u of the PLAYER). Same scan idiom as `stoneHostileNear` / the utility `_utFrz` probe — NO new
  scan class.
- **Modified** the `runStoneCircle` clock-freeze block (top of the function): the original single
  `gap>1000||dodgeMoveSuppressUntil` freeze now advances the reach + consume clocks (`stoneRockProgAt`,
  `stoneRockSince`) ALSO when `_stCombatFrz` (hostile within 60u, capped +20s/rock) or `_stDodgeExcl` (within 1200ms of
  an MB dodge hold). All other stone clocks unchanged.
- `stoneReset()` + the per-map stone reset (`stoneReset(); stoneBlacklist.clear(); ...`) reset the new vars.

---

## Settings added
| const | default | effect / flip |
|---|---|---|
| `ABYSS_FLIP_WATCH_ON` | `true` | `false` = flip-watch never runs (no writes, byte-parity). Gates **B**. |
| `ABYSS_FLIP_WATCH_MS` | `1500` | watcher throttle (matches the node-status probe's own 1.5s cache). |
| `STONE_REACH_FRZ_R` | `60` | hostile-within radius (of the player) that freezes the rock reach/consume clocks. |
| `STONE_REACH_FRZ_CAP_MS` | `20000` | per-rock combat-freeze cap (anti-pin). |
| `STONE_DODGE_EXCL_MS` | `1200` | MB-dodge recency window that excludes the rock clocks. |

- **A** rides the existing prune path (a straight bug fix — no flag; the brief said to say so). It only *clears*
  stranded runner state; it never commits or moves.
- **C** rides `STONECIRCLE_ON` (already-on kill-switch). The new freeze only *adds* behavior on combat/dodge frames;
  with no hostile-near and no recent dodge, the clock math is byte-identical to before.

---

## Grace-path verification (brief item A explicitly asked)
The brief said: skip the clear when `abyssMidNode()` grace is live, and **verify the grace path's own exit clears
abyssId; if not, clear it there too**.

**Verified: the grace path zeroes `abyssId` itself — no extra clear needed.** When `abyssMidNode()` is live
(`abyssId!=0 && abyssDwell!=0`), the mid-node entry survives the prune (`!abyssMidNodeEntry(e)` at the prune gate) AND
survives `arbTerminated` (same guard), so the runner keeps being dispatched — by the arbiter (`arbRunnerFor` →
`runAbyssRun`) and, under the legacy rotation, by the hoisted keep-alive `if (_rAbyss && abyssId && abyssDwell ...)`.
`runAbyssRun` sets `abyssId = 0; abyssDwell = 0` on **every** terminating branch of the dwell/clear path: the clean
loot-retire, the far/boss-engaged reset, the node-done detection, the 45s hard cap, and the empty-nodes exit. So item
A's guard is correct to skip when grace is live — the runner's own exit ends it. Item A therefore only fires in the
**non-grace** case (`abyssDwell == 0`, i.e. the runner was still WALKING to the node when the Abyss bit flipped) — which
is exactly the stranding case from the log (last runner line was a fresh commit; the pre-boss sweep never fired).

---

## LIVE-TEST CHECKLIST

### A — stale-id release (the 7-stranded-chests bug)
- **Setup:** a map where the Abyss objective flips complete while the bot is at/among the nodes and heading for the
  boss (state `WALKING_TO_BOSS_CHECKPOINT` / `FINDING_BOSS`).
- **WORKING:** within a second or two of the objective flip you see (if a runner was mid-walk)
  `[Mapper] ... [Abyss] committed node <id> pruned (objective-complete, no dwell) -> release stranded runner state`,
  then `[AbyssSweep] abyss node (x,y) pruned on objective-complete -> chest site queued (N)` for the pruned nodes, then
  **`[AbyssSweep]` arrival lines PRE-BOSS** (the sweep runs because `abyssId` is now 0 → `abyssSweepIdle()` true).
- **BROKEN (old behavior):** the objective flips, sites queue, but ZERO `[AbyssSweep] site (...) node=... chest=...`
  arrival lines appear before the boss, and the bot walks straight past the standing chests. (If you never see the
  release line, the runner was mid-DWELL — that's the grace path and is expected; the runner should loot in place.)

### B — node flip-watch (incidental completions)
- **Setup:** a multi-node abyss map where a wave gets AoE-cleared on a node the runner never committed to (it kills the
  wave in passing / while committed to a different node), and the Abyss objective is NOT yet complete.
- **WORKING:** `[Abyss] node <id> completed incidentally -> chest site queued` + the paired `[AbyssSweep] abyss node
  (x,y) flip-watch (node flipped spent) -> chest site queued (N)`, and that node's chest is visited by the sweep.
- **BROKEN:** a node visibly flips gray with a chest on it, no `[Abyss] ... completed incidentally` line, and the chest
  is never queued/visited.
- **False-positive watch (report as a bug if seen):** `[Abyss] node <id> completed incidentally` fires for a node that
  is still GREEN/active (the runner then can't clear it because the entry got marked completed). The transition guard
  (must read `active` before `done`) is designed to prevent this — see Risks.

### C — stone reach freeze in a fight
- **Setup:** a stone circle (Runed Monoliths) that streams/commits while a rare/unique fight is live at the rocks
  (adds, dodge-rolling, potions) — the Taua scenario.
- **WORKING:** `[StoneCircle] <key> rock <id>: hostiles within 60u -> fighting through (reach/consume clocks frozen,
  cap 20s)` appears, and the circle CONSUMES ALL its rocks (no `unreachable (no approach 7s at 22u)` skips while
  hostiles are on screen). After ~20s of continuous point-blank combat at one un-reached rock the cap lets it skip
  (anti-pin) — that's intended, not a regression.
- **BROKEN (old behavior):** `[StoneCircle] <key> rock <id> unreachable (no approach 7s at NNu) -> skip` fires at
  ~22–23u with hostiles clearly on screen, leaving live rocks the user has to hand-click.
- **Parity check:** on a quiet stone circle (no hostiles, no dodges) the walk/skip/consume timing should look exactly
  like before this task.

---

## Risks / deviations
1. **B false-positive vs cold-start miss (chosen tradeoff).** The watcher fires only on an OBSERVED `active`→`done`
   transition (it must have read `active` on a prior tick). This protects a live node from a transient/stale `done`
   read (which would wrongly mark it completed and, under ARBITER, stop the runner). The cost: a node that streams in
   and flips spent inside a single ~1.5s window (before the watcher ever reads it `active`) won't queue its chest via
   the flip-watch. That case is rare (needs an ultra-fast incidental kill on a just-streamed node) and, if the whole
   objective later completes, the objective-complete prune still queues it. I judged a missed-rare-chest strictly safer
   than stranding a live node. `abyssNodeStatus` is coord-based (MinimapIcon, fog-independent) and is the SAME probe the
   committed runner already trusts for its own single-read done-detection, so a false `done` on a genuinely-green node
   requires the minimap to actually show gray — very unlikely.
2. **B marks the entry `completed` (completionSource `'flip-watch'`).** This removes it from the arbiter/rotation active
   set (so it isn't re-committed) and stops the watcher re-processing it. `getAbyssNodes` is still authoritative for the
   runner (live reads), so even a wrong completion can't hide a still-active node from the runner under the legacy
   rotation; under ARBITER the runner is dispatched from the queue entry, which is why the transition guard matters
   (risk 1).
3. **`abyssSweepAdd` signature changed** (added optional `reason` + boolean return). Backward-compatible: the prune
   caller's 3-arg call keeps the exact original log string via the default, and ignores the return. No other caller.
4. **A theoretical edge (settings flip mid-grace).** If `clearAbyss` is toggled off *while* a node is mid-dwell (grace
   live) so the runner stops being dispatched, item A won't clear `abyssId` (guard skips on grace). This is a
   pathological mid-map settings change; the brief explicitly wanted grace-live to be left to the grace path, so I did
   not special-case it. Not observed; flagged for completeness.
5. **C perf.** `stoneReachCombatNear` adds one bounded (maxDist 85), lightweight, 500ms-throttled Monster scan — only
   while a stone rock is committed (`stoneKey && stoneRockId`), i.e. actively solving a circle. Same class/cost as the
   existing `stoneHostileNear` fight-phase probe. Within the perf budget.
6. **C cap accounting.** The reach/consume clocks freeze by the full `gap` (real elapsed) while the combat cap counter
   (`_stFrzUsed`) accrues only `min(gap, 250)` per call — so a boss-fight `gap` can't exhaust the +20s cap in one shot
   (mirrors `_utFrz`'s 250ms per-frame increment). The existing `gap>1000` freeze still covers hook-not-running spans
   independently.

## Open questions
None blocking. One thing the planner may want to confirm on the live run: whether, under ARBITER, an incidental
flip-watch completion ever races the runner's own commit on the SAME node (I believe not — the watcher skips
`e.id === abyssId`, and a node the runner is committed to is never "incidental" — but it's worth a glance in the log
if a stone/abyss-dense map shows any `flip-watch` line for a node the runner was walking to).

## NOT done (per HOUSE_RULES — one task per session)
No commit/push (user live-tests first). Did not start the next queue item (navigator 26A / EXPLORE-REDESIGN).
