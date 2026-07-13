# TASK-52 REPORT — decomp Phase 1: four leaf modules extracted (pure moves)

Pre-snapshot: `handoff\pre\TASK-52\mapper.js` (taken before any edit).
`node --check` passes on all five files: mapper.js, targets_db.js, visited_trail.js, movement_broker.js, map_audit.js.
Every moved symbol greps to exactly ONE definition across the live files. The full pre-vs-post diff of mapper.js
contains ONLY the planned seam hunks (verified hunk-by-hunk); the moved bodies were diffed against the pre-snapshot
and are byte-identical except the deltas documented per module below.

Line counts (wc -l): mapper.js 20455 -> 20235 (-220). New modules: targets_db.js 89, visited_trail.js 124,
movement_broker.js 56, map_audit.js 29. (New-module total 298 > 220 because of module headers, export keywords,
the configure seams, and the pointer-comment stubs left in mapper.)

Per-module mapper deltas: targets_db −71, visited_trail −94 (incl. −6 in the resume envelope), movement_broker −45,
map_audit −18, imports/configure +8.

## Module 1 — targets_db.js (mapper −71 lines)
Moved verbatim: `TARGETS_DB` (+ its full header comment), `densestClusterCenter`.
New seam symbol (sanctioned by the brief: "the mapper keeps a thin cached wrapper"): `matchBossArenaTiles()` —
the getTgtLocations read + TARGETS_DB pattern match + densest-cluster core lifted out of `getBossArenaCentroid`.
Returns `undefined` = terrain/TGTs not ready (wrapper retries on its ~1s throttle, cache untouched — same as the
old early `return null` before the cache write), `{gx,gy,extent,size}` = cluster found, `null` = computed-empty
(wrapper caches `false`, same as before). Exceptions propagate into the wrapper's existing try/catch — identical.
Stays in mapper: `getBossArenaCentroid()` wrapper with `_bossArenaCentroid`/`_bossArenaArea`/`_bossArenaRetryAt`
(per-area cache + OPTIMIZER T1 retry throttle + the near-origin reject).
Bus: none needed (pure poe2 reads; module imports `poe2` from poe2_cache.js, the navigator precedent).
Exports: `TARGETS_DB`, `densestClusterCenter`, `matchBossArenaTiles`. Mapper imports only `matchBossArenaTiles`.

## Module 2 — visited_trail.js (mapper −94 lines)
Moved verbatim: `visitedTrail` (the Map — now `export const`), `TRAIL_CELL`, `TRAIL_CAP`, `_trailPrevCX/_trailPrevCY`,
`_trailKey`, `_trailStampCell`, `_trailEvict`, `trailRecord`, `trailHas`, `trailLineFrac`, `trailWalkedFrac`,
`TRAIL_BIAS_ON` (+ its USER comment), `_trailPatrolLogAt` (split out of the 4-var declaration; the other three
picker throttles stay in mapper), `trailNextPatrolAng` (+ its "TRAIL consumer 4" comment), `MAP_STATE_TRAIL_CAP`.
New seam symbols (mandated by the brief — serialize()/restore()/reset() riding the resume envelope):
- `trailSerialize()` — produces the `trail` envelope value. Same shape and content as before: `[[cellKey, ts], ...]`,
  insertion order under the cap, else most-recent-first slice at `MAP_STATE_TRAIL_CAP`. The under-cap branch inlines
  the 1-line `_msMapToArr` loop (that helper STAYS in mapper for the other envelope entries — it is not trail-owned);
  output is element-identical.
- `trailRestore(arr)` — the applyMapState fragment verbatim (validity filter, `.set`, segment-anchor drop inside the
  same `Array.isArray` guard); returns the restored-entry count that feeds the audit RESUME summary (`trail=N`).
