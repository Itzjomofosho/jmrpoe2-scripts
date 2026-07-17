# TASK-74 — StoneCircle sighting memory: passed circles must pull the bot back

Read `handoff/HOUSE_RULES.md` FIRST. Pre-snapshot (FIRST ACT): copy `mapper.js` into
`handoff/pre/TASK-74/`. TASK-72 is live in this file and TASK-73 may land concurrently — diff carefully,
edit only the seams named here.

## Incident (Rockpools 2026-07-17 ~11:24, live-probed after the map)

Circle (3 targetable RuneRocks + RuneRock_Controller) centered (725,725). The bot chased breach mobs to
(748,681) then (726,684) — **41-50u from the circle** — at 11:24:47-54. It was never engaged:

- `runStoneCircle` (and therefore `stoneScan`) only runs in FINDING_BOSS / WALKING_TO_BOSS_CHECKPOINT and
  sits BELOW the breach/hive runners by design. The breach owned every frame of the close pass.
- After the breach the bot moved east (851/909/1024) — never again within the 90u pre-boss scan.
- MAP_COMPLETE cleanup scans 320u, but the boss arena was out of range of the circle.
- Post-map live probe: circle still alive, all rocks targetable. The user watched the bot walk past it.

Root cause: **StoneCircle discovery is proximity-only with no persistence.** Breach/abyss/verisium all
have registries; a spotted circle is forgotten the moment the bot moves on.

## Scope

`mapper.js` only. One flag `STONE_SEEN_PULL_ON` (default ON, off = byte-parity). Do not touch the breach/
hive precedence (stone still never preempts them), pickObjective/`engagedContentAnchor`, or the TASK-72
calm-gate machinery. StoneCircle stays a self-driven runner — no contentQueue entries.

## Part A — Sighting registry (persists across de-stream)

Module state next to the other stone globals: `const stoneSeen = new Map()`  — key (`stoneCircleKey`
shape) -> `{ cx, cy, at }`.

Feeds:
1. Inside `stoneScan`: every group it returns upserts `stoneSeen` (position-keyed; refresh `at` and
   coords — a centroid key can drift as rocks stream, reuse the `stoneCircleBanned` /12-cell decode idiom
   to MERGE near-duplicate keys within `STONE_BAN_NEAR_R` instead of accumulating them).
2. **The pass-by case (the actual incident): a throttled sighting pass that runs even when another
   content owner holds the frame.** In the main mapper tick (`processMapper`), pre-boss states + 
   MAP_COMPLETE, call `stoneScan(now)` on its existing `STONE_SCAN_MS` throttle purely for the registry
   side-effect — but ONLY when a cheap gate says it might matter: skip while `stoneKey` is committed.
   `stoneScan` already caches; this adds at most one C++-filtered `nameContains` scan per STONE_SCAN_MS.
   Do NOT widen the 90u radius.

Removal: delete the entry in `stoneFinish` (both ban and handled paths — `stoneBlacklist` already
prevents re-commit, the registry must not re-pull); prune all when `mapObjectiveComplete('StoneCircles')`.
Reset the Map in `resetMapper`.

## Part B — Pull-back travel phase

In `runStoneCircle`'s COMMIT block (`if (!stoneKey)`), when the live `stoneScan` yields no committable
group: pick the nearest `stoneSeen` entry that is not `stoneCircleBanned` (reuse it — it takes a
`{cx,cy,key}` shape) and not older than 15 minutes. Commit it as a REMOTE circle: `stoneKey/stoneCX/
stoneCY` from memory, new `stonePhase = 'travel'`.

`'travel'` phase (add above the existing `'visit'` handling):
- `navTo(stoneCX, stoneCY, 'Stone Circle', now, MOV.stone-or-existing-MOV)` — use whatever MOV lane the
  runner already walks rocks with; status `StoneCircle: returning to remembered circle Nu`.
- Each pass, if `stoneScan` now shows a group within `STONE_BAN_NEAR_R` of the anchor -> adopt its key/
  coords (key drift) and fall through to `'visit'` — the existing flow takes over.
- Bounds: the existing per-circle total cap (`STONE_CIRCLE_CAP_MS`) already runs from `stoneCommittedAt`
  — travel burns it; arrival with nothing streamed (rock consumed by someone else / registry stale) for
  8s at <40u -> `stoneFinish(now, true)` (ban + registry delete). The TASK-72 stolen-span/unowned clock
  freezes apply as they already do in this function.
- The travel leg must NOT fire while big content is engaged: keep the call-site gating exactly as today
  (the hook already sits below breach/hive and only runs in the two pre-boss states + MAP_COMPLETE);
  additionally skip committing a REMOTE circle when `_hvBigContentActive()` (live queue content pending
  — it will get its chance when the queue drains; the registry keeps it).

MAP_COMPLETE: no extra code — the existing cleanup hook calls `runStoneCircle`, which now also sees
remembered circles, so a passed circle gets finished before the portal. That is the incident's fix.

## Verification (solo, per HOUSE_RULES)

1. `node --check mapper.js`; grep new symbols (`stoneSeen`, `'travel'` phase).
2. Flag-off parity vs `handoff/pre/TASK-74/`.
3. REPORT `handoff/TASK-74-REPORT.md` with LIVE-TEST CHECKLIST:
   - Passing a circle mid-breach logs nothing new, but after the breach (or at MAP_COMPLETE) expect
     `[StoneCircle] commit ... (remembered)` / `StoneCircle: returning to remembered circle` and the
     normal rocks-done flow at the old position.
   - A handled/banned circle never re-pulls (registry deleted with the ban).
   - With big content active in the queue, no remote commit happens until it drains.
