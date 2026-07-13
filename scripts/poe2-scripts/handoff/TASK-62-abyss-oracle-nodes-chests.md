# TASK-62 (REVISED 2026-07-13 EOD) — Abyss oracle slice: Phase A largely PLANNER-ANSWERED; what's left is one mid-abyss probe + a conditional C++ gate

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-62\`. USE OPUS 4.8.
STATUS: do NOT fire until the planner's mid-abyss probe (below) says Phase B exists. The original brief sent
you to prove sources the planner has since DISPROVEN live from distance.

## Planner Phase A results (live, Grimhaven 2026-07-13, probed from 330-1100u)
- `getMapContent` is **STREAM-BOUND for spawners/content (~300u)** — the un-run breach row appeared at 234u
  and vanished at 332u. TASK-61's "fog-independent" claim was a probe-distance artifact (registry has been
  planner-hotfixed to ACCUMULATE seen spawners instead — the abyss-sweep-sites pattern).
- Map-wide sources checked from afar: `getRadarPois` = checkpoints only; `getTgtLocations` = no abyss keys;
  `getQuestMarkers` = full field set is {address, world/grid, iconType, path, questId} but carries ONLY
  done-breach (icon30) / shrines (779) / spirits (837) / exp2 (1000) — NO un-run breach, NO abyss chests;
  uncapped `getAllEntities` (799 rows) = streamed only.
- VERDICT: **no existing JS binding lists un-run breach spawners or abyss chests beyond stream range.**
  The chest fix that exists today (TASK-60 scan + persistent sweep sites + reopen hotfix) IS the
  accumulate-while-streamed pattern and is the correct JS-level ceiling.

## Remaining Phase A (one probe, mid-abyss, next abyss map — planner can do it over the bridge)
While an abyss is LIVE (nodes un-run, chests spawning): does getMapContent list 'Abyss' rows? At what range?
Do AbyssChest rows appear under any type? Capture `minimapIconDone`(+0x10) on a far vs near node for the
FLIP_TRUST_R question. If the bridge is planner-held, the planner runs this — no implementer needed.
NOISE WARNING (planner-probed at close range, post-complete map): getMapContent near a spent trail returns
DOZENS of 'Abyss'/'Strongbox' rows (pearls/litter, duplicates) — a naive 'Abyss'-row accumulate-registry
would cache junk. Any Phase B feed must filter (e.g. node-entity paths only), judged against the live probe.

## Phase B (fire ONLY if the probe finds live abyss rows worth wiring)
Abyss-side persistence, TASK-61-hotfix shape: accumulate un-done abyss rows into a per-map seen-cache from
populateContentQueue (<=1/5s, gated on the Abyss row incomplete); feed chest positions -> abyssSweepAdd
(reopen hotfix handles the latch) and node positions -> the existing queue adopt path. mapper.js only, flag
`ABYSS_ORACLE_ON`, off = today byte-parity. node --check. TEST BEFORE COMMIT. Report handoff\TASK-62-REPORT.md.

## The real map-wide oracle = C++ (separate task, user decision)
The client renders minimap hands/chests the JS surface cannot enumerate. Finding THAT table is an IDA RE
task: start from the getQuestMarkers reader (poe2-quest-map-bindings offsets) — the icon layer is likely an
adjacent/wider container the current reader filters; expose `getMinimapIcons()` (pos + iconType + done).
C++ discipline: RE read-only, staged diff, user rebuilds+tests (cpp-commit-discipline, no blind writes).
Only this closes the "never-streamed fog pocket" gap for BOTH breach and abyss chests.
