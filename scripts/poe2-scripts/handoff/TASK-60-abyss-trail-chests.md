# TASK-60 — Abyss chests are entities: scan unopened AbyssChest* directly, queue each as a sweep site

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-60\`. File: mapper.js ONLY. USE OPUS 4.8.
SEQUENCING: nothing else in flight. Evidence: C:\tmp\log.txt (Rockpools 20:41, 2026-07-13): `[Opener] chest
skip (Abyssal Arsenal): abyss-range at 45u` -> all four NODE-anchored sites probed `chest=no` -> `all chest
sites visited -> done` -> the trail chest left standing (user screenshot).

## USER DESIGN (build exactly this)
The sweep's coverage model was node positions; abyss chests (Arsenals/Armouries) ALSO spawn along the pearl
trail. The chest is an ENTITY — "surely we can build: Abyssal chest entity + unopened -> go do it."
FIX (flag `ABYSS_CHEST_SCAN_ON = true`): a periodic direct scan feeds the sweep:
- `poe2.getEntities({ nameContains: 'AbyssChest', lightweight: true })` — C++ path-filter, same bounded-cost
  idiom as the breach-mob scan (~2ms). Cadence ~4s, and ONLY while the map has known abyss content (abyss
  queue entries ever seen OR sweep sites exist OR the abyss objective row exists) — zero cost on non-abyss maps.
- Every hit with `chestIsOpened !== true && isTargetable === true` whose position is NOT within
  ABYSS_SWEEP_CHEST_R of an existing/looted/queued site key -> `abyssSweepAdd(x, y, now, 'chest entity
  (direct scan)')` — it becomes a normal sweep site; the dwell/chest-walk/opener machinery already does the
  rest. Positions persist in the site list, so a chest that later DE-STREAMS is still visited.
- Dedup: the existing site keys + abyssSweepLooted; the budget already scales with sitesEverQueued.

## Hard limits
- The opener's 25u send gate is UNTOUCHED. No per-frame scans — the 4s cadence + the abyss-known gate.
  Flag off = today. node --check. TEST BEFORE COMMIT.

## Acceptance
- Rockpools-class map: the trail Arsenal gets `chest site queued (chest entity (direct scan))`, the sweep
  walks it, it opens; MAP SUMMARY abyss-chest d == t. A non-abyss map shows zero scan cost (no new
  [DrawProf] weight).
