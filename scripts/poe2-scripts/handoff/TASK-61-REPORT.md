# TASK-61 REPORT — Breach registry: PROVE the source, then walk the unfound breach DIRECTLY

Implementer: Opus 4.8. Worked SOLO (HOUSE_RULES #0 — no fleets/workflows). Live-probed with the user parked in
the exact evidence scenario (Grimhaven, boss dead, Breach objective incomplete, player @(943,987) ~59u from the
completed breach @(886,1001), far un-run breach hand visible on the minimap).

Pre-snapshot: `handoff\pre\TASK-61\mapper.js` (copied before any edit).

---

## PHASE A — PROVEN (live bridge reads, ZERO mapper edits)

Parked scenario, one completed breach + one far un-run breach, probed with identical reads:

| Source | Lists the FAR un-run breach? | Position | Done-vs-live signal | Cost | Verdict |
|---|---|---|---|---|---|
| `getRadarPois()` | **NO** — returned only `Checkpoint_Endgame` @(1764,2074). Carries no breach hands at all. | — | — | cheap | ✗ not a breach source |
| `getMapContent()` | **YES** — `UnstableBrequelSpawnerChaos` @(976,1213), 228u away, and it is **not** a streamed entity (see next row). Omits the completed one entirely. | `gridX/gridY` + `address` | **presence = live** (a completed breach becomes the unclassified `BrequelInitiator` and drops out of the list) + per-instance `isObjectiveDone(address)` | one full-map path scan (cache ≤1/5s) | ✓✓ **THE SOURCE** |
| `getAllEntities()` + MinimapIcon filter | **NO** — stream-limited. Its farthest breach entities cluster WEST around the *completed* breach (x 712–886, out to ~231u); the far breach @(976,1213) is **absent** as an entity. | (streamed only) | entity `isObjectiveDone`/`minimapIconDone` work, but you never see the far one | 831-entity walk | ✗ misses far/un-streamed content (confirms TASK-60's getEntities scan is stream-limited by construction) |
| `getQuestMarkers()` | **NO** — listed ONLY the COMPLETED breach: `BrequelInitiator` @(885,1000) iconType **30**. The far un-run spawner has no quest marker. This is the *current* (broken) discover source. | (completed only) | icon 30 = completed marker persists | cheap | ✗ for finding un-run breaches |

**Why getMapContent wins (C++ read, `poe2_wrap.cc` `GetMapContent` ~L5821):** it walks `GetMapEntityPointers` —
the FULL awake+sleeping entity map, the same source as getQuestMarkers, which bypasses the ~128-nearest getEntities
cap and INCLUDES undiscovered/sleeping content — and classifies by metadata-path substring (`has("Breach")`).
The un-run spawner path `Metadata/Monsters/Breach/Spawners/UnstableBrequelSpawnerChaos` contains "Breach" → type
`Breach`. The completed breach's entity `Metadata/MiscellaneousObjects/Brequel/BrequelInitiator` contains "Brequel"
but NOT "Breach" → classify returns null → not listed. So getMapContent inherently lists only breach *spawners*.

### Done-state discriminator (definitive, live-verified this scenario)
`isObjectiveDone(entity.address)` — breach has no Targetable, so it reads **MinimapIcon +0x38** (live-RE'd:
0 = unopened, 1 = spent/done; `poe2_wrap.cc` L4747). Live results:
- Far breach `UnstableBrequelSpawnerChaos` @(976,1213): `isObjectiveDone = false` → **un-run** ✓
- Completed `BrequelInitiator` @(885,1000): `isObjectiveDone = true` → **done** ✓

(For breach use `isObjectiveDone` / +0x38. `minimapIconDone` reads +0x10 and is the Vaal-BEACON / ABYSS-NODE
signal — it read `false` on both breaches here, so it is NOT the breach discriminator.)

### Reachability oracle
`radarFindPath((943,987)→(976,1213))` returned a 4-waypoint path ending exactly at (976,1213) → the far breach is
routable on the RadarV2 fog-independent grid. Phase B can walk it directly.

### OUT-of-scope probe (abyss, per the brief — NO implementation)
`getMapContent`'s classifier has an **`Abyss`** type (`poe2_wrap.cc` L5853, `has("Abyss")`), and
`minimapIconDone(address)` (+0x10) is the **live-RE'd abyss-node done bit** (`AbyssFinalNodeBase`: done→1, active→0;
L4760). So **getMapContent + minimapIconDone can enumerate abyss nodes/chests fog-independently** and is a strong
candidate to supersede TASK-60's stream-limited `getEntities` abyss-chest scan. This map had no abyss content placed
(objective `Abyss=1`/done; contentByType = Expedition2/LeagueContent/Breach only), so untested live here, but the
classify path + discriminator are proven present. Recommend the next task validate on an abyss map.

---

## PHASE B — implemented (flag `BREACH_REGISTRY_ON = true`)

File touched: `mapper.js` ONLY. All behind the flag; flag off/absent = today's blind bucket hunt, byte-for-byte.

### Symbols added
- `BREACH_REGISTRY_ON` (const, default **true**) — the setting; false = today's control flow.
- `_breachRegAt`, `_breachRegLive`, `_breachRegT`, `_breachRegD` — 5s scan cache + tally state.
- `breachRegistryScan(now)` — cadence ≤1/5s, gated on `mapObjectiveExists('Breach')` (zero cost on breach-less
  maps). Reads `getMapContent()`, keeps `type==='Breach'` rows with `isObjectiveDone(addr)===false` as the live
  set; done count = breach entries in `_discCompletedPos` (done breaches leave getMapContent). Placed right after
  `noteContentCompleted`.
- `breachRegistrySummary(now)` → `{ t, d }` for the MAP SUMMARY.
- `breachRegistryPick(player, now)` → `{ total, doneN, tgt }`: nearest live instance NOT within 60u of a
  completed-instance position (belt vs the existing skip), lazy `radarFindPath`-validated (nearest reachable wins;
  unroutable falls through to the bucket hunt).

### Call sites
1. **Discover feed** — in the MAP_COMPLETE cleanup discover, right after the quest-marker pick (`if (_bm) {...}`,
   search `walking straight to it`). When breach is an unfound type, `breachRegistryPick` competes on distance with
   any marker `h`; nearest wins. Log: `[Breach] registry: N instances (M done) -> walking unfound at (x,y)`. The
   existing sticky-target walk then routes there via radar (same machinery markers use) — this replaces the blind
   `pickRouteNearestBucket` fallback for breach. De-dup: the enclosing `_unfoundTypes` gate already excludes breach
   whenever an active breach queue entry exists, so the registry never double-queues/competes with a live breach.
2. **MAP SUMMARY** — before `let content = Object.entries(by)` (search `game lists more, unfound`): bumps
   `by['breach']` d/t UP only from the registry (never masks a completed one); skipped on LEFT flushes (`!objOverride`).
3. **Per-map reset** — beside `_discCompletedPos = []` (search that string): clears the registry cache so the new
   area re-scans immediately.

### Live validation (bridge, logic mirrored inline — mapper fns are module-scoped)
Reproduced scan+pick against the parked scenario with the completed breach in the ledger:
```
liveBreaches: [[976,1213]]   T: 2   D: 1   pick: {976,1213}
logLine: "[Breach] registry: 2 instances (1 done) -> walking unfound at (976,1213)"
```
Exactly the breach the user pointed at, with the honest 2-instance / 1-done tally.

---

## SETTINGS ADDED
- `BREACH_REGISTRY_ON` — default `true`. Set to `false` to restore today's flow (breach falls back to the blind
  fog-bucket hunt; registry scan/summary/pick become no-ops).

