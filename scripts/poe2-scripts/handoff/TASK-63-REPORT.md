# TASK-63 REPORT — minimap-icon oracle: `getMinimapIcons()` + auto-activating JS feed

Status: **IMPLEMENTED, staged, UNCOMMITTED, awaiting user rebuild + live test.** Opus 4.8.
IDB freshness preflight PASSED (stored md5 `d28d5519511ad0ea34b75fe24699a481` == on-disk exe, 2026-07-03). Bridge + IDA both live.

---

## TL;DR
The game keeps a **PERSISTENT, map-wide minimap-icon store** — the icon set the large map draws — that **survives entity de-stream** (getMapContent/getQuestMarkers are stream-bound ~300u). I found it, RE'd the descriptor layout, live-proved it against the ground truth, added a C++ reader `getMinimapIcons()`, and wired an auto-activating JS feed. On the probe map (Grimhaven) the store carried **2 de-streamed unopened abyss chests that `getMapContent` cannot see** — exactly the never-streamed fog-pocket gap. Un-run breach half is scaffolded but INERT (no live un-run breach existed to confirm the icon type — see Open Questions).

---

## Phase A — the RE (observation → inference → confidence)

**Container chain (all live-verified):**
```
minimapElement            (= ui_root.child[6].child[1]; ui_root = *(InGameState+0x2F0))
  + 0x360  -> area_owner  (the game world/area object; shared by BOTH minimap + large-map elements)
    + 0x1A8 -> icon_mgr   (the minimap icon manager)
      + 0x2248 -> begin   } std::vector of 192-byte icon descriptors
      + 0x2250 -> end     }   (140 entries on the probe map)
```
Derived from the game's own icon path: draw loop `sub_1417223A0` (live `EntityDotLoop` @ RVA 0x17223A0) and its per-frame filler `sub_1417221C0`, which iterates `*(icon_mgr+0x2248)..*(icon_mgr+0x2250)` stride **192** calling `sub_1420A7AC0(desc, entityMgr)`. The `+0x23E0` vector the draw loop reads is a per-frame **scratch** (in-range subset; empty when polled 400× — the corner minimap culls to nearby). The persistent store is the `+0x2248` vector.

**192-byte descriptor layout (from `sub_1420A7AC0` + live correlation):**
| off | type | field | notes |
|----|------|-------|-------|
| +0x10 | int32 | `iconType` | MinimapIcons.dat 1-based row — SAME id space as `getQuestMarkers().iconType` |
| +0x14 | int32 | `gridX` | SAME grid as getQuestMarkers (world/(250/23)); == entity render grid @+0x444 |
| +0x18 | int32 | `gridY` | " |
| +0x70 | uint64 | `entity` | **0 once the icon de-streams** — descriptor persists with cached grid |
| +0xB6 | byte | suppressed | hidden this frame |
| +0xB7 | byte | shown | recomputed each render |

**Persistence proven:** 140 descriptors, **86 with NO live entity** (`+0x70`==0) — de-streamed but still drawn from cached coords. Confidence: **HIGH** (direct live read; coords match entity render grid to the unit).

**Icon-id table observed live (Grimhaven), cross-checked vs known ids:**
| iconType | meaning | evidence |
|---|---|---|
| 30 | **spent/done breach** | (885,1000) = brief's done breach (886,1001); matches getQuestMarkers icon30. A 2nd, de-streamed one at (1483,1276) |
| 779 | shrine | (981,1772) — matches "779 shrines" |
| 837 | spirit | (1033,1370) — matches "837 spirit" |
| **891** | **abyss chest (persistent)** | (1219,1897) & (1219,2012) = the 2 known unopened chests; **+ (1311,2081) & (1541,2081) DE-STREAMED** |
| 937 | abyss chest reward overlay (streamed-only) | only the 2 near chests carry it; redundant with the entity scan |
| 888 | abyss trail node (streamed, near) | 41 of them, all with entities |
| 889 | abyss trail node (de-streamed, far) | 76 of them, mostly entity-less |