- `trailReset()` — the map-reset fragment verbatim (clear + NaN anchors).
- `trailConfigure({ log })` — bus for trailNextPatrolAng's two `[Trail] discover patrol` log lines.
Deliberate deltas inside moved code: `log(` -> `_log(` at the two trailNextPatrolAng log sites (bus seam; wired to
mapper's `log` at load, so output — including the `[Mapper] [M:<map>]` prefix — is byte-identical).
Stays in mapper: `TRAIL_ROUTE_K` + its calibration comment, `PICKER_PHANTOM_ON`, `_trailBucketLogAt/_trailRouteLogAt/
_trailFrontierLogAt`, and every picker consumer (they import the trail fns; 4 sites read `visitedTrail.size` verbatim
via the exported Map — read-only, all writes still go through module fns).
Nav bus accessors (`trailHas`/`trailLineFrac` inside navConfigure) now resolve to the imported module fns — no
call-site text changed.

## Module 3 — movement_broker.js (mapper −45 lines)
Moved verbatim: the MB architecture comment + the whole `MB` object (cur/hold/WINDOW/logAt/set/avail/request/gate).
Deliberate delta inside moved code: `log(` -> `_log(` at the single `[MB] BLOCK:` line in `gate()` (bus seam,
wired via `mbConfigure({ log })` — line output byte-identical). One comment word changed ("primitives below" ->
"primitives in mapper") since the gated senders stayed.
Exports: `MB`, `mbConfigure`. All 72 mapper `MB.` call sites are untouched text.

## Module 4 — map_audit.js (mapper −18 lines)
Moved verbatim: the MAP AUDIT FILE comment, `MAP_AUDIT_FILE`, `_auditLines`, `mapAudit(line)`. Uses the `fs`
runtime global directly (Settings.js proves fs is available inside imported ES modules). No bus needed.
DELIBERATELY LEFT IN MAPPER (deviation from the brief's "mapAudit + its open/flush latches"): the latches
`_auditStartPending`, `_auditOpen`, `_auditStartArea`, `_hoSelectedMapName`, `_mapTag`. Reason: they are START/END
state-machine bookkeeping read/written at ~10 spine sites (map-entry detect, resetMapper, logMapSummary — which the
brief keeps in mapper — the hideout map-select, the sidecar write gate), and `_mapTag` also feeds mapper's `log()`
console prefix. Moving them would mean accessor rewrites at every one of those sites — not a pure move (brief:
"a partial clean extraction beats a total tangled one"). Only the file-writer moved, per the same brief line.

## Settings added
NONE — pure moves have no behavior to gate (per brief: rollback is git / the pre-snapshot, not a flag).
Runtime rollback if the smoke map misbehaves: copy `handoff\pre\TASK-52\mapper.js` back over `mapper.js` and delete
the four new module files.

## Wiring
- mapper.js imports (top, existing style): `matchBossArenaTiles` from targets_db.js; `visitedTrail, TRAIL_BIAS_ON,
  trailConfigure, trailRecord, trailHas, trailLineFrac, trailWalkedFrac, trailNextPatrolAng, trailSerialize,
  trailRestore, trailReset` from visited_trail.js; `MB, mbConfigure` from movement_broker.js; `mapAudit` from
  map_audit.js.
- `mbConfigure({ log })` + `trailConfigure({ log })` sit directly above the existing `navConfigure({...})` call
  (top-level, so they run at load before any tick; both modules also carry a `console.log('[Mapper] ...')` fallback
  that can only fire if configure never ran).
- No module imports mapper (verified by grep); no circular imports.

## LIVE-TEST CHECKLIST (one smoke map)
Working looks like — all of these with the normal `[Mapper] [M:<map>]` prefix:
1. Inject/load: mapper UI appears at all. (A module-resolution failure kills the whole mapper import — the most
   likely total-failure mode, and instantly visible.)
2. Trail recording: the usual `[Trail] frontier wf=...` / `[Trail] bucket wf(chosen)=... (shadow)` /
   `[Trail] routeNearest ...` lines during explore, and the trail overlay draws as before. During post-boss
   discover: `[Trail] discover patrol wf=... bias` (this line now originates in visited_trail.js via the bus —
   if the `[M:<map>]` tag is MISSING on it, the bus wiring is broken).
3. MB arbitration unchanged in shape: `[MB] BLOCK: <owner>(pN) vs holder <owner>(pN)` (same check: prefix present).
4. Boss routing normal: navigator belief log still shows `src=tgt-centroid tiles=N` on an arena-pattern map and
   FINDING_BOSS commits/routes as usual (exercises targets_db end-to-end).
5. Audit file: `map_audit.log` gains a START line when objectives stream in and an END line at map end.
6. Resume envelope: a mid-map Uninject->Inject logs `RESUME map=... trail=N` with N > 0, and `map_state.json`
   still holds the `trail` key as `[[cellKey, ts], ...]` (unchanged shape).
Broken looks like: any behavioral diff at all — a pure move has none. Specifically watch for: trail overlay empty /
`trail=0` on every resume (serialize seam), missing `[M:]` tags on [Trail]/[MB] lines (bus seam), boss-direct never
arming (centroid seam), no audit lines (fs-in-module assumption wrong — see open question).

## Risks / deviations (summary)
1. `log` -> `_log` at 3 log sites inside moved code (MB.gate x1, trailNextPatrolAng x2) — the configure-bus seam;
   output identical once wired (wired at load).
2. New seam symbols: `matchBossArenaTiles`, `trailConfigure/trailSerialize/trailRestore/trailReset`, `mbConfigure`
   — all mandated or implied by the brief's wrapper/serialize/bus requirements.
3. `trailSerialize` inlines `_msMapToArr`'s loop for the under-cap branch (helper stays in mapper); output identical.
4. `MAP_STATE_TRAIL_CAP` moved into visited_trail.js (it parameterizes only trail serialization; name kept).
5. `TRAIL_BIAS_ON` moved+exported (trailNextPatrolAng needs it; 4 mapper picker sites read it verbatim via import).
6. `visitedTrail` Map exported so 4 mapper `visitedTrail.size` reads stay verbatim (read-only; all writes go
   through module fns).
7. map_audit latches left in mapper (full rationale in the Module 4 section).
8. Sequencing note: `handoff\pre\` contains TASK-53..56 snapshots, i.e. later tasks already ran against mapper.js
   after the plan's line numbers were written. All seams were located by symbol per HOUSE_RULES; TASK-52 was
   implemented on the current runtime state as the user instructed.

## Open questions
- `fs` as a global inside imported ES modules is proven by Settings.js (readFile/writeFile at load/save), so
  map_audit.js should be safe — but it is the one runtime assumption a smoke map should confirm (checklist item 5).

NOT committed, NOT pushed (TEST BEFORE COMMIT). Next task not started (one task per session).
