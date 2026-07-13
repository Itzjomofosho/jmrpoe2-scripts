# TASK-63 — RE the minimap icon layer -> expose getMinimapIcons(): the TRUE map-wide content oracle (C++ + JS auto-activating feed)

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-63\`. USE OPUS 4.8.
The C++ repo (c:\Games\jmrpoe2, clean @11c54ef) needs no snapshot — git is the baseline; stage the C++ diff
UNCOMMITTED for planner review + user rebuild (cpp-commit-discipline; no-blind-memory-writes: RE is
READ-ONLY, all writes = staged C++ source).
BRIDGE NOTE: the debug pipe is SINGLE-CLIENT — the planner session has been closed to free it for you.
IDA: live :13337 or headless idalib. STEP 0 = IDB freshness preflight (IDB md5 vs on-disk exe; stale -> regenerate).

## Why (proven today, Grimhaven, planner probes)
The user's minimap renders breach hands + abyss-chest icons the ENTIRE JS surface cannot enumerate:
getQuestMarkers returns only 5 rows here ({address, worldX/Y, gridX/Y, iconType, path, questId}; icon30
done-breach, 779 shrines, 837 spirit, 1000 exp2) — NO un-run breach hand, NO gold chest icons;
getMapContent/getAllEntities are stream-bound (~300u — breach row seen at 234u, gone at 332u);
getRadarPois = checkpoints; getTgtLocations = nothing. The client demonstrably keeps a wider icon store the
minimap draws from. Finding it closes the never-streamed fog-pocket gap for breach AND abyss chests at once
(supersedes the accumulate-pattern's one weakness).

## Ground truth ON THIS PARKED MAP (verify against these — planner live-probed)
- Un-run breach spawner: grid (976,1213) — DE-STREAMED beyond ~300u, hand visible on the user's map.
  Done breach for contrast: (886,1001) (BrequelInitiator, quest-marker icon30).
- Unopened abyss chests (probed streamed at 208/257u, exact): `AbyssChestRareFinalWeapons` @(1220,1898) and
  `AbyssChestCurrency` @(1220,2013), both chestIsOpened=false isTargetable=true. Walk far -> they de-stream
  -> the oracle is REAL iff your new read still returns them (and the breach) from that far position.
- CLOSE-RANGE NOISE WARNING (probed): getMapContent within ~200u of the trail returns DOZENS of 'Strongbox'
  and 'Abyss' rows (trail litter/pearls) + duplicate rows — any icon-store read must be judged against the
  user's ACTUAL minimap icon set, not row counts; expect the real icon table to be much sparser.

## Phase A — RE (read-only)
Starting points, in order of promise:
1. OUR getQuestMarkers reader (C++ side, poe2_wrap.cc; offsets memoized in the quest/map bindings work) —
   it already walks ONE icon-ish container. Find what it walks, then look for SIBLING lists/wider containers
   on the same manager: the 5-row result vs the map's richer draw set implies a filter or a second store.
2. The minimap/large-map UI element render path: find the icon draw loop (W2S per icon), walk back to the
   container it iterates. MinimapIcons.dat row refs (iconType ints like 30/779/1000 index it) are a good
   xref anchor.
3. Bridge-assisted: with the container hypothesis, read it live and check the ground-truth coords above fall
   out. VEH-eats-SEH applies (no speculative raises); EntityData +0x40 state check before any game-fn call.
Document the chain observation->inference->confidence as you go (document-reasoning-stepwise).

## Phase B — C++ binding (staged diff, NOT committed)
`getMinimapIcons()` -> array of { worldX, worldY, gridX, gridY, iconType, done/flags if present, path if
cheap }. Read-only walk, SafeCopy/SEH-wrapped like sibling readers, bounded (cap ~512 rows). Rebuild via
rebuild_debug.bat (bridge-ON DLL), user injects, verify live against the ground truth; ALSO verify cost
(one call, no per-frame walk).

## Phase C — JS feed (auto-activating; ships now, wakes up after the user's rebuild)
Gate every use on `typeof poe2.getMinimapIcons === 'function'` + flag `MINIMAP_ICON_FEED_ON = true`:
- breachRegistryScan: merge un-done breach-hand icons into _breachRegSeen (existing dedup/done-merge).
- abyssChestScan: merge unopened chest icons -> abyssSweepAdd (the reopen hotfix handles the latch).
- 5s cadence rides the existing scans — NO new scan classes, no per-frame calls.
Binding absent (today's release DLL) -> byte-identical behavior.

## Acceptance
From a far position: getMinimapIcons lists the un-run breach + trail chests with sane grid coords + the
done discriminator identified; JS sim shows the merged rows reaching _breachRegSeen/abyssSweepAdd. node
--check; C++ builds clean. Report handoff\TASK-63-REPORT.md: container chain + offsets, binding shape, icon
id table observed, JS merge points, risks. TEST BEFORE COMMIT (both repos).
