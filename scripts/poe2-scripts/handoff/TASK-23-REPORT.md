# TASK-23 REPORT — Half-state map RESUME + forward-biased explore

Status: IMPLEMENTED, syntax-checked, ready for the planner's diff review + the user's live test.
Diff base: `handoff\pre\TASK-23\{mapper.js,opener.js}` (md5-verified copies of the runtime files pre-edit).

## Files touched (RUNTIME dir only — `c:\Games\jmr-poe2\scripts\poe2-scripts\`)
- `mapper.js`  — Part A (state sidecar) + Part B (forward explore). +251 / -5 lines.
- `opener.js`  — Part A dependency: `openBlacklist` serialize/restore export. +38 / -1 lines.

No C++, no tracked repo, no memory writes, no new packets, no new native reads. `node --check` passes on both.

---

## PART A — Per-map state sidecar (`map_state.json`)

### New symbols (mapper.js)
- Consts: `MAP_RESUME_ON` (=true), `MAP_STATE_FILE` (`'map_state.json'`), `MAP_STATE_WRITE_MS` (15000),
  `MAP_STATE_MAX_AGE_MS` (3h), `MAP_STATE_TRAIL_CAP` (20000).
- State: `_mapStateWroteAt`, `_mapStateRestoreArea` (once-per-entry decide latch), `_mapStateResumedArea`
  (drives the RESUME audit verb), `_mapStateRestoreProbeAt` (~1s probe throttle), `_mapStateCorruptLogged`,
  `_resumeChunkVisited` (pending reveal-grid restore set).
- Fns: `_msMapToArr` / `_msArrToMap` (Map<->[[k,v]] helpers), `serializeMapState(now)`, `writeMapStateNow(now)`,
  `maybeWriteMapState(now)`, `clearMapStateFile()`, `applyMapState(env)`, `tryRestoreMapState(areaId,now,tw,th)`,
  `maybeRestoreMapState(areaId,now)`.

### New symbols (opener.js)
- `serializeOpenBlacklist()` → `[[key, rec]...]`; `restoreOpenBlacklist(arr)` → merges, keeps the newer
  `lastAttemptTime`. Both added to the existing `export { ... }`. Imported into mapper.js.

### Envelope written to `map_state.json` (same data dir as `map_audit.log`; whole-file rewrite — fs has no append)
`{ areaId, terrainW, terrainH, savedAt, ...state }` — a single JSON object.

### EXACT restored-field list (`applyMapState`) — STATE ONLY, never goals
1. `visitedTrail` — Map `cx*4096+cy → last-walk ts` (the anti-backtrack trail). Serialized capped at 20k, oldest
   dropped (in-memory `TRAIL_CAP`=4096 so it never trims in practice). `_trailPrevCX/CY` reset to NaN on restore
   so the first post-resume segment doesn't draw a line across the map.
2. Frontier reveal grid — the `chunkMap` **visited** flags, persisted as the list of walkable+visited chunk keys
   (`"cx,cy"`) and re-applied inside `buildChunkGrid()` (terrain dims matched → rebuild reproduces the same keys).
3. `energisedBeacons` (`[{x,y}]`) + `beaconChestDwellDone` (Set of keys).
4. `abyssSweepSites` (`[{x,y,key}]` — **startAt/arriveAt zeroed** so a stale walk/dwell timer can't instantly
   retire a site) + `abyssSweepLooted` (Set) + `abyssSweepCnt` (`{d,t}`) + `abyssSweepDone` (bool).
5. `stoneBlacklist` (Map circle-key → expiry).
6. `ignoredUtilityTargets` (Map key → expiry) + `_utContestedCount` (Map key → count).
7. `_unexpFailed` (Map bucket-key → expiry — unreachable-bucket bans).
8. `deliriumBlacklist` (Set `"gx,gy"`).
9. opener `openBlacklist` (via `restoreOpenBlacklist`) — banned entries + attempt/free-retry records.

### NOT persisted (recompute → restoring them would resurrect stale pointers)
Every live commitment/target: OB records (`obReset`), arb keys (`arbReset`), `utilityActiveTarget`, `stoneKey`,
`abyssId`, breach state, `currentPath`/paths, boss target/arena live ids, `abyssSweepStartAt` (budget re-anchors),
and the abyss site walk/dwell timers (zeroed on restore).

### Timestamp handling
`Date.now()` is wall-clock and survives a re-inject, so every persisted ts stays meaningful:
- trail ts → RELATIVE age scoring (consistent even if all shifted by the reload gap);
- expiry maps + `openBlacklist.until` → future expiry (still-banned holds; expired-during-gap entries just fall off);
- no timestamp is bit-truncated (they exceed int32 — a round-trip unit test confirmed `until`/`lastAttemptTime`
  and the negative/large trail keys survive JSON intact).