**Ground-truth acceptance (from a position where the targets are far):** player at grid (1015,1857).
- Abyss chests (1220,1898)/(1220,2013): present as type 891 (+937) at (1219,1897)/(1219,2012). ✓
- **De-streamed unopened chests (1311,2081),(1541,2081): present as type 891 with no entity; `getMapContent` returns ONLY the 2 near chests.** ✓ (the gap, closed)
- Un-run breach (976,1213): **ABSENT** — `getMapContent` breach rows = [] this session, i.e. no breach exists in the current live state (map differs from the planner's earlier probe). The store *does* persist breach icons (spent type-30 survives de-stream), so the mechanism is sound; the un-run icon type just couldn't be sampled. See Open Questions.

---

## Phase B — C++ binding (staged, UNCOMMITTED)

Files (C++ repo `c:\Games\jmrpoe2`, git = baseline, staged not committed):
- `src/poe2/poe2_wrap.cc` — `POE2Wrap::GetMinimapIcons()` (the reader).
- `src/poe2/poe2_wrap.h` — declaration + `JS_FN("getMinimapIcons", …)` registration.
- `sdk/poe2.d.ts` — `getMinimapIcons()` type + doc.

`getMinimapIcons()` → `Array<{ iconType, gridX, gridY, worldX, worldY, hasEntity, address, hidden, visible, path }>`.
- Resolves the container via the **UI-tree path** (not the render hook's `last_map_element_`, which needs the radar plugin's hook firing). Proven to reach the same object (`s2_ui == s2_hook`).
- Read-only, every hop `SafeRead`/SEH-wrapped. **Shape-sanity gate**: `(end-begin) % 192 == 0`, count capped 4096, `begin!=0 && end>=begin` → returns `[]` (never garbage) on offset drift. Output capped **512** rows.
- `path` only for entity-backed icons (de-streamed rows carry no entity → "").
- COST: one UI-tree hop + one bounded ~140-row walk. **Not per-frame** — JS caches it on a 5s cadence.

Build: `rebuild_debug.bat` (bridge-ON DLL), user injects.

---

## Phase C — JS feed (runtime `mapper.js`, auto-activating)

One function `minimapIconFeed(now)` (after `breachRegistryPick`), dispatched from `populateContentQueue` right after the existing abyss/breach scans. ONE `getMinimapIcons()` call / 5s, no new scan class.

- **Abyss chests** (proven, active): icons of type in `MINIMAP_ABYSS_CHEST_ICON_TYPES = {891}`, gated on `abyssContentKnown()`, deduped via `abyssSiteNearby(x,y,ABYSS_SWEEP_CHEST_R)`, fed to `abyssSweepAdd(x,y,now,'minimap-icon (de-streamed chest)')`. The sweep's looted-key + reopen-latch handle already-looted / late sites.
- **Breach** (scaffolded, inert): un-run icons of type in `MINIMAP_BREACH_UNRUN_ICON_TYPES` (**empty** — unconfirmed) → new `_breachRegSeen` entry (done=false, same `x|y` key as `breachRegistryScan`). Spent icons (`MINIMAP_BREACH_SPENT_ICON_TYPE = 30`) only flip an ALREADY-known entry done (never adds spent-only rows). With the un-run set empty, the breach half does nothing new today.

---

## Settings added (name — default — what flips it)
| setting | default | effect |
|---|---|---|
| `MINIMAP_ICON_FEED_ON` | `true` | master gate; `false` OR binding-absent → byte-parity (no call, no merge) |
| `MINIMAP_ICON_FEED_MS` | `5000` | feed cadence |
| `MINIMAP_ABYSS_CHEST_ICON_TYPES` | `Set{891}` | which icon types feed the abyss sweep |
| `MINIMAP_BREACH_SPENT_ICON_TYPE` | `30` | spent-breach id (marks known registry entries done) |
| `MINIMAP_BREACH_UNRUN_ICON_TYPES` | `Set{}` (empty) | un-run breach ids to inject — **fill after a live un-run-breach probe** |

**Flag-off / binding-absent parity is REAL and verified TODAY:** on the un-rebuilt release DLL `typeof poe2.getMinimapIcons === 'undefined'`, so `minimapIconFeed` returns at the `typeof` gate → byte-identical to baseline. It "wakes up" only after the user rebuilds.

---

## LIVE-TEST CHECKLIST (after `rebuild_debug.bat` + inject)

**Sanity (bridge console):** `new POE2().getMinimapIcons().length` > 0 in a map; each row has `iconType/gridX/gridY`. On a map with a de-streamed abyss chest, `getMinimapIcons().filter(i=>i.iconType===891 && !i.hasEntity)` returns the far chest(s).

**Working looks like:** on an abyss map with a trail chest the bot walked past / never streamed, watch the mapper log for
```
[AbyssSweep] abyss node (X,Y) minimap-icon (de-streamed chest) -> chest site queued (N)
[MinimapIcon] fed K de-streamed chest site(s) from M minimap icons
```
→ the bot then walks to and loots the previously-stranded chest (the TASK-60 "stranded trail chest" class). Chests the entity scan already sees are silently deduped (no double-queue).

**Broken looks like:** `getMinimapIcons()` returns `[]` in a populated map (offset drift — shape-sanity tripped; re-verify 0x360/0x1A8/0x2248/192 against a fresh IDB); OR `[MinimapIcon] fed …` fires on a NON-chest coord (wrong type in the chest set); OR any new movement/queue churn while `MINIMAP_ICON_FEED_ON=false` (must be byte-parity).

**Breach:** no change expected until the un-run type is confirmed (set is empty). If a live un-run breach appears, run the probe in Open Questions.

---

## Risks / deviations from the brief
- **Breach half not delivered end-to-end.** The brief's acceptance names the un-run breach; no live un-run breach existed on the probe map (`getMapContent` breach=[]), so I could not confirm the un-run icon type. Per HOUSE_RULES ("do not guess beyond the brief") I left `MINIMAP_BREACH_UNRUN_ICON_TYPES` empty (byte-neutral) rather than inject a guessed type that could steer the bot to a non-breach spot. The abyss-chest half — the concrete, TASK-60-relevant win — is fully proven.
- **Offsets are build-specific** (0x360/0x1A8/0x2248/0x2250, +0x10/0x14/0x18/0x70, 192). They self-guard: drift → shape-sanity fails → `[]` (safe), never garbage. Re-verify post-patch (live read of `getMinimapIcons().length`).
- **Chest "opened" discriminator not isolated.** All 4 probe chests were unopened, so I couldn't observe the open-flag flip. Not needed for the feed: `abyssSweepAdd`'s own looted-key dedup + the reopen-latch handle looted/late sites (per the TASK-60 hotfix). The binding exposes `hidden`/`visible`/`hasEntity` if a finer signal is wanted later.
- **937 vs 891:** I feed 891 (persistent, includes de-streamed) not 937 (streamed-only, redundant with the entity scan). If a build stops emitting 891 for chests, add 937 to the set.

## Open questions
1. **Un-run breach icon type** — the one missing datum. When a live un-run breach exists: `new POE2().getMinimapIcons().filter(i => Math.abs(i.gridX-BX)<8 && Math.abs(i.gridY-BY)<8)` at the breach grid `(BX,BY)` → read its `iconType`, drop it into `MINIMAP_BREACH_UNRUN_ICON_TYPES`. (Candidate per breach-hive memory: 1048 for BrequelSpawnerCover — UNVERIFIED for regular breach; do not assume.)
2. Confirm on a 2nd map that type 891 is universally "abyss chest" (n=1 map here) before trusting it broadly; the abyss-known gate already prevents off-map harm.

## Verification performed
- `node --check mapper.js` → PASS. New JS symbols grepped (feed fn + call site present).
- C++ diff = 3 files, +117 lines, all additions, uncommitted (git baseline intact). No C++ committed; no memory writes; RE read-only.
- Live acceptance: mirrored the exact C++ chain via the bridge → 140 icons, shape-sanity passes; JS-feed sim queued the 2 de-streamed chests `getMapContent` misses.
- pre-snapshot: `handoff/pre/TASK-63/mapper.js`.
