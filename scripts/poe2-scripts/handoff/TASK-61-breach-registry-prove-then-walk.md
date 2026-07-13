# TASK-61 — Breach registry: PROVE the in-memory source that lists ALL breach instances (incursion-beacon style), then walk the unfound one DIRECTLY

FIRST ACT (HOUSE_RULES): copy `..\mapper.js` into `handoff\pre\TASK-61\`. USE OPUS 4.8.
SEQUENCING: nothing else in flight. This is a PROVE-then-implement task: Phase A is live bridge probing with
the USER parked in a map; do NOT write mapper code until Phase A names the source.

## Evidence (C:\tmp\log.txt, Grimhaven 21:16-21:17 + user screenshot)
Boss dead, gate HONEST: `[Discover] gate: Breach exists=1 complete=0` (2nd breach EXISTS — user ruling: >=1
done + bit incomplete = another instance PROVEN). The marker pass listed exactly ONE breach — the COMPLETED
one @(886,1001), correctly skipped — while the 2nd breach's red-hand icon was VISIBLE on the user's minimap.
Discover had nothing to aim at -> blind `listed content unfound -> exploring toward (bucket)` + radar-
unroutable bans until manual stop. USER: "END OF MAP we can see the breach — U SHOULD KNOW 2nd BREACH IS
THERE!" The hand icon proves the game client KNOWS the position; we are just not reading the right table.

## Phase A — PROVE (bridge eval_js, live, ZERO mapper edits)
User parks in a map whose minimap shows a far un-run breach hand (they will provide the moment). Probe each
source; deliver a table `source x (lists FAR breach? position? done-vs-live signal? cost)`:
1. `poe2.getRadarPois()` — the RadarV2 POI cache (C++ @11c54ef). Does it carry breach hands? Un-streamed/far
   ones? What field flips when a breach completes?
2. `poe2.getMapContent()` — the content-marker classify path.
3. Uncapped `getAllEntities` + MinimapIcon-bearing filter — find the breach-hand icon id (reference: hive
   covers are icon1048); check whether a DONE breach's entity/icon differs (isTargetable? icon removed?).
4. `getQuestMarkers()`.
Also probe the COMPLETED breach near the player vs the far live one with the SAME reads — the done-state
discriminator is half the deliverable ("PROVE breach near me done AND far away reachable"). Reachability =
`poe2.radarFindPath` to the candidate (the honest oracle). Bridge convention: `new POE2()` + top-level
return; NEVER addSendListener.

## Phase B — implement (ONLY with a proven source; flag `BREACH_REGISTRY_ON = true`)
- `breachRegistryScan(now)`: cadence <=1/5s, gated on the Breach objective row existing — registry of ALL
  instances `{x, y, done}` from the proven source. No per-frame scans; zero cost on breach-less maps.
- Feed discover: objective incomplete + registry instance NOT within 60u of a completed-instance position ->
  walk it DIRECTLY (radar pathType), replacing the blind bucket hunt for breach. Keep the existing
  completed-instance skip. Registry entries de-dup against live queue entries (adopt, don't double-queue).
- Log vocabulary: `[Breach] registry: N instances (M done) -> walking unfound at (x,y)`; MAP SUMMARY breach
  d/t from the registry when it disagrees upward.
- Flag off = today (blind hunt). node --check. TEST BEFORE COMMIT.

## Explicitly OUT (user sequencing: "THEN WHEN CLARIFIED we can check abyssal chests")
The abyss-chest equivalent is the NEXT task once Phase A names a source that sees far/un-streamed content —
TASK-60's getEntities scan is stream-limited by construction; the registry source may supersede it. Note in
the report whether the proven source lists abyss chests/nodes too (one extra probe, no implementation).

## Report
handoff\TASK-61-REPORT.md: the Phase A table (every source, exact fields, far-visibility verdict), the
done-state discriminator, Phase B symbols + call sites, deviations.