## LIVE-TEST CHECKLIST
Run a map with a standard breach (red hand) that is left un-run while another breach IS run + boss killed (the
Grimhaven case). After the boss dies with `Breach` objective incomplete, watch `C:\tmp\log.txt`:

WORKING:
- `[Breach] registry: 2 instances (1 done) -> walking unfound at (X,Y)` where (X,Y) is the un-run breach hand.
- The bot walks straight toward that coordinate (NOT the old `[Discover] listed content unfound -> exploring toward
  (bucket)` blind spokes, and NOT the radar-unroutable ban churn).
- On map end: `=== MAP SUMMARY ... content: ... breach 2/2 ...` (or `breach 1/2 found (game lists more, unfound)`
  if it was left un-run) — the registry bumps the total to the real instance count.

BROKEN / regressions to flag:
- `[Breach] registry:` never prints while a far un-run breach hand is visible and `Breach` reads incomplete → the
  scan gate or getMapContent classify missed it (re-probe getMapContent for a `Breach` row).
- It walks to a breach we already completed → the 60u completed-position skip or `isObjectiveDone` misfired.
- Any breach-less or breach-complete map that now shows a `[Breach] registry:` line or extra cost → the objective-row
  gate leaked.

## RISKS / NOTES
- **Done-count depends on `_discCompletedPos`** (breach completions ARE recorded there — `noteContentCompleted` at
  the rotBreach done path). If a breach was completed BEFORE the mapper started (mid-map resume/restart), that
  ledger is empty, so the log/summary would read e.g. `1 instances (0 done)`. Cosmetic only — the PICK (walk the
  live breach) is unaffected. The live target comes purely from getMapContent + `isObjectiveDone`.
- **Scope = standard breach (`Breach`), not `Breach2` (hives).** Hives are a separate mechanic/objective row handled
  by the existing cover system; the registry filters to `type==='Breach'` exactly.
- **Scope = the post-boss MAP_COMPLETE cleanup discover** (where the blind hunt lived and the evidence occurred).
  Pre-boss breaches are still owned by the content queue/rotation; the registry only feeds the discover fallback.
- **Cost:** one `getMapContent()` full-map scan per 5s while a breach row exists and discover is re-picking, plus a
  couple `radarFindPath` calls on re-pick (mirrors the existing PICKER_RADAR_ONE lazy-validate budget). Zero on
  breach-less maps (objective-row gate). `getMapContent` is called elsewhere too, but this path is independently
  throttled to ≤1/5s.

## OPEN QUESTIONS
- None blocking. For the NEXT task (abyss equivalent): validate `getMapContent` `Abyss` rows + `minimapIconDone`
  against a live abyss map to confirm it supersedes TASK-60's stream-limited getEntities scan.
