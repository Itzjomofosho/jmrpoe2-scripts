# TASK-74 REPORT — StoneCircle sighting memory + pull-back

Pre-snapshot: `handoff/pre/TASK-74/mapper.js` (taken before any edit).
`node --check mapper.js`: PASS. New symbols grepped, no typos/half-renames.
Diff vs pre-snapshot: 98 insertions, 9 deletions — all inside the stone subsystem + two hook lines
(`processMapper` sighting pass, `resetMapper` clear). No other seams touched.

## Files touched

- `mapper.js` only.

## Symbols added / modified

**New constants** (next to the other STONE_ consts):
- `STONE_SEEN_PULL_ON = true` — the task flag (house-convention const kill-switch, like `STONECIRCLE_ON`; no user setting per the brief's "one flag" wording). `false` = byte-parity: sighting pass skipped, registry never written, remote commit path returns exactly where `if (!best) return false;` used to.
- `STONE_SEEN_TTL_MS = 900000` — 15-min sighting staleness (brief).
- `STONE_TRAVEL_ARRIVE_R = 40`, `STONE_TRAVEL_EMPTY_MS = 8000` — "8s at <40u with nothing streamed -> ban" (brief).

**New module state**:
- `const stoneSeen = new Map()` — key (`stoneCircleKey` shape) -> `{cx, cy, at}`.
- `let stoneTravelEmptyAt = 0` — travel arrival dwell clock. Frozen on un-owned frames in the existing `_stUnowned` gap block (same list as `stoneLostSince` etc.); reset in `stoneReset`.

**Modified functions**:
- `stoneScan` — Part A feed 1: upserts every returned group into `stoneSeen` (refreshes coords + ts), merging any different key within `STONE_BAN_NEAR_R` of the group anchor (near-duplicate keys from centroid/controller drift never accumulate). Compares against the stored entry coords rather than re-decoding the key string — same /12-anchor comparison, the entry coords are the decoded values, refreshed each sighting.
- `processMapper` — Part A feed 2 (the incident's pass-by case): right after the area-change check and BEFORE every frame-owner early-return (dodge/pickit/opener/breach/hive), gated to FINDING_BOSS / WALKING_TO_BOSS_CHECKPOINT / MAP_COMPLETE, `!stoneKey`, and `now - stoneScanAt >= STONE_SCAN_MS` — calls `stoneScan(now)` for the registry side-effect only. At most one C++-filtered `nameContains` scan per 800ms, shared with the runner's own throttle (a runner call in the same tick hits the cache). Radius untouched.
- `runStoneCircle` —
  - objective-complete gate now also prunes: `stoneSeen.clear()` when `mapObjectiveComplete('StoneCircles')`.
  - COMMIT block: live commit unchanged (restructured `if (!best) return` into `if (best) {...} else {...}`); the else is the remote commit — skipped when flag off / registry empty / `_hvBigContentActive()` (live queue content pending), else nearest non-banned (`stoneCircleBanned({cx,cy,key})` reuse), non-stale entry commits as `stonePhase = 'travel'` with the normal `obStoneClaim`. Stale entries are deleted during the pick; banned ones are skipped (stoneFinish owns deletion).
  - new TRAVEL phase, placed after the total-cap check and BEFORE the `group` lookup (so an adopted key resolves the same pass): walks the anchor via `navTo(..., MOV.stone)`; each pass adopts a scanned group within `STONE_BAN_NEAR_R` of the anchor by PROXIMITY (key drift) -> updates key/coords (+ re-claim; obReconcile's existing `stone-key-gone` branch retires the old-keyed record) -> falls through to the visit flow. No adopt + 8s owned-time at <40u -> `stoneFinish(now, true)`. Travel burns `STONE_CIRCLE_CAP_MS` from `stoneCommittedAt` as briefed; the cap + arrive-dwell clocks ride the existing TASK-72 un-owned freeze.
- `stoneFinish` — both ban and handled paths delete the registry entry by key PLUS any sighting within `STONE_BAN_NEAR_R` of the finished anchor (key-drift siblings must not re-pull).
- `stoneReset` — resets `stoneTravelEmptyAt`.
- `resetMapper` — `stoneSeen.clear()` (map-local grid coords).

**Untouched by design**: breach/hive precedence (stone hook position unchanged, still below both), `pickObjective` / `engagedContentAnchor`, TASK-72 calm-gate, contentQueue (no entries), the 90u pre-boss scan radius, MAP_COMPLETE Phase 3.7 call site (zero changes there — it now sees remembered circles for free, which is the incident's fix).

## Settings added

None user-facing. `STONE_SEEN_PULL_ON` is a module const defaulting ON (flip to `false` in mapper.js to kill).

## LIVE-TEST CHECKLIST

Working:
1. Pass a circle while a breach/hive owns the frames: NO new log lines during the pass (registry feed is silent). After the content finishes (or at MAP_COMPLETE Phase 3.7), expect:
   - `[StoneCircle] commit sc:NxM (remembered) at (x,y) NNNu -> travel`
   - status `StoneCircle: returning to remembered circle NNNu`
   - on arrival: `[StoneCircle] sc:NxM remembered circle streamed (N rocks) -> visit`, then the normal rocks-done / fight / handled lines at the old position, before any portal.
2. A handled or banned circle never re-pulls: after `... -> handled` / `... -> ban`, no further `(remembered)` commit for that position this map.
3. With big content live in the queue (fresh breach/abyss/verisium entry active): no `(remembered)` commit until it drains — the pull fires after.
4. Registry-stale case: `(remembered)` commit, walk completes, nothing streams -> after 8s at the anchor: `[StoneCircle] sc:NxM nothing streamed at remembered anchor (8s at <40u) -> ban` and the bot moves on (once, never loops).

Broken looks like:
- `(remembered)` commits repeating for the same `sc:` key (registry delete failing) — should be impossible (every finish path deletes + position-bans).
- The bot yo-yos toward a remembered circle DURING a breach/hive (precedence violated — the hook order was not touched, so this would be a foreign regression).
- `travel` status with the position frozen >90s (cap should ban out at `total cap 90s -> ban + done`).

## Risks / deviations

- **Merge idiom**: the brief said "reuse the `stoneCircleBanned` /12-cell decode idiom to MERGE near-duplicate keys". I merge by comparing against the STORED entry coords (which ARE the decoded anchor, refreshed every sighting) instead of regex-decoding the key — same comparison, less work. Behaviorally identical.
- **Non-committable-but-visible circles now pull**: the registry remembers every scanned group, including ones the live commit filters reject (controller-only groups with no streamed rocks; lone rocks beyond `STONE_COMMIT_NEAR_R`). When nothing else is committable these can remote-commit and be walked to. That is the brief's letter ("every group it returns upserts") and arguably fixes a cousin of the incident (partial-stream circle seen at 70-90u, gate blocked, never revisited); worst case is a bounded dead-circle visit (adopt -> no targetable rocks -> fight phase -> 6s no-unique grace -> handled + ban).
- **Travel routing**: `navTo` walks route-mode `''` (fog-gated), as briefed. The pull-back path crosses ground the bot already explored when it passed the circle, so routing should hold; a genuinely unroutable pull is bounded by the 90s circle cap.
- `stoneSeen` is NOT persisted in the map-resume sidecar (the brief didn't list it; `stoneBlacklist` is). A mid-map re-inject loses sightings — the sighting pass rebuilds them only if the bot passes within scan range again.

## Open questions

None blocking. One for the planner's radar: pre-boss, a remote pull can walk a long way back (e.g. 400u) as soon as the queue drains — the brief chose no distance cap (`STONE_CIRCLE_CAP_MS` is the bound). If live testing shows painful mid-map backtracks, a max-pull-distance gate pre-boss (letting MAP_COMPLETE catch it instead) is a one-line follow-up.
