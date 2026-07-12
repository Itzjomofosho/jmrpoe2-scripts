# TASK-42 REPORT — Verisium loot-remnant unreachable-loop + first-offered smarts

Pre-snapshot: `handoff\pre\TASK-42\mapper.js` (taken before any edit). Files touched: `mapper.js` ONLY.
`node --check mapper.js` = PASS. New symbols grepped once — all call sites/declarations consistent.

## What was implemented

### A. Loot approach targets a WALKABLE RING cell (the bug fix)
- All three loot-phase walks toward the remnant (`'Verisium loot'` at `dist > _lootR`, and both
  `'Verisium loot-wait'` walks at `dist > 55` / `dist > EXP2_REACH`) now go through a local `_lootNav(label)`
  wrapper inside `exp2Phase === 'loot'`.
- Flag ON: `_lootNav` computes the ring point ONCE per remnant via the SHARED `walkableApproachPoint(t.gridX,
  t.gridY, player.gridX, player.gridY)` (no new helper) and walks to that cell. Cached in `exp2LootApX/Y`,
  reset on `exp2CurId` change. Fog note: the loot phase always follows the on-site open/fight, so the cells
  around the remnant are already revealed when the probe runs.
- Every gate below is UNTOUCHED and still measures `dist` = distance to the REMNANT: the `<= 40u`
  (`VERISIUM_LOOT_OPEN_R`) loot-open ladder, the loot-ready 2s settle + re-validate, the `<= 55u` flip-wait
  proximity, and the 5x/500ms retry ladder (`exp2Craft(t, 0x01)` targets the remnant entity). Verified by
  read-through: only the navTo TARGET changed.
- Flag OFF: `_lootNav` delegates to `navTo(t.gridX, t.gridY, label, now)` — today's dead-center walk verbatim.

### B. Bounded approach (no infinite orbit)
Give-up check at the top of the loot phase, gated `VERISIUM_LOOT_REACH_ON && !exp2LootedAt && !exp2LootFireN
&& exp2LootApAt` (never fires once the open ladder or loot began, never flag-off). Concedes when EITHER:
- no closing on the ring point (>3u improvement, `exp2LootApBest`) for `VERISIUM_LOOT_REACH_MS = 20000` of
  owned time, OR
- the path walker returned `'stuck'` (the net-progress dislodge / 3-strike abandon) `VERISIUM_LOOT_STUCK_MAX = 3`
  times on this remnant (`exp2LootStuckN`, logged as `[Verisium] loot approach dislodge N/3`).

Concede action = the existing give-up shape: `exp2Done.set(t.id, now + 600000)` + log
`[Verisium] loot remnant unreachable -> give up (chest stranded) [<reason>]` + release (`exp2Phase='idle'`).

Owned-time freeze (three layers, matching the established idioms):
1. `exp2LootApAt`/`exp2LootApWalkAt` added to BOTH `+= dt` anchor lists (`obAdvanceAnchors` + the
   `!obOn()` moveLock legacy block) — opener/pickit yields freeze the window intact ("belongs in BOTH lists"
   per the in-code contract).
2. Dodge-recent frames reset the clock — the exact `dodgeMoveSuppressUntil || MB.hold owner 'dodge'` check the
   `stepPathWalker` net-progress watchdog uses.
3. A `>1500ms` gap in approach walk frames restarts the window, and the give-up's 20s path additionally requires
   walk frames to be currently flowing (`now - exp2LootApWalkAt < 1500`) — the C4 ladder / settle / flip-wait
   STANDS can never burn or trip the reach window.

### C. First-offered fallback (optional part — shipped, it was trivial)
- In the `VERISIUM_REWARD_PRIORITY_ON` pick: when ranks tie (i.e. nothing hit the table), a currency-family
  name (`\b(orb|rune|catalyst|distilled)\b`, case-insensitive) now sorts before a plain skill-effect; same-family
  ties keep the lowest-panel-index (bigger stack) rule. Table hits are unaffected (rank still decides first).
- Log now states the fallback reason: `(currency-family fallback)` or `(first-offered, no table/family hit)`;
  table hits keep `(rank N)`. Flag OFF = the old order AND the old `(first-offered)` text byte-for-byte.