### WRITE (throttled ≥15s + once on disable, never in HIDEOUT/IDLE)
- Runs from a new **first-in-map block** (any in-map non-IDLE frame): `maybeWriteMapState(now)`.
- No-op until this entry's restore has been DECIDED (`_auditOpen || _mapStateRestoreArea`) so the first write can
  never clobber a sidecar we still owe a read from.
- Plus one flush on the master-toggle-off debounce **pass 1** (before a possible uninject).

### RESTORE (once per entry, at map-entry, never repeatedly mid-map)
Two triggers, both routed through `maybeRestoreMapState` (shared once-per-area latch + terrain-ready guard):
- **Audit START site** — gives the `RESUME` audit verb (the brief's named site).
- **First-in-map fallback probe** (~1s throttle) — because the audit site is gated on `mapStartWallAt>0`, which
  only `resetMapper` sets; a bare Uninject→Inject that resumes clearing via `IDLE→FINDING_BOSS` never sets it, so
  the fallback guarantees the restore fires regardless (see **Deviations** below).
Restore GATE: restore only if `areaId` matches AND `terrainW/terrainH` match AND `savedAt < 3h` old (a re-rolled
same-name map regenerates terrain → dims differ → fresh). Terrain not-yet-loaded → probe retries (latch not
consumed). Unreadable/corrupt file → logged once, run fresh. A restore only ever merges into the reloaded VM's
EMPTY structures (or no-ops on a blanked file); it never resurrects a live session's state.

### DELETE/blank at MAP END / on leaving the map
`clearMapStateFile()` (writes `''` — fs has no unlink) from `logMapSummary` (every map-end flush) AND from
`resetMapper` on the `_leftMap` transitions (covers paths where the summary is skipped). NOT on a mid-map toggle
reset (those aren't `_leftMap` → the file is kept so a reload can resume). The identity gate is the second guard.

---

## PART B — Forward-biased explore (the actual "backwards" fix)

### New symbols (mapper.js)
- Consts: `EXPLORE_FWD_ON` (=true), `EXPLORE_FWD_K` (=0.6). State: `_fwdFlipLogAt` (2s flip-log throttle).
- Fns: `_fwdExploreBearing(player, buckets, now)` → `{ux,uy,src}|null`; `_fwdPenalty(fwd,cbx,cby,px,py,value)`.

### Forward bearing (priority, NO new reads — the walker's own cached anchors + buckets already in hand)
1. LIVE boss hint: held `fogBlockedAnchorX/Y` (while `fogBlockedAnchorUntil` active) → else locked
   `bossArenaCacheX/Y` → else the sticky `bossBearingCache` (<28s). Player→anchor direction.
2. No hint: the MASS-WEIGHTED CENTROID of `getUnexploredBuckets` (the picker's own list). "The only way is NE" is
   just arithmetic when all remaining mass sits NE.

### Penalty (soft, composes with the trail term, never a hard filter)
`_fwdPenalty` = `dot * K * value` **only when `dot < 0`** (candidate bearing >90° off forward). `value` is the
candidate's OWN score contribution (`count*0.5` in `pickUnexploredHeading`, `s.base` in `pickRouteNearestBucket`),
so ONE `EXPLORE_FWD_K` works across both pickers and the term can never on its own flip a positive score negative
(a fully-backward max bucket keeps ~32/80 of its value — unit-tested). Applied:
- `pickUnexploredHeading` → inside `pickBest`, AFTER the existing fog-anchor terms (so it sharpens, not fights, the
  confident-bearing structural reject).
- `pickRouteNearestBucket` → pass-2 score, composed additively with `TRAIL_ROUTE_K` (does not touch it).
Each picker logs `[FwdExplore] forward(<src>) steered pick/routePick -> (x,y) over (x,y)` when the forward term
flips which bucket wins (2s-throttled).

---

## Settings / flags added
| Const | Default | Flips |
|---|---|---|
| `MAP_RESUME_ON` | `true` | Whole Part A. `false` = no read/write of `map_state.json` ever; audit verb stays `START`; byte-identical control flow. |
| `EXPLORE_FWD_ON` | `true` | Whole Part B. `false` = `_fwdExploreBearing` returns null → every forward block skipped → picker scoring byte-identical. |
| `EXPLORE_FWD_K` | `0.6` | Forward penalty strength (0 = off, ~1 = strong). Independent tunable. |

Independent rollback per the brief: flip either const alone. Both are code consts (no UI setting), matching the
house style for anti-backtrack behavior.

---

## LIVE-TEST CHECKLIST

### Part A — resume (the primary acceptance)
1. **Mid-map Uninject→Inject** (the user ruling scenario): after re-inject, within ~1–13s expect a
   `[Resume] map state restored (trail=<non-zero>, chunks=..., beacons=..., stoneBans=..., abyssSites=...,
   utilBans=..., openBans=...)` console line, then `[Resume] reveal grid: X/Y chunk(s) re-marked visited` on the
   first explore pick. `data\poe2-scripts\map_audit.log` shows a `RESUME map=<id>` line (not a second `START`).
   - WORKING: explore does NOT walk back across already-cleared ground; a used shrine / dead rune / popped chest is
     not re-tried; energised beacons stay done. BROKEN: `trail=0`, or `[Resume]` never prints, or it re-explores
     the whole map, or re-clicks a spent shrine.
2. **Fresh map** (normal hideout→map, or a re-rolled same-name map): NO `[Resume]` line, audit says `START`, trail
   starts empty. (The file is blanked at each map END and on leaving; a dims mismatch also forces fresh.)
3. **Same-map continue after finishing**: complete a map → `MAP SUMMARY` / audit `END` → next map is clean (the
   sidecar was blanked). If you see stale bans carried into a different map, that's BROKEN.
4. **Corrupt file**: hand-edit `map_state.json` to garbage → one `[Resume] map_state.json unreadable/corrupt` line,
   then fresh behavior (no crash).

### Part B — forward explore
5. On a corridor / one-directional map with the boss hint held, watch for `[FwdExplore] forward(<src>) steered
   pick -> (x,y) over (x,y)` when the bias flips a bucket choice, and confirm explore pushes toward the boss/mass
   rather than doubling back. Rear pockets are left for the POST-BOSS coverage sweep (by design since TASK-14).
6. Parity check: set `EXPLORE_FWD_ON=false` (and/or `MAP_RESUME_ON=false`) → the mapper must behave exactly as the
   pre-TASK-23 baseline (no `[FwdExplore]`/`[Resume]` lines, no `map_state.json` writes).

---

## Risks / deviations from the brief (with why)

1. **DEVIATION (added a second restore trigger).** The brief names "the [MapStart]/audit-START site" as THE restore
   location. That block is gated on `mapStartWallAt>0`, and `mapStartWallAt` is set ONLY inside `resetMapper`. On a
   bare Uninject→Inject the mapper resumes clearing via `IDLE→FINDING_BOSS` WITHOUT calling `resetMapper`, so
   `mapStartWallAt` stays 0 and the audit-START block (and a restore hooked only there) would never run — the exact
   reload scenario the task targets. I therefore ALSO added a **first-in-map fallback probe** (once-per-entry latch,
   ~1s throttle, terrain-ready guard) so the restore fires on any in-map non-IDLE frame regardless of
   `mapStartWallAt`. The audit-START trigger is kept for the `RESUME` audit verb. This honors the brief's INTENT
   ("map-entry detection, once, never repeatedly mid-map") and both triggers share the same latch so a restore
   happens at most once per entry. If you want it hooked ONLY at the audit site, delete the `if (MAP_RESUME_ON &&
   currentState !== STATE.IDLE ...)` block in `processMapper` — but confirm your reload workflow re-enables the
   mapper (which fires `resetMapper→mapStartWallAt`) or the feature won't trigger.

2. **Re-enable / resurrect now re-restores.** `resetMapper` clears the restore latch (it just WIPED the live
   per-map state), so a mid-map toggle-off→on or a resurrect re-hydrates from the (still-present) sidecar into the
   freshly-wiped structures. This is safe (empty target) and desirable (don't re-explore after a toggle), but it is
   a behavior change vs today's "toggle wipes everything." `_leftMap` resets blank the file first, so a genuine map
   change stays fresh.

3. **Bare-reinject writes require the fallback path.** On a bare reinject that never sets `mapStartWallAt`, writes
   now still happen (I moved `maybeWriteMapState` into the first-in-map block, gated on restore-decided), so a
   second reload still resumes. Flag-off leaves the WHOLE-MAP CLOCK block byte-identical (the write call was removed
   from it).

4. **`EXPLORE_FWD_K=0.6` is a first calibration**, not tuned live. It's soft (a fully-backward bucket keeps ~40% of
   its value) so a map whose only mass is behind still routes there. Bump toward 1.0 if it doesn't push forward
   hard enough, down toward 0.3 if it over-commits and skips a near side-pocket a required objective sits in.

## Open questions
- **Q1 (confirm the reload workflow):** does your Uninject→Inject leave the Mapper checkbox enabled and auto-resume
  WITHOUT a manual re-enable? If yes, the first-in-map fallback (Deviation 1) is what makes the resume fire; if you
  always re-toggle, the audit-START trigger alone would suffice and you may prefer to drop the fallback. Either way
  the current code covers both.
- **Q2:** the reveal-grid restore only applies once `buildChunkGrid()` runs (the chunk-based explore fallback). The
  primary explore uses `getUnexploredBuckets` (C++, fog-independent) + the persisted `visitedTrail`/`_unexpFailed`,
  so anti-backtrack works regardless; the chunk grid is belt-and-suspenders. Flag if you want the reveal grid tied
  to a different consumer.