## Settings added
| Name | Default | What it does |
|---|---|---|
| `VERISIUM_LOOT_REACH_ON` | `true` | A+B+C. `false` = today's dead-center approach, no give-up, old pick/log (byte-parity). |
| `VERISIUM_LOOT_REACH_MS` | `20000` | Owned-time with no closing on the ring point before conceding. |
| `VERISIUM_LOOT_STUCK_MAX` | `3` | Path-walker stuck returns on this remnant's loot approach before conceding. |

## Symbols added/modified (searchable)
- New consts: `VERISIUM_LOOT_REACH_ON`, `VERISIUM_LOOT_REACH_MS`, `VERISIUM_LOOT_STUCK_MAX` (by the TASK-36 VERISIUM_* block).
- New state: `exp2LootApX`, `exp2LootApY`, `exp2LootApBest`, `exp2LootApAt`, `exp2LootApWalkAt`, `exp2LootStuckN`
  (declared with the exp2 state, reset in the `exp2CurId !== t.id` line, advanced in `obAdvanceAnchors` + the
  moveLock `_dt` block).
- Modified: loot phase (`exp2Phase === 'loot'`) — give-up gate + `_lootNav` + 3 walk call sites; reward pick —
  `_vFam`, `_pickWhy`, sort tiebreak.

## LIVE-TEST CHECKLIST (run a verisium map to loot)
Working:
1. After the fight completes, ONE line: `[Verisium] loot approach ring (x,y) for remnant cell (a,b)` —
   ring coords ≠ remnant cell. (`... = remnant cell (no walkable ring; bounded fallback)` means the probe found
   nothing — the give-up then bounds it.)
2. `Walking to Verisium loot at (x,y)` now shows the RING coords, the char physically arrives (no wall-slide
   orbit), then the proven ladder: `[Verisium] loot-open fired #1/5 (...u, settled) -> awaiting take` →
   `[Verisium] loot-open TOOK ... -> 5s dwell` → dwell/sweep → `looted -> dwell+sweep done -> retire`.
3. A genuinely walled remnant: at most ~20-25s of trying (possibly 1-3 ×
   `No net progress toward Verisium loot for 8s ... -> stuck + dislodge` + `[Verisium] loot approach dislodge N/3`)
   then `[Verisium] loot remnant unreachable -> give up (chest stranded) [...]` and the bot MOVES ON.
4. Reward pick unchanged for table hits (`rank N`); when nothing matches, the log says `currency-family fallback`
   (an Orb/Rune/Catalyst/Distilled name got preferred) or `first-offered, no table/family hit`.
5. Settle-open/pick/hammer identical to TASK-36: `OPENED (area clear, ...u settled)`, `SELECT sent`, `HAMMERED`.

Broken:
- The old loop: `Walking to Verisium loot at (<remnant cell>)` + endless 8s dislodge lines with no give-up.
- A give-up firing on a REACHABLE remnant in under 20s (would mean the reach window burned during a stand —
  report the surrounding log lines if seen).

## Risks / deviations from the brief
1. **C is gated under `VERISIUM_LOOT_REACH_ON`** — the brief names only that flag, and C needed a flag for
   off-parity. Under it, flag-off = today's pick and log text exactly.
2. **Both `'Verisium loot-wait'` walks also use the ring point** — the brief's headline case was the
   `'Verisium loot'` approach, but the loot-wait walks target the same unwalkable cell and feed the same orbit;
   the flip/proximity gates still measure remnant distance.
3. **Fight-owned (non-dodge) movement holds during the approach DO burn the 20s clock** — the freeze idiom I
   mirrored (`stepPathWalker`'s watchdog + the opener/pickit anchor lists) freezes for dodge and opener/pickit
   spans only. This errs toward conceding in a contested approach, which the brief endorses (stranded chest
   beats a dead bot); the 10-min `exp2Done` ban is also not permanent.
4. **`exp2LootStuckN` counts every `'stuck'` return** from the path walker during the loot approach (both the
   8s net-progress dislodge and the 3-strike stuck abandon), not solely the dislodge line — strictly safer.
5. Ring point is computed once per remnant and never recomputed (the helper's own "once per commit" contract);
   a bad/fogged compute falls back to the remnant cell and is bounded by B.

## Open questions
None blocking. Optional planner follow-up: the PRE-open walk (`'Verisium'` phase, 30u stop) still targets the
remnant's dead-center cell — it has never looped live (30u stop is outside the prop footprint) so it was left
untouched per the "no change to settle-open" hard limit.
